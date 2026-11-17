/**
 * Billing comparison — "MTD vs last month to the same day" and "MTD vs the 3-month average to the same day"
 * for the admin "Monthly billing progress" card, plus the "billing slower than usual" outlet list.
 * Shared by GET /v1/admin/dashboard/billing-progress/comparison(/slower-outlets) and the
 * 'billing-comparison-slower' export kind (screen and Excel can never disagree — the plain-words `message`s are built
 * HERE and shown verbatim by both). Plain functions over PrismaService (no Nest DI) so the export worker can run it.
 *
 * REUSE (never re-derived here): filters, the outlet universe (live roster, program / outlet-type / manager
 * filters, KPI applies-to scope) and the report KPI all come from `loadBillingProgress` (or the billing-progress
 * service's CACHED result for the same tenant + filters, via `opts.loadBilling`). The comparison population = that
 * loader's `inScope` outlets (positive target for the SELECTED month), and the SAME outlets are measured in every
 * prior month — like-for-like, so a newly-targeted outlet never inflates the current figure.
 *
 * Day data (written by the sales importer): OutletSalesDay rows hold the CUMULATIVE month-to-date as of the
 * end of that day, sparse (rows only on billing days); SalesDaySet says a month has day data. Day data is kept for
 * the retention window only (sales-import/retention-window.ts: current IST month + 3 before it); sets older than the
 * cutoff are ignored even while the sweep is still deleting them.
 *   MTD(outlet, month, D) = mtdValues[kpi] of the outlet's LATEST row in the month with day ≤ D, else 0.
 *
 * Month coverage (C1): SalesDaySet.lastDay is the last INVOICE day in the applied file — not how far the file
 * reaches. A month whose applied file was taken AFTER the month ended (the file also carries a later month's
 * invoices, or it was uploaded in a later IST month — read from the source SalesImport) is COMPLETE: covered to its
 * last calendar day (a month ending on a non-billing Sunday stays usable at day 31). Otherwise it is covered only to
 * `lastDay`.
 *
 * Day alignment: D = the selected month's covered day (for the CURRENT month capped at today's IST day). Each prior
 * month is read at min(D, its length). A prior month is AVAILABLE only when it is inside the retention window, on or
 * after the first day-data month, has a SalesDaySet covering the aligned day, AND its day data carries the KPI.
 *
 * Queries: 1 client flag + 1 SalesDaySet list (+ 1 SalesImport list of ≤ 4 source imports) FIRST — a tenant without
 * day data stops there (no billing load). Then the billing universe (cached) + ≤ 4 day reads (one per month, ALL
 * outlets of the tenant in one DISTINCT ON statement served by the ordered index
 * outlet_sales_days(clientId, month, outletId, day DESC)), + a 1-row KPI probe only for a month with no row ≤ D.
 */
import type { PrismaService } from '../../prisma/prisma.service';
import { istDateKey, istMonthKey } from '../../common/ist-date';
import { historyCutoffMonth, historyRetentionMonths } from '../../sales-import/retention-window';
import { monthLabel } from '../../sales-import/months/month-state';
import {
  type BillingProgressData,
  type BillingProgressFilters,
  type BillingOutletRow,
  daysInMonthOf,
  loadBillingProgress,
} from './billing-progress';

/** "Slower than usual" = current MTD below this % of the outlet's own last-month MTD to the same day. */
export const SLOWER_THRESHOLD_PCT = 80;

/** The first month that has day-by-day sales at all (the day-level feature and its one-off rebuild start here). */
export const DAY_DATA_START_MONTH = '2026-11';

