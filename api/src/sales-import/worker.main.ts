/**
 * Sales Import worker entrypoint — the Cloud Run JOB command (plan D-4 / §14):
 *   gcloud run jobs deploy gifsy-sales-import[-staging] --image=<api image> \
 *     --command=node --args=--max-old-space-size=1700,dist/sales-import/worker.main.js --memory=2Gi --cpu=1 --task-timeout=3600 ...
 *   The heap size is ENFORCED at startup (ingest/worker-heap.ts): below a 1,600 MB V8 heap limit the process re-executes
 *   itself once with --max-old-space-size=1700, else fails fast (the backstop trips at 75 % of the limit; plan §7.1 step 11).
 * Same image as the API; compiled by `tsc -p tsconfig.build.json` to dist/sales-import/worker.main.js
 * (the api Dockerfile asserts the file exists). Claims imports until none is claimable, then exits 0.
 * Graceful stop (plan §10c, ingest/worker-stop.ts): SIGTERM / SIGINT → no new claims, the current read is aborted and its
 * claim RELEASED (back to QUEUED; the attempt counted unless the stop came early), exit 143 within ~8 s so Cloud Run's
 * retry picks it up; a READY transaction in progress is left to commit. A re-executing parent forwards the signal.
 * OWNER: Lane I (task I-7). Lane-0 skeleton: claimNext() returns null → "processed: 0".
 */
// L-1: ONLY Node built-ins + the tiny heap / stop helpers (no imports of their own) are imported up front. Nest / Prisma / ExcelJS / Storage are loaded
// dynamically after the heap decision, so a parent that re-executes itself never loads them.
import { spawn } from 'node:child_process';
import * as v8 from 'node:v8';
import { ensureWorkerHeap } from './ingest/worker-heap';
import { WORKER_STOP_EXIT_CODE, WorkerStop, drainImports, installWorkerSignals } from './ingest/worker-stop';

// Same BigInt JSON rule as main.ts (paise/micro BigInt must never crash a JSON.stringify).
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

async function main(): Promise<void> {
  const run = ensureWorkerHeap({
    heapLimit: v8.getHeapStatistics().heap_size_limit,
    env: process.env,
    execArgv: process.execArgv,
    argv: process.argv,
    execPath: process.execPath,
    spawn: (cmd, args, opts) => spawn(cmd, args, opts),
    exit: (code) => process.exit(code),
    log: (l) => console.log(l),
    error: (l) => console.error(l),
    onSignal: (sig, cb) => process.on(sig, cb),
  });
  if (!run) return;
  // Installed BEFORE Nest boots: a SIGTERM during startup still means "claim nothing".
  const stop = new WorkerStop();
  installWorkerSignals({ stop, on: (sig, cb) => process.on(sig, cb), exit: (code) => process.exit(code), log: (l) => console.log(l) });
  const { NestFactory } = await import('@nestjs/core');
  const { SalesImportWorkerModule } = await import('./ingest/sales-import-worker.module');
  const { SalesImportProcessorService } = await import('./ingest/sales-import-processor.service');
  const { SalesImportRetentionService } = await import('./ingest/sales-import-retention.service');
  const { SalesApplyJobsService } = await import('./apply/sales-apply-jobs.service');
  const app = await NestFactory.createApplicationContext(SalesImportWorkerModule, { bufferLogs: true });
  const proc = app.get(SalesImportProcessorService);
  const jobs = app.get(SalesApplyJobsService);
  // Background Apply / Recalculate jobs (owner 2026-11-18) go FIRST (an admin is waiting on them; a file read can take
  // minutes), then the imports, then any job queued meanwhile. Each drain stops claiming once a stop is requested.
  const applied = await jobs.drain(stop);
  const drained = await drainImports(proc, stop);
  const appliedAfter = stop.requested ? { finished: 0, released: 0 } : await jobs.drain(stop);
  // S5: every drain also runs a bounded retention sweep across tenants (expired files, abandoned uploads). Skipped when
  // stopping (the next drain runs it).
  const retention = stop.requested ? null : await app.get(SalesImportRetentionService).sweep({ limit: 50 });
  await app.close();
  console.log(JSON.stringify({
    msg: 'sales-import worker done', ...drained,
    applyJobs: { finished: applied.finished + appliedAfter.finished, released: applied.released + appliedAfter.released },
    retention, stoppedBy: stop.reason,
  }));
  // Audit L1: a stopped worker exits non-zero so Cloud Run's task retry picks the handed-back import up promptly.
  if (stop.requested) process.exit(WORKER_STOP_EXIT_CODE);
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({ msg: 'sales-import worker crashed', error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
