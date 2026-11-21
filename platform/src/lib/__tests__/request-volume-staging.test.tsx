/**
 * Request-volume staging round (2026-11-21): no first-install reload, re-prefetch cooldown, shared outlet-targets /
 * settings / outlet-roster reads, and no sales call to the partner banners endpoint.
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/react';

import { prefetchWithRefresh, REPREFETCH_COOLDOWN_MS, __resetPrefetchOnceForTests } from '@/lib/navigation/prefetch-once';
import { getOutletTargets, getSalesOutlets } from '@/lib/cached-reads';
import { refreshGifsySettings } from '@/lib/gifsy-settings';
import { clearSessionCache } from '@/lib/session-cache';
import ServiceWorkerRegister from '@/components/pwa/ServiceWorkerRegister';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const urls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c) => String(c[0]));

afterEach(() => { vi.unstubAllGlobals(); __resetPrefetchOnceForTests(); });

describe('1a — first SW install does not reload the page (no duplicate dashboard load)', () => {
  function mountWith(controller: object | null) {
    const listeners: Record<string, () => void> = {};
    const sw = {
      controller,
      register: vi.fn(() => Promise.resolve({ waiting: null, installing: null, addEventListener: vi.fn() })),
      addEventListener: (ev: string, fn: () => void) => { listeners[ev] = fn; },
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { ...original, pathname: '/sales/dashboard', reload }, configurable: true });
    const view = render(<ServiceWorkerRegister tenantSlug="bajaj" />);
    listeners.controllerchange?.();
    view.unmount();
    Object.defineProperty(window, 'location', { value: original, configurable: true });
    return reload;
  }
  it('first install (no previous controller) → no reload', () => {
    expect(mountWith(null)).not.toHaveBeenCalled();
  });
  it('an update (a controller already existed) → one reload', () => {
    expect(mountWith({})).toHaveBeenCalledTimes(1);
  });
});

describe('1b — a load-time invalidation does not double the nav prefetch', () => {
  it('invalidation within the cooldown → no second prefetch; after it → one', () => {
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => t);
    const calls: Array<{ onInvalidate?: () => void }> = [];
    const router = { prefetch: (_h: string, o?: { onInvalidate?: () => void }) => { calls.push({ onInvalidate: o?.onInvalidate }); } };
    prefetchWithRefresh(router as never, '/sales/support');
    t += 500;
    calls[0].onInvalidate?.(); // e.g. Next's own route-tree re-check right after load
    expect(calls).toHaveLength(1);
    prefetchWithRefresh(router as never, '/sales/leaderboard');
    t += REPREFETCH_COOLDOWN_MS + 1;
    calls[1].onInvalidate?.();
    expect(calls).toHaveLength(3);
    now.mockRestore();
  });
});

describe('2 — outlet-targets: one request per outlet open', () => {
  it('the two detail cards (+ the list) share one in-flight request', async () => {
    const f = vi.fn(async () => ok({ kpiColumns: [], rows: [] }));
    vi.stubGlobal('fetch', f);
    await Promise.all([getOutletTargets('2026-11'), getOutletTargets('2026-11')]);
    await getOutletTargets('2026-11');
    expect(urls(f).filter((u) => u.includes('/api/sales/outlet-targets'))).toHaveLength(1);
  });
});

describe('3 — /api/settings served from the session cache', () => {
  it('repeat refreshes (outlet open, Visibility) reuse it; force and a write re-ask', async () => {
    const f = vi.fn(async () => ok({ conversionRate: 1 }));
    vi.stubGlobal('fetch', f);
    await refreshGifsySettings();
    await refreshGifsySettings();
    expect(urls(f).filter((u) => u === '/api/settings')).toHaveLength(1);
    await refreshGifsySettings({ force: true });
    expect(urls(f).filter((u) => u === '/api/settings')).toHaveLength(2);
    clearSessionCache({ broadcast: false }); // what any API write (incl. a settings save) does
    await refreshGifsySettings();
    expect(urls(f).filter((u) => u === '/api/settings')).toHaveLength(3);
  });
});

describe('4 — Profile / Support / Tasks reuse the roster', () => {
  it('one /api/sales/outlets across screens', async () => {
    const f = vi.fn(async () => ok({ outlets: [] }));
    vi.stubGlobal('fetch', f);
    await getSalesOutlets(); // dashboard
    await getSalesOutlets(); // profile
    await getSalesOutlets(); // support / tasks
    expect(urls(f).filter((u) => u === '/api/sales/outlets')).toHaveLength(1);
  });
  it('the three screens use the shared reader, not their own fetch', () => {
    const base = path.resolve(__dirname, '../../app/sales');
    for (const f of ['profile/page.tsx', 'support/page.tsx', 'tasks/page.tsx']) {
      const code = fs.readFileSync(path.join(base, f), 'utf8');
      expect(code, f).toMatch(/getSalesOutlets(<[^>]*>)?\(/);
      expect(code, f).not.toMatch(/fetch\(\s*'\/api\/sales\/outlets'/);
    }
  });
});
