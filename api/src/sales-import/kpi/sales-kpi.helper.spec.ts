import {
  OutletKpiAccumulator,
  computeOutletKpis,
  definitionsHash,
  entryCoveredBy,
  lineMatches,
  outletInScope,
  redundantAnyOfEntries,
  stableStringify,
  sumMeasure,
  measureToNumber,
  validateAndNormalizeFilter,
  type KpiAgg,
  type KpiDefLite,
} from './sales-kpi.helper';
import type { SalesKpiFilter, SalesKpiMeasure } from '../sales-import.contract';

const agg = (dims: Record<string, string>, amountPaise: bigint, qtyMicro: bigint, lines = 1): KpiAgg => ({
  dims,
  amountPaise,
  qtyPico: qtyMicro * 1_000_000n, // fixtures are written in micro-cases; storage is pico (×1e12)
  lines,
});
const kpi = (aggs: KpiAgg[], measure: SalesKpiMeasure, filter: SalesKpiFilter) =>
  measureToNumber(sumMeasure(aggs, { measure, filter }), measure);
const def = (kpiCode: string, measure: SalesKpiMeasure, filter: SalesKpiFilter, over: Partial<KpiDefLite> = {}): KpiDefLite => ({
  kpiCode,
  measure,
  filter,
  outletTypes: [],
  programs: [],
  ...over,
});
const ALL_META = { outletType: 'RETAIL', program: 'GOLD' };

describe('§6.2 generic examples', () => {
  const lines = [
    agg({ dimA: 'X', dimB: '500' }, 10000n, 2_000000n),
    agg({ dimA: 'Y', dimB: '500' }, 5000n, 1_500000n),
    agg({ dimA: 'Y', dimB: '200' }, 2500n, 40000n),
  ];
  it('all ₹', () => expect(kpi(lines, 'AMOUNT', {})).toBe(175));
  it('dimA = X ₹', () => expect(kpi(lines, 'AMOUNT', { anyOf: [{ dimA: 'X' }] })).toBe(100));
  it('dimA ≠ X ₹', () => expect(kpi(lines, 'AMOUNT', { noneOf: [{ dimA: 'X' }] })).toBe(75));
  it('dimA=Y & dimB=500 ₹ / cases', () => {
    expect(kpi(lines, 'AMOUNT', { anyOf: [{ dimA: 'Y', dimB: '500' }] })).toBe(50);
    expect(kpi(lines, 'QUANTITY', { anyOf: [{ dimA: 'Y', dimB: '500' }] })).toBe(1.5);
  });
  it('all cases (fractional 0.04 survives)', () => expect(kpi(lines, 'QUANTITY', {})).toBe(3.54));
  it('noneOf + anyOf combined', () =>
    expect(kpi(lines, 'AMOUNT', { anyOf: [{ dimA: 'Y' }], noneOf: [{ dimB: '200' }] })).toBe(50));
  it('case/space-insensitive filter values', () => {
    expect(lineMatches({ dimA: 'CNO ENRICH' }, { anyOf: [{ dimA: ' cno   enrich ' }] })).toBe(true);
    expect(lineMatches({ dimA: 'CNO' }, { anyOf: [{ dimA: 'CNO ENRICH' }] })).toBe(false);
  });
  it('AMOUNT Number(6000n)/100 === 60', () => expect(measureToNumber(6000n, 'AMOUNT')).toBe(60));
  it('QUANTITY 0.04 survives', () => expect(measureToNumber(40_000_000_000n, 'QUANTITY')).toBe(0.04));
  it('returns net off (negative lines)', () =>
    expect(kpi([agg({ dimA: 'X' }, 10000n, 0n), agg({ dimA: 'X' }, -4000n, 0n)], 'AMOUNT', {})).toBe(60));
  it('a missing dim on a line never equals a value', () =>
    expect(lineMatches({ dimA: 'X' }, { anyOf: [{ dimB: '500' }] })).toBe(false));
});

