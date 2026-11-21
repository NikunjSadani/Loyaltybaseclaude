/**
 * Location-compliance report — per sales rep, for an IST date range: KYCs and visibility captures, how many had no
 * GPS, accuracy worse than 50 m, were flagged unverifiable, and how many were blocked outside the 200 m fence; plus
 * the median accuracy and the median KYC lock time. Owner-approved 2026-11-18 with the location gate
 * (platform/docs/plans/LOCATION-GATE.md).
 *
 * ONE builder shared by the JSON endpoint (GET /v1/reports/location-compliance — a page of rows) and the Excel export
 * ('location-compliance' kind — every row), so the page and the file can never disagree.
 *
 * Scope (isolation-critical) — exactly like the Usage report: the caller's JWT clientId. Reps = that tenant's SALES_*
 * users; every source is joined through those user ids AND re-checks the tenant where the row carries it.
 *
 * Sources (no new columns):
 *   • KYC — kyc_submissions filed by the rep (userId = the rep), by submittedAt: board-photo fix
 *     (boardPhotoLat/Lng/GeoAccuracy), geoFenceStatus ('UNVERIFIABLE' — recorded on outlet-master-fence tenants
 *     only), geoLockMs (time to lock — recorded on outlet-master-fence tenants only);
 *   • Visibility — visibility_capture_submissions (every version, incl. re-captures) by createdAt, rep via
 *     sales_users: captureLat/Lng/Accuracy, geoFenceOk NULL = unverifiable (counted only when the tenant's fence is
 *     on — with the fence off every capture is NULL and that means "not checked", not "unverifiable");
 *   • Blocked — audit_logs rows `LOCATION_FENCE_BLOCK` (recorded from the day the location gate shipped, and only for
 *     tenants with the gate switched on; refusals before that were never stored).
 */
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { FENCE_BLOCK_ENTITY, POOR_ACCURACY_M, isLocationRequired } from '../../common/location-gate.helper';
import { resolveUsageParams, usageQueryError, USAGE_QUERY_TIMEOUT_MS, USAGE_TIMEOUT_MESSAGE } from '../usage/usage-report';
import {
  LOCATION_PAGE_SIZE_DEFAULT,
  LOCATION_PAGE_SIZE_MAX,
  type LocationComplianceQueryDto,
  type LocationSort,
} from '../dto/location-compliance.dto';

export const LOCATION_TIMEOUT_MESSAGE =
  'The location report took too long to build. Please try again, or choose a shorter date range or narrower filters.';

/** Audit #4: the report exists only for programmes with "Require location" ON (Deoleo sees nothing new). */
export const LOCATION_REPORT_OFF_MESSAGE =
  'The Location report is available only for programmes with "Require location" switched on (Gifsy console → Behaviour flags).';

export const SALES_ROLES = ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'] as const;

export const LOCATION_NOTES = {
  sources:
    'KYCs are counted by submission time and use the store-board photo location. Visibility captures count every submission, including re-captures.',
  accuracy: `"Poor accuracy" means the phone reported its fix as worse than ±${POOR_ACCURACY_M} m. Median accuracy uses every capture that had a location.`,
  unverifiable:
    'Unverifiable means the location could not be checked against the outlet (no outlet coordinates on file, or a fix too imprecise to judge). It is only recorded when the 200 m fence is switched on for the programme.',
  blocked:
    'Blocked attempts are refusals for being more than 200 m from the outlet. They are recorded only while "Require location" is switched on for the programme, from the day this report shipped — earlier refusals were never stored.',
  lock: 'Median lock time is how long the phone took to get the KYC board-photo location. It is recorded only on programmes with the outlet-coordinates fence.',
  region:
    'Region is the rep’s region on their employee record, else the states of the outlets directly assigned to them. Reps without either are left out when a region is chosen.',
} as const;

export interface LocationParams {
  from: string;
  to: string;
  role: string | null;
  region: string | null;
  sort: LocationSort;
  page: number;
  pageSize: number;
}

export interface LocationRow {
  userId: string;
  name: string;
  phone: string;
  role: string;
  regions: string[];
  kycs: number;
  visibilityCaptures: number;
  noGps: number;
  poorAccuracy: number;
  unverifiable: number;
  blockedOutside: number;
  medianAccuracyM: number | null;
  medianLockMs: number | null;
}

export interface LocationTotals extends Omit<LocationRow, 'userId' | 'name' | 'phone' | 'role' | 'regions'> {
  reps: number;
}

