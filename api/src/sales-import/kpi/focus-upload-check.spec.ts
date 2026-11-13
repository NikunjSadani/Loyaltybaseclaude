/**
 * FOCUS-FROM-TARGETS design §7 — the target upload's early, NON-blocking focus check (REAL focus-products).
 */
import type { Prisma } from '@prisma/client';
import { FOCUS_CHECK_FAILED, FOCUS_CHECK_NO_DEFINITION, FOCUS_CHECK_NO_PRODUCTS, targetUploadFocusCheck } from './focus-upload-check';

const MAPPING = {
  headerRow: 'auto', outletCode: 'C', invoiceDate: 'D', amount: 'A', dateOrder: 'DMY',
  dimensions: [{ key: 'brand', label: 'Brand', header: 'B' }, { key: 'skuGroup', label: 'SKU', header: 'S' }],
};

function fakeDb(opts: { defs?: Array<Record<string, unknown>>; combos?: Array<Record<string, string>>; kpiScopes?: Array<Record<string, unknown>> } = {}) {
  return {
    salesKpiDefinition: { findMany: jest.fn(async () => opts.defs ?? []) },
    salesImportProfile: { findUnique: jest.fn(async () => ({ columnMapping: MAPPING })) },
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      const text = q.strings.join('?');
      if (!text.includes('FROM "sales_month_history_combos"')) throw new Error(`unexpected SQL ${text}`);
      return (opts.combos ?? []).map((d) => ({ dims: JSON.stringify(d) }));
    }),
    kpiDef: {
      findMany: jest.fn(async ({ select }: { select: Record<string, boolean> }) =>
        select.label
          ? [{ code: 'FB1', label: 'Focus Brand 1' }, { code: 'FB2', label: 'Focus Brand 2' }]
          : (opts.kpiScopes ?? [])),
    },
    outlet: {
      findMany: jest.fn(async () => [
        { id: 'r1', outletCode: 'R1', name: 'R1', programName: null, programCategory: null, outletType: { code: 'SSS' } },
        { id: 'r2', outletCode: 'R2', name: 'R2', programName: null, programCategory: null, outletType: { code: 'SSS' } },
        { id: 'w1', outletCode: 'W1', name: 'W1', programName: null, programCategory: null, outletType: { code: 'WHOLESALER' } },
      ]),
    },
  };
}

const def = (kpiCode: string, over: Record<string, unknown> = {}) => ({
  id: kpiCode, clientId: 't1', kpiCode, measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [], enabled: true, order: 0,
  productSource: 'TARGET_NAMES', ...over,
});
const COMBOS = [
  { brand: 'CNO', skuGroup: '200' },
  { brand: 'CNO ENRICH', skuGroup: '200' },
  { brand: 'ADHO', skuGroup: '50' },
  { brand: 'ADHO', skuGroup: '500' },
];
const M = '2026-11';

describe('targetUploadFocusCheck (design §7)', () => {
  it('no TARGET_NAMES definition → checked:false (FILTER rows returned by a loose mock are ignored too)', async () => {
    const db = fakeDb({ defs: [def('TOTAL', { productSource: 'FILTER' })] });
    await expect(targetUploadFocusCheck(db as never, 't1', {}, [M])).resolves.toEqual({ checked: false, reason: FOCUS_CHECK_NO_DEFINITION, months: [] });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('no stored product list yet → checked:false with the reason', async () => {
    const db = fakeDb({ defs: [def('FB1')], combos: [] });
    await expect(targetUploadFocusCheck(db as never, 't1', {}, [M])).resolves.toEqual({ checked: false, reason: FOCUS_CHECK_NO_PRODUCTS, months: [] });
  });

  it('November names resolve; a typo and a missing name are reported per month (catalogue loaded ONCE)', async () => {
    const db = fakeDb({ defs: [def('FB1'), def('FB2', { outletTypes: ['WHOLESALER'] })], combos: COMBOS });
    const uploaded = {
      [M]: {
        R1: { FB1: 1000, __names: { FB1: 'CNO & ADHO500' } },
        R2: { FB1: 1000, __names: { FB1: 'CNO & ADH0500' } }, // typo: zero for O
        W1: { FB1: 500, FB2: 600, __names: { FB1: 'ADHO50' } }, // FB2 target but no name
      },
      '2026-12': { R1: { FB1: 5, __names: { FB1: 'CNO' } } },
    };
    const out = await targetUploadFocusCheck(db as never, 't1', uploaded, ['2026-12', M]);
    expect(out.checked).toBe(true);
    expect(out.months.map((m) => m.month)).toEqual([M, '2026-12']);
    const nov = out.months[0].blockers;
    expect(nov).toEqual([
      expect.objectContaining({ code: 'FOCUS_UNMATCHED', kpiCode: 'FB1', key: 'ADH0500', sampleOutletCodes: ['R2'] }),
      expect.objectContaining({ code: 'FOCUS_MISSING_NAME', kpiCode: 'FB2', outlets: 1, sampleOutletCodes: ['W1'] }),
    ]);
    expect(out.months[1].blockers).toEqual([]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('never throws: a failing read → checked:false (the upload is never blocked)', async () => {
    const db = fakeDb({ defs: [def('FB1')], combos: COMBOS });
    db.$queryRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(targetUploadFocusCheck(db as never, 't1', {}, [M])).resolves.toEqual({ checked: false, reason: FOCUS_CHECK_FAILED, months: [] });
  });
});
