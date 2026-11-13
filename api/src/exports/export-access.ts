import { ForbiddenException, Injectable } from '@nestjs/common';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { can } from '../common/rbac/can';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import type { Permission } from '../common/rbac/permissions';
import { TenantService } from '../tenant/tenant.service';
import type { ExportAccess } from './export-kinds';

/**
 * The SAME decision the global RolesGuard + PermissionGuard make for a route carrying `@Roles(...access.roles)` and
 * `@RequirePermission(access.permission)` — applied programmatically, because a generic `POST admin/exports {kind}`
 * and the download of a prepared file have no per-report decorators. Parity with the two guards is pinned by
 * export-access.spec.ts (it runs the real guards against the same matrix). Keep the two in step.
 *
 *  Roles (RolesGuard): GIFSY_ADMIN always passes; GIFSY_STAFF passes the roles floor when a permission is required and
 *  it is not 'users:manage_roles'; everyone else must be listed.
 *  Permission (PermissionGuard): GIFSY_STAFF → its GifsyRole must hold it (always on, fail-closed); legacy roles →
 *  only when env RBAC_ENFORCEMENT='true' AND the tenant's rbacEnforcement feature is on, then can(role, permission).
 */
@Injectable()
export class ExportAccessChecker {
  constructor(
    private readonly gifsyRoles: GifsyRoleService,
    private readonly tenant: TenantService,
  ) {}

  async allowed(user: JwtPayload, access: ExportAccess): Promise<boolean> {
    try {
      await this.assert(user, access);
      return true;
    } catch (e) {
      if (e instanceof ForbiddenException) return false;
      throw e;
    }
  }

  async assert(user: JwtPayload, access: ExportAccess): Promise<void> {
    if (!user) throw new ForbiddenException('Access denied.');
    const permission = access.permission as Permission | undefined;

    // ── RolesGuard ──
    if (access.roles.length > 0 && user.role !== 'GIFSY_ADMIN') {
      const staffDefers = user.role === 'GIFSY_STAFF' && !!permission && permission !== 'users:manage_roles';
      if (!staffDefers && !access.roles.includes(user.role)) {
        throw new ForbiddenException(`Access denied. Required: ${access.roles.join(' or ')}. Your role: ${user.role}`);
      }
    }

    // ── PermissionGuard ──
    if (!permission) return;
    if (user.role === 'GIFSY_STAFF') {
      const perms = await this.gifsyRoles.getPermissions(user.gifsyRoleId);
      if (perms.has(permission)) return;
      throw new ForbiddenException(`Forbidden: missing permission ${permission}`);
    }
    if (process.env.RBAC_ENFORCEMENT !== 'true') return;
    const enabled = await this.tenant.isFeatureEnabled(user.clientId ?? '', 'rbacEnforcement');
    if (!enabled) return;
    if (can(user.role ?? '', permission)) return;
    throw new ForbiddenException(`Forbidden: missing permission ${permission}`);
  }
}
