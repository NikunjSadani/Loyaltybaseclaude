import { stableStringify, type KpiDefLite } from '../kpi/sales-kpi.helper';
import type { AggRow, AggregatePager, RosterOutlet } from '../kpi/sales-import-data';
import type { DaySlice } from '../days/day-slices';
import { SALES_DAY_BUILD_MAX_ROWS_DEFAULT, computeMonthRows, dayBuildRowLimit } from './month-compute';
import { buildMonthDays } from './month-days';

/**
 * sales-day-level: the cumulative month-to-date values (contract of outlet_sales_days.mtdValues) and the invariant
 * "last loaded day == the monthly OutletSalesRecord value of the same write".
 */
const PICO = 1_000_000_000_000n; // pico-cases per case
const def = (kpiCode: string, measure: KpiDefLite['measure'], filter: KpiDefLite['filter'] = {}, outletTypes: string[] = []): KpiDefLite => ({
  kpiCode, measure, filter, outletTypes, programs: [],
});
const roster = (codes: string[], type = 'RETAIL'): Map<string, RosterOutlet> =>
  new Map(codes.map((c) => [c, { id: `id-${c}`, name: c, outletType: type, program: null }]));

let nextId = 1;
/** One aggregate row built from its day slices (totals = Σ slices, like the worker writes it). */
function line(code: string, dims: Record<string, string>, slices: Array<[day: number, paise: bigint, pico?: bigint]>): AggRow {
  const days: DaySlice[] = slices.map(([day, p, q]) => ({ day, amountPaise: p, qtyPico: q ?? 0n, lines: 1 }));
  return {
    id: BigInt(nextId++), month: '2026-10', outletCode: code, dims, dimKey: stableStringify(dims),
    amountPaise: days.reduce((s, d) => s + d.amountPaise, 0n), qtyPico: days.reduce((s, d) => s + d.qtyPico, 0n), lines: days.length, days,
  };
}
const pagerOf = (rows: AggRow[]): AggregatePager => async (onPage) => onPage(rows);

async function run(rows: AggRow[], defs: KpiDefLite[], r: Map<string, RosterOutlet>) {
  const comp = await computeMonthRows(pagerOf(rows), defs, r, { collectDays: true });
  const written = comp.rows.filter((x) => Object.keys(x.values).length > 0);
  return { comp, written, build: buildMonthDays(comp.days, defs, r, written) };
}

