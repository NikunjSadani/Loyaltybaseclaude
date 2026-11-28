import type { Prisma } from '@prisma/client';
import { normalizePhoneLast10 } from '../common/partner-group.helper';

/**
 * User Accounts "Outlet ID" column + outlet-ID search (GET /admin/users).
 *
 * Which outlets a login covers mirrors the OPERABLE-context rule of `resolveOperableContexts`
 * (common/partner-group.helper.ts) — the same rule the partner app uses for outlet switching:
 *   - the login's OWN partner: `userId = login`, same tenant, `deletedAt: null`, NOT a parent;
 *     its non-deleted outlets (primary = isPrimary desc, createdAt asc — the login/eligibility rule);
 *   - plus login-less SIBLING partners: same `groupId`, `userId: null`, NOT a parent, `deletedAt: null`,
 *     whose phone ends with the login's last-10-digit phone; only their ACTIVE non-deleted outlets
 *     (OPERABLE_OUTLET_SELECT — a sibling without an active outlet is not operable).
 * The displayed code is ALWAYS the login's own primary outlet; siblings only feed the "+N" count and
 * the search. Every query is tenant-pinned; everything is batched per page (never per row).
 */

type Db = Pick<Prisma.TransactionClient, 'channelPartner'>;

const PRIMARY_FIRST: Prisma.OutletOrderByWithRelationInput[] = [{ isPrimary: 'desc' }, { createdAt: 'asc' }];

/**
 * Escape LIKE metacharacters so a typed "%" or "_" (or "\") matches literally. Prisma 7.8 passes a
 * `startsWith` value straight into `ILIKE ($1 || '%')` WITHOUT escaping (verified against the
 * installed client's generated SQL), and Postgres' default LIKE escape character is the backslash.
 */
export function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The partner filter shared by the column lookup and the search: tenant, not deleted, not a parent. */
function livePartner(clientId: string) {
  return { clientId, deletedAt: null, isParent: false } as const;
}

/** User-where branch: the login's OWN partner has a non-deleted outlet whose code starts with the prefix. */
export function ownOutletCodeSearchWhere(clientId: string, escapedPrefix: string): Prisma.UserWhereInput {
  return {
    channelPartner: {
      ...livePartner(clientId),
      outlets: {
        some: { clientId, deletedAt: null, outletCode: { startsWith: escapedPrefix, mode: 'insensitive' } },
      },
    },
  };
}

/**
 * Login ids that OPERATE a login-less sibling whose ACTIVE outlet code starts with the prefix. Two
 * batched queries regardless of result size (siblings by code, then the logins of those groups);
 * the phone match is the operable rule (sibling.phone ends with the login's last-10 digits).
 */
export async function loginIdsOperatingMatchingSiblings(
  db: Db,
  clientId: string,
  escapedPrefix: string,
): Promise<string[]> {
  const siblings = await db.channelPartner.findMany({
    where: {
      ...livePartner(clientId),
      userId: null,
      groupId: { not: null },
      outlets: {
        some: {
          clientId,
          isActive: true,
          deletedAt: null,
          outletCode: { startsWith: escapedPrefix, mode: 'insensitive' },
        },
      },
    },
    select: { groupId: true, phone: true },
  });
  const phonesByGroup = new Map<string, string[]>();
  for (const s of siblings) {
    if (!s.groupId || !s.phone) continue;
    const list = phonesByGroup.get(s.groupId) ?? [];
    list.push(s.phone);
    phonesByGroup.set(s.groupId, list);
  }
  if (phonesByGroup.size === 0) return [];

  const logins = await db.channelPartner.findMany({
    where: { ...livePartner(clientId), userId: { not: null }, groupId: { in: [...phonesByGroup.keys()] } },
    select: { userId: true, groupId: true, user: { select: { phone: true } } },
  });
  const ids = new Set<string>();
  for (const l of logins) {
    const last10 = normalizePhoneLast10(l.user?.phone);
    if (!l.userId || !l.groupId || !last10) continue;
    if ((phonesByGroup.get(l.groupId) ?? []).some((p) => p.endsWith(last10))) ids.add(l.userId);
  }
  return [...ids];
}

export interface LoginOutletIds {
  outletCode: string | null;
  additionalOutletCount: number;
}

/**
 * Batched per-page lookup: for each login → its own primary outlet code + how many MORE outlets it
 * can operate (own extra outlets + operable siblings' active outlets). 1 query for own partners,
 * plus 1 for siblings only when a grouped login is on the page. Non-partner logins are absent.
 */
export async function resolveLoginOutletIds(
  db: Db,
  clientId: string,
  logins: { id: string; phone: string }[],
): Promise<Map<string, LoginOutletIds>> {
  const out = new Map<string, LoginOutletIds>();
  if (logins.length === 0) return out;

  const owns = await db.channelPartner.findMany({
    where: { ...livePartner(clientId), userId: { in: logins.map((l) => l.id) } },
    select: {
      userId: true,
      groupId: true,
      outlets: { where: { clientId, deletedAt: null }, select: { outletCode: true }, orderBy: PRIMARY_FIRST },
    },
  });

  const phoneById = new Map(logins.map((l) => [l.id, l.phone]));
  const grouped: { userId: string; groupId: string; last10: string }[] = [];
  for (const o of owns) {
    if (!o.userId) continue;
    out.set(o.userId, {
      outletCode: o.outlets[0]?.outletCode ?? null,
      additionalOutletCount: Math.max(0, o.outlets.length - 1),
    });
    const last10 = normalizePhoneLast10(phoneById.get(o.userId));
    if (o.groupId && last10) grouped.push({ userId: o.userId, groupId: o.groupId, last10 });
  }

  if (grouped.length > 0) {
    const siblings = await db.channelPartner.findMany({
      where: { ...livePartner(clientId), userId: null, groupId: { in: [...new Set(grouped.map((g) => g.groupId))] } },
      select: {
        groupId: true,
        phone: true,
        _count: { select: { outlets: { where: { clientId, isActive: true, deletedAt: null } } } },
      },
    });
    for (const g of grouped) {
      const extra = siblings
        .filter((s) => s.groupId === g.groupId && !!s.phone && s.phone.endsWith(g.last10))
        .reduce((n, s) => n + (s._count?.outlets ?? 0), 0);
      const row = out.get(g.userId);
      if (row && extra > 0) row.additionalOutletCount += extra;
    }
  }
  return out;
}
