/**
 * Shared session-refresh primitives (AF-6 rolling sessions).
 *
 * These are the runtime-agnostic pieces of the refresh flow — no `next/headers`,
 * no `'use server'` — so BOTH callers can reuse them:
 *   - the `refreshSession` server action (lib/auth-actions.ts), fired by
 *     SessionExpiryGuard on an XHR 401, and
 *   - the edge proxy (proxy.ts), which silently refreshes on a FULL PAGE navigation
 *     when the ~60m access token has expired but the 30d refresh cookie is still valid.
 *
 * Cookie SETTING differs by caller (server action mutates `cookies()`; proxy mutates
 * `NextResponse.cookies`), but the backend call, the maxAge derivation and the cookie
 * option shape are identical — factored here so the two paths can never drift.
 */

import { decodeJwt } from 'jose';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Access-cookie maxAge fallback when a token carries no decodable future `exp`. Matches the
 * backend JWT_EXPIRES_IN (the access token is now ~60m) so the cookie can't outlive its token
 * even on the (unexpected) decode-failure path. In practice a real token always decodes, so
 * this is a safety net, not the common path.
 */
export const ACCESS_MAX_AGE_FALLBACK = 60 * 60;

// The backend session/refresh idle window is a SLIDING 30 days (SESSION_TTL_DAYS=30). The
// refresh cookie must track that TTL EXACTLY — NOT outlive it (an over-long value masks the
// real session and strands users whose backend session has lapsed) and NOT fall short (a
// shorter cookie logs the user out while the backend session is still alive). Kept in
// lockstep with SESSION_TTL_DAYS on the backend.
export const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Cookie options shared by every session-cookie write. The shape is accepted verbatim by
 * both `cookies().set(name, value, opts)` (server action) and
 * `NextResponse.cookies.set(name, value, opts)` (proxy).
 *
 * NOTE: cookies are deliberately HOST-ONLY (no `domain`). A parent-domain (".gifsy.in") scope
 * was considered to fix the operator cross-subdomain hop but REJECTED after a security audit —
 * it would broadcast the httpOnly refresh token to every *.gifsy.in host (opshub, kwality, the
 * edge worker), widen the same-site/CSRF surface, and strand cookies on rollout. The operator
 * cross-subdomain case needs a narrower, dedicated design, not a blanket domain cookie.
 */
export const sessionCookieOptions = (maxAge: number) => ({
  httpOnly: true as const,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge,
  path: '/',
});

/**
 * Access-cookie maxAge that tracks the JWT's REAL `exp` (drift-proof) so the cookie can
 * never outlive the token it carries. Falls back to ACCESS_MAX_AGE_FALLBACK if the token
 * can't be decoded or carries no future `exp`.
 */
export function accessCookieMaxAge(token: string): number {
  try {
    const { exp } = decodeJwt(token);
    if (typeof exp === 'number') {
      const secs = exp - Math.floor(Date.now() / 1000);
      if (secs > 0) return secs;
    }
  } catch {
    // fall through to the constant TTL
  }
  return ACCESS_MAX_AGE_FALLBACK;
}

/** Backoff before each retry of a 429'd refresh (ms). Bounded so a page navigation never stalls. */
const REFRESH_429_BACKOFF_MS = [300, 900];
/** Cap on a server-sent Retry-After (ms). */
const REFRESH_429_MAX_WAIT_MS = 2_000;

/**
 * Exchange a (single-use, rotating) refresh token for a fresh access + refresh pair via the
 * backend. Returns the new tokens on success, or `null` on ANY failure (network error, non-2xx,
 * or a missing access token in the body).
 *
 * A 429 is "retry later", NOT "session dead": the backend's throttler rejects BEFORE the refresh
 * token is looked at, so the same token is still valid — retry it (bounded backoff, honouring a
 * short Retry-After) instead of returning null, which both callers turn into a bounce to login.
 *
 * On failure the caller MUST leave the existing cookies intact: with the backend returning the
 * successor tokens on a contended/just-rotated refresh (multi-tab / parallel page requests),
 * deleting the refresh cookie would strand sessions that are actually still alive. A genuinely
 * dead session simply keeps failing and the caller bounces to login.
 */
export async function refreshTokensViaBackend(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string } | null> {
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${API_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 429 && attempt < REFRESH_429_BACKOFF_MS.length) {
        const retryAfterSecs = Number(res.headers?.get?.('Retry-After'));
        const wait = Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
          ? Math.min(retryAfterSecs * 1000, REFRESH_429_MAX_WAIT_MS)
          : REFRESH_429_BACKOFF_MS[attempt];
        // Release the unread 429 body first so its connection isn't held open across the wait.
        await res.body?.cancel().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      const body = await res.json().catch(() => null);
      const accessToken: string | undefined = body?.data?.accessToken;
      const newRefresh: string | undefined = body?.data?.refreshToken;
      if (!res.ok || !accessToken) return null;
      return { accessToken, refreshToken: newRefresh };
    }
  } catch {
    return null;
  }
}
