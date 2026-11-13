import { computeMonthRows, sumOwnedValues } from './month-compute';
import type { AggRow, RosterOutlet } from '../kpi/sales-import-data';

const roster = new Map<string, RosterOutlet>([
  ['O1', { id: 'i1', name: 'One', outletType: null, program: null }],
  ['O2', { id: 'i2', name: 'Two', outletType: null, program: null }],
]);
const agg = (id: number, code: string, qtyPico: bigint, amountPaise = 0n): AggRow => ({
  id: BigInt(id), month: '2026-10', outletCode: code, dims: {}, dimKey: '{}', amountPaise, qtyPico, lines: 1,
});
const pager = (rows: AggRow[]) => async (onPage: (r: AggRow[]) => void | Promise<void>) => { await onPage(rows); };
const defs = [
  { kpiCode: 'Q', measure: 'QUANTITY' as const, filter: {}, outletTypes: [], programs: [] },
  { kpiCode: 'A', measure: 'AMOUNT' as const, filter: {}, outletTypes: [], programs: [] },
];

describe('computeMonthRows — totals are the sum of the STORED per-outlet values (real-DB finding 2)', () => {
  it('two outlets of 0.0005 cases each: stored 0.001 + 0.001 → total 0.002 (not the raw 0.001); re-apply Δ = 0', async () => {
    const comp = await computeMonthRows(pager([agg(1, 'O1', 500_000_000n), agg(2, 'O2', 500_000_000n, 12345n)]), defs, roster);
    expect(comp.rows.map((r) => r.values)).toEqual([{ Q: 0.001, A: 0 }, { Q: 0.001, A: 123.45 }]);
    expect(comp.stats[0]).toMatchObject({ total: 0.002, totalRaw: 1_000_000_000n, outletsNonZero: 2 });
    expect(comp.stats[1].total).toBe(123.45);
    // what an identical re-apply compares against: the stored rows
    const current = sumOwnedValues(comp.rows.map((r) => ({ kpiValues: r.values })), ['Q', 'A']);
    expect(current).toEqual({ Q: comp.stats[0].total, A: comp.stats[1].total });
  });

  it('a value that rounds to 0.000 is not counted as non-zero / negative', async () => {
    const comp = await computeMonthRows(pager([agg(1, 'O1', -400_000_000n)]), defs, roster);
    expect(comp.stats[0]).toMatchObject({ total: 0, outletsNonZero: 0, outletsNegative: 0 });
  });
});

describe('computeMonthRows — matched / unmatched quantity rounded per outlet / per customer (audit L3)', () => {
  it('matched = Σ per-outlet 3-dp values; unmatched = Σ per-customer 3-dp values', async () => {
    const comp = await computeMonthRows(
      pager([agg(1, 'O1', 500_000_000n), agg(2, 'O2', 500_000_000n), agg(3, 'U1', 500_000_000n), agg(4, 'U2', 500_000_000n), agg(5, 'U2', 1n)]),
      defs,
      roster,
    );
    expect(comp.split.matchedQtyThousandths).toBe(2n); // 0.001 + 0.001 (raw 0.001)
    expect(comp.split.unmatchedQtyThousandths).toBe(2n);
    expect(comp.split.matchedPico).toBe(1_000_000_000n); // raw kept for reference
  });
});

