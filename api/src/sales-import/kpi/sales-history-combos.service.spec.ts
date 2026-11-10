import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SALES_IMPORT_MAX_DIMENSION_COMBOS, SALES_IMPORT_MAX_DIMENSION_VALUES } from '../sales-import.contract';
import {
  HISTORY_COMBOS_BUSY_MESSAGE,
  HISTORY_COMBOS_LINE_FALLBACK_MAX_ROWS,
  HISTORY_COMBOS_STATEMENT_TIMEOUT_MS,
  HISTORY_COMBOS_TIMEOUT_MESSAGE,
  SalesHistoryCombosService,
} from './sales-history-combos.service';

/**
 * KPI product picker — "Stored month(s)" source (plan §10c). STRICTLY READ-ONLY: one READ ONLY transaction under
 * SET LOCAL statement_timeout; the set headers (with their summary stamp) read INSIDE it; two aggregate statements one
 * after the other over the per-month combos SUMMARY (+ the stored lines only for a SMALL month whose summary is
 * missing). Never writes, never locks; months that cannot be read within the cap are reported in `unavailableMonths`.
 */
const AT = new Date('2026-11-01T10:00:00.000Z');
type SetRow = {
  month: string; dimensionKeys: string[]; sourceImportId: string; appliedAt: Date; lineRows: number;
  combosSourceImportId: string | null; combosAppliedAt: Date | null;
};
const set = (month: string, dimensionKeys: string[], over: Partial<SetRow> = {}): SetRow => ({
  month, dimensionKeys, sourceImportId: `imp-${month}`, appliedAt: AT, lineRows: 10,
  combosSourceImportId: `imp-${month}`, combosAppliedAt: AT, ...over,
});
const SETS = [
  set('2026-10', ['brand', 'size']),
  set('2026-09', ['brand', 'size']),
  set('2026-08', ['brand']),
  set('2026-07', ['brand', 'size']),
];

