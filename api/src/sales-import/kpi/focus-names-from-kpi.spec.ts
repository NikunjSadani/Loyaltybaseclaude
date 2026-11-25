/**
 * FOCUS-NAMES-FROM-KPI (owner-approved 2026-11-25): a TARGET_NAMES definition can read ANOTHER KPI's per-outlet focus
 * names (`focusNamesFromKpi`), so e.g. FB1 CASES (QUANTITY) counts exactly the products of FOCUS BRAND (AMOUNT).
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  attachOutletFilters,
  buildFocusCatalogue,
  buildMonthReconciliation,
  resolveMonthFocus,
  type MonthFocusInput,
  type MonthTargetRow,
} from './focus-products';
import { definitionsHash, type KpiDefLite } from './sales-kpi.helper';
import type { AggRow, RosterOutlet } from './sales-import-data';
import { computeMonthRows } from '../apply/month-compute';
import { SalesKpiDefService, toDto, toLite } from './sales-kpi-def.service';
import type { JwtPayload } from '../../common/decorators/current-user.decorator';
import type { SalesKpiMeasure } from '../sales-import.contract';

const DIMS = ['brand', 'skuGroup'];
const cat = buildFocusCatalogue(DIMS, [
  { brand: 'ADHO', skuGroup: '50' },
  { brand: 'ADHO', skuGroup: '500' },
  { brand: 'CNO', skuGroup: '50' },
  { brand: 'CNO', skuGroup: '500' },
  { brand: 'CNO ENRICH', skuGroup: '300' },
]);
const FB = 'FOCUS BRAND';
const FB2 = 'FOCUS BRAND 2';
const FB1C = 'FB1 CASES';
const FB2C = 'FB2 CASES';
const LABELS = new Map([
  [FB, 'Focus Brand 1'],
  [FB2, 'Focus Brand 2'],
  [FB1C, 'Focus Brand 1 Cases'],
  [FB2C, 'Focus Brand 2 Cases'],
  ['TOTAL', 'Total'],
]);
const tnDef = (kpiCode: string, measure: SalesKpiMeasure = 'AMOUNT', over: Partial<KpiDefLite> = {}): KpiDefLite => ({
  kpiCode,
  measure,
  filter: {},
  outletTypes: [],
  programs: [],
  productSource: 'TARGET_NAMES',
  ...over,
});
const totalDef: KpiDefLite = { kpiCode: 'TOTAL', measure: 'AMOUNT', filter: {}, outletTypes: [], programs: [] };
const fb1Cases = (over: Partial<KpiDefLite> = {}) => tnDef(FB1C, 'QUANTITY', { focusNamesFromKpi: FB, ...over });
const fb2Cases = (over: Partial<KpiDefLite> = {}) => tnDef(FB2C, 'QUANTITY', { focusNamesFromKpi: FB2, ...over });
const ro = (name: string, outletType: string | null): RosterOutlet => ({ name, outletType, program: null });
const tr = (values: Record<string, number>, names: Record<string, string> = {}): MonthTargetRow => ({ values, names });

function input(over: Partial<MonthFocusInput> = {}): MonthFocusInput {
  return {
    month: '2026-11',
    defs: [totalDef, tnDef(FB), tnDef(FB2)],
    labelOf: LABELS,
    roster: new Map([
      ['R1', ro('Retail 1', 'SSS')],
      ['R2', ro('Retail 2', 'SSS')],
      ['W1', ro('Whole 1', 'WS')],
      ['W2', ro('Whole 2', 'WS')],
    ]),
    targets: new Map([
      ['R1', tr({ [FB]: 1000, TOTAL: 5000, [FB1C]: 10 }, { [FB]: 'CNO & ADHO500' })],
      ['R2', tr({ [FB]: 800, [FB1C]: 8 }, { [FB]: 'cno& adho 500' })],
      ['W1', tr({ [FB]: 100, [FB2]: 200, [FB1C]: 1, [FB2C]: 2 }, { [FB]: 'ADHO50', [FB2]: 'ADHO500' })],
      ['W2', tr({ [FB]: 100, [FB2]: 200 }, { [FB]: 'ADHO50', [FB2]: 'ADHO500' })],
    ]),
    catalogue: cat,
    acceptances: new Map(),
    ...over,
  };
}

describe('existing measures are byte-identical (snapshot pinned on the pre-change code)', () => {
  // Pinned by running this exact block against origin/develop's focus-products.ts + sales-kpi.helper.ts (no borrower).
  const PINNED_FINGERPRINT = '8de0fd9036cca69102371c38bfbc57eb04151a83738f8a118eb4e8a15309f3b6';
  const PINNED_HASH = '23418b0be068d99eec3bb2d95f2e4d26913bed89911999853afce7e5e3eb6232';

  it('a tenant without a borrowing definition: resolution fingerprint + definitionsHash unchanged', () => {
    const res = resolveMonthFocus(input());
    expect({ fingerprint: res.fingerprint, hash: definitionsHash([totalDef, tnDef(FB), tnDef(FB2)]) }).toEqual({
      fingerprint: PINNED_FINGERPRINT,
      hash: PINNED_HASH,
    });
  });
});

describe('resolveMonthFocus — focusNamesFromKpi', () => {
  it('the cases measure gets EXACTLY the ₹ measure\'s product set and name key for every outlet', () => {
    const res = resolveMonthFocus(input({ defs: [totalDef, tnDef(FB), tnDef(FB2), fb1Cases(), fb2Cases()] }));
    for (const [src, borrower] of [[FB, FB1C], [FB2, FB2C]]) {
      const a = res.outletFilters.get(src)!;
      const b = res.outletFilters.get(borrower)!;
      expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
      for (const [code, f] of a) expect(b.get(code)).toEqual(f);
      expect([...res.outletNameKeys.get(borrower)!]).toEqual([...res.outletNameKeys.get(src)!]);
    }
    expect(res.outletFilters.get(FB1C)!.get('R1')).toEqual({ anyOf: [{ brand: 'CNO' }, { brand: 'ADHO', skuGroup: '500' }] });
    expect(res.blockers).toEqual([]);
    const fc = res.focus.find((f) => f.kpiCode === FB1C)!;
    expect(fc.measure).toBe('QUANTITY');
    expect(fc.names.map((n) => n.key).sort()).toEqual(['ADHO50', 'ADHO500&CNO']);
  });

  it('adding a borrower changes nothing about the ₹ measures (filters, blockers, focus entries)', () => {
    const base = resolveMonthFocus(input());
    const withB = resolveMonthFocus(input({ defs: [totalDef, tnDef(FB), tnDef(FB2), fb1Cases()] }));
    for (const code of [FB, FB2]) {
      expect(withB.outletFilters.get(code)).toEqual(base.outletFilters.get(code));
      expect(withB.outletNameKeys.get(code)).toEqual(base.outletNameKeys.get(code));
      expect(withB.focus.find((f) => f.kpiCode === code)).toEqual(base.focus.find((f) => f.kpiCode === code));
    }
    expect(withB.blockers.filter((b) => b.kpiCode !== FB1C)).toEqual(base.blockers);
  });

  it('missing name: a cases target but no FOCUS BRAND name → FOCUS_MISSING_NAME on the cases KPI, outlet omitted (not 0)', () => {
    const t = new Map(input().targets);
    t.set('R2', tr({ [FB1C]: 8 }, {})); // cases target, no ₹ target, no name
    const res = resolveMonthFocus(input({ defs: [tnDef(FB), fb1Cases()], targets: t }));
    const b = res.blockers.filter((x) => x.kpiCode === FB1C);
    expect(b).toEqual([
      expect.objectContaining({
        code: 'FOCUS_MISSING_NAME',
        outlets: 1,
        sampleOutletCodes: ['R2'],
        message: '1 outlet has a target but no Focus Brand 1 (FOCUS BRAND) product name in the target file, so Focus Brand 1 Cases (which uses those names) gets no value for it.',
      }),
    ]);
    expect(res.outletFilters.get(FB1C)!.has('R2')).toBe(false);
    // the ₹ measure has no ₹ target at R2 → no blocker of its own (unchanged rule)
    expect(res.blockers.filter((x) => x.kpiCode === FB)).toEqual([]);
  });

  it('Bajaj shape (NO cases targets): a FOCUS BRAND ₹ target without a name is flagged once (on FOCUS BRAND), not twice', () => {
    const t = new Map(input().targets);
    t.set('R2', tr({ [FB]: 800 }, {})); // ₹ target, no name, no cases target
    const res = resolveMonthFocus(input({ defs: [tnDef(FB), fb1Cases()], targets: t }));
    expect(res.blockers.map((b) => [b.code, b.kpiCode, b.sampleOutletCodes])).toEqual([['FOCUS_MISSING_NAME', FB, ['R2']]]);
    expect(res.outletFilters.get(FB1C)!.has('R2')).toBe(false);
  });

  it('a ₹ target without a name at an outlet OUTSIDE the ₹ KPI scope (but in the cases scope) → FOCUS_SCOPE_MISMATCH (scopes must match)', () => {
    const t = new Map(input().targets);
    t.set('W1', tr({ [FB]: 100 }, {}));
    const res = resolveMonthFocus(input({ defs: [tnDef(FB, 'AMOUNT', { outletTypes: ['SSS'] }), fb1Cases({ outletTypes: ['WS'] })], targets: t }));
    // audit round 2: different scopes are refused outright (the same names over different outlets ≠ the same products)
    expect(res.blockers.map((b) => [b.code, b.kpiCode, b.sampleOutletCodes])).toEqual([['FOCUS_SCOPE_MISMATCH', FB1C, ['W1', 'W2']]]);
  });

  it('an UNMATCHED token is reported once (on the source); accepting it on the source clears both', () => {
    const t = new Map(input().targets);
    t.set('R1', tr({ [FB]: 1000, [FB1C]: 10 }, { [FB]: 'CNO & XYZ' }));
    const defs = [tnDef(FB), fb1Cases()];
    const res = resolveMonthFocus(input({ defs, targets: t }));
    expect(res.blockers.map((b) => [b.code, b.kpiCode, b.key])).toEqual([['FOCUS_UNMATCHED', FB, 'XYZ']]);
    expect(res.outletFilters.get(FB1C)!.get('R1')).toEqual(res.outletFilters.get(FB)!.get('R1')); // matched part only
    const acc = new Map([[`${FB}|XYZ`, { byName: 'Ops', at: '2026-11-25T00:00:00.000Z' }]]);
    const res2 = resolveMonthFocus(input({ defs, targets: t, acceptances: acc }));
    expect(res2.blockers).toEqual([]);
    const tok = res2.focus.find((f) => f.kpiCode === FB1C)!.names.flatMap((n) => n.tokens).find((x) => x.key === 'XYZ')!;
    expect(tok.accepted).toEqual({ byName: 'Ops', at: '2026-11-25T00:00:00.000Z' });
  });

  it('an outlet only in the cases KPI scope → FOCUS_SCOPE_MISMATCH, not a per-token blocker', () => {
    const t = new Map(input().targets);
    t.set('W1', tr({ [FB1C]: 1 }, { [FB]: 'ZZZ' }));
    const res = resolveMonthFocus(
      input({ defs: [tnDef(FB, 'AMOUNT', { outletTypes: ['SSS'] }), fb1Cases({ outletTypes: ['WS'] })], targets: t }),
    );
    expect(res.blockers.map((b) => [b.code, b.kpiCode])).toEqual([['FOCUS_SCOPE_MISMATCH', FB1C]]); // audit round 2
  });

  it('source not an enabled own-names TARGET_NAMES definition → FOCUS_SOURCE_MISSING, no outlet gets a value', () => {
    for (const defs of [[fb1Cases()], [tnDef(FB, 'AMOUNT', { productSource: undefined }), fb1Cases()], [tnDef(FB, 'AMOUNT', { focusNamesFromKpi: FB2 }), tnDef(FB2), fb1Cases()]]) {
      const res = resolveMonthFocus(input({ defs }));
      const b = res.blockers.filter((x) => x.kpiCode === FB1C);
      expect(b).toHaveLength(1);
      expect(b[0]).toEqual(expect.objectContaining({ code: 'FOCUS_SOURCE_MISSING', outlets: 4 }));
      expect(b[0].message).toMatch(/uses the focus product names of "FOCUS BRAND"/);
      expect(res.outletFilters.get(FB1C)!.size).toBe(0);
      expect(res.fingerprint).not.toBe('');
    }
  });

  it('fingerprint changes when a borrower is pointed at a different KPI', () => {
    const a = resolveMonthFocus(input({ defs: [tnDef(FB), tnDef(FB2), fb1Cases()] }));
    const b = resolveMonthFocus(input({ defs: [tnDef(FB), tnDef(FB2), fb1Cases({ focusNamesFromKpi: FB2 })] }));
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe('audit round 2 — scope, no names, separator de-dupe', () => {
  it('scope mismatch at run time (e.g. the KPI applies-to changed later) → FOCUS_SCOPE_MISMATCH, no outlet gets a value', () => {
    const res = resolveMonthFocus(input({ defs: [tnDef(FB), fb1Cases({ kpiScope: { outletTypes: ['WS'], programs: [], subPrograms: [] } })] }));
    expect(res.blockers.map((b) => [b.code, b.kpiCode, b.outlets])).toEqual([['FOCUS_SCOPE_MISMATCH', FB1C, 2]]);
    expect(res.outletFilters.get(FB1C)!.size).toBe(0);
  });

  it('the same EFFECTIVE scope written differently (definition types vs KPI applies-to) is not a mismatch', () => {
    const res = resolveMonthFocus(input({
      defs: [tnDef(FB, 'AMOUNT', { outletTypes: ['sss'] }), fb1Cases({ kpiScope: { outletTypes: ['SSS'], programs: [], subPrograms: [] } })],
    }));
    expect(res.blockers).toEqual([]);
    expect([...res.outletFilters.get(FB1C)!.keys()].sort()).toEqual(['R1', 'R2']);
  });

  it('the source has NO focus names at all this month → NOT a blocker: the cases KPI is listed as not calculated (owner 2026-11-25)', () => {
    // ₹-only rows (the borrower's own cases targets are kept here: they must NOT add a missing-name blocker either)
    const t = new Map([...input().targets].map(([k, r]) => [k, tr(r.values, {})]));
    const res = resolveMonthFocus(input({ defs: [fb1Cases(), tnDef(FB)], targets: t }));
    expect(res.blockers.filter((x) => x.kpiCode === FB1C)).toEqual([]);
    expect(res.notCalculated).toEqual([
      { kpiCode: FB1C, namesFromKpi: FB, message: "No focus names in this month's target file — Focus Brand 1 Cases not calculated." },
    ]);
    expect(res.outletFilters.get(FB1C)!.size).toBe(0); // every outlet left EMPTY (no value, not 0)
    // no target file at all for the month → the same, nothing blocks
    const none = resolveMonthFocus(input({ defs: [tnDef(FB), fb1Cases()], targets: new Map() }));
    expect(none.blockers).toEqual([]);
    expect(none.notCalculated.map((n) => n.kpiCode)).toEqual([FB1C]);
    // names present → nothing listed; a tenant without a borrower never lists anything
    expect(resolveMonthFocus(input({ defs: [tnDef(FB), fb1Cases()] })).notCalculated).toEqual([]);
    expect(resolveMonthFocus(input({ targets: new Map() })).notCalculated).toEqual([]);
  });

  it('a separator-only name is reported once (on the source), payload unchanged (no key)', () => {
    const t = new Map(input().targets);
    t.set('R1', tr({ [FB]: 10 }, { [FB]: '&' }));
    const res = resolveMonthFocus(input({ defs: [tnDef(FB), fb1Cases()], targets: t }));
    const sep = res.blockers.filter((b) => b.message.startsWith('"&"'));
    expect(sep.map((b) => b.kpiCode)).toEqual([FB]);
    expect(sep[0]).not.toHaveProperty('key');
  });
});

describe('end to end: cases over the ₹ measure\'s products (computeMonthRows + reconciliation)', () => {
  let id = 0;
  const line = (code: string, brand: string, skuGroup: string, amountPaise: bigint, qtyPico: bigint): AggRow => {
    const dims = { brand, skuGroup };
    return { id: BigInt(++id), month: '2026-11', outletCode: code, dims, dimKey: JSON.stringify(dims), amountPaise, qtyPico, lines: 1 };
  };
  const pager = (rows: AggRow[]) => async (onPage: (r: AggRow[]) => void | Promise<void>) => {
    await onPage(rows);
  };
  const CASE = 1_000_000_000_000n;

  it('"CNO & ADHO500" sums the cases of BOTH (all CNO SKUs + ADHO 500), the same lines the ₹ measure sums', async () => {
    const inp = input({ defs: [totalDef, tnDef(FB), fb1Cases()] });
    const res = resolveMonthFocus(inp);
    const defs = attachOutletFilters(inp.defs, res);
    const rows = (code: string) => [
      line(code, 'CNO', '50', 10000n, 2n * CASE),
      line(code, 'CNO', '500', 20000n, 3n * CASE),
      line(code, 'ADHO', '500', 40000n, 4n * CASE),
      line(code, 'ADHO', '50', 80000n, 7n * CASE),
      line(code, 'CNO ENRICH', '300', 160000n, 11n * CASE),
    ];
    const comp = await computeMonthRows(pager([...rows('R1'), ...rows('W1')]), defs, inp.roster as Map<string, RosterOutlet>);
    const v = Object.fromEntries(comp.rows.map((r) => [r.outletCode, r.values]));
    expect(v.R1).toEqual({ TOTAL: 3100, [FB]: 700, [FB1C]: 9 }); // ₹ 100+200+400; cases 2+3+4
    expect(v.W1).toEqual({ TOTAL: 3100, [FB]: 800, [FB1C]: 7 }); // ADHO50 only
    const rec = buildMonthReconciliation({ input: inp, resolution: res, comp, targetUploadedAt: null, ownedKpiCodes: ['TOTAL', FB, FB1C] });
    const fc = rec.focus.find((f) => f.kpiCode === FB1C)!;
    expect(fc.names.find((n) => n.key === 'ADHO500&CNO')!.achieved).toEqual({ total: 9, outletsZero: 1 }); // R2 no sales
    expect(rec.blockers).toEqual([]);
  });

  it('Bajaj shape: NO cases target anywhere — every outlet with a FOCUS BRAND name still gets FB1 CASES achieved; BSC CASES (FILTER) for every in-scope outlet', async () => {
    // Target file = ₹ only (TOTAL / FOCUS BRAND), no FB1 CASES / BSC CASES columns at all.
    const targets = new Map<string, MonthTargetRow>([
      ['R1', tr({ TOTAL: 5000, [FB]: 1000 }, { [FB]: 'CNO & ADHO500' })],
      ['W1', tr({ [FB]: 100 }, { [FB]: 'ADHO50' })],
      ['R2', tr({ TOTAL: 4000 }, { [FB]: 'CNO' })], // a name but no ₹ FB target either
      // W2: no target row at all
    ]);
    const bscCases: KpiDefLite = { kpiCode: 'BSC CASES', measure: 'QUANTITY', filter: {}, outletTypes: [], programs: [] };
    const inp = input({ defs: [totalDef, bscCases, tnDef(FB), fb1Cases()], targets });
    const res = resolveMonthFocus(inp);
    expect(res.blockers).toEqual([]);
    const defs = attachOutletFilters(inp.defs, res);
    const rows = (code: string) => [
      line(code, 'CNO', '50', 10000n, 2n * CASE),
      line(code, 'ADHO', '500', 40000n, 4n * CASE),
      line(code, 'ADHO', '50', 80000n, 7n * CASE),
    ];
    const comp = await computeMonthRows(pager([...rows('R1'), ...rows('R2'), ...rows('W1'), ...rows('W2')]), defs, inp.roster as Map<string, RosterOutlet>);
    const v = Object.fromEntries(comp.rows.map((r) => [r.outletCode, r.values]));
    expect(v.R1).toEqual({ TOTAL: 1300, 'BSC CASES': 13, [FB]: 500, [FB1C]: 6 });
    expect(v.R2).toEqual({ TOTAL: 1300, 'BSC CASES': 13, [FB]: 100, [FB1C]: 2 });
    expect(v.W1).toEqual({ TOTAL: 1300, 'BSC CASES': 13, [FB]: 800, [FB1C]: 7 });
    expect(v.W2).toEqual({ TOTAL: 1300, 'BSC CASES': 13 }); // no name → focus keys omitted, no target → no blocker
  });
});

// ─── Service: storage, validation, other tenants ─────────────────────────────
const user: JwtPayload = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '', name: 'A' };
const MAPPING = {
  headerRow: 'auto' as const,
  outletCode: 'CUSTOMER CODE',
  invoiceDate: 'INVOICE DATE',
  amount: 'NET AMT',
  quantity: 'QTY',
  dimensions: [{ key: 'brand', label: 'Brand', header: 'BRAND' }],
  dateOrder: 'DMY' as const,
};
const row = (over: Record<string, unknown> = {}) => ({
  id: 'd1', clientId: 't1', kpiCode: FB, measure: 'AMOUNT', filter: {}, productSource: 'TARGET_NAMES', focusNamesFromKpi: null,
  outletTypes: [], programs: [], enabled: true, order: 0, updatedById: 'u0', createdAt: new Date(0), updatedAt: new Date(0), ...over,
});
function db(defsByCode: Record<string, ReturnType<typeof row>> = {}) {
  const d: Record<string, any> = {
    salesImportProfile: { findUnique: jest.fn(async () => ({ columnMapping: MAPPING })) },
    salesKpiDefinition: {
      findMany: jest.fn(async () => []),
      // clientId-scoped like the real unique index: another tenant's definition is never returned.
      findUnique: jest.fn(async ({ where }: { where: { clientId_kpiCode: { clientId: string; kpiCode: string } } }) => {
        const r = defsByCode[where.clientId_kpiCode.kpiCode];
        return r && r.clientId === where.clientId_kpiCode.clientId ? r : null;
      }),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row(), id: 'new', ...data })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row(), ...data })),
    },
    kpiDef: {
      // Only FOCUS BRAND / FOCUS BRAND 2 have the per-outlet name column; the CASES KPIs don't need one.
      findFirst: jest.fn(async ({ where }: { where: { code: string } }) => ({
        code: where.code,
        hasNameOverride: where.code.startsWith('FOCUS'),
        nameOverrideLabel: where.code.startsWith('FOCUS') ? 'Focus brand' : null,
      })),
      findMany: jest.fn(async () => []),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  d.$queryRaw = jest.fn(async () => []); // row locks (SELECT … FOR UPDATE)
  d.$transaction = jest.fn(async (cb: (tx: unknown) => unknown) => cb(d));
  return d;
}
const casesDto = (over: Record<string, unknown> = {}) =>
  ({ kpiCode: FB1C, measure: 'QUANTITY', filter: {}, productSource: 'TARGET_NAMES', focusNamesFromKpi: FB, outletTypes: [], programs: [], enabled: true, order: 0, ...over }) as never;

describe('SalesKpiDefService — focusNamesFromKpi', () => {
  it('create: saves the source code; the cases KPI needs no name column of its own; DTO + lite carry it', async () => {
    const d = db({ [FB]: row() });
    const out = await new SalesKpiDefService(d as never).create(user, casesDto());
    expect(d.salesKpiDefinition.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ kpiCode: FB1C, measure: 'QUANTITY', productSource: 'TARGET_NAMES', focusNamesFromKpi: FB, filter: {} }),
    );
    expect(out.focusNamesFromKpi).toBe(FB);
    expect(toLite(row({ kpiCode: FB1C, measure: 'QUANTITY', focusNamesFromKpi: FB })).focusNamesFromKpi).toBe(FB);
  });

  it.each([
    ['self-reference', { focusNamesFromKpi: FB1C }, /can't use its own focus names/],
    ['not from the target file', { productSource: 'FILTER' }, /Only a KPI whose products come from the target file/],
    ['unknown source', { focusNamesFromKpi: 'NOPE' }, /"NOPE" is not a Sales Import KPI whose products come from the target file/],
    ['not a string', { focusNamesFromKpi: 5 }, /must be a KPI code or empty/],
  ])('create: %s → 400', async (_n, over, re) => {
    const d = db({ [FB]: row() });
    await expect(new SalesKpiDefService(d as never).create(user, casesDto(over))).rejects.toThrow(re);
    expect(d.salesKpiDefinition.create).not.toHaveBeenCalled();
  });

  it('create: source must be ENABLED and TARGET_NAMES, and must not borrow itself (no chains / cycles)', async () => {
    const cases: Array<[ReturnType<typeof row>, RegExp]> = [
      [row({ enabled: false }), /is not a Sales Import KPI whose products come from the target file/],
      [row({ productSource: 'FILTER' }), /is not a Sales Import KPI whose products come from the target file/],
      [row({ focusNamesFromKpi: FB2 }), /"FOCUS BRAND" itself uses the focus names of "FOCUS BRAND 2"/],
    ];
    for (const [src, re] of cases) {
      const d = db({ [FB]: src });
      const err = await new SalesKpiDefService(d as never).create(user, casesDto()).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(re);
    }
  });

  it('tenant isolation: another tenant\'s FOCUS BRAND definition cannot be borrowed', async () => {
    const d = db({ [FB]: row({ clientId: 'other' }) });
    await expect(new SalesKpiDefService(d as never).create(user, casesDto())).rejects.toThrow(/is not a Sales Import KPI/);
    expect(d.salesKpiDefinition.findUnique).toHaveBeenCalledWith({ where: { clientId_kpiCode: { clientId: 't1', kpiCode: FB } } });
  });

  it('a borrowed-from definition cannot be disabled, renamed, switched to FILTER or made to borrow (409 naming the borrowers)', async () => {
    const d = db({ [FB2]: row({ kpiCode: FB2 }) });
    d.salesKpiDefinition.findFirst.mockResolvedValue(row());
    d.salesKpiDefinition.findMany.mockResolvedValue([{ kpiCode: FB1C }]);
    const s = new SalesKpiDefService(d as never);
    for (const p of [{ enabled: false }, { kpiCode: 'FOCUS BRAND X' }, { productSource: 'FILTER' as const }, { focusNamesFromKpi: FB2 }]) {
      const err = await s.patch(user, 'd1', p).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe('"FB1 CASES" uses the focus names of "FOCUS BRAND". Change that KPI first.');
    }
    await expect(s.disable(user, 'd1')).rejects.toBeInstanceOf(ConflictException);
    expect(d.salesKpiDefinition.findMany).toHaveBeenCalledWith({
      where: { clientId: 't1', enabled: true, productSource: 'TARGET_NAMES', focusNamesFromKpi: FB, id: { not: 'd1' } },
      select: { kpiCode: true },
      orderBy: { kpiCode: 'asc' },
    });
    expect(d.salesKpiDefinition.update).not.toHaveBeenCalled();
    // A harmless patch (order) is still allowed.
    await s.patch(user, 'd1', { order: 4 });
    expect(d.salesKpiDefinition.update).toHaveBeenCalledTimes(1);
  });

  it('scope must equal the source\'s effective scope (definition types / programmes AND the KPI applies-to)', async () => {
    const d = db({ [FB]: row({ outletTypes: ['RETAILER'] }) });
    await expect(new SalesKpiDefService(d as never).create(user, casesDto())).rejects.toThrow(
      /"FB1 CASES" must apply to exactly the same outlets as "FOCUS BRAND"/,
    );
    // same effective scope via the KPI's own applies-to → accepted
    d.kpiDef.findMany.mockResolvedValue([{ code: FB1C, outletType: null, outletTypes: ['RETAILER'], programs: [], subPrograms: [] }]);
    await new SalesKpiDefService(d as never).create(user, casesDto());
    expect(d.salesKpiDefinition.create).toHaveBeenCalledTimes(1);
  });

  it('editing a DISABLED borrower whose source is disabled is allowed; enabling it re-checks the source', async () => {
    const d = db({ [FB]: row({ enabled: false }) });
    d.salesKpiDefinition.findFirst.mockResolvedValue(row({ id: 'd9', kpiCode: FB1C, measure: 'QUANTITY', focusNamesFromKpi: FB, enabled: false }));
    const s = new SalesKpiDefService(d as never);
    await s.patch(user, 'd9', { order: 7 });
    expect(d.salesKpiDefinition.update).toHaveBeenCalledTimes(1);
    await expect(s.patch(user, 'd9', { enabled: true })).rejects.toThrow(/is not a Sales Import KPI whose products come from the target file/);
  });

  it('atomic: the source is locked and re-read INSIDE the write transaction, before the write', async () => {
    const d = db({ [FB]: row() });
    const order: string[] = [];
    d.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => { order.push('tx'); return cb(d); });
    d.$queryRaw.mockImplementation(async () => { order.push('lock'); return []; });
    d.salesKpiDefinition.findUnique.mockImplementation(async ({ where }: { where: { clientId_kpiCode: { kpiCode: string } } }) => {
      order.push(`read:${where.clientId_kpiCode.kpiCode}`);
      return where.clientId_kpiCode.kpiCode === FB ? row() : null;
    });
    d.salesKpiDefinition.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { order.push('write'); return { ...row(), ...data }; });
    await new SalesKpiDefService(d as never).create(user, casesDto());
    expect(order).toEqual(['tx', 'lock', `read:${FB}`, `read:${FB1C}`, 'write']);
    // the source side locks its own row before looking for borrowers
    const d2 = db();
    const o2: string[] = [];
    d2.salesKpiDefinition.findFirst.mockResolvedValue(row());
    d2.$queryRaw.mockImplementation(async () => { o2.push('lock'); return []; });
    d2.salesKpiDefinition.findMany.mockImplementation(async () => { o2.push('borrowers'); return []; });
    d2.salesKpiDefinition.update.mockImplementation(async () => { o2.push('write'); return row({ enabled: false }); });
    await new SalesKpiDefService(d2 as never).disable(user, 'd1');
    expect(o2).toEqual(['lock', 'borrowers', 'write']);
  });

  it('a borrowed-from definition cannot change its outlet scope (409)', async () => {
    const d = db();
    d.salesKpiDefinition.findFirst.mockResolvedValue(row());
    d.salesKpiDefinition.findMany.mockResolvedValue([{ kpiCode: FB1C }]);
    await expect(new SalesKpiDefService(d as never).patch(user, 'd1', { outletTypes: ['RETAILER'] })).rejects.toBeInstanceOf(ConflictException);
  });

  it('clearing it (null / "") stores NULL and the definition reads its own names again', async () => {
    const d = db({ [FB]: row() });
    d.salesKpiDefinition.findFirst.mockResolvedValue(row({ id: 'd9', kpiCode: FB1C, measure: 'QUANTITY', focusNamesFromKpi: FB }));
    await new SalesKpiDefService(d as never).patch(user, 'd9', { focusNamesFromKpi: null, productSource: 'FILTER' });
    expect(d.salesKpiDefinition.update.mock.calls[0][0].data.focusNamesFromKpi).toBeNull();
  });

  it('other tenants / existing rows: no focusNamesFromKpi → DTO, lite and definitionsHash exactly as before', () => {
    const r = row({ focusNamesFromKpi: null });
    expect(toDto(r as never)).not.toHaveProperty('focusNamesFromKpi');
    expect(toLite(r)).not.toHaveProperty('focusNamesFromKpi');
    const { focusNamesFromKpi: _x, ...legacyRow } = r; // a row read before the column existed
    expect(definitionsHash([toLite(r)])).toBe(definitionsHash([toLite(legacyRow)]));
    // stale value on a FILTER row is ignored everywhere
    const stale = row({ productSource: 'FILTER', focusNamesFromKpi: FB2 });
    expect(toDto(stale as never)).not.toHaveProperty('focusNamesFromKpi');
    expect(toLite(stale)).not.toHaveProperty('focusNamesFromKpi');
    // a borrower's hash differs from the same def without it (a preview from before the change can't be applied)
    expect(definitionsHash([toLite(row({ kpiCode: FB1C, focusNamesFromKpi: FB }))])).not.toBe(definitionsHash([toLite(row({ kpiCode: FB1C }))]));
  });
});
