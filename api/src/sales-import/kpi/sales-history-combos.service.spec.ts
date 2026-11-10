import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SALES_IMPORT_MAX_DIMENSION_COMBOS, SALES_IMPORT_MAX_DIMENSION_VALUES } from '../sales-import.contract';
import { HISTORY_COMBOS_STATEMENT_TIMEOUT_MS, SalesHistoryCombosService } from './sales-history-combos.service';

/**
 * KPI product picker — "Stored month(s)" source (plan §10c). STRICTLY READ-ONLY: one READ ONLY transaction under
 * SET LOCAL statement_timeout; set headers + summary heads read INSIDE it; two aggregate statements one after the
 * other over the per-month combos SUMMARY (+ the stored lines only for a month whose summary is missing). It never
 * writes, never takes the month lock; stale / missing months are reported in `refreshingMonths` (the worker repairs).
 */
const AT = new Date('2026-11-01T10:00:00.000Z');
const set = (month: string, dimensionKeys: string[], over: Partial<{ sourceImportId: string; appliedAt: Date; lineRows: number }> = {}) =>
  ({ month, dimensionKeys, sourceImportId: `imp-${month}`, appliedAt: AT, lineRows: 10, ...over });
const SETS = [
  set('2026-10', ['brand', 'size']),
  set('2026-09', ['brand', 'size']),
  set('2026-08', ['brand']),
  set('2026-07', ['brand', 'size']),
];
type Head = { month: string; srcMin: string; srcMax: string; atMin: Date; atMax: Date };
const headsOf = (sets: typeof SETS): Head[] =>
  sets.map((s) => ({ month: s.month, srcMin: s.sourceImportId, srcMax: s.sourceImportId, atMin: s.appliedAt, atMax: s.appliedAt }));

function make(opts: { sets?: typeof SETS; combos?: unknown[]; values?: unknown[]; fail?: Error; failCode?: string; heads?: Head[] } = {}) {
  const queries: Prisma.Sql[] = [];
  const headQueries: Prisma.Sql[] = [];
  const order: string[] = [];
  const sets = opts.sets ?? SETS;
  const $queryRaw = jest.fn().mockImplementation(async (q: Prisma.Sql) => {
    if (/GROUP BY c\."month"/.test(q.sql)) {
      headQueries.push(q);
      order.push('heads');
      return opts.heads ?? headsOf(sets);
    }
    const n = queries.push(q);
    order.push(`start${n}`);
    await new Promise((r) => setImmediate(r)); // a parallel second query would start before this one ends
    order.push(`end${n}`);
    if (opts.fail) throw opts.fail;
    return /jsonb_each_text/.test(q.sql) ? (opts.values ?? []) : (opts.combos ?? []);
  });
  const tx = {
    $executeRawUnsafe: jest.fn(async (s: string) => { order.push(s); return 0; }),
    $executeRaw: jest.fn(async () => { throw new Error('the read path must never write'); }),
    $queryRaw,
    salesMonthHistorySet: {
      findMany: jest.fn(async () => { order.push('sets'); return sets; }),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const prisma = {
    salesMonthHistorySet: { findMany: jest.fn(async () => { throw new Error('headers must be read inside the read tx'); }) },
    salesMonthHistory: { findMany: jest.fn(), groupBy: jest.fn() },
    $queryRaw,
    $executeRaw: jest.fn(),
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => {
      if (opts.failCode) throw Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), { code: opts.failCode });
      return cb(tx);
    }),
  };
  return { svc: new SalesHistoryCombosService(prisma as never), prisma, tx, queries, headQueries, order };
}

const PREAMBLE = ['SET TRANSACTION READ ONLY', `SET LOCAL statement_timeout = ${HISTORY_COMBOS_STATEMENT_TIMEOUT_MS}`, 'sets'];

