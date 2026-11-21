/**
 * Request-volume audit fixes (2026-11-21): session-scoped cache keys, cross-tab clears, assumed-context /
 * partner-outlet switch clears, bounded onInvalidate re-prefetch, a loading shell per nav route, 60 s features TTL.
 */
import fs from 'node:fs';
import path from 'node:path';

const setActivePartnerMock = vi.fn().mockResolvedValue({ success: true });
vi.mock('@/lib/active-partner-actions', () => ({
  setActivePartner: (id: string | null) => setActivePartnerMock(id),
}));

import {
  getCached, peekCached, clearSessionCache, SESSION_CHANNEL, FEATURES_TTL_MS, __sessionCacheSizeForTests,
} from '@/lib/session-cache';
import { clearAssumedContext } from '@/lib/auth-client';
import { switchActivePartner } from '@/lib/partner-identity';
import { getSalesMe, OUTLET_TYPES_URL } from '@/lib/cached-reads';
import { prefetchWithRefresh, MAX_REPREFETCH_PER_HREF, __resetPrefetchOnceForTests } from '@/lib/navigation/prefetch-once';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const signIn = (id: string) => localStorage.setItem('user', JSON.stringify({ id, name: id, role: 'SALES_SO', phone: '' }));

beforeEach(() => {
  localStorage.clear();
  setActivePartnerMock.mockClear();
  __resetPrefetchOnceForTests();
});

describe('1 — entries are scoped to user + assumed tenant', () => {
  it('tab 2 after a user switch (no clear reached it) never reads the previous user\'s entry', async () => {
    signIn('user-A');
    await getCached('/api/sales/me', async () => ({ success: true, data: { name: 'A' } }));
    // Another tab logged in as B: localStorage changed, this tab's in-memory cache was NOT cleared.
    signIn('user-B');
    expect(peekCached('/api/sales/me')).toBeUndefined();
    const loader = vi.fn(async () => ({ success: true, data: { name: 'B' } }));
    const v = await getCached('/api/sales/me', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(v).toEqual({ success: true, data: { name: 'B' } });
  });

  it('an assumed brand is its own scope', async () => {
    signIn('op-1');
    await getCached(OUTLET_TYPES_URL, async () => ({ success: true, data: ['DEOLEO'] }));
    localStorage.setItem('assumedBrand', 'Bajaj');
    expect(peekCached(OUTLET_TYPES_URL)).toBeUndefined();
  });
});

describe('1 — cross-tab clears', () => {
  it('assume in another tab (storage event on assumedBrand) clears outlet-types here', async () => {
    signIn('op-1');
    await getCached(OUTLET_TYPES_URL, async () => ({ success: true, data: [] }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'assumedBrand', newValue: 'Bajaj' }));
    expect(peekCached(OUTLET_TYPES_URL)).toBeUndefined();
  });

  it('an unrelated storage key does not clear', async () => {
    await getCached(OUTLET_TYPES_URL, async () => ({ success: true, data: [] }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'pwa-push-snooze', newValue: '1' }));
    expect(peekCached(OUTLET_TYPES_URL)).toBeDefined();
  });

  it(`a '${SESSION_CHANNEL}' broadcast from another tab clears this tab`, async () => {
    await getCached(OUTLET_TYPES_URL, async () => ({ success: true, data: [] }));
    const otherTab = new BroadcastChannel(SESSION_CHANNEL);
    otherTab.postMessage({ type: 'clear' });
    for (let i = 0; i < 20 && peekCached(OUTLET_TYPES_URL); i++) await tick(10);
    otherTab.close();
    expect(peekCached(OUTLET_TYPES_URL)).toBeUndefined();
  });

  it('clearSessionCache broadcasts to other tabs', async () => {
    const otherTab = new BroadcastChannel(SESSION_CHANNEL);
    const got = new Promise((resolve) => { otherTab.onmessage = (e) => resolve(e.data); });
    clearSessionCache();
    await expect(got).resolves.toEqual({ type: 'clear' });
    otherTab.close();
  });
});

describe('2 — clearAssumedContext clears the read cache when the context really changes', () => {
  it('hint present → cache cleared; hint already absent → cache kept', async () => {
    localStorage.setItem('assumedBrand', 'Bajaj');
    await getCached(OUTLET_TYPES_URL, async () => ({ success: true, data: [] }));
    expect(__sessionCacheSizeForTests()).toBe(1);
    clearAssumedContext();
    expect(__sessionCacheSizeForTests()).toBe(0); // every scope wiped, not just hidden by the scope change
    await getCached(OUTLET_TYPES_URL, async () => ({ success: true, data: [] }));
    clearAssumedContext();
    expect(peekCached(OUTLET_TYPES_URL)).toBeDefined();
  });
});

describe('5 — partner outlet switch clears the cache (incl. the unread count)', () => {
  it('switchActivePartner → server action called, unread + identity entries gone', async () => {
    await getCached('notifications:unread-count', async () => ({ success: true, data: { count: 3 } }));
    await getCached('/api/partner/me', async () => ({ success: true }));
    await switchActivePartner('p-sib');
    expect(setActivePartnerMock).toHaveBeenCalledWith('p-sib');
    expect(peekCached('notifications:unread-count')).toBeUndefined();
    expect(peekCached('/api/partner/me')).toBeUndefined();
  });
});

describe('4 — nav prefetch: onInvalidate re-prefetch, bounded', () => {
  it('re-prefetches the same href on each invalidation, at most MAX_REPREFETCH_PER_HREF times', () => {
    const calls: Array<{ href: string; onInvalidate?: () => void }> = [];
    const router = { prefetch: (href: string, opts?: { onInvalidate?: () => void }) => { calls.push({ href, onInvalidate: opts?.onInvalidate }); } };
    prefetchWithRefresh(router, '/sales/outlets');
    for (let i = 0; i < MAX_REPREFETCH_PER_HREF + 5; i++) calls.at(-1)?.onInvalidate?.();
    expect(calls.every((c) => c.href === '/sales/outlets')).toBe(true);
    expect(calls).toHaveLength(1 + MAX_REPREFETCH_PER_HREF);
  });

  it('every bottom-nav / menu route has a loading.tsx shell (and the ledger has its own)', () => {
    const base = path.resolve(__dirname, '../../app/sales');
    for (const r of ['dashboard', 'kyc', 'outlets', 'tasks', 'team', 'leaderboard', 'profile', 'support', 'visibility',
      'kyc/[id]', 'kyc/[id]/ledger', 'kyc/new', 'team/[memberId]/outlets']) {
      expect(fs.existsSync(path.join(base, r, 'loading.tsx')), r).toBe(true);
    }
    expect(fs.readFileSync(path.join(base, 'kyc/[id]/ledger/loading.tsx'), 'utf8')).toMatch(/variant="ledger"/);
  });
});

describe('7 — feature flags are at most 60 s old', () => {
  it('/api/sales/me is re-read after FEATURES_TTL_MS', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(10_000_000);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { features: {} } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await getSalesMe();
    now.mockReturnValue(10_000_000 + FEATURES_TTL_MS - 1);
    await getSalesMe();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(10_000_000 + FEATURES_TTL_MS + 1);
    await getSalesMe();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    now.mockRestore();
  });
});
