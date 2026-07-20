/// <reference types="vitest/globals" />
/**
 * Unit tests for the Cloudflare Worker (`cloudflare-worker/worker.js`).
 *
 * The worker lives OUTSIDE `platform/`; it is imported via a relative path so it
 * runs inside the existing `cd platform && npx vitest run` gate (see the report
 * for the approach chosen). We mock `globalThis.fetch` (the worker's only side
 * effect), capture the forwarded backend Request, and control the origin Response.
 *
 * Nothing here touches the network or a real clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Depth: this file is platform/src/__tests__/ → ../../../ is the repo root.
import worker from '../../../cloudflare-worker/worker.js';

// Exact origin strings from worker.js (kept in sync intentionally).
const FRONTEND_PROD = 'https://gifsy-frontend-4d4n5mc6yq-el.a.run.app';
const FRONTEND_STAGING = 'https://gifsy-frontend-staging-4d4n5mc6yq-el.a.run.app';
const API_PROD = 'https://gifsy-api-4d4n5mc6yq-el.a.run.app';
const API_STAGING = 'https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app';

let captured: Request | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  captured = undefined;
  fetchMock = vi.fn(async (req: Request) => {
    captured = req;
    return new Response('ok', { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build an inbound edge Request. */
function inbound(
  url: string,
  opts: { headers?: Record<string, string>; method?: string } = {},
): Request {
  return new Request(url, { method: opts.method ?? 'GET', headers: opts.headers ?? {} });
}

/** Drive the worker. */
function hit(url: string, env: Record<string, string> = {}, headers?: Record<string, string>) {
  // 3rd arg is the Worker ExecutionContext (ctx); the worker ignores it (`_ctx`).
  return worker.fetch(inbound(url, { headers }), env, {} as never);
}

