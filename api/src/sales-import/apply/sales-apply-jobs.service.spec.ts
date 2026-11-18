import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import { SALES_APPLY_MAX_ATTEMPTS } from '../sales-import.contract';
import { ApplyStopError } from './sales-apply.service';
import { SalesApplyJobsService, isUniqueViolation } from './sales-apply-jobs.service';
import { assertNoActiveJob, busyText, istClock } from './apply-jobs-data';

/**
 * Background Apply / Recalculate jobs (owner 2026-11-18). The SQL itself is exercised on a real Postgres by
 * test/sales-apply-jobs.e2e-spec.ts; here an in-memory fake answers each statement so the orchestration is pinned:
 * enqueue (precheck → one insert, resend → same job, active month → 409), and a worker run (months marked DONE inside
 * the write's transaction, failures recorded, whole-job refusal, stop → released, attempts cap).
 * Run: npx jest src/sales-import/apply/sales-apply-jobs.service.spec.ts
 */

const user: JwtPayload = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '', name: 'Asha' };

type Job = Record<string, unknown> & { id: string; status: string; claimToken: string | null; attempts: number };
type Month = { jobId: string; clientId: string; month: string; status: string; result: unknown; lastError?: string | null; startedAt: Date | null; finishedAt: Date | null };

function fakeDb(opts: { flag?: boolean; userStatus?: string; userRole?: string; deleted?: boolean } = {}) {
  const jobs: Job[] = [];
  const months: Month[] = [];
  const log: string[] = [];
  let failInsertWith: unknown = null;
  const text = (q: Prisma.Sql) => q.strings.join('?').replace(/\s+/g, ' ');
  const v = (q: Prisma.Sql) => q.values as unknown[];
  const jobOf = (id: unknown) => jobs.find((j) => j.id === id);
  const queryRaw = jest.fn(async (q: Prisma.Sql) => {
    const t = text(q);
    const vals = v(q);
    if (t.startsWith(' SELECT m."month", j."id" AS "jobId"')) {
      const [clientId, ms] = vals as [string, string[]];
      return months.filter((m) => m.clientId === clientId && ms.includes(m.month) && ['QUEUED', 'RUNNING'].includes(m.status))
        .map((m) => ({ month: m.month, jobId: m.jobId, kind: jobOf(m.jobId)!.kind, status: m.status, importId: jobOf(m.jobId)!.importId,
          requestedByName: jobOf(m.jobId)!.requestedByName, createdAt: jobOf(m.jobId)!.createdAt }));
    }
    if (t.includes('SELECT * FROM "sales_apply_jobs" WHERE "id" =')) return jobs.filter((j) => j.id === vals[0] && j.clientId === vals[1]);
    if (t.includes('SELECT * FROM "sales_apply_jobs" WHERE "clientId" =')) return jobs.filter((j) => j.clientId === vals[0] && j.requestId === vals[1]);
    if (t.includes('SELECT "month","status","result"')) return months.filter((m) => m.jobId === vals[0]).sort((a, b) => a.month.localeCompare(b.month));
    if (t.includes('SELECT "month" FROM "sales_apply_job_months" WHERE "jobId" = ? AND "status" = \'QUEUED\'')) {
      return months.filter((m) => m.jobId === vals[0] && m.status === 'QUEUED').sort((a, b) => a.month.localeCompare(b.month));
    }
    if (t.includes('SELECT "month", "lastError" FROM "sales_apply_job_months" WHERE "jobId" = ? AND "status" IN')) {
      return months.filter((m) => m.jobId === vals[0] && ['QUEUED', 'RUNNING'].includes(m.status));
    }
    if (t.includes('UPDATE "sales_apply_jobs" SET "status" = \'RUNNING\'')) {
      const token = vals[0] as string;
      const exclude = (vals.find((x) => Array.isArray(x)) ?? []) as string[];
      const j = jobs.find((x) => x.status === 'QUEUED' && !exclude.includes(x.id));
      if (!j) return [];
      Object.assign(j, { status: 'RUNNING', claimToken: token, attempts: j.attempts + 1 });
      return [{ ...j }];
    }
    if (t.includes('count(*)::int AS n')) return [{ n: jobs.filter((j) => j.status === 'QUEUED').length }];
    throw new Error(`unexpected query: ${t}`);
  });
  const executeRaw = jest.fn(async (q: Prisma.Sql) => {
    const t = text(q);
    const vals = v(q);
    if (t.includes('WITH j AS')) {
      if (failInsertWith) throw failInsertWith;
      const [id, clientId, kind, importId, requestId, request, requestedById, requestedByName, requestedByRole] = vals as string[];
      jobs.push({ id, clientId, kind, importId, requestId, request: JSON.parse(request), requestedById, requestedByName, requestedByRole,
        status: 'QUEUED', claimToken: null, attempts: 0, error: null, focusBasis: null, createdAt: new Date('2026-11-18T05:02:00.000Z'), startedAt: null, finishedAt: null });
      const [, ids, ms] = vals.slice(-3) as [string, string[], string[]];
      void ids;
      for (const m of ms) months.push({ jobId: id, clientId, month: m, status: 'QUEUED', result: null, startedAt: null, finishedAt: null });
      log.push(`insert:${ms.join(',')}`);
      return 1;
    }
    if (t.includes('SET "heartbeatAt" = (now()')) return 1;
    const held = (jobId: unknown, token: unknown) => jobOf(jobId)?.claimToken === token;
    if (t.includes('UPDATE "sales_apply_job_months" m SET "status" = \'QUEUED\', "startedAt" = NULL')) {
      const [jobId, token] = vals;
      if (!held(jobId, token)) { log.push('reset:refused'); return 0; }
      for (const m of months) if (m.jobId === jobId && m.status === 'RUNNING') m.status = 'QUEUED';
      return 1;
    }
    if (t.includes('SET "lastError" = ?')) {
      const [err, jobId, token, monthA] = vals as string[];
      if (!held(jobId, token)) return 0;
      for (const m of months) if (m.jobId === jobId && ['QUEUED', 'RUNNING'].includes(m.status) && (monthA == null || m.month === monthA)) m.lastError = err;
      return 1;
    }
    if (t.includes('SET "focusBasis" = ?')) {
      const [basis, jobId, token] = vals as string[];
      const j = jobOf(jobId);
      if (j && held(jobId, token) && j.focusBasis == null) j.focusBasis = JSON.parse(basis);
      log.push('basis:saved');
      return 1;
    }
    if (t.includes('SET "status" = \'RUNNING\', "startedAt"')) {
      const [jobId, token, month] = vals as string[];
      const m = months.find((x) => x.jobId === jobId && x.month === month && x.status === 'QUEUED');
      if (!m || !held(jobId, token)) return 0;
      m.status = 'RUNNING';
      log.push(`running:${month}`);
      return 1;
    }
    if (t.includes('SET "status" = \'DONE\', "result"')) {
      const [result, jobId, token, month] = vals as string[];
      const m = months.find((x) => x.jobId === jobId && x.month === month && x.status === 'RUNNING');
      if (!m || !held(jobId, token)) return 0;
      Object.assign(m, { status: 'DONE', result: JSON.parse(result) });
      log.push(`done:${month}`);
      return 1;
    }
    if (t.includes('SET "status" = \'FAILED\', "result"')) {
      const [result, jobId, token, month] = vals as string[];
      const m = months.find((x) => x.jobId === jobId && x.month === month && ['QUEUED', 'RUNNING'].includes(x.status));
      if (!m || !held(jobId, token)) return 0;
      Object.assign(m, { status: 'FAILED', result: JSON.parse(result) });
      log.push(`failed:${month}`);
      return 1;
    }
    if (t.includes('UPDATE "sales_apply_jobs" SET "status" = \'DONE\', "finishedAt"')) {
      const [jobId, token] = vals.slice(-2);
      if (held(jobId, token)) Object.assign(jobOf(jobId)!, { status: 'DONE', claimToken: null });
      log.push('job:DONE');
      return 1;
    }
    if (t.includes('UPDATE "sales_apply_jobs" SET "status" = ?, "error"')) {
      const [status, error] = vals as string[];
      const [jobId, token] = vals.slice(-2);
      if (held(jobId, token)) Object.assign(jobOf(jobId)!, { status, error, claimToken: null });
      log.push(`job:${status}`);
      return 1;
    }
    if (t.includes('UPDATE "sales_apply_jobs" SET "status" = \'QUEUED\', "claimToken" = NULL, "heartbeatAt" = NULL')) {
      const [dec, jobId, token] = vals as [number, string, string];
      if (held(jobId, token)) {
        const j = jobOf(jobId)!;
        Object.assign(j, { status: 'QUEUED', claimToken: null, attempts: Math.max(0, j.attempts - dec) });
        log.push(dec ? 'job:released(not counted)' : 'job:released(counted)');
      } else log.push('job:release-refused');
      return 1;
    }
    throw new Error(`unexpected statement: ${t}`);
  });
  const db = {
    jobs, months, log, $queryRaw: queryRaw, $executeRaw: executeRaw, failInsert: (e: unknown) => { failInsertWith = e; },
    // requester re-check (A-L4)
    client: { findUnique: jest.fn(async () => ({ status: 'ACTIVE', features: { salesImport: opts.flag ?? true } })) },
    user: { findUnique: jest.fn(async () => ({ status: opts.userStatus ?? 'ACTIVE', deletedAt: opts.deleted ? new Date() : null, role: opts.userRole ?? 'CLIENT_ADMIN', gifsyRoleId: null })) },
    gifsyRole: { findFirst: jest.fn(async () => null) },
  };
  return db;
}

