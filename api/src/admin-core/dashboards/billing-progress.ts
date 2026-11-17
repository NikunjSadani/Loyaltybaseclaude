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
}

/**
 * Month pace by the IST calendar, measured to the DATA date:
 *   - no data (`asOf` null) → no pace, whatever the month;
 *   - past month → the whole month (100%, "missed target" wording on screen), as of the month's last day;
 *   - future month → no pace;
 *   - current month → the IST day of min(asOf, today) — pacing to today when the data stops at the 12th
 *     would flag outlets "behind" for days that haven't been uploaded yet.
 */
export function paceFor(month: string, now: Date, asOf: string | null): BillingPace {
  const daysInMonth = daysInMonthOf(month);
  const current = istMonthKey(now);
  const monthStatus: BillingMonthStatus = month < current ? 'PAST' : month > current ? 'FUTURE' : 'CURRENT';
  const none = { monthStatus, daysInMonth, daysElapsed: null, pacePct: null, paceAsOf: null };
  if (!asOf || monthStatus === 'FUTURE') return none;
  if (monthStatus === 'PAST') {
    return { monthStatus, daysInMonth, daysElapsed: daysInMonth, pacePct: 100, paceAsOf: `${month}-${String(daysInMonth).padStart(2, '0')}` };
  }
  const today = istDateKey(now);
  const upTo = asOf < today ? asOf : today;
  // Data dated before the month began covers none of it.
  const daysElapsed = upTo.slice(0, 7) < month ? 0 : Number(upTo.slice(8, 10));
  return {
    monthStatus,
    daysInMonth,
    daysElapsed,
    pacePct: Math.round((daysElapsed / daysInMonth) * 100),
    paceAsOf: upTo,
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
    prisma.salesUser.findMany({
      where: { clientId, deletedAt: null },
      select: {
        id: true,
        reportingToId: true,
        isActive: true,
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
  // (a manually-uploaded KPI is as fresh as its last upload, not the DMS file).
  const importerOwnsKpi = !!kpiDef && !!lastApplied && lastApplied.ownedCodes.includes(kpiDef.code);
  let asOf: string | null = importerOwnsKpi ? lastApplied!.lastInvoiceDate : null;
  if (!asOf) {
    let latest = 0;
    for (const r of salesRows) {
      const t = r.updatedAt instanceof Date ? r.updatedAt.getTime() : 0;
      if (t > latest) latest = t;
    }
    asOf = latest > 0 ? istDateKey(new Date(latest)) : null;
  }
  const pace = paceFor(month, now, asOf);

  // ── managers ──
  const userById = new Map(salesUsers.map((u) => [u.id, u]));
  const nameOf = (u: (typeof salesUsers)[number]) => u.user?.name || u.employeeCode;
  const minLevel = levels.length
    ? Math.min(...levels.map((l) => l.level))
    : salesUsers.length
      ? Math.min(...salesUsers.map((u) => u.hierarchyLevel?.level ?? Infinity))
      : Infinity;
  const availableManagers = salesUsers
    .filter((u) => u.isActive && u.hierarchyLevel && u.hierarchyLevel.level > minLevel)
    .sort((a, b) => b.hierarchyLevel.level - a.hierarchyLevel.level || nameOf(a).localeCompare(nameOf(b)))
    .map((u) => ({ id: u.id, name: nameOf(u), levelCode: u.hierarchyLevel.code, levelName: u.hierarchyLevel.name }));
  const selectedManager = f.managerId ? userById.get(f.managerId) : undefined;
  const managerName = selectedManager ? nameOf(selectedManager) : null;

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

  // ── manager downline (unknown / other-tenant id → empty set → nothing matches) ──
  let downline: Set<string> | null = null;
  if (f.managerId) {
    downline = selectedManager
      ? descendantSalesUserIds(
          f.managerId,
          salesUsers.map((u) => ({ id: u.id, reportingToId: u.reportingToId })),
        )
      : new Set<string>();
  }

  /** Nearest self-or-ancestor with level code `code` (cycle-safe). */
  const ancestorName = (startId: string | undefined, code: string): string | null => {
    const seen = new Set<string>();
    let cur = startId ? userById.get(startId) : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.hierarchyLevel?.code === code) return nameOf(cur);
      cur = cur.reportingToId ? userById.get(cur.reportingToId) : undefined;
    }
    return null;
  };

  const appliesTo = kpiOutletPredicate(kpiDef);
  const code = kpiDef.code;
  const targetByCode = new Map(targetRows.map((r) => [r.outletCode, num((r.targetValues as Record<string, unknown> | null)?.[code])]));
  const achByCode = new Map(salesRows.map((r) => [r.outletCode, num((r.kpiValues as Record<string, unknown> | null)?.[code])]));

  // Target rows that can never reach the report: their outlet isn't in the live roster.
  const rosterCodes = new Set(outlets.map((o) => o.outletCode));
  let targetsOutsideRoster = 0;
  for (const [outletCode, t] of targetByCode) if (t > 0 && !rosterCodes.has(outletCode)) targetsOutsideRoster++;

  const inScope: BillingOutletRow[] = [];
  const noTarget: BillingOutletRow[] = [];
  const notCovered: BillingOutletRow[] = [];
  for (const o of outlets) {
    const type = o.outletType?.code ?? null;
    // Program match is whitespace-tolerant (the filter value is trimmed; stored names may not be).
    if (f.program && (o.programName ?? '').trim() !== f.program) continue;
    if (f.outletType && type !== f.outletType) continue;
    const reps = o.salesAssignments.map((a) => a.salesUserId);
    if (downline && !reps.some((id) => downline!.has(id))) continue;
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
      rawPct: 0,
      bucket: null,
      behindPace: false,
    };
    if (appliesTo && !appliesTo({ outletType: type, program: o.programName ?? null, subProgram: o.programCategory ?? null })) {
      // Outside the KPI's applies-to scope: listed (never silently dropped), but its stored values for this KPI
      // are excluded — the platform rule for out-of-scope (outlet, KPI) values.
      notCovered.push(row);
      continue;
    }
    const target = targetByCode.get(o.outletCode) ?? 0;
    const achieved = achByCode.get(o.outletCode) ?? 0;
    row.target = target;
    row.achieved = achieved;
    if (target > 0) {
      const rawPct = (achieved / target) * 100;
      const bucket = bucketOf(target, achieved);
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
  };
}

export function billingListLabel(key: BillingListKey, monthStatus?: BillingMonthStatus): string {
  if (key === 'BEHIND_PACE') return monthStatus === 'PAST' ? 'Missed target' : 'Behind pace';
  if (key === 'NO_TARGET') return 'No target';
  if (key === 'NOT_COVERED') return 'Not covered by the KPI target';
  return BILLING_BUCKETS.find((b) => b.key === key)!.label;
}
