/**
 * login verifyOTP — auth cookie TTLs for the rolling 7-day session.
 *
 * The core fix: the refresh_token cookie is written at 7 days (SESSION_TTL_DAYS), NOT the old
 * 30 days that outlived the real backend session. The access `token` cookie tracks the JWT's
 * real `exp` (~7d, drift-proof).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const SEVEN_DAYS = 60 * 60 * 24 * 7; // 604800

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

import { verifyOTP } from '@/app/auth/login/actions';

function jwtWithExp(expSecs: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: expSecs })}.sig`;
}
const nowSecs = () => Math.floor(Date.now() / 1000);
const setOf = (name: string) => setCalls.filter((c) => c.name === name).at(-1);

beforeEach(() => { setCalls.length = 0; cookieStore.set.mockClear(); });

describe('verifyOTP — cookie TTLs', () => {
  it('sets refresh_token cookie maxAge = 7d (604800) and token cookie ≈ access TTL', async () => {
    const exp = nowSecs() + SEVEN_DAYS;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { accessToken: jwtWithExp(exp), refreshToken: 'r-login', user: { id: 'u1', name: 'A', role: 'ADMIN', phone: '9' } },
      }),
    }));

    const res = await verifyOTP('9830011252', '123456');

    expect(res.success).toBe(true);
    // Core fix: refresh cookie tracks the sliding 7-day session, not 30d.
    expect(setOf('refresh_token')?.value).toBe('r-login');
    expect(setOf('refresh_token')?.opts.maxAge).toBe(SEVEN_DAYS);
    // Access cookie tracks the JWT exp (~7d, drift-proof).
    const tokenMaxAge = setOf('token')?.opts.maxAge ?? 0;
    expect(tokenMaxAge).toBeGreaterThan(SEVEN_DAYS - 5);
    expect(tokenMaxAge).toBeLessThanOrEqual(SEVEN_DAYS);
  });
});