function applyMock() {
  return {
    precheckApply: jest.fn(async (_u: JwtPayload, _id: string, body: { months: string[] }) => [...body.months].sort()),
    precheckRecalculate: jest.fn(async () => undefined),
    apply: jest.fn(),
    recalculate: jest.fn(),
  };
}

const body = { months: ['2026-11', '2026-10'], expectedDefinitionsHash: 'h', processingVersion: 2, requestId: 'req-00000001' };

describe('enqueue', () => {
  it('Apply: prechecks, records ONE job with its months (QUEUED) and returns it with old-page-safe results', async () => {
    const db = fakeDb();
    const apply = applyMock();
    const r = await new SalesApplyJobsService(db as never, apply as never).enqueueApply(user, 'imp1', body);
    expect(apply.precheckApply).toHaveBeenCalledWith(user, 'imp1', body);
    expect(db.log).toEqual(['insert:2026-10,2026-11']);
    expect(r.job).toEqual(expect.objectContaining({ kind: 'APPLY', importId: 'imp1', status: 'QUEUED', requestedBy: 'Asha', requestId: 'req-00000001' }));
    expect(r.job.months.map((m) => [m.month, m.status])).toEqual([['2026-10', 'QUEUED'], ['2026-11', 'QUEUED']]);
    expect(r.results).toEqual([
      expect.objectContaining({ month: '2026-10', ok: false, error: expect.stringMatching(/being applied in the background — refresh this page/) }),
      expect.objectContaining({ month: '2026-11', ok: false }),
    ]);
    // the stored request is what the worker runs: validated months, nothing the page did not send
    expect(db.jobs[0].request).toEqual({ months: ['2026-10', '2026-11'], expectedDefinitionsHash: 'h', processingVersion: 2,
      acknowledgePartialMonths: [], acknowledgeOlderThanLastApplied: false, expectedFocusFingerprints: {} });
  });

  it('a resend with the same requestId returns the SAME job — no precheck, no second insert', async () => {
    const db = fakeDb();
    const apply = applyMock();
    const svc = new SalesApplyJobsService(db as never, apply as never);
    const a = await svc.enqueueApply(user, 'imp1', body);
    const b = await svc.enqueueApply(user, 'imp1', body);
    expect(b.job.id).toBe(a.job.id);
    expect(apply.precheckApply).toHaveBeenCalledTimes(1);
    expect(db.log).toEqual(['insert:2026-10,2026-11']);
  });

  it('a precheck refusal (4xx) records nothing', async () => {
    const db = fakeDb();
    const apply = applyMock();
    apply.precheckApply.mockRejectedValue(new BadRequestException('Select at least one month.'));
    await expect(new SalesApplyJobsService(db as never, apply as never).enqueueApply(user, 'imp1', body)).rejects.toBeInstanceOf(BadRequestException);
    expect(db.log).toEqual([]);
  });

  it('a month with an active job → 409 naming who and since when (IST)', async () => {
    const db = fakeDb();
    const apply = applyMock();
    const svc = new SalesApplyJobsService(db as never, apply as never);
    await svc.enqueueApply({ ...user, name: 'Ravi' }, 'imp1', { ...body, months: ['2026-10'], requestId: 'req-ravi-0001' });
    db.failInsert(Object.assign(new Error('Raw query failed. Code: `23505`. Message: `duplicate key value violates unique constraint "sales_apply_job_months_active_month_key"`'), { code: 'P2010', meta: { code: '23505' } }));
    const p = svc.enqueueApply(user, 'imp1', { ...body, requestId: 'req-asha-0002' });
    await expect(p).rejects.toBeInstanceOf(ConflictException);
    await expect(p).rejects.toThrow(/^October 2026 is being applied by Ravi since (\d+ \w+, )?10:32\. Wait for it to finish, then check the result before applying again\.$/);
  });

  it('Recalculate: prechecks and records a RECALC job for the one month', async () => {
    const db = fakeDb();
    const apply = applyMock();
    const r = await new SalesApplyJobsService(db as never, apply as never)
      .enqueueRecalculate(user, '2026-10', { expectedDefinitionsHash: 'h', expectedHistoryAppliedAt: 'x', requestId: 'req-recalc-01' });
    expect(apply.precheckRecalculate).toHaveBeenCalled();
    expect(r.job).toEqual(expect.objectContaining({ kind: 'RECALC', importId: null }));
    expect(r.results[0].error).toMatch(/being recalculated in the background/);
  });
});

