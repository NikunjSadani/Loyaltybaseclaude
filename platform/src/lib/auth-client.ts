/* ─── Client-side auth helpers ───────────────────────────────────────────────
   The session token lives in localStorage (api-client.ts sends it as
   Authorization: Bearer; the backend extracts it from that header). These
   helpers centralise reading it and clearing it on logout. Client-only.
─────────────────────────────────────────────────────────────────────────────── */

const TOKEN_KEY = 'token';
const USER_KEY = 'user';

// ── Operator-context (A2/#51): a GIFSY operator "working in" a tenant ──────────
// When the operator assumes a tenant, the active token becomes the tenant-scoped
// assume-tenant token; the original gifsy (home) session is stashed so Exit can
// restore it without a re-login. `assumedBrand` drives the global banner.
const HOME_TOKEN_KEY = 'homeToken';
const HOME_USER_KEY = 'homeUser';
const ASSUMED_BRAND_KEY = 'assumedBrand';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getToken();
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

/** Clear the local session and return to the login screen. */
export function logout(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(HOME_TOKEN_KEY);
    localStorage.removeItem(HOME_USER_KEY);
    localStorage.removeItem(ASSUMED_BRAND_KEY);
    window.location.href = '/auth/login';
  }
}

// ── Operator-context switcher (A2/#51) ───────────────────────────────────────

/** The brand the GIFSY operator is currently "working in", or null if at platform level. */
export function getAssumedBrand(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ASSUMED_BRAND_KEY);
}

/**
 * GIFSY operator switches into a tenant's context: exchanges the gifsy session for
 * a tenant-scoped GIFSY_ADMIN token (POST /api/auth/assume-tenant). The home (gifsy)
 * session is stashed once so exitTenant() restores it without a re-login.
 */
export async function assumeTenant(clientId: string): Promise<{ brandName: string }> {
  const res = await fetch('/api/auth/assume-tenant', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` },
    body: JSON.stringify({ clientId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error || 'Could not switch brand context');
  }
  const { data } = await res.json();
  // Stash the home session ONCE (a second assume keeps the original gifsy home).
  if (!localStorage.getItem(HOME_TOKEN_KEY)) {
    localStorage.setItem(HOME_TOKEN_KEY, getToken() ?? '');
    const u = localStorage.getItem(USER_KEY);
    if (u) localStorage.setItem(HOME_USER_KEY, u);
  }
  localStorage.setItem(TOKEN_KEY, data.accessToken);
  localStorage.setItem(ASSUMED_BRAND_KEY, data.brandName);
  return { brandName: data.brandName };
}

/** Exit the assumed tenant context and restore the gifsy (home) operator session. */
export function exitTenant(): void {
  if (typeof window === 'undefined') return;
  const home = localStorage.getItem(HOME_TOKEN_KEY);
  if (home) localStorage.setItem(TOKEN_KEY, home);
  const homeUser = localStorage.getItem(HOME_USER_KEY);
  if (homeUser) localStorage.setItem(USER_KEY, homeUser);
  localStorage.removeItem(HOME_TOKEN_KEY);
  localStorage.removeItem(HOME_USER_KEY);
  localStorage.removeItem(ASSUMED_BRAND_KEY);
}
