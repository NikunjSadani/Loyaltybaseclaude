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
