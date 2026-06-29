/* ─── Client-side auth helpers (AF-6) ────────────────────────────────────────
   The access token lives ONLY in an httpOnly `token` cookie — it is NOT readable
   by JS and is NOT mirrored to localStorage, so a stored-XSS has no bearer token
   to steal. The edge proxy reads that cookie and injects `Authorization: Bearer`
   for the backend on every `/api/*` call; same-origin fetches send the cookie
   automatically, so client code never needs to attach a token.

   localStorage now holds only NON-sensitive display state: the `user` object
   (id/name/role/phone) for client-side routing, and `assumedBrand` for the
   operator banner. Mutating the auth cookies (assume/exit/logout) happens via
   server actions in lib/auth-actions.ts.
   Client-only.
─────────────────────────────────────────────────────────────────────────────── */

import { assumeTenantAction, exitTenantAction, logoutAction } from './auth-actions';
import { unsubscribeFromPush } from './pwa/push';

const USER_KEY = 'user';
const ASSUMED_BRAND_KEY = 'assumedBrand';

/**
 * @deprecated The access token is an httpOnly cookie and is intentionally NOT
 * readable from JS (AF-6). Always returns null. Use `isAuthenticated()` for a
 * presence check and let same-origin fetches carry the cookie automatically.
 * Kept only so legacy call sites that built an `Authorization` header compile —
 * the proxy ignores any client Authorization and injects its own from the cookie.
 */
export function getToken(): string | null {
  return null;
}

export interface StoredUser {
  id: string;
  name: string;
  role: string;
  phone: string;
}

export function getStoredUser(): StoredUser | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    return null;
  }
}

/**
 * Client-side "is there a session?" check. Based on the NON-sensitive stored user
 * (the real credential is the httpOnly cookie + backend verification). A guard that
 * passes here but has no valid cookie still gets a 401 from the backend → the
 * SessionExpiryGuard bounces it to login.
 */
export function isAuthenticated(): boolean {
  return !!getStoredUser();
}

/**
 * Which backend roles each portal admits (mirrors login/page.tsx getRoleDashboard). Used by the
 * role-aware route guard so a role can't load another portal (gap #41). Keep in sync with the
 * backend UserRole enum.
 */
export const PORTAL_ROLES: Record<'admin' | 'partner' | 'sales' | 'gifsy', string[]> = {
  // GIFSY_ADMIN is admitted to the admin shell too: a GIFSY operator working IN a
  // brand's context (A2/#51) operates per-brand surfaces that live in the admin
  // shell (e.g. /admin/payouts, GIFSY-only per Q1). At platform level the operator
  // uses /gifsy; in a tenant context they reach admin pages scoped to that tenant.
  admin: ['CLIENT_ADMIN', 'MIS_USER', 'GIFSY_ADMIN'],
  partner: ['SSS', 'WHOLESALER', 'SUB_STOCKIST'],
  sales: ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'],
  gifsy: ['GIFSY_ADMIN'],
};

/** The home dashboard for a role — where the guard sends a user who lands on a portal they can't use. */
export function getRoleHome(role?: string | null): string {
  if (!role) return '/auth/login';
  if (PORTAL_ROLES.admin.includes(role)) return '/admin/dashboard';
  if (PORTAL_ROLES.partner.includes(role)) return '/partner/dashboard';
  if (PORTAL_ROLES.sales.includes(role)) return '/sales/dashboard';
  if (PORTAL_ROLES.gifsy.includes(role)) return '/gifsy';
  return '/auth/login';
}

/** Clear the session (httpOnly cookies server-side + local display state) and return to login. */
export async function logout(): Promise<void> {
  // Best-effort: drop this browser's push subscription BEFORE clearing the session
  // (the /api/push/unsubscribe call still carries the cookie here), so the next user
  // on this device never inherits the previous user's push notifications. No-ops if
  // there's no subscription. Raced against a hard timeout so it can NEVER block logout
  // — even if a browser stalls the SW/push APIs, logout still proceeds.
  try {
    await Promise.race([
      unsubscribeFromPush(),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    /* push unsubscribe is best-effort; never block logout */
  }
  try {
    await logoutAction();
  } catch {
    /* even if the cookie-clear call fails, still clear local state + redirect */
  }
  if (typeof window !== 'undefined') {
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ASSUMED_BRAND_KEY);
    window.location.href = '/auth/login';
  }
}

// ── Operator-context switcher (A2/#51) ───────────────────────────────────────

/**
 * The brand the GIFSY operator is currently "working in", or null at platform level.
 * Drives the global banner. Set when the operator assumes a tenant, cleared on exit,
 * logout, and a fresh login. If the assumed token expires while the banner is up, the
 * next `/api` call 401s → SessionExpiryGuard → login, which clears this — so the banner
 * cannot meaningfully outlive its token.
 */
export function getAssumedBrand(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ASSUMED_BRAND_KEY);
}

/** Clear any GIFSY operator assumed-tenant context (called on a fresh login). */
export function clearAssumedContext(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(ASSUMED_BRAND_KEY);
}

/**
 * GIFSY operator switches into a tenant's context: the server action exchanges the
 * gifsy session cookie for a tenant-scoped GIFSY_ADMIN token and stashes the home
 * session so exitTenant() restores it without a re-login. Throws on failure.
 */
export async function assumeTenant(clientId: string): Promise<{ brandName: string }> {
  const res = await assumeTenantAction(clientId);
  if (!res.success || !res.brandName) {
    throw new Error(res.error || 'Could not switch brand context');
  }
  if (typeof window !== 'undefined') {
    localStorage.setItem(ASSUMED_BRAND_KEY, res.brandName);
  }
  return { brandName: res.brandName };
}

/** Exit the assumed tenant context and restore the gifsy (home) operator session. */
export async function exitTenant(): Promise<void> {
  await exitTenantAction();
  if (typeof window !== 'undefined') {
    localStorage.removeItem(ASSUMED_BRAND_KEY);
  }
}
