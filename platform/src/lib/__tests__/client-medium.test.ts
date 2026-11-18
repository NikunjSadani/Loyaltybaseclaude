/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CLIENT_MEDIUM_HEADER,
  __resetClientMediumForTests,
  detectClientMedium,
  installClientMediumHeader,
  isSameOriginApi,
  withClientMedium,
} from '@/lib/client-medium';

function setStandalone(on: boolean, iosFlag = false) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((q: string) => ({ matches: on && q === '(display-mode: standalone)', media: q })),
  });
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: iosFlag ? true : undefined });
}

const headerOf = (init: RequestInit | undefined) => new Headers(init?.headers).get(CLIENT_MEDIUM_HEADER);

describe('detectClientMedium', () => {
  afterEach(() => setStandalone(false));

  it('installed PWA (display-mode standalone) → app', () => {
    setStandalone(true);
    expect(detectClientMedium()).toBe('app');
  });
  it('legacy iOS navigator.standalone → app', () => {
    setStandalone(false, true);
    expect(detectClientMedium()).toBe('app');
  });
  it('a normal tab → browser', () => {
    setStandalone(false);
    expect(detectClientMedium()).toBe('browser');
  });
  it('matchMedia throwing → falls back, never throws', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error('nope');
      },
    });
    expect(detectClientMedium()).toBe('browser');
  });
});

describe('isSameOriginApi / withClientMedium', () => {
  it('only same-origin /api/* is tagged', () => {
    expect(isSameOriginApi('/api/reports/usage')).toBe(true);
    expect(isSameOriginApi(`${window.location.origin}/api/wallet`)).toBe(true);
    expect(isSameOriginApi(new URL('/api/x', window.location.origin))).toBe(true);
    expect(isSameOriginApi('/admin/reports')).toBe(false);
    expect(isSameOriginApi('/apix/foo')).toBe(false);
    expect(isSameOriginApi('https://evil.example.com/api/steal')).toBe(false);
    expect(isSameOriginApi('https://storage.googleapis.com/bucket/api/x')).toBe(false);
  });

  it('adds the header, keeps every other header and the rest of init', () => {
    const init = withClientMedium('/api/a', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }, 'app');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    expect(headerOf(init)).toBe('app');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  });

  it('works with no init, a Headers object and an array of pairs', () => {
    expect(headerOf(withClientMedium('/api/a', undefined, 'browser'))).toBe('browser');
    expect(headerOf(withClientMedium('/api/a', { headers: new Headers({ a: '1' }) }, 'app'))).toBe('app');
    const arr = withClientMedium('/api/a', { headers: [['a', '1']] }, 'app');
    expect(new Headers(arr?.headers).get('a')).toBe('1');
  });

  it("keeps a Request's own headers when init has none", () => {
    const req = new Request(`${window.location.origin}/api/a`, { headers: { 'X-Keep': 'yes' } });
    const init = withClientMedium(req, undefined, 'app');
    expect(new Headers(init?.headers).get('x-keep')).toBe('yes');
    expect(headerOf(init)).toBe('app');
  });

  it('never overrides an explicitly-set value; leaves non-api requests untouched (same object)', () => {
    expect(headerOf(withClientMedium('/api/a', { headers: { [CLIENT_MEDIUM_HEADER]: 'browser' } }, 'app'))).toBe('browser');
    const init = { headers: { a: '1' } };
    expect(withClientMedium('https://other.example.com/x', init, 'app')).toBe(init);
  });
});

describe('installClientMediumHeader (the window.fetch patch)', () => {
  let original: typeof window.fetch;
  let spy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    original = window.fetch;
    spy = vi.fn(async () => new Response('{}', { status: 200 }));
    window.fetch = spy as unknown as typeof window.fetch;
    __resetClientMediumForTests();
    setStandalone(false);
  });
  afterEach(() => {
    window.fetch = original;
    __resetClientMediumForTests();
  });

  it('tags raw fetch("/api/...") calls with the medium detected AT CALL TIME', async () => {
    installClientMediumHeader();
    await window.fetch('/api/reports/session-report');
    expect(headerOf(spy.mock.calls[0][1])).toBe('browser');
    setStandalone(true);
    await window.fetch('/api/wallet', { method: 'GET' });
    expect(headerOf(spy.mock.calls[1][1])).toBe('app');
  });

  it('does not tag third-party requests', async () => {
    installClientMediumHeader();
    await window.fetch('https://maps.example.com/tiles/1');
    expect(spy.mock.calls[0][1]).toBeUndefined();
  });

  it('is idempotent (one wrapper, not stacked)', async () => {
    installClientMediumHeader();
    const once = window.fetch;
    installClientMediumHeader();
    expect(window.fetch).toBe(once);
  });

  it('a tagging failure never breaks the request (falls through with the original init)', async () => {
    installClientMediumHeader();
    // An invalid header name makes `new Headers(...)` throw inside the tagger.
    const init = { headers: [['bad name', 'x']] as [string, string][] };
    const res = await window.fetch('/api/x', init);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(init); // passed through untouched
  });

  it('a later wrapper (SessionExpiryGuard) that wraps this one still sends the header on its retry', async () => {
    installClientMediumHeader();
    const tagged = window.fetch;
    // what SessionExpiryGuard does: capture the current fetch and call it again for the retry
    await tagged('/api/retry-me');
    await tagged('/api/retry-me');
    expect(spy.mock.calls.every((c) => headerOf(c[1]) === 'browser')).toBe(true);
  });
});
