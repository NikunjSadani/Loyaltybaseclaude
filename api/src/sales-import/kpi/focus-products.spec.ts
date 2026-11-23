import {
  FOCUS_SAMPLE_LIMIT,
  attachOutletFilters,
  buildFocusCatalogue,
  buildMonthReconciliation,
  focusKey,
  focusNameKey,
  resolveFocusToken,
  resolveMonthFocus,
  splitFocusName,
  type FocusAcceptanceInfo,
  type MonthFocusInput,
  type MonthTargetRow,
} from './focus-products';
import { OutletKpiAccumulator, type KpiDefLite } from './sales-kpi.helper';
import type { RosterOutlet, AggRow } from './sales-import-data';
import { computeMonthRows } from '../apply/month-compute';
import { loadFocusCatalogue } from './focus-data';
import type { SalesKpiMeasure } from '../sales-import.contract';

// ─── November 2026 shape (prod) ──────────────────────────────────────────────
const DIMS = ['brand', 'skuGroup'];
const NOV_COMBOS = [
  { brand: 'ADHO', skuGroup: '50' },
  { brand: 'ADHO', skuGroup: '500' },
  { brand: 'ADHO', skuGroup: '300' },
  { brand: 'CNO', skuGroup: '50' },
  { brand: 'CNO', skuGroup: '500' },
  { brand: 'CNO ENRICH', skuGroup: '300' },
  { brand: 'CNO GREEN', skuGroup: '' },
];
const cat = buildFocusCatalogue(DIMS, NOV_COMBOS);

const FB = 'FOCUS BRAND';
const FB2 = 'FOCUS BRAND 2';
const LABELS = new Map([
  [FB, 'Focus Brand 1'],
  [FB2, 'Focus Brand 2'],
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
      ['R1', tr({ [FB]: 1000, TOTAL: 5000 }, { [FB]: 'CNO & ADHO500' })],
      ['R2', tr({ [FB]: 800 }, { [FB]: 'cno& adho 500' })],
      ['W1', tr({ [FB]: 100, [FB2]: 200 }, { [FB]: 'ADHO50', [FB2]: 'ADHO500' })],
      ['W2', tr({ [FB]: 100, [FB2]: 200 }, { [FB]: 'ADHO50', [FB2]: 'ADHO500' })],
    ]),
    catalogue: cat,
    acceptances: new Map(),
    ...over,
  };
}

describe('focusKey / splitFocusName', () => {
  it('uppercases, trims and removes every space', () => {
    expect(focusKey('  adho  500 ')).toBe('ADHO500');
    expect(focusKey('CNO Enrich')).toBe('CNOENRICH');
    expect(focusKey(null)).toBe('');
  });
  it('splits on & and , trims, drops empties, de-dupes by key keeping the first spelling', () => {
    expect(splitFocusName('CNO & ADHO500')).toEqual(['CNO', 'ADHO500']);
    expect(splitFocusName(' cno ,adho 500 && , ')).toEqual(['cno', 'adho 500']);
    expect(splitFocusName('ADHO 500 & adho500 & CNO')).toEqual(['ADHO 500', 'CNO']);
    expect(splitFocusName('  ')).toEqual([]);
  });
  it('focusNameKey is order / spelling independent', () => {
    expect(focusNameKey('CNO & ADHO500')).toBe('ADHO500&CNO');
    expect(focusNameKey('adho 500, cno')).toBe('ADHO500&CNO');
  });
});

