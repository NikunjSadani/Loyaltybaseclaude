import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { claimNextExport, hasClaimableExports } from './exports-claim';
import { EXPORT_STALE_HEARTBEAT_MINUTES } from './exports-engine.constants';
import { ExportsProcessorService } from './exports-processor.service';
import { exportsRunnerConfigured, exportsRunnerMode } from './exports-runner.config';
import { ExportsRunnerService } from './exports-runner.service';
import { ExportsWorkerModule } from './exports-worker.module';

function sqlText(s: Prisma.Sql): string {
  return s.sql.replace(/\s+/g, ' ');
}

describe('export claim SQL', () => {
  it('claims ONE QUEUED-or-stale-RUNNING row atomically (FOR UPDATE SKIP LOCKED), oldest first, with a fresh token', async () => {
    const queryRaw = jest.fn(async () => []);
    await claimNextExport({ $queryRaw: queryRaw } as never, 'tok-x');
    const q = (queryRaw.mock.calls[0] as unknown as [Prisma.Sql])[0];
    const text = sqlText(q);
    expect(text).toContain('UPDATE "export_requests" SET "status" = \'RUNNING\'');
    expect(text).toContain('"attempts" = "attempts" + 1');
    expect(text).toContain('FOR UPDATE SKIP LOCKED');
    expect(text).toContain('ORDER BY "createdAt"');
    expect(text).toContain('LIMIT 1');
    expect(text).toContain('"heartbeatAt" IS NULL');
    expect(q.values).toContain('tok-x');
    expect(q.values).toContain(EXPORT_STALE_HEARTBEAT_MINUTES);
    // timezone-safe: never a bare now() (see sales-import/sql-time.ts)
    expect(text.replace(/\(now\(\) AT TIME ZONE 'UTC'\)/g, '')).not.toMatch(/now\(\)/i);
  });

  it('hasClaimableExports uses the same predicate', async () => {
    const queryRaw = jest.fn(async () => [{ n: 2 }]);
    await expect(hasClaimableExports({ $queryRaw: queryRaw } as never)).resolves.toBe(true);
    const text = sqlText((queryRaw.mock.calls[0] as unknown as [Prisma.Sql])[0]);
    expect(text).toContain('"status" = \'QUEUED\'');
    expect(text).toContain('"status" = \'RUNNING\'');
  });
});

describe('exports runner config', () => {
  it('inline | job (+ EXPORTS_JOB + project) | none — a half-configured job is NOT configured', () => {
    expect(exportsRunnerMode({ EXPORTS_RUNNER: 'inline' })).toBe('inline');
    expect(exportsRunnerMode({ EXPORTS_RUNNER: 'job', EXPORTS_JOB: 'gifsy-exports', GCP_PROJECT: 'p' })).toBe('job');
    expect(exportsRunnerMode({ EXPORTS_RUNNER: 'job', EXPORTS_JOB: 'gifsy-exports', GCP_PROJECT_ID: '﻿p\r' })).toBe('job');
    expect(exportsRunnerMode({ EXPORTS_RUNNER: 'job', GCP_PROJECT: 'p' })).toBe('none');
    expect(exportsRunnerMode({ EXPORTS_RUNNER: 'job', EXPORTS_JOB: 'gifsy-exports' })).toBe('none');
    expect(exportsRunnerConfigured({})).toBe(false);
    // the Sales Import runner settings never configure Downloads
    expect(exportsRunnerConfigured({ SALES_IMPORT_RUNNER: 'job', SALES_IMPORT_JOB: 'x', GCP_PROJECT: 'p' })).toBe(false);
  });
});

describe('ExportsWorkerModule (the gifsy-exports job context)', () => {
  it('resolves every dependency of the engine (and of EXPORT_WORKER_FEATURE_MODULES) without the AppModule', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ExportsWorkerModule] }).compile();
    expect(moduleRef.get(ExportsProcessorService)).toBeInstanceOf(ExportsProcessorService);
    expect(moduleRef.get(ExportsRunnerService)).toBeInstanceOf(ExportsRunnerService);
    await moduleRef.close();
  });
});
