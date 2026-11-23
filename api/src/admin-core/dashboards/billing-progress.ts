/**
 * Billing progress — how far each outlet is through its PRIMARY-KPI monthly target, bucketed.
 * Shared by GET /v1/admin/dashboard/billing-progress(/outlets) and the 'billing-progress-outlets'
 * export kind (so the screen and the Excel can never disagree). No Nest DI here — plain functions
 * over PrismaService so the export worker can run it from `ctx.prisma`.
 *
 * ONE KPI per report (never a mix of KPIs' targets in one sum). KPI choice = the platform rule
 * (sales.service team targets / partner.service trend / APPLIES-TO-TARGETING-PLAN): the tenant's
 * ENABLED KPI flagged primary; none flagged (or the flagged one disabled) → the first ENABLED KPI by
 * `order`, then `code`. No enabled KPI at all → `kpi: null` (the card is hidden).
 *
 * Join (the SAME one the partner / sales / program-health readers use): OutletTarget ⋈
 * OutletSalesRecord on (clientId, outletCode, month), values read verbatim from the JSON maps
 * keyed by KpiDef.code; outlet codes match EXACTLY as stored.
 *
 * Universe = the LIVE roster (`liveOutletWhere`: not deleted / deactivated / PARKED / NOT_INTERESTED —
 * never `isActive:true`, so KYC-pending outlets, which DO bill, are included). Nothing is dropped silently:
 *   - outlets outside the KPI's APPLIES-TO scope → `notCovered` (count + drill-down `NOT_COVERED`);
 *   - target rows whose outlet is not in the live roster → `targetsOutsideRoster` (count, tenant-wide).
 *
 * Queries: ≈9, all parallel, none per outlet (Bajaj ≈ 6.5k outlets aggregates in memory).
 */
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { istDateKey, istMonthKey } from '../../common/ist-date';
import { kpiOutletPredicate } from '../../sales/outlet-kpi-scope.helper';
import { descendantSalesUserIds } from '../../sales/sales-hierarchy-access.helper';
import { loadLastApplied } from '../../sales-import/apply/last-applied';
import { liveOutletWhere, loadAvailablePrograms, normalizeFilterParam } from './dashboard-program-filter';

// ─── Buckets ────────────────────────────────────────────────────────────────────────────────────

/**
 * Buckets on the RAW pct. `lo`/`hi` are the DISPLAY bounds (1 dp) so a shown pct can never contradict its
 * bucket (see `displayPct`).
 */
export const BILLING_BUCKETS = [
  { key: 'NOT_STARTED', label: 'Not started', lo: -Infinity, hi: 0 },
  { key: 'P0_20', label: 'Under 20%', lo: 0.1, hi: 19.9 },
  { key: 'P20_40', label: '20–39%', lo: 20, hi: 39.9 },
  { key: 'P40_60', label: '40–59%', lo: 40, hi: 59.9 },
  { key: 'P60_80', label: '60–79%', lo: 60, hi: 79.9 },
  { key: 'P80_100', label: '80–99%', lo: 80, hi: 99.9 },
  { key: 'ACHIEVED', label: 'Achieved (100%+)', lo: 100, hi: Infinity },
] as const;

export type BillingBucketKey = (typeof BILLING_BUCKETS)[number]['key'];
/** The outlets-list selector: a bucket, or the cross-cutting lists. */
export type BillingListKey = BillingBucketKey | 'BEHIND_PACE' | 'NO_TARGET' | 'NOT_COVERED';
export const BILLING_LIST_KEYS: readonly BillingListKey[] = [
  ...BILLING_BUCKETS.map((b) => b.key),
  'BEHIND_PACE',
  'NO_TARGET',
  'NOT_COVERED',
];

/**
 * True when `achieved` meets `target` — the platform's float-noise convention (platform/src/lib/pace.ts
 * `remainingOf`): an ABSOLUTE 0.005 snap on the remaining amount, never relative to the target.
 */
export function isMet(target: number, achieved: number): boolean {
  return target - achieved < 0.005;
}