describe('buildMonthDays — cumulative month-to-date per outlet × billing day', () => {
  it('AMOUNT: running ₹ sum, only on days the outlet billed; returns net off', async () => {
    const { build } = await run(
      [line('O1', { b: 'A' }, [[3, 10000n], [10, -2500n]]), line('O1', { b: 'B' }, [[7, 500n]])],
      [def('AMT', 'AMOUNT')],
      roster(['O1']),
    );
    expect(build).toEqual({
      ok: true,
      outlets: 1,
      rows: [
        { outletId: 'id-O1', outletCode: 'O1', day: 3, mtdValues: { AMT: 100 } },
        { outletId: 'id-O1', outletCode: 'O1', day: 7, mtdValues: { AMT: 105 } },
        { outletId: 'id-O1', outletCode: 'O1', day: 10, mtdValues: { AMT: 80 } },
      ],
    });
  });

  it('QUANTITY: the cumulative pico sum is rounded ONCE per day like the stored monthly value (not a sum of rounded days)', async () => {
    const q = (cases4dp: bigint) => (cases4dp * PICO) / 10_000n; // 0.0004 case
    const { build, written } = await run(
      [line('O1', { b: 'A' }, [[1, 0n, q(4n)], [2, 0n, q(4n)], [3, 0n, q(4n)]])],
      [def('CS', 'QUANTITY')],
      roster(['O1']),
    );
    expect(build.ok && build.rows.map((r) => [r.day, r.mtdValues.CS])).toEqual([[1, 0], [2, 0.001], [3, 0.001]]);
    expect(written[0].values.CS).toBe(0.001); // the monthly value
  });

  it('PRODUCT_COUNT: distinct products with CUMULATIVE net > 0 — a full return drops the product from that day on; free / negative-only never count', async () => {
    const { build, written } = await run(
      [
        line('O1', { b: 'A' }, [[3, 100n], [10, -100n]]), // bought, fully returned on the 10th
        line('O1', { b: 'B' }, [[5, 50n]]),
        line('O1', { b: 'C' }, [[7, 0n]]), // free goods only
        line('O1', { b: 'D' }, [[12, -30n]]), // return only
        line('O1', { b: 'E' }, [[14, 10n], [20, -40n], [25, 40n]]), // net > 0 on 14, ≤ 0 on 20..24, > 0 again on 25
      ],
      [def('LINES', 'PRODUCT_COUNT')],
      roster(['O1']),
    );
    expect(build.ok && build.rows.map((r) => [r.day, r.mtdValues.LINES])).toEqual([
      [3, 1], [5, 2], [7, 2], [10, 1], [12, 1], [14, 2], [20, 1], [25, 2],
    ]);
    expect(written[0].values.LINES).toBe(2); // = the last day
  });

  it('PRODUCT_COUNT honours the filter, and a product split over several lines is netted before counting', async () => {
    const { build } = await run(
      [
        line('O1', { b: 'A', s: '1' }, [[1, 100n]]),
        line('O1', { b: 'A', s: '1' }, [[2, -100n]]), // the same product in a second row (another page / history row)
        line('O1', { b: 'X', s: '1' }, [[2, 100n]]), // excluded by the filter
      ],
      [def('L', 'PRODUCT_COUNT', { noneOf: [{ b: 'X' }] })],
      roster(['O1']),
    );
    expect(build.ok && build.rows.map((r) => [r.day, r.mtdValues.L])).toEqual([[1, 1], [2, 0]]);
  });

  it('only ROSTER (programme) outlets get rows; out-of-scope KPIs are omitted like the monthly row; zero-filled outlets get none', async () => {
    const r = new Map<string, RosterOutlet>([
      ['W1', { id: 'id-W1', name: 'W', outletType: 'WHOLESALER', program: null }],
      ['R1', { id: 'id-R1', name: 'R', outletType: 'RETAIL', program: null }],
      ['Z1', { id: 'id-Z1', name: 'Z', outletType: 'RETAIL', program: null }], // no lines
    ]);
    const { build, written } = await run(
      [line('W1', { b: 'A' }, [[4, 100n, PICO]]), line('R1', { b: 'A' }, [[6, 200n, PICO]]), line('NOT-ON-ROSTER', { b: 'A' }, [[1, 999n]])],
      [def('AMT', 'AMOUNT'), def('CS', 'QUANTITY', {}, ['WHOLESALER'])],
      r,
    );
    expect(written.map((w) => w.outletCode)).toEqual(['R1', 'W1', 'Z1']);
    expect(build.ok && build.rows).toEqual([
      { outletId: 'id-R1', outletCode: 'R1', day: 6, mtdValues: { AMT: 2 } },
      { outletId: 'id-W1', outletCode: 'W1', day: 4, mtdValues: { AMT: 1, CS: 1 } },
    ]);
  });

  it('a matched line without a usable day split → NO_DAY_SPLIT (an unmatched one does not matter)', async () => {
    const good = line('O1', { b: 'A' }, [[1, 100n]]);
    const unmatchedNoDays = { ...line('ZZ', { b: 'A' }, [[1, 5n]]), days: null };
    expect((await run([good, unmatchedNoDays], [def('AMT', 'AMOUNT')], roster(['O1']))).build.ok).toBe(true);
    const missing = { ...line('O1', { b: 'B' }, [[2, 100n]]), days: null };
    expect((await run([good, missing], [def('AMT', 'AMOUNT')], roster(['O1']))).build).toEqual({ ok: false, code: 'NO_DAY_SPLIT', rowsWithoutDays: 1 });
    const notSumming = { ...line('O1', { b: 'B' }, [[2, 100n]]), amountPaise: 101n };
    expect((await run([good, notSumming], [def('AMT', 'AMOUNT')], roster(['O1']))).build).toEqual({ ok: false, code: 'NO_DAY_SPLIT', rowsWithoutDays: 1 });
  });

  it('INVARIANT (randomised, seeded): MTD to every day D == the month computed over the lines up to D; the last day == the monthly value', async () => {
    let seed = 20261118;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    const products = ['A', 'B', 'C', 'D', 'E', 'F'];
    const defs = [
      def('AMT', 'AMOUNT'),
      def('AMT_AB', 'AMOUNT', { anyOf: [{ b: 'A' }, { b: 'B' }] }),
      def('CS', 'QUANTITY'),
      def('CS_W', 'QUANTITY', {}, ['WHOLESALER']),
      def('LINES', 'PRODUCT_COUNT'),
      def('LINES_NOT_F', 'PRODUCT_COUNT', { noneOf: [{ b: 'F' }] }),
    ];
    const codes = Array.from({ length: 25 }, (_, i) => `O${i}`);
    const r = new Map<string, RosterOutlet>(codes.map((c, i) => [c, { id: `id-${c}`, name: c, outletType: i % 3 === 0 ? 'WHOLESALER' : 'RETAIL', program: null }]));
    const rows: AggRow[] = [];
    for (const c of [...codes, 'U1', 'U2']) {
      for (const p of products) {
        if (rnd(3) === 0) continue;
        const n = 1 + rnd(4);
        const days = [...new Set(Array.from({ length: n }, () => 1 + rnd(30)))];
        rows.push(line(c, { b: p }, days.map((d) => [d, BigInt(rnd(20000) - 6000), BigInt(rnd(3_000_000)) * 1_000_000n] as [number, bigint, bigint])));
      }
    }
    const { build, written } = await run(rows, defs, r);
    if (!build.ok) throw new Error(JSON.stringify(build));
    // oracle: the month computed over each line truncated to day ≤ D
    const upTo = (d: number): AggRow[] =>
      rows.flatMap((l) => {
        const s = l.days!.filter((x) => x.day <= d);
        if (s.length === 0) return [];
        return [{ ...l, amountPaise: s.reduce((a, x) => a + x.amountPaise, 0n), qtyPico: s.reduce((a, x) => a + x.qtyPico, 0n), lines: s.length, days: s }];
      });
    const oracle = new Map<number, Map<string, Record<string, number>>>();
    for (const d of new Set(build.rows.map((x) => x.day))) {
      const c = await computeMonthRows(pagerOf(upTo(d)), defs, r);
      oracle.set(d, new Map(c.rows.map((x) => [x.outletCode, x.values])));
    }
    for (const row of build.rows) expect(row.mtdValues).toEqual(oracle.get(row.day)!.get(row.outletCode));
    for (const w of written) {
      const mine = build.rows.filter((x) => x.outletCode === w.outletCode);
      const last = mine[mine.length - 1];
      expect(last ? last.mtdValues : Object.fromEntries(Object.keys(w.values).map((k) => [k, 0]))).toEqual(w.values);
    }
    expect(build.rows.some((x) => x.outletCode.startsWith('U'))).toBe(false);
    expect(build.rows.length).toBeGreaterThan(50); // a real spread of outlets × days was checked
  });
});

