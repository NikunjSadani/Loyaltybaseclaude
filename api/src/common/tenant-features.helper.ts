import { TenantService } from '../tenant/tenant.service';

/**
 * Resolve the caller's tenant feature blob (the raw `clients.features` JSON) for a
 * role `/me`-style identity response. The FE reads per-tenant feature gating from
 * these AUTHENTICATED endpoints (§A-DOMAIN "P5") instead of the in-code
 * CLIENT_REGISTRY, so the DB (via TenantService.resolveClient — D-1) is the single
 * source of truth for runtime feature flags.
 *
 * Fails SOFT: any resolve error (missing/inactive client row, DB blip) returns `{}`
 * rather than throwing — a `/me` identity read must never 500 because feature
 * resolution hiccupped, and the FE normaliser applies conservative defaults for any
 * absent key.
 */
export async function resolveTenantFeatures(
  tenant: TenantService,
  clientId: string,
): Promise<Record<string, unknown>> {
  try {
    const config = await tenant.resolveClient(clientId);
    return (config.features ?? {}) as unknown as Record<string, unknown>;
  } catch {
    return {};
  }
}
