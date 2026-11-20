/**
 * SessionExpiryGuard — refresh outcome handling (2026-11-20 audit rounds).
 *
 * The guard only reacts to SESSION 401s (`x-auth-failure: session`), refreshes via POST /auth/session-refresh
 * and reads a real status: 200 ok · 401 dead (login, with `next`) · 503/network/timeout → "unavailable" ·
 * other → "error". A transient outcome never logs out and never reloads the page: a role=status banner with
 * "Retry now", background retries (2/4/8/16/30 s, then every 60 s), and retries on online / visible / focus.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react';
import React from 'react';

const assign = vi.fn();
const reload = vi.fn();
let realFetch: typeof window.fetch;

type Mod = typeof import('@/components/auth/SessionExpiryGuard');
let mod: Mod;

beforeEach(async () => {
  vi.resetModules();
  assign.mockReset();
  reload.mockReset();
  realFetch = window.fetch;
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, pathname: '/admin/users', search: '', assign, reload },
  });
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  mod = await import('@/components/auth/SessionExpiryGuard');
  mod.__resetSessionGuardForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.fetch = realFetch;
});

type Api = number | { status: number; marker?: string | null };

/** Route the network: the refresh endpoint and the app's /api calls get separate scripted answers. */
function mountWith(opts: { refresh: Array<number | 'network' | 'timeout'>; api: Api[] }) {
  const refreshQ = [...opts.refresh];
  const apiQ = [...opts.api];
  const backend = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/auth/session-refresh')) {
      const next = refreshQ.shift() ?? 503;
      if (next === 'network') throw new TypeError('Failed to fetch');
      if (next === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      return new Response(null, { status: next });
    }
    const a = apiQ.shift() ?? 200;
    const status = typeof a === 'number' ? a : a.status;
    // Session 401s carry the marker by default (as the proxy / JwtAuthGuard send them).
    const marker = typeof a === 'number' ? (a === 401 ? 'session' : null) : a.marker ?? null;
    return new Response(null, { status, headers: marker ? { 'x-auth-failure': marker } : {} });
  });
  window.fetch = backend as unknown as typeof window.fetch;
  render(React.createElement(mod.default));
  const refreshCalls = () => backend.mock.calls.filter((c) => String(c[0]).includes('/auth/session-refresh')).length;
  return { backend, refreshCalls };
}

const banner = () => screen.queryByRole('status');

