import type { SalesColumnMapping } from '../sales-import.contract';
import { SALES_IMPORT_MAX_DIMENSION_COMBOS, SALES_IMPORT_MAX_DIMENSION_VALUES, SALES_IMPORT_MAX_ERROR_SAMPLES } from '../sales-import.contract';
import { AggregatorLimitError, SalesAggregator } from './aggregator';
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
/** Fixtures are written in micro-cases; the aggregator stores pico-cases (x1e12, H3). */
const pico = (micro: bigint) => micro * 1_000_000n;

describe('SalesAggregator', () => {
  it('nets returns within a month and splits by invoice month', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-03', 'X', '500', '100.00', '1.5'), 3);
    a.push(row('O1', '2026-10-20', 'x ', 500, '-40.00', '-0.5'), 4);
    a.push(row('O1', '2026-11-01', 'X', '500', '10.00', '0.04'), 5);
    const r = a.result();
    expect(r.get('2026-10', 'O1', KEY_X500)).toEqual({ amountPaise: 6000n, qtyPico: pico(1_000_000n), lines: 2 });
    expect(r.get('2026-11', 'O1', KEY_X500)).toEqual({ amountPaise: 1000n, qtyPico: pico(40_000n), lines: 1 });
    expect(r.monthSummaries.map((m) => [m.month, m.firstDate, m.lastDate, m.lines])).toEqual([
      ['2026-10', '2026-10-03', '2026-10-20', 2],
      ['2026-11', '2026-11-01', '2026-11-01', 1],
    ]);
    expect(r.monthSummaries[0]).toMatchObject({ matchedOutlets: 1, matchedAmountRupees: 60, matchedQuantity: 1 });
    expect(r.aggregateCount).toBe(2);
    expect([...r.aggregates()]).toEqual([
      {
        month: '2026-10', outletCode: 'O1', dims: { dimA: 'X', dimB: '500' }, dimKey: KEY_X500, amountPaise: 6000n, qtyPico: pico(1_000_000n), lines: 2,
        days: [
          { day: 3, amountPaise: 10000n, qtyPico: pico(1_500_000n), lines: 1 },
          { day: 20, amountPaise: -4000n, qtyPico: pico(-500_000n), lines: 1 },
        ],
      },
      {
        month: '2026-11', outletCode: 'O1', dims: { dimA: 'X', dimB: '500' }, dimKey: KEY_X500, amountPaise: 1000n, qtyPico: pico(40_000n), lines: 1,
        days: [{ day: 1, amountPaise: 1000n, qtyPico: pico(40_000n), lines: 1 }],
      },
    ]);
  });

  it('keeps distinct dim combos apart and matches numeric codes from xlsx against the roster', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['327852']), TODAY);
    a.push(row(327852, '2026-10-03', 'X', 500, 10, 1), 3);
    a.push(row('327852', '2026-10-04', 'X', 200, 20, 2), 4);
    const r = a.result();
    expect(r.get('2026-10', '327852', KEY_X500)).toEqual({ amountPaise: 1000n, qtyPico: pico(1_000_000n), lines: 1 });
    expect(r.get('2026-10', '327852', '{"dimA":"X","dimB":"200"}')).toEqual({ amountPaise: 2000n, qtyPico: pico(2_000_000n), lines: 1 });
  });

  it('M6: aggregates under the NORMALIZED file code (the roster is applied at preview/apply); summary still matches', () => {
    const a = new SalesAggregator(MAP, IDX, new Map([['00123', ' 00123 ']]), TODAY);
    a.push(row('00123', '2026-10-03', 'X', 500, 10, 1), 3);
    const r = a.result();
    expect(r.get('2026-10', '00123', KEY_X500)).toEqual({ amountPaise: 1000n, qtyPico: pico(1_000_000n), lines: 1 });
    expect(r.monthSummaries[0]).toMatchObject({ matchedOutlets: 1, unmatchedCustomers: 0 });
  });

  it('M6: aggregates EVERY customer (matched or not) and still lists the processing-time unmatched ones', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-03', 'X', '500', '100', '1'), 3);
    a.push(row('U9', '2026-10-03', 'X', '500', '7.50', '0.5', ''), 4);
    a.push(row('U9', '2026-10-05', 'Y', '500', '2.50', '0.5', 'Late Name'), 5);
    a.push(row('U8', '2026-11-01', 'X', '500', '1', '1'), 6);
    const r = a.result();
    expect(r.aggregateCount).toBe(4);
    expect(r.get('2026-10', 'U9', KEY_X500)).toEqual({ amountPaise: 750n, qtyPico: pico(500_000n), lines: 1 });
    expect(r.monthSummaries[0]).toMatchObject({ lines: 3, matchedOutlets: 1, unmatchedCustomers: 1, unmatchedAmountRupees: 10, unmatchedQuantity: 1 });
    expect(r.monthSummaries[1]).toMatchObject({ unmatchedCustomers: 1, matchedOutlets: 0 });
    expect([...r.unmatched()]).toEqual([
      { month: '2026-10', code: 'U9', name: 'Late Name', amountPaise: 1000n, qtyPico: pico(1_000_000n), lines: 2 },
      { month: '2026-11', code: 'U8', name: 'Name', amountPaise: 100n, qtyPico: pico(1_000_000n), lines: 1 },
    ]);
  });

  it('skips blank code / bad date / bad amount / bad qty with reasons, capped at 200 samples', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    a.push(row('', '2026-10-03', 'X', '500', '1', '1'), 3);
    a.push(row('O1', '31-02-2026', 'X', '500', '1', '1'), 4);
    a.push(row('O1', '1999-01-01', 'X', '500', '1', '1'), 5);
    a.push(row('O1', '2026-10-03', 'X', '500', 'abc', '1'), 6);
    a.push(row('O1', '2026-10-03', 'X', '500', '', ''), 7);
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
      { row: 7, column: null, reason: 'blank amount and quantity' },
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
    expect(a.result().get('2026-10', 'O1', KEY_X500)).toEqual({ amountPaise: 500n, qtyPico: pico(0n), lines: 1 });
  });

  it('no dimensions → a single "{}" bucket per outlet-month and no combos', () => {
    const a = new SalesAggregator({ ...MAP, dimensions: [] }, { ...IDX, dims: {} }, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-03', 'X', '500', '5', '1'), 3);
    a.push(row('O1', '2026-10-04', 'Y', '200', '5', '1'), 4);
    const r = a.result();
    expect(r.get('2026-10', 'O1', '{}')).toEqual({ amountPaise: 1000n, qtyPico: pico(2_000_000n), lines: 2 });
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
    expect(a.result().get('2026-10', 'O1', KEY_X500)).toEqual({ amountPaise: 10_000n, qtyPico: pico(1000n), lines: 1000 });
  });

  it('H3: 12 lines of 1/12 case (Excel float) → monthly quantity exactly 1.000', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    for (let i = 0; i < 12; i++) a.push(row('O1', '2026-10-03', 'X', '500', 1, 1 / 12), i + 2);
    expect(a.result().monthSummaries[0].matchedQuantity).toBe(1);
  });

  it('H4: with both measures mapped a blank one counts as 0 (row kept); both blank → skipped', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-03', 'X', '500', '', '2'), 2); // free goods: qty only
    a.push(row('O1', '2026-10-04', 'X', '500', '-50', null), 3); // credit note: amount only
    a.push(row('O1', '2026-10-05', 'X', '500', ' ', ''), 4); // nothing
    const r = a.result();
    expect(r.get('2026-10', 'O1', KEY_X500)).toEqual({ amountPaise: -5000n, qtyPico: pico(2_000_000n), lines: 2 });
    expect(r.errorSamples).toEqual([{ row: 4, column: null, reason: 'blank amount and quantity' }]);
    // a single mapped measure that is blank is still a skip
    const b = new SalesAggregator({ ...MAP, quantity: null }, { ...IDX, quantity: null }, roster(['O1']), TODAY);
    b.push(row('O1', '2026-10-03', 'X', '500', '', '2'), 2);
    expect(b.result().errorSamples).toEqual([{ row: 2, column: 'AMT', reason: 'blank amount' }]);
  });

  it('L1: decimal-comma text cells when the run separator is a comma', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY, ',');
    a.push(row('O1', '2026-10-03', 'X', '500', '1.234,50', '0,5'), 2);
    a.push(row('O1', '2026-10-03', 'X', '500', '1234.5', '1'), 3); // ambiguous → invalid amount
    const r = a.result();
    expect(r.get('2026-10', 'O1', KEY_X500)).toEqual({ amountPaise: 123450n, qtyPico: pico(500_000n), lines: 1 });
    expect(r.errorSamples).toEqual([{ row: 3, column: 'AMT', reason: 'invalid amount' }]);
  });

  it('S4/M6: distinct-code, aggregate, unmatched and quantity caps fail with a readable AggregatorLimitError', () => {
    const codes = new SalesAggregator(MAP, IDX, roster([]), TODAY, '.', { maxCodes: 2 });
    codes.push(row('A', '2026-10-03', 'X', '500', 1, 1), 2);
    codes.push(row('B', '2026-10-03', 'X', '500', 1, 1), 3);
    codes.push(row('A', '2026-10-04', 'X', '500', 1, 1), 4); // known code: fine
    expect(() => codes.push(row('C', '2026-10-03', 'X', '500', 1, 1), 5)).toThrow(AggregatorLimitError);
    expect(() => codes.push(row('C', '2026-10-03', 'X', '500', 1, 1), 5)).toThrow(/more than 2 distinct customer codes/);

    const aggs = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY, '.', { maxAggregates: 1 });
    aggs.push(row('O1', '2026-10-03', 'X', '500', 1, 1), 2);
    expect(() => aggs.push(row('O1', '2026-10-03', 'X', '200', 1, 1), 3)).toThrow(/month × customer × product/);

    const un = new SalesAggregator(MAP, IDX, roster([]), TODAY, '.', { maxUnmatched: 1 });
    un.push(row('U1', '2026-10-03', 'X', '500', 1, 1), 2);
    expect(() => un.push(row('U2', '2026-10-03', 'X', '500', 1, 1), 3)).toThrow(/unmatched customer/);

    const big = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    expect(() => big.push(row('O1', '2026-10-03', 'X', '500', 1, '9000001'), 2)).toThrow(AggregatorLimitError);
  });
});

