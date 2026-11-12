/**
 * login verifyOTP — auth cookie TTLs for the rolling 7-day session.
 *
 * The core fix: the refresh_token cookie is written at 30 days (SESSION_TTL_DAYS), NOT the old
 * 30 days that outlived the real backend session. The access `token` cookie tracks the JWT's
 * real `exp` (~30d, drift-proof).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const REFRESH_SECS = 60 * 60 * 24 * 30; // 2592000 — matches REFRESH_MAX_AGE (30d)

const setCalls: Array<{ name: string; value: string; opts: { maxAge?: number } }> = [];
const cookieStore = {
  get: vi.fn(() => undefined),
  set: vi.fn((name: string, value: string, opts: { maxAge?: number }) => { setCalls.push({ name, value, opts }); }),
  delete: vi.fn(),
};
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
  headers: () => Promise.resolve({ get: () => null }),
}));
vi.mock('@/lib/platform/tenant-resolution', () => ({ resolveTenant: async () => ({ slug: 'deoleo' }) }));
vi.mock('@/lib/platform/edge-trust', () => ({ resolveTrustedHost: () => 'deoleo.gifsy.in' }));

import { sendOTP, verifyOTP } from '@/app/auth/login/actions';

function jwtWithExp(expSecs: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: expSecs })}.sig`;
}
const nowSecs = () => Math.floor(Date.now() / 1000);
const setOf = (name: string) => setCalls.filter((c) => c.name === name).at(-1);

beforeEach(() => { setCalls.length = 0; cookieStore.set.mockClear(); });

describe('verifyOTP — cookie TTLs', () => {
  it('sets refresh_token cookie maxAge = 30d (2592000) and token cookie ≈ access TTL', async () => {
    const exp = nowSecs() + REFRESH_SECS;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { accessToken: jwtWithExp(exp), refreshToken: 'r-login', user: { id: 'u1', name: 'A', role: 'ADMIN', phone: '9' } },
      }),
    }));

    const res = await verifyOTP('9830011252', '123456');

    expect(res.success).toBe(true);
    // Core: refresh cookie tracks the sliding 30-day session (REFRESH_MAX_AGE), in lockstep with the backend.
    expect(setOf('refresh_token')?.value).toBe('r-login');
    expect(setOf('refresh_token')?.opts.maxAge).toBe(REFRESH_SECS);
    // Access cookie tracks the JWT exp (~30d, drift-proof).
    const tokenMaxAge = setOf('token')?.opts.maxAge ?? 0;
    expect(tokenMaxAge).toBeGreaterThan(REFRESH_SECS - 5);
    expect(tokenMaxAge).toBeLessThanOrEqual(REFRESH_SECS);
  });
});

/**
 * 429 copy (2026-11-10). The API answers a throttler refusal with the raw Nest text
 * "ThrottlerException: Too Many Requests", which the login page used to toast verbatim. Map it to
 * friendly copy; the per-phone HOURLY DB cap returns its own clear message, which is kept as-is.
 */
describe('login actions — 429 copy', () => {
  const FRIENDLY = 'Too many attempts. Please wait a minute and try again.';
  const DB_CAP = 'Too many OTP requests for this number. Please wait a while before trying again.';
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status < 400, status, json: () => Promise.resolve(body) }));

  it('sendOTP: throttler 429 → friendly copy, never the raw ThrottlerException text', async () => {
    respond(429, { success: false, error: 'ThrottlerException: Too Many Requests' });
    const res = await sendOTP('9830011252', 'SMS');
    expect(res).toEqual({ success: false, error: FRIENDLY });
  });

  it('verifyOTP: throttler 429 → friendly copy', async () => {
    respond(429, { success: false, error: 'ThrottlerException: Too Many Requests' });
    const res = await verifyOTP('9830011252', '123456');
    expect(res).toEqual({ success: false, error: FRIENDLY });
  });

  it('sendOTP: 429 with no/unknown body → friendly copy', async () => {
    respond(429, {});
    expect((await sendOTP('9830011252', 'SMS')).error).toBe(FRIENDLY);
  });

  it('sendOTP: the per-phone hourly DB cap keeps its own message', async () => {
    respond(429, { success: false, error: DB_CAP });
    expect((await sendOTP('9830011252', 'SMS')).error).toBe(DB_CAP);
  });

  it('non-429 errors are unchanged (e.g. 401 no-account)', async () => {
    respond(401, { success: false, error: 'No account found. Please contact your sales representative to complete KYC first.' });
    expect((await sendOTP('9830011252', 'SMS')).error).toBe('No account found. Please contact your sales representative to complete KYC first.');
  });
});
