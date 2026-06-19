/* ─── Client-side auth helpers ───────────────────────────────────────────────
   The session token lives in localStorage (api-client.ts sends it as
   Authorization: Bearer; the backend extracts it from that header). These
   helpers centralise reading it and clearing it on logout. Client-only.
─────────────────────────────────────────────────────────────────────────────── */

const TOKEN_KEY = 'token';
const USER_KEY = 'user';

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
  admin: ['CLIENT_ADMIN', 'MIS_USER'],
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
    window.location.href = '/auth/login';
  }
}