describe('SalesAggregator — re-audit memory bound', () => {
  it('aggregate + unmatched entries are bounded COMBINED (a hostile file fails readably, not with an OOM)', () => {
    const a = new SalesAggregator(MAP, IDX, roster([]), TODAY, '.', { maxTracked: 3 });
    a.push(row('U1', '2026-10-03', 'X', '500', 1, 1), 2); // 1 aggregate + 1 unmatched
    expect(() => a.push(row('U2', '2026-10-03', 'X', '500', 1, 1), 3)).toThrow(/too large to process in one go/);
  });

  it('collects decimal evidence only when asked (auto mode)', () => {
    const on = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY, '.', {}, { collectDecimalEvidence: true });
    on.push(row('O1', '2026-10-03', 'X', '500', '0.500', '2.000'), 2);
    expect(on.result().decimalEvidence).toEqual({ dot: 1, comma: 0, ambiguous: 1, examples: { dot: '0.500', ambiguous: '2.000' } });
    const off = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    off.push(row('O1', '2026-10-03', 'X', '500', '0.500', '2.000'), 2);
    expect(off.result().decimalEvidence).toEqual({ dot: 0, comma: 0, ambiguous: 0, examples: {} });
  });
});

describe('SalesAggregator — final check L1 (bounded keys)', () => {
  it('a dimension value or outlet code longer than 200 characters skips the row with a reason (counted)', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-03', 'X'.repeat(201), '500', 1, 1), 2);
    a.push(row('C'.repeat(201), '2026-10-03', 'X', '500', 1, 1), 3);
    a.push(row('O1', '2026-10-03', 'X'.repeat(200), '500', 1, 1), 4); // exactly 200 is fine
    const r = a.result();
    expect(r.rowsSkipped).toBe(2);
    expect(r.errorSamples).toEqual([
      { row: 2, column: 'A', reason: 'dimA value longer than 200 characters' },
      { row: 3, column: 'CODE', reason: 'outlet code longer than 200 characters' },
    ]);
    expect(r.aggregateCount).toBe(1);
  });
});

