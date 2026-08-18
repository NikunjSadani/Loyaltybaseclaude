import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { isPermission, type Permission } from './permissions';

/**
 * RBAC Option-X — resolves a GIFSY_STAFF user's effective permission set from
 * their assigned GifsyRole. Used by PermissionGuard (only when enforcement is
 * active AND the request user's role is GIFSY_STAFF).
 *
 * Caching: a small in-process Map keyed by roleId with a short TTL
 * (CACHE_TTL_MS = 30s). This keeps the guard off the DB on hot paths while
 * bounding staleness — a role edit (or a soft-delete) takes effect within ~30s
 * without any explicit invalidation. NOTE: this is a per-instance cache; with
 * multiple API instances each converges independently within the TTL. The cache
 * is intentionally NOT the enforcement kill-switch — that is the uncached
 * RBAC_ENFORCEMENT env + per-tenant flag checked in the guard before we get here.
 *
 * Fail-closed: a missing, soft-deleted (deletedAt != null), or unknown role
 * resolves to an EMPTY set → the guard denies. Unknown/stale permission strings
 * stored on the role are validated via isPermission() and silently dropped.
 */
@Injectable()
export class GifsyRoleService {
  /** Staleness bound for a role's permission set. Documented in the class doc. */
  static readonly CACHE_TTL_MS = 30_000;

  private readonly cache = new Map<
    string,
    { expiresAt: number; perms: Set<Permission> }
  >();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the effective (validated) permission set for a GifsyRole id.
   * Empty set for null/empty/unknown/soft-deleted roles (fail-closed).
   */
  async getPermissions(roleId: string | null | undefined): Promise<Set<Permission>> {
    if (!roleId) return new Set();

    const now = Date.now();
    const hit = this.cache.get(roleId);
    if (hit && hit.expiresAt > now) return hit.perms;

    const role = await this.prisma.gifsyRole.findFirst({
      where: { id: roleId, deletedAt: null },
      select: { permissions: true },
    });

    const perms = new Set<Permission>();
    if (role) {
      for (const p of role.permissions) {
        if (isPermission(p)) perms.add(p);
      }
    }

    // Cache both hits and misses (negative caching) so a bad/stale id can't
    // hammer the DB; the empty-set miss also expires after CACHE_TTL_MS.
    this.cache.set(roleId, {
      expiresAt: now + GifsyRoleService.CACHE_TTL_MS,
      perms,
    });
    return perms;
  }

  /** Test/ops hook — drop the in-process cache immediately. */
  clearCache(): void {
    this.cache.clear();
  }
}
