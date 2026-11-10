import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SALES_IMPORT_MAX_DIMENSION_COMBOS, SALES_IMPORT_MAX_DIMENSION_VALUES } from '../sales-import.contract';
import { HISTORY_COMBOS_STATEMENT_TIMEOUT_MS, SalesHistoryCombosService } from './sales-history-combos.service';

/**
 * KPI product picker — "Stored month(s)" source (plan §10c). The combos come from the per-month combos SUMMARY
 * (sales_month_history_combos, audit M1) through ONE aggregate SQL per list (GROUP BY dims / per-key values, LIMIT = the
 * existing caps), run sequentially in one transaction under SET LOCAL statement_timeout; the history line rows are never
 * read.
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
/** Summary heads that match the set headers (nothing stale). */
const headsOf = (sets: typeof SETS): Head[] =>
  sets.map((s) => ({ month: s.month, srcMin: s.sourceImportId, srcMax: s.sourceImportId, atMin: s.appliedAt, atMax: s.appliedAt }));

function make(opts: { sets?: typeof SETS; combos?: unknown[]; values?: unknown[]; fail?: Error; failCode?: string; heads?: Head[] } = {}) {
  const queries: Prisma.Sql[] = [];
  const headQueries: Prisma.Sql[] = [];
  const writes: Prisma.Sql[] = [];
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
    $executeRawUnsafe: jest.fn(async (s: string) => { order.push(`set:${s}`); return 0; }),
    $executeRaw: jest.fn(async (q: Prisma.Sql) => {
      writes.push(q);
      order.push(/pg_advisory_xact_lock/.test(q.sql) ? 'lock' : /^\s*DELETE/.test(q.sql) ? 'delete' : 'insert');
      return 3;
    }),
    $queryRaw,
    salesMonthHistorySet: {
      findUnique: jest.fn(async ({ where }: { where: { clientId_month: { month: string } } }) => {
        const s = sets.find((x) => x.month === where.clientId_month.month);
        return s ? { sourceImportId: s.sourceImportId, appliedAt: s.appliedAt } : null;
      }),
    },
  };
  const prisma = {
    salesMonthHistorySet: { findMany: jest.fn().mockResolvedValue(sets) },
    salesMonthHistory: { findMany: jest.fn(), groupBy: jest.fn() },
    $queryRaw, // same fn: a read outside the transaction would show up too
    $transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => {
      if (opts.failCode) throw Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), { code: opts.failCode });
      return cb(tx);
    }),
  };
  return { svc: new SalesHistoryCombosService(prisma as never), prisma, queries, headQueries, writes, order, tx };
}

