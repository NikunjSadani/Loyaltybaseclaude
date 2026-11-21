/**
 * cached-reads — the shared, session-cached versions of the read-mostly calls the sales app made on nearly every
 * screen (request-volume work, 2026-11-21). One request per SESSION_TTL_MS (5 min) per key, shared by every caller
 * (concurrent callers share one in-flight request). Freshness / invalidation rules: lib/session-cache.ts.
 *
 * Each returns the parsed JSON envelope (`{ success, data }`) or null on a non-2xx / network error — exactly what
 * the old inline `fetch(...).then(r => r.ok ? r.json() : null)` call sites produced. Failures are never cached.
 */
import { getCached, FEATURES_TTL_MS, DASHBOARD_REUSE_MS } from '@/lib/session-cache';

export type Envelope<T = unknown> = { success?: boolean; data?: T; error?: string } | null;

const isSuccess = (v: Envelope) => !!v && v.success === true;

function jsonOrNull<T>(url: string): Promise<Envelope<T>> {
  return fetch(url, { credentials: 'include' })
    // `ok === false` only: a non-2xx is a failure; the body's own `success` decides the rest (as the old inline
    // `r.json()` call sites did — minimal Response stand-ins in tests carry no `ok`).
    .then((r) => (r.ok === false ? null : (r.json() as Promise<Envelope<T>>)))
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

/**
 * GET /api/sales/outlet-targets?period= — the caller's per-outlet KPI target vs achievement for a month. Shared by
 * the outlets list and the outlet detail's Target Achievement + trend-comparison cards (which asked for the SAME
 * period twice on every outlet open): one in-flight request, reused for 2 min; any write clears it.
 */
export function getOutletTargets<T = unknown>(period: string): Promise<Envelope<T>> {
  const url = `/api/sales/outlet-targets?period=${encodeURIComponent(period)}`;
  return getCached(url, () => jsonOrNull<T>(url), { shouldCache: isSuccess, ttlMs: DASHBOARD_REUSE_MS });
}

export const SALES_OUTLETS_URL = '/api/sales/outlets';

/**
 * GET /api/sales/outlets — the caller's outlet roster. Shared by the dashboard, Outlets, Tasks, Support (ticket
 * outlet picker) and Profile (outlet counts) so moving between them reuses ONE answer for 2 min (scoped to the
 * user/tenant; any write — KYC submit, capture, … — clears it).
 */
export function getSalesOutlets<T = { outlets?: any[]; members?: any[] }>(): Promise<Envelope<T>> {
  return getCached(SALES_OUTLETS_URL, () => jsonOrNull<T>(SALES_OUTLETS_URL), { shouldCache: isSuccess, ttlMs: DASHBOARD_REUSE_MS });
}
