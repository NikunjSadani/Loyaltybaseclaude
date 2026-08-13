/**
 * Rolling 7-day session — FE cookie TTL + multi-tab refresh safety.
 *
 * The backend session/refresh idle window is a SLIDING 7 days (SESSION_TTL_DAYS=7). These tests
 * pin the FE cookie half:
 *  - refresh-token cookie writes use 7d (604800), NOT the old 30d that outlived the real session;
 *  - the access cookie tracks the JWT's real `exp` (~7d);
 *  - refreshSession does NOT delete the refresh cookie on a non-success/contended response
 *    (deleting it strands other tabs whose session is still alive).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const SEVEN_DAYS = 60 * 60 * 24 * 7; // 604800
const ONE_HOUR = 60 * 60; // access token is now short-lived (~60m)

const store = new Map<string, string>();
const setCalls: Array<{ name: string; value: string; opts: { maxAge?: number } }> = [];
const deleted: string[] = [];
const cookieStore = {
  get: vi.fn((name: string) => (store.has(name) ? { value: store.get(name)! } : undefined)),
  set: vi.fn((name: string, value: string, opts: { maxAge?: number }) => {
    store.set(name, value);
    setCalls.push({ name, value, opts });
  }),
  delete: vi.fn((name: string) => { store.delete(name); deleted.push(name); }),
};
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(cookieStore) }));
vi.mock('@/lib/platform/tenant-resolution', () => ({ resolveClientConfig: () => null }));
vi.mock('@/lib/platform/tenant-routing-cache', () => ({ refreshIfStale: () => {} }));

import { refreshSession, assumeTenantAction, exitTenantAction } from '@/lib/auth-actions';

/** A minimal, unsigned JWT whose payload carries `exp` — decodeJwt only base64url-decodes it. */
function jwtWithExp(expSecs: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: expSecs })}.sig`;
}
const nowSecs = () => Math.floor(Date.now() / 1000);
const setOf = (name: string) => setCalls.filter((c) => c.name === name).at(-1);

beforeEach(() => {
  store.clear();
  setCalls.length = 0;
  deleted.length = 0;
  cookieStore.set.mockClear();
  cookieStore.delete.mockClear();
  cookieStore.get.mockClear();
});

describe('refreshSession — multi-tab safety + 7-day TTL', () => {
  it('does NOT delete the refresh_token cookie on a non-success/contended response', async () => {
    store.set('refresh_token', 'r-alive');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'contended' }),
    }));

    const res = await refreshSession();

    expect(res).toEqual({ ok: false });
    expect(deleted).not.toContain('refresh_token');   // the core fix: cookie left intact
    expect(store.get('refresh_token')).toBe('r-alive'); // still present for the other tabs
  });

  it('sets BOTH token and refresh cookies on success — refresh maxAge = 7d, token maxAge ≈ access exp', async () => {
    store.set('refresh_token', 'r-old');
    const exp = nowSecs() + SEVEN_DAYS;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { accessToken: jwtWithExp(exp), refreshToken: 'r-new' } }),
    }));

    const res = await refreshSession();

    expect(res).toEqual({ ok: true });
    expect(setOf('refresh_token')?.value).toBe('r-new');
    expect(setOf('refresh_token')?.opts.maxAge).toBe(SEVEN_DAYS);
    // access cookie tracks the JWT exp (drift-proof) — within a couple seconds of 7d.
    const tokenMaxAge = setOf('token')?.opts.maxAge ?? 0;
    expect(tokenMaxAge).toBeGreaterThan(SEVEN_DAYS - 5);
    expect(tokenMaxAge).toBeLessThanOrEqual(SEVEN_DAYS);
  });
});

describe('assume / exit — refresh-cookie writes use 7d, not 30d', () => {
  it('assumeTenantAction writes refresh_token AND home_refresh_token at 7d, and stashes home_token at 7d (NOT the ~60m access exp)', async () => {
    // The operator's HOME access token is now short-lived (~60m). Capture the exact value so the
    // assertion compares against the SAME token (recomputing jwtWithExp could drift by a second).
    const homeAccess = jwtWithExp(nowSecs() + ONE_HOUR);
    store.set('token', homeAccess);
    store.set('refresh_token', 'home-refresh');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: { accessToken: jwtWithExp(nowSecs() + ONE_HOUR), refreshToken: 'assumed-refresh', brandName: 'Acme' },
      }),
    }));

    const res = await assumeTenantAction('acme');

    expect(res.success).toBe(true);
    expect(setOf('home_refresh_token')?.opts.maxAge).toBe(SEVEN_DAYS);
    expect(setOf('refresh_token')?.value).toBe('assumed-refresh');
    expect(setOf('refresh_token')?.opts.maxAge).toBe(SEVEN_DAYS);
    // SHIP-BLOCKER guard: home_token must be stashed at 7d, NOT accessCookieMaxAge(~60m) — else the
    // browser drops it after ~60m and Exit can no longer restore the home context. Its maxAge must
    // track its home_refresh_token sibling (7d), even though the stashed VALUE is a ~60m token.
    expect(setOf('home_token')?.opts.maxAge).toBe(SEVEN_DAYS);
    expect(setOf('home_token')?.value).toBe(homeAccess);
  });

  it('exitTenantAction restores home refresh_token at 7d', async () => {
    store.set('home_token', jwtWithExp(nowSecs() + ONE_HOUR));
    store.set('home_refresh_token', 'home-refresh');

    const res = await exitTenantAction();

    expect(res).toEqual({ success: true });
    expect(setOf('refresh_token')?.value).toBe('home-refresh');
    expect(setOf('refresh_token')?.opts.maxAge).toBe(SEVEN_DAYS);
  });

  it('exitTenantAction restores home context even when the home ACCESS token has EXPIRED (the ship-blocker regression)', async () => {
    // Simulates >60m of assumed work: the home ACCESS token value is expired, but the home_token
    // COOKIE is still present (it is now stashed at 7d maxAge, so the browser still holds it).
    const expiredHome = jwtWithExp(nowSecs() - 60);
    store.set('home_token', expiredHome);
    store.set('home_refresh_token', 'home-refresh');
    // Currently on the assumed tenant token:
    store.set('token', 'assumed-token');
    store.set('refresh_token', 'assumed-refresh');

    const res = await exitTenantAction();

    expect(res).toEqual({ success: true });
    // The `if (home)` restore block MUST run: home access token restored (value still the expired
    // one — the proxy page-nav silent refresh will exchange the restored home refresh for a fresh
    // session on the next navigation), and the home refresh token restored so that refresh works.
    expect(setOf('token')?.value).toBe(expiredHome);
    expect(setOf('refresh_token')?.value).toBe('home-refresh');
    expect(setOf('refresh_token')?.opts.maxAge).toBe(SEVEN_DAYS);
    // The stash is consumed, not orphaned: BOTH home_token and home_refresh_token are deleted.
    expect(deleted).toContain('home_token');
    expect(deleted).toContain('home_refresh_token');
  });
});
