'use server';

import { cookies, headers } from 'next/headers';
import { resolveSlugFromHostname } from '@/lib/platform/tenant-resolution';

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
 * shared `resolveSlugFromHostname` so login uses the SAME resolution as the rest
 * of the app — including the CLIENT_REGISTRY custom-domain map, so a branded
 * domain whose label differs from the slug resolves correctly:
 *   deoleoloyalty.gifsy.in → deoleo   (custom-domain map)
 *   deoleo.gifsy.in        → deoleo   (subdomain label)
 *   gifsy.in / www / localhost → DEFAULT_CLIENT_ID
 * The backend `verify-otp` requires `clientId` in the body to scope the user lookup.
 */
function resolveClientId(host: string | null): string {
  return resolveSlugFromHostname(host ?? '') ?? DEFAULT_CLIENT_ID;
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
    const clientId = resolveClientId(hdrs.get('x-forwarded-host') ?? hdrs.get('host'));
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
    let clientId = resolveClientId(hdrs.get('x-forwarded-host') ?? hdrs.get('host'));

    // DEV-ONLY clientId override (#39 / Q3). On localhost there is no real subdomain, so the form
    // offers an explicit org field to log in as GIFSY (or any non-default tenant). NEVER honored in
    // production — there the Host subdomain is authoritative, so a tenant cannot impersonate another.
    if (process.env.NODE_ENV !== 'production' && clientIdOverride) {
      clientId = clientIdOverride.trim().toLowerCase();
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
    cookieStore.set('token', token, { ...cookieBase, maxAge: 60 * 60 * 24 * 7 }); // 7 days
    // AF-6 refresh: the (single-use, rotating) refresh token also lives ONLY in an
    // httpOnly cookie (NOT localStorage — that would re-open the XSS exposure AF-6 closed).
    // SessionExpiryGuard uses it to silently refresh an expired access token before
    // bouncing to login. TTL matches the backend refresh-token lifetime (30 days).
    if (refreshToken) {
      cookieStore.set('refresh_token', refreshToken, { ...cookieBase, maxAge: 60 * 60 * 24 * 30 });
    }

    return { success: true, role: user?.role, token, user };
  } catch {
    return { success: false, error: 'Network error. Please check your connection.' };
  }
}
