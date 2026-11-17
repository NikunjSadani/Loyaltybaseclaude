/**
 * Billing comparison — "MTD vs last month to the same day" and "MTD vs the 3-month average to the same day"
 * for the admin "Monthly billing progress" card, plus the "billing slower than usual" outlet list.
 * Shared by GET /v1/admin/dashboard/billing-progress/comparison(/slower-outlets) and the
 * 'billing-comparison-slower' export kind (screen and Excel can never disagree). Plain functions over
 * PrismaService (no Nest DI) so the export worker can run it from `ctx.prisma`.
 *
 * REUSE (never re-derived here): filters, the outlet universe (live roster, program / outlet-type / manager
 * filters, KPI applies-to scope) and the report KPI all come from `loadBillingProgress`. The comparison
 * population = that loader's `inScope` outlets (positive target for the SELECTED month), and the SAME
 * outlets are measured in every prior month — like-for-like, so a newly-targeted outlet never inflates the
 * current figure against a smaller prior population.
 *
 * Day data (written by the sales importer): OutletSalesDay rows hold the CUMULATIVE month-to-date as of the
 * end of that day, sparse (rows only on billing days); SalesDaySet says a month has day data, up to `lastDay`.
 *   MTD(outlet, month, D) = mtdValues[kpi] of the outlet's LATEST row in the month with day ≤ D, else 0.
 *
 * Day alignment: D = the selected month's data day (SalesDaySet.lastDay; for the CURRENT month capped at
 * today's IST day — a future-dated invoice must not compare against days that haven't happened). Each prior
 * month is read at min(D, that month's length) (31 Mar → 28/29 Feb, 31 → 30). A prior month is AVAILABLE only
 * when its SalesDaySet exists AND its lastDay ≥ that aligned day; otherwise the comparison is unavailable and
 * `availableFrom` names the first month for which it will be.
 *
 * Queries: loadBillingProgress (≈9, parallel) + 1 client flag + 1 SalesDaySet list + ≤4 day reads (one per
 * month, ALL outlets of the tenant in one statement — never per outlet), all parallel.
 */
import type { PrismaService } from '../../prisma/prisma.service';
import { istDateKey, istMonthKey } from '../../common/ist-date';
import {
  type BillingProgressFilters,
  type BillingOutletRow,
  daysInMonthOf,
  loadBillingProgress,
} from './billing-progress';

/** "Slower than usual" = current MTD below this % of the outlet's own last-month MTD to the same day. */
export const SLOWER_THRESHOLD_PCT = 80;

/** Why the whole comparison is unavailable (null = it was computed). */
export type ComparisonReason =
  /** The tenant has no day-level sales data (not a Sales Import tenant). The UI shows nothing. */
  | 'NO_DAY_LEVEL_DATA'
  /** No enabled KPI — the billing card itself is hidden. */
  | 'NO_KPI'
  /** The selected month has no day-level data (yet). */
  | 'NO_DAY_DATA_FOR_MONTH'
  /** The month has day data, but none of it carries the report KPI (the importer doesn't own that KPI). */
  | 'KPI_NOT_IN_DAY_DATA';

/** Why ONE comparison (last month / 3-month average) is unavailable. */
export type PriorReason = 'NO_DAY_DATA' | 'DAY_DATA_INCOMPLETE';

// ─── Month / day arithmetic ─────────────────────────────────────────────────────────────────────

/** Shift a 'YYYY-MM' key by `delta` months. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** Day D of the selected month, aligned into `month` (clamped to its length: 31 → 30, 31/30/29 → 28 in Feb). */
export function alignedDay(day: number, month: string): number {
  return Math.min(day, daysInMonthOf(month));
}

/** Prior month `month` is usable at day D iff it has a day set whose lastDay reaches the aligned day. */
export function priorStatus(sets: ReadonlyMap<string, number>, month: string, day: number): { available: boolean; day: number; reason: PriorReason | null } {
  const d = alignedDay(day, month);
  const last = sets.get(month);
  if (last === undefined) return { available: false, day: d, reason: 'NO_DAY_DATA' };
  if (last < d) return { available: false, day: d, reason: 'DAY_DATA_INCOMPLETE' };
  return { available: true, day: d, reason: null };
}

