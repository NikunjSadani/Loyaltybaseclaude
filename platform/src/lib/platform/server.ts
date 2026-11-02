/**
 * Server-side tenant helpers.
 * Import these only in Server Components and API routes — not in client components.
 */

import { headers } from 'next/headers';
import { resolveClientConfig } from './tenant-resolution';
import { ensureWarm } from './tenant-routing-cache';
import { buildCssVariables } from './client-config';
import { DEFAULT_CLIENT_CONFIG } from './default-client-config';
import type { ClientConfig } from './client-config';

/**
 * Reads the resolved tenant slug from the x-tenant-slug header and returns the
 * full ClientConfig from the in-code registry (Prisma-free).
 *
 * Fallback chain (airtight — server rendering must never break):
 *   1. No slug header           → DEFAULT_CLIENT_CONFIG (dev / no-subdomain — the
 *                                 platform-neutral fallback)
 *   2. Slug present in registry  → resolveClientConfig(slug)
 *   3. Slug unknown in registry  → DEFAULT_CLIENT_CONFIG (last resort)
 *
 * D2 (#31): the DB-backed branch (`getClientConfigFromDb` → platform Prisma) was retired.
 * It never executed at runtime (no middleware sets the slug → always Branch 1), so this is
 * behavior-identical. Real per-tenant SSR branding (subdomain → backend tenant-config
 * endpoint + a wired middleware) is a separate feature — see POST-GO-LIVE-BACKLOG.md §A.
 */
export async function getTenantConfig(): Promise<ClientConfig> {
  // §A-DOMAIN Phase 2: ensure the DB routing/branding snapshot is warm BEFORE resolving,
  // so a cold Cloud Run instance doesn't render a DB-only tenant (e.g. Bajaj, absent from
  // CLIENT_REGISTRY) with the neutral DEFAULT_CLIENT_CONFIG and flash "LoyaltyBase" branding
  // (header/title/favicon) until a later warm render corrects it. `ensureWarm()` awaits a
  // single ~2s-capped fetch ONLY on the first request of a cold instance, is a no-op once
  // warm, and on failure leaves the snapshot null → registry fallback (so registry tenants
  // like Deoleo are unaffected). Mirrors the blocking warm the proxy already performs.
  await ensureWarm();

  const hdrs = await headers();
  const slug = hdrs.get('x-tenant-slug');

  if (!slug) return DEFAULT_CLIENT_CONFIG;
  return resolveClientConfig(slug) ?? DEFAULT_CLIENT_CONFIG;
}

/**
 * Returns a <style> JSX element injecting brand CSS variables into :root.
 * Place this inside <head> in the root layout.
 *
 * <BrandStyleTag config={config} />
 */
export function getBrandStyle(config: ClientConfig): string {
  return buildCssVariables(config);
}
