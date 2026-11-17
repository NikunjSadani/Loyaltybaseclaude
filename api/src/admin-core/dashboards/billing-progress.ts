/**
 * Billing progress — how far each outlet is through its PRIMARY-KPI monthly target, bucketed.
 * Shared by GET /v1/admin/dashboard/billing-progress(/outlets) and the 'billing-progress-outlets'
 * export kind (so the screen and the Excel can never disagree). No Nest DI here — plain functions
 * over PrismaService so the export worker can run it from `ctx.prisma`.
 *
 * Join (the SAME one the partner / sales / program-health readers use): OutletTarget ⋈
 * OutletSalesRecord on (clientId, outletCode, month), values read verbatim from the JSON maps
 * keyed by KpiDef.code; outlet codes match EXACTLY as stored (no normalisation at read time —
 * the importers already store the roster's own outletCode).
 *
 * Universe = the program-health ADDRESSABLE universe (live, non-deleted, non-deactivated, not
 * NOT_INTERESTED / PARKED — never `isActive:true`, which would drop KYC-pending outlets that DO
 * bill). The primary KPI's APPLIES-TO scope is honoured: an outlet outside it is excluded from
 * everything (it cannot have a target for that KPI, so it is neither "in scope" nor "without target").
 *
 * Queries: ≈9, all parallel, none per outlet (Bajaj ≈ 6.5k outlets aggregates in memory).
 */
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { istDateKey, istMonthKey, IST_OFFSET_MIN } from '../../common/ist-date';
import { kpiOutletPredicate } from '../../sales/outlet-kpi-scope.helper';
import { descendantSalesUserIds } from '../../sales/sales-hierarchy-access.helper';
import { loadLastApplied } from '../../sales-import/apply/last-applied';
import { loadAvailablePrograms, normalizeFilterParam } from './dashboard-program-filter';

// ─── Buckets ────────────────────────────────────────────────────────────────────────────────────

export const BILLING_BUCKETS = [
  { key: 'NOT_STARTED', label: 'Not started' },
  { key: 'P0_20', label: '1–20%' },
  { key: 'P20_40', label: '20–40%' },
  { key: 'P40_60', label: '40–60%' },
  { key: 'P60_80', label: '60–80%' },
  { key: 'P80_100', label: '80–99%' },
  { key: 'ACHIEVED', label: 'Achieved (100%+)' },
] as const;