/**
 * The first month (after `selected`) whose `k` preceding months will all have day data: a month counts when it
 * already has a SalesDaySet, or is the current IST month or later (its data is still to arrive). A PAST month
 * with no set never gains one (day data starts with the importer), so it pushes the date out.
 */
export function availableFromMonth(sets: ReadonlyMap<string, number>, selected: string, k: number, currentMonth: string): string {
  const willHave = (m: string) => sets.has(m) || m >= currentMonth;
  let x = shiftMonth(selected, 1);
  // Bounded: once x - k ≥ currentMonth every month in the window qualifies.
  for (let i = 0; i < 1200; i++, x = shiftMonth(x, 1)) {
    let ok = true;
    for (let j = 1; j <= k && ok; j++) ok = willHave(shiftMonth(x, -j));
    if (ok) return x;
  }
  return x;
}

/** (current − prior) / prior × 100 at 1 dp; null when prior ≤ 0 (no meaningful base — a negative base flips the sign). */
export function deltaPct(current: number, prior: number): number | null {
  if (!(prior > 0)) return null;
  const v = Math.round(((current - prior) / prior) * 1000) / 10;
  return Object.is(v, -0) ? 0 : v;
}

/** current ÷ prior × 100, FLOORED to 1 dp (79.96 → 79.9, never a rounded-up 80.0 that contradicts "below 80%"). */
export function ratioPct(current: number, prior: number): number {
  const v = Math.floor((current / prior) * 1000) / 10;
  return Object.is(v, -0) ? 0 : v;
}

// ─── Day data reads ─────────────────────────────────────────────────────────────────────────────

/** Every SalesDaySet of the tenant as month → lastDay (one row per month — tiny). */
export async function loadDaySets(prisma: PrismaService, clientId: string): Promise<Map<string, number>> {
  const rows = await prisma.salesDaySet.findMany({ where: { clientId }, select: { month: true, lastDay: true } });
  return new Map((rows ?? []).map((r) => [r.month, Number(r.lastDay)]));
}

/**
 * MTD of `kpiCode` per outlet code for (month, day): each outlet's LATEST row with day ≤ `day`.
 *
 * Raw SQL, justified: the Prisma query API has no "latest row per group ≤ D" — `distinct` + `orderBy` would
 * work but Prisma applies `distinct` in memory after fetching EVERY row ≤ D (≈ outlets × billing days, ~160k
 * at Bajaj per month), and it cannot pull one key out of the JSON map. `DISTINCT ON` returns exactly one row
 * per outlet straight from Postgres (table `outlet_sales_days`, the @@map of OutletSalesDay), served by the
 * @@index(clientId, month, day) / @@unique(clientId, outletId, month, day) indexes.
 * Tenant-scoped by `clientId`; every value is a bound parameter (no string interpolation).
 * A row whose map lacks the key comes back as v = NULL (counted as 0, and reported via `hasKey`).
 */
export async function loadMtdByOutlet(
  prisma: PrismaService,
  clientId: string,
  month: string,
  day: number,
  kpiCode: string,
): Promise<{ byCode: Map<string, number>; rows: number; hasKey: boolean }> {
  const rows = await prisma.$queryRaw<Array<{ outletCode: string; v: string | null }>>`
    SELECT DISTINCT ON (d."outletId") d."outletCode" AS "outletCode", (d."mtdValues" ->> ${kpiCode}) AS v
    FROM "outlet_sales_days" d
    WHERE d."clientId" = ${clientId} AND d."month" = ${month} AND d."day" <= ${day}
    ORDER BY d."outletId", d."day" DESC`;
  const byCode = new Map<string, number>();
  let hasKey = false;
  for (const r of rows ?? []) {
    if (r.v !== null && r.v !== undefined) hasKey = true;
    const n = Number(r.v);
    byCode.set(r.outletCode, (byCode.get(r.outletCode) ?? 0) + (Number.isFinite(n) ? n : 0));
  }
  return { byCode, rows: rows?.length ?? 0, hasKey };
}