/** Bucket for an outlet WITH a positive target. pct is never rounded before bucketing. */
export function bucketOf(target: number, achieved: number): BillingBucketKey {
  if (!(achieved > 0)) return 'NOT_STARTED'; // none, zero, or net-negative after returns
  if (isMet(target, achieved)) return 'ACHIEVED';
  const pct = (achieved / target) * 100;
  if (pct < 20) return 'P0_20';
  if (pct < 40) return 'P20_40';
  if (pct < 60) return 'P40_60';
  if (pct < 80) return 'P60_80';
  return 'P80_100'; // 80 ≤ pct < 100 (a met target already returned ACHIEVED)
}

/**
 * The pct SHOWN for a bucketed outlet (1 dp): floored (99.96 → 99.9, never rounded up to a misleading 100.0),
 * then clamped into the bucket's display range — so "100%+" appears only for Achieved, a started outlet never
 * reads 0.0%, and float noise at a band edge can't print a value from the neighbouring band.
 */
export function displayPct(target: number, achieved: number, bucket: BillingBucketKey): number {
  const raw = (achieved / target) * 100;
  const floored = Math.floor(raw * 10) / 10;
  const b = BILLING_BUCKETS.find((x) => x.key === bucket)!;
  const v = Math.min(b.hi, Math.max(b.lo, floored));
  return Object.is(v, -0) ? 0 : v;
}

// ─── Pace (IST, to the data date) ───────────────────────────────────────────────────────────────

