import type { Prisma } from '@prisma/client';
import { lockSalesMonth } from '../../common/sales-kpi-ownership';
import {
  COMBOS_REFRESH_MAX_MONTHS,
  COMBOS_REFRESH_STATEMENT_TIMEOUT_MS,
  classifyMonthSummaries,
  insertMonthCombosSql,
  refreshStaleMonthCombos,
  salesMonthLockKey,
} from './month-combos';

const AT = new Date('2026-11-01T10:00:00.000Z');

describe('classifyMonthSummaries', () => {
  const set = (month: string, lineRows = 5) => ({ month, sourceImportId: `imp-${month}`, appliedAt: AT, lineRows });
  const head = (month: string, over: Partial<{ srcMin: string; srcMax: string; atMin: Date; atMax: Date }> = {}) =>
    ({ month, srcMin: `imp-${month}`, srcMax: `imp-${month}`, atMin: AT, atMax: AT, ...over });

  it('current / stale (other import, other apply time, two sets mixed) / missing / empty', () => {
    const s = classifyMonthSummaries(
      [set('2026-01'), set('2026-02'), set('2026-03'), set('2026-04'), set('2026-05'), set('2026-06', 0)],
      [
        head('2026-01'),
        head('2026-02', { srcMin: 'imp-OLD', srcMax: 'imp-OLD' }),
        head('2026-03', { atMin: new Date(AT.getTime() - 1), atMax: new Date(AT.getTime() - 1) }),
        head('2026-04', { srcMax: 'imp-zzz' }),
      ],
    );
    expect(Object.fromEntries(s)).toEqual({
      '2026-01': 'current', '2026-02': 'stale', '2026-03': 'stale', '2026-04': 'stale', '2026-05': 'missing', '2026-06': 'empty',
    });
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

describe('refreshStaleMonthCombos (background repair; never on a request)', () => {
  it('uses the SAME advisory-lock key as the apply (lockSalesMonth)', async () => {
    const tx = { $executeRaw: jest.fn(async (_q: Prisma.Sql) => 1) };
    await lockSalesMonth(tx as never, 't1', '2026-10');
    expect(tx.$executeRaw.mock.calls[0][0].values[0]).toBe(salesMonthLockKey('t1', '2026-10'));
  });

  function make(opts: { candidates?: Array<{ clientId: string; month: string }>; locked?: string[]; fresh?: string[]; fail?: string[] } = {}) {
    const candidates = opts.candidates ?? [{ clientId: 't1', month: '2026-10' }, { clientId: 't2', month: '2026-09' }];
    const events: string[] = [];
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
        events.push(`${current}:${/^\s*DELETE/.test(q.sql) ? 'delete' : 'insert'}`);
        return 7;
      }),
    };
    const db = {
      $queryRaw: jest.fn(async (_q: Prisma.Sql) => candidates),
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>, _o?: unknown) => fn(tx)),
    };
    // Each candidate runs in its own transaction: tag events with the candidate being processed.
    const realTx = db.$transaction.getMockImplementation()!;
    let i = 0;
    db.$transaction.mockImplementation(async (fn, o) => {
      const c = candidates[i++];
      current = c.month;
      return realTx(fn, o);
    });
    const log = { log: jest.fn(), warn: jest.fn() };
    return { db, tx, log, events };
  }

  it('lists stale / missing months (bounded) and rebuilds each in its own tx: timeout → try-lock → re-check → DELETE + INSERT', async () => {
    const { db, log, events } = make();
    const r = await refreshStaleMonthCombos(db as never, log);
    expect(r).toEqual({ found: 2, rebuilt: 2, busy: 0, fresh: 0, failed: 0, skipped: 0 });
    const list = db.$queryRaw.mock.calls[0][0];
    expect(list.sql).toMatch(/FROM "sales_month_history_sets" s/);
    expect(list.sql).toMatch(/NOT EXISTS/);
    expect(list.sql).toMatch(/c\."sourceImportId" <> s\."sourceImportId" OR c\."appliedAt" <> s\."appliedAt"/);
    expect(list.values).toContain(COMBOS_REFRESH_MAX_MONTHS);
    expect(events.filter((e) => e.startsWith('2026-10:'))).toEqual([
      `2026-10:SET LOCAL statement_timeout = ${COMBOS_REFRESH_STATEMENT_TIMEOUT_MS}`,
      `2026-10:trylock:${salesMonthLockKey('t1', '2026-10')}`,
      '2026-10:recheck', '2026-10:delete', '2026-10:insert',
    ]);
    expect(COMBOS_REFRESH_STATEMENT_TIMEOUT_MS).toBe(120_000);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });

  it('a month an apply holds (try-lock fails) is skipped without waiting; one already fixed after the lock is left alone', async () => {
    const { db, log, events } = make({ locked: ['2026-10'], fresh: ['2026-09'] });
    const r = await refreshStaleMonthCombos(db as never, log);
    expect(r).toEqual({ found: 2, rebuilt: 0, busy: 1, fresh: 1, failed: 0, skipped: 0 });
    expect(events.some((e) => /delete|insert/.test(e))).toBe(false);
  });

  it('a failing month is logged and counted; the others still run; never throws', async () => {
    const { db, log } = make({ fail: ['2026-10'] });
    const r = await refreshStaleMonthCombos(db as never, log);
    expect(r).toMatchObject({ failed: 1, rebuilt: 1 });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/2026-10 failed/));
    db.$queryRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(refreshStaleMonthCombos(db as never, log)).resolves.toMatchObject({ found: 0 });
  });

  it('stops starting new months past the budget or when the worker is stopping', async () => {
    const a = make();
    let t = 0;
    const ra = await refreshStaleMonthCombos(a.db as never, a.log, { budgetMs: 1000, now: () => (t += 600) });
    expect(ra).toMatchObject({ rebuilt: 1, skipped: 1 });
    const b = make();
    const rb = await refreshStaleMonthCombos(b.db as never, b.log, { shouldStop: () => true });
    expect(rb).toMatchObject({ rebuilt: 0, skipped: 2 });
    expect(b.db.$transaction).not.toHaveBeenCalled();
  });
});
