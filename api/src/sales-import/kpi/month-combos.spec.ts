import type { Prisma } from '@prisma/client';
import { lockSalesMonth } from '../../common/sales-kpi-ownership';
import {
  COMBOS_REFRESH_HTTP_LIMITS,
  COMBOS_REFRESH_WORKER_LIMITS,
  classifyMonthSummaries,
  insertMonthCombosSql,
  refreshStaleMonthCombos,
  salesMonthLockKey,
  type CombosRefreshLimits,
} from './month-combos';

const AT = new Date('2026-11-01T10:00:00.000Z');

describe('classifyMonthSummaries (from the set header stamp alone)', () => {
  const head = (month: string, over: Partial<{ lineRows: number; combosSourceImportId: string | null; combosAppliedAt: Date | null }> = {}) => ({
    month, sourceImportId: `imp-${month}`, appliedAt: AT, lineRows: 5, combosSourceImportId: `imp-${month}`, combosAppliedAt: AT, ...over,
  });

  it('current / stale (other import or other apply time) / missing (never stamped, has lines) / empty', () => {
    const s = classifyMonthSummaries([
      head('2026-01'),
      head('2026-02', { combosSourceImportId: 'imp-OLD' }),
      head('2026-03', { combosAppliedAt: new Date(AT.getTime() - 1) }),
      head('2026-04', { combosSourceImportId: null, combosAppliedAt: null }),
      head('2026-05', { combosSourceImportId: null, combosAppliedAt: null, lineRows: 0 }),
    ]);
    expect(Object.fromEntries(s)).toEqual({ '2026-01': 'current', '2026-02': 'stale', '2026-03': 'stale', '2026-04': 'missing', '2026-05': 'empty' });
  });
});

describe('insertMonthCombosSql', () => {
  it('one INSERT … SELECT grouped by dimKey + dims, stamped with the set', () => {
    const q = insertMonthCombosSql('t1', '2026-10', 'imp1', AT);
    expect(q.sql).toMatch(/INSERT INTO "sales_month_history_combos"/);
    expect(q.sql).toMatch(/GROUP BY h\."clientId", h\."month", h\."dimKey", h\."dims"\s*$/);
    expect(q.sql).not.toMatch(/array_agg/);
    expect(q.values).toEqual(['imp1', AT.toISOString(), 't1', '2026-10']);
  });
});

describe('refresh limits (re-check M1 / L2)', () => {
  it('statements stay at 25 s (below the 30 s close / reopen and 60 s upload waiters on the month lock)', () => {
    expect(COMBOS_REFRESH_WORKER_LIMITS.statementTimeoutMs).toBe(25_000);
    expect(COMBOS_REFRESH_HTTP_LIMITS.statementTimeoutMs).toBe(25_000);
  });

  it('the HTTP path (Cloud Scheduler drain) ends well inside the 170 s attempt deadline even in the worst case', () => {
    const { limit, budgetMs, txTimeoutMs } = COMBOS_REFRESH_HTTP_LIMITS;
    expect(limit).toBeLessThanOrEqual(2);
    // the last month can start just before the budget ends and then run to its tx bound (+ maxWait 5 s)
    const worstMs = Math.min(budgetMs + txTimeoutMs + 5_000, limit * (txTimeoutMs + 5_000));
    expect(worstMs).toBeLessThanOrEqual(80_000); // leaves ~90 s for the retention sweep under a 170 s deadline
  });
});

