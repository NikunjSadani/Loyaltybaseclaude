/**
 * Server-side tenant helpers.
 * Import these only in Server Components and API routes — not in client components.
 */

import { headers } from 'next/headers';
import { resolveClientConfig } from './tenant-resolution';
import { buildCssVariables } from './client-config';
import { DEOLEO_CONFIG } from './client-registry';
import { getClientConfigFromDb } from './client-config-db';
import type { ClientConfig } from './client-config';

/**
 * Reads the resolved tenant slug from the x-tenant-slug header set by
 * middleware and returns the full ClientConfig.
 *
 * Fallback chain (airtight — server rendering must never break):
 *   1. No slug header           → DEOLEO_CONFIG (dev / no-subdomain)
 *   2. Slug present, DB returns a row
 *                               → DB-backed ClientConfig (primary production path)
 *   3. DB returns null or throws → resolveClientConfig(slug) from in-code registry
 *   4. Slug unknown in registry → DEOLEO_CONFIG (last resort)
 *
 * The Edge runtime path (proxy.ts / tenant-resolution.ts) is NOT affected —
 * it still reads from CLIENT_REGISTRY only.
 */
export async function getTenantConfig(): Promise<ClientConfig> {
  const hdrs = await headers();
  const slug = hdrs.get('x-tenant-slug');

  // ── Branch 1: no slug → dev/no-subdomain fallback ────────────────────────
  if (!slug) return DEOLEO_CONFIG;

  // ── Branch 2: try DB ──────────────────────────────────────────────────────
  const dbConfig = await getClientConfigFromDb(slug);
  if (dbConfig) return dbConfig;

  // ── Branches 3 + 4: registry fallback then DEOLEO_CONFIG ─────────────────
  return resolveClientConfig(slug) ?? DEOLEO_CONFIG;
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
