/**
 * Server-side tenant helpers.
 * Import these only in Server Components and API routes — not in client components.
 */

import { headers } from 'next/headers';
import { resolveClientConfig } from './tenant-resolution';
import { refreshIfStale } from './tenant-routing-cache';
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
  // §A-DOMAIN Phase 2: keep the DB routing/branding snapshot warm for SSR-only
  // entry paths (non-blocking; the proxy usually primes it first). resolveClientConfig
  // reads the snapshot and overlays any non-empty DB branding, falling back to the
  // registry — so this is DB-aware without an inline network wait.
  void refreshIfStale();

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
