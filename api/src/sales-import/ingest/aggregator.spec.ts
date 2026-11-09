import type { SalesColumnMapping } from '../sales-import.contract';
import { SALES_IMPORT_MAX_DIMENSION_COMBOS, SALES_IMPORT_MAX_DIMENSION_VALUES, SALES_IMPORT_MAX_ERROR_SAMPLES } from '../sales-import.contract';
import { SalesAggregator } from './aggregator';
import type { ColumnIndex } from './header';

// Synthetic, neutral fixtures (plan G3): outlets O1/O2, dims dimA/dimB, round numbers.
const MAP: SalesColumnMapping = {
  sheetName: null,
  headerRow: 'auto',
  outletCode: 'Code',
  outletName: 'Name',
  invoiceDate: 'Date',
  amount: 'Amt',
  quantity: 'Qty',
  dimensions: [
    { key: 'dimA', label: 'A', header: 'A' },
    { key: 'dimB', label: 'B', header: 'B' },
  ],
  dateOrder: 'YMD',
};
// Cells: [code, name, date, dimA, dimB, amount, qty]
const IDX: ColumnIndex = { outletCode: 0, outletName: 1, invoiceDate: 2, amount: 5, quantity: 6, dims: { dimA: 3, dimB: 4 } };
const TODAY = '2026-11-09';
const roster = (codes: string[]) => new Map(codes.map((c) => [c, c]));
const row = (code: unknown, date: unknown, a: unknown, b: unknown, amt: unknown, qty: unknown, name: unknown = 'Name') => [code, name, date, a, b, amt, qty];
const KEY_X500 = '{"dimA":"X","dimB":"500"}';

