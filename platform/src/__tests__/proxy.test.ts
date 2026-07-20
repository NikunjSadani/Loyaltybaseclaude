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

import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { resolveTenantSync } from '@/lib/platform/tenant-resolution';
import { jwtVerify } from 'jose';

const mockResolve = vi.mocked(resolveTenantSync);
const mockJwt = vi.mocked(jwtVerify);

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
