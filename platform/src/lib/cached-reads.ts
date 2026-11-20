/**
 * cached-reads — the shared, session-cached versions of the read-mostly calls the sales app made on nearly every
 * screen (request-volume work, 2026-11-21). One request per SESSION_TTL_MS (5 min) per key, shared by every caller
 * (concurrent callers share one in-flight request). Freshness / invalidation rules: lib/session-cache.ts.
 *
 * Each returns the parsed JSON envelope (`{ success, data }`) or null on a non-2xx / network error — exactly what
 * the old inline `fetch(...).then(r => r.ok ? r.json() : null)` call sites produced. Failures are never cached.
 */
import { getCached, FEATURES_TTL_MS } from '@/lib/session-cache';

export type Envelope<T = unknown> = { success?: boolean; data?: T; error?: string } | null;

const isSuccess = (v: Envelope) => !!v && v.success === true;

function jsonOrNull<T>(url: string): Promise<Envelope<T>> {
  return fetch(url, { credentials: 'include' })
    .then((r) => (r.ok ? (r.json() as Promise<Envelope<T>>) : null))
    .catch(() => null);
}

export const SALES_ME_URL = '/api/sales/me';
export const OUTLET_TYPES_URL = '/api/settings/outlet-types';
export const AUTH_ME_URL = '/api/auth/me';

/**
 * GET /api/sales/me — the sales user's identity + tenant feature flags. The flags GATE screens, so this entry uses
 * the short FEATURES_TTL_MS (60 s): an admin's feature toggle reaches reps within a minute (audit fix 7).
 */
export function getSalesMe<T = Record<string, unknown>>(): Promise<Envelope<T>> {
  return getCached(SALES_ME_URL, () => jsonOrNull<T>(SALES_ME_URL), { shouldCache: isSuccess, ttlMs: FEATURES_TTL_MS });
}

/** GET /api/settings/outlet-types — the tenant's enabled outlet types + display-name overrides. */
export function getOutletTypes<T = unknown>(): Promise<Envelope<T>> {
  return getCached(OUTLET_TYPES_URL, () => jsonOrNull<T>(OUTLET_TYPES_URL), { shouldCache: isSuccess });
}

/** GET /api/auth/me — the signed-in user's own profile (read-only screens only; never a wallet balance). */
export function getAuthMe<T = unknown>(): Promise<Envelope<T>> {
  return getCached(AUTH_ME_URL, () => jsonOrNull<T>(AUTH_ME_URL), { shouldCache: isSuccess });
}
