/**
 * App Adoption → "Download installed users (Excel)" — GET /v1/push/adoption/installed-users (owner 2026-11-16).
 *
 * One row per user who has ≥ 1 `pwa_install` row (i.e. opened the app as an installed/home-screen app), newest first
 * install first. Columns: Name · Phone · Role · Role Group · Zone · State · City · Employee ID · <level> ID × (≤ 5, the
 * tenant's levels ranked 1..5 by `level`, lowest first — Bajaj: ISR · SO · ASM · SM · ZH) · Outlet Code · Outlet Name ·
 * Platforms Installed · First Installed · Last Seen · Notifications Enabled · User Status, plus an "About" sheet explaining
 * the area and level-ID columns (reports/area/user-area.ts — owner 2026-11-20). Owner 2026-11-23 (platform-wide): the
 * ASM (name) column was REMOVED and replaced by the employee-ID-only level columns (`UserAreaResolver.resolveIds`).
 *
 * Population — the SAME as the App Adoption page's "Installed to home screen" number (`tenantInstallWhere` in
 * push/pwa-adoption.service.ts is the one definition both use), so the page number and the unfiltered file's row
 * count always match: install rows of this tenant whose user BELONGS to this tenant (a Gifsy operator who opened the
 * app while assumed in is excluded) and is NOT soft-deleted (owner policy: removed users' phone numbers must not
 * circulate). Inactive / suspended users are kept (status column says so).
 *
 * Scope (isolation-critical) — EXACTLY like GET /v1/push/adoption (PwaAdoptionService.adoption): every read is pinned
 * to the caller's JWT `clientId` (CLIENT_ADMIN / MIS_USER → own tenant; a GIFSY operator → the tenant they have
 * assumed; an un-assumed GIFSY_ADMIN → their home tenant, NEVER all tenants). No clientId param exists. A caller with
 * no tenant is refused before any read.
 *
 * Build order (audit before bytes): one grouped read of the tenant's installs (one small row per installed user — a
 * few thousand at most), then users / platforms / push subscriptions ≤ 1,000 users at a time; ALL rows are built in
 * memory first. Then:
 *   • 0 rows → 404 "0 users matched these filters." — no file, no audit row (no personal data left the system).
 *   • otherwise ONE AuditLog row (action EXPORT, entityType APP_ADOPTION: who, tenant, exact row count, filters) is
 *     written, and ONLY THEN is the workbook written. If the audit write fails the request fails before a single
 *     byte of the file is sent (the light-export stream turns a pre-byte error into an error response).
 *
 * Phone column: the last 10 digits (normalizePhoneLast10) so Indian numbers never become "'+91…" text cells; a number
 * that is not 10+ digits is written as stored. Always text.
 *
 * Audit granularity (L8, accepted): one audit row per BUILT file. A download that is built but then not saved by the
 * browser (client closes the tab mid-stream) is still audited — the record errs on the side of "may have left".
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { istDateTimeCell } from '../../../common/ist-date';
import { rungDisplayLabel } from '../../../common/hierarchy-labels';
import { normalizePhoneLast10 } from '../../../common/partner-group.helper';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import {
  InstalledUsersQueryDto,
  type InstalledUsersRoleGroup,
} from '../../../push/dto/push.dto';
import { tenantInstallWhere } from '../../../push/pwa-adoption.service';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import type { XlsxCell, XlsxStreamWriter } from '../../../common/xlsx-stream';
import { parseQueryDto } from './kind-support';
import {
  AREAS_FULL_HEADERS,
  AREAS_FULL_SHEET,
  areaCell,
  areasFullRow,
  loadUserAreaResolver,
  type AreaPrisma,
  type HierarchyIdLevel,
  type UserAreaResolver,
} from '../../../reports/area/user-area';

export interface InstalledUsersParams {
  roleGroup: InstalledUsersRoleGroup | null;
  /** YYYY-MM-DD (IST calendar day) — first install on/after it. */
  since: string | null;
}

/**
 * The FIXED column headers. The level-ID columns ("<level> ID", one per tenant level ranked 1..5) are inserted right
 * after 'Employee ID' by installedUsersHeaders(idLevels). Area columns (owner 2026-11-20) sit right after the role
 * columns; the ASM (name) column was removed 2026-11-23.
 */
