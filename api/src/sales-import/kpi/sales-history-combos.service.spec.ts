import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SALES_IMPORT_MAX_DIMENSION_COMBOS, SALES_IMPORT_MAX_DIMENSION_VALUES } from '../sales-import.contract';
import { SalesHistoryCombosService } from './sales-history-combos.service';

/**
 * KPI product picker — "Stored month(s)" source (plan §10c). The combos come from sales_month_histories through ONE
 * aggregate SQL per list (GROUP BY dims / per-key values, LIMIT = the existing caps); the line rows are never loaded
 * into Node (Prisma `distinct` / findMany over the table is not used).
 */
const SETS = [
  { month: '2026-10', dimensionKeys: ['brand', 'size'] },
  { month: '2026-09', dimensionKeys: ['brand', 'size'] },
  { month: '2026-08', dimensionKeys: ['brand'] },
  { month: '2026-07', dimensionKeys: ['brand', 'size'] },
];

function make(opts: { sets?: typeof SETS; combos?: unknown[]; values?: unknown[] } = {}) {
  const queries: Prisma.Sql[] = [];
  const prisma = {
    salesMonthHistorySet: { findMany: jest.fn().mockResolvedValue(opts.sets ?? SETS) },
    salesMonthHistory: { findMany: jest.fn(), groupBy: jest.fn() },
    $queryRaw: jest.fn().mockImplementation(async (q: Prisma.Sql) => {
      queries.push(q);
      return /jsonb_each_text/.test(q.sql) ? (opts.values ?? []) : (opts.combos ?? []);
    }),
  };
  return { svc: new SalesHistoryCombosService(prisma as never), prisma, queries };
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
    const { svc, prisma, queries } = make({
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

    // Two aggregate statements, both scoped by tenant + the chosen months, both GROUP BY in SQL with a LIMIT / rank cap.
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.sql).toMatch(/FROM "sales_month_histories"/);
      expect(q.sql).toMatch(/h\."clientId" = \? AND h\."month" = ANY\(\?::text\[\]\)/);
      expect(q.sql).toMatch(/GROUP BY/);
      expect(q.values[0]).toBe('t1');
      expect(q.values).toContainEqual(['2026-09', '2026-10']);
    }
    const [combosSql, valuesSql] = /jsonb_each_text/.test(queries[0].sql) ? [queries[1], queries[0]] : [queries[0], queries[1]];
    expect(combosSql.sql).toMatch(/GROUP BY h\."dims"/);
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

  it('JSON null / non-string dim values come back as strings ("" for null)', async () => {
    const { svc } = make({ combos: [{ dims: { brand: 'A', size: null, n: 5 }, lines: 1, paise: '100', pico: '0', total: 1 }] });
    const r = await svc.combos('t1', { month: '2026-10' });
    expect(r.dimensionCombos[0].dims).toEqual({ brand: 'A', size: '', n: '5' });
  });
});