describe('buildFocusCatalogue', () => {
  it('indexes every non-blank prefix: brand-only key and brand+sku key', () => {
    expect(cat.byKey.get('ADHO')).toEqual([{ brand: 'ADHO' }]);
    expect(cat.byKey.get('ADHO500')).toEqual([{ brand: 'ADHO', skuGroup: '500' }]);
    expect(cat.byKey.get('CNOENRICH')).toEqual([{ brand: 'CNO ENRICH' }]);
  });
  it('a blank value ends the prefix (brand key only)', () => {
    expect(cat.byKey.get('CNOGREEN')).toEqual([{ brand: 'CNO GREEN' }]);
    expect([...cat.byKey.keys()].filter((k) => k.startsWith('CNOGREEN'))).toEqual(['CNOGREEN']);
  });
  it('DimMatches are distinct; size = distinct combos', () => {
    const c = buildFocusCatalogue(DIMS, [...NOV_COMBOS, { brand: 'adho', skuGroup: '50' }, { brand: 'ADHO', skuGroup: '50' }]);
    expect(c.byKey.get('ADHO')).toEqual([{ brand: 'ADHO' }]);
    expect(c.size).toBe(NOV_COMBOS.length);
    expect(buildFocusCatalogue(DIMS, []).size).toBe(0);
  });
  it('audit follow-up: no dimension keys → size 0 and no keys (nothing can be named), whatever the combos', () => {
    const c = buildFocusCatalogue([], NOV_COMBOS);
    expect(c.size).toBe(0);
    expect(c.byKey.size).toBe(0);
  });
});

describe('resolveFocusToken', () => {
  it('CNO = only the brand CNO (CNO Enrich / CNO Green have their own keys)', () => {
    expect(resolveFocusToken('CNO', cat)).toEqual({ token: 'CNO', key: 'CNO', status: 'MATCHED', product: { brand: 'CNO' } });
  });
  it('ADHO50 and ADHO500 are distinct MATCHED products', () => {
    expect(resolveFocusToken('ADHO50', cat).product).toEqual({ brand: 'ADHO', skuGroup: '50' });
    expect(resolveFocusToken(' adho 500 ', cat)).toMatchObject({ token: 'adho 500', key: 'ADHO500', status: 'MATCHED', product: { brand: 'ADHO', skuGroup: '500' } });
  });
  it('UNMATCHED', () => {
    expect(resolveFocusToken('ADHO5000', cat)).toEqual({ token: 'ADHO5000', key: 'ADHO5000', status: 'UNMATCHED' });
  });
  it('AMBIGUOUS lists every candidate', () => {
    const c = buildFocusCatalogue(DIMS, [{ brand: 'AB', skuGroup: 'C' }, { brand: 'A', skuGroup: 'BC' }]);
    const r = resolveFocusToken('ABC', c);
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.candidates).toEqual(expect.arrayContaining([{ brand: 'AB', skuGroup: 'C' }, { brand: 'A', skuGroup: 'BC' }]));
    expect(r.candidates).toHaveLength(2);
  });
});

