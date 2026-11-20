/// <reference types="vitest/globals" />
/**
 * Unit tests for the Next.js edge proxy (`src/proxy.ts`).
 *
 * The proxy does tenant resolution (Step 1) + JWT auth / role-route gating (Step 2).
 * We mock its three collaborators (tenant-resolution, tenant-routing-cache, jose)
 * and drive `proxy(request, event)` directly, then assert on the returned
 * NextResponse.
 *
 * How Next encodes results (verified against next@16.2.6 source):
 *  - NextResponse.next({request:{headers}})  → status 200, `x-middleware-next: 1`,
 *    and each forwarded REQUEST header as a response header
 *    `x-middleware-request-<lowercased-name>` (+ `x-middleware-override-headers`).
 *  - NextResponse.rewrite(url,{request:{headers}}) → `x-middleware-rewrite: <url>`
 *    plus the same forwarded-request encoding.
 *  - NextResponse.redirect(url) → status 307, `location: <url>`.
 *  - NextResponse.json(body,{status}) → that status + JSON body.
 * `resolveTrustedHost` (pure) is left real; the hostname it yields is irrelevant
 * because `resolveTenantSync` is mocked to return whatever the test needs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextFetchEvent } from 'next/server';

// ── Mocks (must be declared before importing the module under test) ───────────
vi.mock('jose', () => ({ jwtVerify: vi.fn() }));
vi.mock('@/lib/platform/tenant-resolution', () => ({ resolveTenantSync: vi.fn() }));
vi.mock('@/lib/platform/tenant-routing-cache', () => ({
  ensureWarm: vi.fn(() => Promise.resolve()),
  refreshIfStale: vi.fn(() => Promise.resolve()),
}));
// Only the backend fetch is mocked; the pure cookie/maxAge helpers stay real so the
// silent-refresh path exercises the actual cookie-option shape.
vi.mock('@/lib/auth-refresh', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/auth-refresh')>();
  return { ...actual, refreshTokensViaBackend: vi.fn() };
});

import { NextRequest } from 'next/server';
import { proxy, config as proxyConfig } from '@/proxy';
import { resolveTenantSync } from '@/lib/platform/tenant-resolution';
import { jwtVerify } from 'jose';
import { refreshTokensViaBackend } from '@/lib/auth-refresh';

const mockResolve = vi.mocked(resolveTenantSync);
const mockJwt = vi.mocked(jwtVerify);
const mockRefresh = vi.mocked(refreshTokensViaBackend);
const DEAD = { kind: 'dead' as const, status: 401 };
const TRANSIENT = { kind: 'transient' as const, reason: 'server' as const };

const VALID_TENANT = {
  slug: 'deoleo',
  config: { slug: 'deoleo', internalName: 'Deoleo' } as never,
};

/** Build a NextRequest for a path, with optional cookies / headers / host / method. */
function makeReq(
  pathname: string,
  opts: {
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
    host?: string;
    method?: string;
  } = {},
): NextRequest {
  const host = opts.host ?? 'deoleoloyalty.gifsy.in';
  const h = new Headers(opts.headers ?? {});
  if (opts.cookies) {
    h.set(
      'cookie',
      Object.entries(opts.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    );
  }
  return new NextRequest(`https://${host}${pathname}`, {
    headers: h,
    method: opts.method ?? 'GET',
  });
}

/** A fake NextFetchEvent whose waitUntil is a spy. */
function makeEvent(): NextFetchEvent {
  return { waitUntil: vi.fn() } as unknown as NextFetchEvent;
}

/** Read a FORWARDED request header off a next()/rewrite response. */
function fwd(res: Response, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name.toLowerCase()}`);
}

/** Is this a NextResponse.next() passthrough? */
function isNext(res: Response): boolean {
  return res.headers.get('x-middleware-next') === '1';
}

const run = (req: NextRequest) => proxy(req, makeEvent());

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockReturnValue(VALID_TENANT);
  delete process.env.DEMO_MODE;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('proxy — Step 1: tenant resolution', () => {
  // A `.webmanifest` path is the cleanest window onto the forwarded tenant
  // headers: it returns next() right after Step 1 with no auth, so the tenant
  // headers survive as forwarded request headers.
  const MANIFEST = '/sales/manifest.webmanifest';

  it('valid tenant → x-tenant-slug=slug, x-tenant-valid=true (forwarded)', async () => {
    mockResolve.mockReturnValue(VALID_TENANT);
    const res = await run(makeReq(MANIFEST));
    expect(isNext(res)).toBe(true);
    expect(fwd(res, 'x-tenant-slug')).toBe('deoleo');
    expect(fwd(res, 'x-tenant-valid')).toBe('true');
  });

  it('slug === null (bare domain) → x-tenant-slug="" + valid=false', async () => {
    mockResolve.mockReturnValue({ slug: null, config: null });
    const res = await run(makeReq(MANIFEST));
    expect(isNext(res)).toBe(true);
    expect(fwd(res, 'x-tenant-slug')).toBe('');
    expect(fwd(res, 'x-tenant-valid')).toBe('false');
  });

  it('slug === "gifsy" with no config → passthrough (slug=gifsy, valid=false), NOT 404', async () => {
    mockResolve.mockReturnValue({ slug: 'gifsy', config: null });
    const res = await run(makeReq(MANIFEST));
    expect(isNext(res)).toBe(true);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull(); // not a /not-found rewrite
    expect(fwd(res, 'x-tenant-slug')).toBe('gifsy');
    expect(fwd(res, 'x-tenant-valid')).toBe('false');
  });

  it('unknown slug with no config → rewrite to /not-found + valid=false', async () => {
    mockResolve.mockReturnValue({ slug: 'nope', config: null });
    const res = await run(makeReq('/admin'));
    const rewrite = res.headers.get('x-middleware-rewrite');
    expect(rewrite).not.toBeNull();
    expect(new URL(rewrite as string).pathname).toBe('/not-found');
    // For the rewrite branch these two are set on the RESPONSE headers directly.
    expect(res.headers.get('x-tenant-slug')).toBe('nope');
    expect(res.headers.get('x-tenant-valid')).toBe('false');
  });

  // ── Internal-header spoofing: ONLY the proxy may set the headers render code trusts ──
  const SPOOF = {
    'x-tenant-slug': 'bajaj',
    'x-tenant-valid': 'true',
    'x-tenant-color': '#ff0000',
    'x-tenant-name': 'Evil',
    'x-user-id': 'attacker',
    'x-user-role': 'GIFSY_ADMIN',
    'x-partner-id': 'p-evil',
    'x-pathname': '/sales/evil',
  };
  /** Header names Next will apply to the forwarded request (absent → header removed). */
  const overridden = (res: Response) =>
    (res.headers.get('x-middleware-override-headers') ?? '').split(',').map((h) => h.trim());

  it('a client-sent x-tenant-slug (and every other internal header) is replaced by the proxy own values', async () => {
    mockResolve.mockReturnValue(VALID_TENANT);
    const res = await run(makeReq(MANIFEST, { headers: SPOOF }));
    expect(fwd(res, 'x-tenant-slug')).toBe('deoleo');
    expect(fwd(res, 'x-tenant-valid')).toBe('true');
    expect(fwd(res, 'x-pathname')).toBe(MANIFEST);
    for (const h of ['x-tenant-color', 'x-tenant-name', 'x-user-id', 'x-user-role', 'x-partner-id']) {
      expect(fwd(res, h)).toBeNull();
      expect(overridden(res)).not.toContain(h);
    }
  });

  it('unknown-host 404 rewrite: a spoofed x-tenant-slug is NOT forwarded to the render', async () => {
    mockResolve.mockReturnValue({ slug: 'nope', config: null });
    const res = await run(makeReq('/admin', { headers: SPOOF }));
    expect(new URL(res.headers.get('x-middleware-rewrite') as string).pathname).toBe('/not-found');
    for (const h of ['x-tenant-slug', 'x-tenant-valid', 'x-user-id', 'x-user-role', 'x-partner-id']) {
      expect(fwd(res, h)).toBeNull();
      expect(overridden(res)).not.toContain(h);
    }
  });

  // curl -H 'x-tenant-slug: deoleo' https://unknown.gifsy.in/ → /not-found with NO tenant slug
  // forwarded, so getTenantConfig() renders DEFAULT_CLIENT_CONFIG (not Deoleo's branding).
  it("unknown host + client 'x-tenant-slug: deoleo' → /not-found, no slug/valid forwarded", async () => {
    mockResolve.mockReturnValue({ slug: 'unknown', config: null });
    const res = await run(
      makeReq('/auth/login', { host: 'unknown.gifsy.in', headers: { 'x-tenant-slug': 'deoleo', 'x-tenant-valid': 'true' } }),
    );
    expect(new URL(res.headers.get('x-middleware-rewrite') as string).pathname).toBe('/not-found');
    expect(fwd(res, 'x-tenant-slug')).toBeNull();
    expect(fwd(res, 'x-tenant-valid')).toBeNull();
    expect(overridden(res)).not.toContain('x-tenant-slug');
    expect(overridden(res)).not.toContain('x-tenant-valid');
  });

  it('bare domain: a spoofed x-tenant-slug is overwritten with ""', async () => {
    mockResolve.mockReturnValue({ slug: null, config: null });
    const res = await run(makeReq(MANIFEST, { headers: SPOOF }));
    expect(fwd(res, 'x-tenant-slug')).toBe('');
    expect(fwd(res, 'x-tenant-valid')).toBe('false');
  });

  it('public (pre-auth) paths never forward client-sent identity headers', async () => {
    const res = await run(makeReq('/auth/login', { headers: SPOOF }));
    expect(isNext(res)).toBe(true);
    for (const h of ['x-user-id', 'x-user-role', 'x-partner-id']) {
      expect(fwd(res, h)).toBeNull();
      expect(overridden(res)).not.toContain(h);
    }
  });

  it('forwards x-pathname so the root layout can gate PWA <head>', async () => {
    const res = await run(makeReq(MANIFEST));
    expect(fwd(res, 'x-pathname')).toBe(MANIFEST);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('proxy — Step 2: passthroughs before auth', () => {
  it('.webmanifest passes through WITHOUT auth (no cookie, no redirect)', async () => {
    const res = await run(makeReq('/partner/manifest.webmanifest'));
    expect(isNext(res)).toBe(true);
    expect(res.status).toBe(200);
    // auth never ran → no injected identity headers
    expect(fwd(res, 'x-user-role')).toBeNull();
    expect(fwd(res, 'authorization')).toBeNull();
  });

  it('PUBLIC_PATHS (/auth/login) passes through without auth', async () => {
    const res = await run(makeReq('/auth/login'));
    expect(isNext(res)).toBe(true);
    expect(fwd(res, 'x-user-role')).toBeNull();
  });

  it('PUBLIC_PATHS (/api/auth/send-otp) passes through without auth', async () => {
    const res = await run(makeReq('/api/auth/send-otp', { method: 'POST' }));
    expect(isNext(res)).toBe(true);
  });

  // Tokenized media/document view endpoints are @Public at the backend (the signed query
  // token is the sole authority) and are opened from a DOWNLOADED .xlsx with NO session
  // cookie — the edge auth gate must let them through, else every report image/doc link 401s.
  it('PUBLIC_PATHS (/api/schemes/media/view) passes through without a token cookie', async () => {
    const res = await run(makeReq('/api/schemes/media/view?token=t'));
    expect(isNext(res)).toBe(true);
    expect(res.status).not.toBe(401);
    // auth never ran → no injected Bearer (the query token is the authority, not the cookie)
    expect(fwd(res, 'authorization')).toBeNull();
  });

  it('PUBLIC_PATHS (/api/kyc/documents/view) passes through without a token cookie', async () => {
    const res = await run(makeReq('/api/kyc/documents/view?token=t'));
    expect(isNext(res)).toBe(true);
    expect(res.status).not.toBe(401);
    expect(fwd(res, 'authorization')).toBeNull();
  });

  // Guard against an over-broad startsWith: the LIST/other kyc-documents routes must STILL
  // require auth — only the exact `/documents/view` public leaf is exempt.
  it('/api/kyc/documents (list, no /view) is NOT public → 401 without a token', async () => {
    const res = await run(makeReq('/api/kyc/documents'));
    expect(res.status).toBe(401);
  });

  // Tenant branding images (logo / wordmark / favicon) are rendered on the SIGN-IN page and
  // the browser tab BEFORE login → the backend route is @Public and the edge must not 401 it.
  it('PUBLIC_PATHS (/api/public/branding-assets) passes through without a token cookie', async () => {
    const res = await run(
      makeReq('/api/public/branding-assets?key=branding%2Fbajaj%2F2026-11%2Fx-logo.png'),
    );
    expect(isNext(res)).toBe(true);
    expect(res.status).not.toBe(401);
    expect(fwd(res, 'authorization')).toBeNull();
  });

  // Help & videos: the <video> element's Range requests carry only the signed query token.
  it('PUBLIC_EXACT_PATHS (/api/help/media) passes through without a token cookie; siblings do not', async () => {
    const res = await run(makeReq('/api/help/media?token=t'));
    expect(isNext(res)).toBe(true);
    expect(res.status).not.toBe(401);
    expect(fwd(res, 'authorization')).toBeNull();
    expect((await run(makeReq('/api/help/media-other'))).status).toBe(401);
    expect((await run(makeReq('/api/help'))).status).toBe(401);
  });

  it('other /api/public/* paths are NOT exempt → 401 without a token', async () => {
    const res = await run(makeReq('/api/public/something-else'));
    expect(res.status).toBe(401);
  });

  it('"/" redirects to /auth/login', async () => {
    const res = await run(makeReq('/'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') as string).pathname).toBe('/auth/login');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('proxy — Step 2: no token', () => {
  it('/api/* with no token → 401 JSON', async () => {
    const res = await run(makeReq('/api/wallet/me'));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ success: false, error: 'Unauthorized' });
  });

  it('a page with no token → redirect to /auth/login', async () => {
    const res = await run(makeReq('/admin'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') as string).pathname).toBe('/auth/login');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('proxy — Step 2: valid token + role gating', () => {
  const withToken = (path: string, extra: Record<string, string> = {}) =>
    makeReq(path, { cookies: { token: 'jwt.abc.def', ...extra } });

  it('allowed role → next() with injected auth headers', async () => {
    mockJwt.mockResolvedValue({ payload: { role: 'GIFSY_ADMIN', sub: 'user-1' } } as never);
    const res = await run(withToken('/admin'));
    expect(isNext(res)).toBe(true);
    expect(fwd(res, 'authorization')).toBe('Bearer jwt.abc.def');
    expect(fwd(res, 'x-user-id')).toBe('user-1');
    expect(fwd(res, 'x-user-role')).toBe('GIFSY_ADMIN');
  });

  it('Usage Report: forwards the client X-Client-Medium + User-Agent headers on /api/* to the backend rewrite', async () => {
    mockJwt.mockResolvedValue({ payload: { role: 'SSS', sub: 'p-1' } } as never);
    const res = await run(
      makeReq('/api/wallet', {
        cookies: { token: 'jwt.abc.def' },
        headers: { 'X-Client-Medium': 'app', 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Mobile' },
      }),
    );
    expect(isNext(res)).toBe(true);
    expect(fwd(res, 'x-client-medium')).toBe('app');
    expect(fwd(res, 'user-agent')).toBe('Mozilla/5.0 (Linux; Android 14) Mobile');
    expect(fwd(res, 'authorization')).toBe('Bearer jwt.abc.def');
  });

  it('injects x-partner-id when the JWT carries partnerId', async () => {
    mockJwt.mockResolvedValue({
      payload: { role: 'SSS', sub: 'p-9', partnerId: 'partner-77' },
    } as never);
    const res = await run(withToken('/partner'));
    expect(isNext(res)).toBe(true);
    expect(fwd(res, 'x-partner-id')).toBe('partner-77');
  });

  it('omits x-partner-id when the JWT has none', async () => {
    mockJwt.mockResolvedValue({ payload: { role: 'GIFSY_ADMIN', sub: 'user-1' } } as never);
    const res = await run(withToken('/admin'));
    expect(fwd(res, 'x-partner-id')).toBeNull();
  });

  it('disallowed role on a page (SALES_SO on /admin) → redirect to /auth/login', async () => {
    mockJwt.mockResolvedValue({ payload: { role: 'SALES_SO', sub: 'so-1' } } as never);
    const res = await run(withToken('/admin'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') as string).pathname).toBe('/auth/login');
  });

  it('GIFSY_ADMIN is allowed on /admin/gifsy', async () => {
    mockJwt.mockResolvedValue({ payload: { role: 'GIFSY_ADMIN', sub: 'g-1' } } as never);
    const res = await run(withToken('/admin/gifsy/settings'));
    expect(isNext(res)).toBe(true);
    expect(fwd(res, 'x-user-role')).toBe('GIFSY_ADMIN');
  });

  it('/admin/gifsy is checked BEFORE /admin: CLIENT_ADMIN (allowed on /admin) is blocked on /admin/gifsy', async () => {
    // Proves the ROLE_ROUTES ordering — if /admin matched first, CLIENT_ADMIN
    // would pass. The gifsy-specific prefix must intercept it.
    mockJwt.mockResolvedValue({ payload: { role: 'CLIENT_ADMIN', sub: 'ca-1' } } as never);
    const res = await run(withToken('/admin/gifsy'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') as string).pathname).toBe('/auth/login');
  });

  it('CLIENT_ADMIN IS allowed on a plain /admin page', async () => {
    mockJwt.mockResolvedValue({ payload: { role: 'CLIENT_ADMIN', sub: 'ca-1' } } as never);
    const res = await run(withToken('/admin/users'));
    expect(isNext(res)).toBe(true);
  });

  it('a canonical sales role (SALES_SO) is allowed on /sales', async () => {
    mockJwt.mockResolvedValue({ payload: { role: 'SALES_SO', sub: 'so-1' } } as never);
    const res = await run(withToken('/sales/outlets'));
    expect(isNext(res)).toBe(true);
  });

  it('an /api/* request is NOT role-gated by the proxy — it passes through (backend enforces)', async () => {
    // ROLE_ROUTES lists only PAGE prefixes; an /api/* path never matches one (it starts
    // with '/api/'), so an authenticated request passes through with injected auth REGARDLESS
    // of role — the NestJS role guards on the endpoint are the real gate. This documents the
    // removal of the old unreachable /api/* 403 branch; re-adding a broken proxy gate re-fails here.
    mockJwt.mockResolvedValue({ payload: { role: 'SALES_SO', sub: 'so-1' } } as never);
    const res = await run(withToken('/api/admin/users'));
    expect(isNext(res)).toBe(true);
    expect(fwd(res, 'authorization')).toBe('Bearer jwt.abc.def');
    expect(fwd(res, 'x-user-role')).toBe('SALES_SO');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('proxy — Step 2: invalid / expired token', () => {
  beforeEach(() => {
    mockJwt.mockRejectedValue(new Error('signature verification failed'));
  });

  it('/api/* with a bad token → 401 JSON "Invalid token"', async () => {
    const res = await run(makeReq('/api/wallet/me', { cookies: { token: 'bad' } }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ success: false, error: 'Invalid token' });
  });

  it('a page with a bad token → redirect to /auth/login', async () => {
    const res = await run(makeReq('/admin', { cookies: { token: 'bad' } }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') as string).pathname).toBe('/auth/login');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('proxy — DEMO_MODE auth bypass', () => {
  afterEach(() => {
    delete process.env.DEMO_MODE;
  });

  it('DEMO_MODE=true injects a GIFSY_ADMIN identity and skips JWT entirely', async () => {
    process.env.DEMO_MODE = 'true';
    // No cookie, and jwtVerify must never be consulted.
    const res = await run(makeReq('/admin'));
    expect(isNext(res)).toBe(true);
    expect(fwd(res, 'x-user-id')).toBe('demo-admin-id');
    expect(fwd(res, 'x-user-role')).toBe('GIFSY_ADMIN');
    expect(mockJwt).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server-side silent refresh on FULL PAGE navigation.
//
// The access token is now short-lived (~60m). When it expires the browser DROPS the
// `token` cookie (maxAge tracks the JWT exp), so a hard reload arrives with NO access
// token but a still-valid 7d `refresh_token` cookie. The proxy must silently refresh
// against the backend and CONTINUE the navigation instead of bouncing to login.
describe('proxy — page-nav silent refresh (expired/absent access + valid refresh)', () => {
  it('absent access + valid refresh → refreshes, forwards new Bearer, sets rotated cookies, NO redirect', async () => {
    mockRefresh.mockResolvedValue({ kind: 'ok', accessToken: 'new.jwt.tok', refreshToken: 'r-new' });
    // The refreshed access token verifies to a valid identity.
    mockJwt.mockResolvedValue({ payload: { role: 'CLIENT_ADMIN', sub: 'u-1' } } as never);

    const res = await run(makeReq('/admin/users', { cookies: { refresh_token: 'r-valid' } }));

    expect(mockRefresh).toHaveBeenCalledWith('r-valid', expect.any(Object));
    expect(isNext(res)).toBe(true); // continued the navigation
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(fwd(res, 'authorization')).toBe('Bearer new.jwt.tok');
    expect(fwd(res, 'x-user-role')).toBe('CLIENT_ADMIN');
    // Rotated pair persisted on the outgoing response.
    expect(res.cookies.get('token')?.value).toBe('new.jwt.tok');
    expect(res.cookies.get('refresh_token')?.value).toBe('r-new');
  });

  it('EXPIRED access (verify throws) + valid refresh → refreshes and continues (no login bounce)', async () => {
    // 1st jwtVerify (the expired cookie token) throws; 2nd (the refreshed token) succeeds.
    mockJwt
      .mockRejectedValueOnce(new Error('exp'))
      .mockResolvedValueOnce({ payload: { role: 'GIFSY_ADMIN', sub: 'g-1' } } as never);
    mockRefresh.mockResolvedValue({ kind: 'ok', accessToken: 'fresh.jwt.tok', refreshToken: 'r-rotated' });

    const res = await run(
      makeReq('/admin', { cookies: { token: 'expired.jwt.tok', refresh_token: 'r-valid' } }),
    );

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(isNext(res)).toBe(true);
    expect(res.status).not.toBe(307);
    expect(fwd(res, 'authorization')).toBe('Bearer fresh.jwt.tok');
    expect(res.cookies.get('token')?.value).toBe('fresh.jwt.tok');
  });

  it('expired access + DEAD refresh (backend 401) → NO retry (B3), redirect to /auth/login?expired=1', async () => {
    mockJwt.mockRejectedValue(new Error('exp'));
    mockRefresh.mockResolvedValue(DEAD); // refresh token truly dead

    const res = await run(
      makeReq('/admin', { cookies: { token: 'expired.jwt.tok', refresh_token: 'r-dead' } }),
    );

    expect(mockRefresh).toHaveBeenCalledTimes(1); // a definite refusal is never retried
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.pathname).toBe('/auth/login');
    expect(loc.searchParams.get('expired')).toBe('1');
    // Must NOT wipe the refresh cookie on a (possibly transient) failure.
    expect(res.cookies.get('refresh_token')?.value).toBeUndefined();
  });

  it('a failed refresh does NOT expose new cookies (good cookie is never overwritten with empties)', async () => {
    mockJwt.mockRejectedValue(new Error('exp'));
    mockRefresh.mockResolvedValue(DEAD);

    const res = await run(
      makeReq('/sales/outlets', { cookies: { token: 'expired', refresh_token: 'r-dead' } }),
    );

    expect(res.status).toBe(307);
    expect(res.cookies.get('token')?.value).toBeUndefined();
  });

  it('page with NO token and NO refresh cookie → plain /auth/login (not ?expired=1, never logged in)', async () => {
    const res = await run(makeReq('/admin'));
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.pathname).toBe('/auth/login');
    expect(loc.searchParams.get('expired')).toBeNull();
  });

  it('a signed-out deep link (ticket email) survives login: ?next=<path+query>, same-origin relative only', async () => {
    const doc = { 'sec-fetch-dest': 'document', accept: 'text/html' };
    const res = await run(makeReq('/admin/tickets?ticket=t1', { headers: doc }));
    const loc = new URL(res.headers.get('location') as string);
    expect(loc.pathname).toBe('/auth/login');
    expect(loc.searchParams.get('next')).toBe('/admin/tickets?ticket=t1');
    // expired-session bounce keeps it too
    mockJwt.mockRejectedValue(new Error('exp'));
    mockRefresh.mockResolvedValue(DEAD);
    const res2 = await run(makeReq('/admin/tickets?ticket=t1', { headers: doc, cookies: { token: 'x', refresh_token: 'dead' } }));
    const loc2 = new URL(res2.headers.get('location') as string);
    expect(loc2.searchParams.get('expired')).toBe('1');
    expect(loc2.searchParams.get('next')).toBe('/admin/tickets?ticket=t1');
  });

  it('RSC / prefetch / non-document requests never get a `next` (and `_rsc` is stripped)', async () => {
    for (const headers of <Record<string, string>[]>[
      { rsc: '1' },
      { 'next-router-prefetch': '1', rsc: '1' },
      { 'sec-fetch-dest': 'empty' },
      { purpose: 'prefetch', 'sec-fetch-dest': 'document' },
    ]) {
      const res = await run(makeReq('/admin/tickets?ticket=t1&_rsc=abc', { headers }));
      const loc = new URL(res.headers.get('location') as string);
      expect(loc.pathname).toBe('/auth/login');
      expect(loc.searchParams.get('next')).toBeNull();
    }
    const res = await run(makeReq('/admin/tickets?ticket=t1&_rsc=abc', { headers: { 'sec-fetch-dest': 'document' } }));
    expect(new URL(res.headers.get('location') as string).searchParams.get('next')).toBe('/admin/tickets?ticket=t1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent-refresh race (prod 2026-11-19): a cold page load fans out into many parallel
// proxy hits after the 60m access token expired. A sub-request whose refresh fails must NOT
// bounce a valid session to login; a document retries once; concurrent hits share one refresh.
describe('proxy — refresh failure handling by request kind + dedupe', () => {
  const expiredWithRefresh = (path: string, headers: Record<string, string> = {}, refresh = 'r-1') =>
    makeReq(path, { cookies: { token: 'expired', refresh_token: refresh }, headers });

  beforeEach(() => {
    mockJwt.mockRejectedValue(new Error('exp'));
    mockRefresh.mockResolvedValue(DEAD);
  });

  it.each([
    ['RSC payload fetch', { rsc: '1' }],
    ['router prefetch', { rsc: '1', 'next-router-prefetch': '1' }],
    ['browser prefetch (Sec-Purpose)', { 'sec-purpose': 'prefetch', 'sec-fetch-dest': 'document' }],
    ['image sub-resource', { 'sec-fetch-dest': 'image' }],
    ['script sub-resource', { 'sec-fetch-dest': 'script' }],
    ['fetch()/XHR (dest=empty)', { 'sec-fetch-dest': 'empty' }],
  ])('%s with a failed refresh → 401 no-store, NO login redirect, NO retry, cookies untouched', async (_l, headers) => {
    const res = await run(expiredWithRefresh('/admin/users', headers));
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(res.cookies.get('token')?.value).toBeUndefined();
    expect(res.cookies.get('refresh_token')?.value).toBeUndefined();
  });

  it('an RSC fetch whose refresh SUCCEEDS still continues with rotated cookies', async () => {
    mockJwt
      .mockRejectedValueOnce(new Error('exp'))
      .mockResolvedValueOnce({ payload: { role: 'CLIENT_ADMIN', sub: 'u-1' } } as never);
    mockRefresh.mockResolvedValue({ kind: 'ok', accessToken: 'new.jwt', refreshToken: 'r-2' });
    const res = await run(expiredWithRefresh('/admin/users', { rsc: '1' }));
    expect(isNext(res)).toBe(true);
    expect(res.cookies.get('refresh_token')?.value).toBe('r-2');
  });

  it('C2: document TRANSIENT refresh failure → waits, retries ONCE, then the RECONNECTING page (503) — never the login page', async () => {
    mockRefresh.mockResolvedValue(TRANSIENT);
    // Fake ONLY setTimeout (the retry pause); the token hash (crypto.subtle) stays real.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const p = run(expiredWithRefresh('/admin', { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }));
      for (let i = 0; i < 50 && mockRefresh.mock.calls.length === 0; i++) {
        await new Promise((r) => setImmediate(r));
      }
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      expect(mockRefresh).toHaveBeenCalledTimes(1); // retry is NOT immediate
      await vi.advanceTimersByTimeAsync(200);
      const res = await p;
      expect(mockRefresh).toHaveBeenCalledTimes(2);
      expect(res.status).toBe(503);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const html = await res.text();
      expect(html).toMatch(/Reconnecting/);
      expect(html).toMatch(/still signed in/);
      expect(html).toMatch(/location\.reload\(\)/); // retries THIS url
      // never navigates to login by itself: only an initially HIDDEN "Sign in again" link (shown after ~2 min)
      expect(html).toMatch(/<a id="signin" href="\/auth\/login" hidden>Sign in again<\/a>/);
      expect(html).not.toMatch(/location\.(assign|replace)\(|location\.href\s*=/);
      expect(html).toMatch(/30 \* 60 \* 1000/); // auto-retry stops after 30 min (manual Retry stays)
      // cookies untouched
      expect(res.cookies.get('refresh_token')?.value).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('document: first refresh fails transiently, the retry succeeds → continues (no login bounce)', async () => {
    mockJwt
      .mockRejectedValueOnce(new Error('exp'))
      .mockResolvedValueOnce({ payload: { role: 'CLIENT_ADMIN', sub: 'u-1' } } as never);
    mockRefresh
      .mockResolvedValueOnce(TRANSIENT)
      .mockResolvedValueOnce({ kind: 'ok', accessToken: 'new.jwt', refreshToken: 'r-2' });
    const res = await run(expiredWithRefresh('/admin', { 'sec-fetch-dest': 'document' }));
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(isNext(res)).toBe(true);
    expect(res.cookies.get('token')?.value).toBe('new.jwt');
    expect(res.cookies.get('refresh_token')?.value).toBe('r-2');
  });

  it('dedupe: 10 concurrent hits with the SAME refresh cookie share ONE backend refresh and all get the same pair', async () => {
    let resolveRefresh!: (v: { kind: 'ok'; accessToken: string; refreshToken: string }) => void;
    mockRefresh.mockImplementation(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );
    // Every jwtVerify: the expired cookie token throws; the refreshed one verifies.
    mockJwt.mockImplementation((async (tok: string) => {
      if (tok === 'expired') throw new Error('exp');
      return { payload: { role: 'CLIENT_ADMIN', sub: 'u-1' } };
    }) as never);

    const reqs = Array.from({ length: 10 }, (_, i) =>
      run(expiredWithRefresh(`/admin/users?i=${i}`, i === 0 ? { 'sec-fetch-dest': 'document' } : { rsc: '1' })),
    );
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    resolveRefresh({ kind: 'ok', accessToken: 'shared.jwt', refreshToken: 'r-shared' });
    const results = await Promise.all(reqs);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    for (const res of results) {
      expect(isNext(res)).toBe(true);
      expect(res.cookies.get('refresh_token')?.value).toBe('r-shared');
    }
  });

  it('dedupe is per refresh token: two different refresh cookies make two backend calls', async () => {
    mockRefresh.mockResolvedValue({ kind: 'ok', accessToken: 'a', refreshToken: 'b' });
    mockJwt.mockImplementation((async (tok: string) => {
      if (tok === 'expired') throw new Error('exp');
      return { payload: { role: 'CLIENT_ADMIN', sub: 'u-1' } };
    }) as never);
    await Promise.all([
      run(expiredWithRefresh('/admin', { rsc: '1' }, 'r-A')),
      run(expiredWithRefresh('/admin', { rsc: '1' }, 'r-B')),
    ]);
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(mockRefresh).toHaveBeenCalledWith('r-A', expect.any(Object));
    expect(mockRefresh).toHaveBeenCalledWith('r-B', expect.any(Object));
  });

  it('dedupe does not outlive the burst: a later refresh with the same token makes a fresh call', async () => {
    mockRefresh.mockResolvedValue(DEAD);
    await run(expiredWithRefresh('/admin', { rsc: '1' }));
    await run(expiredWithRefresh('/admin', { rsc: '1' }));
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  // ── B3: retry only what is retryable ──
  it('B3: document + DEFINITE refusal (dead) → NO retry, straight to /auth/login?expired=1', async () => {
    mockRefresh.mockResolvedValue(DEAD);
    const res = await run(expiredWithRefresh('/admin', { 'sec-fetch-dest': 'document' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') as string).searchParams.get('expired')).toBe('1');
  });

  it('B3: non-document + TRANSIENT failure → 503 no-store (retryable), not 401, no redirect, no retry', async () => {
    mockRefresh.mockResolvedValue(TRANSIENT);
    const res = await run(expiredWithRefresh('/admin/users', { rsc: '1' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('location')).toBeNull();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('B3: a refreshed access token that fails verification counts as DEAD (no retry)', async () => {
    mockRefresh.mockResolvedValue({ kind: 'ok', accessToken: 'unverifiable', refreshToken: 'r-2' });
    mockJwt.mockRejectedValue(new Error('bad signature'));
    const res = await run(expiredWithRefresh('/admin', { 'sec-fetch-dest': 'document' }));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(307);
    expect(res.cookies.get('refresh_token')?.value).toBeUndefined();
  });

  // ── B4: no Sec-Fetch-Dest = still a document, but static-asset paths never get the retry ──
  it.each(['/Brand/deoleo.png', '/guides/tds/194r-report.png', '/some/file.svg', '/manifest.json'])(
    'B4: %s with NO Sec-Fetch-Dest + transient failure → treated as a document (reconnect page) but NOT retried',
    async (path) => {
      mockRefresh.mockResolvedValue(TRANSIENT);
      const res = await run(expiredWithRefresh(path));
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(503);
    },
  );

  it('B4: a page path with NO Sec-Fetch-Dest keeps the document retry', async () => {
    mockRefresh.mockResolvedValueOnce(TRANSIENT).mockResolvedValueOnce(TRANSIENT);
    await run(expiredWithRefresh('/admin/users'));
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  // ── B1: mark the forwarded request so refreshSession does not rotate a second time ──
  it('B1: a successful proxy refresh marks the FORWARDED request with x-session-refreshed: 1', async () => {
    mockJwt
      .mockRejectedValueOnce(new Error('exp'))
      .mockResolvedValueOnce({ payload: { role: 'CLIENT_ADMIN', sub: 'u-1' } } as never);
    mockRefresh.mockResolvedValue({ kind: 'ok', accessToken: 'new.jwt', refreshToken: 'r-2' });
    const res = await run(expiredWithRefresh('/admin/users', { 'next-action': 'refreshSessionId' }));
    expect(isNext(res)).toBe(true);
    expect(fwd(res, 'x-session-refreshed')).toBe('1');
  });

  it('C2: a DEAD document refresh still goes to /auth/login?expired=1 (only dead ever logs out)', async () => {
    mockRefresh.mockResolvedValue(DEAD);
    const res = await run(expiredWithRefresh('/admin', { 'sec-fetch-dest': 'document' }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') as string).searchParams.get('expired')).toBe('1');
  });

  it('H1: session 401s from the proxy carry x-auth-failure: session (the guard ignores unmarked 401s)', async () => {
    const api = await run(makeReq('/api/wallet/me', { cookies: { token: 'expired', refresh_token: 'r' } }));
    expect(api.status).toBe(401);
    expect(api.headers.get('x-auth-failure')).toBe('session');
    mockRefresh.mockResolvedValue(DEAD);
    const rsc = await run(expiredWithRefresh('/admin/users', { rsc: '1' }));
    expect(rsc.status).toBe(401);
    expect(rsc.headers.get('x-auth-failure')).toBe('session');
  });

  it('S-H1a: the browser User-Agent + UA client hints are forwarded to the refresh (device fingerprint)', async () => {
    mockRefresh.mockResolvedValue(DEAD);
    await run(expiredWithRefresh('/admin', {
      'sec-fetch-dest': 'document',
      'user-agent': 'Mozilla/5.0 (Linux; Android 14) Mobile Chrome/131',
      'sec-ch-ua-platform': '"Android"',
      'sec-ch-ua-mobile': '?1',
    }));
    expect(mockRefresh).toHaveBeenCalledWith('r-1', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile Chrome/131',
      platform: '"Android"',
      mobile: '?1',
    });
  });

  it('dedupe never shares a result across DEVICES: same token, two User-Agents → two backend calls', async () => {
    mockRefresh.mockResolvedValue({ kind: 'ok', accessToken: 'a', refreshToken: 'b' });
    mockJwt.mockImplementation((async (tok: string) => {
      if (tok === 'expired') throw new Error('exp');
      return { payload: { role: 'CLIENT_ADMIN', sub: 'u-1' } };
    }) as never);
    await Promise.all([
      run(expiredWithRefresh('/admin', { rsc: '1', 'user-agent': 'phone' })),
      run(expiredWithRefresh('/admin', { rsc: '1', 'user-agent': 'laptop' })),
    ]);
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  // S1/M3 (2026-11-20): NO unauthenticated pass-through for server actions any more.
  it.each([
    ['POST', 'dead', DEAD, 401],
    ['POST', 'transient', TRANSIENT, 503],
    ['GET', 'dead', DEAD, 401],
    ['GET', 'transient', TRANSIENT, 503],
  ])('S1: %s + Next-Action whose refresh failed (%s) → %i, never next() / a rendered page / identity headers', async (method, _k, outcome, status) => {
    mockRefresh.mockResolvedValue(outcome);
    const req = makeReq('/admin/users', {
      method: method as string,
      cookies: { token: 'expired', refresh_token: 'garbage' },
      headers: { 'next-action': 'x' },
    });
    const res = await run(req);
    expect(res.status).toBe(status);
    expect(isNext(res)).toBe(false);
    expect(fwd(res, 'authorization')).toBeNull();
    expect(fwd(res, 'x-user-id')).toBeNull();
  });

  it('S1: /auth/session-refresh (the guard endpoint) is a PUBLIC exact path — reaches its handler without an access token', async () => {
    const res = await run(makeReq('/auth/session-refresh', { method: 'POST', cookies: { refresh_token: 'r' } }));
    expect(isNext(res)).toBe(true);
    expect(mockRefresh).not.toHaveBeenCalled(); // the edge does NOT refresh for it; the handler does
    expect(fwd(res, 'authorization')).toBeNull();
    // …but only that exact path
    const sib = await run(makeReq('/auth/session-refresh-x'));
    expect(sib.status).toBe(307);
  });

  it('security: client-sent server-to-server headers are STRIPPED before the /api rewrite (x-gifsy-no-first-use, x-client-*, secret)', async () => {
    mockJwt.mockResolvedValue({ payload: { role: 'CLIENT_ADMIN', sub: 'u-1' } } as never);
    const res = await run(makeReq('/api/wallet/me', {
      cookies: { token: 'valid' },
      headers: {
        'x-gifsy-no-first-use': '1',
        'x-internal-proxy-secret': 'guess',
        'x-client-user-agent': 'forged',
        'x-client-ua-platform': '"forged"',
        'x-client-ua-mobile': '?1',
      },
    }));
    expect(isNext(res)).toBe(true);
    for (const h of ['x-gifsy-no-first-use', 'x-internal-proxy-secret', 'x-client-user-agent', 'x-client-ua-platform', 'x-client-ua-mobile']) {
      expect(fwd(res, h)).toBeNull();
    }
  });

  it('B1: a CLIENT-sent x-session-refreshed is stripped (cannot fake a proxy rotation)', async () => {
    mockJwt.mockResolvedValue({ payload: { role: 'CLIENT_ADMIN', sub: 'u-1' } } as never);
    const res = await run(makeReq('/admin/users', { cookies: { token: 'valid' }, headers: { 'x-session-refreshed': '1' } }));
    expect(isNext(res)).toBe(true);
    expect(fwd(res, 'x-session-refreshed')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The XHR path is UNCHANGED: /api/* still 401s so SessionExpiryGuard drives the
// client-side refresh+retry. The proxy must NOT server-refresh an /api/* request.
describe('proxy — /api/* keeps 401ing (XHR SessionExpiryGuard path unchanged)', () => {
  it('/api/* with EXPIRED token + valid refresh → 401 "Invalid token", NO server refresh', async () => {
    mockJwt.mockRejectedValue(new Error('exp'));
    const res = await run(
      makeReq('/api/wallet/me', { cookies: { token: 'expired', refresh_token: 'r-valid' } }),
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ success: false, error: 'Invalid token' });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('/api/* with NO token but a refresh cookie → 401 "Unauthorized", NO server refresh', async () => {
    const res = await run(makeReq('/api/wallet/me', { cookies: { refresh_token: 'r-valid' } }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ success: false, error: 'Unauthorized' });
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('proxy — matcher static exclusions', () => {
  // The matcher is a single negative-lookahead path regex; compile it the same way to check
  // which static paths bypass the proxy (and so load pre-auth on the sign-in page).
  const re = new RegExp(`^${proxyConfig.matcher[0]}$`);

  it('public/Logos/* (the actual committed folder, capital L) bypasses the proxy like brand/', () => {
    expect(re.test('/Logos/bajaj.png')).toBe(false);
    expect(re.test('/Logos/deoleo.png')).toBe(false);
    expect(re.test('/logos/deoleo.svg')).toBe(false);
    expect(re.test('/brand/deoleo-wordmark-white.png')).toBe(false);
  });

  it('app routes (incl. the public branding-asset API) still run through the proxy', () => {
    expect(re.test('/auth/login')).toBe(true);
    expect(re.test('/admin/dashboard')).toBe(true);
    expect(re.test('/api/public/branding-assets')).toBe(true);
    expect(re.test('/LogosEvil')).toBe(true);
  });
});

