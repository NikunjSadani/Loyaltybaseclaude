import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { claimNextExport, hasClaimableExports } from './exports-claim';
import { EXPORT_STALE_HEARTBEAT_MINUTES } from './exports-engine.constants';
import { SchedulerRegistry } from '@nestjs/schedule';
import { KycService } from '../kyc/kyc.service';
import { PointsComputeService } from '../points-engine/points-compute.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { EXPORT_KIND_REGISTRY, ExportsProcessorService } from './exports-processor.service';
import { exportsRunnerConfigured, exportsRunnerMode } from './exports-runner.config';
import { ExportsRunnerService } from './exports-runner.service';
import { ExportsWorkerModule, WORKER_EXPORTS_SERVICE_MESSAGE } from './exports-worker.module';
import { ExportsService } from './exports.service';
import { EXPORT_KINDS } from './kinds';

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
  /**
   * The job loads ExportsWorkerModule + EXPORT_WORKER_FEATURE_MODULES, never AppModule. This compiles AND initialises
   * it exactly like worker.main.ts (createApplicationContext → onModuleInit hooks run) with Prisma/Storage stubbed, so:
   *  - a feature module whose controller/provider injects ExportsService still resolves (worker stub),
   *  - every service a registered kind resolves through ctx.moduleRef is present,
   *  - init starts no timers / scheduled workers (no ScheduleModule.forRoot in the job) and makes no DB call.
   */
  it('compiles + initialises with every feature module, resolves kind services, starts no timers, cannot recurse', async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const prismaCalls: string[] = [];
    const prismaStub = new Proxy(
      {},
      {
        get: (_t, prop) => {
          // Nest probes the value for lifecycle hooks / thenable — that is not a DB call.
          if (typeof prop === 'symbol' || prop === 'then' || /^(on|before)[A-Z]/.test(prop)) return undefined;
          prismaCalls.push(String(prop));
          return () => {
            throw new Error(`worker init must not touch the DB (${String(prop)})`);
          };
        },
      },
    );
    const intervalSpy = jest.spyOn(global, 'setInterval');
    const moduleRef = await Test.createTestingModule({ imports: [ExportsWorkerModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .overrideProvider(StorageService)
      .useValue({})
      .compile();
    const app = moduleRef;
    await app.init(); // runs every onModuleInit, like createApplicationContext in worker.main.ts
    try {
      expect(intervalSpy).not.toHaveBeenCalled();
      expect(prismaCalls).toEqual([]);
      expect(app.get(ExportsProcessorService)).toBeInstanceOf(ExportsProcessorService);
      expect(app.get(ExportsRunnerService)).toBeInstanceOf(ExportsRunnerService);
      // Services the registered kinds resolve via ctx.moduleRef.get(X, { strict: false }).
      expect(app.get(KycService, { strict: false })).toBeDefined();
      expect(app.get(PointsComputeService, { strict: false })).toBeDefined();
      // No scheduler in the job → @Interval/@Cron workers of pulled-in modules are inert.
      expect(() => app.get(SchedulerRegistry, { strict: false })).toThrow();
      // The API surface is a stub inside the job: no self-kick, no second build path.
      const svc = app.get(ExportsService, { strict: false });
      expect(() => svc.request({} as never, 'x', {})).toThrow(WORKER_EXPORTS_SERVICE_MESSAGE);
      expect(() => svc.respond({} as never, {} as never, 'x', {})).toThrow(WORKER_EXPORTS_SERVICE_MESSAGE);
      // Every registered kind is reachable from the job's registry.
      const registry = app.get<ReadonlyMap<string, unknown>>(EXPORT_KIND_REGISTRY);
      expect([...registry.keys()].sort()).toEqual([...EXPORT_KINDS.keys()].sort());
    } finally {
      intervalSpy.mockRestore();
      await app.close();
    }
  }, 120_000);
});