describe('worker run', () => {
  async function queued(months = ['2026-10', '2026-11']) {
    const db = fakeDb();
    const apply = applyMock();
    const svc = new SalesApplyJobsService(db as never, apply as never);
    await svc.enqueueApply(user, 'imp1', { ...body, months });
    db.log.length = 0;
    return { db, apply, svc };
  }
  /** A fake SalesApplyService.apply that runs the hooks the way the real one does (tx = the db). */
  const runsHooks = (db: ReturnType<typeof fakeDb>, outcome: Record<string, boolean>) =>
    async (_u: JwtPayload, _id: string, req: { months: string[] }, hooks: { beforeMonth(m: string): Promise<void>; inTx(tx: unknown, r: unknown): Promise<void> }) => {
      const results: Array<Record<string, unknown>> = [];
      for (const month of req.months) {
        try {
          await hooks.beforeMonth(month);
        } catch (e) {
          if (e instanceof ApplyStopError) throw e;
        }
        if (outcome[month]) {
          const res = { month, ok: true, applyId: `a-${month}`, outletsWritten: 5, outletsZeroFilled: 1 };
          await hooks.inTx(db, res);
          results.push(res);
        } else results.push({ month, ok: false, error: `${month} is closed.` });
      }
      return { results };
    };

  it('claims, marks each month RUNNING then DONE inside the write transaction, records a failure, ends DONE', async () => {
    const { db, apply, svc } = await queued();
    apply.apply.mockImplementation(runsHooks(db, { '2026-10': true, '2026-11': false }));
    expect(await svc.drain()).toEqual({ finished: 1, released: 0 });
    expect(apply.apply).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'u1', clientId: 't1', name: 'Asha', role: 'CLIENT_ADMIN' }), 'imp1',
      expect.objectContaining({ months: ['2026-10', '2026-11'], expectedDefinitionsHash: 'h' }), expect.anything(), expect.anything());
    expect(db.log).toEqual(['running:2026-10', 'done:2026-10', 'running:2026-11', 'failed:2026-11', 'job:DONE']);
    const job = await svc.getJob('t1', db.jobs[0].id);
    expect(job.status).toBe('DONE');
    expect(job.months).toEqual([
      expect.objectContaining({ month: '2026-10', status: 'DONE', result: expect.objectContaining({ ok: true, outletsWritten: 5 }) }),
      expect.objectContaining({ month: '2026-11', status: 'FAILED', result: expect.objectContaining({ ok: false, error: '2026-11 is closed.' }) }),
    ]);
  });

  it('a reclaimed job re-runs ONLY the months not yet written (a DONE month is never applied twice)', async () => {
    const { db, apply, svc } = await queued();
    db.months[0].status = 'DONE'; // 2026-10 committed by a run that then died
    db.months[1].status = 'RUNNING'; // 2026-11 was in flight → its transaction rolled back
    apply.apply.mockImplementation(runsHooks(db, { '2026-11': true }));
    await svc.drain();
    expect(apply.apply.mock.calls[0][2].months).toEqual(['2026-11']);
    expect(db.log).toEqual(['running:2026-11', 'done:2026-11', 'job:DONE']);
  });

  it('a whole-job refusal (4xx before any write, e.g. focus products changed) → every month FAILED with the reason, job FAILED', async () => {
    const { db, apply, svc } = await queued();
    apply.apply.mockRejectedValue(new ConflictException('The focus products changed since the preview. Refresh the preview and apply again.'));
    await svc.drain();
    expect(db.log).toEqual(['failed:2026-10', 'failed:2026-11', 'job:FAILED']);
    const job = await svc.getJob('t1', db.jobs[0].id);
    expect(job.error).toMatch(/focus products changed/);
    expect(job.months.every((m) => m.status === 'FAILED' && /focus products changed/.test(m.result?.error ?? ''))).toBe(true);
  });

  it('a stop between months hands the job back (QUEUED; the unwritten month QUEUED again) for the next run', async () => {
    const { db, apply, svc } = await queued();
    const stop = { requested: false };
    apply.apply.mockImplementation(async (u: JwtPayload, id: string, req: { months: string[] }, hooks: never) => {
      const run = runsHooks(db, { '2026-10': true, '2026-11': true });
      const wrapped = {
        beforeMonth: async (m: string) => { if (m === '2026-11') stop.requested = true; return (hooks as { beforeMonth(m: string): Promise<void> }).beforeMonth(m); },
        inTx: (hooks as { inTx(tx: unknown, r: unknown): Promise<void> }).inTx,
      };
      return run(u, id, req, wrapped);
    });
    expect(await svc.drain(stop)).toEqual({ finished: 0, released: 1 });
    expect(db.log).toEqual(['running:2026-10', 'done:2026-10', 'job:released(not counted)']);
    expect(db.jobs[0].status).toBe('QUEUED');
    expect(db.months.map((m) => m.status)).toEqual(['DONE', 'QUEUED']);
  });

  it('an unexpected error (DB unreachable) hands the job back instead of failing it', async () => {
    const { db, apply, svc } = await queued();
    apply.apply.mockRejectedValue(new Error('Connection terminated'));
    expect(await svc.drain({ requested: false } as never).catch(() => 'threw')).toBeDefined();
    expect(db.log[0]).toBe('job:released(counted)');
  });

  it(`more than ${SALES_APPLY_MAX_ATTEMPTS} claims → the remaining months FAILED (never an endless retry)`, async () => {
    const { db, apply, svc } = await queued(['2026-10']);
    db.jobs[0].attempts = SALES_APPLY_MAX_ATTEMPTS; // the claim makes it MAX + 1
    await svc.drain();
    expect(apply.apply).not.toHaveBeenCalled();
    expect(db.log).toEqual(['failed:2026-10', 'job:DONE']);
    expect(db.months[0].result).toEqual(expect.objectContaining({ error: expect.stringMatching(/Stopped after 3 attempts/) }));
  });

  it('a lost claim (another run took the job) writes nothing more: DONE is refused inside the transaction', async () => {
    const { db, apply, svc } = await queued(['2026-10']);
    apply.apply.mockImplementation(async (_u: JwtPayload, _id: string, req: { months: string[] }, hooks: { beforeMonth(m: string): Promise<void>; inTx(tx: unknown, r: unknown): Promise<void> }) => {
      await hooks.beforeMonth(req.months[0]);
      db.jobs[0].claimToken = 'someone-else';
      await expect(hooks.inTx(db, { month: req.months[0], ok: true })).rejects.toThrow(/claim lost/);
      return { results: [{ month: req.months[0], ok: false, error: 'Apply failed for this month. Nothing was changed for it.' }] };
    });
    await svc.drain();
    expect(db.log).toEqual(['running:2026-10', 'job:DONE']); // no done:, no failed: (both guarded by the claim)
  });

  it('Recalculate job: runs recalculate with the stored request; a refusal is recorded on the month', async () => {
    const db = fakeDb();
    const apply = applyMock();
    const svc = new SalesApplyJobsService(db as never, apply as never);
    await svc.enqueueRecalculate(user, '2026-10', { expectedDefinitionsHash: 'h', expectedHistoryAppliedAt: 'x', requestId: 'req-recalc-02' });
    db.log.length = 0;
    apply.recalculate.mockRejectedValue(new ConflictException('A newer file was applied to this month since the preview.'));
    await svc.drain();
    expect(apply.recalculate).toHaveBeenCalledWith(expect.objectContaining({ sub: 'u1' }), '2026-10',
      { expectedDefinitionsHash: 'h', expectedHistoryAppliedAt: 'x' }, expect.anything());
    expect(db.log).toEqual(['running:2026-10', 'failed:2026-10', 'job:DONE']);
    expect(db.months[0].result).toEqual(expect.objectContaining({ ok: false, error: 'A newer file was applied to this month since the preview.' }));
  });
});