export const INSTALLED_USERS_HEADERS = [
  'Name',
  'Phone',
  'Role',
  'Role Group',
  'Zone',
  'State',
  'City',
  // Employee ID (owner 2026-11-21, all tenants): the login's SalesUser.employeeCode; blank for anyone without a
  // sales employee record — the same blank Outlet Code shows for a sales user.
  'Employee ID',
  'Outlet Code',
  'Outlet Name',
  'Platforms Installed',
  'First Installed (IST)',
  'Last Seen (IST)',
  'Notifications Enabled',
  'User Status',
] as const;

/** Index of the first level-ID column (right after 'Employee ID'). */
export const INSTALLED_USERS_ID_COL = INSTALLED_USERS_HEADERS.indexOf('Employee ID') + 1;

/**
 * The level-ID headers: "<tenant level name> ID". A header equal (case-insensitive) to a fixed column or to an earlier
 * level header gets the internal level code appended — e.g. a level named "Employee" → "Employee ID (SO)" (never two
 * "Employee ID" columns).
 */
export function installedUsersIdHeaders(idLevels: readonly HierarchyIdLevel[]): string[] {
  const used = new Set<string>(INSTALLED_USERS_HEADERS.map((h) => h.toLowerCase()));
  return idLevels.map((l) => {
    const base = `${l.label} ID`;
    let out = base;
    for (let n = 1; used.has(out.toLowerCase()); n++) out = n === 1 ? `${base} (${l.code})` : `${base} (${l.code} ${n})`;
    used.add(out.toLowerCase());
    return out;
  });
}

/** The headers as written: the fixed columns with the level-ID columns after 'Employee ID'. */
export function installedUsersHeaders(idLevels: readonly HierarchyIdLevel[]): string[] {
  const fixed: string[] = [...INSTALLED_USERS_HEADERS];
  return [...fixed.slice(0, INSTALLED_USERS_ID_COL), ...installedUsersIdHeaders(idLevels), ...fixed.slice(INSTALLED_USERS_ID_COL)];
}

/** Column widths matching installedUsersHeaders (ID columns 14 wide). */
export function installedUsersWidths(idCount: number): number[] {
  const fixed = [26, 14, 16, 10, 16, 18, 18, 14, 16, 30, 22, 18, 18, 12, 14];
  return [...fixed.slice(0, INSTALLED_USERS_ID_COL), ...Array.from({ length: idCount }, () => 14), ...fixed.slice(INSTALLED_USERS_ID_COL)];
}

export const INSTALLED_USERS_ABOUT_SHEET = 'About';

/** Users read per batch (keeps every `IN (...)` list small). */
export const INSTALLED_USERS_CHUNK = 1000;

/** 404 text when the filters match nobody — the App Adoption page shows it as a neutral note (no file is saved). */
export const INSTALLED_USERS_NONE_MESSAGE = '0 users matched these filters.';

export const ROLE_GROUP_ROLES: Record<InstalledUsersRoleGroup, readonly UserRole[]> = {
  sales: ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'],
  partner: ['SSS', 'WHOLESALER', 'SUB_STOCKIST'],
  admin: ['CLIENT_ADMIN', 'MIS_USER', 'GIFSY_ADMIN', 'GIFSY_STAFF'],
};

const GROUP_LABEL: Record<InstalledUsersRoleGroup, string> = { sales: 'Sales', partner: 'Partner', admin: 'Admin' };

const PARTNER_ROLE_LABEL: Record<string, string> = { SSS: 'SSS', WHOLESALER: 'Wholesaler', SUB_STOCKIST: 'Sub-Stockist' };
const ADMIN_ROLE_LABEL: Record<string, string> = {
  CLIENT_ADMIN: 'Client admin',
  MIS_USER: 'MIS user',
  GIFSY_ADMIN: 'Gifsy admin',
  GIFSY_STAFF: 'Gifsy staff',
};
const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  SUSPENDED: 'Suspended',
  PENDING_VERIFICATION: 'Pending verification',
};
const PLATFORM_ORDER = ['ANDROID', 'IOS', 'DESKTOP', 'OTHER'];
const PLATFORM_LABEL: Record<string, string> = { ANDROID: 'Android', IOS: 'iOS', DESKTOP: 'Desktop', OTHER: 'Other' };