describe('computeOutletKpis (scope + zero-fill)', () => {
  const defs = [
    def('K_ALL', 'AMOUNT', {}),
    def('K_WS', 'QUANTITY', {}, { outletTypes: ['WHOLESALER'] }),
    def('K_GOLD', 'AMOUNT', {}, { programs: ['Gold'] }),
  ];
  it('out-of-scope outlet → key absent; in-scope → value', () => {
    const v = computeOutletKpis([agg({ dimA: 'X' }, 12345n, 1_250000n)], defs, { outletType: 'RETAIL', program: 'GOLD' });
    expect(v).toEqual({ K_ALL: 123.45, K_GOLD: 123.45 });
    expect('K_WS' in v).toBe(false);
  });
  it('in-scope with no lines → 0 (full rewrite)', () => {
    expect(computeOutletKpis([], defs, { outletType: 'wholesaler', program: null })).toEqual({ K_ALL: 0, K_WS: 0 });
  });
  it('scope compare is case/space-insensitive; null facet is out of a non-empty scope', () => {
    expect(outletInScope({ outletTypes: [' wholesaler'], programs: [] }, { outletType: 'WHOLESALER', program: null })).toBe(true);
    expect(outletInScope({ outletTypes: [], programs: ['GOLD'] }, { outletType: 'X', program: null })).toBe(false);
  });
});

describe('L4: KpiDef.outletType (the KPI\'s own type tag) scopes the KPI', () => {
  const SSS = { outletType: 'SSS', program: null };
  const WS = { outletType: 'WHOLESALER', program: null };
  const NONE = { outletType: null, program: null };
  it('KpiDef.outletType alone: only that type is in scope (others omitted, never 0); untyped outlets are out', () => {
    const d = def('K', 'AMOUNT', {}, { kpiOutletType: 'SSS' });
    expect(computeOutletKpis([agg({ dimA: 'X' }, 500n, 0n)], [d], SSS)).toEqual({ K: 5 });
    expect(computeOutletKpis([agg({ dimA: 'X' }, 500n, 0n)], [d], WS)).toEqual({});
    expect(computeOutletKpis([], [d], NONE)).toEqual({});
    expect(outletInScope(d, { outletType: ' sss ', program: null })).toBe(true); // case/space-insensitive
  });
  it('null / blank KpiDef.outletType = shared KPI (every type, unchanged behaviour)', () => {
    for (const k of [null, undefined, '', '  ']) {
      expect(outletInScope(def('K', 'AMOUNT', {}, { kpiOutletType: k }), WS)).toBe(true);
      expect(outletInScope(def('K', 'AMOUNT', {}, { kpiOutletType: k }), NONE)).toBe(true);
    }
  });
  it('both set → intersection; a disjoint pair puts NO outlet in scope', () => {
    const both = def('K', 'AMOUNT', {}, { kpiOutletType: 'SSS', outletTypes: ['SSS', 'WHOLESALER'] });
    expect(outletInScope(both, SSS)).toBe(true);
    expect(outletInScope(both, WS)).toBe(false);
    const disjoint = def('K', 'AMOUNT', {}, { kpiOutletType: 'SSS', outletTypes: ['WHOLESALER'] });
    expect(outletInScope(disjoint, SSS)).toBe(false);
    expect(outletInScope(disjoint, WS)).toBe(false);
  });
  it('the accumulator applies the same scope', () => {
    const d = def('K', 'AMOUNT', {}, { kpiOutletType: 'SSS' });
    const acc = new OutletKpiAccumulator([d]);
    acc.add('O1', agg({ dimA: 'X' }, 700n, 0n));
    expect(acc.valuesFor('O1', SSS)).toEqual({ K: 7 });
    expect(acc.valuesFor('O1', WS)).toEqual({});
  });
});