export function daysInMonthOf(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export type BillingMonthStatus = 'PAST' | 'CURRENT' | 'FUTURE';

export interface BillingPace {
  monthStatus: BillingMonthStatus;
  daysInMonth: number;
  /** null = no pace (no sales data yet, or a future month). */
  daysElapsed: number | null;
  pacePct: number | null;
  /** The IST date the pace is measured to (YYYY-MM-DD); null when there is no pace. */
  paceAsOf: string | null;
  /** True only for a PAST month whose data reaches its last day ("missed target" wording). */
  fullMonth: boolean;
}

/** IST "today" as YYYY-MM-DD. */
export function istToday(now: Date): string {
  return istDateKey(now);
}

/** A data date can't be in the future: min(asOf, today). */
export function clampAsOf(asOf: string | null, now: Date): string | null {
  if (!asOf) return null;
  const today = istToday(now);
  return asOf > today ? today : asOf;
}

/** Month status of a YYYY-MM key relative to `now` (IST). */
export function monthStatusOf(month: string, now: Date): BillingMonthStatus {
  const current = istMonthKey(now);
  return month < current ? 'PAST' : month > current ? 'FUTURE' : 'CURRENT';
}

/**
 * Month pace by the IST calendar, measured to the DATA date (`upTo` = min(asOf, today)):
 *   - no data (`asOf` null) or a future month → no pace;
 *   - data reaching the month's last day (past month) → the whole month, 100%, `fullMonth` ("missed target");
 *   - otherwise (current month, or a past month whose data stops early) → the IST day of `upTo` in the month
 *     ("Data up to <date>"); pacing to the calendar would flag outlets for days not uploaded yet;
 *   - data dated before the month began → 0 days covered.
 */
export function paceFor(month: string, now: Date, asOf: string | null): BillingPace {
  const daysInMonth = daysInMonthOf(month);
  const monthStatus = monthStatusOf(month, now);
  const none = { monthStatus, daysInMonth, daysElapsed: null, pacePct: null, paceAsOf: null, fullMonth: false };
  const upTo = clampAsOf(asOf, now);
  if (!upTo || monthStatus === 'FUTURE') return none;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  if (upTo >= monthEnd) {
    return { monthStatus, daysInMonth, daysElapsed: daysInMonth, pacePct: 100, paceAsOf: monthEnd, fullMonth: true };
  }
  const daysElapsed = upTo.slice(0, 7) < month ? 0 : Number(upTo.slice(8, 10));
  return {
    monthStatus,
    daysInMonth,
    daysElapsed,
    pacePct: Math.round((daysElapsed / daysInMonth) * 100),
    paceAsOf: upTo,
    fullMonth: false,
  };
}

// ─── Filters ────────────────────────────────────────────────────────────────────────────────────

export interface BillingProgressFilters {
  /** YYYY-MM; null = the current IST month (resolved against `now` at read time). */
  month: string | null;
  program: string | null;
  outletType: string | null;
  managerId: string | null;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Validate + normalise the shared filter params (query string or stored export params). */
export function parseBillingProgressFilters(raw: unknown): BillingProgressFilters {
  const q = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const month = normalizeFilterParam(q.month, 'month');
  if (month && !MONTH_RE.test(month)) throw new BadRequestException('`month` must be YYYY-MM.');
  return {
    month,
    program: normalizeFilterParam(q.program, 'program'),
    outletType: normalizeFilterParam(q.outletType, 'outletType'),
    managerId: normalizeFilterParam(q.managerId, 'managerId'),
  };
}

/** Validate the outlets-list selector. */
export function parseBillingListKey(raw: unknown): BillingListKey {
  const v = normalizeFilterParam(raw, 'bucket');
  if (!v) throw new BadRequestException(`\`bucket\` is required (one of ${BILLING_LIST_KEYS.join(', ')}).`);
  if (!(BILLING_LIST_KEYS as readonly string[]).includes(v)) {
    throw new BadRequestException(`Unknown \`bucket\` "${v}" (one of ${BILLING_LIST_KEYS.join(', ')}).`);
  }
  return v as BillingListKey;
}

// ─── Data ───────────────────────────────────────────────────────────────────────────────────────

export interface BillingOutletRow {
  outletCode: string;
  outletName: string;
  program: string | null;
  outletType: string | null;
  soName: string | null;
  asmName: string | null;
  target: number;
  achieved: number;
  /** Display pct (1 dp, floored + clamped to the bucket — `displayPct`); null when there is no positive target. */
  pct: number | null;
  /** Set when the row's values are shown but NOT counted (outside the KPI's applies-to scope). */
  note: string | null;
  /** Unrounded pct — the sort key. */
  rawPct: number;
  bucket: BillingBucketKey | null;
  behindPace: boolean;
}

export interface BillingProgressData extends BillingPace {
  month: string;
  kpi: { code: string; label: string; unit: string } | null;
  asOf: string | null;
  /** Outlets in the filters with a positive target for the report's KPI (bucketed). */
  inScope: BillingOutletRow[];
  /** Outlets in the filters (and in the KPI's applies-to scope) with no / zero target. */
  noTarget: BillingOutletRow[];
  /** Outlets in the filters OUTSIDE the KPI's applies-to scope (no target/billing for this KPI by design). */
  notCovered: BillingOutletRow[];
  /** Positive-target rows for this KPI + month whose outlet is NOT in the live roster (tenant-wide; never counted above). */
  targetsOutsideRoster: number;
  /** The selected manager's display name (null when unfiltered / unknown). */
  managerName: string | null;
  availablePrograms: string[];
  availableOutletTypes: string[];
  availableManagers: Array<{ id: string; name: string; levelCode: string; levelName: string }>;
}

/** Shown on every NOT_COVERED row (drill-down + Excel). */
export const NOT_COVERED_NOTE = 'Not counted — outside this target’s scope';

/** Field-level / manager-level codes used for the list's SO / ASM columns (internal role codes are tenant-stable). */
const SO_CODE = 'SO';
const ASM_CODE = 'ASM';

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The live roster (same condition the program filter's partner match uses). */
function addressableWhere(clientId: string): Prisma.OutletWhereInput {
  return { clientId, ...liveOutletWhere() };
}

/** Platform primary-KPI rule over ENABLED KPIs already sorted by order, code. */
export function pickReportKpi<T extends { isPrimary: boolean }>(enabledSorted: readonly T[]): T | null {
  return enabledSorted.find((k) => k.isPrimary) ?? enabledSorted[0] ?? null;
}

// ─── Shared per-outlet rules (also used by the Target vs Sales report, so the two can never disagree) ──────────

/** A KPI value read from an OutletTarget.targetValues / OutletSalesRecord.kpiValues JSON map (absent / junk → 0). */
export function billingKpiValue(values: unknown, code: string): number {
  return num((values as Record<string, unknown> | null | undefined)?.[code]);
}

/** Where one outlet lands on the billing card for one month. */
export type BillingOutletClass =
  | { kind: 'NOT_COVERED' }
  | { kind: 'NO_TARGET' }
  | { kind: 'BUCKET'; bucket: BillingBucketKey; rawPct: number };

/**
 * The card's per-outlet rule: outside the KPI's applies-to scope → NOT_COVERED; a positive target → its bucket
 * (`bucketOf`, raw pct); otherwise (no / zero / negative target) → NO_TARGET. `appliesTo` = kpiOutletPredicate(kpi)
 * (undefined = unscoped KPI = applies everywhere). Facets are the outlet master's raw values.
 */
export function classifyBillingOutlet(
  appliesTo: ((o: { outletType: string | null; program: string | null; subProgram: string | null }) => boolean) | undefined,
  facets: { outletType: string | null; program: string | null; subProgram: string | null },
  target: number,
  achieved: number,
): BillingOutletClass {
  if (appliesTo && !appliesTo(facets)) return { kind: 'NOT_COVERED' };
  if (target > 0) return { kind: 'BUCKET', bucket: bucketOf(target, achieved), rawPct: (achieved / target) * 100 };
  return { kind: 'NO_TARGET' };
}

/** The minimal sales-user shape the manager filter needs (soft-deleted users INCLUDED — see G3 below). */
export interface BillingManagerUser {
  id: string;
  reportingToId: string | null;
  deletedAt: Date | null;
  employeeCode: string;
  user?: { name: string | null } | null;
}

/**
 * The card's sales-manager filter: the manager's WHOLE downline (descendantSalesUserIds over every sales user,
 * soft-deleted included so the walk passes THROUGH a resigned manager). No `managerId` → `downline: null` (no
 * filter). An unknown / other-tenant / deleted manager id → an EMPTY downline (matches nothing — never their old team).
 */
export function resolveBillingManagerScope(
  salesUsers: readonly BillingManagerUser[],
  managerId: string | null,
): { downline: Set<string> | null; managerName: string | null } {
  if (!managerId) return { downline: null, managerName: null };
  const candidate = salesUsers.find((u) => u.id === managerId);
  const selected = candidate && candidate.deletedAt == null ? candidate : undefined;
  if (!selected) return { downline: new Set<string>(), managerName: null };
  return {
    downline: descendantSalesUserIds(
      managerId,
      salesUsers.map((u) => ({ id: u.id, reportingToId: u.reportingToId, deletedAt: u.deletedAt ?? null })),
    ),
    managerName: selected.user?.name || selected.employeeCode,
  };
}

/**
 * The card's program / outlet-type / manager filters for ONE outlet. `repIds` = the outlet's CURRENT direct
 * assignments (SalesUserAssignment by outletId, unassignedAt null). Program match is whitespace-tolerant (the
 * filter value is trimmed; stored names may not be).
 */
export function outletPassesBillingFilters(
  o: { programName: string | null; outletType: string | null; repIds: readonly string[] },
  f: Pick<BillingProgressFilters, 'program' | 'outletType'>,
  downline: Set<string> | null,
): boolean {
  if (f.program && (o.programName ?? '').trim() !== f.program) return false;
  if (f.outletType && o.outletType !== f.outletType) return false;
  if (downline && !o.repIds.some((id) => downline.has(id))) return false;
  return true;
}

/** The manager dropdown: live, active sales users above the lowest level, highest level first, then by name. */
export function billingAvailableManagers(
  salesUsers: ReadonlyArray<
    BillingManagerUser & { isActive: boolean; hierarchyLevel: { code: string; name: string; level: number } | null }
  >,
  levels: ReadonlyArray<{ level: number }>,
): Array<{ id: string; name: string; levelCode: string; levelName: string }> {
  const liveUsers = salesUsers.filter((u) => u.deletedAt == null);
  const nameOf = (u: BillingManagerUser) => u.user?.name || u.employeeCode;
  const minLevel = levels.length
    ? Math.min(...levels.map((l) => l.level))
    : liveUsers.length
      ? Math.min(...liveUsers.map((u) => u.hierarchyLevel?.level ?? Infinity))
      : Infinity;
  return liveUsers
    .filter((u) => u.isActive && u.hierarchyLevel && u.hierarchyLevel.level > minLevel)
    .sort((a, b) => b.hierarchyLevel!.level - a.hierarchyLevel!.level || nameOf(a).localeCompare(nameOf(b)))
    .map((u) => ({ id: u.id, name: nameOf(u), levelCode: u.hierarchyLevel!.code, levelName: u.hierarchyLevel!.name }));
}

export async function loadBillingProgress(
  prisma: PrismaService,
  clientId: string,
  f: BillingProgressFilters,
  now: Date,
): Promise<BillingProgressData> {
  const month = f.month ?? istMonthKey(now);

  const [kpiRows, outlets, salesUsers, levels, targetRows, salesRows, availablePrograms, lastApplied] = await Promise.all([
    prisma.kpiDef.findMany({
      where: { clientId, enabled: true },
      orderBy: [{ order: 'asc' }, { code: 'asc' }],
      select: {
        code: true, label: true, unit: true, isPrimary: true,
        outletType: true, outletTypes: true, programs: true, subPrograms: true,
      },
    }),
    // Whole tenant live roster ONCE (filters applied in memory so the dropdown sources stay filter-independent).
    prisma.outlet.findMany({
      where: addressableWhere(clientId),
      select: {
        outletCode: true,
        name: true,
        programName: true,
        programCategory: true,
        outletType: { select: { code: true } },
        salesAssignments: {
          where: { unassignedAt: null },
          orderBy: { assignedAt: 'desc' },
          select: { salesUserId: true },
        },
      },
    }),
    // G3: INCLUDES soft-deleted users (deletedAt) so the manager-downline filter and the SO/ASM name columns
    // walk THROUGH a resigned manager; deleted users are never offered as a manager nor shown as a name.
    prisma.salesUser.findMany({
      where: { clientId },
      select: {
        id: true,
        reportingToId: true,
        isActive: true,
        deletedAt: true,
        employeeCode: true,
        user: { select: { name: true } },
        hierarchyLevel: { select: { code: true, name: true, level: true } },
      },
    }),
    prisma.salesHierarchyLevel.findMany({ where: { clientId }, select: { level: true } }),
    prisma.outletTarget.findMany({ where: { clientId, month }, select: { outletCode: true, targetValues: true } }),
    prisma.outletSalesRecord.findMany({
      where: { clientId, month },
      select: { outletCode: true, kpiValues: true, updatedAt: true },
    }),
    loadAvailablePrograms(prisma, clientId),
    // Sales-import tenants: the last APPLIED import's latest invoice date for the month (null otherwise).
    loadLastApplied(prisma, clientId, month),
  ]);

  const kpiDef = pickReportKpi(kpiRows ?? []);

  // ── data freshness ── the importer's invoice date counts only when the importer OWNS the report KPI
  // (a manually-uploaded KPI is as fresh as its last upload, not the DMS file). The upload-time fallback reads
  // ONLY sales records that actually carry the report KPI's key — another KPI's upload says nothing about this
  // one (→ null → "No sales uploaded"). A future date is clamped to today everywhere (screen + export).
  const importerOwnsKpi = !!kpiDef && !!lastApplied && lastApplied.ownedCodes.includes(kpiDef.code);
  let asOf: string | null = importerOwnsKpi ? lastApplied!.lastInvoiceDate : null;
  if (!asOf && kpiDef) {
    let latest = 0;
    for (const r of salesRows) {
      const vals = r.kpiValues as Record<string, unknown> | null;
      if (!vals || typeof vals !== 'object' || !Object.prototype.hasOwnProperty.call(vals, kpiDef.code)) continue;
      const t = r.updatedAt instanceof Date ? r.updatedAt.getTime() : 0;
      if (t > latest) latest = t;
    }
    asOf = latest > 0 ? istDateKey(new Date(latest)) : null;
  }
  asOf = clampAsOf(asOf, now);
  const pace = paceFor(month, now, asOf);

  // ── managers ──
  const userById = new Map(salesUsers.map((u) => [u.id, u]));
  const nameOf = (u: (typeof salesUsers)[number]) => u.user?.name || u.employeeCode;
  const availableManagers = billingAvailableManagers(salesUsers, levels);
  // A deleted manager id (stale URL) behaves like an unknown id → empty downline (never their old team).
  const { downline, managerName } = resolveBillingManagerScope(salesUsers, f.managerId);

  const availableOutletTypes = [
    ...new Set(outlets.map((o) => o.outletType?.code).filter((c): c is string => !!c && c.trim().length > 0)),
  ].sort((a, b) => a.localeCompare(b));

  const base = {
    month,
    asOf,
    ...pace,
    managerName,
    availablePrograms,
    availableOutletTypes,
    availableManagers,
  };
  if (!kpiDef) return { ...base, kpi: null, inScope: [], noTarget: [], notCovered: [], targetsOutsideRoster: 0 };

  /**
   * Nearest LIVE self-or-ancestor with level code `code` (cycle-safe). G3: the walk passes THROUGH a deleted
   * node and never names one — a vacant SO slot leaves the SO cell blank (a level-specific column must not
   * show the ASM as the "SO") while the ASM cell above it still resolves.
   */
  const ancestorName = (startId: string | undefined, code: string): string | null => {
    const seen = new Set<string>();
    let cur = startId ? userById.get(startId) : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.deletedAt == null && cur.hierarchyLevel?.code === code) return nameOf(cur);
      cur = cur.reportingToId ? userById.get(cur.reportingToId) : undefined;
    }
    return null;
  };

  const appliesTo = kpiOutletPredicate(kpiDef);
  const code = kpiDef.code;
  const targetByCode = new Map(targetRows.map((r) => [r.outletCode, billingKpiValue(r.targetValues, code)]));
  const achByCode = new Map(salesRows.map((r) => [r.outletCode, billingKpiValue(r.kpiValues, code)]));

  // Target rows that can never reach the report: their outlet isn't in the live roster.
  const rosterCodes = new Set(outlets.map((o) => o.outletCode));
  let targetsOutsideRoster = 0;
  for (const [outletCode, t] of targetByCode) if (t > 0 && !rosterCodes.has(outletCode)) targetsOutsideRoster++;

  const inScope: BillingOutletRow[] = [];
  const noTarget: BillingOutletRow[] = [];
  const notCovered: BillingOutletRow[] = [];
  for (const o of outlets) {
    const type = o.outletType?.code ?? null;
    const reps = o.salesAssignments.map((a) => a.salesUserId);
    if (!outletPassesBillingFilters({ programName: o.programName ?? null, outletType: type, repIds: reps }, f, downline)) continue;
    const row: BillingOutletRow = {
      outletCode: o.outletCode,
      outletName: o.name,
      program: o.programName?.trim() || null,
      outletType: type,
      soName: ancestorName(reps[0], SO_CODE),
      asmName: ancestorName(reps[0], ASM_CODE),
      target: 0,
      achieved: 0,
      pct: null,
      note: null,
      rawPct: 0,
      bucket: null,
      behindPace: false,
    };
    const target = targetByCode.get(o.outletCode) ?? 0;
    const achieved = achByCode.get(o.outletCode) ?? 0;
    row.target = target;
    row.achieved = achieved;
    const cls = classifyBillingOutlet(
      appliesTo,
      { outletType: type, program: o.programName ?? null, subProgram: o.programCategory ?? null },
      target,
      achieved,
    );
    if (cls.kind === 'NOT_COVERED') {
      // Outside the KPI's applies-to scope: listed with its REAL stored values (never silently dropped, never a
      // fake 0), but NOT counted in any total — the platform rule for out-of-scope (outlet, KPI) values.
      row.note = NOT_COVERED_NOTE;
      notCovered.push(row);
      continue;
    }
    if (cls.kind === 'BUCKET') {
      const { rawPct, bucket } = cls;
      row.rawPct = rawPct;
      row.bucket = bucket;
      row.pct = displayPct(target, achieved, bucket);
      row.behindPace = pace.pacePct !== null && !isMet(target, achieved) && rawPct < pace.pacePct;
      inScope.push(row);
    } else {
      noTarget.push(row);
    }
  }

  return {
    ...base,
    kpi: { code: kpiDef.code, label: kpiDef.label, unit: kpiDef.unit ?? '' },
    inScope,
    noTarget,
    notCovered,
    targetsOutsideRoster,
  };
}

// ─── Response shapes ────────────────────────────────────────────────────────────────────────────

export function summarizeBillingProgress(d: BillingProgressData) {
  const sum = (rows: BillingOutletRow[], k: 'target' | 'achieved') => rows.reduce((a, r) => a + r[k], 0);
  const behind = d.inScope.filter((r) => r.behindPace);
  const total = d.inScope.length;
  return {
    month: d.month,
    kpi: d.kpi,
    asOf: d.asOf,
    monthStatus: d.monthStatus,
    daysElapsed: d.daysElapsed,
    daysInMonth: d.daysInMonth,
    pacePct: d.pacePct,
    paceAsOf: d.paceAsOf,
    fullMonth: d.fullMonth,
    /** Outlets with a positive target for the KPI (KYC-pending outlets included — they bill). */
    outletsInScope: total,
    outletsWithoutTarget: d.noTarget.length,
    outletsNotCovered: d.notCovered.length,
    targetsOutsideRoster: d.targetsOutsideRoster,
    /** Σ over the outlets WITH a target only (`outletsInScope`). */
    totals: { targetSum: sum(d.inScope, 'target'), achievedSum: sum(d.inScope, 'achieved') },
    behindPace: { count: behind.length, targetSum: sum(behind, 'target'), achievedSum: sum(behind, 'achieved') },
    buckets: BILLING_BUCKETS.map((b) => {
      const rows = d.inScope.filter((r) => r.bucket === b.key);
      return {
        key: b.key,
        label: b.label,
        count: rows.length,
        pctOfOutlets: total > 0 ? round1((rows.length / total) * 100) : 0,
        targetSum: sum(rows, 'target'),
        achievedSum: sum(rows, 'achieved'),
      };
    }),
    availablePrograms: d.availablePrograms,
    availableOutletTypes: d.availableOutletTypes,
    availableManagers: d.availableManagers,
  };
}

/** The rows behind one tile, sorted pct ascending then target descending (then code, for a stable page order). */
export function selectBillingRows(d: BillingProgressData, key: BillingListKey): BillingOutletRow[] {
  const rows =
    key === 'NO_TARGET'
      ? d.noTarget
      : key === 'NOT_COVERED'
        ? d.notCovered
        : key === 'BEHIND_PACE'
          ? d.inScope.filter((r) => r.behindPace)
          : d.inScope.filter((r) => r.bucket === key);
  return [...rows].sort(
    (a, b) => a.rawPct - b.rawPct || b.target - a.target || a.outletCode.localeCompare(b.outletCode),
  );
}

/** Public row shape (drops the internal sort/bucket fields). */
export function publicBillingRow(r: BillingOutletRow) {
  return {
    outletCode: r.outletCode,
    outletName: r.outletName,
    program: r.program,
    outletType: r.outletType,
    soName: r.soName,
    asmName: r.asmName,
    target: r.target,
    achieved: r.achieved,
    pct: r.pct,
    note: r.note,
  };
}

/**
 * List label. BEHIND_PACE reads "Missed target" for a past month — except when the data is known to stop
 * before the month's end (`fullMonth === false`), where it is pace to the data date ("Behind pace").
 */
export function billingListLabel(key: BillingListKey, monthStatus?: BillingMonthStatus, fullMonth?: boolean): string {
  if (key === 'BEHIND_PACE') return monthStatus === 'PAST' && fullMonth !== false ? 'Missed target' : 'Behind pace';
  if (key === 'NO_TARGET') return 'No target';
  if (key === 'NOT_COVERED') return 'Not covered by the KPI target';
  return BILLING_BUCKETS.find((b) => b.key === key)!.label;
}
