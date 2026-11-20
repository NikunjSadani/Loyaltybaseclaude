/**
 * Usage Report — "who is using the app, how (installed app vs browser; phone vs computer) and for how long"
 * (owner-approved 2026-11-18; design: platform/docs/plans/USAGE-REPORT.md).
 *
 * ONE builder shared by the JSON endpoint (GET /v1/reports/usage — a page of rows) and the Excel export
 * ('usage-report' kind — every row), so the page and the file can never disagree.
 *
 * Source: user_activity_day (one row per user per IST day; visits / activeSeconds / medium written by
 * ActivityTrackingService). Days before the feature shipped exist (active-day stamps) but carry visits = 0 and no
 * duration / medium — they still count as "days active", and are excluded from "average minutes per tracked day".
 *
 * Scope (isolation-critical) — EXACTLY like the Session Report: the caller's JWT clientId (CLIENT_ADMIN / MIS_USER →
 * own tenant; a GIFSY operator → the tenant they have assumed; un-assumed → their home tenant, never all tenants).
 * Users are the tenant's non-deleted users (User.clientId); activity is joined by userId, so a Gifsy operator's own
 * activity while assumed into a tenant never appears in that tenant's report.
 *
 * Programme / region (what exists per role — stated on the page):
 *   • retailers / partners (SSS, WHOLESALER, SUB_STOCKIST): programme = Outlet.programName and region = Outlet.state of
 *     the outlets they own (incl. child outlets of a group they head);
 *   • sales staff: SalesUser.region when set (dormant today), else the programme / state of the outlets DIRECTLY
 *     assigned to them (SalesUserAssignment). Managers without directly-assigned outlets have none;
 *   • admins / Gifsy staff / vendors: none.
 * Filtering by programme or region therefore keeps only users who have one.
 *
 * Area columns (ASM · Zone · State · City, owner 2026-11-20) are separate from programme / region and come from the
 * shared resolver in reports/area/user-area.ts (sales hierarchy + outlet master; 4 tenant-wide reads).
 */
import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { ActivityTrackingService } from '../../activity/activity-tracking.service';
import {
  USAGE_PAGE_SIZE_DEFAULT,
  USAGE_PAGE_SIZE_MAX,
  type UsageReportQueryDto,
  type UsageSort,
} from '../dto/usage-report.dto';
import {
  cachedUserAreaResolver,
  loadUserAreaResolver,
  type AreaPrisma,
  type UserAreaResolver,
} from '../area/user-area';

export const USAGE_MAX_RANGE_DAYS = 366;
export const USAGE_DEFAULT_RANGE_DAYS = 30;

/** The page/Excel note — one wording everywhere. */
export const USAGE_DURATION_NOTE =
  "Duration counts the time between a user's first and last action in each visit (a new visit starts after 30 minutes idle), so it is a minimum.";

export const USAGE_REGION_NOTE =
  'Programme and region come from outlets: a retailer’s own outlets; a sales user’s directly-assigned outlets (or the region on their employee record). Managers without directly-assigned outlets and admin users have none, so a programme or region filter leaves them out.';

export interface UsageParams {
  from: string; // YYYY-MM-DD (IST), inclusive
  to: string; // YYYY-MM-DD (IST), inclusive
  role: string | null;
  program: string | null;
  region: string | null;
  sort: UsageSort;
  includeInactive: boolean;
  page: number;
  pageSize: number;
}