describe('§6.2a multi-combination (focus SKU set) KPIs', () => {
  const aggs = [
    agg({ dimA: 'P', dimB: '500' }, 10000n, 1_000000n), agg({ dimA: 'P', dimB: '200' }, 4000n, 500000n),
    agg({ dimA: 'P', dimB: '150' }, 2500n, 250000n), agg({ dimA: 'P', dimB: '50' }, 999n, 90000n),
    agg({ dimA: 'Q', dimB: '500' }, 7000n, 700000n), agg({ dimA: 'Q', dimB: '50' }, 300n, 30000n),
  ];
  const SET = { anyOf: [{ dimA: 'P', dimB: '500' }, { dimA: 'P', dimB: '200' }, { dimA: 'P', dimB: '150' }] };
  it('sums ₹ across a 3-combo set', () => expect(kpi(aggs, 'AMOUNT', SET)).toBe(165));
  it('sums cases across the same set', () => expect(kpi(aggs, 'QUANTITY', SET)).toBe(1.75));
  it('mixes a whole-brand entry with combos across brands', () =>
    expect(kpi(aggs, 'AMOUNT', { anyOf: [{ dimA: 'Q' }, { dimA: 'P', dimB: '500' }] })).toBe(173));
  it('counts a line matching TWO entries once (overlap)', () =>
    expect(kpi(aggs, 'AMOUNT', { anyOf: [{ dimA: 'P', dimB: '500' }, { dimA: 'P' }] })).toBe(174.99));
  it('exclusion inside a whole brand', () =>
    expect(kpi(aggs, 'AMOUNT', { anyOf: [{ dimA: 'P' }], noneOf: [{ dimA: 'P', dimB: '50' }] })).toBe(165));
  it('not-equal brand = noneOf only', () => expect(kpi(aggs, 'AMOUNT', { noneOf: [{ dimA: 'P' }] })).toBe(73));
  it('entry order and duplicates do not change the result', () => {
    const shuffled = { anyOf: [SET.anyOf[2], SET.anyOf[0], SET.anyOf[1], SET.anyOf[0]] };
    expect(kpi(aggs, 'AMOUNT', shuffled)).toBe(165);
  });
  it('normalizes entry values (" p ", "500.0" via a number)', () => {
    expect(kpi(aggs, 'AMOUNT', { anyOf: [{ dimA: ' p ', dimB: 500.0 as unknown as string }] })).toBe(100);
    const v = validateAndNormalizeFilter({ anyOf: [{ dimA: ' p ', dimB: 500.0 }] }, ['dimA', 'dimB']);
    expect(v.errors).toEqual([]);
    expect(v.filter).toEqual({ anyOf: [{ dimA: 'P', dimB: '500' }] });
  });
  it('reports covered entries as redundantEntries', () => {
    expect(redundantAnyOfEntries([{ dimA: 'P', dimB: '500' }, { dimA: 'P' }, { dimA: 'Q', dimB: '50' }])).toEqual([0]);
    expect(redundantAnyOfEntries([{ dimA: 'P' }, { dimA: 'p' }])).toEqual([1]); // identical → the later one
    expect(entryCoveredBy({ dimA: 'P' }, { dimA: 'P', dimB: '500' })).toBe(false);
  });
  it('rejects an empty entry {} in anyOf and > 200 entries; unknown dim keys block', () => {
    expect(validateAndNormalizeFilter({ anyOf: [{}] }, ['dimA']).errors[0]).toMatch(/empty/);
    expect(validateAndNormalizeFilter({ noneOf: [{}] }, ['dimA']).errors[0]).toMatch(/empty/);
    const many = Array.from({ length: 201 }, (_, i) => ({ dimA: `V${i}` }));
    expect(validateAndNormalizeFilter({ anyOf: many }, ['dimA']).errors[0]).toMatch(/maximum is 200/);
    expect(validateAndNormalizeFilter({ anyOf: [{ brand: 'X' }] }, ['dimA']).errors[0]).toMatch(/unknown dimension "brand"/);
    expect(validateAndNormalizeFilter({ anyOf: [{ dimA: '  ' }] }, ['dimA']).errors[0]).toMatch(/blank/);
    expect(validateAndNormalizeFilter({ anyOf: 'x' }, ['dimA']).errors[0]).toMatch(/list/);
    expect(validateAndNormalizeFilter({ allOf: [] }, ['dimA']).errors[0]).toMatch(/unknown field/);
  });
  it('de-duplicates exact duplicates with a note', () => {
    const v = validateAndNormalizeFilter({ anyOf: [{ dimA: 'P' }, { dimA: ' p' }] }, ['dimA']);
    expect(v.filter).toEqual({ anyOf: [{ dimA: 'P' }] });
    expect(v.notes).toHaveLength(1);
  });
  it('{} / null filter = all lines', () => {
    expect(validateAndNormalizeFilter({}, []).filter).toEqual({});
    expect(validateAndNormalizeFilter(null, []).filter).toEqual({});
  });
});

describe('OutletKpiAccumulator ≡ computeOutletKpis', () => {
  it('matches the pure function per outlet and counts matched lines once', () => {
    const defs = [def('A', 'AMOUNT', { anyOf: [{ dimA: 'P' }, { dimA: 'P', dimB: '500' }] }), def('B', 'QUANTITY', {})];
    const o1 = [agg({ dimA: 'P', dimB: '500' }, 100n, 1n, 3), agg({ dimA: 'Q', dimB: '500' }, 50n, 2n, 2)];
    const acc = new OutletKpiAccumulator(defs);
    for (const a of o1) acc.add('O1', a);
    expect(acc.valuesFor('O1', ALL_META)).toEqual(computeOutletKpis(o1, defs, ALL_META));
    expect(acc.valuesFor('O2', ALL_META)).toEqual({ A: 0, B: 0 });
    expect(acc.hasLines('O1')).toBe(true);
    expect(acc.hasLines('O2')).toBe(false);
    expect(acc.matchedLines).toBe(5);
  });
});

