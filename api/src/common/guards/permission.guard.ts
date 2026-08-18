import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { can } from '../rbac/can';
import type { Permission } from '../rbac/permissions';
import { TenantService } from '../../tenant/tenant.service';
import { GifsyRoleService } from '../rbac/gifsy-role.service';

/**
 * RBAC permission enforcement — the Nest port of lib/rbac/require-permission.ts.
 *
 * GIFSY_STAFF (RBAC Option-X): ALWAYS enforced (fail-closed), independent of the flags below.
 * It is a brand-new role with no legacy routes, so its @RequirePermission check is live from
 * day one — and once a route admits GIFSY_STAFF at @Roles, this check is its ONLY fine gate,
 * so it must not be flag-gated (else a staff would reach the route unchecked while the flag is
 * off). Effective perms = the user's assigned GifsyRole set (null/unknown/deleted → empty → deny).
 *
 * LEGACY roles: two-level flag (the common OFF case costs nothing — no DB read):
 *   Level 1 — env RBAC_ENFORCEMENT === 'true'                (global master switch)
 *   Level 2 — tenant features.rbacEnforcement === true       (per-tenant opt-in)
 * Enforcement applies only when BOTH are active. Fail-open: unknown tenant / flag
 * off → allow (the per-route @Roles checks still gate access).
 *
 * @Public routes and routes without @RequirePermission are never permission-gated.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenant: TenantService,
    private readonly gifsyRoles: GifsyRoleService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    // No @RequirePermission on this route → nothing to enforce.
    if (!permission) return true;

    // @Public routes are intentionally open — never permission-gate them. A @Public route may
    // still carry @RequirePermission for the in-session case, but a tokenless hit must pass
    // (JwtAuthGuard already skipped auth). Matches the 'isPublic' check in JwtAuthGuard/TenantGuard.
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const user = ctx.switchToHttp().getRequest().user as
      | { role?: string; clientId?: string; gifsyRoleId?: string | null }
      | undefined;

    // RBAC Option-X — GIFSY_STAFF is ALWAYS enforced (fail-closed), BEFORE the flag gates:
    // it is a brand-new role with no legacy routes, so enforcing from day one has no regression
    // risk, and once a route admits GIFSY_STAFF at @Roles this is its ONLY fine gate (flag-gating
    // it would let a staff hit the route unchecked while the flag is off). Effective access = the
    // assigned GifsyRole's permissions (null/unknown/soft-deleted role → empty set → denied).
    // On a non-@Public route the upstream JwtAuthGuard guarantees `user` is present.
    if (user?.role === 'GIFSY_STAFF') {
      const perms = await this.gifsyRoles.getPermissions(user.gifsyRoleId);
      if (perms.has(permission)) return true;
      throw new ForbiddenException(`Forbidden: missing permission ${permission}`);
    }

    // ── LEGACY roles: flag-gated (the common OFF case costs nothing — no DB read) ─────────────
    // Level 1 — env master switch OFF (default) → no-op.
    if (process.env.RBAC_ENFORCEMENT !== 'true') return true;
    if (!user) throw new UnauthorizedException('Authentication required.');
    // Level 2 — per-tenant opt-in (fail-open if not enabled / unknown tenant).
    const enabled = await this.tenant.isFeatureEnabled(user.clientId ?? '', 'rbacEnforcement');
    if (!enabled) return true;

    if (can(user.role ?? '', permission)) return true;
    throw new ForbiddenException(`Forbidden: missing permission ${permission}`);
  }
}
