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
