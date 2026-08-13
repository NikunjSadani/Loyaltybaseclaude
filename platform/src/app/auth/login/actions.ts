'use server';

import { cookies, headers } from 'next/headers';
import { resolveTenant } from '@/lib/platform/tenant-resolution';
import { resolveTrustedHost } from '@/lib/platform/edge-trust';
// Reuse the single shared derivation instead of re-implementing it here (it drifted; the access
// token is now ~60m, not 7d). accessCookieMaxAge tracks the JWT's real exp; REFRESH_MAX_AGE is 7d.
import { accessCookieMaxAge, REFRESH_MAX_AGE } from '@/lib/auth-refresh';

interface SendOTPResult {
  success: boolean;
  error?: string;
}

interface VerifyOTPResult {
  success: boolean;
  role?: string;
  /** JWT access token — the client stores this in localStorage (api-client reads it for Bearer auth). */
  token?: string;
  user?: { id: string; name: string; role: string; phone: string };
  error?: string;
}

const DEFAULT_CLIENT_ID = 'deoleo';

/**
 * Resolve the tenant clientId from the request Host header. Delegates to the
 * shared DB-aware `resolveTenant` so login uses the SAME resolution as the rest
 * of the app — the DB routing map (from GET /v1/tenants/routing) layered over the
 * CLIENT_REGISTRY custom-domain map, so a branded domain whose label differs from
 * the slug resolves correctly:
 *   deoleoloyalty.gifsy.in → deoleo   (DB map / custom-domain map)
 *   deoleo.gifsy.in        → deoleo   (subdomain label)
 *   localhost (dev) → DEFAULT_CLIENT_ID
 * The backend `verify-otp` requires `clientId` in the body to scope the user lookup.
 * DB-aware; `resolveTenant` cold-warms the DB map so a branded host resolves on the
 * first login of a fresh instance.
 *
 * FAIL-CLOSED (design §5): in PRODUCTION an unknown/null-resolving host (bare domain,
 * reserved subdomain) returns null — it must NOT silently scope the login to Deoleo.
 * Dev keeps the Deoleo default (localhost has no subdomain). A real tenant login always
 * arrives on a tenant host (→ a slug) or the operator host (→ 'gifsy'), so null only
 * happens for non-login hosts.
 */
async function resolveClientId(host: string | null): Promise<string | null> {
  const { slug } = await resolveTenant(host ?? '');
  if (slug) return slug;
  return process.env.NODE_ENV === 'production' ? null : DEFAULT_CLIENT_ID;
}


export async function sendOTP(
  mobile: string,
  channel: 'SMS' | 'WHATSAPP',
): Promise<SendOTPResult> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    // Resolve the tenant from the request Host (same as verifyOTP) so the backend can
    // pick the per-tenant login OTP template; absent → the global env template is used.
    const hdrs = await headers();
    const clientId = await resolveClientId(resolveTrustedHost((n) => hdrs.get(n)));
    if (!clientId) {
      // Fail-closed: could not determine the tenant from this host (prod).
      return { success: false, error: 'Unable to determine your organization from this address.' };
    }
    const res = await fetch(`${baseUrl}/api/auth/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Backend SendOtpDto expects `phone` (not `mobile`).
      body: JSON.stringify({ phone: mobile, channel, clientId }),
      // Never let an unreachable API host hang the login form forever — fail fast to the
      // catch below (which surfaces "Network error") instead of an endless spinner.
      signal: AbortSignal.timeout(12_000),
    });

    const data = await res.json();

    if (!res.ok) {
      return { success: false, error: data.error ?? 'Failed to send OTP. Please try again.' };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error. Please check your connection.' };
  }
}

export async function verifyOTP(
  mobile: string,
  otp: string,
  clientIdOverride?: string,
): Promise<VerifyOTPResult> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    // Behind the Cloudflare Worker, `host` is the internal .run.app origin; the real
    // public hostname (e.g. deoleoloyalty.gifsy.in) is carried in `x-forwarded-host`
    // (set by cloudflare-worker/worker.js). Read that first so a branded custom domain
    // resolves its tenant instead of falling back to DEFAULT_CLIENT_ID.
    const hdrs = await headers();
    let clientId = await resolveClientId(resolveTrustedHost((n) => hdrs.get(n)));

    // DEV-ONLY clientId override (#39 / Q3). On localhost there is no real subdomain, so the form
    // offers an explicit org field to log in as GIFSY (or any non-default tenant). NEVER honored in
    // production — there the Host subdomain is authoritative, so a tenant cannot impersonate another.
    if (process.env.NODE_ENV !== 'production' && clientIdOverride) {
      clientId = clientIdOverride.trim().toLowerCase();
    }

    if (!clientId) {
      // Fail-closed: unknown tenant for this host (prod, no dev override).
      return { success: false, error: 'Unable to determine your organization from this address.' };
    }

    const res = await fetch(`${baseUrl}/api/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Backend VerifyOtpDto expects { phone, otp, clientId }.
      body: JSON.stringify({ phone: mobile, otp, clientId }),
      signal: AbortSignal.timeout(12_000),
    });

    const data = await res.json();

    if (!res.ok) {
      return { success: false, error: data.error ?? 'Invalid OTP. Please try again.' };
    }

    // Backend returns { success, data: { accessToken, refreshToken, user } }.
    const token: string = data.data?.accessToken ?? '';
    const refreshToken: string = data.data?.refreshToken ?? '';
    const user = data.data?.user;

    // AF-6: the access token lives ONLY in this httpOnly cookie — it is NOT readable
    // by JS and is NOT mirrored to localStorage. The edge proxy reads this cookie and
    // injects `Authorization: Bearer` for the backend on every `/api/*` request.
    const cookieStore = await cookies();
    const cookieBase = {
      httpOnly: true as const,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
    };
    // Access cookie maxAge tracks the token's REAL exp (drift-proof) so it can never outlive
    // the ~60m access JWT; falls back to the shared default if the token can't be decoded.
    cookieStore.set('token', token, { ...cookieBase, maxAge: accessCookieMaxAge(token) });
    // AF-6 refresh: the (single-use, rotating) refresh token also lives ONLY in an
    // httpOnly cookie (NOT localStorage — that would re-open the XSS exposure AF-6 closed).
    // SessionExpiryGuard (XHR) and the proxy (page-nav) use it to silently refresh an expired
    // ~60m access token before bouncing to login. TTL tracks the backend's SLIDING 7-day session
    // (REFRESH_MAX_AGE) — NOT 30d, which outlived the real session and masked expiry.
    if (refreshToken) {
      cookieStore.set('refresh_token', refreshToken, { ...cookieBase, maxAge: REFRESH_MAX_AGE });
    }

    return { success: true, role: user?.role, token, user };
  } catch {
    return { success: false, error: 'Network error. Please check your connection.' };
  }
}
