'use client';

import { useEffect } from 'react';

/**
 * Pure decision: should an API response trigger a re-login redirect?
 *
 * Deliberate scope:
 *  - ONLY 401 (authentication failed → token missing/expired/invalid). 403 (Forbidden
 *    = authenticated but not permitted) is intentionally NOT handled, so RBAC errors
 *    still surface in-page instead of bouncing the user out.
 *  - ONLY same-origin `/api/*` calls, EXCLUDING `/api/auth/*` (the login flow itself
 *    legitimately returns 4xx on a bad OTP / expired OTP).
 *  - Never when already on an `/auth/*` page (avoids a redirect loop).
 */
export function shouldRedirectOnAuth(
  status: number,
  url: string,
  pathname: string,
): boolean {
  if (status !== 401) return false;
  if (!url.includes('/api/')) return false;
  if (url.includes('/api/auth/')) return false;
  if (pathname.startsWith('/auth/')) return false;
  return true;
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

// Module-level: install the fetch patch once per app session, and fire the redirect
// at most once even if several in-flight /api calls 401 together.
let installed = false;
let redirecting = false;

/**
 * SessionExpiryGuard — graceful recovery from an expired / invalid token.
 *
 * Tokens here are bearer JWTs with no silent refresh, so when one expires the proxy
 * answers `/api/*` calls with 401 `{ error: 'Invalid token' }`. Without this, a write
 * surfaces the cryptic "Invalid token" and reads silently blank out. This patches
 * window.fetch to detect any qualifying 401 (see shouldRedirectOnAuth) and bounce the
 * user to /auth/login to re-authenticate. Mounted once, app-wide, in the root layout.
 */
export default function SessionExpiryGuard() {
  useEffect(() => {
    if (installed || typeof window === 'undefined') return;
    installed = true;

    const originalFetch = window.fetch.bind(window);
    const patched: typeof window.fetch = async (input, init) => {
      const res = await originalFetch(input, init);
      try {
        if (
          !redirecting &&
          shouldRedirectOnAuth(res.status, extractUrl(input), window.location.pathname)
        ) {
          redirecting = true;
          try {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
          } catch {
            /* storage blocked — proceed to login anyway */
          }
          window.location.assign('/auth/login?expired=1');
        }
      } catch {
        /* the guard must NEVER break a fetch */
      }
      return res;
    };
    window.fetch = patched;
    // Intentionally not restored on unmount: the patch must persist for the whole app
    // session, and restoring could race with in-flight requests.
  }, []);

  return null;
}