describe('hashes', () => {
  it('definitionsHash is id/order-free, sorted by kpiCode, ignores disabled', () => {
    const a = def('A', 'AMOUNT', { anyOf: [{ dimA: 'P' }] });
    const b = def('B', 'QUANTITY', {}, { outletTypes: ['Y', 'X'] });
    const h1 = definitionsHash([a, b]);
    expect(definitionsHash([{ ...b, outletTypes: ['X', 'Y'] }, a, { ...def('C', 'AMOUNT', {}), enabled: false }])).toBe(h1);
    expect(definitionsHash([a, { ...b, measure: 'AMOUNT' }])).not.toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
  it('L4: a type-tagged KPI changes the hash; a shared KPI (null/blank kpiOutletType) hashes exactly as before', () => {
    const a = def('A', 'AMOUNT', {});
    const h = definitionsHash([a]);
    expect(definitionsHash([{ ...a, kpiOutletType: null }])).toBe(h);
    expect(definitionsHash([{ ...a, kpiOutletType: '  ' }])).toBe(h);
    expect(definitionsHash([{ ...a, kpiOutletType: 'SSS' }])).not.toBe(h);
    expect(definitionsHash([{ ...a, kpiOutletType: 'sss' }])).toBe(definitionsHash([{ ...a, kpiOutletType: 'SSS' }]));
  });
  it('stableStringify sorts keys recursively', () =>
    expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}'));
});

describe('audit fix round', () => {
  it('H3: 12 × (1/12 case as an Excel float) sums EXACTLY and stores 1.000 (no per-line 1e-6 loss)', () => {
    // toPico keeps 12 decimals of 0.08333333333333333; 12 lines → 0.999999999996 → rounded once to 3 dp.
    const { toPico } = jest.requireActual('../ingest/normalize') as typeof import('../ingest/normalize');
    const twelfth = toPico(1 / 12)!;
    expect(twelfth).toBe(83_333_333_333n);
    const lines = Array.from({ length: 12 }, () => ({ dims: {}, amountPaise: 0n, qtyPico: twelfth, lines: 1 }));
    expect(kpi(lines, 'QUANTITY', {})).toBe(1);
    // the old micro scale lost 4e-6 here (0.083333 × 12 = 0.999996)
    expect(measureToNumber(-1_234_500_000_000n, 'QUANTITY')).toBe(-1.235); // half away from zero
  });

  it("blank values: '' is a valid exact 'column is empty' match; a fully blank entry or a non-text blank is rejected", () => {
    const ok = validateAndNormalizeFilter({ anyOf: [{ dimA: 'P', dimB: '' }], noneOf: [{ dimA: 'Q', dimB: '  ' }] }, ['dimA', 'dimB']);
    expect(ok.errors).toEqual([]);
    expect(ok.filter).toEqual({ anyOf: [{ dimA: 'P', dimB: '' }], noneOf: [{ dimA: 'Q', dimB: '' }] });
    expect(lineMatches({ dimA: 'P', dimB: '' }, ok.filter)).toBe(true);
    expect(lineMatches({ dimA: 'P', dimB: '500' }, ok.filter)).toBe(false);
    expect(validateAndNormalizeFilter({ anyOf: [{ dimA: '', dimB: '' }] }, ['dimA', 'dimB']).errors[0]).toMatch(/blank/);
    expect(validateAndNormalizeFilter({ anyOf: [{ dimA: NaN }] }, ['dimA']).errors[0]).toMatch(/not a valid value/);
    expect(validateAndNormalizeFilter({ anyOf: [{ dimA: null }] }, ['dimA']).errors[0]).toMatch(/text or number/);
  });

  it('M4: accumulators sharing one match cache evaluate each distinct combo once', () => {
    const cache = new Map<string, boolean[]>();
    const defs = [def('K', 'AMOUNT', { anyOf: [{ dimA: 'P' }] })];
    const a = new OutletKpiAccumulator(defs, cache);
    const b = new OutletKpiAccumulator(defs, cache);
    a.add('O1', agg({ dimA: 'P' }, 100n, 0n), 'k1');
    b.add('O2', agg({ dimA: 'P' }, 200n, 0n), 'k1');
    a.add('O1', agg({ dimA: 'Q' }, 300n, 0n), 'k2');
    expect(cache.size).toBe(2);
    expect(a.rawSum('O1', 0)).toBe(100n);
    expect(b.rawSum('O2', 0)).toBe(200n);
  });
});
