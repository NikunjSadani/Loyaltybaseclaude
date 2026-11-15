import { createHash } from 'node:crypto';
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

describe('PRODUCT_COUNT (LINES = distinct products with net amount > 0, owner 2026-11-13)', () => {
  const P = (brand: string, sku: string, paise: bigint) => agg({ brand, sku }, paise, 1n);
  const count = (aggs: KpiAgg[], filter: SalesKpiFilter = {}) => kpi(aggs, 'PRODUCT_COUNT', filter);
  /** Feeds the same aggregates through the streaming accumulator (with dimKeys) and returns the outlet's value. */
  const streamed = (aggs: KpiAgg[], filter: SalesKpiFilter = {}) => {
    const acc = new OutletKpiAccumulator([def('L', 'PRODUCT_COUNT', filter)]);
    for (const a of aggs) acc.add('O1', a, stableStringify(a.dims));
    return acc.valuesFor('O1', ALL_META).L;
  };
  const both = (aggs: KpiAgg[], filter: SalesKpiFilter = {}) => {
    const v = count(aggs, filter);
    expect(streamed(aggs, filter)).toBe(v); // non-streaming ≡ streaming
    return v;
  };

  it('counts each distinct product once even when it arrives in several rows', () =>
    expect(both([P('ADHO', '50', 1000n), P('ADHO', '50', 2000n), P('ADHO', '100', 500n), P('ALMD', '50', 700n)])).toBe(3));
  it('net basis: +500 then −500 for the same product → not counted', () =>
    expect(both([P('ADHO', '50', 500n), P('ADHO', '50', -500n)])).toBe(0));
  it('net basis: +500 then −200 → counted', () => expect(both([P('ADHO', '50', 500n), P('ADHO', '50', -200n)])).toBe(1));
  it('a return arriving BEFORE the purchase nets the same way (order-independent)', () =>
    expect(both([P('ADHO', '50', -500n), P('ADHO', '50', 500n), P('ALMD', '50', -100n), P('ALMD', '50', 300n)])).toBe(1));
  it('only zero-amount (free) rows → not counted', () => expect(both([P('ADHO', '50', 0n), P('ADHO', '50', 0n)])).toBe(0));
  it('negative-only → not counted (never negative)', () => expect(both([P('ADHO', '50', -900n)])).toBe(0));
  it('anyOf filter respected: a non-matching brand is not counted', () =>
    expect(both([P('ADHO', '50', 100n), P('ADHO', '100', 100n), P('ALMD', '50', 100n)], { anyOf: [{ brand: 'ADHO' }] })).toBe(2));
  it('noneOf respected', () =>
    expect(both([P('ADHO', '50', 100n), P('ADHO', '100', 100n), P('ALMD', '50', 100n)], { noneOf: [{ brand: 'ADHO', sku: '100' }] })).toBe(2));
  it('a product matching two anyOf entries still counts once', () =>
    expect(both([P('ADHO', '50', 100n)], { anyOf: [{ brand: 'ADHO' }, { brand: 'ADHO', sku: '50' }] })).toBe(1));
  it('the value is a plain integer (no /100, no /1000)', () => {
    expect(measureToNumber(7n, 'PRODUCT_COUNT')).toBe(7);
    expect(computeOutletKpis([P('A', '1', 1n), P('B', '1', 1n)], [def('L', 'PRODUCT_COUNT', {})], ALL_META)).toEqual({ L: 2 });
  });
  it('outlet scope: an out-of-scope outlet is omitted; an in-scope outlet with nothing → 0', () => {
    const d = def('L', 'PRODUCT_COUNT', {}, { outletTypes: ['WHOLESALER'] });
    const acc = new OutletKpiAccumulator([d]);
    acc.add('WS', P('A', '1', 100n));
    acc.add('RT', P('A', '1', 100n));
    expect(acc.valuesFor('WS', { outletType: 'WHOLESALER', program: null })).toEqual({ L: 1 });
    expect(acc.valuesFor('RT', { outletType: 'RETAIL', program: null })).toEqual({});
    expect(acc.valuesFor('EMPTY', { outletType: 'WHOLESALER', program: null })).toEqual({ L: 0 });
  });
  it('per definition: two PRODUCT_COUNT defs with different filters share the per-outlet net map but count separately', () => {
    const defs = [def('L_ALL', 'PRODUCT_COUNT', {}), def('L_ADHO', 'PRODUCT_COUNT', { anyOf: [{ brand: 'ADHO' }] })];
    const acc = new OutletKpiAccumulator(defs);
    for (const a of [P('ADHO', '50', 100n), P('ALMD', '50', 100n), P('ADHO', '100', 100n), P('ADHO', '100', -100n)]) acc.add('O1', a);
    expect(acc.valuesFor('O1', ALL_META)).toEqual({ L_ALL: 2, L_ADHO: 1 });
  });
  it('mixing AMOUNT + QUANTITY + PRODUCT_COUNT leaves AMOUNT / QUANTITY identical to without it', () => {
    const aggs = [P('ADHO', '50', 1000n), P('ADHO', '50', -1000n), P('ALMD', '50', 250n), agg({ brand: 'X', sku: '1' }, 0n, 3n)];
    const base = [def('A', 'AMOUNT', { anyOf: [{ brand: 'ADHO' }] }), def('Q', 'QUANTITY', {})];
    const mixed = [...base, def('L', 'PRODUCT_COUNT', {})];
    const accBase = new OutletKpiAccumulator(base);
    const accMixed = new OutletKpiAccumulator(mixed);
    for (const a of aggs) {
      accBase.add('O1', a);
      accMixed.add('O1', a);
    }
    const vBase = accBase.valuesFor('O1', ALL_META);
    const vMixed = accMixed.valuesFor('O1', ALL_META);
    expect({ A: vMixed.A, Q: vMixed.Q }).toEqual(vBase);
    expect(accMixed.rawSum('O1', 0)).toBe(accBase.rawSum('O1', 0));
    expect(accMixed.rawSum('O1', 1)).toBe(accBase.rawSum('O1', 1));
    expect(vMixed.L).toBe(1); // ADHO|50 netted to 0, ALMD|50 > 0, X|1 zero-value
    expect(accMixed.matchedLines).toBe(accBase.matchedLines);
    expect(computeOutletKpis(aggs, mixed, ALL_META)).toEqual(vMixed);
  });
  it('definitionsHash differs between QUANTITY and PRODUCT_COUNT for the same filter', () => {
    const q = def('K', 'QUANTITY', { anyOf: [{ brand: 'ADHO' }] });
    expect(definitionsHash([{ ...q, measure: 'PRODUCT_COUNT' }])).not.toBe(definitionsHash([q]));
  });
  it('existing AMOUNT / QUANTITY hashes are unchanged by the new measure (pinned)', () => {
    // Computed before PRODUCT_COUNT existed: the canonical JSON of a definition does not depend on the measure list.
    const a = def('A', 'AMOUNT', {});
    expect(definitionsHash([a])).toBe(
      createHash('sha256')
        .update('[{"filter":{},"kpiCode":"A","measure":"AMOUNT","outletTypes":[],"programs":[]}]').digest('hex'),
    );
  });
});

