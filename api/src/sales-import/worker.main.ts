/**
 * Sales Import worker entrypoint — the Cloud Run JOB command (plan D-4 / §14):
 *   gcloud run jobs deploy gifsy-sales-import[-staging] --image=<api image> \
 *     --command=node --args=dist/sales-import/worker.main.js --memory=2Gi --cpu=1 --task-timeout=3600 ...
 * Same image as the API; compiled by `tsc -p tsconfig.build.json` to dist/sales-import/worker.main.js
 * (the api Dockerfile asserts the file exists). Claims imports until none is claimable, then exits 0.
 * OWNER: Lane I (task I-7). Lane-0 skeleton: claimNext() returns null → "processed: 0".
 */
import { NestFactory } from '@nestjs/core';
import { SalesImportWorkerModule } from './ingest/sales-import-worker.module';
import { SalesImportProcessorService } from './ingest/sales-import-processor.service';
import { SalesImportRetentionService } from './ingest/sales-import-retention.service';

// Same BigInt JSON rule as main.ts (paise/micro BigInt must never crash a JSON.stringify).
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

async function main(): Promise<void> {
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