describe('SalesHistoryCombosService', () => {
  it('validates the query: month XOR lastMonths, YYYY-MM, 1..12', async () => {
    const { svc, prisma } = make();
    for (const q of [
      { month: '2026-10', lastMonths: '2' },
      { month: '2026-13' },
      { month: 'oct' },
      { lastMonths: '0' },
      { lastMonths: '13' },
      { lastMonths: '2.5' },
      { lastMonths: 'x' },
    ]) {
      await expect(svc.combos('t1', q)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('lastMonths=N → the N most recent STORED months; tenant-scoped aggregate SQL with the caps; rows never loaded', async () => {
    const { svc, prisma, queries, order } = make({
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
    expect(prisma.salesMonthHistorySet.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { clientId: 't1' } }));
    expect(r.months).toEqual(['2026-09', '2026-10']);
    expect(r.availableMonths).toEqual(['2026-10', '2026-09', '2026-08', '2026-07']);
    expect(r.dimensionKeys).toEqual(['brand', 'size']);
    expect(r.dimensionKeysDiffer).toBe(false);
    expect(r.dimensionCombos).toEqual([
      { dims: { brand: 'ADHO', size: '500' }, lines: 12, amountRupees: 1234.56, quantity: 2.5 },
      { dims: { brand: 'CNO', size: '' }, lines: 3, amountRupees: -5, quantity: 0 },
    ]);
    expect(r.totalCombos).toBe(3);
    expect(r.dimensionValues).toEqual({
      brand: [{ value: 'ADHO', lines: 12, amountRupees: 1234.56 }, { value: 'CNO', lines: 3, amountRupees: -5 }],
      size: [{ value: '500', lines: 12, amountRupees: 1234.56 }, { value: '', lines: 3, amountRupees: -5 }],
    });

    // Two aggregate statements over the SUMMARY table, scoped by tenant + the chosen months, GROUP BY in SQL with a LIMIT /
    // rank cap — one after the other, after SET LOCAL statement_timeout, inside one transaction (audit M1).
    expect(queries).toHaveLength(2);
    expect(order).toEqual([`set:SET LOCAL statement_timeout = ${HISTORY_COMBOS_STATEMENT_TIMEOUT_MS}`, 'heads', 'start1', 'end1', 'start2', 'end2']);
    expect(HISTORY_COMBOS_STATEMENT_TIMEOUT_MS).toBe(10_000);
    for (const q of queries) {
      expect(q.sql).toMatch(/FROM "sales_month_history_combos" c/);
      expect(q.sql).not.toMatch(/sales_month_histories/);
      expect(q.sql).toMatch(/c\."clientId" = \? AND c\."month" = ANY\(\?::text\[\]\)/);
      expect(q.sql).toMatch(/GROUP BY/);
      expect(q.values[0]).toBe('t1');
      expect(q.values).toContainEqual(['2026-09', '2026-10']);
    }
    const [combosSql, valuesSql] = /jsonb_each_text/.test(queries[0].sql) ? [queries[1], queries[0]] : [queries[0], queries[1]];
    expect(combosSql.sql).toMatch(/GROUP BY c\."dims"/);
    expect(combosSql.sql).toMatch(/count\(\*\) OVER \(\)/i);
    expect(combosSql.values).toContain(SALES_IMPORT_MAX_DIMENSION_COMBOS);
    expect(valuesSql.values).toContain(SALES_IMPORT_MAX_DIMENSION_VALUES);
    expect(prisma.salesMonthHistory.findMany).not.toHaveBeenCalled();
    expect(prisma.salesMonthHistory.groupBy).not.toHaveBeenCalled();
  });

  it('default = the most recent stored month; lastMonths larger than what is stored covers what exists', async () => {
    const a = make();
    expect((await a.svc.combos('t1', {})).months).toEqual(['2026-10']);
    const b = make();
    expect((await b.svc.combos('t1', { lastMonths: '12' })).months).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
  });

  it('months read with different product columns → union of keys + dimensionKeysDiffer', async () => {
    const { svc } = make();
    const r = await svc.combos('t1', { lastMonths: '3' }); // 2026-10, -09 (brand,size) + 2026-08 (brand)
    expect(r.dimensionKeys).toEqual(['brand', 'size']);
    expect(r.dimensionKeysDiffer).toBe(true);
    const one = await svc.combos('t1', { month: '2026-08' });
    expect(one.months).toEqual(['2026-08']);
    expect(one.dimensionKeys).toEqual(['brand']);
    expect(one.dimensionKeysDiffer).toBe(false);
  });

  it('a month without stored history → 404; a tenant without any history → empty lists, no line query', async () => {
    const a = make();
    await expect(a.svc.combos('t1', { month: '2026-01' })).rejects.toBeInstanceOf(NotFoundException);
    expect(a.prisma.$queryRaw).not.toHaveBeenCalled();
    const b = make({ sets: [] });
    const r = await b.svc.combos('t1', { lastMonths: '3' });
    expect(r).toEqual({
      months: [], availableMonths: [], dimensionKeys: [], dimensionKeysDiffer: false,
      dimensionValues: {}, dimensionCombos: [], totalCombos: 0,
    });
    expect(b.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('L-a: summaries matching the set headers are read as they are (no lock, no rewrite)', async () => {
    const { svc, writes, headQueries } = make();
    await svc.combos('t1', { lastMonths: '3' });
    expect(writes).toEqual([]);
    expect(headQueries).toHaveLength(1);
    expect(headQueries[0].sql).toMatch(/FROM "sales_month_history_combos" c/);
    expect(headQueries[0].values).toEqual(['t1', ['2026-10', '2026-09', '2026-08']]);
  });

  it('L-a: a month whose summary is missing or from another set is rebuilt under the month lock before the reads', async () => {
    const heads = headsOf(SETS).filter((h) => h.month !== '2026-08') // 2026-08: missing (set has lines)
      .map((h) => (h.month === '2026-10' ? { ...h, srcMax: 'imp-OLD' } : h)) // 2026-10: rows of two sets
      .map((h) => (h.month === '2026-09' ? { ...h, atMin: new Date(AT.getTime() - 1), atMax: new Date(AT.getTime() - 1) } : h)); // re-applied since
    const { svc, writes, order, tx } = make({ heads });
    await svc.combos('t1', { lastMonths: '4' });
    // 2026-07 matches → untouched; the three stale months rebuilt in month order, each: lock → delete → insert
    expect(order.slice(0, 2)).toEqual([`set:SET LOCAL statement_timeout = ${HISTORY_COMBOS_STATEMENT_TIMEOUT_MS}`, 'heads']);
    expect(order.slice(2, 11)).toEqual(['lock', 'delete', 'insert', 'lock', 'delete', 'insert', 'lock', 'delete', 'insert']);
    expect(order.slice(11)).toEqual(['start1', 'end1', 'start2', 'end2']);
    const locks = writes.filter((w) => /pg_advisory_xact_lock/.test(w.sql)).map((w) => w.values[0]);
    expect(locks).toEqual(['sales-month:t1:2026-08', 'sales-month:t1:2026-09', 'sales-month:t1:2026-10']);
    const inserts = writes.filter((w) => /INSERT INTO "sales_month_history_combos"/.test(w.sql));
    expect(inserts[0].sql).toMatch(/GROUP BY h\."clientId", h\."month", h\."dimKey", h\."dims"/);
    // stamped with the header as re-read after the lock
    expect(inserts.map((w) => w.values)).toEqual([
      ['imp-2026-08', AT.toISOString(), 't1', '2026-08'],
      ['imp-2026-09', AT.toISOString(), 't1', '2026-09'],
      ['imp-2026-10', AT.toISOString(), 't1', '2026-10'],
    ]);
    expect(tx.salesMonthHistorySet.findUnique).toHaveBeenCalledTimes(3);
  });

  it('L-a: a set without lines and without summary rows is not "stale"', async () => {
    const sets = [set('2026-10', ['brand'], { lineRows: 0 })];
    const { svc, writes } = make({ sets, heads: [] });
    await svc.combos('t1', {});
    expect(writes).toEqual([]);
  });

  it('L-d: no transaction could be started (P2028, pool busy) → the same friendly 503', async () => {
    const { svc } = make({ failCode: 'P2028' });
    await expect(svc.combos('t1', { lastMonths: '3' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('a statement timeout → 503 with a readable message; other errors propagate', async () => {
    const a = make({ fail: new Error('ERROR: canceling statement due to statement timeout') });
    await expect(a.svc.combos('t1', { lastMonths: '12' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    const b = make({ fail: new Error('connection reset') });
    await expect(b.svc.combos('t1', { lastMonths: '12' })).rejects.toThrow('connection reset');
  });

  it('JSON null / non-string dim values come back as strings ("" for null)', async () => {
    const { svc } = make({ combos: [{ dims: { brand: 'A', size: null, n: 5 }, lines: 1, paise: '100', pico: '0', total: 1 }] });
    const r = await svc.combos('t1', { month: '2026-10' });
    expect(r.dimensionCombos[0].dims).toEqual({ brand: 'A', size: '', n: '5' });
  });
});