export interface LocationReport {
  generatedAt: string;
  timezone: 'Asia/Kolkata';
  range: { from: string; to: string; days: number };
  setting: { requireLocation: boolean; fenceOn: boolean; outletMasterFence: boolean };
  notes: typeof LOCATION_NOTES;
  filters: { roles: string[]; regions: string[] };
  applied: { role: string | null; region: string | null; sort: LocationSort };
  totals: LocationTotals;
  rows: LocationRow[];
}

// ─── Params ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Same date validation + defaults as the Usage report (IST days, ≤ 366, default last 30). */
export function resolveLocationParams(q: LocationComplianceQueryDto, now: Date = new Date()): LocationParams {
  const base = resolveUsageParams({ from: q.from, to: q.to, region: q.region }, now);
  return {
    from: base.from,
    to: base.to,
    role: q.role ?? null,
    region: base.region,
    sort: q.sort ?? 'issues',
    page: q.page ?? 1,
    pageSize: Math.min(q.pageSize ?? LOCATION_PAGE_SIZE_DEFAULT, LOCATION_PAGE_SIZE_MAX),
  };
}

export function requireLocationTenant(clientId: string | undefined | null): string {
  const c = (clientId ?? '').trim();
  if (!c) throw new ForbiddenException('The location-compliance report requires a tenant scope.');
  return c;
}

/** [start, end) instants of an inclusive IST day range. */
export function istBounds(from: string, to: string): { start: Date; end: Date } {
  return {
    start: new Date(`${from}T00:00:00.000+05:30`),
    end: new Date(Date.parse(`${to}T00:00:00.000+05:30`) + 86_400_000),
  };
}

// ─── SQL ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LocationAggRow {
  userId: string | null;
  isTotal: number;
  kycs: number;
  visibilityCaptures: number;
  noGps: number;
  poorAccuracy: number;
  unverifiable: number;
  blockedOutside: number;
  medianAccuracyM: number | string | null;
  medianLockMs: number | string | null;
}

/**
 * Per-rep figures + ONE totals row (GROUPING SETS) for the given rep ids — medians of the filtered population are
 * computed by Postgres, never averaged from per-rep medians. `visFenceOn` decides whether a visibility capture with
 * geoFenceOk NULL counts as unverifiable.
 */
export function locationAggregateSql(
  clientId: string,
  repIds: string[],
  start: Date,
  end: Date,
  visFenceOn: boolean,
): Prisma.Sql {
  return Prisma.sql`
    WITH ev AS (
      SELECT k."userId" AS uid, 'K' AS src,
             (k."boardPhotoLat" IS NOT NULL AND k."boardPhotoLng" IS NOT NULL) AS has_gps,
             k."boardPhotoGeoAccuracy"::float8 AS acc,
             (k."geoFenceStatus" = 'UNVERIFIABLE') AS unverifiable,
             k."geoLockMs"::float8 AS lock_ms
        FROM "kyc_submissions" k
        JOIN "users" u ON u."id" = k."userId"
       WHERE u."clientId" = ${clientId}
         AND k."userId" = ANY(${repIds})
         AND k."submittedAt" >= ${start} AND k."submittedAt" < ${end}
      UNION ALL
      SELECT su."userId", 'V',
             (s."captureLat" IS NOT NULL AND s."captureLng" IS NOT NULL),
             s."captureAccuracy"::float8,
             (${visFenceOn}::boolean AND s."geoFenceOk" IS NULL),
             NULL::float8
        FROM "visibility_capture_submissions" s
        JOIN "sales_users" su ON su."id" = s."submittedBySalesUserId"
       WHERE s."clientId" = ${clientId}
         AND su."userId" = ANY(${repIds})
         AND s."createdAt" >= ${start} AND s."createdAt" < ${end}
      UNION ALL
      SELECT a."actorId", 'B', false, NULL::float8, false, NULL::float8
        FROM "audit_logs" a
       WHERE a."entityType" = ${FENCE_BLOCK_ENTITY}
         AND a."metadata"->>'clientId' = ${clientId}
         AND a."actorId" = ANY(${repIds})
         AND a."createdAt" >= ${start} AND a."createdAt" < ${end}
    )
    SELECT uid AS "userId",
           GROUPING(uid)::int                                                        AS "isTotal",
           COUNT(*) FILTER (WHERE src = 'K')::int                                    AS "kycs",
           COUNT(*) FILTER (WHERE src = 'V')::int                                    AS "visibilityCaptures",
           COUNT(*) FILTER (WHERE src <> 'B' AND NOT has_gps)::int                   AS "noGps",
           COUNT(*) FILTER (WHERE src <> 'B' AND has_gps AND acc > ${POOR_ACCURACY_M})::int AS "poorAccuracy",
           COUNT(*) FILTER (WHERE src <> 'B' AND unverifiable)::int                  AS "unverifiable",
           COUNT(*) FILTER (WHERE src = 'B')::int                                    AS "blockedOutside",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY acc) FILTER (WHERE src <> 'B' AND has_gps) AS "medianAccuracyM",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY lock_ms) FILTER (WHERE src = 'K')          AS "medianLockMs"
      FROM ev
     GROUP BY GROUPING SETS ((uid), ())`;
}