describe('SalesAggregator', () => {
  it('nets returns within a month and splits by invoice month', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-03', 'X', '500', '100.00', '1.5'), 3);
    a.push(row('O1', '2026-10-20', 'x ', 500, '-40.00', '-0.5'), 4);
    a.push(row('O1', '2026-11-01', 'X', '500', '10.00', '0.04'), 5);
    const r = a.result();
    expect(r.get('2026-10', 'O1', KEY_X500)).toEqual({ amountPaise: 6000n, qtyMicro: 1_000_000n, lines: 2 });
    expect(r.get('2026-11', 'O1', KEY_X500)).toEqual({ amountPaise: 1000n, qtyMicro: 40_000n, lines: 1 });
    expect(r.monthSummaries.map((m) => [m.month, m.firstDate, m.lastDate, m.lines])).toEqual([
      ['2026-10', '2026-10-03', '2026-10-20', 2],
      ['2026-11', '2026-11-01', '2026-11-01', 1],
    ]);
    expect(r.monthSummaries[0]).toMatchObject({ matchedOutlets: 1, matchedAmountRupees: 60, matchedQuantity: 1 });
    expect(r.aggregateCount).toBe(2);
    expect([...r.aggregates()]).toEqual([
      { month: '2026-10', outletCode: 'O1', dims: { dimA: 'X', dimB: '500' }, dimKey: KEY_X500, amountPaise: 6000n, qtyMicro: 1_000_000n, lines: 2 },
      { month: '2026-11', outletCode: 'O1', dims: { dimA: 'X', dimB: '500' }, dimKey: KEY_X500, amountPaise: 1000n, qtyMicro: 40_000n, lines: 1 },
    ]);
  });

  it('keeps distinct dim combos apart and matches numeric codes from xlsx against the roster', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['327852']), TODAY);
    a.push(row(327852, '2026-10-03', 'X', 500, 10, 1), 3);
    a.push(row('327852', '2026-10-04', 'X', 200, 20, 2), 4);
    const r = a.result();
    expect(r.get('2026-10', '327852', KEY_X500)).toEqual({ amountPaise: 1000n, qtyMicro: 1_000_000n, lines: 1 });
    expect(r.get('2026-10', '327852', '{"dimA":"X","dimB":"200"}')).toEqual({ amountPaise: 2000n, qtyMicro: 2_000_000n, lines: 1 });
  });

  it("aggregates under the roster's own outlet code (normalized match)", () => {
    const a = new SalesAggregator(MAP, IDX, new Map([['00123', ' 00123 ']]), TODAY);
    a.push(row('00123', '2026-10-03', 'X', 500, 10, 1), 3);
    expect(a.result().get('2026-10', ' 00123 ', KEY_X500)).toEqual({ amountPaise: 1000n, qtyMicro: 1_000_000n, lines: 1 });
  });

  it('counts unmatched customers per month without aggregating them', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-03', 'X', '500', '100', '1'), 3);
    a.push(row('U9', '2026-10-03', 'X', '500', '7.50', '0.5', ''), 4);
    a.push(row('U9', '2026-10-05', 'Y', '500', '2.50', '0.5', 'Late Name'), 5);
    a.push(row('U8', '2026-11-01', 'X', '500', '1', '1'), 6);
    const r = a.result();
    expect(r.aggregateCount).toBe(1);
    expect(r.monthSummaries[0]).toMatchObject({ lines: 3, matchedOutlets: 1, unmatchedCustomers: 1, unmatchedAmountRupees: 10, unmatchedQuantity: 1 });
    expect(r.monthSummaries[1]).toMatchObject({ unmatchedCustomers: 1, matchedOutlets: 0 });
    expect([...r.unmatched()]).toEqual([
      { month: '2026-10', code: 'U9', name: 'Late Name', amountPaise: 1000n, qtyMicro: 1_000_000n, lines: 2 },
      { month: '2026-11', code: 'U8', name: 'Name', amountPaise: 100n, qtyMicro: 1_000_000n, lines: 1 },
    ]);
  });

  it('skips blank code / bad date / bad amount / bad qty with reasons, capped at 200 samples', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    a.push(row('', '2026-10-03', 'X', '500', '1', '1'), 3);
    a.push(row('O1', '31-02-2026', 'X', '500', '1', '1'), 4);
    a.push(row('O1', '1999-01-01', 'X', '500', '1', '1'), 5);
    a.push(row('O1', '2026-10-03', 'X', '500', 'abc', '1'), 6);
    a.push(row('O1', '2026-10-03', 'X', '500', '', '1'), 7);
    a.push(row('O1', '2026-10-03', 'X', '500', '1', 'n/a'), 8);
    a.push([null, '', '  ', null, null, null, null], 9); // fully blank: ignored, not counted
    let r = a.result();
    expect(r.rowsRead).toBe(6);
    expect(r.rowsSkipped).toBe(6);
    expect(r.errorSamples).toEqual([
      { row: 3, column: 'CODE', reason: 'blank outlet code' },
      { row: 4, column: 'DATE', reason: 'invalid date' },
      { row: 5, column: 'DATE', reason: 'date out of range' },
      { row: 6, column: 'AMT', reason: 'invalid amount' },
      { row: 7, column: 'AMT', reason: 'blank amount' },
      { row: 8, column: 'QTY', reason: 'invalid quantity' },
    ]);
    for (let i = 0; i < 500; i++) a.push(row('', '2026-10-03', 'X', '500', '1', '1'), 100 + i);
    r = a.result();
    expect(r.rowsSkipped).toBe(506);
    expect(r.errorSamples).toHaveLength(SALES_IMPORT_MAX_ERROR_SAMPLES);
    expect(r.monthSummaries).toEqual([]);
  });

  it('an unmapped amount or quantity column counts as 0', () => {
    const a = new SalesAggregator({ ...MAP, quantity: null }, { ...IDX, quantity: null }, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-03', 'X', '500', '5', 'garbage'), 3);
    expect(a.result().get('2026-10', 'O1', KEY_X500)).toEqual({ amountPaise: 500n, qtyMicro: 0n, lines: 1 });
  });

  it('no dimensions → a single "{}" bucket per outlet-month and no combos', () => {
    const a = new SalesAggregator({ ...MAP, dimensions: [] }, { ...IDX, dims: {} }, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-03', 'X', '500', '5', '1'), 3);
    a.push(row('O1', '2026-10-04', 'Y', '200', '5', '1'), 4);
    const r = a.result();
    expect(r.get('2026-10', 'O1', '{}')).toEqual({ amountPaise: 1000n, qtyMicro: 2_000_000n, lines: 2 });
    expect(r.dimensionCombos).toEqual([]);
    expect(r.dimensionValues).toEqual({});
  });

  it('dimensionValues keeps per-dim counts (top 200 by |₹|), over matched AND unmatched lines', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-03', 'P', '500', '10', '1'), 3);
    a.push(row('U1', '2026-10-03', 'P', '200', '-30', '1'), 4);
    a.push(row('O1', '2026-10-03', 'Q', '500', '20', '1'), 5);
    for (let i = 0; i < 250; i++) a.push(row('O1', '2026-10-03', `V${i}`, '1', String(i), '1'), 10 + i);
    const r = a.result();
    expect(r.dimensionValues.dimA).toHaveLength(SALES_IMPORT_MAX_DIMENSION_VALUES);
    expect(r.dimensionValues.dimA[0]).toEqual({ value: 'V249', lines: 1, amountRupees: 249 });
    expect(r.dimensionValues.dimB.slice(0, 3)).toEqual([
      { value: '1', lines: 250, amountRupees: 31125 },
      { value: '500', lines: 2, amountRupees: 30 },
      { value: '200', lines: 1, amountRupees: -30 },
    ]);
  });

  it('dimensionCombos lists every distinct full combo with lines/₹/qty (cap 2,000, sorted by |₹|)', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-03', 'P', '500', '10', '1.5'), 3);
    a.push(row('O1', '2026-10-04', 'P', '500', '5', '0.5'), 4);
    a.push(row('U1', '2026-10-04', 'P', '200', '-100', '-1'), 5);
    let r = a.result();
    expect(r.dimensionCombos).toEqual([
      { dims: { dimA: 'P', dimB: '200' }, lines: 1, amountRupees: -100, quantity: -1 },
      { dims: { dimA: 'P', dimB: '500' }, lines: 2, amountRupees: 15, quantity: 2 },
    ]);
    for (let i = 0; i < 2100; i++) a.push(row('O1', '2026-10-03', `C${i}`, '1', '1', '1'), 10 + i);
    r = a.result();
    expect(r.dimensionCombos).toHaveLength(SALES_IMPORT_MAX_DIMENSION_COMBOS);
    expect(r.dimensionsTruncated).toBe(false);
  });

  it('stops tracking NEW distinct values past the memory bound and flags truncation', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    for (let i = 0; i < 20_001; i++) a.push(row('O1', '2026-10-03', `V${i}`, '1', '1', '1'), i + 2);
    expect(a.result().dimensionsTruncated).toBe(true);
  });

  it('amounts sum exactly in BigInt (no float drift)', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    for (let i = 0; i < 1000; i++) a.push(row('O1', '2026-10-03', 'X', '500', 0.1, 0.000001), i + 2);
    expect(a.result().get('2026-10', 'O1', KEY_X500)).toEqual({ amountPaise: 10_000n, qtyMicro: 1000n, lines: 1000 });
  });
});