/** The tenant's `features.salesImport` (strict true; INACTIVE client = off). */
export async function readSalesImportFlag(prisma: PrismaService, clientId: string): Promise<boolean> {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { features: true, status: true } });
  const f = c?.features;
  return !!c && c.status !== 'INACTIVE' && !!f && typeof f === 'object' && !Array.isArray(f) && (f as Record<string, unknown>).salesImport === true;
}

// ─── Loader ─────────────────────────────────────────────────────────────────────────────────────

export interface SlowerRow {
  outletCode: string;
  outletName: string;
  program: string | null;
  soName: string | null;
  asmName: string | null;
  currentMtd: number;
  lastMonthMtd: number;
  ratioPct: number;
  /** Unrounded ratio — the sort key. */
  rawRatio: number;
}

export interface LastMonthComparison {
  available: boolean;
  /** First month for which this comparison will be available (null when available or never meaningful). */
  availableFrom: string | null;
  reason: PriorReason | null;
  month: string;
  /** The day the prior month is read at (min(D, its length)); null when there is no D. */
  compareDay: number | null;
  mtd: number | null;
  deltaPct: number | null;
}

export interface ThreeMonthComparison {
  available: boolean;
  availableFrom: string | null;
  reason: PriorReason | null;
  months: string[];
  compareDays: Array<number | null>;
  /** Each month's MTD (null for an unavailable month). */
  monthMtds: Array<number | null>;
  avgMtd: number | null;
  deltaPct: number | null;
}

export interface BillingComparisonData {
  month: string;
  kpi: { code: string; label: string; unit: string } | null;
  reason: ComparisonReason | null;
  compareDay: number | null;
  current: { mtd: number | null; outlets: number };
  lastMonth: LastMonthComparison;
  threeMonthAvg: ThreeMonthComparison;
  slowerThanUsual: { count: number; thresholdPct: number };
  slowerRows: SlowerRow[];
  managerName: string | null;
}

function sumOver(rows: readonly BillingOutletRow[], byCode: Map<string, number>): number {
  let s = 0;
  for (const r of rows) s += byCode.get(r.outletCode) ?? 0;
  return s;
}

