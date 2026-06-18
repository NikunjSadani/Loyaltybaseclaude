'use server';

import { cookies, headers } from 'next/headers';

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
 * Resolve the tenant slug from the request Host header (subdomain), e.g.
 * `deoleo.gifsy.in` → `deoleo`. Bare domains, `www`/`platform`, and localhost
 * fall back to DEFAULT_CLIENT_ID — matches `lib/tenant.ts`. The backend
 * `verify-otp` requires `clientId` in the body to scope the user lookup.
 */
function resolveClientId(host: string | null): string {
  if (!host) return DEFAULT_CLIENT_ID;
  const hostname = host.split(':')[0].toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1') return DEFAULT_CLIENT_ID;
  const parts = hostname.split('.');
  if (parts.length < 3) return DEFAULT_CLIENT_ID; // bare domain, no subdomain
  const sub = parts[0];
  if (sub === 'www' || sub === 'platform') return DEFAULT_CLIENT_ID;
  return sub;
}

export async function sendOTP(
  mobile: string,
  channel: 'SMS' | 'WHATSAPP',
): Promise<SendOTPResult> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/auth/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Backend SendOtpDto expects `phone` (not `mobile`).
      body: JSON.stringify({ phone: mobile, channel }),
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
): Promise<VerifyOTPResult> {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const clientId = resolveClientId((await headers()).get('host'));

    const res = await fetch(`${baseUrl}/api/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Backend VerifyOtpDto expects { phone, otp, clientId }.
      body: JSON.stringify({ phone: mobile, otp, clientId }),
    });

    const data = await res.json();

    if (!res.ok) {
      return { success: false, error: data.error ?? 'Invalid OTP. Please try again.' };
    }

    // Backend returns { success, data: { accessToken, refreshToken, user } }.
    const token: string = data.data?.accessToken ?? '';
    const user = data.data?.user;

    // Also set an httpOnly cookie (defence-in-depth / future SSR guard); the
    // client stores the token in localStorage because api-client.ts sends it as
    // an Authorization: Bearer header and the backend extracts it from there.
    const cookieStore = await cookies();
    cookieStore.set('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    });

    return { success: true, role: user?.role, token, user };
  } catch {
    return { success: false, error: 'Network error. Please check your connection.' };
  }
}