export interface UsageRow {
  userId: string;
  name: string;
  phone: string;
  role: string;
  status: string;
  programmes: string[];
  regions: string[];
  /** Area (owner 2026-11-20) — reports/area/user-area.ts: FULL sorted lists, never empty ("Not set" / "Above ASM
   *  level" / "Not in sales hierarchy" / "Group — N outlets" when missing / not applicable). The page caps the display;
   *  the Excel writes everything. */
  asm: string[];
  zone: string[];
  state: string[];
  city: string[];
  daysActive: number;
  /** Days with duration/medium tracking (visits > 0) — 0 for days before the feature shipped. */
  trackedDays: number;
  visits: number;
  /** floor(activeSeconds / 60) — "at least". */
  minutes: number;
  activeSeconds: number;
  /** activeSeconds / 60 / trackedDays, 1 decimal; null when no tracked day. */
  avgMinutesPerDay: number | null;
  appDays: number;
  browserDays: number;
  phoneDays: number;
  computerDays: number;
  /** 'Phone' | 'Computer' | 'Both' | '' (unknown / no tracked day). */
  device: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface UsageTotals {
  /** Enabled accounts matching the filters + deactivated/suspended accounts that WERE active in the range. */
  usersInScope: number;
  /** Users with ≥ 1 active day in the range. */
  usersActive: number;
  /** Enabled accounts with NO activity in the range (who did not use it). */
  usersInactive: number;
  /** Deactivated / suspended accounts with no activity in the range — NOT counted anywhere above. */
  disabledAccountsExcluded: number;
  avgDaysActive: number | null;
  totalMinutes: number;
  /** Users with ≥ 1 TRACKED day (duration/medium recorded — i.e. after the feature shipped). */
  usersTracked: number;
  /** totalMinutes ÷ usersTracked (pre-ship-only users would otherwise drag the average down). */
  avgMinutesPerTrackedUser: number | null;
  appUsers: number;
  browserUsers: number;
  phoneUsers: number;
  computerUsers: number;
}

export interface UsageReport {
  generatedAt: string;
  timezone: 'Asia/Kolkata';
  range: { from: string; to: string; days: number };
  /** First IST day with duration/medium tracking for this tenant (null = no tracked activity yet). */
  trackingStartedOn: string | null;
  notes: { duration: string; region: string; area: string[] };
  /** The ASM column's header — the tenant's own name for the ASM level ("ASM" by default). */
  asmHeader: string;
  filters: { roles: string[]; programs: string[]; regions: string[] };
  applied: { role: string | null; program: string | null; region: string | null; sort: UsageSort; includeInactive: boolean };
  totals: UsageTotals;
  /** Every matching row, sorted (the endpoint slices a page; the Excel writes all). */
  rows: UsageRow[];
}

// ─── Params ───────────────────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Midnight-UTC Date for a real calendar YYYY-MM-DD, else null (rejects 2026-02-31). */
function calendarDay(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return null;
  return d;
}

function normText(v: string | undefined | null): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** Validate + default the (already DTO-validated) query. Throws 400 with a plain message. Pure except `now`. */
export function resolveUsageParams(q: UsageReportQueryDto, now: Date = new Date()): UsageParams {
  const today = ActivityTrackingService.istDateKey(now);
  const to = q.to ?? today;
  const toDay = calendarDay(to);
  if (!toDay) throw new BadRequestException(['to must be a real calendar date']);
  const from = q.from ?? new Date(toDay.getTime() - (USAGE_DEFAULT_RANGE_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const fromDay = calendarDay(from);
  if (!fromDay) throw new BadRequestException(['from must be a real calendar date']);
  if (fromDay.getTime() > toDay.getTime()) throw new BadRequestException(['from must be on or before to']);
  const days = Math.round((toDay.getTime() - fromDay.getTime()) / DAY_MS) + 1;
  if (days > USAGE_MAX_RANGE_DAYS) {
    throw new BadRequestException([`The date range can be at most ${USAGE_MAX_RANGE_DAYS} days`]);
  }
  return {
    from,
    to,
    role: q.role ?? null,
    program: normText(q.program),
    region: normText(q.region),
    sort: q.sort ?? 'minutes',
    includeInactive: q.includeInactive === 'true',
    page: q.page ?? 1,
    pageSize: Math.min(q.pageSize ?? USAGE_PAGE_SIZE_DEFAULT, USAGE_PAGE_SIZE_MAX),
  };
}

export function requireUsageTenant(clientId: string | undefined | null): string {
  const c = (clientId ?? '').trim();
  if (!c) throw new ForbiddenException('The usage report requires a tenant scope.');
  return c;
}

// ─── Build ────────────────────────────────────────────────────────────────────────────────────────────────────

interface AggRow {
  userId: string;
  daysActive: number;
  trackedDays: number;
  visits: number;
  activeSeconds: number;
  appDays: number;
  browserDays: number;
  phoneDays: number;
  computerDays: number;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
}

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0) || 0);

/** Per-user aggregate over the range — ONE grouped SQL read (never one row per day into memory). */
export function usageAggregateSql(clientId: string, from: string, to: string): Prisma.Sql {
  return Prisma.sql`
    SELECT a."userId"                                             AS "userId",
           COUNT(*)::int                                          AS "daysActive",
           COUNT(*) FILTER (WHERE a."visits" > 0)::int            AS "trackedDays",
           COALESCE(SUM(a."visits"), 0)::int                      AS "visits",
           COALESCE(SUM(a."activeSeconds"), 0)::int               AS "activeSeconds",
           COUNT(*) FILTER (WHERE a."appUsed")::int               AS "appDays",
           COUNT(*) FILTER (WHERE a."browserUsed")::int           AS "browserDays",
           COUNT(*) FILTER (WHERE a."phoneUsed")::int             AS "phoneDays",
           COUNT(*) FILTER (WHERE a."computerUsed")::int          AS "computerDays",
           MIN(a."firstSeenAt")                                   AS "firstSeenAt",
           MAX(a."lastSeenAt")                                    AS "lastSeenAt"
      FROM "user_activity_day" a
      JOIN "users" u ON u."id" = a."userId"
     WHERE u."clientId" = ${clientId}
       AND u."deletedAt" IS NULL
       AND a."activityDate" >= CAST(${from} AS date)
       AND a."activityDate" <= CAST(${to} AS date)
     GROUP BY a."userId"`;
}

type Link = { programmes: Set<string>; regions: Set<string> };

function addLink(map: Map<string, Link>, userId: string | null | undefined, program: unknown, state: unknown): void {
  if (!userId) return;
  let l = map.get(userId);
  if (!l) {
    l = { programmes: new Set(), regions: new Set() };
    map.set(userId, l);
  }
  const p = typeof program === 'string' ? program.trim() : '';
  const s = typeof state === 'string' ? state.trim() : '';
  if (p) l.programmes.add(p);
  if (s) l.regions.add(s);
}

const sortStrings = (s: Iterable<string>) => [...s].sort((a, b) => a.localeCompare(b));
const eqCI = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

function deviceLabel(phoneDays: number, computerDays: number): string {
  if (phoneDays > 0 && computerDays > 0) return 'Both';
  if (phoneDays > 0) return 'Phone';
  if (computerDays > 0) return 'Computer';
  return '';
}

function compareRows(sort: UsageSort): (a: UsageRow, b: UsageRow) => number {
  const byName = (a: UsageRow, b: UsageRow) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId);
  const lastMs = (r: UsageRow) => (r.lastSeenAt ? Date.parse(r.lastSeenAt) : -Infinity);
  switch (sort) {
    case 'days':
      return (a, b) => b.daysActive - a.daysActive || b.activeSeconds - a.activeSeconds || byName(a, b);
    case 'lastSeen':
      return (a, b) => lastMs(b) - lastMs(a) || byName(a, b);
    case 'name':
      return byName;
    case 'minutes':
    default:
      return (a, b) => b.activeSeconds - a.activeSeconds || b.daysActive - a.daysActive || byName(a, b);
  }
}

