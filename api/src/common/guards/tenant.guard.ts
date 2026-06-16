import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * TenantGuard — the application-layer tenant chokepoint (Phase S, S5).
 *
 * Scope (deliberately modest, see docs/spec/gap-register.md #23):
 *   - clientId is already in the SIGNED JWT, so the tenant binding is tamper-proof,
 *     and every service query already filters by `req.user.clientId` (audited, S4).
 *   - This guard's job is NOT to enforce isolation per-row — that stays the per-query
 *     `where: { clientId }` discipline now, and becomes Postgres RLS + a Prisma
 *     auto-scoper at P8.6 (Gap #23). It is defense-in-depth:
 *       1. asserts a tenant is RESOLVED on every authenticated request → converts a
 *          silent "clientId === undefined → unscoped query" failure mode into a loud 403;
 *       2. stamps `req.tenantId` as the single named tenant seam (for audit/logging,
 *          and the one place RLS `SET app.tenant_id` will later hook into).
 *
 * Runs after JwtAuthGuard (so `req.user` is populated). @Public() routes are skipped.
 * GIFSY_ADMIN is unaffected: it carries a clientId too — its cross-tenant routes just
 * scope by the path `:slug`, not the caller's tenant, which this guard does not force.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Public routes have no authenticated user → nothing to scope.
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const clientId = request.user?.clientId;

    if (typeof clientId !== 'string' || clientId.trim() === '') {
      // A token that reached here (JWT verified + session valid) but carries no tenant
      // must not run a single query — every downstream filter depends on this value.
      throw new ForbiddenException('No tenant context on this request.');
    }

    request.tenantId = clientId;
    return true;
  }
}
