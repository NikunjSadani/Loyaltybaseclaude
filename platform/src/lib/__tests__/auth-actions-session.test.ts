/**
 * Rolling 7-day session — FE cookie TTL + multi-tab refresh safety.
 *
 * The backend session/refresh idle window is a SLIDING 30 days (SESSION_TTL_DAYS=30). These tests
 * pin the FE cookie half:
 *  - refresh-token cookie writes use 30d (2592000) = REFRESH_MAX_AGE, kept in lockstep with the 30d backend session (neither outlives it nor dies first);
 *  - the access cookie tracks the JWT's real `exp` (~30d);
 *  - refreshSession does NOT delete the refresh cookie on a non-success/contended response
 *    (deleting it strands other tabs whose session is still alive).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

const REFRESH_SECS = 60 * 60 * 24 * 30; // 2592000 — matches REFRESH_MAX_AGE (30d)
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
// Request headers as forwarded by the proxy (B1: x-session-refreshed marks a proxy rotation).
const requestHeaders = new Headers();
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(cookieStore),
  headers: () => Promise.resolve(requestHeaders),
}));
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
  requestHeaders.delete('x-session-refreshed');
  requestHeaders.delete('cookie');
});

describe('refreshSession — B1 no double rotation + B3 transient', () => {
  it('when the PROXY already rotated in this request (x-session-refreshed) → reuses that pair: NO backend call, NO cookie writes', async () => {
    // Next merges the proxy's Set-Cookie into cookies(): the store already holds the NEW pair.
    store.set('token', jwtWithExp(nowSecs() + ONE_HOUR));
    store.set('refresh_token', 'r-from-proxy');
    requestHeaders.set('x-session-refreshed', '1');
    requestHeaders.set('cookie', 'token=old; refresh_token=r-original'); // what the browser SENT
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await refreshSession();

    expect(res).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled(); // the just-issued r-from-proxy is NOT rotated again
    expect(setCalls).toHaveLength(0);
    expect(store.get('refresh_token')).toBe('r-from-proxy');
  });

  it('F5: a FORGED marker (refresh cookie unchanged from what the browser sent) is ignored → normal exchange', async () => {
    store.set('refresh_token', 'r-same');
    requestHeaders.set('x-session-refreshed', '1');
    requestHeaders.set('cookie', 'refresh_token=r-same');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ data: { accessToken: jwtWithExp(nowSecs() + ONE_HOUR), refreshToken: 'r-next' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshSession()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1); // did NOT short-circuit on the header alone
    expect(setOf('refresh_token')?.value).toBe('r-next');
  });

  it('without the marker it still rotates normally (one backend call)', async () => {
    store.set('refresh_token', 'r-old');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ data: { accessToken: jwtWithExp(nowSecs() + ONE_HOUR), refreshToken: 'r-new' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshSession()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setOf('refresh_token')?.value).toBe('r-new');
  });

  it('a TRANSIENT backend failure (5xx) → { ok:false, transient:true } and cookies untouched', async () => {
    store.set('refresh_token', 'r-alive');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, body: { cancel: vi.fn().mockResolvedValue(undefined) }, json: () => Promise.resolve({}) }));

    await expect(refreshSession()).resolves.toEqual({ ok: false, transient: true });
    expect(deleted).toHaveLength(0);
    expect(setCalls).toHaveLength(0);
  });

  it('a DEFINITE refusal (401) → { ok:false } (no transient flag) and cookies untouched', async () => {
    store.set('refresh_token', 'r-dead');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) }));

    await expect(refreshSession()).resolves.toEqual({ ok: false });
    expect(deleted).toHaveLength(0);
  });
});

describe('refreshSession — multi-tab safety + 7-day TTL', () => {
  it('does NOT delete the refresh_token cookie on a non-success/contended response', async () => {
    store.set('refresh_token', 'r-alive');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409, // a non-401/403 refusal is TRANSIENT (L2) — the session may be alive
      json: () => Promise.resolve({ error: 'contended' }),
    }));

    const res = await refreshSession();

    expect(res).toEqual({ ok: false, transient: true });
    expect(deleted).not.toContain('refresh_token');   // the core fix: cookie left intact
    expect(store.get('refresh_token')).toBe('r-alive'); // still present for the other tabs
  });

  it('sets BOTH token and refresh cookies on success — refresh maxAge = 30d, token maxAge ≈ access exp', async () => {
    store.set('refresh_token', 'r-old');
    const exp = nowSecs() + REFRESH_SECS;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { accessToken: jwtWithExp(exp), refreshToken: 'r-new' } }),
    }));

    const res = await refreshSession();

    expect(res).toEqual({ ok: true });
    expect(setOf('refresh_token')?.value).toBe('r-new');
    expect(setOf('refresh_token')?.opts.maxAge).toBe(REFRESH_SECS);
    // access cookie tracks the JWT exp (drift-proof) — within a couple seconds of the mock's 30d exp.
    const tokenMaxAge = setOf('token')?.opts.maxAge ?? 0;
    expect(tokenMaxAge).toBeGreaterThan(REFRESH_SECS - 5);
    expect(tokenMaxAge).toBeLessThanOrEqual(REFRESH_SECS);
  });
});

describe('assume / exit — refresh-cookie writes use the 30d session window', () => {
  it('assumeTenantAction writes refresh_token AND home_refresh_token at 30d, and stashes home_token at 30d (NOT the ~60m access exp)', async () => {
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
    expect(setOf('home_refresh_token')?.opts.maxAge).toBe(REFRESH_SECS);
    expect(setOf('refresh_token')?.value).toBe('assumed-refresh');
    expect(setOf('refresh_token')?.opts.maxAge).toBe(REFRESH_SECS);
    // SHIP-BLOCKER guard: home_token must be stashed at 30d, NOT accessCookieMaxAge(~60m) — else the
    // browser drops it after ~60m and Exit can no longer restore the home context. Its maxAge must
    // track its home_refresh_token sibling (30d), even though the stashed VALUE is a ~60m token.
    expect(setOf('home_token')?.opts.maxAge).toBe(REFRESH_SECS);
    expect(setOf('home_token')?.value).toBe(homeAccess);
  });

  it('exitTenantAction restores home refresh_token at 30d', async () => {
    store.set('home_token', jwtWithExp(nowSecs() + ONE_HOUR));
    store.set('home_refresh_token', 'home-refresh');

    const res = await exitTenantAction();

    expect(res).toEqual({ success: true });
    expect(setOf('refresh_token')?.value).toBe('home-refresh');
    expect(setOf('refresh_token')?.opts.maxAge).toBe(REFRESH_SECS);
  });

  it('exitTenantAction — fast path with NO home_refresh stashed drops the assumed refresh (prevents silent re-assume)', async () => {
    store.set('home_token', jwtWithExp(nowSecs() + ONE_HOUR));
    // no home_refresh_token stashed; the live refresh_token is still the ASSUMED tenant's
    store.set('refresh_token', 'assumed-refresh');

    const res = await exitTenantAction();

    expect(res).toEqual({ success: true });
    // leaving the assumed refresh would let the proxy silent-refresh roll the tenant scope forward
    // and re-drop the operator into the tenant — it must be deleted.
    expect(deleted).toContain('refresh_token');
    expect(deleted).toContain('home_token');
  });

  it('exitTenantAction restores home context even when the home ACCESS token has EXPIRED (the ship-blocker regression)', async () => {
    // Simulates >60m of assumed work: the home ACCESS token value is expired, but the home_token
    // COOKIE is still present (it is now stashed at 30d maxAge, so the browser still holds it).
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
    expect(setOf('refresh_token')?.opts.maxAge).toBe(REFRESH_SECS);
    // The stash is consumed, not orphaned: BOTH home_token and home_refresh_token are deleted.
    expect(deleted).toContain('home_token');
    expect(deleted).toContain('home_refresh_token');
  });

  it('exitTenantAction — NO stash → authoritative backend exit sets fresh un-assumed cookies (#51 strand fix)', async () => {
    // The strand: no home_token stash at all (so the fast path is skipped) — old code no-opped and
    // left the assumed token in place. The fallback must exit authoritatively via the backend.
    store.set('token', 'assumed-token');
    store.set('refresh_token', 'assumed-refresh');
    const homeExp = nowSecs() + REFRESH_SECS;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      // full interceptor envelope, so the test pins the real {success,data} contract.
      json: () => Promise.resolve({ success: true, data: { accessToken: jwtWithExp(homeExp), refreshToken: 'home-new', clientId: 'gifsy' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await exitTenantAction();

    expect(res).toEqual({ success: true });
    // hit the authoritative backend endpoint with the (assumed) bearer token
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/auth/exit-tenant'),
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer assumed-token' }) }),
    );
    // fresh un-assumed home session written
    expect(setOf('token')?.value).toBe(jwtWithExp(homeExp));
    expect(setOf('refresh_token')?.value).toBe('home-new');
    expect(setOf('refresh_token')?.opts.maxAge).toBe(REFRESH_SECS);
  });

  it('exitTenantAction — fallback success with NO refresh in the response drops the stale assumed refresh (no re-assume)', async () => {
    store.set('token', 'assumed-token');
    store.set('refresh_token', 'assumed-refresh'); // the ASSUMED refresh — must NOT survive exit
    const homeExp = nowSecs() + REFRESH_SECS;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { accessToken: jwtWithExp(homeExp), clientId: 'gifsy' } }), // no refreshToken
    }));

    const res = await exitTenantAction();

    expect(res).toEqual({ success: true });
    expect(setOf('token')?.value).toBe(jwtWithExp(homeExp));
    // the leftover assumed refresh cookie is dropped rather than left to roll the tenant scope forward
    expect(deleted).toContain('refresh_token');
  });

  it('exitTenantAction — NO stash, backend 401 (assumed token dead) → CLEARS the session (clean re-login)', async () => {
    store.set('token', 'assumed-token');
    store.set('refresh_token', 'assumed-refresh');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({ error: 'unauthorized' }) }));

    const res = await exitTenantAction();

    expect(res).toEqual({ success: false });
    // definitively-invalid token → cleared so the next navigation bounces to a clean login
    expect(deleted).toContain('token');
    expect(deleted).toContain('refresh_token');
  });

  it('exitTenantAction — NO stash, TRANSIENT failure (network/5xx) → KEEPS cookies (retryable, not a forced logout)', async () => {
    store.set('token', 'assumed-token');
    store.set('refresh_token', 'assumed-refresh');
    // a network throw is the transient case
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const res = await exitTenantAction();

    expect(res).toEqual({ success: false });
    // a healthy session must NOT be evicted by a blip — cookies intact so Exit is retryable
    expect(deleted).not.toContain('token');
    expect(deleted).not.toContain('refresh_token');
    expect(store.get('token')).toBe('assumed-token');
  });

  it('exitTenantAction — NO stash + NO token at all → clears any residual stash', async () => {
    // nothing to preserve
    vi.stubGlobal('fetch', vi.fn());
    const res = await exitTenantAction();
    expect(res).toEqual({ success: false });
    expect(deleted).toContain('token');
  });
});
