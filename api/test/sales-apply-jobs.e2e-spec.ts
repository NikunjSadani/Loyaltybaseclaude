/**
 * Background Apply / Recalculate jobs × a REAL Postgres (owner 2026-11-18). Pins what the unit fake cannot:
 *   - the migration SQL runs, and its PARTIAL unique index allows ONE active job per tenant × month (a second → 409),
 *     while a finished month frees it;
 *   - two concurrent claims never take the same job (FOR UPDATE SKIP LOCKED);
 *   - a month marked DONE inside a transaction that then rolls back stays RUNNING (DONE commits only with the write);
 *   - the timestamps are UTC (SQL_NOW_UTC) — a fresh RUNNING job is not "stale".
 *
 * Runs under `npm run test:e2e` ONLY when DATABASE_URL is set AND SALES_IMPORT_E2E=1, and refuses staging / prod. Every
 * table lives in a throw-away SCHEMA created from the migration file and dropped in afterAll — nothing else is touched.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { SalesApplyJobsService } from '../src/sales-import/apply/sales-apply-jobs.service';
import type { JwtPayload } from '../src/common/decorators/current-user.decorator';

const enabled = !!process.env.DATABASE_URL && process.env.SALES_IMPORT_E2E === '1';
const d = enabled ? describe : describe.skip;
const SCHEMA = `e2e_apply_jobs_${randomUUID().slice(0, 8)}`;

d('SalesApplyJobsService × real Postgres', () => {
  let prisma: PrismaService;
  let svc: SalesApplyJobsService;
  const user: JwtPayload = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: `t-${SCHEMA}`, phone: '', name: 'Asha' };
  const apply = {
    precheckApply: jest.fn(async (_u: unknown, _i: unknown, b: { months: string[] }) => [...b.months].sort()),
    precheckRecalculate: jest.fn(async () => undefined),
    apply: jest.fn(),
    recalculate: jest.fn(),
  };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    const admin = new PrismaService();
    const [{ db }] = await admin.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`;
    if (/prod|staging/i.test(db)) throw new Error(`Refusing to run against ${db}`);
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.$disconnect();
    url.searchParams.set('schema', SCHEMA);
    process.env.DATABASE_URL = url.toString();
    prisma = new PrismaService();
    const sql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '20261118170000_sales_apply_jobs', 'migration.sql'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(stmt);
    svc = new SalesApplyJobsService(prisma, apply as never);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.$executeRawUnsafe(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    await prisma.$disconnect();
  });

  it('one active job per tenant × month: a second → 409 naming who; a finished month frees it', async () => {
    const a = await svc.enqueueApply(user, 'imp1', { months: ['2026-10', '2026-11'], expectedDefinitionsHash: 'h', processingVersion: 1, requestId: 'req-real-0001' });
    expect(a.job.months.map((m) => m.status)).toEqual(['QUEUED', 'QUEUED']);
    await expect(svc.enqueueApply({ ...user, name: 'Ravi' }, 'imp2', { months: ['2026-11'], expectedDefinitionsHash: 'h', processingVersion: 1, requestId: 'req-real-0002' }))
      .rejects.toThrow(ConflictException);
    // the same click resent → the same job, nothing new
    expect((await svc.enqueueApply(user, 'imp1', { months: ['2026-10'], expectedDefinitionsHash: 'h', processingVersion: 1, requestId: 'req-real-0001' })).job.id).toBe(a.job.id);
    await prisma.$executeRawUnsafe(`UPDATE "sales_apply_job_months" SET "status" = 'DONE' WHERE "jobId" = '${a.job.id}'`);
    const b = await svc.enqueueApply(user, 'imp2', { months: ['2026-11'], expectedDefinitionsHash: 'h', processingVersion: 1, requestId: 'req-real-0003' });
    expect(b.job.status).toBe('QUEUED');
  });

  it('two concurrent claims never take the same job; a fresh RUNNING job is not stale (UTC timestamps)', async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "sales_apply_jobs"`);
    await svc.enqueueApply(user, 'imp1', { months: ['2026-09'], expectedDefinitionsHash: 'h', processingVersion: 1, requestId: 'req-real-0004' });
    const [x, y] = await Promise.all([svc.claimNext(), svc.claimNext()]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(await svc.claimNext()).toBeNull();
    expect(await svc.hasClaimable()).toBe(false);
  });

  describe('release — ONE statement: job back to QUEUED + its unwritten months, guarded by the claim token', () => {
    type Release = (j: unknown, t: string, o: { countAttempt: boolean; lastError?: string; month?: string }) => Promise<void>;
    const release = () => (svc as unknown as { release: Release }).release.bind(svc);
    async function claimedWithRunningMonth(months: string[], requestId: string) {
      await prisma.$executeRawUnsafe(`DELETE FROM "sales_apply_jobs"`);
      const { job } = await svc.enqueueApply(user, 'imp1', { months, expectedDefinitionsHash: 'h', processingVersion: 1, requestId });
      const claimed = (await svc.claimNext())!;
      await prisma.$executeRawUnsafe(`UPDATE "sales_apply_job_months" SET "status" = 'RUNNING' WHERE "jobId" = '${job.id}' AND "month" = '${months[0]}'`);
      return { job, claimed };
    }
    const state = async (jobId: string) => ({
      job: (await prisma.$queryRawUnsafe<Array<{ status: string; claimToken: string | null; heartbeatAt: Date | null; attempts: number }>>(
        `SELECT "status","claimToken","heartbeatAt","attempts" FROM "sales_apply_jobs" WHERE "id" = '${jobId}'`))[0],
      months: await prisma.$queryRawUnsafe<Array<{ month: string; status: string; lastError: string | null; startedAt: Date | null }>>(
        `SELECT "month","status","lastError","startedAt" FROM "sales_apply_job_months" WHERE "jobId" = '${jobId}' ORDER BY "month"`),
    });

    it('countAttempt false (a stop): attempts back down, heartbeat cleared, RUNNING month QUEUED, no lastError', async () => {
      const { job, claimed } = await claimedWithRunningMonth(['2026-06', '2026-07'], 'req-real-rel-1');
      await release()(claimed, claimed.claimToken!, { countAttempt: false });
      const s = await state(job.id);
      expect(s.job).toEqual(expect.objectContaining({ status: 'QUEUED', claimToken: null, heartbeatAt: null, attempts: 0 }));
      expect(s.months.map((m) => [m.month, m.status, m.lastError])).toEqual([['2026-06', 'QUEUED', null], ['2026-07', 'QUEUED', null]]);
      expect(s.months[0].startedAt).toBeNull();
    });

    it('countAttempt true + lastError for ONE month: the attempt is kept; only that month carries the error', async () => {
      const { job, claimed } = await claimedWithRunningMonth(['2026-06', '2026-07'], 'req-real-rel-2');
      await release()(claimed, claimed.claimToken!, { countAttempt: true, lastError: 'deadlock detected', month: '2026-06' });
      const s = await state(job.id);
      expect(s.job.attempts).toBe(1);
      expect(s.months.map((m) => [m.month, m.status, m.lastError])).toEqual([['2026-06', 'QUEUED', 'deadlock detected'], ['2026-07', 'QUEUED', null]]);
    });

    it('lastError without a month: every unwritten month carries it; a DONE month is untouched', async () => {
      const { job, claimed } = await claimedWithRunningMonth(['2026-05', '2026-06', '2026-07'], 'req-real-rel-3');
      await prisma.$executeRawUnsafe(`UPDATE "sales_apply_job_months" SET "status" = 'DONE' WHERE "jobId" = '${job.id}' AND "month" = '2026-07'`);
      await release()(claimed, claimed.claimToken!, { countAttempt: true, lastError: 'connection reset' });
      const s = await state(job.id);
      expect(s.months.map((m) => [m.month, m.status, m.lastError])).toEqual([
        ['2026-05', 'QUEUED', 'connection reset'], ['2026-06', 'QUEUED', 'connection reset'], ['2026-07', 'DONE', null]]);
    });

    it('a stale token changes NOTHING (neither the job nor any month)', async () => {
      const { job, claimed } = await claimedWithRunningMonth(['2026-06'], 'req-real-rel-4');
      await release()(claimed, 'not-the-holder', { countAttempt: false, lastError: 'x' });
      const s = await state(job.id);
      expect(s.job).toEqual(expect.objectContaining({ status: 'RUNNING', claimToken: claimed.claimToken, attempts: 1 }));
      expect(s.months[0]).toEqual(expect.objectContaining({ status: 'RUNNING', lastError: null }));
    });
  });

  it('DONE inside a transaction that rolls back stays RUNNING (DONE commits only with the write)', async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "sales_apply_jobs"`);
    const { job } = await svc.enqueueApply(user, 'imp1', { months: ['2026-08'], expectedDefinitionsHash: 'h', processingVersion: 1, requestId: 'req-real-0005' });
    const claimed = (await svc.claimNext())!;
    const hooks = (svc as unknown as { hooks(j: unknown, t: string, s: { requested: boolean }): { beforeMonth(m: string): Promise<void>; inTx(tx: unknown, r: unknown): Promise<void> } })
      .hooks(claimed, claimed.claimToken!, { requested: false });
    await hooks.beforeMonth('2026-08');
    await expect(prisma.$transaction(async (tx) => {
      await hooks.inTx(tx, { month: '2026-08', ok: true, applyId: 'a1' });
      throw new Error('the write failed after DONE was set');
    })).rejects.toThrow('the write failed');
    expect((await svc.getJob(user.clientId, job.id)).months[0].status).toBe('RUNNING');
    await prisma.$transaction(async (tx) => hooks.inTx(tx, { month: '2026-08', ok: true, applyId: 'a1' }));
    expect((await svc.getJob(user.clientId, job.id)).months[0]).toEqual(expect.objectContaining({ status: 'DONE', result: expect.objectContaining({ applyId: 'a1' }) }));
  });
});
