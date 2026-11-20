/**
 * SessionExpiryGuard — refresh outcome handling (2026-11-20 audit round: H3 / M1 / M2 / M4 / L3).
 *
 * The guard refreshes via POST /auth/session-refresh and reads a real status:
 *   200 → ok (retry the original request) · 401 → dead (login, with `next`) · anything else → transient.
 * Transient never logs out: a role=status "Reconnecting…" banner, background retries with backoff,
 * one reload after recovery (unless the user has typed on the page), counted ONCE per refresh outcome.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
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

/** Route the network: the refresh endpoint and the app's /api calls get separate scripted answers. */
function mountWith(opts: { refresh: Array<number | 'network'>; api: number[] }) {
  const refreshQ = [...opts.refresh];
  const apiQ = [...opts.api];
  const backend = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/auth/session-refresh')) {
      const next = refreshQ.shift() ?? 503;
      if (next === 'network') throw new TypeError('Failed to fetch');
      return new Response(null, { status: next });
    }
    return new Response(null, { status: apiQ.shift() ?? 200 });
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

  it('the refresh POST carries the CSRF header', async () => {
    const { backend } = mountWith({ refresh: [200], api: [401, 200] });
    await window.fetch('/api/wallet/me');
    const call = backend.mock.calls.find((c) => String(c[0]).includes('/auth/session-refresh'))!;
    expect(call[1]).toMatchObject({ method: 'POST', headers: { 'x-session-refresh': '1' } });
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

  it.each([503, 500, 404, 'network' as const])('TRANSIENT (%s) → original 401 returned, NO redirect, a role=status Reconnecting banner', async (r) => {
    mountWith({ refresh: [r], api: [401] });

    const res = await act(() => window.fetch('/api/wallet/me'));

    expect(res.status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(banner()?.textContent).toMatch(/Reconnecting/);
  });

  it('H3: 3 parallel 401s sharing ONE transient refresh → ONE refresh call, no reload, no redirect', async () => {
    const { refreshCalls } = mountWith({ refresh: [503], api: [401, 401, 401] });

    await act(() => Promise.all([window.fetch('/api/a'), window.fetch('/api/b'), window.fetch('/api/c')]));

    expect(refreshCalls()).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('M1: transient → retries in the background with backoff; on recovery the page reloads ONCE to re-fetch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { refreshCalls } = mountWith({ refresh: [503, 503, 200], api: [401] });

    await act(() => window.fetch('/api/wallet/me'));
    expect(refreshCalls()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(mod.RECONNECT_BACKOFF_MS[0])); // 2nd attempt (503)
    expect(refreshCalls()).toBe(2);
    expect(reload).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(mod.RECONNECT_BACKOFF_MS[1])); // 3rd attempt (200)
    expect(refreshCalls()).toBe(3);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it('M1: a background retry that finds the session DEAD → login (not a stuck banner)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mountWith({ refresh: [503, 401], api: [401] });

    await act(() => window.fetch('/api/wallet/me'));
    await act(() => vi.advanceTimersByTimeAsync(mod.RECONNECT_BACKOFF_MS[0]));

    expect(assign).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('M1: reloads are capped — a second recovery inside the window asks instead of reloading again', async () => {
    window.sessionStorage.setItem('gifsy:session-reload-at', String(Date.now()));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mountWith({ refresh: [503, 200], api: [401] });

    await act(() => window.fetch('/api/wallet/me'));
    await act(() => vi.advanceTimersByTimeAsync(mod.RECONNECT_BACKOFF_MS[0]));

    expect(reload).not.toHaveBeenCalled();
    expect(banner()?.textContent).toMatch(/Connection restored/);
  });

  it('H3: the user has TYPED on this page → recovery never reloads (input kept), banner asks them to retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mountWith({ refresh: [503, 200], api: [401] });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));

    await act(() => window.fetch('/api/wallet/me'));
    await act(() => vi.advanceTimersByTimeAsync(mod.RECONNECT_BACKOFF_MS[0]));

    expect(reload).not.toHaveBeenCalled();
    expect(banner()?.textContent).toMatch(/unsaved changes are kept/);
    input.remove();
  });

  it('H3: OFFLINE → no timed retries; waits for the `online` event, then refreshes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    const { refreshCalls } = mountWith({ refresh: ['network', 200], api: [401] });

    await act(() => window.fetch('/api/wallet/me'));
    expect(banner()?.textContent).toMatch(/offline/);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(refreshCalls()).toBe(1); // nothing while offline

    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(refreshCalls()).toBe(2);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('L3: any successful /api response clears the banner and cancels the backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { refreshCalls } = mountWith({ refresh: [503], api: [401, 200] });

    await act(() => window.fetch('/api/a'));
    expect(banner()).not.toBeNull();
    await act(() => window.fetch('/api/b')); // 200 — the session works again
    expect(banner()).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(refreshCalls()).toBe(1); // backoff cancelled
    expect(reload).not.toHaveBeenCalled();
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
});
