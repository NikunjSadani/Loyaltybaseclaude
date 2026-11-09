import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import { resolveTenantFeatures } from '../common/tenant-features.helper';
import type { TenantService } from '../tenant/tenant.service';
import type { PrismaService } from '../prisma/prisma.service';

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