export type BillingBucketKey = (typeof BILLING_BUCKETS)[number]['key'];
/** The outlets-list selector: a bucket, or the two cross-cutting lists. */
export type BillingListKey = BillingBucketKey | 'BEHIND_PACE' | 'NO_TARGET';
export const BILLING_LIST_KEYS: readonly BillingListKey[] = [
  ...BILLING_BUCKETS.map((b) => b.key),
  'BEHIND_PACE',
  'NO_TARGET',
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

// ─── Pace (IST) ─────────────────────────────────────────────────────────────────────────────────

export function daysInMonthOf(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Month pace by the IST calendar: current month → days elapsed = today's IST day-of-month (today
 * counts); past month → the whole month (100%); future month → 0.
 */
export function paceFor(month: string, now: Date): { daysElapsed: number; daysInMonth: number; pacePct: number } {
  const daysInMonth = daysInMonthOf(month);
  const current = istMonthKey(now);
  let daysElapsed: number;
  if (month < current) daysElapsed = daysInMonth;
  else if (month > current) daysElapsed = 0;
  else daysElapsed = new Date(now.getTime() + IST_OFFSET_MIN * 60_000).getUTCDate();
  return { daysElapsed, daysInMonth, pacePct: Math.round((daysElapsed / daysInMonth) * 100) };
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
  /** achieved/target×100, 1 dp for display; null when there is no positive target. */
  pct: number | null;
  /** Unrounded pct — the sort key. */
  rawPct: number;
  bucket: BillingBucketKey | null;
  behindPace: boolean;
}

export interface BillingProgressData {
  month: string;
  kpi: { code: string; label: string; unit: string } | null;
  asOf: string | null;
  daysElapsed: number;
  daysInMonth: number;
  pacePct: number;
  /** Outlets in the filters with a positive primary target (bucketed). */
  inScope: BillingOutletRow[];
  /** Outlets in the filters (and in the KPI's applies-to scope) with no / zero target. */
  noTarget: BillingOutletRow[];
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

/** The addressable universe (mirror of ProgramHealthDashboardService.addressableWhere — NEVER isActive:true). */
function addressableWhere(clientId: string): Prisma.OutletWhereInput {
  return {
    clientId,
    deletedAt: null,
    deactivatedAt: null,
    // notIn drops NULL rows → keep the (majority) NULL-intent outlets via the OR branch.
    OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
  };
}

export async function loadBillingProgress(
  prisma: PrismaService,
  clientId: string,
  f: BillingProgressFilters,
  now: Date,
): Promise<BillingProgressData> {
  const month = f.month ?? istMonthKey(now);
  const pace = paceFor(month, now);

  const [kpiDef, outlets, salesUsers, levels, targetRows, salesRows, availablePrograms, lastApplied] = await Promise.all([
    // PRIMARY KPI = enabled KpiDef flagged isPrimary (ties → lowest order, then code).
    prisma.kpiDef.findFirst({
      where: { clientId, enabled: true, isPrimary: true },
      orderBy: [{ order: 'asc' }, { code: 'asc' }],
      select: {
        code: true, label: true, unit: true,
        outletType: true, outletTypes: true, programs: true, subPrograms: true,
      },
    }),
    // Whole tenant universe ONCE (filters applied in memory so the dropdown sources stay filter-independent).
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

  // ── data freshness ── the importer's invoice date counts only when the importer OWNS the primary
  // KPI (a manually-uploaded primary is as fresh as its last upload, not the DMS file).
  const importerOwnsPrimary = !!kpiDef && !!lastApplied && lastApplied.ownedCodes.includes(kpiDef.code);
  let asOf: string | null = importerOwnsPrimary ? lastApplied!.lastInvoiceDate : null;
  if (!asOf) {
    let latest = 0;
    for (const r of salesRows) {
      const t = r.updatedAt instanceof Date ? r.updatedAt.getTime() : 0;
      if (t > latest) latest = t;
    }
    asOf = latest > 0 ? istDateKey(new Date(latest)) : null;
  }

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

  const availableOutletTypes = [
    ...new Set(outlets.map((o) => o.outletType?.code).filter((c): c is string => !!c && c.trim().length > 0)),
  ].sort((a, b) => a.localeCompare(b));

  const base = {
    month,
    asOf,
    ...pace,
    availablePrograms,
    availableOutletTypes,
    availableManagers,
  };
  if (!kpiDef) return { ...base, kpi: null, inScope: [], noTarget: [] };

  // ── manager downline (unknown / other-tenant id → empty set → nothing matches) ──
  let downline: Set<string> | null = null;
  if (f.managerId) {
    downline = userById.has(f.managerId)
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

  const inScope: BillingOutletRow[] = [];
  const noTarget: BillingOutletRow[] = [];
  for (const o of outlets) {
    const type = o.outletType?.code ?? null;
    if (f.program && o.programName !== f.program) continue;
    if (f.outletType && type !== f.outletType) continue;
    const reps = o.salesAssignments.map((a) => a.salesUserId);
    if (downline && !reps.some((id) => downline!.has(id))) continue;
    if (appliesTo && !appliesTo({ outletType: type, program: o.programName ?? null, subProgram: o.programCategory ?? null })) {
      continue; // outside the primary KPI's applies-to scope — not part of this report at all
    }
    const target = targetByCode.get(o.outletCode) ?? 0;
    const achieved = achByCode.get(o.outletCode) ?? 0;
    const row: BillingOutletRow = {
      outletCode: o.outletCode,
      outletName: o.name,
      program: o.programName ?? null,
      outletType: type,
      soName: ancestorName(reps[0], SO_CODE),
      asmName: ancestorName(reps[0], ASM_CODE),
      target,
      achieved,
      pct: null,
      rawPct: 0,
      bucket: null,
      behindPace: false,
    };
    if (target > 0) {
      const rawPct = (achieved / target) * 100;
      row.rawPct = rawPct;
      row.pct = round1(rawPct);
      row.bucket = bucketOf(target, achieved);
      row.behindPace = !isMet(target, achieved) && rawPct < pace.pacePct;
      inScope.push(row);
    } else {
      noTarget.push(row);
    }
  }

  return { ...base, kpi: { code: kpiDef.code, label: kpiDef.label, unit: kpiDef.unit ?? '' }, inScope, noTarget };
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
    daysElapsed: d.daysElapsed,
    daysInMonth: d.daysInMonth,
    pacePct: d.pacePct,
    outletsInScope: total,
    outletsWithoutTarget: d.noTarget.length,
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

export function billingListLabel(key: BillingListKey): string {
  if (key === 'BEHIND_PACE') return 'Behind pace';
  if (key === 'NO_TARGET') return 'No target';
  return BILLING_BUCKETS.find((b) => b.key === key)!.label;
}