export function roleGroupOf(role: string): InstalledUsersRoleGroup | null {
  for (const g of Object.keys(ROLE_GROUP_ROLES) as InstalledUsersRoleGroup[]) {
    if ((ROLE_GROUP_ROLES[g] as readonly string[]).includes(role)) return g;
  }
  return null;
}

/** 00:00 IST of a YYYY-MM-DD day, or null when the string is not a real calendar date. */
export function istDayStart(day: string): Date | null {
  const d = new Date(`${day}T00:00:00+05:30`);
  if (Number.isNaN(d.getTime())) return null;
  // Reject roll-overs like 2026-02-31 (Date would silently move to March).
  const back = new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return back === day ? d : null;
}

function requireTenant(user: JwtPayload): string {
  const clientId = (user?.clientId ?? '').trim();
  if (!clientId) throw new ForbiddenException('App adoption export requires a tenant scope.');
  return clientId;
}

interface UserRow {
  id: string;
  name: string;
  phone: string;
  role: string;
  status: string;
  salesUser: { employeeCode: string | null; hierarchyLevel: { code: string; name: string | null } | null } | null;
  channelPartner: {
    partnerCode: string;
    outlets: Array<{ outletCode: string; name: string; outletType: { code: string; name: string } | null }>;
  } | null;
}

function roleLabel(clientId: string, u: UserRow, typeDisplay: Map<string, string>): string {
  const group = roleGroupOf(u.role);
  if (group === 'sales') {
    // The tenant's own level name ("Area Sales Manager" …) → the code-based label (Bajaj rung labels) → the role.
    const level = u.salesUser?.hierarchyLevel;
    const name = (level?.name ?? '').trim();
    if (name) return name;
    if (level?.code) return rungDisplayLabel(clientId, level.code);
    return u.role.replace(/^SALES_/, '').replace(/_/g, ' ');
  }
  if (group === 'partner') {
    const t = u.channelPartner?.outlets[0]?.outletType;
    if (t) return typeDisplay.get(t.code) || t.name || PARTNER_ROLE_LABEL[u.role] || u.role;
    return PARTNER_ROLE_LABEL[u.role] ?? u.role;
  }
  if (group === 'admin') return ADMIN_ROLE_LABEL[u.role] ?? u.role;
  return u.role === 'VENDOR' ? 'Vendor' : u.role;
}

function platformsLabel(platforms: Set<string>): string {
  return [...platforms]
    .sort((a, b) => {
      const ia = PLATFORM_ORDER.indexOf(a);
      const ib = PLATFORM_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    })
    .map((p) => PLATFORM_LABEL[p] ?? p)
    .join(', ');
}