describe('SalesHistoryCombosService', () => {
  it('validates the query: month XOR lastMonths, YYYY-MM, 1..12', async () => {
    const { svc, prisma } = make();
    for (const q of [
      { month: '2026-10', lastMonths: '2' }, { month: '2026-13' }, { month: 'oct' },
      { lastMonths: '0' }, { lastMonths: '13' }, { lastMonths: '2.5' }, { lastMonths: 'x' },
    ]) {
      await expect(svc.combos('t1', q)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('lastMonths=N → the N most recent STORED months, read from the SUMMARY in one read-only tx (sequential, capped)', async () => {
    const { svc, queries, order, headQueries, tx, prisma } = make({
      combos: [
        { dims: { brand: 'ADHO', size: '500' }, lines: 12n, paise: '123456', pico: '2500000000000', total: 3n },
        { dims: { brand: 'CNO', size: '' }, lines: 3n, paise: '-500', pico: '0', total: 3n },
      ],
      values: [
        { key: 'brand', value: 'ADHO', lines: 12n, paise: '123456' },
        { key: 'brand', value: 'CNO', lines: 3n, paise: '-500' },
        { key: 'size', value: '500', lines: 12n, paise: '123456' },
        { key: 'size', value: '', lines: 3n, paise: '-500' },
      ],
    });
    const r = await svc.combos('t1', { lastMonths: '2' });
    expect(tx.salesMonthHistorySet.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { clientId: 't1' } }));
    expect(r.months).toEqual(['2026-09', '2026-10']);
    expect(r.availableMonths).toEqual(['2026-10', '2026-09', '2026-08', '2026-07']);
    expect(r.dimensionKeys).toEqual(['brand', 'size']);
    expect(r.dimensionKeysDiffer).toBe(false);
    expect(r.refreshingMonths).toEqual([]);
    expect(r.dimensionCombos).toEqual([
      { dims: { brand: 'ADHO', size: '500' }, lines: 12, amountRupees: 1234.56, quantity: 2.5 },
      { dims: { brand: 'CNO', size: '' }, lines: 3, amountRupees: -5, quantity: 0 },
    ]);
    expect(r.totalCombos).toBe(3);
    expect(r.dimensionValues).toEqual({
      brand: [{ value: 'ADHO', lines: 12, amountRupees: 1234.56 }, { value: 'CNO', lines: 3, amountRupees: -5 }],
      size: [{ value: '500', lines: 12, amountRupees: 1234.56 }, { value: '', lines: 3, amountRupees: -5 }],
    });

    expect(order).toEqual([...PREAMBLE, 'heads', 'start1', 'end1', 'start2', 'end2']);
    expect(headQueries[0].values).toEqual(['t1', ['2026-09', '2026-10']]);
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.sql).toMatch(/FROM "sales_month_history_combos" c\s+WHERE c\."clientId" = \? AND c\."month" = ANY\(\?::text\[\]\)/);
      // the stored-lines branch is present but gets NO months when every summary is there
      expect(q.values).toEqual(expect.arrayContaining(['t1', ['2026-09', '2026-10'], []]));
    }
    const [combosSql, valuesSql] = /jsonb_each_text/.test(queries[0].sql) ? [queries[1], queries[0]] : [queries[0], queries[1]];
    expect(combosSql.sql).toMatch(/GROUP BY s\."dims"/);
    expect(combosSql.sql).toMatch(/count\(\*\) OVER \(\)/i);
    expect(combosSql.values).toContain(SALES_IMPORT_MAX_DIMENSION_COMBOS);
    expect(valuesSql.values).toContain(SALES_IMPORT_MAX_DIMENSION_VALUES);
    expect(prisma.salesMonthHistory.findMany).not.toHaveBeenCalled();
  });

  it('NEVER writes or locks: a stale month is answered from its old summary, a missing one from its stored lines; both flagged', async () => {
    const heads = headsOf(SETS)
      .filter((h) => h.month !== '2026-08') // 2026-08: summary missing (set has lines)
      .map((h) => (h.month === '2026-10' ? { ...h, srcMin: 'imp-OLD', srcMax: 'imp-OLD' } : h)); // 2026-10: older apply
    const { svc, queries, tx, prisma, order } = make({ heads });
    const r = await svc.combos('t1', { lastMonths: '4' });
    expect(r.refreshingMonths).toEqual(['2026-08', '2026-10']);
    for (const q of queries) {
      // summary for 07, 09, 10 (stale still served); the stored lines ONLY for the missing 08
      expect(q.values).toEqual(expect.arrayContaining(['t1', ['2026-07', '2026-09', '2026-10'], ['2026-08']]));
      expect(q.sql).toMatch(/FROM "sales_month_histories" h\s+WHERE h\."clientId" = \? AND h\."month" = ANY\(\?::text\[\]\)/);
    }
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(order.join(' ')).not.toMatch(/advisory/);
    expect(order.slice(0, 1)).toEqual(['SET TRANSACTION READ ONLY']);
  });

  it('a set without lines and without summary is neither read from the lines nor "refreshing"', async () => {
    const sets = [set('2026-10', ['brand'], { lineRows: 0 })];
    const { svc, queries } = make({ sets, heads: [] });
    const r = await svc.combos('t1', {});
    expect(r.refreshingMonths).toEqual([]);
    expect(queries[0].values).toEqual(expect.arrayContaining([['2026-10'], []]));
  });

  it('default = the most recent stored month; lastMonths larger than what is stored covers what exists', async () => {
    expect((await make().svc.combos('t1', {})).months).toEqual(['2026-10']);
    expect((await make().svc.combos('t1', { lastMonths: '12' })).months).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
  });

  it('months read with different product columns → union of keys + dimensionKeysDiffer', async () => {
    const { svc } = make();
    const r = await svc.combos('t1', { lastMonths: '3' });
    expect(r.dimensionKeys).toEqual(['brand', 'size']);
    expect(r.dimensionKeysDiffer).toBe(true);
    const one = await svc.combos('t1', { month: '2026-08' });
    expect(one.months).toEqual(['2026-08']);
    expect(one.dimensionKeys).toEqual(['brand']);
    expect(one.dimensionKeysDiffer).toBe(false);
  });

  it('a month without stored history → 404; a tenant without any history → empty lists, no aggregate query', async () => {
    const a = make();
    await expect(a.svc.combos('t1', { month: '2026-01' })).rejects.toBeInstanceOf(NotFoundException);
    expect(a.queries).toHaveLength(0);
    const b = make({ sets: [] });
    const r = await b.svc.combos('t1', { lastMonths: '3' });
    expect(r).toEqual({
      months: [], availableMonths: [], dimensionKeys: [], dimensionKeysDiffer: false,
      dimensionValues: {}, dimensionCombos: [], totalCombos: 0, refreshingMonths: [],
    });
    expect(b.queries).toHaveLength(0);
    expect(b.headQueries).toHaveLength(0);
  });

  it('a statement timeout or P2028 (pool busy) → 503 with a readable message; other errors propagate', async () => {
    await expect(make({ fail: new Error('ERROR: canceling statement due to statement timeout') }).svc.combos('t1', { lastMonths: '12' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(make({ failCode: 'P2028' }).svc.combos('t1', { lastMonths: '3' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(make({ fail: new Error('connection reset') }).svc.combos('t1', { lastMonths: '12' })).rejects.toThrow('connection reset');
  });

  it('JSON null / non-string dim values come back as strings ("" for null)', async () => {
    const { svc } = make({ combos: [{ dims: { brand: 'A', size: null, n: 5 }, lines: 1, paise: '100', pico: '0', total: 1 }] });
    const r = await svc.combos('t1', { month: '2026-10' });
    expect(r.dimensionCombos[0].dims).toEqual({ brand: 'A', size: '', n: '5' });
  });
});