describe('helpers', () => {
  it('assertNoActiveJob: 409 "… is being applied by X since 10:32 — try again when it finishes."', async () => {
    const db = fakeDb();
    const svc = new SalesApplyJobsService(db as never, applyMock() as never);
    await svc.enqueueApply({ ...user, name: 'Ravi' }, 'imp1', { ...body, months: ['2026-10'] });
    await expect(assertNoActiveJob(db as never, 't1', '2026-10')).rejects.toThrow(/^October 2026 is being applied by Ravi since (\d+ \w+, )?10:32 — try again when it finishes\.$/);
    await expect(assertNoActiveJob(db as never, 't1', '2026-09')).resolves.toBeUndefined();
  });
  it('istClock / busyText use India time', () => {
    const sameDay = new Date('2026-11-18T08:00:00.000Z');
    expect(istClock('2026-11-18T05:02:00.000Z', sameDay)).toBe('10:32');
    // B-L11: another day shows the date
    expect(istClock('2026-11-17T05:02:00.000Z', sameDay)).toBe('17 Nov, 10:32');
    expect(busyText('2026-10', { kind: 'RECALC', requestedBy: 'Asha', createdAt: '2026-11-18T18:45:00.000Z' }, new Date('2026-11-18T19:00:00.000Z')))
      .toBe('October 2026 is being recalculated by Asha since 00:15');
  });
  it('isUniqueViolation recognises the raw (P2010/23505) and typed (P2002) forms, optionally of one index', () => {
    const raw = Object.assign(new Error('… unique constraint "sales_apply_job_months_active_month_key"'), { code: 'P2010', meta: { code: '23505' } });
    expect(isUniqueViolation(raw)).toBe(true);
    expect(isUniqueViolation(raw, 'sales_apply_job_months_active_month_key')).toBe(true);
    expect(isUniqueViolation(raw, 'sales_apply_jobs_clientId_requestId_key')).toBe(false);
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isUniqueViolation(new Error('timeout'))).toBe(false);
  });
});

