'use server';

/**
 * Server actions that manage the httpOnly auth cookies (AF-6).
 *
 * The access token lives ONLY in an httpOnly `token` cookie (set at login). It is
 * never readable by JS, so operations that must CHANGE the active token — the
 * GIFSY operator assuming/exiting a tenant context, and logout — cannot run on the
 * client. They run here, server-side, where `cookies()` can be mutated.
 *
 * assume-tenant calls the backend directly (server→server) with the operator's
 * current cookie token as the Bearer, then swaps the cookie to the new
 * tenant-scoped token, stashing the home token in a second httpOnly cookie so exit
 * can restore it without a re-login.
 */

import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';
import { resolveClientConfig } from '@/lib/platform/tenant-resolution';
import { refreshIfStale } from '@/lib/platform/tenant-routing-cache';
import {
  REFRESH_MAX_AGE,
  accessCookieMaxAge,
  refreshTokensViaBackend,
  sessionCookieOptions as cookieOptions,
} from '@/lib/auth-refresh';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * GIFSY operator enters a tenant's context. Exchanges the current (home) token for
 * a tenant-scoped GIFSY_ADMIN token and swaps the httpOnly cookie. The home token is
 * stashed ONCE (a second assume keeps the original home) so exit restores it.
 */
export async function assumeTenantAction(
  clientId: string,
): Promise<{ success: boolean; brandName?: string; error?: string }> {
  const cookieStore = await cookies();
  const token = cookieStore.get('token')?.value;
  if (!token) return { success: false, error: 'Not authenticated' };

  try {
    const res = await fetch(`${API_URL}/v1/auth/assume-tenant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ clientId }),
      signal: AbortSignal.timeout(12_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { success: false, error: body?.error ?? 'Could not switch brand context' };
    }
    const newToken: string | undefined = body?.data?.accessToken;
    const newRefresh: string | undefined = body?.data?.refreshToken;
    const brandName: string = body?.data?.brandName ?? '';
    if (!newToken) return { success: false, error: 'Could not switch brand context' };

    // Stash the home (operator) session ONCE — both token AND refresh token — so Exit
    // restores the exact home session and refresh works in either context.
    if (!cookieStore.get('home_token')) {
      // Stash home_token at the 7d REFRESH_MAX_AGE (NOT the access token's own ~60m exp): the
      // access token is now short-lived, so a maxAge of accessCookieMaxAge(token) would drop the
      // home_token cookie after ~60m of assumed work — then Exit's `if (home)` restore block would
      // be skipped, stranding the operator on the assumed tenant token under platform chrome. The
      // stashed VALUE may be an expired access token, but that's fine: on Exit it is restored
      // alongside home_refresh_token, and the proxy's page-nav silent refresh exchanges the home
      // refresh token for a fresh home session on the next navigation. Matches its sibling below.
      cookieStore.set('home_token', token, cookieOptions(REFRESH_MAX_AGE));
      const homeRefresh = cookieStore.get('refresh_token')?.value;
      if (homeRefresh) cookieStore.set('home_refresh_token', homeRefresh, cookieOptions(REFRESH_MAX_AGE));
    }
    cookieStore.set('token', newToken, cookieOptions(accessCookieMaxAge(newToken)));
    if (newRefresh) cookieStore.set('refresh_token', newRefresh, cookieOptions(REFRESH_MAX_AGE));
    return { success: true, brandName };
  } catch {
    return { success: false, error: 'Network error switching brand context' };
  }
}

/** Exit the assumed-tenant context: restore the stashed home session, drop the stash. */
export async function exitTenantAction(): Promise<{ success: boolean }> {
  const cookieStore = await cookies();
  const home = cookieStore.get('home_token')?.value;
  if (home) {
    cookieStore.set('token', home, cookieOptions(accessCookieMaxAge(home)));
    const homeRefresh = cookieStore.get('home_refresh_token')?.value;
    if (homeRefresh) cookieStore.set('refresh_token', homeRefresh, cookieOptions(REFRESH_MAX_AGE));
    cookieStore.delete('home_token');
    cookieStore.delete('home_refresh_token');
  }
  return { success: true };
}

/**
 * Silently refresh an expired access token using the (single-use, rotating) httpOnly
 * refresh-token cookie. Called by SessionExpiryGuard on a 401 BEFORE bouncing to login,
 * so a normal session-expiry doesn't interrupt the user. On success the new access +
 * refresh cookies are set and `{ ok: true }` is returned; the caller retries the request.
 * On failure the cookies are LEFT INTACT: with the backend returning the successor tokens on a
 * contended/just-rotated refresh (multi-tab), deleting the refresh cookie here would strand the
 * other tabs on a session that is actually still alive. A genuinely dead session simply keeps
 * 401ing and SessionExpiryGuard bounces to login; logoutAction still clears cookies on real logout.
 */
export async function refreshSession(): Promise<{ ok: boolean }> {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get('refresh_token')?.value;
  if (!refreshToken) return { ok: false };

  const refreshed = await refreshTokensViaBackend(refreshToken);
  if (!refreshed) {
    // Do NOT delete the refresh cookie here: a contended/just-rotated refresh (multi-tab) can
    // fail transiently while the session is still alive. Leave the cookies intact — a truly dead
    // session keeps 401ing and SessionExpiryGuard bounces to login.
    return { ok: false };
  }
  cookieStore.set('token', refreshed.accessToken, cookieOptions(accessCookieMaxAge(refreshed.accessToken)));
  if (refreshed.refreshToken) cookieStore.set('refresh_token', refreshed.refreshToken, cookieOptions(REFRESH_MAX_AGE));
  return { ok: true };
}

/**
 * Server-truth source for the operator banner: read the httpOnly token cookie, verify
 * it, and return the brand the operator is actually working in (or null at platform
 * level). Because this reads the REAL cookie token — not a client localStorage hint —
 * the banner can never desync from the active session (the AF-6 replacement for the
 * old client-side token-decode self-heal).
 */
export async function getAssumedContext(): Promise<{ brandName: string | null }> {
  const cookieStore = await cookies();
  const token = cookieStore.get('token')?.value;
  if (!token) return { brandName: null };
  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? '');
    const { payload } = await jwtVerify(token, secret);
    if (payload.assumed !== true) return { brandName: null };
    const clientId = (payload.clientId as string) ?? '';
    // §A-DOMAIN Phase 2: DB-aware display name (non-blocking cache warm; resolveClientConfig
    // overlays any non-empty DB branding over the registry, falling back to it).
    void refreshIfStale();
    const cfg = resolveClientConfig(clientId);
    return { brandName: cfg?.branding.displayName ?? clientId ?? null };
  } catch {
    return { brandName: null };
  }
}

/** Clear the auth cookies on logout (the token is httpOnly so only the server can). */
export async function logoutAction(): Promise<{ success: boolean }> {
  const cookieStore = await cookies();
  cookieStore.delete('token');
  cookieStore.delete('refresh_token');
  cookieStore.delete('home_token');
  cookieStore.delete('home_refresh_token');
  // Wave 3 — also drop the active-outlet selection so a shared device / the next login
  // starts in its OWN outlet context (never a previous user's selected sibling).
  cookieStore.delete('active_partner_id');
  return { success: true };
}