describe('SalesAggregator — month summary quantities rounded like preview / apply (audit L-4)', () => {
  it('matched = Σ per-outlet 3-dp values, unmatched = Σ per-customer 3-dp values', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1', 'O2']), TODAY);
    a.push(row('O1', '2026-10-03', 'X', '500', 1, '0.0005'), 2);
    a.push(row('O2', '2026-10-03', 'X', '500', 1, '0.0005'), 3);
    a.push(row('U1', '2026-10-03', 'X', '500', 1, '0.0005'), 4);
    a.push(row('U2', '2026-10-03', 'Y', '500', 1, '0.0005'), 5);
    expect(a.result().monthSummaries[0]).toMatchObject({ matchedQuantity: 0.002, unmatchedQuantity: 0.002 }); // raw: 0.001 each
  });
});

describe('SalesAggregator — day split (sales-day-level)', () => {
  it('splits each aggregate by IST invoice DAY; the parts sum exactly to the row (one-day rows stay compact)', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-03', 'X', '500', '100.00', '1.5'), 2);
    a.push(row('O1', '2026-10-20', 'X', '500', '-40.00', '-0.5'), 3);
    a.push(row('O1', '2026-10-03', 'X', '500', '5.00', '0.25'), 4); // the 3rd again
    a.push(row('O1', '2026-10-09', 'Y', '500', '7.00', '1'), 5); // a one-day row
    const r = a.result();
    expect(r.getDays('2026-10', 'O1', KEY_X500)).toEqual([
      { day: 3, amountPaise: 10500n, qtyPico: pico(1_750_000n), lines: 2 },
      { day: 20, amountPaise: -4000n, qtyPico: pico(-500_000n), lines: 1 },
    ]);
    expect(r.get('2026-10', 'O1', KEY_X500)).toEqual({ amountPaise: 6500n, qtyPico: pico(1_250_000n), lines: 3 });
    expect(r.getDays('2026-10', 'O1', '{"dimA":"Y","dimB":"500"}')).toEqual([{ day: 9, amountPaise: 700n, qtyPico: pico(1_000_000n), lines: 1 }]);
  });

  it('the day is the IST calendar day — an instant late on the 31st (UTC) is the 1st of the NEXT month in IST', () => {
    const a = new SalesAggregator({ ...MAP, dateOrder: 'YMD' }, IDX, roster(['O1']), TODAY);
    a.push(row('O1', '2026-10-31T20:00:00Z', 'X', '500', '1', '0'), 2); // 01:30 IST on 1 Nov
    a.push(row('O1', '2026-10-31T18:29:00Z', 'X', '500', '2', '0'), 3); // 23:59 IST on 31 Oct
    a.push(row('O1', '2026-10-31 23:45', 'X', '500', '4', '0'), 4); // wall clock (IST) without a zone → 31 Oct
    a.push(row('O1', new Date(Date.UTC(2026, 9, 31)), 'X', '500', '8', '0'), 5); // an xlsx date cell = a calendar date
    const r = a.result();
    expect(r.getDays('2026-11', 'O1', KEY_X500)).toEqual([{ day: 1, amountPaise: 100n, qtyPico: 0n, lines: 1 }]);
    expect(r.getDays('2026-10', 'O1', KEY_X500)).toEqual([{ day: 31, amountPaise: 1400n, qtyPico: 0n, lines: 3 }]);
    expect(r.monthSummaries.map((m) => [m.month, m.firstDate, m.lastDate])).toEqual([
      ['2026-10', '2026-10-31', '2026-10-31'],
      ['2026-11', '2026-11-01', '2026-11-01'],
    ]);
  });

  it('a line that cannot be dated is never dropped silently: it is skipped, counted and sampled (and in no month / day)', () => {
    const a = new SalesAggregator(MAP, IDX, roster(['O1']), TODAY);
    a.push(row('O1', 'not a date', 'X', '500', '1', '0'), 2);
    a.push(row('O1', '2026-10-05', 'X', '500', '1', '0'), 3);
    const r = a.result();
    expect(r.rowsSkipped).toBe(1);
    expect(r.errorSamples).toEqual([{ row: 2, column: 'DATE', reason: 'invalid date' }]);
    expect([...r.aggregates()].flatMap((x) => x.days.map((d) => d.day))).toEqual([5]);
  });
});