// ─────────────────────────────────────────────────────────────────────────────
describe('worker — resolveOrigin routing', () => {
  it('api.gifsy.in → API_PROD origin', async () => {
    await hit('https://api.gifsy.in/v1/health');
    expect(captured!.url.startsWith(API_PROD)).toBe(true);
  });

  it('api.staging.gifsy.in → API_STAGING origin', async () => {
    await hit('https://api.staging.gifsy.in/v1/health');
    expect(captured!.url.startsWith(API_STAGING)).toBe(true);
  });

  it('uat.deoleoloyalty.gifsy.in → FRONTEND_STAGING', async () => {
    await hit('https://uat.deoleoloyalty.gifsy.in/auth/login');
    expect(captured!.url.startsWith(FRONTEND_STAGING)).toBe(true);
  });

  it('deoleoloyalty.gifsy.in (tenant frontend) → FRONTEND_PROD', async () => {
    await hit('https://deoleoloyalty.gifsy.in/auth/login');
    expect(captured!.url.startsWith(FRONTEND_PROD)).toBe(true);
  });

  it('an arbitrary non-API, non-reserved host → FRONTEND_PROD (coarse rule)', async () => {
    await hit('https://brandnewtenant.gifsy.in/');
    expect(captured!.url.startsWith(FRONTEND_PROD)).toBe(true);
  });

  it.each(['www.gifsy.in', 'mail.gifsy.in', 'status.gifsy.in'])(
    'reserved host %s → 502 and no backend fetch',
    async (host) => {
      const res = await hit(`https://${host}/`);
      expect(res.status).toBe(502);
      expect(await res.text()).toContain('No backend configured');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
describe('worker — path + query preservation', () => {
  it('preserves pathname and query string on the backend URL', async () => {
    await hit('https://deoleoloyalty.gifsy.in/a/b/c?x=1&y=two');
    const u = new URL(captured!.url);
    expect(u.origin).toBe(FRONTEND_PROD);
    expect(u.pathname).toBe('/a/b/c');
    expect(u.search).toBe('?x=1&y=two');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('worker — header transforms on the forwarded request', () => {
  it('sets x-forwarded-host to the real inbound hostname + x-forwarded-proto', async () => {
    await hit('https://deoleoloyalty.gifsy.in/x', {}, {});
    expect(captured!.headers.get('x-forwarded-host')).toBe('deoleoloyalty.gifsy.in');
    expect(captured!.headers.get('x-forwarded-proto')).toBe('https');
  });

  it('forwards the REAL host even for a uat.* host (no alias rewrite)', async () => {
    await hit('https://uat.deoleoloyalty.gifsy.in/x');
    expect(captured!.headers.get('x-forwarded-host')).toBe('uat.deoleoloyalty.gifsy.in');
  });

  it('strips cf-connecting-ip / cf-ipcountry / cf-ray / cf-visitor', async () => {
    await hit('https://deoleoloyalty.gifsy.in/x', {}, {
      'cf-connecting-ip': '203.0.113.9',
      'cf-ipcountry': 'IN',
      'cf-ray': 'abc-DEL',
      'cf-visitor': '{"scheme":"https"}',
      'x-keep-me': 'yes',
    });
    expect(captured!.headers.get('cf-connecting-ip')).toBeNull();
    expect(captured!.headers.get('cf-ipcountry')).toBeNull();
    expect(captured!.headers.get('cf-ray')).toBeNull();
    expect(captured!.headers.get('cf-visitor')).toBeNull();
    // unrelated headers are preserved
    expect(captured!.headers.get('x-keep-me')).toBe('yes');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('worker — x-edge-secret (S1 trust boundary)', () => {
  it('env.EDGE_SECRET set → forwarded request carries x-edge-secret = that value', async () => {
    await hit('https://deoleoloyalty.gifsy.in/x', { EDGE_SECRET: 'sup3r-s3cret' });
    expect(captured!.headers.get('x-edge-secret')).toBe('sup3r-s3cret');
  });

  it('env.EDGE_SECRET unset → forwarded request has NO x-edge-secret', async () => {
    await hit('https://deoleoloyalty.gifsy.in/x', {});
    expect(captured!.headers.get('x-edge-secret')).toBeNull();
  });

  it('env.EDGE_SECRET empty string → forwarded request has NO x-edge-secret', async () => {
    await hit('https://deoleoloyalty.gifsy.in/x', { EDGE_SECRET: '' });
    expect(captured!.headers.get('x-edge-secret')).toBeNull();
  });

  it('inbound smuggled x-edge-secret is STRIPPED when env is unset', async () => {
    await hit('https://deoleoloyalty.gifsy.in/x', {}, { 'x-edge-secret': 'forged-by-client' });
    expect(captured!.headers.get('x-edge-secret')).toBeNull();
  });

  it('inbound smuggled x-edge-secret is OVERWRITTEN with the real value when env is set', async () => {
    await hit(
      'https://deoleoloyalty.gifsy.in/x',
      { EDGE_SECRET: 'real-secret' },
      { 'x-edge-secret': 'forged-by-client' },
    );
    expect(captured!.headers.get('x-edge-secret')).toBe('real-secret');
    expect(captured!.headers.get('x-edge-secret')).not.toBe('forged-by-client');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('worker — Location redirect rewriting', () => {
  it('rewrites a .run.app absolute Location to the public host over https', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { location: `${FRONTEND_PROD}/auth/login?next=/admin` },
      }),
    );
    const res = await hit('https://deoleoloyalty.gifsy.in/admin');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'https://deoleoloyalty.gifsy.in/auth/login?next=/admin',
    );
  });

  it('leaves a Location on a non-.run.app host unchanged', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://accounts.google.com/o/oauth2/auth' },
      }),
    );
    const res = await hit('https://deoleoloyalty.gifsy.in/x');
    expect(res.headers.get('location')).toBe('https://accounts.google.com/o/oauth2/auth');
  });

  it('a RELATIVE Location resolves against the .run.app origin, so it is rewritten to the public host', async () => {
    // NOTE: `new URL('/dashboard', backendBase)` resolves (does NOT throw) against
    // the .run.app origin, whose hostname ends with `.run.app`, so the worker
    // rewrites it to the inbound public host. (The "leave as-is" catch branch only
    // fires for a genuinely unparseable Location.) This asserts the ACTUAL behavior.
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: '/dashboard' } }),
    );
    const res = await hit('https://deoleoloyalty.gifsy.in/x');
    expect(res.headers.get('location')).toBe('https://deoleoloyalty.gifsy.in/dashboard');
  });

  it('a 200 response with no Location is passed through untouched', async () => {
    const res = await hit('https://deoleoloyalty.gifsy.in/x');
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toBe('ok');
  });
});
