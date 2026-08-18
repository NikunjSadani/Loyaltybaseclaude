import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user) throw new ForbiddenException('Access denied.');

    // GIFSY_ADMIN is the platform super-admin — it passes every role check.
    if (user.role === 'GIFSY_ADMIN') return true;

    // RBAC Option-X — GIFSY_STAFF: the coarse @Roles floor DEFERS to the fine @RequirePermission
    // gate for staff. Admit a staff member past @Roles to any route carrying a @RequirePermission
    // (their assigned GifsyRole then decides, enforced ALWAYS-ON in PermissionGuard) — so the
    // owner's self-service roles work from the FULL permission catalog without curating @Roles on
    // every controller. Two exclusions stay owner-only regardless of any grant, and fall through
    // to the normal allow-list check below (staff isn't listed → 403):
    //   1) a route with NO @RequirePermission — there is no fine gate to defer to; AND
    //   2) staff/role administration itself (users:manage_roles) — delegating the power to create
    //      staff / edit roles stays exclusively with the owner.
    // This branch only affects the brand-new GIFSY_STAFF role, so existing roles are unchanged.
    if (user.role === 'GIFSY_STAFF') {
      const permission = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (permission && permission !== 'users:manage_roles') return true;
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Access denied. Required: ${requiredRoles.join(' or ')}. Your role: ${user.role}`,
      );
    }
    return true;
  }
}