describe('computeMonthRows — PRODUCT_COUNT (LINES = distinct products with net amount > 0)', () => {
  const prod = (id: number, code: string, brand: string, sku: string, amountPaise: bigint): AggRow => {
    const dims = { brand, sku };
    return { id: BigInt(id), month: '2026-10', outletCode: code, dims, dimKey: JSON.stringify(dims), amountPaise, qtyPico: 1_000_000_000_000n, lines: 1 };
  };
  const pages = (...ps: AggRow[][]) => async (onPage: (r: AggRow[]) => void | Promise<void>) => {
    for (const p of ps) await onPage(p);
  };
  const L = { kpiCode: 'L', measure: 'PRODUCT_COUNT' as const, filter: {}, outletTypes: [], programs: [] };

  it('the same outlet × product split across pages / rows nets first, then counts once; a full return cancels', async () => {
    const comp = await computeMonthRows(
      pages(
        [prod(1, 'O1', 'ADHO', '50', 500n), prod(2, 'O1', 'ADHO', '100', 300n)],
        [prod(3, 'O1', 'ADHO', '50', 200n), prod(4, 'O1', 'ADHO', '100', -300n), prod(5, 'O2', 'ALMD', '50', 0n)],
      ),
      [L],
      roster,
    );
    expect(comp.rows.map((r) => [r.outletCode, r.values])).toEqual([['O1', { L: 1 }], ['O2', { L: 0 }]]);
    expect(comp.stats[0]).toMatchObject({ total: 1, totalRaw: 1n, outletsNonZero: 1, outletsNegative: 0 });
  });

  it('file codes are mapped onto the CURRENT roster outlet before counting (stored "77.0" ← file "77"), product counted once', async () => {
    const r = new Map<string, RosterOutlet>([['77.0', { id: 'i77', name: 'Seventy-seven', outletType: null, program: null }]]);
    const comp = await computeMonthRows(
      pages([prod(1, '77', 'ADHO', '50', 500n)], [prod(2, '77', 'ADHO', '50', 100n), prod(3, '77', 'ALMD', '50', 100n)]),
      [L],
      r,
    );
    expect(comp.rows).toEqual([{ outletCode: '77.0', outletName: 'Seventy-seven', values: { L: 2 }, zeroFilled: false }]);
  });

  it('filter, scope, stats: total = Σ per-outlet counts; out-of-scope outlets omitted; in-scope with nothing → 0', async () => {
    const r = new Map<string, RosterOutlet>([
      ['W1', { id: 'w1', name: 'W1', outletType: 'WHOLESALER', program: null }],
      ['W2', { id: 'w2', name: 'W2', outletType: 'WHOLESALER', program: null }],
      ['W3', { id: 'w3', name: 'W3', outletType: 'WHOLESALER', program: null }],
      ['R1', { id: 'r1', name: 'R1', outletType: 'RETAIL', program: null }],
    ]);
    const LW = { ...L, filter: { noneOf: [{ brand: 'ALMD' }] }, outletTypes: ['WHOLESALER'] };
    const comp = await computeMonthRows(
      pages([
        prod(1, 'W1', 'ADHO', '50', 100n), prod(2, 'W1', 'ADHO', '100', 100n), prod(3, 'W1', 'ALMD', '50', 100n),
        prod(4, 'W2', 'ADHO', '50', 100n), prod(5, 'W2', 'ADHO', '50', -150n),
        prod(6, 'R1', 'ADHO', '50', 100n),
        prod(7, 'W3', 'ALMD', '50', 100n),
      ]),
      [LW],
      r,
    );
    expect(Object.fromEntries(comp.rows.map((x) => [x.outletCode, x.values]))).toEqual({ W1: { L: 2 }, W2: { L: 0 }, W3: { L: 0 } });
    expect(comp.stats[0]).toMatchObject({ total: 2, totalRaw: 2n, outletsNonZero: 1, outletsNegative: 0 });
  });

  it('mixed AMOUNT + QUANTITY + PRODUCT_COUNT: AMOUNT / QUANTITY rows and stats identical to without PRODUCT_COUNT', async () => {
    const rows = [prod(1, 'O1', 'ADHO', '50', 12345n), prod(2, 'O1', 'ADHO', '50', -12345n), prod(3, 'O2', 'ALMD', '50', 999n), prod(4, 'O2', 'ALMD', '100', -5n)];
    const base = await computeMonthRows(pages(rows), defs, roster);
    const mixed = await computeMonthRows(pages(rows), [...defs, L], roster);
    expect(mixed.rows.map((x) => ({ Q: x.values.Q, A: x.values.A }))).toEqual(base.rows.map((x) => x.values));
    expect(mixed.stats.slice(0, 2)).toEqual(base.stats);
    expect(mixed.split).toEqual(base.split);
    expect(mixed.rows.map((x) => x.values.L)).toEqual([0, 1]);
    expect(mixed.stats[2]).toMatchObject({ total: 1, outletsNegative: 0 });
  });
});
