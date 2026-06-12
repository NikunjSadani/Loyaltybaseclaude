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
const PLATFORM_RESERVED = new Set(['www', 'app', 'api', 'admin', 'status', 'mail']);

/**
 * Extracts the tenant slug from an incoming hostname.
 *
 * Examples:
 *   deoleo.loyaltybase.in        → "deoleo"
 *   clientb.app.loyaltybase.in   → "clientb"
 *   loyaltybase.in               → null   (bare domain — platform root)
 *   www.loyaltybase.in           → null   (reserved)
 *   localhost                    → DEFAULT_DEV_SLUG
 *   localhost:3000               → DEFAULT_DEV_SLUG
 *   ""                           → DEFAULT_DEV_SLUG
 */
export function resolveSlugFromHostname(hostname: string): string | null {
  // Strip port
  const host = hostname.toLowerCase().split(':')[0].trim();

  // Localhost / empty → dev default
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    return DEFAULT_DEV_SLUG;
  }

  const parts = host.split('.');

  // Bare domain (e.g. "loyaltybase.in") — 2 parts or fewer
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
