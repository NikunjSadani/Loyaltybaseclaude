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
import { runSessionChangeGuards } from './session-change-guards';

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
  /**
   * Partner logins only (OTP-login reply): the default outlet's display identity — the same
   * businessName / outletName GET /partner/me returns — so the partner header paints the outlet
   * name from the first frame. Absent for non-partner logins and for sessions stored before the
   * backend added them (the header then falls back to the legacy person-name seed).
   */
  businessName?: string | null;
  outletName?: string | null;
}

/**
 * Build the stored `user` from a GET /auth/me reply (the login page's live-cookie re-hydrate).
 * Mirrors what the post-OTP path persists — id/name/role/phone, plus the partner header identity
 * (businessName/outletName) when /auth/me carries it, so that session also paints the OUTLET name
 * from the first frame. Never the token (AF-6). The outlet keys are omitted when absent, exactly
 * like a non-partner OTP login.
 */
export function storedUserFromAuthMe(data: {
  role: string;
  user?: { id?: string; name?: string; phone?: string | null; businessName?: string | null; outletName?: string | null };
}): StoredUser {
  const u = data.user ?? {};
  return {
    id: u.id ?? '',
    name: u.name ?? '',
    role: data.role,
    phone: u.phone ?? '',
    ...('businessName' in u ? { businessName: u.businessName ?? null } : {}),
    ...('outletName' in u ? { outletName: u.outletName ?? null } : {}),
  };
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
export const PORTAL_ROLES: Record<'admin' | 'partner' | 'sales' | 'gifsy' | 'vendor', string[]> = {
  // GIFSY_ADMIN is admitted to the admin shell too: a GIFSY operator working IN a
  // brand's context (A2/#51) operates per-brand surfaces that live in the admin
  // shell (e.g. /admin/payouts, GIFSY-only per Q1). At platform level the operator
  // uses /gifsy; in a tenant context they reach admin pages scoped to that tenant.
  // GIFSY_STAFF (RBAC Option-X P5) is a limited operator who works the SAME way — by
  // assuming one granted brand at a time — so it is admitted to admin (its stored role
  // is unchanged while assuming) and to the /gifsy launchpad shell. There is no
  // all-brands view for staff; the /gifsy layout renders them a brand-picker launchpad.
  admin: ['CLIENT_ADMIN', 'MIS_USER', 'GIFSY_ADMIN', 'GIFSY_STAFF'],
  partner: ['SSS', 'WHOLESALER', 'SUB_STOCKIST'],
  sales: ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'],
  gifsy: ['GIFSY_ADMIN', 'GIFSY_STAFF'],
  // VENDOR (Gift Catalogue & Dispatch, Wave-2) — a hard-scoped third-party fulfiller.
  // Its own portal at /vendor; admitted nowhere else.
  vendor: ['VENDOR'],
};

/** The home dashboard for a role — where the guard sends a user who lands on a portal they can't use. */
export function getRoleHome(role?: string | null): string {
  if (!role) return '/auth/login';
  // GIFSY_STAFF's home is the platform launchpad (/gifsy), even though it is ALSO
  // admitted to the admin shell while assuming a brand. Check it before admin so a
  // portal bounce lands staff on their launchpad, not an un-assumed admin dashboard.
  if (role === 'GIFSY_STAFF') return '/gifsy';
  if (PORTAL_ROLES.vendor.includes(role)) return '/vendor/catalogue';
  if (PORTAL_ROLES.admin.includes(role)) return '/admin/dashboard';
  if (PORTAL_ROLES.partner.includes(role)) return '/partner/dashboard';
  if (PORTAL_ROLES.sales.includes(role)) return '/sales/dashboard';
  if (PORTAL_ROLES.gifsy.includes(role)) return '/gifsy';
  return '/auth/login';
}

/** Clear the session (httpOnly cookies server-side + local display state) and return to login. */
export async function logout(opts: { force?: boolean } = {}): Promise<void> {
  // Something in flight in this tab (e.g. a Sales Import upload) may ask the user first and clean up with the
  // current session; "stay" cancels the logout. No guard registered (the usual case) → no prompt, unchanged.
  // `force` (session already revoked, e.g. log out of all devices): never prompt, never vetoed — clean-up is
  // best-effort and time-boxed, and the logout always completes.
  if (!(await runSessionChangeGuards('logout', { force: opts.force }))) return;
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

/**
 * Exit the assumed tenant context and restore the gifsy (home) operator session. Returns false (nothing changed)
 * when a session-change guard vetoed it (e.g. the operator chose to keep an in-flight Sales Import upload).
 */
export async function exitTenant(): Promise<boolean> {
  if (!(await runSessionChangeGuards('switch-brand'))) return false;
  await exitTenantAction();
  if (typeof window !== 'undefined') {
    localStorage.removeItem(ASSUMED_BRAND_KEY);
  }
  return true;
}