describe('resolveMonthFocus — design §4', () => {
  it('November: per-outlet filters, name keys, no blockers', () => {
    const res = resolveMonthFocus(input());
    expect(res.blockers).toEqual([]);
    expect(res.outletFilters.get(FB)!.get('R1')).toEqual({ anyOf: [{ brand: 'CNO' }, { brand: 'ADHO', skuGroup: '500' }] });
    expect(res.outletFilters.get(FB)!.get('R2')).toBe(res.outletFilters.get(FB)!.get('R1')); // shared per name
    expect(res.outletFilters.get(FB)!.get('W1')).toEqual({ anyOf: [{ brand: 'ADHO', skuGroup: '50' }] });
    expect(res.outletFilters.get(FB2)!.get('W1')).toEqual({ anyOf: [{ brand: 'ADHO', skuGroup: '500' }] });
    expect(res.outletFilters.get(FB2)!.has('R1')).toBe(false); // no name, no target → omitted, no blocker
    expect(res.outletNameKeys.get(FB)!.get('R2')).toBe('ADHO500&CNO');
    const fb = res.focus.find((f) => f.kpiCode === FB)!;
    expect(fb.label).toBe('Focus Brand 1');
    expect(fb.names.map((n) => [n.key, n.outlets, n.outletsByType])).toEqual([
      ['ADHO50', 2, { WS: 2 }],
      ['ADHO500&CNO', 2, { SSS: 2 }],
    ]);
    // most common spelling, ties → alphabetical ('CNO & ADHO500' < 'cno& adho 500')
    expect(fb.names[1].name).toBe('CNO & ADHO500');
    expect(fb.names[1].tokens.map((t) => t.status)).toEqual(['MATCHED', 'MATCHED']);
    expect(fb.names[1].achieved).toEqual({ total: 0, outletsZero: 0 });
    expect(res.focus.map((f) => f.kpiCode)).toEqual([FB, FB2]);
    expect(res.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('no TARGET_NAMES definition → empty resolution, fingerprint ""', () => {
    const res = resolveMonthFocus(input({ defs: [totalDef] }));
    expect(res).toEqual({ outletFilters: new Map(), outletNameKeys: new Map(), blockers: [], focus: [], fingerprint: '' });
  });

  it('out-of-scope outlet is ignored (no filter, no blocker)', () => {
    const res = resolveMonthFocus(
      input({
        defs: [tnDef(FB2, 'AMOUNT', { outletTypes: ['WS'] })],
        targets: new Map([['R1', tr({ [FB2]: 5 })], ['W1', tr({ [FB2]: 5 }, { [FB2]: 'ADHO500' })]]),
      }),
    );
    expect(res.blockers).toEqual([]);
    expect([...res.outletFilters.get(FB2)!.keys()]).toEqual(['W1']);
  });

  it('UNMATCHED token → blocker; matched tokens still give the outlet a filter', () => {
    const res = resolveMonthFocus(input({ targets: new Map([['R1', tr({ [FB]: 1 }, { [FB]: 'CNO & ADHO5000' })]]) }));
    expect(res.blockers).toEqual([
      {
        code: 'FOCUS_UNMATCHED',
        kpiCode: FB,
        token: 'ADHO5000',
        key: 'ADHO5000',
        outlets: 1,
        sampleOutletCodes: ['R1'],
        message: '"ADHO5000" in Focus Brand 1 (FOCUS BRAND) is not a product in the sales data (1 outlet). Fix the target file, or accept it as not sold yet.',
      },
    ]);
    expect(res.outletFilters.get(FB)!.get('R1')).toEqual({ anyOf: [{ brand: 'CNO' }] });
  });

  it('accepted UNMATCHED token clears the blocker and contributes nothing; tokens carry `accepted`', () => {
    const acceptances = new Map<string, FocusAcceptanceInfo>([[`${FB}|ADHO5000`, { byName: 'Ops', at: '2026-11-07T00:00:00.000Z' }]]);
    const res = resolveMonthFocus(input({ targets: new Map([['R1', tr({ [FB]: 1 }, { [FB]: 'CNO & ADHO5000' })]]), acceptances }));
    expect(res.blockers).toEqual([]);
    expect(res.outletFilters.get(FB)!.get('R1')).toEqual({ anyOf: [{ brand: 'CNO' }] });
    const tok = res.focus[0].names[0].tokens.find((t) => t.key === 'ADHO5000')!;
    expect(tok).toMatchObject({ status: 'UNMATCHED', accepted: { byName: 'Ops', at: '2026-11-07T00:00:00.000Z' } });
    // an acceptance for ANOTHER KPI does not apply
    const other = resolveMonthFocus(
      input({ targets: new Map([['R1', tr({}, { [FB]: 'ADHO5000' })]]), acceptances: new Map([[`${FB2}|ADHO5000`, { byName: 'x', at: 'y' }]]) }),
    );
    expect(other.blockers.map((b) => b.code)).toEqual(['FOCUS_UNMATCHED']);
  });

  it('all tokens accepted → a filter that matches NOTHING (value 0, never all lines)', () => {
    const acceptances = new Map<string, FocusAcceptanceInfo>([[`${FB}|NEWBRAND`, { byName: 'Ops', at: 't' }]]);
    const res = resolveMonthFocus(input({ defs: [tnDef(FB)], targets: new Map([['R1', tr({ [FB]: 1 }, { [FB]: 'New Brand' })]]), acceptances }));
    expect(res.blockers).toEqual([]);
    const f = res.outletFilters.get(FB)!.get('R1')!;
    expect(f).not.toEqual({});
    const defs = attachOutletFilters([tnDef(FB)], res);
    const acc = new OutletKpiAccumulator(defs);
    acc.add('R1', { dims: { brand: 'ADHO', skuGroup: '500' }, amountPaise: 999n, qtyPico: 1n, lines: 1 });
    expect(acc.valuesFor('R1', { outletType: 'SSS', program: null })).toEqual({ [FB]: 0 });
  });

  it('AMBIGUOUS → blocker with both readings', () => {
    const c = buildFocusCatalogue(DIMS, [{ brand: 'AB', skuGroup: 'C' }, { brand: 'A', skuGroup: 'BC' }]);
    const res = resolveMonthFocus(input({ defs: [tnDef(FB)], catalogue: c, targets: new Map([['R1', tr({}, { [FB]: 'ABC' })]]) }));
    expect(res.blockers).toHaveLength(1);
    expect(res.blockers[0]).toMatchObject({ code: 'FOCUS_AMBIGUOUS', key: 'ABC', outlets: 1 });
    expect(res.blockers[0].message).toBe(
      '"ABC" in Focus Brand 1 (FOCUS BRAND) could mean more than one product: brand A + SKU group BC, or brand AB + SKU group C. Write it so only one product matches (1 outlet).',
    );
    // no MATCHED token → matches-nothing filter, still present
    expect(res.outletFilters.get(FB)!.has('R1')).toBe(true);
  });

  it('missing name: with a numeric target → FOCUS_MISSING_NAME + omitted; without → omitted, no blocker', () => {
    const res = resolveMonthFocus(
      input({
        defs: [tnDef(FB)],
        targets: new Map([
          ['R1', tr({ [FB]: 10 })],
          ['R2', tr({ [FB]: 0 }, { [FB]: '   ' })],
          ['W1', tr({ TOTAL: 3 })],
        ]),
      }),
    );
    expect(res.outletFilters.get(FB)!.size).toBe(0);
    expect(res.blockers).toEqual([
      {
        code: 'FOCUS_MISSING_NAME',
        kpiCode: FB,
        outlets: 2,
        sampleOutletCodes: ['R1', 'R2'],
        message: '2 outlets have a Focus Brand 1 target but no product name in the target file.',
      },
    ]);
    expect(res.focus[0].missingName).toEqual({ outlets: 2, sampleOutletCodes: ['R1', 'R2'] });
  });

  it('audit follow-up: a name made only of separators is a FOCUS_MISSING_NAME blocker WITH or WITHOUT a target; key omitted', () => {
    const res = resolveMonthFocus(
      input({
        defs: [tnDef(FB)],
        targets: new Map([
          ['R1', tr({ [FB]: 10 }, { [FB]: '&' })],
          ['R2', tr({}, { [FB]: '&' })], // no numeric target — still a blocker (the operator wrote something)
          ['W1', tr({ [FB]: 5 }, { [FB]: ' , && ' })],
          ['W2', tr({ [FB]: 5 }, { [FB]: 'ADHO50' })],
        ]),
      }),
    );
    expect(res.blockers).toEqual([
      {
        code: 'FOCUS_MISSING_NAME',
        kpiCode: FB,
        outlets: 2,
        sampleOutletCodes: ['R1', 'R2'],
        message: '"&" in Focus Brand 1 (FOCUS BRAND) for 2 outlets has no product in it. Write the product name(s) in the target file.',
      },
      {
        code: 'FOCUS_MISSING_NAME',
        kpiCode: FB,
        outlets: 1,
        sampleOutletCodes: ['W1'],
        message: '", &&" in Focus Brand 1 (FOCUS BRAND) for 1 outlet has no product in it. Write the product name(s) in the target file.',
      },
    ]);
    expect([...res.outletFilters.get(FB)!.keys()]).toEqual(['W2']);
    // not counted as "no name" (that is the target-without-name case)
    expect(res.focus[0].missingName.outlets).toBe(0);
    // the fingerprint sees the separator-only names
    const clean = resolveMonthFocus(input({ defs: [tnDef(FB)], targets: new Map([['W2', tr({ [FB]: 5 }, { [FB]: 'ADHO50' })]]) }));
    expect(res.fingerprint).not.toBe(clean.fingerprint);
  });

  it('audit follow-up: MonthFocusKpi carries the definition measure', () => {
    const res = resolveMonthFocus(input({ defs: [tnDef(FB, 'PRODUCT_COUNT'), tnDef(FB2, 'QUANTITY')] }));
    expect(res.focus.map((f) => [f.kpiCode, f.measure])).toEqual([[FB, 'PRODUCT_COUNT'], [FB2, 'QUANTITY']]);
  });

  it('blockers group by (kpi, token key), count outlets, samples sorted and ≤ 20', () => {
    const roster = new Map<string, RosterOutlet>();
    const targets = new Map<string, MonthTargetRow>();
    for (let i = 30; i >= 1; i--) {
      const code = `O${String(i).padStart(2, '0')}`;
      roster.set(code, ro(code, 'SSS'));
      targets.set(code, tr({ [FB]: 1 }, { [FB]: i % 2 ? 'adho 5000 & CNO' : 'ADHO5000' }));
    }
    const res = resolveMonthFocus(input({ defs: [tnDef(FB)], roster, targets }));
    expect(res.blockers).toHaveLength(1);
    expect(res.blockers[0].outlets).toBe(30);
    expect(res.blockers[0].sampleOutletCodes).toHaveLength(FOCUS_SAMPLE_LIMIT);
    expect(res.blockers[0].sampleOutletCodes[0]).toBe('O01');
    expect(res.blockers[0].sampleOutletCodes).toEqual([...res.blockers[0].sampleOutletCodes].sort());
    expect(res.blockers[0].token).toBe('adho 5000'); // first outlet in code order (O01, odd) spelling
  });
});

describe('fingerprint', () => {
  const fp = (over: Partial<MonthFocusInput> = {}) => resolveMonthFocus(input(over)).fingerprint;
  it('is stable under input order', () => {
    const base = input();
    const reversed = input({
      roster: new Map([...base.roster.entries()].reverse()),
      targets: new Map([...base.targets.entries()].reverse()),
      defs: [...base.defs].reverse(),
    });
    expect(resolveMonthFocus(reversed).fingerprint).toBe(fp());
  });
  it('changes when a name changes', () => {
    const t = new Map(input().targets);
    t.set('W2', tr({ [FB]: 100 }, { [FB]: 'ADHO300' }));
    expect(fp({ targets: t })).not.toBe(fp());
  });
  it('does not change for a different spelling of the same name', () => {
    const t = new Map(input().targets);
    t.set('R2', tr({ [FB]: 800 }, { [FB]: 'ADHO 500, cno' }));
    expect(fp({ targets: t })).toBe(fp());
  });
  it('changes when an acceptance is used', () => {
    const t = new Map(input().targets);
    t.set('W2', tr({ [FB]: 100 }, { [FB]: 'NEW' }));
    const a = fp({ targets: t });
    const b = fp({ targets: t, acceptances: new Map([[`${FB}|NEW`, { byName: 'x', at: 'y' }]]) });
    expect(a).not.toBe(b);
    // an unused acceptance does not change it
    expect(fp({ acceptances: new Map([[`${FB}|ZZZ`, { byName: 'x', at: 'y' }]]) })).toBe(fp());
  });
  it('changes when the catalogue resolution changes', () => {
    const c2 = buildFocusCatalogue(DIMS, [...NOV_COMBOS, { brand: 'CNO', skuGroup: '' }, { brand: 'C', skuGroup: 'NO' }]);
    expect(fp({ catalogue: c2 })).not.toBe(fp()); // CNO now AMBIGUOUS
  });
  it('changes when a missing name appears', () => {
    const t = new Map(input().targets);
    t.set('R2', tr({ [FB]: 800 }));
    expect(fp({ targets: t })).not.toBe(fp());
  });
  it('changes with the month', () => {
    expect(fp({ month: '2026-12' })).not.toBe(fp());
  });
});

describe('attachOutletFilters', () => {
  it('FILTER defs keep identity; TARGET_NAMES defs get outletFilter from the resolution', () => {
    const inp = input();
    const res = resolveMonthFocus(inp);
    const out = attachOutletFilters(inp.defs, res);
    expect(out[0]).toBe(totalDef);
    expect(out[1]).not.toBe(inp.defs[1]);
    expect(out[1].outletFilter!('W1')).toEqual({ anyOf: [{ brand: 'ADHO', skuGroup: '50' }] });
    expect(out[2].outletFilter!('R1')).toBeUndefined();
    expect(inp.defs[1].outletFilter).toBeUndefined();
  });
});

describe('end to end with computeMonthRows + buildMonthReconciliation (November shape)', () => {
  let id = 0;
  const line = (code: string, brand: string, skuGroup: string, amountPaise: bigint, qtyPico = 1_000_000_000_000n): AggRow => {
    const dims = { brand, skuGroup };
    return { id: BigInt(++id), month: '2026-11', outletCode: code, dims, dimKey: JSON.stringify(dims), amountPaise, qtyPico, lines: 1 };
  };
  const pager = (rows: AggRow[]) => async (onPage: (r: AggRow[]) => void | Promise<void>) => {
    await onPage(rows);
  };

  it('two outlets with different names get different values from the same lines; reconciliation fills achieved / gaps / targets', async () => {
    const roster = new Map<string, RosterOutlet>([
      ['R1', ro('Retail 1', 'SSS')],
      ['R2', ro('Retail 2', 'SSS')],
      ['W1', ro('Whole 1', 'WS')],
      ['W2', ro('Whole 2', 'WS')],
      ['X1', ro('No target', 'WS')],
    ]);
    const inp = input({ roster });
    const res = resolveMonthFocus(inp);
    const defs = attachOutletFilters(inp.defs, res);
    const same = (code: string) => [
      line(code, 'CNO', '50', 10000n),
      line(code, 'ADHO', '500', 20000n),
      line(code, 'ADHO', '50', 40000n),
      line(code, 'CNO ENRICH', '300', 80000n),
    ];
    // R2 has no sales; X1 sells without any target row
    const comp = await computeMonthRows(pager([...same('R1'), ...same('W1'), ...same('W2'), line('X1', 'ADHO', '50', 100n)]), defs, roster);
    const v = Object.fromEntries(comp.rows.map((r) => [r.outletCode, r.values]));
    expect(v.R1).toEqual({ TOTAL: 1500, [FB]: 300 }); // CNO + ADHO500; FB2 omitted
    expect(v.R2).toEqual({ TOTAL: 0, [FB]: 0 });
    expect(v.W1).toEqual({ TOTAL: 1500, [FB]: 400, [FB2]: 200 });
    expect(v.X1).toEqual({ TOTAL: 1 }); // no names → both focus keys omitted
    const st = Object.fromEntries(comp.stats.map((s) => [s.kpiCode, s]));
    expect(st[FB].total).toBe(1100);
    expect(st[FB2]).toMatchObject({ total: 400, outletsNonZero: 2 });
    expect([...comp.matchedOutletCodes].sort()).toEqual(['R1', 'W1', 'W2', 'X1']);

    const rec = buildMonthReconciliation({
      input: inp,
      resolution: res,
      comp,
      targetUploadedAt: new Date('2026-11-07T10:00:00.000Z'),
      ownedKpiCodes: ['TOTAL', FB, FB2],
    });
    expect(rec.targets).toEqual({
      kpis: [
        { kpiCode: 'TOTAL', label: 'Total', outletsWithTarget: 1, totalTarget: 5000, measure: 'AMOUNT' },
        { kpiCode: FB, label: 'Focus Brand 1', outletsWithTarget: 4, totalTarget: 2000, measure: 'AMOUNT' },
        { kpiCode: FB2, label: 'Focus Brand 2', outletsWithTarget: 2, totalTarget: 400, measure: 'AMOUNT' },
      ],
      targetUploadedAt: '2026-11-07T10:00:00.000Z',
      newerThanLastApply: false,
    });
    const fb = rec.focus.find((f) => f.kpiCode === FB)!;
    expect(fb.names.find((n) => n.key === 'ADHO500&CNO')!.achieved).toEqual({ total: 300, outletsZero: 1 });
    expect(fb.names.find((n) => n.key === 'ADHO50')!.achieved).toEqual({ total: 800, outletsZero: 0 });
    expect(res.focus[0].names[0].achieved).toEqual({ total: 0, outletsZero: 0 }); // resolution not mutated
    expect(rec.gaps).toEqual({
      targetNoSales: { outlets: 1, sampleOutletCodes: ['R2'] },
      salesNoTarget: { outlets: 1, sampleOutletCodes: ['X1'] },
    });
    expect(rec.blockers).toEqual([]);
    expect(rec.focusFingerprint).toBe(res.fingerprint);
  });

  it('QUANTITY and PRODUCT_COUNT work per outlet too', async () => {
    const roster = new Map<string, RosterOutlet>([['R1', ro('R', 'SSS')], ['W1', ro('W', 'WS')]]);
    const inp = input({ roster, defs: [tnDef(FB, 'QUANTITY'), tnDef(FB2, 'PRODUCT_COUNT')] });
    const t = new Map(inp.targets);
    t.set('R1', tr({}, { [FB]: 'CNO & ADHO500', [FB2]: 'CNO' }));
    const res = resolveMonthFocus({ ...inp, targets: t });
    const defs = attachOutletFilters(inp.defs, res);
    const rows = (code: string) => [
      line(code, 'CNO', '50', 100n, 2_000_000_000_000n),
      line(code, 'CNO', '500', 100n, 1_000_000_000_000n),
      line(code, 'ADHO', '500', 100n, 3_000_000_000_000n),
      line(code, 'ADHO', '50', 100n, 5_000_000_000_000n),
    ];
    const comp = await computeMonthRows(pager([...rows('R1'), ...rows('W1')]), defs, roster);
    const v = Object.fromEntries(comp.rows.map((r) => [r.outletCode, r.values]));
    expect(v.R1).toEqual({ [FB]: 6, [FB2]: 2 }); // CNO 2+1 + ADHO500 3 cases; CNO → 2 products
    expect(v.W1).toEqual({ [FB]: 5, [FB2]: 1 }); // ADHO50 5 cases; ADHO500 → 1 product
  });
});

// Roster-only aggregates (2026-11-23): for a roster-only import the catalogue also takes the file's frozen product
// combos (products sold only to non-programme customers); a legacy import (processedRosterCodes NULL) does not.
describe('loadFocusCatalogue — frozen combos of a roster-only import', () => {
  const dbWith = (imp: Record<string, unknown> | null) => ({
    salesImportProfile: { findUnique: jest.fn(async () => ({ columnMapping: { dimensions: [{ key: 'brand' }, { key: 'skuGroup' }] } })) },
    $queryRaw: jest.fn(async (q: { strings: string[] }) =>
      q.strings.join('?').includes('sales_import_aggregates') ? [{ dims: { brand: 'ADHO', skuGroup: '500' } }] : []),
    salesImport: { findFirst: jest.fn(async ({ where }: { where: { id: string; clientId: string } }) => (where.clientId === 't1' ? imp : null)) },
  });
  const FROZEN = [{ dims: { brand: 'ONLY NONPROGRAMME', skuGroup: '1' }, lines: 1, amountRupees: 1, quantity: 0 }];

  it('roster-only import: aggregates ∪ frozen combos', async () => {
    const cat = await loadFocusCatalogue(dbWith({ processedRosterCodes: ['O1'], dimensionCombos: FROZEN }) as never, 't1', { importId: 'imp1' });
    expect(cat.byKey.get('ADHO')).toEqual([{ brand: 'ADHO' }]);
    expect(cat.byKey.get('ONLYNONPROGRAMME')).toEqual([{ brand: 'ONLY NONPROGRAMME' }]);
    expect(cat.size).toBe(2);
  });

  it('legacy import (processedRosterCodes NULL): the aggregates only, frozen combos NOT read in', async () => {
    const cat = await loadFocusCatalogue(dbWith({ processedRosterCodes: null, dimensionCombos: FROZEN }) as never, 't1', { importId: 'imp1' });
    expect(cat.byKey.get('ONLYNONPROGRAMME')).toBeUndefined();
    expect(cat.size).toBe(1);
  });

  it('another tenant\'s import id contributes no frozen combos', async () => {
    const cat = await loadFocusCatalogue(dbWith({ processedRosterCodes: ['O1'], dimensionCombos: FROZEN }) as never, 't2', { importId: 'imp1' });
    expect(cat.byKey.get('ONLYNONPROGRAMME')).toBeUndefined();
  });
});
