/**
 * Downloads worker entrypoint — the Cloud Run JOB command (platform/docs/plans/DOWNLOADS-PAGE.md):
 *   gcloud run jobs deploy gifsy-exports[-staging] --image=<api image> \
 *     --command=node --args=--max-old-space-size=1700,dist/exports/worker.main.js --memory=2Gi --cpu=1 --task-timeout=3600 ...
 * Modelled exactly on sales-import/worker.main.ts and REUSING its helpers:
 *  - heap enforced at start (sales-import/ingest/worker-heap.ts): below a 1,600 MB V8 limit it re-executes itself once
 *    with --max-old-space-size=1700, else fails fast;
 *  - graceful stop (sales-import/ingest/worker-stop.ts): SIGTERM / SIGINT → no new claims, the current file is aborted
 *    and its claim RELEASED back to QUEUED, exit 143 within ~8 s so Cloud Run's retry picks it up.
 * Claims requests until none is claimable, runs the retention sweep, then exits 0.
 */
// Only Node built-ins + the tiny heap / stop helpers up front; Nest / Prisma / ExcelJS load after the heap decision.
import { spawn } from 'node:child_process';
import * as v8 from 'node:v8';
import { ensureWorkerHeap } from '../sales-import/ingest/worker-heap';
import { WORKER_STOP_EXIT_CODE, WorkerStop, drainImports, installWorkerSignals } from '../sales-import/ingest/worker-stop';

// Same BigInt JSON rule as main.ts.
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
  const stop = new WorkerStop();
  installWorkerSignals({ stop, on: (sig, cb) => process.on(sig, cb), exit: (code) => process.exit(code), log: (l) => console.log(l) });
  const { NestFactory } = await import('@nestjs/core');
  const { ExportsWorkerModule } = await import('./exports-worker.module');
  const { ExportsProcessorService } = await import('./exports-processor.service');
  const app = await NestFactory.createApplicationContext(ExportsWorkerModule, { bufferLogs: true });
  const proc = app.get(ExportsProcessorService);
  const drained = await drainImports(proc, stop);
  const retention = stop.requested ? null : await proc.sweep();
  await app.close();
  console.log(JSON.stringify({ msg: 'exports worker done', ...drained, retention, stoppedBy: stop.reason }));
  // Exit explicitly: the feature modules the job loads (notifications, credits, admin-core, …) can leave handles open
  // (the worker-module spec needs --forceExit), and a job that never exits would run until its 1 h task timeout.
  process.exit(stop.requested ? WORKER_STOP_EXIT_CODE : 0);
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({ msg: 'exports worker crashed', error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
