/**
 * Request-volume work (2026-11-21): list links are not prefetched, nav targets are prefetched once per session,
 * the session read cache de-duplicates / expires / is invalidated by any API write, and the dashboard reuse window.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { LayoutDashboard, MapPin } from 'lucide-react';

const prefetchSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), prefetch: prefetchSpy }),
  usePathname: () => '/sales/dashboard',
}));
vi.mock('next/link', () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean | null; children: React.ReactNode }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>{children}</a>
  ),
  useLinkStatus: () => ({ pending: false }),
}));

import {
  getCached, swr, peekCached, clearSessionCache, DASHBOARD_REUSE_MS, DASH_PREFIX, SESSION_TTL_MS,
} from '@/lib/session-cache';
import { installClientMediumHeader, __resetClientMediumForTests } from '@/lib/client-medium';
import { takeUnprefetched, __resetPrefetchOnceForTests } from '@/lib/navigation/prefetch-once';
import { KycCardLink } from '@/components/sales/KycCardLink';
import NoPrefetchLink from '@/components/navigation/no-prefetch-link';
import { NavBottom } from '@/components/layout/nav-bottom';

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  prefetchSpy.mockReset();
  __resetPrefetchOnceForTests();
});

describe('list links are not prefetched', () => {
  it('KycCardLink (outlet rows) renders a Link with prefetch=false', () => {
    render(<KycCardLink href="/sales/kyc/abc">Outlet A</KycCardLink>);
    expect(screen.getByText('Outlet A').closest('a')).toHaveAttribute('data-prefetch', 'false');
  });

  it('NoPrefetchLink defaults to prefetch=false but a call site may opt back in', () => {
    render(<><NoPrefetchLink href="/x">x</NoPrefetchLink><NoPrefetchLink href="/y" prefetch>y</NoPrefetchLink></>);
    expect(screen.getByText('x').closest('a')).toHaveAttribute('data-prefetch', 'false');
    expect(screen.getByText('y').closest('a')).toHaveAttribute('data-prefetch', 'true');
  });
});

describe('bottom nav: prefetched once per session, not per render', () => {
  const items = [
    { href: '/sales/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/sales/outlets', label: 'Outlets', icon: MapPin },
    { href: '/sales/support', label: 'Support', icon: MapPin },
  ];

  it('tab links never auto-prefetch; each non-current tab is router.prefetch-ed exactly once across re-renders and remounts', async () => {
    vi.useFakeTimers();
    const { rerender, unmount } = render(<NavBottom items={items} />);
    rerender(<NavBottom items={[...items]} />);
    rerender(<NavBottom items={[...items]} />);
    unmount();
    render(<NavBottom items={items} />);
    vi.runAllTimers();
    for (const a of screen.getAllByRole('link')) expect(a).toHaveAttribute('data-prefetch', 'false');
    const calls = prefetchSpy.mock.calls.map((c) => c[0]).sort();
    expect(calls).toEqual(['/sales/outlets', '/sales/support']); // the current tab is skipped; no repeats
  });

  it('takeUnprefetched hands out each href once', () => {
    expect(takeUnprefetched(['/a', '/b'])).toEqual(['/a', '/b']);
    expect(takeUnprefetched(['/a', '/b', '/c'])).toEqual(['/c']);
    expect(takeUnprefetched(['/a'])).toEqual([]);
  });
});

describe('session cache', () => {
  it('shares one in-flight request and serves a fresh value without a request', async () => {
    const loader = vi.fn(async () => ({ success: true, data: 1 }));
    const [a, b] = await Promise.all([getCached('k', loader), getCached('k', loader)]);
    expect(a).toBe(b);
    await getCached('k', loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('expires after the TTL', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    const loader = vi.fn(async () => 'v');
    await getCached('k', loader);
    now.mockReturnValue(1_000_000 + SESSION_TTL_MS - 1);
    await getCached('k', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + SESSION_TTL_MS + 1);
    await getCached('k', loader);
    expect(loader).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('never caches a failure', async () => {
    const loader = vi.fn(async () => ({ success: false }));
    await getCached('k', loader, { shouldCache: (r) => r.success });
    await getCached('k', loader, { shouldCache: (r) => r.success });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('a read that was in flight when the cache was cleared is not stored', async () => {
    let resolve!: (v: string) => void;
    const p = getCached('k', () => new Promise<string>((r) => { resolve = r; }));
    await tick(); // the loader has started
    clearSessionCache();
    resolve('pre-write');
    await p;
    expect(peekCached('k')).toBeUndefined();
  });
});

describe('post-write invalidation (KYC submit / capture / redemption)', () => {
  let originalFetch: typeof window.fetch;
  beforeEach(() => {
    originalFetch = window.fetch;
    __resetClientMediumForTests();
  });
  afterEach(() => {
    window.fetch = originalFetch;
    __resetClientMediumForTests();
  });

  it.each([
    ['POST', '/api/kyc/submit'],
    ['POST', '/api/visibility/submit'],
    ['POST', '/api/rewards/redeem/confirm'],
    ['PATCH', '/api/kyc/abc/approve'],
  ])('%s %s clears the dashboard + identity caches', async (method, url) => {
    window.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof window.fetch;
    installClientMediumHeader();
    await getCached(`${DASH_PREFIX}core`, async () => 'dash');
    await getCached('/api/sales/me', async () => ({ success: true }));
    expect(peekCached(`${DASH_PREFIX}core`)).toBeDefined();
    await window.fetch(url, { method });
    expect(peekCached(`${DASH_PREFIX}core`)).toBeUndefined();
    expect(peekCached('/api/sales/me')).toBeUndefined();
  });

  it('a GET does not clear the cache', async () => {
    window.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof window.fetch;
    installClientMediumHeader();
    await getCached(`${DASH_PREFIX}core`, async () => 'dash');
    await window.fetch('/api/sales/outlets');
    expect(peekCached(`${DASH_PREFIX}core`)).toBeDefined();
  });

  it('a GET that started before a write and finished after it is not cached', async () => {
    let resolveGet!: (v: string) => void;
    window.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof window.fetch;
    installClientMediumHeader();
    const read = getCached(`${DASH_PREFIX}core`, () => new Promise<string>((r) => { resolveGet = r; }));
    await window.fetch('/api/kyc/submit', { method: 'POST' });
    resolveGet('pre-write');
    await read;
    expect(peekCached(`${DASH_PREFIX}core`)).toBeUndefined();
  });
});

describe('dashboard reuse window (2 min, stale-while-revalidate)', () => {
  it('within 2 min: cached value, no request; after: cached value at once, then a background refresh', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(5_000_000);
    let n = 0;
    const loader = vi.fn(async () => ++n);
    const seen: Array<[number, string]> = [];
    const onValue = (v: number, src: string) => seen.push([v, src]);

    await swr('dash:x', loader, { maxAgeMs: DASHBOARD_REUSE_MS, onValue });
    expect(seen).toEqual([[1, 'network']]);

    now.mockReturnValue(5_000_000 + DASHBOARD_REUSE_MS - 1);
    const none = swr('dash:x', loader, { maxAgeMs: DASHBOARD_REUSE_MS, onValue });
    expect(none).toBeUndefined();
    expect(seen.at(-1)).toEqual([1, 'cache']);
    expect(loader).toHaveBeenCalledTimes(1);

    now.mockReturnValue(5_000_000 + DASHBOARD_REUSE_MS + 1);
    const refresh = swr('dash:x', loader, { maxAgeMs: DASHBOARD_REUSE_MS, onValue });
    expect(seen.at(-1)).toEqual([1, 'cache']); // shown instantly
    await refresh;
    await tick();
    expect(seen.at(-1)).toEqual([2, 'network']); // then refreshed
    expect(loader).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });
});
