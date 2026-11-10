/**
 * getTenantConfig() — the SERVER-RENDER resolver (root layout, auth layout, PWA head +
 * manifests). It runs in a different module instance from proxy.ts, so it must keep its
 * OWN routing snapshot fresh: SWR refresh on every call (60s TTL) + one awaited, bounded
 * refresh when a slug the proxy already validated is missing from this instance's snapshot
 * (a tenant created after the instance started — the 2026-11-10 Bajaj "LoyaltyBase" bug).
 *
 * Uses the REAL tenant-routing-cache + tenant-resolution modules; only `next/headers` and
 * `fetch` are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let slugHeader: string | null = null;
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (n: string) => (n === 'x-tenant-slug' ? slugHeader : null) }),
}));

import { getTenantConfig } from '../server';
import { __resetRoutingCacheForTests, getRoutingSnapshot } from '../tenant-routing-cache';
import { DEFAULT_CLIENT_CONFIG } from '../default-client-config';
import { CLIENT_REGISTRY } from '../client-registry';

const DEOLEO = {
  slug: 'deoleo',
  status: 'ACTIVE',
  domains: ['deoleoloyalty.gifsy.in', 'deoleo.gifsy.in'],
  branding: {
    displayName: 'Deoleo',
    primaryColor: '#16a34a',
    logoUrl: '/logos/deoleo.svg',
    wordmarkWhiteUrl: '/brand/deoleo-wordmark-white.png',
    wordmarkColorUrl: '/brand/deoleo-wordmark-color.png',
    faviconUrl: '/favicons/deoleo.ico',
  },
};
const BAJAJ = {
  slug: 'bajaj',
  status: 'ACTIVE',
  domains: ['bajajloyalty.gifsy.in', 'bajaj.gifsy.in'],
  branding: {
    displayName: 'Bajaj Consumer Care Ltd',
    primaryColor: '#430441',
    wordmarkWhiteUrl: '/api/public/branding-assets?key=branding%2Fbajaj%2F2026-11%2Fx.png',
  },
};

const body = (tenants: unknown[]) => ({ ok: true, json: async () => ({ success: true, data: { tenants } }) });

let now = 5_000_000;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  now = 5_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.TENANT_ROUTING_SOURCE;
  __resetRoutingCacheForTests();
  slugHeader = null;
  fetchMock = vi.fn().mockResolvedValue(body([DEOLEO]));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetRoutingCacheForTests();
});

/** Let fire-and-forget refreshes settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('getTenantConfig — render-path freshness', () => {
  it('Deoleo renders the registry config overlaid with its DB branding — identical to before', async () => {
    slugHeader = 'deoleo';
    const cfg = await getTenantConfig();
    expect(cfg).toEqual({
      ...CLIENT_REGISTRY.deoleo,
      branding: { ...CLIENT_REGISTRY.deoleo.branding, ...DEOLEO.branding },
    });
    // Static Deoleo assets untouched.
    expect(cfg.branding.wordmarkWhiteUrl).toBe('/brand/deoleo-wordmark-white.png');
    expect(cfg.branding.faviconUrl).toBe('/favicons/deoleo.ico');
    expect(fetchMock).toHaveBeenCalledTimes(1); // cold warm only; no miss refresh for a known tenant
  });

  it('a tenant created AFTER warm-up appears via the awaited miss refresh — no restart needed', async () => {
    slugHeader = 'deoleo';
    await getTenantConfig(); // warm with Deoleo only
    now += 10_000;
    fetchMock.mockResolvedValue(body([DEOLEO, BAJAJ]));

    slugHeader = 'bajaj';
    const cfg = await getTenantConfig();
    expect(cfg.slug).toBe('bajaj');
    expect(cfg.branding.displayName).toBe('Bajaj Consumer Care Ltd');
    expect(cfg.branding.primaryColor).toBe('#430441');
    expect(cfg.branding.wordmarkWhiteUrl).toBe(BAJAJ.branding.wordmarkWhiteUrl);
  });

  it('a stale snapshot is refreshed in the background after the 60s TTL (branding edits show up)', async () => {
    slugHeader = 'deoleo';
    await getTenantConfig();
    fetchMock.mockResolvedValue(body([{ ...DEOLEO, branding: { ...DEOLEO.branding, displayName: 'Deoleo Renamed' } }]));

    now += 30_000; // within TTL → no refetch
    await getTenantConfig();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 31_000; // past TTL → SWR: this render still gets last-good, the next sees the update
    const swr = await getTenantConfig();
    expect(swr.branding.displayName).toBe('Deoleo');
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await getTenantConfig()).branding.displayName).toBe('Deoleo Renamed');
  });

  it('an unknown slug: one awaited refresh, then the unchanged DEFAULT fallback', async () => {
    slugHeader = 'deoleo';
    await getTenantConfig();
    now += 10_000;
    slugHeader = 'ghost';
    const cfg = await getTenantConfig();
    expect(cfg).toBe(DEFAULT_CLIENT_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A burst of further misses inside the 5s floor costs NO extra fetches.
    await getTenantConfig();
    await getTenantConfig();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('routing fetch failure → exactly today\'s fallback (registry for Deoleo, DEFAULT for unknown), never throws', async () => {
    fetchMock.mockRejectedValue(new Error('backend down'));
    slugHeader = 'deoleo';
    await expect(getTenantConfig()).resolves.toBe(CLIENT_REGISTRY.deoleo);
    now += 10_000;
    slugHeader = 'bajaj';
    await expect(getTenantConfig()).resolves.toBe(DEFAULT_CLIENT_CONFIG);
    expect(getRoutingSnapshot()).toBeNull();
  });

  it('no slug header → DEFAULT, and the gifsy operator console never triggers a miss refresh', async () => {
    slugHeader = null;
    expect(await getTenantConfig()).toBe(DEFAULT_CLIENT_CONFIG);
    now += 10_000;
    slugHeader = 'gifsy';
    expect(await getTenantConfig()).toBe(DEFAULT_CLIENT_CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