export async function loadBillingComparison(
  prisma: PrismaService,
  clientId: string,
  f: BillingProgressFilters,
  now: Date,
): Promise<BillingComparisonData> {
  const month = f.month ?? istMonthKey(now);
  const currentMonth = istMonthKey(now);
  const priorMonths = [1, 2, 3].map((k) => shiftMonth(month, -k));

  const [billing, flagOn, sets] = await Promise.all([
    loadBillingProgress(prisma, clientId, { ...f, month }, now),
    readSalesImportFlag(prisma, clientId),
    loadDaySets(prisma, clientId),
  ]);

  const kpi = billing.kpi;
  const population = billing.inScope;
  const lastMonth: LastMonthComparison = {
    available: false, availableFrom: null, reason: null, month: priorMonths[0], compareDay: null, mtd: null, deltaPct: null,
  };
  const threeMonthAvg: ThreeMonthComparison = {
    available: false, availableFrom: null, reason: null, months: priorMonths,
    compareDays: [null, null, null], monthMtds: [null, null, null], avgMtd: null, deltaPct: null,
  };
  const base = {
    month,
    kpi,
    compareDay: null as number | null,
    current: { mtd: null as number | null, outlets: population.length },
    lastMonth,
    threeMonthAvg,
    slowerThanUsual: { count: 0, thresholdPct: SLOWER_THRESHOLD_PCT },
    slowerRows: [] as SlowerRow[],
    managerName: billing.managerName,
  };

  if (!kpi) return { ...base, reason: 'NO_KPI' };
  // Day-level data exists iff the tenant imports sales (flag) or ever did (sets left from a flag-on period).
  if (!flagOn && sets.size === 0) return { ...base, reason: 'NO_DAY_LEVEL_DATA' };

  const selectedLast = sets.get(month);
  if (selectedLast === undefined || !(selectedLast >= 1)) {
    lastMonth.availableFrom = availableFromMonth(sets, month, 1, currentMonth);
    threeMonthAvg.availableFrom = availableFromMonth(sets, month, 3, currentMonth);
    lastMonth.reason = 'NO_DAY_DATA';
    threeMonthAvg.reason = 'NO_DAY_DATA';
    return { ...base, reason: 'NO_DAY_DATA_FOR_MONTH' };
  }

  let D = Math.min(selectedLast, daysInMonthOf(month));
  if (month === currentMonth) D = Math.min(D, Number(istDateKey(now).slice(8, 10)));
  D = Math.max(1, D);

  const statuses = priorMonths.map((p) => priorStatus(sets, p, D));
  const reads = await Promise.all([
    loadMtdByOutlet(prisma, clientId, month, D, kpi.code),
    ...statuses.map((s, i) => (s.available ? loadMtdByOutlet(prisma, clientId, priorMonths[i], s.day, kpi.code) : Promise.resolve(null))),
  ]);
  const cur = reads[0]!;
  const prior = reads.slice(1);

  if (cur.rows > 0 && !cur.hasKey) {
    return { ...base, compareDay: D, reason: 'KPI_NOT_IN_DAY_DATA' };
  }

  const currentMtd = sumOver(population, cur.byCode);

  // Last month.
  const s1 = statuses[0];
  lastMonth.compareDay = s1.day;
  if (s1.available && prior[0]) {
    lastMonth.available = true;
    lastMonth.mtd = sumOver(population, prior[0].byCode);
    lastMonth.deltaPct = deltaPct(currentMtd, lastMonth.mtd);
  } else {
    lastMonth.reason = s1.reason;
    lastMonth.availableFrom = availableFromMonth(sets, month, 1, currentMonth);
  }

  // 3-month average (all three months needed — an average of fewer months isn't what the label says).
  threeMonthAvg.compareDays = statuses.map((s) => s.day);
  threeMonthAvg.monthMtds = prior.map((p) => (p ? sumOver(population, p.byCode) : null));
  if (statuses.every((s) => s.available)) {
    threeMonthAvg.available = true;
    const mtds = threeMonthAvg.monthMtds as number[];
    threeMonthAvg.avgMtd = (mtds[0] + mtds[1] + mtds[2]) / 3;
    threeMonthAvg.deltaPct = deltaPct(currentMtd, threeMonthAvg.avgMtd);
  } else {
    threeMonthAvg.reason = statuses.find((s) => !s.available)!.reason;
    threeMonthAvg.availableFrom = availableFromMonth(sets, month, 3, currentMonth);
  }

  // Slower than usual: own last-month MTD to the same day > 0 and current < 80% of it.
  const slowerRows: SlowerRow[] = [];
  if (lastMonth.available && prior[0]) {
    for (const r of population) {
      const last = prior[0].byCode.get(r.outletCode) ?? 0;
      if (!(last > 0)) continue;
      const now_ = cur.byCode.get(r.outletCode) ?? 0;
      const raw = (now_ / last) * 100;
      if (!(raw < SLOWER_THRESHOLD_PCT)) continue;
      slowerRows.push({
        outletCode: r.outletCode,
        outletName: r.outletName,
        program: r.program,
        soName: r.soName,
        asmName: r.asmName,
        currentMtd: now_,
        lastMonthMtd: last,
        ratioPct: ratioPct(now_, last),
        rawRatio: raw,
      });
    }
    slowerRows.sort((a, b) => a.rawRatio - b.rawRatio || b.lastMonthMtd - a.lastMonthMtd || a.outletCode.localeCompare(b.outletCode));
  }

  return {
    ...base,
    reason: null,
    compareDay: D,
    current: { mtd: currentMtd, outlets: population.length },
    slowerThanUsual: { count: slowerRows.length, thresholdPct: SLOWER_THRESHOLD_PCT },
    slowerRows,
  };
}

// ─── Response shapes ────────────────────────────────────────────────────────────────────────────

export function summarizeBillingComparison(d: BillingComparisonData) {
  const { slowerRows: _rows, managerName: _m, ...rest } = d;
  return rest;
}

export function publicSlowerRow(r: SlowerRow) {
  const { rawRatio: _raw, ...rest } = r;
  return rest;
}
