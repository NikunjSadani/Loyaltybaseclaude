import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * RBAC Option-X (P5) — resolves which tenants a GIFSY_STAFF operator may work in.
 *
 * The TENANT axis, orthogonal to the FEATURE axis (GifsyRoleService). A staff may ASSUME
 * (and thereby operate on) only a tenant they hold a `GifsyStaffTenantGrant` for; un-assumed
 * staff are NOT platform-wide (see common/tenant-scope.ts). Deny-by-default: zero grants →
 * empty set → the staff can assume nothing.
 *
 * Caching mirrors GifsyRoleService: a small per-instance Map keyed by userId with a 30s TTL,
 * so grant reads stay off the hot path while bounding staleness. It is NOT the kill-switch:
 * a grant REVOCATION also revokes the staff's live sessions (stamp-before-sweep in
 * GifsyStaffService), and callers should invalidate(userId) on any grant change so a removed
 * tenant takes effect on the next request rather than up to 30s later.
 *
 * Extension point: to add teams later, union team-derived grants inside grantedTenantIds()
 * behind the same signature — no call-site changes.
 */
@Injectable()
export class GifsyTenantGrantService {
  /** Staleness bound for a staff's granted-tenant set. */
  static readonly CACHE_TTL_MS = 30_000;

  private readonly cache = new Map<string, { expiresAt: number; clientIds: Set<string> }>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The set of tenant slugs (Client.id) this staff user may assume/operate in.
   * Empty set for an unknown user or a staff with no grants (deny-by-default).
   */
  async grantedTenantIds(userId: string): Promise<Set<string>> {
    if (!userId) return new Set();

    const now = Date.now();
    const hit = this.cache.get(userId);
    if (hit && hit.expiresAt > now) return hit.clientIds;

    const grants = await this.prisma.gifsyStaffTenantGrant.findMany({
      where: { userId },
      select: { clientId: true },
    });

    const clientIds = new Set(grants.map((g) => g.clientId));
    this.cache.set(userId, {
      expiresAt: now + GifsyTenantGrantService.CACHE_TTL_MS,
      clientIds,
    });
    return clientIds;
  }

  /** True iff this staff may assume/operate in `clientId`. */
  async mayOperateOnTenant(userId: string, clientId: string): Promise<boolean> {
    return (await this.grantedTenantIds(userId)).has(clientId);
  }

  /** Drop one user's cached grant set — call on any grant change (add/remove). */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  /** Test/ops hook — drop the whole cache. */
  clearCache(): void {
    this.cache.clear();
  }
}
