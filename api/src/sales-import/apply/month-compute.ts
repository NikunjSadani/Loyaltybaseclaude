/**
 * The per-month KPI computation shared by PREVIEW and APPLY, so the numbers the admin previews are exactly the
 * numbers apply writes (same function, same aggregates, same definitions).
 */
import type { Prisma } from '@prisma/client';
import { OutletKpiAccumulator, assertNeverMeasure, outletInScope, type KpiDefLite } from '../kpi/sales-kpi.helper';
import { QTY_SCALE, divRoundHalfAway } from '../ingest/normalize';
import { rosterIndexOf, type AggregatePager, type RosterOutlet } from '../kpi/sales-import-data';
import { slicesMatchTotals, type DaySlice } from '../days/day-slices';

export interface MonthOutletRow {
  outletCode: string;
  outletName: string;
  /**
   * kpiCode → value for every IN-SCOPE owned KPI (out-of-scope keys omitted; no lines → 0). FOCUS-FROM-TARGETS: a
   * per-outlet (TARGET_NAMES) KPI whose outletFilter gives no filter for the outlet is omitted too.
   */
  values: Record<string, number>;
  /** The outlet had no aggregate line at all this month (every value is a zero-fill). */
  zeroFilled: boolean;
}

export interface MonthKpiStat {
  kpiCode: string;
  totalRaw: bigint; // paise / pico-cases / Σ product counts (PRODUCT_COUNT)
  total: number;
  outletsNonZero: number;
  outletsNegative: number;
}

/** The file's lines for the month split by the roster CURRENT at compute time (M6; overrides the frozen summary). */
export interface MonthRosterSplit {
  matchedOutlets: number;
  matchedPaise: bigint;
  matchedPico: bigint;
  /** Σ over matched OUTLETS of each outlet's quantity rounded to 3 dp (thousandths) — consistent with the KPI totals. */
  matchedQtyThousandths: bigint;
  unmatchedCustomers: number;
  unmatchedPaise: bigint;
  unmatchedPico: bigint;
  /** Σ over unmatched CUSTOMER CODES of each code's quantity rounded to 3 dp (thousandths). */
  unmatchedQtyThousandths: bigint;
}

export interface MonthComputation {
  rows: MonthOutletRow[];
  stats: MonthKpiStat[];
  zeroFillOutlets: number;
  split: MonthRosterSplit;
  /** ROSTER outlet codes with at least one sales line this month (in an owned KPI's scope or not) — reconciliation gaps. */
  matchedOutletCodes: ReadonlySet<string>;
  /** sales-day-level: the matched lines with their day split — only with `collectDays` (apply / recalculate). */
  days?: MonthDayInput;
}

/** One matched line (aggregate / history row) of an outlet with its split by IST invoice day. */
export interface DayLine {
  dimKey: string;
  dims: Record<string, string>;
  days: DaySlice[];
}
export interface MonthDayInput {
  /** ROSTER outlet code → its matched lines (with their day split). */
  byOutlet: Map<string, DayLine[]>;
  /** Matched rows with no usable day split (absent, malformed, or not summing exactly to the row) — day data impossible. */
  rowsWithoutDays: number;
}

/**
 * `pager` = the month's lines: an import's aggregates (importPager — preview / apply) or the month's stored history
 * (historyPager — recalculate). Same computation either way.
 */