function make(opts: { sets?: SetRow[]; combos?: unknown[]; values?: unknown[]; fail?: Error; failCode?: string } = {}) {
  const queries: Prisma.Sql[] = [];
  const order: string[] = [];
  const sets = opts.sets ?? SETS;
  const $queryRaw = jest.fn().mockImplementation(async (q: Prisma.Sql) => {
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
  return { svc: new SalesHistoryCombosService(prisma as never), prisma, tx, queries, order };
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
    const { svc, queries, order, tx, prisma } = make({
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
    expect(tx.salesMonthHistorySet.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { clientId: 't1' },
      select: expect.objectContaining({ combosSourceImportId: true, combosAppliedAt: true, lineRows: true }),
    }));
    expect(r.months).toEqual(['2026-09', '2026-10']);
    expect(r.availableMonths).toEqual(['2026-10', '2026-09', '2026-08', '2026-07']);
    expect(r.dimensionKeys).toEqual(['brand', 'size']);
    expect(r.dimensionKeysDiffer).toBe(false);
    expect(r.unavailableMonths).toEqual([]);
    expect(r.dimensionCombos).toEqual([
      { dims: { brand: 'ADHO', size: '500' }, lines: 12, amountRupees: 1234.56, quantity: 2.5 },
      { dims: { brand: 'CNO', size: '' }, lines: 3, amountRupees: -5, quantity: 0 },
    ]);
    expect(r.totalCombos).toBe(3);
    expect(r.dimensionValues).toEqual({
      brand: [{ value: 'ADHO', lines: 12, amountRupees: 1234.56 }, { value: 'CNO', lines: 3, amountRupees: -5 }],
      size: [{ value: '500', lines: 12, amountRupees: 1234.56 }, { value: '', lines: 3, amountRupees: -5 }],
    });

    // no summary-head scan any more (re-check L1): the header stamp decides
    expect(order).toEqual([...PREAMBLE, 'start1', 'end1', 'start2', 'end2']);
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.sql).toMatch(/FROM "sales_month_history_combos" c\s+WHERE c\."clientId" = \? AND c\."month" = ANY\(\?::text\[\]\)/);
      expect(q.values).toEqual(expect.arrayContaining(['t1', ['2026-09', '2026-10'], []])); // no line months
    }
    const [combosSql, valuesSql] = /jsonb_each_text/.test(queries[0].sql) ? [queries[1], queries[0]] : [queries[0], queries[1]];
    expect(combosSql.sql).toMatch(/GROUP BY s\."dims"/);
    expect(combosSql.sql).toMatch(/count\(\*\) OVER \(\)/i);
    expect(combosSql.values).toContain(SALES_IMPORT_MAX_DIMENSION_COMBOS);
    expect(valuesSql.values).toContain(SALES_IMPORT_MAX_DIMENSION_VALUES);
    expect(prisma.salesMonthHistory.findMany).not.toHaveBeenCalled();
  });

  it('NEVER writes or locks: stale and missing months are read from their stored lines (not the old summary); nothing unavailable', async () => {
    const sets = [
      set('2026-10', ['brand'], { combosSourceImportId: 'imp-OLD' }), // re-applied by an older revision → stale
      set('2026-09', ['brand'], { combosAppliedAt: new Date(AT.getTime() - 1) }), // same import re-applied → stale
      set('2026-08', ['brand'], { combosSourceImportId: null, combosAppliedAt: null }), // never summarised → missing
      set('2026-07', ['brand']),
    ];
    const { svc, queries, tx, prisma, order } = make({ sets });
    const r = await svc.combos('t1', { lastMonths: '4' });
    expect(r.unavailableMonths).toEqual([]);
    for (const q of queries) {
      // the summary only for the CURRENT month; the stored lines for the other three
      expect(q.values).toEqual(expect.arrayContaining(['t1', ['2026-07'], ['2026-08', '2026-09', '2026-10']]));
      expect(q.sql).toMatch(/FROM "sales_month_histories" h\s+WHERE h\."clientId" = \? AND h\."month" = ANY\(\?::text\[\]\)/);
    }
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(order.join(' ')).not.toMatch(/advisory/);
    expect(order[0]).toBe('SET TRANSACTION READ ONLY');
  });

  it(`a month without a current summary and over ${HISTORY_COMBOS_LINE_FALLBACK_MAX_ROWS} line rows is unavailable — no combos`, async () => {
    const big = set('2026-10', ['brand'], { combosSourceImportId: null, combosAppliedAt: null, lineRows: HISTORY_COMBOS_LINE_FALLBACK_MAX_ROWS + 1 });
    const only = make({ sets: [big] });
    const r = await only.svc.combos('t1', {});
    expect(r).toEqual(expect.objectContaining({ months: ['2026-10'], unavailableMonths: ['2026-10'], dimensionCombos: [], totalCombos: 0 }));
    expect(only.queries).toHaveLength(0); // nothing to read → no aggregate statement at all

    const staleBig = make({ sets: [set('2026-10', ['brand'], { combosSourceImportId: 'imp-OLD', lineRows: HISTORY_COMBOS_LINE_FALLBACK_MAX_ROWS + 1 })] });
    expect((await staleBig.svc.combos('t1', {})).unavailableMonths).toEqual(['2026-10']); // a stale summary is NOT served

    const mixed = make({ sets: [big, set('2026-09', ['brand'])] });
    const r2 = await mixed.svc.combos('t1', { lastMonths: '2' });
    expect(r2.unavailableMonths).toEqual(['2026-10']);
    expect(mixed.queries[0].values).toEqual(expect.arrayContaining([['2026-09'], []])); // 10 neither summary nor lines
    const atLimit = make({ sets: [set('2026-10', ['brand'], { combosSourceImportId: null, combosAppliedAt: null, lineRows: HISTORY_COMBOS_LINE_FALLBACK_MAX_ROWS })] });
    await atLimit.svc.combos('t1', {});
    expect(atLimit.queries[0].values).toEqual(expect.arrayContaining([[], ['2026-10']])); // at the limit: read from lines
  });

  it('the line fallback is capped on the SUM of line rows across those months (newest first); the rest are unavailable', async () => {
    const missing = (month: string, lineRows: number) => set(month, ['brand'], { combosSourceImportId: null, combosAppliedAt: null, lineRows });
    const third = Math.floor(HISTORY_COMBOS_LINE_FALLBACK_MAX_ROWS / 3);
    const sets = [missing('2026-10', third), missing('2026-09', third), missing('2026-08', third), missing('2026-07', third)];
    const { svc, queries } = make({ sets });
    const r = await svc.combos('t1', { lastMonths: '4' });
    expect(r.unavailableMonths).toEqual(['2026-07']);
    expect(queries[0].values).toEqual(expect.arrayContaining([[], ['2026-08', '2026-09', '2026-10']]));
  });

  it('a set without lines and without a summary is neither read nor unavailable', async () => {
    const { svc, queries } = make({ sets: [set('2026-10', ['brand'], { lineRows: 0, combosSourceImportId: null, combosAppliedAt: null })] });
    const r = await svc.combos('t1', {});
    expect(r.unavailableMonths).toEqual([]);
    expect(queries).toHaveLength(0);
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
      dimensionValues: {}, dimensionCombos: [], totalCombos: 0, unavailableMonths: [],
    });
    expect(b.queries).toHaveLength(0);
  });

  it('a statement timeout → 503 "took too long"; P2028 (pool busy) → 503 "busy"; other errors propagate', async () => {
    const timeout = make({ fail: new Error('ERROR: canceling statement due to statement timeout') }).svc.combos('t1', { lastMonths: '12' });
    await expect(timeout).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(make({ fail: new Error('canceling statement due to statement timeout') }).svc.combos('t1', {})).rejects.toThrow(HISTORY_COMBOS_TIMEOUT_MESSAGE);
    await expect(make({ failCode: 'P2028' }).svc.combos('t1', { lastMonths: '3' })).rejects.toThrow(HISTORY_COMBOS_BUSY_MESSAGE);
    // L2: a P2028 for a transaction that EXPIRED / was already closed is the read taking too long, not a busy pool
    const expired = make({
      fail: Object.assign(new Error('Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.'), { code: 'P2028' }),
    });
    await expect(expired.svc.combos('t1', { lastMonths: '3' })).rejects.toThrow(HISTORY_COMBOS_TIMEOUT_MESSAGE);
    await expect(make({ fail: new Error('connection reset') }).svc.combos('t1', { lastMonths: '12' })).rejects.toThrow('connection reset');
  });

  it('JSON null / non-string dim values come back as strings ("" for null)', async () => {
    const { svc } = make({ combos: [{ dims: { brand: 'A', size: null, n: 5 }, lines: 1, paise: '100', pico: '0', total: 1 }] });
    const r = await svc.combos('t1', { month: '2026-10' });
    expect(r.dimensionCombos[0].dims).toEqual({ brand: 'A', size: '', n: '5' });
  });
});
