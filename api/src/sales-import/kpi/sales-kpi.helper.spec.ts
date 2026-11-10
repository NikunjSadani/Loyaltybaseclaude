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
  qtyMicro,
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
  it('QUANTITY 0.04 survives', () => expect(measureToNumber(40000n, 'QUANTITY')).toBe(0.04));
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
  it('stableStringify sorts keys recursively', () =>
    expect(stableStringify({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}'));
});