// ─── Build ────────────────────────────────────────────────────────────────────────────────────────────────────

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0) || 0);
const median = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};
const normText = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const sortStrings = (s: Iterable<string>) => [...s].sort((a, b) => a.localeCompare(b));
const eqCI = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

const EMPTY_TOTALS: LocationTotals = {
  reps: 0,
  kycs: 0,
  visibilityCaptures: 0,
  noGps: 0,
  poorAccuracy: 0,
  unverifiable: 0,
  blockedOutside: 0,
  medianAccuracyM: null,
  medianLockMs: null,
};

const issues = (r: LocationRow) => r.noGps + r.poorAccuracy + r.unverifiable + r.blockedOutside;

function compareRows(sort: LocationSort): (a: LocationRow, b: LocationRow) => number {
  const byName = (a: LocationRow, b: LocationRow) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId);
  const captures = (r: LocationRow) => r.kycs + r.visibilityCaptures;
  switch (sort) {
    case 'captures':
      return (a, b) => captures(b) - captures(a) || issues(b) - issues(a) || byName(a, b);
    case 'name':
      return byName;
    case 'issues':
    default:
      return (a, b) => issues(b) - issues(a) || captures(b) - captures(a) || byName(a, b);
  }
}

/** Whether a visibility capture with geoFenceOk NULL means "unverifiable" for this tenant (fence on). */
function visibilityFenceOn(features: Record<string, unknown>, visibilityConfig: unknown): boolean {
  if (features.outletMasterGeo === true) return true;
  const gf = (visibilityConfig as { geoFence?: { enabled?: unknown } } | null)?.geoFence;
  return gf?.enabled === true;
}