/** Why the whole comparison is unavailable (null = it was computed). */
export type ComparisonReason =
  /** The tenant has no day-level sales data in the window (and doesn't import sales). The UI shows nothing. */
  | 'NO_DAY_LEVEL_DATA'
  /** No enabled KPI — the billing card itself is hidden. */
  | 'NO_KPI'
  /** No outlet has a target for the filters — nothing to compare. */
  | 'NO_TARGETED_OUTLETS'
  /** The selected month has no usable day-level data (`monthDataReason` says why). */
  | 'NO_DAY_DATA_FOR_MONTH'
  /** The month has day data, but none of it carries the report KPI (the importer doesn't own that KPI). */
  | 'KPI_NOT_IN_DAY_DATA';

/** Why ONE month's day data can't be used. */
export type PriorReason =
  /** (a) before day-by-day sales existed at all. */
  | 'BEFORE_DAY_DATA'
  /** (b) deleted by the retention window. */
  | 'DELETED_BY_RETENTION'
  /** a past month in the window that has no day data (e.g. applied without it). */
  | 'NO_DAY_DATA'
  /** (c) the current / a future month whose data hasn't arrived yet. */
  | 'NOT_YET'
  /** the month's data doesn't reach the aligned day (file taken before the month ended). */
  | 'DAY_DATA_INCOMPLETE'
  /** the month's day data doesn't carry the report KPI. */
  | 'KPI_NOT_IN_DAY_DATA';

/** One month's day data: the last invoice day, and how far the applied file covers the month. */
export interface DaySetInfo {
  lastDay: number;
  /** The applied file was taken after the month ended → covered to the month's last day. */
  complete: boolean;
}

export interface MonthContext {
  currentMonth: string;
  /** Oldest month still kept (inclusive). */
  cutoff: string;
  startMonth: string;
  retentionMonths: number;
}

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

/** The last day of `month` the day data covers (month end when complete, else the last invoice day). */
export function coveredTo(info: DaySetInfo, month: string): number {
  return info.complete ? daysInMonthOf(month) : Math.min(info.lastDay, daysInMonthOf(month));
}

/** Why `month` has no usable day-data set (null = it has one). Order: (a) before the feature, (b) retention, then. */
export function missingMonthReason(sets: ReadonlyMap<string, DaySetInfo>, month: string, ctx: MonthContext): PriorReason | null {
  if (month < ctx.startMonth) return 'BEFORE_DAY_DATA';
  if (month < ctx.cutoff) return 'DELETED_BY_RETENTION';
  if (sets.has(month)) return null;
  return month >= ctx.currentMonth ? 'NOT_YET' : 'NO_DAY_DATA';
}

export interface PriorStatus {
  available: boolean;
  day: number;
  reason: PriorReason | null;
  /** The day the month's data covers to (null when it has no set). */
  coveredTo: number | null;
}

/** Prior month `month` is usable at day D iff it has a (kept) day set that covers the ALIGNED day. */
export function priorStatus(sets: ReadonlyMap<string, DaySetInfo>, month: string, day: number, ctx: MonthContext): PriorStatus {
  const d = alignedDay(day, month);
  const missing = missingMonthReason(sets, month, ctx);
  if (missing) return { available: false, day: d, reason: missing, coveredTo: null };
  const cov = coveredTo(sets.get(month)!, month);
  if (cov < d) return { available: false, day: d, reason: 'DAY_DATA_INCOMPLETE', coveredTo: cov };
  return { available: true, day: d, reason: null, coveredTo: cov };
}

/**
 * The first month AFTER `selected` whose `k` preceding months will all have day data — or null when that month is
 * already in the past (never show an "available from" date that has gone by: picking that month now is the user's
 * call, it is not something to wait for). A month "will have" data when it is on/after the first day-data month and
 * either has a kept set or is the current IST month or later (its data is still to arrive). Deleted (pre-cutoff),
 * pre-feature and past months without a set never gain one, so they push the date out. Never ≤ `selected`.
 */
