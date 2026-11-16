/**
 * App Adoption → "Download installed users (Excel)" — GET /v1/push/adoption/installed-users (owner 2026-11-16).
 *
 * One row per user who has ≥ 1 `pwa_install` row (i.e. opened the app as an installed/home-screen app), newest first
 * install first. Columns: Name · Phone · Role · Role Group · Outlet Code · Outlet Name · Platforms Installed ·
 * First Installed · Last Seen · Notifications Enabled · User Status.
 *
 * Scope (isolation-critical) — EXACTLY like GET /v1/push/adoption (PwaAdoptionService.adoption): every read is pinned
 * to the caller's JWT `clientId` (CLIENT_ADMIN / MIS_USER → own tenant; a GIFSY operator → the tenant they have
 * assumed; an un-assumed GIFSY_ADMIN → their home tenant, NEVER all tenants). No clientId param exists. A caller with
 * no tenant is refused before any read.
 *
 * Paging: one grouped read of the tenant's installs (one small row per installed user — a few thousand at most), then
 * users / platforms / push subscriptions are read ≤ 1,000 users at a time and written before the next read.
 *
 * Phone numbers are personal data: every built file writes ONE AuditLog row (action EXPORT, entityType APP_ADOPTION)
 * with who, tenant, row count and filters. If that write fails the download fails (never an unaudited file).
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { istDateTimeCell } from '../../../common/ist-date';
import { rungDisplayLabel } from '../../../common/hierarchy-labels';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import {
  InstalledUsersQueryDto,
  type InstalledUsersRoleGroup,
} from '../../../push/dto/push.dto';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import type { XlsxStreamWriter } from '../../../common/xlsx-stream';
import { parseQueryDto } from './kind-support';

export interface InstalledUsersParams {
  roleGroup: InstalledUsersRoleGroup | null;
  /** YYYY-MM-DD (IST calendar day) — first install on/after it. */
  since: string | null;
}

export const INSTALLED_USERS_HEADERS = [
  'Name',
  'Phone',
  'Role',
  'Role Group',
  'Outlet Code',
  'Outlet Name',
  'Platforms Installed',
  'First Installed (IST)',
  'Last Seen (IST)',
  'Notifications Enabled',
  'User Status',
] as const;

/** Users read per batch (keeps every `IN (...)` list small). */
export const INSTALLED_USERS_CHUNK = 1000;

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
  deletedAt: Date | null;
  salesUser: { hierarchyLevel: { code: string } | null } | null;
  channelPartner: {
    partnerCode: string;
    outlets: Array<{ outletCode: string; name: string; outletType: { code: string; name: string } | null }>;
  } | null;
}

function roleLabel(clientId: string, u: UserRow, typeDisplay: Map<string, string>): string {
  const group = roleGroupOf(u.role);
  if (group === 'sales') {
    const code = u.salesUser?.hierarchyLevel?.code;
    if (code) return rungDisplayLabel(clientId, code);
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

function statusLabel(u: UserRow): string {
  if (u.deletedAt) return 'Deleted';
  return STATUS_LABEL[u.status] ?? u.status;
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

async function run(ctx: ExportRunContext, p: InstalledUsersParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const clientId = requireTenant(ctx.user);
  const { prisma } = ctx;
  const sheet = await out.addSheet('Installed users', [...INSTALLED_USERS_HEADERS], {
    widths: [26, 14, 16, 10, 16, 30, 22, 18, 18, 12, 14],
  });

  // ── 1. One row per installed user: first install + last seen (tenant-pinned). ──
  const groups = await prisma.pwaInstall.groupBy({
    by: ['userId'],
    where: { clientId },
    _min: { installedAt: true },
    _max: { lastSeenAt: true },
  });
  const since = p.since ? istDayStart(p.since) : null;
  const ordered = groups
    .map((g) => ({ userId: g.userId, first: g._min.installedAt, last: g._max.lastSeenAt }))
    .filter((g): g is { userId: string; first: Date; last: Date | null } => !!g.first)
    .filter((g) => !since || g.first.getTime() >= since.getTime())
    .sort((a, b) => b.first.getTime() - a.first.getTime() || a.userId.localeCompare(b.userId));

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
  let written = 0;
  for (let i = 0; i < ordered.length; i += INSTALLED_USERS_CHUNK) {
    const chunk = ordered.slice(i, i + INSTALLED_USERS_CHUNK);
    const ids = chunk.map((c) => c.userId);
    const [users, installs, subs] = await Promise.all([
      prisma.user.findMany({
        // clientId pinned again: an install row can never surface another tenant's user.
        where: { id: { in: ids }, clientId, ...roleFilter },
        select: {
          id: true,
          name: true,
          phone: true,
          role: true,
          status: true,
          deletedAt: true,
          salesUser: { select: { hierarchyLevel: { select: { code: true } } } },
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
      if (!u) continue; // other role group, or not a user of this tenant
      const group = roleGroupOf(u.role);
      const outlet = u.channelPartner?.outlets[0];
      await sheet.addRow([
        u.name ?? '',
        u.phone ?? '',
        roleLabel(clientId, u, typeDisplay),
        group ? GROUP_LABEL[group] : 'Other',
        outlet?.outletCode ?? (group === 'partner' ? u.channelPartner?.partnerCode ?? '' : ''),
        outlet?.name ?? '',
        platformsLabel(platforms.get(u.id) ?? new Set()),
        istDateTimeCell(c.first),
        c.last ? istDateTimeCell(c.last) : '',
        notified.has(u.id) ? 'Yes' : 'No',
        statusLabel(u),
      ]);
      written++;
    }
  }

  // Personal data (phone numbers) left the system — record who, which tenant, how many rows, which filters.
  await prisma.auditLog.create({
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
        rowCount: written,
        filters: { roleGroup: p.roleGroup, since: p.since },
      },
    },
  });
  return { rowCount: written };
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
