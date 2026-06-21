/**
 * Tenant resolution — maps an incoming hostname to a ClientConfig.
 *
 * Flow:
 *   hostname  →  resolveSlugFromHostname()  →  slug
 *   slug      →  resolveClientConfig()      →  ClientConfig | null
 *
 * Both functions are pure (no I/O) so they are fully unit-testable.
 * The Next.js middleware calls these and sets x-tenant-slug on each request.
 */

import { CLIENT_REGISTRY } from './client-registry';
import type { ClientConfig } from './client-config';

/**
 * The slug served when running on localhost / no subdomain detected.
 * Points to Deoleo for all local development.
 */
export const DEFAULT_DEV_SLUG = 'deoleo';

/**
 * Top-level domains / subdomains that are reserved for the platform itself
 * and should NOT be treated as client slugs.
 */
const PLATFORM_RESERVED = new Set(['www', 'app', 'api', 'admin', 'status', 'mail', 'platform']);

/**
 * The GIFSY platform-operator console. The operator user lives under clientId
 * `gifsy` (NOT a tenant in CLIENT_REGISTRY), so these exact hostnames must resolve
 * to the `gifsy` slug — otherwise `app.gifsy.in` falls into PLATFORM_RESERVED → null
 * (→ default tenant) and `uat.app.gifsy.in` would yield the `uat` label. Matched as
 * full hosts ahead of every other rule. The staging build runs the same code, so
 * the staging host resolves natively (no Worker host-alias needed).
 *   app.gifsy.in      → gifsy   (prod operator console)
 *   uat.app.gifsy.in  → gifsy   (staging operator console)
 */
const OPERATOR_HOSTS = new Set(['app.gifsy.in', 'uat.app.gifsy.in']);

/**
 * Full custom-hostname → slug map, built from each tenant's `domains` (a branded
 * domain that differs from the slug, e.g. `deoleoloyalty.gifsy.in` → `deoleo`).
 * Checked BEFORE the subdomain-label heuristic so a branded domain resolves to the
 * right tenant. (Long-term this map comes from a `clients.domains` column.)
 */
const DOMAIN_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.values(CLIENT_REGISTRY).flatMap((cfg) =>
    (cfg.domains ?? []).map((d) => [d.toLowerCase(), cfg.slug] as const),
  ),
);

/**
 * Extracts the tenant slug from an incoming hostname.
 *
 * Examples:
 *   deoleoloyalty.gifsy.in → "deoleo"   (custom domain map — branded ≠ slug)
 *   deoleo.gifsy.in        → "deoleo"
 *   clientb.app.gifsy.in   → "clientb"
 *   gifsy.in               → null   (bare domain — platform root)
 *   www.gifsy.in           → null   (reserved)
 *   localhost                    → DEFAULT_DEV_SLUG
 *   localhost:3000               → DEFAULT_DEV_SLUG
 *   ""                           → DEFAULT_DEV_SLUG
 */
export function resolveSlugFromHostname(hostname: string): string | null {
  // Strip port
  const host = hostname.toLowerCase().split(':')[0].trim();

  // GIFSY operator console — explicit full-host match → `gifsy` (overrides the
  // reserved/subdomain heuristics below). Checked first so neither the `app`
  // reserved-label nor the `uat` first-label intercepts it.
  if (OPERATOR_HOSTS.has(host)) return 'gifsy';

  // Localhost / empty → dev default
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    return DEFAULT_DEV_SLUG;
  }

  // Custom branded domain (full-hostname match) wins over the subdomain heuristic.
  if (DOMAIN_TO_SLUG[host]) return DOMAIN_TO_SLUG[host];

  const parts = host.split('.');

  // Bare domain (e.g. "gifsy.in") — 2 parts or fewer
  if (parts.length <= 2) return null;

  const subdomain = parts[0];

  // Reserved platform subdomains
  if (PLATFORM_RESERVED.has(subdomain)) return null;

  return subdomain;
}

/**
 * Looks up a ClientConfig by slug.
 * Returns null if the slug is unknown (show 404 / redirect to platform home).
 */
export function resolveClientConfig(slug: string): ClientConfig | null {
  if (!slug) return null;
  return CLIENT_REGISTRY[slug.toLowerCase()] ?? null;
}