export function availableFromMonth(
  sets: ReadonlyMap<string, DaySetInfo>,
  selected: string,
  k: number,
  ctx: Pick<MonthContext, 'currentMonth' | 'startMonth' | 'cutoff'>,
): string | null {
  const willHave = (m: string) => m >= ctx.startMonth && ((m >= ctx.cutoff && sets.has(m)) || m >= ctx.currentMonth);
  let x = shiftMonth(selected, 1);
  // Bounded: once x - k ≥ max(current, start) every month in the window qualifies.
  for (let i = 0; i < 1200; i++, x = shiftMonth(x, 1)) {
    let ok = true;
    for (let j = 1; j <= k && ok; j++) ok = willHave(shiftMonth(x, -j));
    if (ok) break;
  }
  if (x <= selected || x < ctx.currentMonth) return null;
  return x;
}

/**
 * (current − prior) / prior × 100 at 1 dp, rounding half AWAY from zero (+12.25 → +12.3, −12.25 → −12.3);
 * null when prior ≤ 0 (no meaningful base — a negative base flips the sign).
 */
export function deltaPct(current: number, prior: number): number | null {
  if (!(prior > 0)) return null;
  const tenths = ((current - prior) * 1000) / prior;
  // +1e-9 tenths absorbs binary representation error (100.05 is stored as 100.0499…), so a displayed half rounds
  // away from zero on both sides; it is far below any real difference at 1 dp.
  const v = (Math.sign(tenths) * Math.round(Math.abs(tenths) + 1e-9)) / 10;
  return Object.is(v, -0) ? 0 : v;
}

/** current ÷ prior × 100, FLOORED to 1 dp (79.96 → 79.9, never a rounded-up 80.0 that contradicts "below 80%"). */
export function ratioPct(current: number, prior: number): number {
  const v = Math.floor((current / prior) * 1000) / 10;
  return Object.is(v, -0) ? 0 : v;
}

// ─── Plain-words text (screen AND Excel) ────────────────────────────────────────────────────────

/** Why one month can't be used, as a clause ("day-by-day sales start from November 2026"). */
export function monthReasonClause(reason: PriorReason, month: string, ctx: MonthContext, extra: { coveredTo?: number | null; kpiLabel?: string } = {}): string {
  const M = monthLabel(month);
  switch (reason) {
    case 'BEFORE_DAY_DATA':
      return `day-by-day sales start from ${monthLabel(ctx.startMonth)}`;
    case 'DELETED_BY_RETENTION':
      return `day-by-day sales are kept for ${ctx.retentionMonths} months, and ${M} is older than that`;
    case 'NO_DAY_DATA':
      return `there are no day-by-day sales for ${M}`;
    case 'NOT_YET':
      return `there are no day-by-day sales for ${M} yet`;
    case 'DAY_DATA_INCOMPLETE':
      return `${M}'s day-by-day sales only go up to day ${extra.coveredTo ?? '—'}`;
    case 'KPI_NOT_IN_DAY_DATA':
      return `${M}'s day-by-day sales don't include ${extra.kpiLabel ?? 'this KPI'}`;
  }
}

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function availableSuffix(availableFrom: string | null): string {
  return availableFrom ? ` Available from ${monthLabel(availableFrom)}.` : '';
}

// ─── Day data reads ─────────────────────────────────────────────────────────────────────────────

interface ImportCoverage {
  id: string;
  createdAt: Date | string | null;
  monthSummaries: unknown;
}

/**
 * Is `month` complete in the import that produced its day set? The file was taken after the month ended when it
 * carries invoices of a LATER month, or it was uploaded in a later IST month.
 */
export function monthCompleteIn(imp: ImportCoverage | undefined, month: string): boolean {
  if (!imp) return false;
  const sums = Array.isArray(imp.monthSummaries) ? (imp.monthSummaries as Array<{ month?: unknown }>) : [];
  if (sums.some((s) => typeof s?.month === 'string' && s.month > month)) return true;
  if (imp.createdAt) {
    const at = new Date(imp.createdAt);
    if (!Number.isNaN(at.getTime()) && istMonthKey(at) > month) return true;
  }
  return false;
}

