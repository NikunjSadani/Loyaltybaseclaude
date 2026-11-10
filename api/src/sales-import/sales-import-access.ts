import {
  BadRequestException,
  CanActivate,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { resolveTenantFeatures } from '../common/tenant-features.helper';
import { TenantService } from '../tenant/tenant.service';
import { PrismaService } from '../prisma/prisma.service';
import { can } from '../common/rbac/can';
import type { Permission } from '../common/rbac/permissions';
import type { GifsyRoleService } from '../common/rbac/gifsy-role.service';

/**
 * Sales Import access gate (plan §5 / §10 task 0-4). Every Sales Import route calls this FIRST.
 *
 *   1. Tenant context: an UN-ASSUMED Gifsy operator (GIFSY_ADMIN or GIFSY_STAFF) → 400 (else rows would
 *      land under the operator's home 'gifsy' clientId). Same rule as OffersAdminService.assertAccess.
 *   2. The per-tenant `features.salesImport` flag (default OFF) → 403 unless strictly `true`.
 *      - READS use the cached tenant config (TenantService.resolveClient, ≤5-min per-instance TTL).
 *      - WRITES re-read `clients.features` UNCACHED (fail-closed) so a Gifsy "turn it off" stops new
 *        writes fleet-wide immediately (same rationale as TenantSettingsService.get*Uncached).
 *
 * Deoleo (and every tenant that never set the flag) → 403 on every route: byte-identical behaviour.
 */
export interface SalesImportAccessDeps {
  tenant: Pick<TenantService, 'resolveClient'>;
  prisma: Pick<PrismaService, 'client'>;
}

export async function assertSalesImportAccess(
  user: JwtPayload,
  deps: SalesImportAccessDeps,
  opts: { write: boolean },
): Promise<void> {
  // platformWide() is OWNER-only (an un-assumed GIFSY_STAFF is not platform-wide, it is pinned to its
  // home 'gifsy' clientId) — so check both operator roles explicitly.
  const unassumedOperator = platformWide(user) || (user.role === 'GIFSY_STAFF' && !user.assumed);
  if (unassumedOperator) throw new BadRequestException('Assume a tenant to use Sales Import.');

  const enabled = opts.write
    ? await isSalesImportEnabledUncached(deps.prisma, user.clientId)
    : (await resolveTenantFeatures(deps.tenant as TenantService, user.clientId)).salesImport === true;
  if (!enabled) throw new ForbiddenException('Sales Import is not enabled for this tenant.');
}

/**
 * UNCACHED, fail-CLOSED read of `clients.features.salesImport` for one tenant. Used by the write gate
 * above, the worker (plan §7.1 step 2) and the D-1 month guard. Returns true ONLY for a strict boolean
 * `true` on an existing, non-INACTIVE client row; any read error / missing row / other value → false.
 */
export async function isSalesImportEnabledUncached(
  prisma: Pick<PrismaService, 'client'>,
  clientId: string,
): Promise<boolean> {
  try {
    const row = await prisma.client.findUnique({
      where: { id: clientId },
      select: { features: true, status: true },
    });
    if (!row || row.status === 'INACTIVE') return false;
    const f = row.features;
    if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
    return (f as Record<string, unknown>).salesImport === true;
  } catch {
    return false;
  }
}

/**
 * Does the caller hold `permission`? Mirrors PermissionGuard exactly (GIFSY_STAFF: its GifsyRole set, fail-closed;
 * legacy roles: allowed unless RBAC_ENFORCEMENT=true AND the tenant opted in, then `can(role, permission)`). Used where a
 * route is open to a weaker permission but part of the response needs a stronger one (S3: detectedHeaders sample rows
 * on GET :id need targets:upload). Any error → false (fail-closed: the caller just gets less data).
 */
export async function callerHasPermission(
  user: JwtPayload,
  permission: Permission,
  deps: { tenant: Pick<TenantService, 'isFeatureEnabled'>; gifsyRoles: Pick<GifsyRoleService, 'getPermissions'> },
): Promise<boolean> {
  try {
    if (user.role === 'GIFSY_STAFF') {
      return (await deps.gifsyRoles.getPermissions((user as JwtPayload & { gifsyRoleId?: string | null }).gifsyRoleId)).has(permission);
    }
    if (process.env.RBAC_ENFORCEMENT !== 'true') return true;
    if (!(await deps.tenant.isFeatureEnabled(user.clientId ?? '', 'rbacEnforcement'))) return true;
    return can(user.role ?? '', permission);
  } catch {
    return false;
  }
}

/**
 * S7: the part-upload route's gate as a GUARD, so the feature flag (uncached, fail-closed), the operator rule and the
 * import's state are checked BEFORE FileInterceptor buffers the 4 MiB body (Nest runs guards before interceptors; the
 * global JWT / Roles / Permission guards have already run). The service re-checks the state under the row lock.
 */
@Injectable()
export class SalesImportPartGuard implements CanActivate {
  constructor(
    private readonly tenant: TenantService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user: JwtPayload; params?: Record<string, string> }>();
    await assertSalesImportAccess(req.user, { tenant: this.tenant, prisma: this.prisma }, { write: true });
    const id = String(req.params?.id ?? '');
    const row = await this.prisma.salesImport.findFirst({ where: { id, clientId: req.user.clientId }, select: { status: true } });
    if (!row) throw new NotFoundException('Sales import not found.');
    if (row.status !== 'UPLOADING') throw new ConflictException(`This import is ${row.status}; parts can only be added while UPLOADING.`);
    return true;
  }
}