describe('SessionExpiryGuard — refresh outcomes', () => {
  it('refresh OK → retries the original request once and returns the retry (no banner, no reload)', async () => {
    const { backend } = mountWith({ refresh: [200], api: [401, 200] });

    const res = await window.fetch('/api/wallet/me');

    expect(res.status).toBe(200);
    expect(backend.mock.calls.filter((c) => String(c[0]).includes('/api/')).length).toBe(2);
    expect(assign).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it('M-3: timeoutSignal falls back to AbortController + timer when AbortSignal.timeout is missing (older Safari)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const original = (AbortSignal as unknown as { timeout?: unknown }).timeout;
    try {
      Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
      const signal = mod.timeoutSignal(1_000)!;
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(signal.aborted).toBe(true);
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: original });
    }
  });

  it('H-A (b): the exchange timeout covers the whole browser → route → API path (10 s)', () => {
    expect(mod.REFRESH_EXCHANGE_TIMEOUT_MS).toBe(10_000);
  });

  it('the refresh POST carries the CSRF header and a timeout signal (H4)', async () => {
    const { backend } = mountWith({ refresh: [200], api: [401, 200] });
    await window.fetch('/api/wallet/me');
    const call = backend.mock.calls.find((c) => String(c[0]).includes('/auth/session-refresh'))!;
    expect(call[1]).toMatchObject({ method: 'POST', headers: { 'x-session-refresh': '1' } });
    expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('H1: a 401 WITHOUT the session marker (business error, e.g. wrong OTP) → no refresh, no resend, no logout', async () => {
    const { backend, refreshCalls } = mountWith({ refresh: [200], api: [{ status: 401, marker: null }] });

    const res = await window.fetch('/api/rewards/redeem/confirm', { method: 'POST', body: '{"otp":"1"}' });

    expect(res.status).toBe(401);
    expect(refreshCalls()).toBe(0);
    expect(backend.mock.calls.filter((c) => String(c[0]).includes('/api/')).length).toBe(1); // NOT resent
    expect(assign).not.toHaveBeenCalled();
  });

  it('DEAD (refresh endpoint 401) → login with expired=1 and next', async () => {
    mountWith({ refresh: [401], api: [401] });

    await window.fetch('/api/wallet/me');

    expect(assign).toHaveBeenCalledTimes(1);
    const target = new URL(assign.mock.calls[0][0] as string, 'https://x.test');
    expect(target.pathname).toBe('/auth/login');
    expect(target.searchParams.get('expired')).toBe('1');
    expect(target.searchParams.get('next')).toBe('/admin/users');
  });

  it.each([503, 'network' as const, 'timeout' as const])(
    'UNAVAILABLE (%s) → caller gets a TYPED transient 503 "Connection problem" (not the raw 401), NO redirect, NO reload, banner with Retry',
    async (r) => {
      mountWith({ refresh: [r], api: [401] });

      const res = await act(() => window.fetch('/api/wallet/me'));

      expect(res.status).toBe(503);
      expect(res.headers.get('x-session-transient')).toBe('1');
      await expect(res.json()).resolves.toMatchObject({ error: 'Connection problem — please retry.', transient: true });
      expect(assign).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      expect(banner()?.textContent).toMatch(/Reconnecting/);
      expect(screen.getByRole('button', { name: /Retry now/ })).toBeTruthy();
    },
  );

  it.each([400, 404])('ERROR (%i from the refresh endpoint) → "Something went wrong" banner (not "connection"), session kept', async (r) => {
    mountWith({ refresh: [r], api: [401] });

    await act(() => window.fetch('/api/wallet/me'));

    expect(banner()?.textContent).toMatch(/Something went wrong/);
    expect(banner()?.textContent).not.toMatch(/interrupted/);
    expect(assign).not.toHaveBeenCalled();
  });

  it('3 parallel 401s sharing ONE transient refresh → ONE refresh call, no reload, no redirect', async () => {
    const { refreshCalls } = mountWith({ refresh: [503], api: [401, 401, 401] });

    await act(() => Promise.all([window.fetch('/api/a'), window.fetch('/api/b'), window.fetch('/api/c')]));

    expect(refreshCalls()).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('H2: recovery after a transient outage → banner disappears, NO reload, `session:restored` event for opt-in pages', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { refreshCalls } = mountWith({ refresh: [503, 503, 200], api: [401] });
    const restored = vi.fn();
    window.addEventListener('session:restored', restored);

    await act(() => window.fetch('/api/wallet/me'));
    await act(() => vi.advanceTimersByTimeAsync(mod.RECONNECT_BACKOFF_MS[0]));
    expect(refreshCalls()).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(mod.RECONNECT_BACKOFF_MS[1]));
    expect(refreshCalls()).toBe(3);

    expect(reload).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
    expect(restored).toHaveBeenCalledTimes(1);
    window.removeEventListener('session:restored', restored);
  });

  it('M4: keeps retrying after the 5 fast attempts — every 60 s — never gives up into a stuck state', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { refreshCalls } = mountWith({ refresh: Array(12).fill(503), api: [401] });

    await act(() => window.fetch('/api/wallet/me'));
    let total = 0;
    for (const ms of mod.RECONNECT_BACKOFF_MS) total += ms;
    await act(() => vi.advanceTimersByTimeAsync(total + 3 * 60_000));

    expect(refreshCalls()).toBeGreaterThanOrEqual(1 + mod.RECONNECT_BACKOFF_MS.length + 3);
    expect(assign).not.toHaveBeenCalled();
    expect(banner()).not.toBeNull();
  });

  it('a background retry that finds the session DEAD → login (not a stuck banner)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mountWith({ refresh: [503, 401], api: [401] });

    await act(() => window.fetch('/api/wallet/me'));
    await act(() => vi.advanceTimersByTimeAsync(mod.RECONNECT_BACKOFF_MS[0]));

    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('M4: OFFLINE → offline banner WITH Retry, no timed retries; `online` triggers a refresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    const { refreshCalls } = mountWith({ refresh: ['network', 200], api: [401] });

    await act(() => window.fetch('/api/wallet/me'));
    expect(banner()?.textContent).toMatch(/offline/);
    expect(screen.getByRole('button', { name: /Retry now/ })).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(refreshCalls()).toBe(1);

    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshCalls()).toBe(2);
    expect(banner()).toBeNull();
  });

  it('M4: the tab becoming visible again (iOS resume) retries immediately; so does "Retry now"', async () => {
    const { refreshCalls } = mountWith({ refresh: [503, 503, 200], api: [401] });

    await act(() => window.fetch('/api/wallet/me'));
    expect(refreshCalls()).toBe(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(refreshCalls()).toBe(2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry now/ }));
    });
    expect(refreshCalls()).toBe(3);
    expect(banner()).toBeNull();
  });

  it('any successful /api response clears the banner and cancels the backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { refreshCalls } = mountWith({ refresh: [503], api: [401, 200] });

    await act(() => window.fetch('/api/a'));
    expect(banner()).not.toBeNull();
    await act(() => window.fetch('/api/b')); // 200 — the session works again
    expect(banner()).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(refreshCalls()).toBe(1); // backoff cancelled
  });

  it('M4: another tab refreshed moments ago (shared cookie jar) → no second refresh exchange', async () => {
    window.localStorage.setItem('gifsy:session-refreshed-at', String(Date.now()));
    const { refreshCalls } = mountWith({ refresh: [200], api: [401, 200] });

    const res = await window.fetch('/api/wallet/me');

    expect(res.status).toBe(200);
    expect(refreshCalls()).toBe(0);
  });

  it('M4: refreshes are serialised across tabs with a Web Lock when available', async () => {
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => cb());
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    mountWith({ refresh: [200], api: [401, 200] });

    await window.fetch('/api/wallet/me');

    expect(request).toHaveBeenCalledWith('gifsy-session-refresh', expect.any(Function));
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  });

  it('C2: a page that loads normally clears the proxy Reconnecting page backoff counter', async () => {
    window.sessionStorage.setItem('gifsy:reconnect-attempt', '4');
    mountWith({ refresh: [], api: [] });
    expect(window.sessionStorage.getItem('gifsy:reconnect-attempt')).toBeNull();
  });
});