/**
 * The tenant's KEPT SalesDaySets (month ≥ the retention cutoff) as month → {lastDay, complete}. Completeness is read
 * from the source SalesImport rows (≤ one per month — tiny; the row and its frozen month summaries survive the
 * import's purge).
 */
export async function loadDaySets(prisma: PrismaService, clientId: string, cutoff: string): Promise<Map<string, DaySetInfo>> {
  const rows = await prisma.salesDaySet.findMany({
    where: { clientId, month: { gte: cutoff } },
    select: { month: true, lastDay: true, sourceImportId: true },
  });
  const sets = (rows ?? []).filter((r) => r.month >= cutoff);
  const ids = [...new Set(sets.map((r) => r.sourceImportId).filter((x): x is string => !!x))];
  const imports: ImportCoverage[] = ids.length
    ? ((await prisma.salesImport.findMany({
        where: { clientId, id: { in: ids } },
        select: { id: true, createdAt: true, monthSummaries: true },
      })) ?? [])
    : [];
  const byId = new Map(imports.map((i) => [i.id, i]));
  return new Map(
    sets.map((r) => [r.month, { lastDay: Number(r.lastDay), complete: monthCompleteIn(byId.get(r.sourceImportId), r.month) }]),
  );
}

export interface MonthRead {
  byCode: Map<string, number>;
  rows: number;
  /** Does the month's day data carry the KPI? null = the month has no day rows at all (nothing to say). */
  hasKey: boolean | null;
}

/**
 * MTD of `kpiCode` per outlet code for (month, day): each outlet's LATEST row with day ≤ `day`.
 *
 * Raw SQL, justified: the Prisma query API has no "latest row per group ≤ D" — `distinct` + `orderBy` would
 * work but Prisma applies `distinct` in memory after fetching EVERY row ≤ D (≈ outlets × billing days, ~160k
 * at Bajaj per month), and it cannot pull one key out of the JSON map. `DISTINCT ON` returns exactly one row
 * per outlet straight from Postgres (table `outlet_sales_days`, the @@map of OutletSalesDay). Expected plan:
 *   Unique → Index Scan using outlet_sales_days_clientId_month_outletId_day_idx
 *            Index Cond: ("clientId" = $2 AND "month" = $3 AND "day" <= $4)
 * — the (clientId, month, outletId, day DESC) index already yields rows in the ORDER BY, so no Sort node.
 * When no row is ≤ D, a one-row probe says whether the month's day data carries the KPI at all (so a month that
 * never had the KPI is UNAVAILABLE, never a fake 0).
 * Tenant-scoped by `clientId`; every value is a bound parameter (no string interpolation).
 */