/** Max time the per-user aggregate may run (SET LOCAL statement_timeout inside its own transaction). */
export const USAGE_QUERY_TIMEOUT_MS = 20_000;

export const USAGE_NOT_MIGRATED_MESSAGE =
  'The usage report is not available yet: its database update has not been applied on this server. Please contact Gifsy.';
export const USAGE_TIMEOUT_MESSAGE =
  'The usage report took too long to build. Please try again, or choose a shorter date range or narrower filters.';

/**
 * Turn the two failures an admin could actually hit into clear messages instead of a bare 500:
 *  • the migration has not run (Postgres 42703 "column … does not exist" / 42P01) → 503 with a plain message;
 *  • the statement timeout fired (57014), or Prisma could not start the transaction in time (P2028 — the
 *    connection pool is busy) → 503 asking for a narrower range / to try again.
 */
export function usageQueryError(e: unknown): Error {
  const msg = String((e as { message?: unknown })?.message ?? e ?? '');
  const code = String((e as { code?: unknown; meta?: { code?: unknown } })?.meta?.code ?? (e as { code?: unknown })?.code ?? '');
  if (/42703|42P01/.test(code) || /42703|42P01|column .* does not exist|relation .* does not exist/i.test(msg)) {
    return new ServiceUnavailableException(USAGE_NOT_MIGRATED_MESSAGE);
  }
  // 57014 = statement timeout; P2028 = Prisma could not start / hold the transaction (pool wait or tx timeout).
  if (
    /57014|P2028/.test(code) ||
    /57014|P2028|statement timeout|canceling statement due to statement timeout|Unable to start a transaction/i.test(msg)
  ) {
    return new ServiceUnavailableException(USAGE_TIMEOUT_MESSAGE);
  }
  return e instanceof Error ? e : new Error(msg);
}