describe('controllers: enqueue (202) then start the worker', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SalesImportApplyController } = require('../sales-import-apply.controller');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SalesMonthsController } = require('../sales-months.controller');
  const tenant = { findById: jest.fn(async () => ({ id: 't1', status: 'ACTIVE', features: { salesImport: true } })) };
  const prisma = { client: { findUnique: jest.fn(async () => ({ id: 't1', status: 'ACTIVE', features: { salesImport: true } })) } };
  const queuedJob = { job: { id: 'j1', status: 'QUEUED', months: [] }, results: [] };

  it('POST :id/apply is HTTP 202, enqueues and kicks the worker; a resend of a finished job does not kick', async () => {
    expect(Reflect.getMetadata('__httpCode__', SalesImportApplyController.prototype.postApply)).toBe(202);
    const jobs = { enqueueApply: jest.fn(async () => queuedJob) };
    const runner = { kick: jest.fn(async () => 'job') };
    const c = new SalesImportApplyController({} as never, {} as never, tenant as never, prisma as never, jobs as never, runner as never);
    jest.spyOn(require('../sales-import-access'), 'assertSalesImportAccess').mockResolvedValue(undefined);
    await expect(c.postApply(user, 'imp1', body)).resolves.toBe(queuedJob);
    expect(jobs.enqueueApply).toHaveBeenCalledWith(user, 'imp1', body);
    expect(runner.kick).toHaveBeenCalledTimes(1);
    jobs.enqueueApply.mockResolvedValue({ job: { id: 'j1', status: 'DONE', months: [] }, results: [] } as never);
    await c.postApply(user, 'imp1', body);
    expect(runner.kick).toHaveBeenCalledTimes(1);
  });

  it('POST :month/recalculate is HTTP 202 and enqueues a RECALC job', async () => {
    expect(Reflect.getMetadata('__httpCode__', SalesMonthsController.prototype.recalculate)).toBe(202);
    const jobs = { enqueueRecalculate: jest.fn(async () => queuedJob) };
    const runner = { kick: jest.fn(async () => 'job') };
    const c = new SalesMonthsController({} as never, tenant as never, prisma as never, {} as never, jobs as never, runner as never);
    jest.spyOn(require('../sales-import-access'), 'assertSalesImportAccess').mockResolvedValue(undefined);
    const req = { expectedDefinitionsHash: 'h', expectedHistoryAppliedAt: 'x', requestId: 'req-00000009' };
    await expect(c.recalculate(user, '2026-10', req)).resolves.toBe(queuedJob);
    expect(jobs.enqueueRecalculate).toHaveBeenCalledWith(user, '2026-10', req);
    expect(runner.kick).toHaveBeenCalledTimes(1);
  });
});

