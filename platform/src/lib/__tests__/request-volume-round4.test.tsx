/**
 * Request-volume audit round 4 (2026-11-21): SW reload paths, 60 s settings / roster TTLs, forced fresh roster reads,
 * prefetch re-arm after a dropped refresh.
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

const prefetchSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: prefetchSpy }),
  usePathname: () => '/sales/dashboard',
}));

import ServiceWorkerRegister from '@/components/pwa/ServiceWorkerRegister';
import { refreshGifsySettings } from '@/lib/gifsy-settings';
import { getSalesOutlets, OUTLET_LIST_TTL_MS } from '@/lib/cached-reads';
import { FEATURES_TTL_MS } from '@/lib/session-cache';
import {
  prefetchWithRefresh, takeUnprefetched, REPREFETCH_COOLDOWN_MS, __resetPrefetchOnceForTests,
} from '@/lib/navigation/prefetch-once';
import { ListRefreshControl } from '@/components/sales/list-refresh-control';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const count = (m: ReturnType<typeof vi.fn>, url: string) => m.mock.calls.filter((c) => String(c[0]) === url).length;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); __resetPrefetchOnceForTests(); });

/** A fake SW container whose controller can change and whose events we fire by hand. */
function setupSw(initialController: object | null, opts: { waiting?: object } = {}) {
  const listeners: Record<string, () => void> = {};
  const regListeners: Record<string, () => void> = {};
  const waiting = opts.waiting ? { ...opts.waiting, postMessage: vi.fn(), addEventListener: vi.fn(), state: 'installed' } : null;
  const registration = {
    waiting, installing: null as unknown,
    addEventListener: (ev: string, fn: () => void) => { regListeners[ev] = fn; },
  };
  const sw = {
    controller: initialController as object | null,
    register: vi.fn(() => Promise.resolve(registration)),
    addEventListener: (ev: string, fn: () => void) => { listeners[ev] = fn; },
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
  const reload = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', { value: { ...original, pathname: '/sales/dashboard', reload }, configurable: true });
  const restore = () => Object.defineProperty(window, 'location', { value: original, configurable: true });
  return { sw, listeners, regListeners, registration, reload, restore };
}

describe('1 — service worker reload paths', () => {
  it('first-ever install claims → no reload; a LATER update in the same first session → reload', async () => {
    const env = setupSw(null);
    const view = render(<ServiceWorkerRegister tenantSlug="bajaj" />);
    await act(async () => { await Promise.resolve(); });
    env.sw.controller = {};                // first install claims the page
    env.listeners.controllerchange?.();
    expect(env.reload).not.toHaveBeenCalled();
    env.regListeners.updatefound?.();      // a deploy later in the session
    env.listeners.controllerchange?.();    // the update takes control
    expect(env.reload).toHaveBeenCalledTimes(1);
    view.unmount();
    env.restore();
  });

  it('tapping Refresh on the update banner always reloads', async () => {
    const env = setupSw({}, { waiting: {} });
    const view = render(<ServiceWorkerRegister tenantSlug="bajaj" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    expect(env.registration.waiting!.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    env.listeners.controllerchange?.();
    expect(env.reload).toHaveBeenCalledTimes(1);
    view.unmount();
    env.restore();
  });
});

describe('2 — /api/settings follows the 1-minute rule', () => {
  it('re-read after 60 s', async () => {
    const now = vi.spyOn(Date, 'now');
    let t = 7_000_000;
    now.mockImplementation(() => t);
    const f = vi.fn(async () => ok({}));
    vi.stubGlobal('fetch', f);
    await refreshGifsySettings();
    t += FEATURES_TTL_MS - 1;
    await refreshGifsySettings();
    expect(count(f, '/api/settings')).toBe(1);
    t += 2;
    await refreshGifsySettings();
    expect(count(f, '/api/settings')).toBe(2);
  });
});

describe('3 — outlet roster: 60 s, and forced reads never re-store the old copy', () => {
  it('TTL is 60 s and force always asks the server and stores the fresh answer', async () => {
    expect(OUTLET_LIST_TTL_MS).toBe(60_000);
    let n = 0;
    const f = vi.fn(async () => ok({ outlets: [{ id: `v${++n}` }] }));
    vi.stubGlobal('fetch', f);
    await getSalesOutlets();
    const forced = await getSalesOutlets({ force: true }); // dashboard revalidation / refresh control
    expect(count(f, '/api/sales/outlets')).toBe(2);
    const reused = await getSalesOutlets();               // the next screen gets the FRESH copy
    expect(count(f, '/api/sales/outlets')).toBe(2);
    expect(reused).toEqual(forced);
    expect((reused?.data as { outlets: { id: string }[] }).outlets[0].id).toBe('v2');
  });

  it('the refresh control shows when the list was fetched and calls onRefresh', () => {
    const onRefresh = vi.fn();
    render(<ListRefreshControl updatedAt={new Date(2026, 10, 21, 10, 42)} refreshing={false} onRefresh={onRefresh} />);
    expect(screen.getByTestId('list-refresh')).toHaveTextContent(/Updated 10:42/i);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('4 — a refresh dropped inside the cooldown re-arms the route', () => {
  it('the href is handed out again once the cooldown has passed', () => {
    const now = vi.spyOn(Date, 'now');
    let t = 9_000_000;
    now.mockImplementation(() => t);
    const calls: Array<{ onInvalidate?: () => void }> = [];
    const router = { prefetch: (_h: string, o?: { onInvalidate?: () => void }) => { calls.push({ onInvalidate: o?.onInvalidate }); } };
    expect(takeUnprefetched(['/sales/support'])).toEqual(['/sales/support']);
    prefetchWithRefresh(router as never, '/sales/support');
    t += 1_000;
    calls[0].onInvalidate?.();                                  // dropped (too soon)
    expect(calls).toHaveLength(1);
    expect(takeUnprefetched(['/sales/support'])).toEqual([]);   // still cooling
    t += REPREFETCH_COOLDOWN_MS;
    expect(takeUnprefetched(['/sales/support'])).toEqual(['/sales/support']); // re-armed, not lost
  });
});