/** Build the whole report (every matching rep, sorted). Reads run sequentially (one pooled connection at a time). */
export async function buildLocationReport(
  prisma: PrismaService,
  clientIdRaw: string,
  p: LocationParams,
  now: Date = new Date(),
): Promise<LocationReport> {
  const clientId = requireLocationTenant(clientIdRaw);

  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { features: true } });
  const features = ((client?.features ?? {}) as Record<string, unknown>) ?? {};
  if (!client || !isLocationRequired(features)) throw new ForbiddenException(LOCATION_REPORT_OFF_MESSAGE);
  const visCfg = await prisma.programSetting.findUnique({
    where: { clientId_settingKey: { clientId, settingKey: 'visibilityConfig' } },
    select: { settingValue: true },
  });
  const fenceOn = visibilityFenceOn(features, visCfg?.settingValue ?? null);

  type Rep = { id: string; name: string | null; phone: string | null; role: string; salesUser: { region: string | null; zone: string | null } | null };
  let reps: Rep[] = [];
  let population: Rep[] = [];
  const regionsBy = new Map<string, Set<string>>();
  const allRegions = new Set<string>();
  let agg: LocationAggRow[] = [];
  const { start, end } = istBounds(p.from, p.to);

  // The roster reads AND the aggregate run in ONE short transaction under the statement timeout (review LOW: a huge
  // assignment table can never hang the request either). Sequential inside — one pooled connection.
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${USAGE_QUERY_TIMEOUT_MS}`);
        // Reps of THIS tenant (incl. deactivated/deleted — their past captures still count; listed only with activity).
        reps = (await tx.user.findMany({
          where: { clientId, role: { in: [...SALES_ROLES] } },
          select: { id: true, name: true, phone: true, role: true, salesUser: { select: { region: true, zone: true } } },
        })) as Rep[];
        const assignments = await tx.salesUserAssignment.findMany({
          where: { unassignedAt: null, salesUser: { clientId } },
          select: {
            salesUser: { select: { userId: true } },
            outlet: { select: { state: true, deletedAt: true, clientId: true } },
          },
        });
        for (const a of assignments) {
          const uid = a.salesUser?.userId;
          const st = normText(a.outlet?.state);
          if (!uid || !st || !a.outlet || a.outlet.deletedAt || a.outlet.clientId !== clientId) continue;
          if (!regionsBy.has(uid)) regionsBy.set(uid, new Set());
          regionsBy.get(uid)!.add(st);
        }
        for (const u of reps) {
          const r = normText(u.salesUser?.region) ?? normText(u.salesUser?.zone);
          if (r) regionsBy.set(u.id, new Set([r])); // employee-record region wins (same rule as the Usage report)
        }
        for (const set of regionsBy.values()) for (const r of set) allRegions.add(r);
        population = reps.filter((u) => {
          if (p.role && u.role !== p.role) return false;
          if (p.region && ![...(regionsBy.get(u.id) ?? [])].some((x) => eqCI(x, p.region!))) return false;
          return true;
        });
        const ids = population.map((u) => u.id);
        if (ids.length > 0) {
          agg = await tx.$queryRaw<LocationAggRow[]>(locationAggregateSql(clientId, ids, start, end, fenceOn));
        }
      },
      { maxWait: 5_000, timeout: USAGE_QUERY_TIMEOUT_MS + 5_000 },
    );
  } catch (e) {
    const mapped = usageQueryError(e);
    // Same timeout / pool-busy mapping as the Usage report, worded for this report.
    throw mapped instanceof ServiceUnavailableException && mapped.message === USAGE_TIMEOUT_MESSAGE
      ? new ServiceUnavailableException(LOCATION_TIMEOUT_MESSAGE)
      : mapped;
  }

  const byUser = new Map<string, LocationAggRow>();
  let totalRow: LocationAggRow | undefined;
  for (const r of agg) {
    if (num(r.isTotal) === 1) totalRow = r;
    else if (r.userId) byUser.set(r.userId, r);
  }

  const rows: LocationRow[] = [];
  for (const u of population) {
    const a = byUser.get(u.id);
    if (!a) continue; // no KYC, capture or block in the range → not listed
    rows.push({
      userId: u.id,
      name: u.name ?? '',
      phone: u.phone ?? '',
      role: u.role as string,
      regions: sortStrings(regionsBy.get(u.id) ?? []),
      kycs: num(a.kycs),
      visibilityCaptures: num(a.visibilityCaptures),
      noGps: num(a.noGps),
      poorAccuracy: num(a.poorAccuracy),
      unverifiable: num(a.unverifiable),
      blockedOutside: num(a.blockedOutside),
      medianAccuracyM: median(a.medianAccuracyM),
      medianLockMs: median(a.medianLockMs),
    });
  }
  rows.sort(compareRows(p.sort));

  const totals: LocationTotals = totalRow
    ? {
        reps: rows.length,
        kycs: num(totalRow.kycs),
        visibilityCaptures: num(totalRow.visibilityCaptures),
        noGps: num(totalRow.noGps),
        poorAccuracy: num(totalRow.poorAccuracy),
        unverifiable: num(totalRow.unverifiable),
        blockedOutside: num(totalRow.blockedOutside),
        medianAccuracyM: median(totalRow.medianAccuracyM),
        medianLockMs: median(totalRow.medianLockMs),
      }
    : { ...EMPTY_TOTALS };

  return {
    generatedAt: now.toISOString(),
    timezone: 'Asia/Kolkata',
    range: {
      from: p.from,
      to: p.to,
      days: Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000) + 1,
    },
    setting: {
      requireLocation: isLocationRequired(features),
      fenceOn,
      outletMasterFence: features.outletMasterGeo === true,
    },
    notes: LOCATION_NOTES,
    filters: { roles: sortStrings(new Set(reps.map((u) => u.role as string))), regions: sortStrings(allRegions) },
    applied: { role: p.role, region: p.region, sort: p.sort },
    totals,
    rows,
  };
}

/** The JSON endpoint's payload: the report with ONE page of rows. */
export function pageOfLocationReport(r: LocationReport, p: LocationParams) {
  const totalRows = r.rows.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / p.pageSize));
  const page = Math.min(Math.max(1, p.page), pageCount);
  const start = (page - 1) * p.pageSize;
  return { ...r, page, pageSize: p.pageSize, pageCount, totalRows, rows: r.rows.slice(start, start + p.pageSize) };
}