export async function computeMonthRows(
  pager: AggregatePager,
  defs: readonly KpiDefLite[],
  roster: Map<string, RosterOutlet>,
  /** `collectDays`: keep every matched line's day split for buildMonthDays (the pager must read `withDays`). */
  opts: { collectDays?: boolean } = {},
): Promise<MonthComputation> {
  // M6: aggregates carry the FILE's (normalized) customer code; they are mapped onto the roster as it is NOW, so an
  // outlet added after processing is written and one removed since is not.
  const index = rosterIndexOf(roster);
  const acc = new OutletKpiAccumulator(defs);
  const matched = new Set<string>();
  const unmatched = new Set<string>();
  const split: MonthRosterSplit = {
    matchedOutlets: 0, matchedPaise: 0n, matchedPico: 0n, matchedQtyThousandths: 0n,
    unmatchedCustomers: 0, unmatchedPaise: 0n, unmatchedPico: 0n, unmatchedQtyThousandths: 0n,
  };
  // Per outlet / per customer quantity, so the displayed totals round each one ONCE like the stored values do.
  const matchedQty = new Map<string, bigint>();
  const unmatchedQty = new Map<string, bigint>();
  const days: MonthDayInput | undefined = opts.collectDays ? { byOutlet: new Map(), rowsWithoutDays: 0 } : undefined;
  await pager((page) => {
    for (const a of page) {
      const code = index.get(a.outletCode);
      if (code === undefined) {
        unmatched.add(a.outletCode);
        split.unmatchedPaise += a.amountPaise;
        split.unmatchedPico += a.qtyPico;
        unmatchedQty.set(a.outletCode, (unmatchedQty.get(a.outletCode) ?? 0n) + a.qtyPico);
        continue;
      }
      matched.add(code);
      split.matchedPaise += a.amountPaise;
      split.matchedPico += a.qtyPico;
      matchedQty.set(code, (matchedQty.get(code) ?? 0n) + a.qtyPico);
      acc.add(code, a, a.dimKey);
      if (days) {
        if (a.days && slicesMatchTotals(a.days, a)) {
          let list = days.byOutlet.get(code);
          if (!list) days.byOutlet.set(code, (list = []));
          list.push({ dimKey: a.dimKey, dims: a.dims, days: a.days });
        } else {
          days.rowsWithoutDays++;
        }
      }
    }
  });
  split.matchedOutlets = matched.size;
  split.unmatchedCustomers = unmatched.size;
  for (const v of matchedQty.values()) split.matchedQtyThousandths += storedUnits(v, 'QUANTITY');
  for (const v of unmatchedQty.values()) split.unmatchedQtyThousandths += storedUnits(v, 'QUANTITY');

  const stats: MonthKpiStat[] = defs.map((d) => ({ kpiCode: d.kpiCode, totalRaw: 0n, total: 0, outletsNonZero: 0, outletsNegative: 0 }));
  const storedSums = defs.map(() => 0n);
  const rows: MonthOutletRow[] = [];
  let zeroFillOutlets = 0;
  for (const [code, meta] of [...roster.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (!defs.some((d) => outletInScope(d, meta))) continue; // in no owned KPI's scope → untouched
    const values: Record<string, number> = {};
    defs.forEach((d, i) => {
      if (!outletInScope(d, meta)) return;
      if (acc.keyOmitted(code, i)) return; // FOCUS-FROM-TARGETS: no name for this KPI → no key, not counted in stats
      const raw = acc.rawSum(code, i);
      const units = storedUnits(raw, d.measure);
      values[d.kpiCode] = unitsToNumber(units, d.measure);
      stats[i].totalRaw += raw;
      storedSums[i] += units;
      if (units !== 0n) stats[i].outletsNonZero++;
      if (units < 0n) stats[i].outletsNegative++;
    });
    const zeroFilled = !acc.hasLines(code);
    if (zeroFilled) zeroFillOutlets++;
    rows.push({ outletCode: code, outletName: meta.name, values, zeroFilled });
  }
  // Real-DB finding 2: the total is the sum of the per-outlet values that are actually STORED (each rounded once), so a
  // re-apply of identical data shows Δ 0 and the audit "after" total equals what OutletSalesRecord holds.
  defs.forEach((d, i) => (stats[i].total = unitsToNumber(storedSums[i], d.measure)));
  return { rows, stats, zeroFillOutlets, split, matchedOutletCodes: matched, ...(days ? { days } : {}) };
}

/**
 * A raw BigInt value → the integer units the STORED value has: paise (₹, exact), thousandths of a case (rounded
 * once), or the product count itself (PRODUCT_COUNT — already an integer).
 */
export function storedUnits(raw: bigint, measure: KpiDefLite['measure']): bigint {
  switch (measure) {
    case 'AMOUNT':
      return raw;
    case 'QUANTITY':
      return divRoundHalfAway(raw, QTY_SCALE / 1000n);
    case 'PRODUCT_COUNT':
      return raw;
    default:
      return assertNeverMeasure(measure);
  }
}
export function unitsToNumber(units: bigint, measure: KpiDefLite['measure']): number {
  switch (measure) {
    case 'AMOUNT':
      return Number(units) / 100;
    case 'QUANTITY':
      return Number(units) / 1000;
    case 'PRODUCT_COUNT':
      return Number(units);
    default:
      return assertNeverMeasure(measure);
  }
}

/** Σ of the owned keys across the month's CURRENT OutletSalesRecord rows (numeric values only). */
export function sumOwnedValues(
  rows: Array<{ kpiValues: Prisma.JsonValue }>,
  owned: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(owned.map((k) => [k, 0]));
  for (const r of rows) {
    const v = r.kpiValues;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    for (const k of owned) {
      const n = (v as Record<string, unknown>)[k];
      const num = typeof n === 'number' ? n : typeof n === 'string' && n.trim() !== '' ? Number(n) : NaN;
      if (Number.isFinite(num)) out[k] += num;
    }
  }
  for (const k of owned) out[k] = Math.round(out[k] * 1e6) / 1e6;
  return out;
}
