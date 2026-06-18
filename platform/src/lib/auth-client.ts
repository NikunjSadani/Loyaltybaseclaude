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

/** Clear the local session and return to the login screen. */
export function logout(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.href = '/auth/login';
  }
}
