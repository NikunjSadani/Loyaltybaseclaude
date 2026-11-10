/**
 * Sales Import worker entrypoint — the Cloud Run JOB command (plan D-4 / §14):
 *   gcloud run jobs deploy gifsy-sales-import[-staging] --image=<api image> \
 *     --command=node --args=--max-old-space-size=1700,dist/sales-import/worker.main.js --memory=2Gi --cpu=1 --task-timeout=3600 ...
 *   The heap size is ENFORCED at startup (ingest/worker-heap.ts): below a 1,600 MB V8 heap limit the process re-executes
 *   itself once with --max-old-space-size=1700, else fails fast (the backstop trips at 75 % of the limit; plan §7.1 step 11).
 * Same image as the API; compiled by `tsc -p tsconfig.build.json` to dist/sales-import/worker.main.js
 * (the api Dockerfile asserts the file exists). Claims imports until none is claimable, then exits 0.
 * OWNER: Lane I (task I-7). Lane-0 skeleton: claimNext() returns null → "processed: 0".
 */
import { spawn } from 'node:child_process';
import * as v8 from 'node:v8';
import { NestFactory } from '@nestjs/core';
import { decideWorkerHeap } from './ingest/worker-heap';
import { SalesImportWorkerModule } from './ingest/sales-import-worker.module';
import { SalesImportProcessorService } from './ingest/sales-import-processor.service';
import { SalesImportRetentionService } from './ingest/sales-import-retention.service';

// Same BigInt JSON rule as main.ts (paise/micro BigInt must never crash a JSON.stringify).
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

async function main(): Promise<void> {
  const heap = decideWorkerHeap(v8.getHeapStatistics().heap_size_limit, process.env, process.execArgv);
  if (heap.kind === 'fail') {
    console.error(JSON.stringify({ msg: heap.message }));
    process.exit(1);
  }
  if (heap.kind === 'reexec') {
    console.log(JSON.stringify({ msg: 'sales-import worker: heap below the floor; re-executing with the configured heap', execArgv: heap.execArgv }));
    const child = spawn(process.execPath, [...heap.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, ...heap.env } });
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    return;
  }
  const app = await NestFactory.createApplicationContext(SalesImportWorkerModule, { bufferLogs: true });
  const proc = app.get(SalesImportProcessorService);
  let processed = 0;
  for (let row = await proc.claimNext(); row; row = await proc.claimNext()) {
    await proc.processClaimed(row);
    processed++;
  }
  // S5: every drain also runs a bounded retention sweep across tenants (expired files, abandoned uploads).
  const retention = await app.get(SalesImportRetentionService).sweep({ limit: 50 });
  await app.close();
  console.log(JSON.stringify({ msg: 'sales-import worker done', processed, retention }));
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({ msg: 'sales-import worker crashed', error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