async function guardUsageQuery<T>(q: Promise<T>): Promise<T> {
  try {
    return await q;
  } catch (e) {
    throw usageQueryError(e);
  }
}

/** The aggregate in its own short transaction with a statement timeout (a huge tenant can never hang a request). */
async function runAggregate(prisma: PrismaService, clientId: string, p: UsageParams): Promise<AggRow[]> {
  return guardUsageQuery(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${USAGE_QUERY_TIMEOUT_MS}`);
      return tx.$queryRaw<AggRow[]>(usageAggregateSql(clientId, p.from, p.to));
    }, { maxWait: 5_000, timeout: USAGE_QUERY_TIMEOUT_MS + 5_000 }), // Prisma's 5 s interactive default is too short
  );
}

/**
 * Area columns (reports/area/user-area.ts): 4 tenant-wide reads, sequential, independent of the row count — run in
 * their own short transaction under the same statement timeout + friendly-503 guard as the aggregate, and cached per
 * tenant for USER_AREA_CACHE_TTL_MS so sorting / filtering / paging the page does not reload the hierarchy.
 */
function loadUsageArea(prisma: PrismaService, clientId: string): Promise<UserAreaResolver> {
  return cachedUserAreaResolver(clientId, () =>
    guardUsageQuery(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${USAGE_QUERY_TIMEOUT_MS}`);
        return loadUserAreaResolver(tx as unknown as AreaPrisma, clientId);
      }, { maxWait: 5_000, timeout: USAGE_QUERY_TIMEOUT_MS + 5_000 }),
    ),
  );
}