/** Read everything and build every row in memory (no bytes written). */
async function buildRows(
  ctx: ExportRunContext,
  clientId: string,
  p: InstalledUsersParams,
): Promise<{ rows: XlsxCell[][]; fullAreas: string[][]; area: UserAreaResolver | null }> {
  const { prisma } = ctx;
  // ── 1. One row per installed user: first install + last seen (tenant-pinned, shared population). ──
  const groups = await prisma.pwaInstall.groupBy({
    by: ['userId'],
    where: tenantInstallWhere(clientId),
    _min: { installedAt: true },
    _max: { lastSeenAt: true },
  });
  const since = p.since ? istDayStart(p.since) : null;
  const ordered = groups
    .map((g) => ({ userId: g.userId, first: g._min.installedAt, last: g._max.lastSeenAt }))
    .filter((g): g is { userId: string; first: Date; last: Date | null } => !!g.first)
    .filter((g) => !since || g.first.getTime() >= since.getTime())
    .sort((a, b) => b.first.getTime() - a.first.getTime() || a.userId.localeCompare(b.userId));
  if (!ordered.length) return { rows: [], fullAreas: [], area: null };

  // Area columns (Zone / State / City) + level-ID columns: the tenant's hierarchy + outlet geography, read ONCE (4 queries)
  // whatever the row count — see reports/area/user-area.ts.
  const area = await loadUserAreaResolver(prisma as unknown as AreaPrisma, clientId);

  // Per-tenant outlet-type display names ("Retailer" / "Wholesaler" …): displayName ?? OutletType.name.
  const typeDisplay = new Map<string, string>();
  if (p.roleGroup !== 'sales' && p.roleGroup !== 'admin') {
    const typeConfigs = await prisma.outletTypeClientConfig.findMany({
      where: { clientId, displayName: { not: null } },
      select: { displayName: true, outletType: { select: { code: true } } },
    });
    for (const tc of typeConfigs) {
      const dn = (tc.displayName ?? '').trim();
      if (dn) typeDisplay.set(tc.outletType.code, dn);
    }
  }

  const roleFilter = p.roleGroup ? { role: { in: [...ROLE_GROUP_ROLES[p.roleGroup]] } } : {};
  const rows: XlsxCell[][] = [];
  const fullAreas: string[][] = []; // above-ASM rows' full State / City lists ("Areas (full)" sheet)
  for (let i = 0; i < ordered.length; i += INSTALLED_USERS_CHUNK) {
    const chunk = ordered.slice(i, i + INSTALLED_USERS_CHUNK);
    const ids = chunk.map((c) => c.userId);
    const [users, installs, subs] = await Promise.all([
      prisma.user.findMany({
        // clientId + deletedAt pinned again (defence in depth, same as tenantInstallWhere): an install row can never
        // surface another tenant's user or a removed user's phone number.
        where: { id: { in: ids }, clientId, deletedAt: null, ...roleFilter },
        select: {
          id: true,
          name: true,
          phone: true,
          role: true,
          status: true,
          // employeeCode rides on this SAME per-chunk read (no extra query). userId is @unique on SalesUser, so a
          // login has at most one row — it is shown whether or not it is soft-deleted (it is the only one there is).
          salesUser: { select: { employeeCode: true, hierarchyLevel: { select: { code: true, name: true } } } },
          channelPartner: {
            select: {
              partnerCode: true,
              outlets: {
                where: { deletedAt: null },
                orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
                take: 1,
                select: { outletCode: true, name: true, outletType: { select: { code: true, name: true } } },
              },
            },
          },
        },
      }) as unknown as Promise<UserRow[]>,
      prisma.pwaInstall.findMany({ where: { clientId, userId: { in: ids } }, select: { userId: true, platform: true } }),
      prisma.pushSubscription.groupBy({ by: ['userId'], where: { clientId, userId: { in: ids } } }),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    const platforms = new Map<string, Set<string>>();
    for (const r of installs) (platforms.get(r.userId) ?? platforms.set(r.userId, new Set()).get(r.userId)!).add(r.platform);
    const notified = new Set(subs.map((s) => s.userId));

    for (const c of chunk) {
      const u = byId.get(c.userId);
      if (!u) continue; // other role group (or not a current user of this tenant)
      const group = roleGroupOf(u.role);
      const outlet = u.channelPartner?.outlets[0];
      const a = area.resolve({ id: u.id, role: u.role });
      const phone = normalizePhoneLast10(u.phone) ?? u.phone ?? '';
      const role = roleLabel(clientId, u, typeDisplay);
      const full = areasFullRow(u.name ?? '', phone, role, a);
      if (full) fullAreas.push(full);
      rows.push([
        u.name ?? '',
        phone,
        role,
        group ? GROUP_LABEL[group] : 'Other',
        areaCell(a.zone), // full lists (above-ASM City / State = counts; full lists on the "Areas (full)" sheet)
        areaCell(a.state),
        areaCell(a.city),
        (u.salesUser?.employeeCode ?? '').trim(),
        ...area.resolveIds({ id: u.id, role: u.role }), // level IDs (same tenant-wide load — no extra query)
        outlet?.outletCode ?? (group === 'partner' ? u.channelPartner?.partnerCode ?? '' : ''),
        outlet?.name ?? '',
        platformsLabel(platforms.get(u.id) ?? new Set()),
        istDateTimeCell(c.first),
        c.last ? istDateTimeCell(c.last) : '',
        notified.has(u.id) ? 'Yes' : 'No',
        STATUS_LABEL[u.status] ?? u.status,
      ]);
    }
  }
  return { rows, fullAreas, area };
}

async function run(ctx: ExportRunContext, p: InstalledUsersParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const clientId = requireTenant(ctx.user);

  // 1. Build every row in memory — nothing has been written to the response yet.
  const { rows, fullAreas, area } = await buildRows(ctx, clientId, p);

  // 2. Nobody matched → an honest "0 users" answer instead of an empty file (no personal data → no audit row).
  if (!rows.length || !area) throw new NotFoundException(INSTALLED_USERS_NONE_MESSAGE);

  // 3. Audit BEFORE any byte leaves: who, which tenant, exactly how many rows, which filters. A failure here rejects
  //    the run before the workbook is started, so the caller gets an error response and no file.
  await ctx.prisma.auditLog.create({
    data: {
      action: 'EXPORT',
      entityType: 'APP_ADOPTION',
      entityId: clientId,
      actorId: ctx.user.sub,
      metadata: {
        route: 'installed-users',
        clientId,
        assumed: !!ctx.user.assumed,
        actorRole: ctx.user.role,
        rowCount: rows.length,
        filters: { roleGroup: p.roleGroup, since: p.since },
      },
    },
  });

  // 4. Only now write the workbook.
  const sheet = await out.addSheet('Installed users', installedUsersHeaders(area.idLevels), {
    widths: installedUsersWidths(area.idLevels.length),
  });
  for (const r of rows) await sheet.addRow(r);

  // 5. "About" — how to read the area columns (not data rows; not counted).
  const about = await out.addSheet(INSTALLED_USERS_ABOUT_SHEET, ['About this report', ''], { widths: [22, 120] });
  const [, geoNote, blankNote] = area.notes;
  await about.addRow(['Zone / State / City', geoNote]);
  await about.addRow(['Not set / Not in hierarchy', blankNote]);
  await about.addRow(['"N cities" / "N states"', area.notes[3] ?? '']);
  const idHeaders = installedUsersIdHeaders(area.idLevels);
  const [idWhat, ...idRows] = area.idNotes;
  await about.addRow([idHeaders.length ? idHeaders.join(' · ') : 'Level ID columns', idWhat ?? '']);
  const idLabels = ['Level IDs — sales users', 'Level IDs — retailers / wholesalers', 'Level IDs — admin / Gifsy / vendor'];
  for (let i = 0; i < idRows.length; i++) await about.addRow([idLabels[i] ?? 'Level IDs', idRows[i]]);

  // 6. Full State / City lists of the rows summarised above (only when there are any; not counted).
  if (fullAreas.length) {
    const fullSheet = await out.addSheet(AREAS_FULL_SHEET, AREAS_FULL_HEADERS, { widths: [26, 14, 16, 60, 100] });
    for (const r of fullAreas) await fullSheet.addRow(r);
  }
  return { rowCount: rows.length };
}

export const APP_INSTALLED_USERS_KIND: ExportKindDef<InstalledUsersParams> = {
  kind: 'app-installed-users',
  label: 'App installed users',
  // Same as GET /v1/push/adoption: @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'), no @RequirePermission.
  access: { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER'] },
  parseParams(raw: unknown, user: JwtPayload) {
    const q = parseQueryDto(InstalledUsersQueryDto, raw);
    if (q.since && !istDayStart(q.since)) {
      // Same 400 shape as the DTO's own messages.
      throw new BadRequestException(['since must be a real calendar date']);
    }
    requireTenant(user); // fail closed at request time (403, never queued)
    return { roleGroup: q.roleGroup ?? null, since: q.since ?? null };
  },
  // One row per installed user of ONE tenant (a few thousand at most) → always streams instantly.
  isHeavy: () => false,
  describeParams: (p) =>
    [p.roleGroup ? `${GROUP_LABEL[p.roleGroup]} users` : 'All users', p.since ? `installed since ${p.since}` : 'any install date'].join(' · '),
  fileName: (_p, now) => `app-installed-users-${now.toISOString().slice(0, 10)}.xlsx`,
  run,
};
