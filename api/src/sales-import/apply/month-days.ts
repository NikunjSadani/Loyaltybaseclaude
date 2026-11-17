/**
 * Day-level month-to-date KPI values (sales-day-level, owner decision 2026-11-18). PURE — no DB.
 *
 * WHAT IS STORED (the contract `outlet_sales_days.mtdValues`): for each programme outlet and each IST invoice day on which
 * it billed something, the CUMULATIVE month-to-date value of every KPI the month write gave it, as of the end of that day.
 * "MTD to day D" = the outlet's latest row with day ≤ D (0 when none) — one lookup, no summing.
 *
 * WHY CUMULATIVE (the PRODUCT_COUNT design): ₹ and cases are additive, but PRODUCT_COUNT ("distinct products with NET
 * amount > 0") is not — a product bought on the 3rd and fully returned on the 20th counts 1 on days 3..19 and 0 from the
 * 20th; per-day counts cannot be summed into that. Storing per day × product amounts would let a reader recompute it, but
 * every reader would then have to re-implement the KPI filters / scope / TARGET_NAMES focus products exactly. Instead the
 * value is computed HERE, once, by the SAME evaluator as the monthly value: one OutletKpiAccumulator is fed the outlet's
 * day slices in day order and snapshotted after each day. The accumulator nets each product's amount across everything
 * added so far (productNet), so the snapshot after day D IS "distinct products with cumulative net > 0 up to D", and for
 * ₹ / cases it is the running sum, rounded ONCE like the stored monthly value (storedUnits / unitsToNumber).
 *
 * INVARIANT (checked, never assumed): the slices of every line sum exactly to the line (slicesMatchTotals), so after the
 * last day the accumulator holds exactly the month's lines and the last snapshot EQUALS the monthly OutletSalesRecord
 * value of the same write, key by key. Any difference → no day data for the month (the caller removes the old data and
 * reports why) — a comparison that disagrees with the monthly figure is never stored.
 */
import { OutletKpiAccumulator, type KpiDefLite } from '../kpi/sales-kpi.helper';
import type { RosterOutlet } from '../kpi/sales-import-data';
import { storedUnits, unitsToNumber, type DayLine, type MonthDayInput, type MonthOutletRow } from './month-compute';

export interface OutletDayRow {
  outletId: string;
  outletCode: string;
  day: number;
  mtdValues: Record<string, number>;
}

export type MonthDaysBuild =
  | { ok: true; rows: OutletDayRow[]; outlets: number }
  | { ok: false; code: 'NO_DAY_SPLIT'; rowsWithoutDays: number }
  | { ok: false; code: 'MISMATCH'; detail: string };

/**
 * `written` = exactly the outlet rows the month write stores (values non-empty). Only their keys are written per day;
 * an outlet with no line this month gets no day row (its MTD is 0 every day, matching its zero-filled monthly values).
 */
export function buildMonthDays(
  input: MonthDayInput | undefined,
  defs: readonly KpiDefLite[],
  roster: ReadonlyMap<string, RosterOutlet>,
  written: readonly MonthOutletRow[],
): MonthDaysBuild {
  if (!input) return { ok: false, code: 'NO_DAY_SPLIT', rowsWithoutDays: -1 };
  if (input.rowsWithoutDays > 0) return { ok: false, code: 'NO_DAY_SPLIT', rowsWithoutDays: input.rowsWithoutDays };
  const index = new Map(defs.map((d, i) => [d.kpiCode, i]));
  const acc = new OutletKpiAccumulator(defs);
  const rows: OutletDayRow[] = [];
  let outlets = 0;
  for (const w of written) {
    const keys = Object.keys(w.values);
    const outletId = roster.get(w.outletCode)?.id;
    if (!outletId) return { ok: false, code: 'MISMATCH', detail: `outlet ${w.outletCode} has no roster id` };
    for (const k of keys) {
      if (!index.has(k)) return { ok: false, code: 'MISMATCH', detail: `${w.outletCode}: ${k} is not an owned KPI` };
    }
    const byDay = groupByDay(input.byOutlet.get(w.outletCode) ?? []);
    let last: Record<string, number> | null = null;
    for (const [day, slices] of byDay) {
      for (const s of slices) acc.add(w.outletCode, s.agg, s.dimKey);
      const mtd: Record<string, number> = {};
      for (const k of keys) {
        const i = index.get(k)!;
        const m = defs[i].measure;
        mtd[k] = unitsToNumber(storedUnits(acc.rawSum(w.outletCode, i), m), m);
      }
      rows.push({ outletId, outletCode: w.outletCode, day, mtdValues: mtd });
      last = mtd;
    }
    if (last) outlets++;
    for (const k of keys) {
      const dayValue = last ? last[k] : 0;
      if (dayValue !== w.values[k]) {
        return { ok: false, code: 'MISMATCH', detail: `${w.outletCode} ${k}: last day ${dayValue} vs month ${w.values[k]}` };
      }
    }
  }
  return { ok: true, rows, outlets };
}

type Slice = { dimKey: string; agg: { dims: Record<string, string>; amountPaise: bigint; qtyPico: bigint; lines: number } };

/** The outlet's lines regrouped by day, days ascending. */
function groupByDay(lines: readonly DayLine[]): Array<[number, Slice[]]> {
  const m = new Map<number, Slice[]>();
  for (const l of lines) {
    for (const d of l.days) {
      let list = m.get(d.day);
      if (!list) m.set(d.day, (list = []));
      list.push({ dimKey: l.dimKey, agg: { dims: l.dims, amountPaise: d.amountPaise, qtyPico: d.qtyPico, lines: d.lines } });
    }
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}