describe('refreshStaleMonthCombos (background repair; never on a request)', () => {
  it('uses the SAME advisory-lock key as the apply (lockSalesMonth)', async () => {
    const tx = { $executeRaw: jest.fn(async (_q: Prisma.Sql) => 1) };
    await lockSalesMonth(tx as never, 't1', '2026-10');
    expect(tx.$executeRaw.mock.calls[0][0].values[0]).toBe(salesMonthLockKey('t1', '2026-10'));
  });

  const LIMITS: CombosRefreshLimits = { limit: 5, budgetMs: 60_000, statementTimeoutMs: 25_000, txTimeoutMs: 30_000 };

  function make(opts: { candidates?: Array<{ clientId: string; month: string }>; locked?: string[]; fresh?: string[]; fail?: string[] } = {}) {
    const candidates = opts.candidates ?? [{ clientId: 't1', month: '2026-10' }, { clientId: 't2', month: '2026-09' }];
    const events: string[] = [];
    const writes: Prisma.Sql[] = [];
    let current = '';
    const tx = {
      $executeRawUnsafe: jest.fn(async (s: string) => { events.push(`${current}:${s}`); return 0; }),
      $queryRaw: jest.fn(async (q: Prisma.Sql) => {
        if (/pg_try_advisory_xact_lock/.test(q.sql)) {
          events.push(`${current}:trylock:${String(q.values[0])}`);
          return [{ ok: !(opts.locked ?? []).includes(current) }];
        }
        events.push(`${current}:recheck`);
        if ((opts.fail ?? []).includes(current)) throw new Error('canceling statement due to statement timeout');
        return (opts.fresh ?? []).includes(current) ? [] : [{ sourceImportId: `imp-${current}`, appliedAt: AT }];
      }),
      $executeRaw: jest.fn(async (q: Prisma.Sql) => {
        writes.push(q);
        events.push(`${current}:${/^\s*DELETE/.test(q.sql) ? 'delete' : /^\s*UPDATE/.test(q.sql) ? 'stamp' : 'insert'}`);
        return 7;
      }),
    };
    let i = 0;
    const db = {
      $queryRaw: jest.fn(async (_q: Prisma.Sql) => candidates),
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>, _o?: unknown) => {
        current = candidates[i++].month;
        return fn(tx);
      }),
    };
    const log = { log: jest.fn(), warn: jest.fn() };
    return { db, tx, log, events, writes };
  }

  it('lists stale months from the HEADER stamp (no summary scan) and rebuilds each in its own tx; stamps the header', async () => {
    const { db, log, events, writes } = make();
    const r = await refreshStaleMonthCombos(db as never, log, LIMITS);
    expect(r).toEqual({ found: 2, rebuilt: 2, busy: 0, fresh: 0, failed: 0, skipped: 0 });
    const list = db.$queryRaw.mock.calls[0][0];
    expect(list.sql).toMatch(/FROM "sales_month_history_sets" s/);
    expect(list.sql).toMatch(/s\."combosSourceImportId" IS DISTINCT FROM s\."sourceImportId" OR s\."combosAppliedAt" IS DISTINCT FROM s\."appliedAt"/);
    expect(list.sql).not.toMatch(/sales_month_history_combos/);
    expect(list.values).toContain(LIMITS.limit);
    expect(events.filter((e) => e.startsWith('2026-10:'))).toEqual([
      '2026-10:SET LOCAL statement_timeout = 25000',
      `2026-10:trylock:${salesMonthLockKey('t1', '2026-10')}`,
      '2026-10:recheck', '2026-10:delete', '2026-10:insert', '2026-10:stamp',
    ]);
    const stamp = writes.find((w) => /^\s*UPDATE "sales_month_history_sets"/.test(w.sql))!;
    expect(stamp.sql).toMatch(/SET "combosSourceImportId" = \?, "combosAppliedAt" = /);
    expect(stamp.sql).toMatch(/AND "sourceImportId" = \? AND "appliedAt" = /); // guarded by the set it rebuilt from
    expect(stamp.values).toEqual(['imp-2026-10', AT.toISOString(), 't1', '2026-10', 'imp-2026-10', AT.toISOString()]);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: LIMITS.txTimeoutMs, maxWait: 5_000 });
  });

  it('a month an apply holds (try-lock fails) is skipped without waiting; one already fixed after the lock is left alone', async () => {
    const { db, log, events } = make({ locked: ['2026-10'], fresh: ['2026-09'] });
    const r = await refreshStaleMonthCombos(db as never, log, LIMITS);
    expect(r).toEqual({ found: 2, rebuilt: 0, busy: 1, fresh: 1, failed: 0, skipped: 0 });
    expect(events.some((e) => /delete|insert|stamp/.test(e))).toBe(false);
  });

  it('a failing month is logged and counted; the others still run; never throws', async () => {
    const { db, log } = make({ fail: ['2026-10'] });
    const r = await refreshStaleMonthCombos(db as never, log, LIMITS);
    expect(r).toMatchObject({ failed: 1, rebuilt: 1 });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/2026-10 failed/));
    db.$queryRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(refreshStaleMonthCombos(db as never, log, LIMITS)).resolves.toMatchObject({ found: 0 });
  });

  it('stops starting new months past the budget or when the worker is stopping', async () => {
    const a = make();
    let t = 0;
    const ra = await refreshStaleMonthCombos(a.db as never, a.log, { ...LIMITS, budgetMs: 1000 }, { now: () => (t += 600) });
    expect(ra).toMatchObject({ rebuilt: 1, skipped: 1 });
    const b = make();
    const rb = await refreshStaleMonthCombos(b.db as never, b.log, LIMITS, { shouldStop: () => true });
    expect(rb).toMatchObject({ rebuilt: 0, skipped: 2 });
    expect(b.db.$transaction).not.toHaveBeenCalled();
  });
});