describe('S5 — bounded day building', () => {
  it('above the row limit collection STOPS, what was collected is dropped, and the build is TOO_LARGE (never an OOM)', async () => {
    const rows = [line('O1', { b: 'A' }, [[1, 100n]]), line('O1', { b: 'B' }, [[2, 100n]]), line('O2', { b: 'A' }, [[3, 100n]]), line('ZZ', { b: 'A' }, [[3, 1n]])];
    const r = roster(['O1', 'O2']);
    const comp = await computeMonthRows(pagerOf(rows), [def('AMT', 'AMOUNT')], r, { collectDays: true, dayRowLimit: 2 });
    expect(comp.days!.tooLarge).toEqual({ rows: 3, limit: 2 });
    expect(comp.days!.byOutlet.size).toBe(0);
    expect(comp.days!.matchedRows).toBe(3); // unmatched ZZ never counts
    expect(comp.rows.find((x) => x.outletCode === 'O1')!.values).toEqual({ AMT: 2 }); // the monthly figures are unaffected
    const written = comp.rows.filter((x) => Object.keys(x.values).length > 0);
    expect(buildMonthDays(comp.days, [def('AMT', 'AMOUNT')], r, written)).toEqual({ ok: false, code: 'TOO_LARGE', rows: 3, limit: 2 });
    // at the limit it still builds
    const ok = await computeMonthRows(pagerOf(rows), [def('AMT', 'AMOUNT')], r, { collectDays: true, dayRowLimit: 3 });
    expect(buildMonthDays(ok.days, [def('AMT', 'AMOUNT')], r, written).ok).toBe(true);
  });

  it('compact storage: flat per-outlet slices, the product interned once per month (rows never held twice); consumed as it builds', async () => {
    const rows = [line('O1', { b: 'A' }, [[1, 100n], [4, 50n]]), line('O1', { b: 'A' }, [[2, 10n]]), line('O2', { b: 'A' }, [[3, 5n]])];
    const r = roster(['O1', 'O2']);
    const comp = await computeMonthRows(pagerOf(rows), [def('AMT', 'AMOUNT')], r, { collectDays: true });
    const o1 = comp.days!.byOutlet.get('O1')!;
    expect(o1.day).toEqual([1, 4, 2]);
    expect(o1.paise).toEqual([100n, 50n, 10n]);
    expect(o1.product[0]).toBe(o1.product[2]); // one object for the product, whichever row it came from
    expect(o1.product[0]).toBe(comp.days!.byOutlet.get('O2')!.product[0]);
    const written = comp.rows.filter((x) => Object.keys(x.values).length > 0);
    const b = buildMonthDays(comp.days, [def('AMT', 'AMOUNT')], r, written);
    expect(b.ok && b.rows.map((x) => [x.outletCode, x.day, x.mtdValues.AMT])).toEqual([['O1', 1, 1], ['O1', 2, 1.1], ['O1', 4, 1.6], ['O2', 3, 0.05]]);
    expect(comp.days!.byOutlet.size).toBe(0); // each outlet released once built
  });

  it('the limit setting SALES_DAY_BUILD_MAX_ROWS (whole number >= 1; anything else -> the default)', () => {
    expect(SALES_DAY_BUILD_MAX_ROWS_DEFAULT).toBe(500_000);
    expect(dayBuildRowLimit({})).toBe(500_000);
    expect(dayBuildRowLimit({ SALES_DAY_BUILD_MAX_ROWS: '1200000' })).toBe(1_200_000);
    for (const bad of ['0', '-5', 'abc', '1.5', ' ']) expect(dayBuildRowLimit({ SALES_DAY_BUILD_MAX_ROWS: bad })).toBe(500_000);
  });
});
