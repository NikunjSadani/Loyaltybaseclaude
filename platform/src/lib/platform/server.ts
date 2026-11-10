/**
 * Server-side tenant helpers.
 * Import these only in Server Components and API routes — not in client components.
 */

import { headers } from 'next/headers';
import { resolveClientConfig } from './tenant-resolution';
import {
  ensureWarm,
  getRoutingSnapshot,
  refreshIfStale,
  refreshOnMiss,
} from './tenant-routing-cache';
import { buildCssVariables } from './client-config';
import { DEFAULT_CLIENT_CONFIG } from './default-client-config';
import type { ClientConfig } from './client-config';

/**
 * Reads the resolved tenant slug from the x-tenant-slug header and returns the
 * full ClientConfig from the in-code registry (Prisma-free).
 *
 * Fallback chain (airtight — server rendering must never break):
 *   1. No slug header            → DEFAULT_CLIENT_CONFIG (dev / no-subdomain — the
 *                                  platform-neutral fallback)
 *   2. Slug known (registry and/or DB routing snapshot) → resolveClientConfig(slug)
 *   3. Slug not in this instance's snapshot → one bounded miss refresh, re-resolve,
 *      else DEFAULT_CLIENT_CONFIG (last resort)
 *
 * D2 (#31): the DB-backed branch (`getClientConfigFromDb` → platform Prisma) was retired.
 * It never executed at runtime (no middleware sets the slug → always Branch 1), so this is
 * behavior-identical. Real per-tenant SSR branding (subdomain → backend tenant-config
 * endpoint + a wired middleware) is a separate feature — see POST-GO-LIVE-BACKLOG.md §A.
 */
/** The Gifsy operator console's pseudo-slug (proxy.ts) — not a tenant, never in the routing map. */
const PLATFORM_OPERATOR_SLUG = 'gifsy';

export async function getTenantConfig(): Promise<ClientConfig> {
  // §A-DOMAIN Phase 2 — keep THIS module instance's routing snapshot fresh. Server rendering
  // runs in a different module instance from proxy.ts (each holds its own snapshot), so
  // warming here once and never refreshing froze the render path at instance start: a tenant
  // created later (Bajaj, 2026-11-10) rendered DEFAULT_CLIENT_CONFIG ("LoyaltyBase") while
  // the proxy routed it fine.
  //  - Cold (no snapshot): AWAIT one ~2s-capped warm fetch (unchanged behaviour).
  //  - Warm: fire-and-forget stale-while-revalidate (60s TTL) — never blocks the render.
  // Both swallow their own errors; on failure the snapshot stays last-good / null → registry.
  if (getRoutingSnapshot() === null) await ensureWarm();
  else void refreshIfStale();

  const hdrs = await headers();
  const slug = hdrs.get('x-tenant-slug');

  if (!slug) return DEFAULT_CLIENT_CONFIG;
  const resolved = resolveClientConfig(slug);
  // Registry tenants (Deoleo) and tenants already in the snapshot return here — no extra I/O.
  if (resolved || slug === PLATFORM_OPERATOR_SLUG) return resolved ?? DEFAULT_CLIENT_CONFIG;

  // A slug the proxy validated but this instance doesn't know yet → ONE awaited, coalesced,
  // throttled (≤1 fetch / 5s), ≤2s-bounded refresh, then resolve again. Never throws; if the
  // fetch fails or the slug is genuinely unknown, the fallback is exactly as before.
  await refreshOnMiss();
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