/** Build the whole report (all matching rows, sorted). Reads: users, outlets, assignments, one grouped aggregate. */
export async function buildUsageReport(
  prisma: PrismaService,
  clientIdRaw: string,
  p: UsageParams,
  now: Date = new Date(),
): Promise<UsageReport> {
  const clientId = requireUsageTenant(clientIdRaw);

  // Reads run SEQUENTIALLY (one pooled connection at a time, ~10 per instance) — never 5 in parallel. The heavy one
  // (the per-user aggregate) runs first so a missing migration / timeout fails fast before the roster reads.
  const agg = await runAggregate(prisma, clientId, p);
  const started = await guardUsageQuery(
    prisma.$queryRaw<Array<{ day: string }>>(Prisma.sql`
    SELECT to_char(MIN(x."activityDate"), 'YYYY-MM-DD') AS "day"
      FROM (SELECT "activityDate" FROM "user_activity_day"
             WHERE "clientId" = ${clientId} AND "visits" > 0
             ORDER BY "activityDate" ASC LIMIT 1) x`),
  );
  const users = await prisma.user.findMany({
    where: { clientId, deletedAt: null },
    select: {
      id: true,
      name: true,
      phone: true,
      role: true,
      status: true,
      salesUser: { select: { region: true, zone: true } },
    },
  });
  const outlets = await prisma.outlet.findMany({
    where: { clientId, deletedAt: null },
    select: { programName: true, state: true, partner: { select: { userId: true } }, parent: { select: { userId: true } } },
  });
  const assignments = await prisma.salesUserAssignment.findMany({
    where: { unassignedAt: null, salesUser: { clientId, deletedAt: null } },
    select: {
      salesUser: { select: { userId: true } },
      outlet: { select: { programName: true, state: true, deletedAt: true, clientId: true } },
      // A rep assigned at the owner covers its outlets; assigned at a PARENT group, it also covers the group's child
      // outlets (Outlet.parentId) — the same rule as the ASM column (reports/area/user-area.ts).
      partner: {
        select: {
          clientId: true,
          outlets: { where: { deletedAt: null }, select: { programName: true, state: true } },
          childOutlets: { where: { deletedAt: null }, select: { programName: true, state: true } },
        },
      },
    },
  });
  const area = await loadUsageArea(prisma, clientId);

  // ── programme / region per user + the dropdown catalogues (all tenant outlets) ──
  const links = new Map<string, Link>();
  const allPrograms = new Set<string>();
  const allRegions = new Set<string>();
  for (const o of outlets) {
    const prog = typeof o.programName === 'string' ? o.programName.trim() : '';
    const st = typeof o.state === 'string' ? o.state.trim() : '';
    if (prog) allPrograms.add(prog);
    if (st) allRegions.add(st);
    addLink(links, o.partner?.userId, o.programName, o.state);
    if (o.parent?.userId && o.parent.userId !== o.partner?.userId) addLink(links, o.parent.userId, o.programName, o.state);
  }
  const salesRegion = new Map<string, string>();
  for (const u of users) {
    const r = normText(u.salesUser?.region) ?? normText(u.salesUser?.zone);
    if (r) salesRegion.set(u.id, r);
  }
  for (const a of assignments) {
    const uid = a.salesUser?.userId;
    if (!uid) continue;
    if (a.outlet && !a.outlet.deletedAt && a.outlet.clientId === clientId) addLink(links, uid, a.outlet.programName, a.outlet.state);
    if (a.partner && a.partner.clientId === clientId) {
      for (const o of a.partner.outlets ?? []) addLink(links, uid, o.programName, o.state);
      for (const o of a.partner.childOutlets ?? []) addLink(links, uid, o.programName, o.state);
    }
  }
  for (const [uid, region] of salesRegion) {
    // An explicit employee-record region wins over the outlet-derived states for that sales user.
    const l = links.get(uid) ?? { programmes: new Set<string>(), regions: new Set<string>() };
    l.regions = new Set([region]);
    links.set(uid, l);
    allRegions.add(region);
  }

  const aggBy = new Map<string, AggRow>();
  for (const r of agg) aggBy.set(r.userId, r);

  const roles = sortStrings(new Set(users.map((u) => u.role as string)));

  // ── filter population (role / programme / region), then compute every row ──
  const inScope: UsageRow[] = [];
  for (const u of users) {
    if (p.role && u.role !== p.role) continue;
    const l = links.get(u.id);
    const programmes = l ? sortStrings(l.programmes) : [];
    const regions = l ? sortStrings(l.regions) : [];
    if (p.program && !programmes.some((x) => eqCI(x, p.program!))) continue;
    if (p.region && !regions.some((x) => eqCI(x, p.region!))) continue;
    const a = aggBy.get(u.id);
    const trackedDays = num(a?.trackedDays);
    const activeSeconds = num(a?.activeSeconds);
    const phoneDays = num(a?.phoneDays);
    const computerDays = num(a?.computerDays);
    const where = area.resolve({ id: u.id, role: u.role as string });
    inScope.push({
      userId: u.id,
      name: u.name ?? '',
      phone: u.phone ?? '',
      role: u.role as string,
      status: u.status as string,
      programmes,
      regions,
      asm: where.asm,
      zone: where.zone,
      state: where.state,
      city: where.city,
      daysActive: num(a?.daysActive),
      trackedDays,
      visits: num(a?.visits),
      minutes: Math.floor(activeSeconds / 60),
      activeSeconds,
      avgMinutesPerDay: trackedDays > 0 ? Math.round((activeSeconds / 60 / trackedDays) * 10) / 10 : null,
      appDays: num(a?.appDays),
      browserDays: num(a?.browserDays),
      phoneDays,
      computerDays,
      device: deviceLabel(phoneDays, computerDays),
      firstSeenAt: a?.firstSeenAt ? new Date(a.firstSeenAt).toISOString() : null,
      lastSeenAt: a?.lastSeenAt ? new Date(a.lastSeenAt).toISOString() : null,
    });
  }

  // Deactivated / suspended accounts count only if they actually used the app in the range (they did use it);
  // otherwise they are left out of the population and reported as one separate number.
  const DISABLED = new Set(['INACTIVE', 'SUSPENDED']);
  const active = inScope.filter((r) => r.daysActive > 0);
  const idleEnabled = inScope.filter((r) => r.daysActive === 0 && !DISABLED.has(r.status));
  const disabledIdle = inScope.length - active.length - idleEnabled.length;
  const tracked = active.filter((r) => r.trackedDays > 0);
  const totalSeconds = active.reduce((s, r) => s + r.activeSeconds, 0);
  const totals: UsageTotals = {
    usersInScope: active.length + idleEnabled.length,
    usersActive: active.length,
    usersInactive: idleEnabled.length,
    disabledAccountsExcluded: disabledIdle,
    avgDaysActive: active.length ? Math.round((active.reduce((s, r) => s + r.daysActive, 0) / active.length) * 10) / 10 : null,
    totalMinutes: Math.floor(totalSeconds / 60),
    usersTracked: tracked.length,
    avgMinutesPerTrackedUser: tracked.length ? Math.round((totalSeconds / 60 / tracked.length) * 10) / 10 : null,
    appUsers: active.filter((r) => r.appDays > 0).length,
    browserUsers: active.filter((r) => r.browserDays > 0).length,
    phoneUsers: active.filter((r) => r.phoneDays > 0).length,
    computerUsers: active.filter((r) => r.computerDays > 0).length,
  };

  const rows = (p.includeInactive ? [...active, ...idleEnabled] : active).sort(compareRows(p.sort));
  const range = {
    from: p.from,
    to: p.to,
    days: Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / DAY_MS) + 1,
  };

  return {
    generatedAt: now.toISOString(),
    timezone: 'Asia/Kolkata',
    range,
    trackingStartedOn: started?.[0]?.day ?? null,
    notes: { duration: USAGE_DURATION_NOTE, region: USAGE_REGION_NOTE, area: area.notes },
    asmHeader: area.asmHeader,
    filters: { roles, programs: sortStrings(allPrograms), regions: sortStrings(allRegions) },
    applied: { role: p.role, program: p.program, region: p.region, sort: p.sort, includeInactive: p.includeInactive },
    totals,
    rows,
  };
}

/** The JSON endpoint's payload: the report with ONE page of rows. */
export function pageOfUsageReport(r: UsageReport, p: UsageParams) {
  const totalRows = r.rows.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / p.pageSize));
  const page = Math.min(Math.max(1, p.page), pageCount);
  const start = (page - 1) * p.pageSize;
  return { ...r, page, pageSize: p.pageSize, pageCount, totalRows, rows: r.rows.slice(start, start + p.pageSize) };
}