describe('FOCUS-FROM-TARGETS: per-outlet filters (outletFilter)', () => {
  const P = (brand: string, sku: string, amountPaise: bigint, qtyMicro = 1_000000n): KpiAgg => agg({ brand, sku }, amountPaise, qtyMicro);
  const lines = [P('CNO', '50', 1000n, 2_000000n), P('ADHO', '500', 2000n, 3_000000n), P('ADHO', '50', 4000n, 5_000000n)];
  const byOutlet: Record<string, SalesKpiFilter | undefined> = {
    R1: { anyOf: [{ brand: 'CNO' }, { brand: 'ADHO', sku: '500' }] },
    W1: { anyOf: [{ brand: 'ADHO', sku: '50' }] },
    N1: undefined,
  };
  const perOutlet = (code: string, measure: SalesKpiMeasure): KpiDefLite =>
    def(code, measure, {}, { productSource: 'TARGET_NAMES', outletFilter: (o) => byOutlet[o] });

  it.each<[SalesKpiMeasure, Record<string, number>, Record<string, number>]>([
    ['AMOUNT', { F: 30 }, { F: 40 }],
    ['QUANTITY', { F: 5 }, { F: 5 }],
    ['PRODUCT_COUNT', { F: 2 }, { F: 1 }],
  ])('%s: two outlets with different names get different values from the same lines; undefined → key omitted', (m, r1, w1) => {
    const d = perOutlet('F', m);
    const acc = new OutletKpiAccumulator([d]);
    for (const o of ['R1', 'W1', 'N1']) for (const a of lines) acc.add(o, a);
    expect(acc.valuesFor('R1', ALL_META)).toEqual(r1);
    expect(acc.valuesFor('W1', ALL_META)).toEqual(w1);
    expect(acc.valuesFor('N1', ALL_META)).toEqual({});
    expect(acc.keyOmitted('N1', 0)).toBe(true);
    expect(acc.keyOmitted('R1', 0)).toBe(false);
    expect(acc.valuesFor('NOLINES', ALL_META)).toEqual({}); // undefined filter, no lines
    // computeOutletKpis agrees
    expect(computeOutletKpis(lines, [d], ALL_META, 'R1')).toEqual(r1);
    expect(computeOutletKpis(lines, [d], ALL_META, 'W1')).toEqual(w1);
    expect(computeOutletKpis(lines, [d], ALL_META, 'N1')).toEqual({});
  });

  it('computeOutletKpis requires the outlet code for a per-outlet definition', () => {
    expect(() => computeOutletKpis(lines, [perOutlet('F', 'AMOUNT')], ALL_META)).toThrow(/outlet code is required/);
  });

  it('scope still wins (out of scope → omitted even with a filter)', () => {
    const d = def('F', 'AMOUNT', {}, { outletTypes: ['WS'], outletFilter: (o) => byOutlet[o] });
    const acc = new OutletKpiAccumulator([d]);
    acc.add('W1', lines[2]);
    expect(acc.valuesFor('W1', { outletType: 'RETAIL', program: null })).toEqual({});
    expect(acc.valuesFor('W1', { outletType: 'WS', program: null })).toEqual({ F: 40 });
  });

  it('mixed FILTER + per-outlet defs leave FILTER values identical', () => {
    const base = [def('A', 'AMOUNT', { anyOf: [{ brand: 'ADHO' }] }), def('L', 'PRODUCT_COUNT', {}), def('Q', 'QUANTITY', {})];
    const mixed = [base[0], perOutlet('F', 'PRODUCT_COUNT'), base[1], perOutlet('G', 'AMOUNT'), base[2]];
    const accBase = new OutletKpiAccumulator(base);
    const accMixed = new OutletKpiAccumulator(mixed);
    for (const o of ['R1', 'W1', 'N1']) {
      for (const a of lines) {
        accBase.add(o, a);
        accMixed.add(o, a);
      }
    }
    for (const o of ['R1', 'W1', 'N1']) {
      const vb = accBase.valuesFor(o, ALL_META);
      const vm = accMixed.valuesFor(o, ALL_META);
      expect({ A: vm.A, L: vm.L, Q: vm.Q }).toEqual(vb);
    }
    expect(accMixed.valuesFor('R1', ALL_META)).toMatchObject({ F: 2, G: 30 });
    expect(accMixed.valuesFor('N1', ALL_META)).not.toHaveProperty('F');
    expect(accMixed.matchedLines).toBe(accBase.matchedLines); // every line matches Q {} in both
  });

  it('a shared match cache keeps the per-outlet slot false (valid across months with other names)', () => {
    const mixed = [def('A', 'AMOUNT', {}), perOutlet('F', 'AMOUNT')];
    const cache = new Map<string, boolean[]>();
    const nov = new OutletKpiAccumulator(mixed, cache);
    nov.add('R1', lines[0]);
    expect([...cache.values()][0]).toEqual([true, false]);
    const dec = new OutletKpiAccumulator([mixed[0], def('F', 'AMOUNT', {}, { outletFilter: () => ({ anyOf: [{ brand: 'ADHO' }] }) })], cache);
    dec.add('R1', lines[0]);
    dec.add('R1', lines[1]);
    expect(nov.valuesFor('R1', ALL_META)).toEqual({ A: 10, F: 10 });
    expect(dec.valuesFor('R1', ALL_META)).toEqual({ A: 30, F: 20 });
  });

  it('outletFilter is called once per outlet, not per line', () => {
    let calls = 0;
    const d = def('F', 'AMOUNT', {}, {
      outletFilter: (o) => {
        calls++;
        return byOutlet[o];
      },
    });
    const acc = new OutletKpiAccumulator([d]);
    for (let i = 0; i < 50; i++) for (const a of lines) acc.add('R1', a);
    expect(acc.valuesFor('R1', ALL_META)).toEqual({ F: 1500 });
    expect(calls).toBe(1);
  });

  it('definitionsHash: productSource hashed only when TARGET_NAMES; a FILTER hash is pinned', () => {
    const f = def('FB', 'QUANTITY', { anyOf: [{ brand: 'ADHO', sku: '500' }] }, { outletTypes: ['WS'], programs: ['GOLD'] });
    const pinned = createHash('sha256')
      .update(
        '[{"filter":{"anyOf":[{"brand":"ADHO","sku":"500"}]},"kpiCode":"FB","measure":"QUANTITY","outletTypes":["WS"],"programs":["GOLD"]}]',
      )
      .digest('hex');
    expect(definitionsHash([f])).toBe(pinned);
    expect(definitionsHash([{ ...f, productSource: 'FILTER' }])).toBe(pinned);
    const tn = { ...f, filter: {}, productSource: 'TARGET_NAMES' as const };
    expect(definitionsHash([tn])).not.toBe(definitionsHash([{ ...f, filter: {} }]));
    expect(definitionsHash([tn])).toBe(
      createHash('sha256')
        .update('[{"filter":{},"kpiCode":"FB","measure":"QUANTITY","outletTypes":["WS"],"productSource":"TARGET_NAMES","programs":["GOLD"]}]')
        .digest('hex'),
    );
    // outletFilter (a function) never affects the hash
    expect(definitionsHash([{ ...tn, outletFilter: () => undefined }])).toBe(definitionsHash([tn]));
  });
});