describe('audit fixes (dual audit of e1ce98d8)', () => {
  type Hooks = { beforeMonth(m: string): Promise<void>; inTx(tx: unknown, r: unknown): Promise<void> };
  async function queued(months = ['2026-10'], o: Parameters<typeof fakeDb>[0] = {}) {
    const db = fakeDb(o);
    const apply = applyMock();
    const svc = new SalesApplyJobsService(db as never, apply as never);
    await svc.enqueueApply(user, 'imp1', { ...body, months });
    db.log.length = 0;
    return { db, apply, svc };
  }
  /** A stop token like WorkerStop: listeners fire on request(). */
  function stopToken() {
    const ls: Array<(r: string) => void> = [];
    const t = { requested: false, onStop: (cb: (r: string) => void) => { ls.push(cb); return () => undefined; },
      request: () => { t.requested = true; ls.forEach((l) => l('SIGTERM')); } };
    return t;
  }

  it('A-M2: a stop signal MID-month hands the job back at once (QUEUED, no heartbeat, not counted); the in-flight month cannot commit DONE', async () => {
    const { db, apply, svc } = await queued();
    const stop = stopToken();
    apply.apply.mockImplementation(async (_u: JwtPayload, _i: string, req: { months: string[] }, hooks: Hooks) => {
      await hooks.beforeMonth(req.months[0]);
      stop.request(); // SIGTERM while the month is writing
      await new Promise((r) => setImmediate(r));
      await expect(hooks.inTx(db, { month: req.months[0], ok: true })).rejects.toThrow(/claim lost/);
      return { results: [{ month: req.months[0], ok: false, error: 'Apply failed for this month. Nothing was changed for it.' }] };
    });
    expect(await svc.drain(stop)).toEqual({ finished: 0, released: 1 });
    expect(db.jobs[0]).toEqual(expect.objectContaining({ status: 'QUEUED', claimToken: null, attempts: 0 }));
    expect(db.months[0].status).toBe('QUEUED');
    expect(db.log).toContain('job:released(not counted)');
    expect(db.log).not.toContain('done:2026-10');
    expect(db.log).not.toContain('failed:2026-10');
  });

  it('A-M3: a run that lost its claim cannot reset or release a month of the run that took the job over', async () => {
    const { db, apply, svc } = await queued();
    apply.apply.mockImplementation(async (_u: JwtPayload, _i: string, req: { months: string[] }, hooks: Hooks) => {
      await hooks.beforeMonth(req.months[0]);
      db.jobs[0].claimToken = 'newer-run'; // another worker reclaimed it; its month is RUNNING
      throw new Error('Connection terminated');
    });
    await svc.drain();
    expect(db.log).toEqual(['running:2026-10', 'reset:refused', 'job:release-refused']);
    expect(db.months[0].status).toBe('RUNNING'); // the newer run's month is untouched
    expect(db.jobs[0].claimToken).toBe('newer-run');
  });

  it('A-L2 + A-L3: a transient DB error hands the job back (counted) with the month lastError; when the attempts run out the reason is shown', async () => {
    const { TransientApplyError } = await import('./sales-apply.service');
    const { db, apply, svc } = await queued();
    apply.apply.mockImplementation(async (_u: JwtPayload, _i: string, req: { months: string[] }, hooks: Hooks) => {
      await hooks.beforeMonth(req.months[0]);
      throw new TransientApplyError(req.months[0], 'October 2026: a temporary database problem (deadlock detected)');
    });
    for (let i = 0; i < SALES_APPLY_MAX_ATTEMPTS; i++) expect(await svc.drain()).toEqual({ finished: 0, released: 1 });
    expect(db.months[0]).toEqual(expect.objectContaining({ status: 'QUEUED', lastError: 'October 2026: a temporary database problem (deadlock detected)' }));
    expect(db.jobs[0].attempts).toBe(SALES_APPLY_MAX_ATTEMPTS);
    expect(await svc.drain()).toEqual({ finished: 1, released: 0 }); // the next claim is attempt MAX + 1
    expect(db.months[0].result).toEqual(expect.objectContaining({ ok: false,
      error: `Stopped after ${SALES_APPLY_MAX_ATTEMPTS} attempts without finishing: October 2026: a temporary database problem (deadlock detected). Nothing more was written for this month — check it and apply again.` }));
    expect(apply.apply).toHaveBeenCalledTimes(SALES_APPLY_MAX_ATTEMPTS);
  });

  it('A-L3: stops do not use up attempts (a job stopped many times still runs)', async () => {
    const { db, apply, svc } = await queued();
    apply.apply.mockImplementation(async () => { throw new ApplyStopError('stopping'); });
    for (let i = 0; i < SALES_APPLY_MAX_ATTEMPTS + 2; i++) await svc.drain();
    expect(db.jobs[0]).toEqual(expect.objectContaining({ status: 'QUEUED', attempts: 0 }));
  });

  it.each([
    [{ flag: false }, /Sales Import was turned off for this client before this apply ran\. Nothing was written\./],
    [{ userStatus: 'SUSPENDED' }, /Asha.s account is no longer active, so this apply was not run\. Nothing was written/],
    [{ deleted: true }, /Asha.s account is no longer active/],
    [{ userRole: 'SALES_USER' }, /Asha is no longer allowed to apply sales files, so this apply was not run\. Nothing was written\./],
  ])('A-L4: the worker re-checks the tenant flag and the requester before running (%j) → every month FAILED with the reason, nothing applied', async (o, why) => {
    const { db, apply, svc } = await queued(['2026-10', '2026-11'], o as never);
    await svc.drain();
    expect(apply.apply).not.toHaveBeenCalled();
    expect(db.jobs[0]).toEqual(expect.objectContaining({ status: 'FAILED', error: expect.stringMatching(why) }));
    expect(db.months.every((m) => m.status === 'FAILED' && why.test((m.result as { error: string }).error))).toBe(true);
  });

  it('A-L5: a requestId reused for a DIFFERENT apply (months / import / kind) → 409, never the old job', async () => {
    const db = fakeDb();
    const svc = new SalesApplyJobsService(db as never, applyMock() as never);
    await svc.enqueueApply(user, 'imp1', body);
    await expect(svc.enqueueApply(user, 'imp1', { ...body, months: ['2026-10'] })).rejects.toThrow('This request id was already used for a different apply. Refresh the page and try again.');
    await expect(svc.enqueueApply(user, 'imp2', body)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.enqueueRecalculate(user, '2026-10', { expectedDefinitionsHash: 'h', expectedHistoryAppliedAt: 'x', requestId: body.requestId })).rejects.toBeInstanceOf(ConflictException);
    expect((await svc.enqueueApply(user, 'imp1', { ...body, months: ['2026-10', '2026-11'] })).job.months).toHaveLength(2); // same months, any order → same job
  });

  it('A-M1 (worker): the first run saves the product-list snapshot; a retry passes it back to apply()', async () => {
    const { db, apply, svc } = await queued(['2026-09', '2026-10']);
    const SNAP = [{ dims: '{"dimA":"R"}' }];
    apply.apply.mockImplementationOnce(async (_u: JwtPayload, _i: string, _req: { months: string[] }, hooks: Hooks, job: { onFocusHistory(h: unknown): Promise<void> }) => {
      await job.onFocusHistory(SNAP);
      await hooks.beforeMonth('2026-09');
      await hooks.inTx(db, { month: '2026-09', ok: true });
      throw new ApplyStopError('worker killed');
    });
    await svc.drain();
    expect(db.jobs[0].focusBasis).toEqual(SNAP);
    apply.apply.mockImplementationOnce(async () => ({ results: [{ month: '2026-10', ok: true }] }));
    await svc.drain();
    expect(apply.apply.mock.calls[1][2].months).toEqual(['2026-10']);
    expect(apply.apply.mock.calls[1][4]).toEqual(expect.objectContaining({ focusHistory: SNAP }));
  });

  it('B-H2: a Recalculate 202 also carries a top-level not-ok month result, so an OLD Months tab never shows "recalculated"', async () => {
    const r = await new SalesApplyJobsService(fakeDb() as never, applyMock() as never)
      .enqueueRecalculate(user, '2026-10', { expectedDefinitionsHash: 'h', expectedHistoryAppliedAt: 'x', requestId: 'req-recalc-77' });
    expect(r).toEqual(expect.objectContaining({ month: '2026-10', ok: false, error: expect.stringMatching(/being recalculated in the background — refresh this page to follow it/) }));
    expect(r.job.attempts).toBe(0);
    // B-L3: an old page renders "<Month>: not applied" above this text — it starts by saying it is simply not finished yet.
    expect(r.results[0].error).toMatch(/^Not finished yet: October 2026 is being recalculated in the background/);
  });
});
