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
import { storedUnits, unitsToNumber, type MonthDayInput, type MonthOutletRow, type OutletDaySlices } from './month-compute';

/*
 * S5 MEMORY (apply / recalculate / its preview run in gifsy-api, 1 GiB shared with live tenants):
 *   - computeMonthRows keeps each matched line's day split ONCE, compactly (OutletDaySlices: flat parallel arrays, the
 *     product interned) — no per-line / per-slice objects, no second copy of the rows;
 *   - buildMonthDays evaluates ONE outlet at a time with its own accumulator (sharing only the product-match cache), so
 *     the accumulator state of finished outlets is garbage immediately; the outlet's slices are dropped once built;
 *   - above SALES_DAY_BUILD_MAX_ROWS matched rows (default 500,000) nothing is collected (MonthDayInput.tooLarge) and the
 *     month gets no day data with a loud reason.
 * Estimate for 400,000 matched rows (≈ 1.3 days per row ⇒ ≈ 520,000 slices): per slice 5 array slots (40 B) + the two
 * BigInts decoded from the page and retained (≈ 2 × 24 B) + growth slack (≈ 25 %) ≈ 110 B ⇒ ≈ 57 MB; the output rows
 * (≈ outlets × billing days, e.g. 6,500 × 10 = 65,000 rows × ≈ 200 B) ≈ 13 MB; the per-outlet accumulator is transient
 * (KBs). Added peak ≈ 70 MB, vs ≈ 150 MB for the previous per-line objects (DayLine + DaySlice objects + per-row dims / dimKey).
 */

export interface OutletDayRow {
  outletId: string;
  outletCode: string;
  day: number;
  mtdValues: Record<string, number>;
}

export type MonthDaysBuild =
  | { ok: true; rows: OutletDayRow[]; outlets: number }
  | { ok: false; code: 'NO_DAY_SPLIT'; rowsWithoutDays: number }
  | { ok: false; code: 'TOO_LARGE'; rows: number; limit: number }
  | { ok: false; code: 'OUT_OF_WINDOW'; month: string }
  | { ok: false; code: 'MISMATCH'; detail: string };

/**
 * `written` = exactly the outlet rows the month write stores (values non-empty). Only their keys are written per day;
 * an outlet with no line this month gets no day row (its MTD is 0 every day, matching its zero-filled monthly values).
 * Consumes `input` (each outlet's slices are released once built).
 */
export function buildMonthDays(
  input: MonthDayInput | undefined,
  defs: readonly KpiDefLite[],
  roster: ReadonlyMap<string, RosterOutlet>,
  written: readonly MonthOutletRow[],
): MonthDaysBuild {
  if (!input) return { ok: false, code: 'NO_DAY_SPLIT', rowsWithoutDays: -1 };
  if (input.tooLarge) return { ok: false, code: 'TOO_LARGE', rows: input.tooLarge.rows, limit: input.tooLarge.limit };
  if (input.rowsWithoutDays > 0) return { ok: false, code: 'NO_DAY_SPLIT', rowsWithoutDays: input.rowsWithoutDays };
  const index = new Map(defs.map((d, i) => [d.kpiCode, i]));
  const matchCache = new Map<string, boolean[]>();
  const rows: OutletDayRow[] = [];
  let outlets = 0;
  for (const w of written) {
    const keys = Object.keys(w.values);
    const outletId = roster.get(w.outletCode)?.id;
    if (!outletId) return { ok: false, code: 'MISMATCH', detail: `outlet ${w.outletCode} has no roster id` };
    for (const k of keys) {
      if (!index.has(k)) return { ok: false, code: 'MISMATCH', detail: `${w.outletCode}: ${k} is not an owned KPI` };
    }
    const slices = input.byOutlet.get(w.outletCode);
    input.byOutlet.delete(w.outletCode);
    // One accumulator per outlet (its state is garbage once the outlet is done); the product-match cache is shared.
    const acc = new OutletKpiAccumulator(defs, matchCache);
    let last: Record<string, number> | null = null;
    if (slices) {
      for (const [day, idx] of groupByDay(slices)) {
        for (const i of idx) {
          const p = slices.product[i];
          acc.add(w.outletCode, { dims: p.dims, amountPaise: slices.paise[i], qtyPico: slices.pico[i], lines: slices.lines[i] }, p.dimKey);
        }
        const mtd: Record<string, number> = {};
        for (const k of keys) {
          const i = index.get(k)!;
          const m = defs[i].measure;
          mtd[k] = unitsToNumber(storedUnits(acc.rawSum(w.outletCode, i), m), m);
        }
        rows.push({ outletId, outletCode: w.outletCode, day, mtdValues: mtd });
        last = mtd;
      }
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

/** The outlet's slice indices grouped by day, days ascending (slice order kept within a day). */
function groupByDay(s: OutletDaySlices): Array<[number, number[]]> {
  const m = new Map<number, number[]>();
  for (let i = 0; i < s.day.length; i++) {
    let list = m.get(s.day[i]);
    if (!list) m.set(s.day[i], (list = []));
    list.push(i);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}