export async function loadMtdByOutlet(
  prisma: PrismaService,
  clientId: string,
  month: string,
  day: number,
  kpiCode: string,
): Promise<MonthRead> {
  const rows = await prisma.$queryRaw<Array<{ outletCode: string; v: string | null }>>`
    SELECT DISTINCT ON (d."outletId") d."outletCode" AS "outletCode", (d."mtdValues" ->> ${kpiCode}) AS v
    FROM "outlet_sales_days" d
    WHERE d."clientId" = ${clientId} AND d."month" = ${month} AND d."day" <= ${day}
    ORDER BY d."outletId", d."day" DESC`;
  const byCode = new Map<string, number>();
  let hasKey: boolean | null = null;
  for (const r of rows ?? []) {
    if (r.v !== null && r.v !== undefined) hasKey = true;
    else if (hasKey === null) hasKey = false;
    const n = Number(r.v);
    byCode.set(r.outletCode, (byCode.get(r.outletCode) ?? 0) + (Number.isFinite(n) ? n : 0));
  }
  if (!rows?.length) {
    const probe = await prisma.$queryRaw<Array<{ anyRow: boolean; withKey: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM "outlet_sales_days" p WHERE p."clientId" = ${clientId} AND p."month" = ${month}) AS "anyRow",
             EXISTS (SELECT 1 FROM "outlet_sales_days" p WHERE p."clientId" = ${clientId} AND p."month" = ${month}
                       AND jsonb_exists(p."mtdValues", ${kpiCode})) AS "withKey"`;
    const p = probe?.[0];
    hasKey = p?.anyRow ? !!p.withKey : null;
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
  /** First month (≥ the current month) for which this comparison will be available; null when available / not to wait for. */
  availableFrom: string | null;
  reason: PriorReason | null;
  /** Plain-words line when unavailable (shown verbatim on screen and in the Excel About sheet). */
  message: string | null;
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
  message: string | null;
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
  /** Why the SELECTED month has no usable day data (only with reason NO_DAY_DATA_FOR_MONTH). */
  monthDataReason: PriorReason | null;
  /** Plain-words line for `reason` (null when computed). */
  message: string | null;
  compareDay: number | null;
  current: { mtd: number | null; outlets: number };
  lastMonth: LastMonthComparison;
  threeMonthAvg: ThreeMonthComparison;
  slowerThanUsual: { count: number; thresholdPct: number };
  slowerRows: SlowerRow[];
  managerName: string | null;
}

export interface BillingComparisonOptions {
  /** The billing universe for the SAME tenant + filters (e.g. the billing-progress service's cached load). */
  loadBilling?: () => Promise<BillingProgressData>;
  /** Override of DAY_DATA_START_MONTH (tests). */
  dayDataStartMonth?: string;
  /** Override of the retention window length (default: the sales-import setting). */
  retentionMonths?: number;
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
  opts: BillingComparisonOptions = {},
): Promise<BillingComparisonData> {
  const month = f.month ?? istMonthKey(now);
  const currentMonth = istMonthKey(now);
  const retentionMonths = opts.retentionMonths ?? historyRetentionMonths();
  const ctx: MonthContext = {
    currentMonth,
    cutoff: historyCutoffMonth(currentMonth, retentionMonths),
    startMonth: opts.dayDataStartMonth ?? DAY_DATA_START_MONTH,
    retentionMonths,
  };
  const priorMonths = [1, 2, 3].map((k) => shiftMonth(month, -k));

  const lastMonth: LastMonthComparison = {
    available: false, availableFrom: null, reason: null, message: null, month: priorMonths[0], compareDay: null, mtd: null, deltaPct: null,
  };
  const threeMonthAvg: ThreeMonthComparison = {
    available: false, availableFrom: null, reason: null, message: null, months: priorMonths,
    compareDays: [null, null, null], monthMtds: [null, null, null], avgMtd: null, deltaPct: null,
  };
  const base = {
    month,
    kpi: null as BillingComparisonData['kpi'],
    monthDataReason: null as PriorReason | null,
    compareDay: null as number | null,
    current: { mtd: null as number | null, outlets: 0 },
    lastMonth,
    threeMonthAvg,
    slowerThanUsual: { count: 0, thresholdPct: SLOWER_THRESHOLD_PCT },
    slowerRows: [] as SlowerRow[],
    managerName: null as string | null,
  };

  // C6: the cheap check FIRST — a tenant with no kept day data that doesn't import sales stops here (no billing load).
  const [flagOn, sets] = await Promise.all([readSalesImportFlag(prisma, clientId), loadDaySets(prisma, clientId, ctx.cutoff)]);
  if (!flagOn && sets.size === 0) {
    return {
      ...base,
      reason: 'NO_DAY_LEVEL_DATA',
      message: 'This program has no day-by-day sales data, so month-to-date comparisons are not available.',
    };
  }

  const billing = await (opts.loadBilling ? opts.loadBilling() : loadBillingProgress(prisma, clientId, { ...f, month }, now));
  const kpi = billing.kpi;
  const population = billing.inScope;
  base.kpi = kpi;
  base.managerName = billing.managerName;
  base.current.outlets = population.length;

  if (!kpi) return { ...base, reason: 'NO_KPI', message: 'No enabled KPI — nothing to compare.' };
  if (population.length === 0) {
    return { ...base, reason: 'NO_TARGETED_OUTLETS', message: 'No outlets have a target for these filters.' };
  }

  const M = monthLabel(month);
  /** Fill one comparison's unavailable state (reason, message, availableFrom). */
  const unavailable = (
    c: LastMonthComparison | ThreeMonthComparison,
    k: number,
    lead: string,
    blocker: { reason: PriorReason; month: string; coveredTo?: number | null },
  ) => {
    c.reason = blocker.reason;
    c.availableFrom = availableFromMonth(sets, month, k, ctx);
    c.message = `${lead}: ${monthReasonClause(blocker.reason, blocker.month, ctx, { coveredTo: blocker.coveredTo, kpiLabel: kpi.label })}.${availableSuffix(c.availableFrom)}`;
  };
  const LM_LEAD = 'Comparison with last month not available';
  const AVG_LEAD = '3-month average not available';

  // The selected month itself.
  const selMissing = missingMonthReason(sets, month, ctx);
  if (selMissing) {
    for (const [c, k, lead] of [[lastMonth, 1, LM_LEAD], [threeMonthAvg, 3, AVG_LEAD]] as const) {
      unavailable(c, k, lead, { reason: selMissing, month });
    }
    return {
      ...base,
      reason: 'NO_DAY_DATA_FOR_MONTH',
      monthDataReason: selMissing,
      message: `${capitalise(monthReasonClause(selMissing, month, ctx))}, so ${M} can't be compared with earlier months.`,
    };
  }

  let D = coveredTo(sets.get(month)!, month);
  if (month === currentMonth) D = Math.min(D, Number(istDateKey(now).slice(8, 10)));
  D = Math.max(1, D);

  const statuses = priorMonths.map((p) => priorStatus(sets, p, D, ctx));
  const reads = await Promise.all([
    loadMtdByOutlet(prisma, clientId, month, D, kpi.code),
    ...statuses.map((s, i) => (s.available ? loadMtdByOutlet(prisma, clientId, priorMonths[i], s.day, kpi.code) : Promise.resolve(null))),
  ]);
  const cur = reads[0]!;
  const prior = reads.slice(1);

  if (cur.hasKey === false) {
    return {
      ...base,
      compareDay: D,
      reason: 'KPI_NOT_IN_DAY_DATA',
      message: `The day-by-day sales data for ${M} doesn't include ${kpi.label}, so it can't be compared with earlier months.`,
    };
  }
  // C2: a prior month whose day data lacks the KPI is UNAVAILABLE (never counted as 0).
  statuses.forEach((s, i) => {
    if (s.available && prior[i]?.hasKey === false) {
      s.available = false;
      s.reason = 'KPI_NOT_IN_DAY_DATA';
      prior[i] = null;
    }
  });

  const currentMtd = sumOver(population, cur.byCode);

  // Last month.
  const s1 = statuses[0];
  lastMonth.compareDay = s1.day;
  if (s1.available && prior[0]) {
    lastMonth.available = true;
    lastMonth.mtd = sumOver(population, prior[0].byCode);
    lastMonth.deltaPct = deltaPct(currentMtd, lastMonth.mtd);
  } else {
    unavailable(lastMonth, 1, LM_LEAD, { reason: s1.reason!, month: priorMonths[0], coveredTo: s1.coveredTo });
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
    const i = statuses.findIndex((s) => !s.available);
    unavailable(threeMonthAvg, 3, AVG_LEAD, { reason: statuses[i].reason!, month: priorMonths[i], coveredTo: statuses[i].coveredTo });
  }

  // Slower than usual: own last-month MTD to the same day > 0 and current < 80% of it (needs last month AVAILABLE).
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
    message: null,
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
