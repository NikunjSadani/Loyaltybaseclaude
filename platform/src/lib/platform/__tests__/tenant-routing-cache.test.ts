/**
 * §A-DOMAIN Phase 2 — tenant-routing-cache tests.
 *
 * Covers the stale-while-revalidate contract: cold-start null snapshot, TTL
 * staleness, the TENANT_ROUTING_SOURCE=registry kill switch, empty-branding
 * cleanup, and fail-safe behaviour (a fetch failure keeps last-good / stays null
 * and never throws). `fetch` is mocked — no real network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getRoutingSnapshot,
  refreshIfStale,
  ensureWarm,
  invalidate,
  __resetRoutingCacheForTests,
} from '../tenant-routing-cache';

const GOOD_PAYLOAD = {
  success: true,
  data: {
    tenants: [
      {
        slug: 'deoleo',
        status: 'ACTIVE',
        domains: ['deoleoloyalty.gifsy.in', 'deoleo.gifsy.in'],
        branding: {
          displayName: 'Deoleo India',
          primaryColor: '#16a34a',
          logoUrl: 'https://cdn/deoleo.png',
          wordmarkWhiteUrl: '',
          wordmarkColorUrl: '',
          faviconUrl: '',
        },
      },
      {
        slug: 'acme',
        status: 'ONBOARDING',
        domains: ['acme.gifsy.in'],
        branding: { displayName: '', primaryColor: '', logoUrl: '' },
      },
    ],
  },
};

function mockFetchResolving(payload: unknown, ok = true) {
  const f = vi.fn().mockResolvedValue({ ok, json: async () => payload });
  vi.stubGlobal('fetch', f);
  return f;
}

let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.TENANT_ROUTING_SOURCE;
  __resetRoutingCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetRoutingCacheForTests();
  delete process.env.TENANT_ROUTING_SOURCE;
});

describe('getRoutingSnapshot / cold start', () => {
  it('returns null before any successful fetch (→ caller uses the registry)', () => {
    expect(getRoutingSnapshot()).toBeNull();
  });
});

describe('refreshIfStale — happy path', () => {
  it('populates the snapshot with domain→slug and cleaned branding', async () => {
    mockFetchResolving(GOOD_PAYLOAD);
    await refreshIfStale();

    const snap = getRoutingSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.domainToSlug.get('deoleoloyalty.gifsy.in')).toBe('deoleo');
    expect(snap!.domainToSlug.get('deoleo.gifsy.in')).toBe('deoleo');
    expect(snap!.domainToSlug.get('acme.gifsy.in')).toBe('acme');

    // Non-empty branding kept…
    expect(snap!.slugToBranding.get('deoleo')).toMatchObject({
      displayName: 'Deoleo India',
      primaryColor: '#16a34a',
      logoUrl: 'https://cdn/deoleo.png',
    });
    // …empty-string branding fields dropped (the staging reality).
    const deoleoBranding = snap!.slugToBranding.get('deoleo')!;
    expect(deoleoBranding.wordmarkWhiteUrl).toBeUndefined();
    expect(deoleoBranding.faviconUrl).toBeUndefined();
    // A tenant whose branding is ALL empty strings → an empty object, not "".
    expect(snap!.slugToBranding.get('acme')).toEqual({});
  });

  it('lowercases domains from the endpoint', async () => {
    mockFetchResolving({
      data: { tenants: [{ slug: 'deoleo', status: 'ACTIVE', domains: ['DeoleoLoyalty.Gifsy.In'], branding: {} }] },
    });
    await refreshIfStale();
    expect(getRoutingSnapshot()!.domainToSlug.get('deoleoloyalty.gifsy.in')).toBe('deoleo');
  });
});

describe('TTL staleness (stale-while-revalidate)', () => {
  it('does not refetch while fresh, refetches once the TTL lapses', async () => {
    const f = mockFetchResolving(GOOD_PAYLOAD);

    await refreshIfStale();
    expect(f).toHaveBeenCalledTimes(1);

    // Still fresh → no network.
    await refreshIfStale();
    expect(f).toHaveBeenCalledTimes(1);

    // Past the ~60s TTL → background refetch.
    now += 61_000;
    await refreshIfStale();
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('invalidate()', () => {
  it('forces the next refreshIfStale to refetch (last-good kept meanwhile)', async () => {
    const f = mockFetchResolving(GOOD_PAYLOAD);
    await refreshIfStale();
    expect(f).toHaveBeenCalledTimes(1);

    invalidate();
    // Snapshot still readable (SWR keeps last-good until the refetch lands).
    expect(getRoutingSnapshot()).not.toBeNull();

    await refreshIfStale();
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('ensureWarm — one-time cold-start block', () => {
  it('awaits a single fetch on cold start, then no-ops once warm', async () => {
    const f = mockFetchResolving(GOOD_PAYLOAD);
    expect(getRoutingSnapshot()).toBeNull();

    await ensureWarm();
    expect(getRoutingSnapshot()).not.toBeNull();
    expect(f).toHaveBeenCalledTimes(1);

    // Warm → no second fetch (SWR/refreshIfStale handles staleness thereafter).
    await ensureWarm();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('no-ops under the kill switch (never fetches, stays null)', async () => {
    process.env.TENANT_ROUTING_SOURCE = 'registry';
    const f = mockFetchResolving(GOOD_PAYLOAD);
    await ensureWarm();
    expect(f).not.toHaveBeenCalled();
    expect(getRoutingSnapshot()).toBeNull();
  });
});

describe('invalidate() during an in-flight fetch', () => {
  it('is not lost — the next refresh still refetches (generation guard)', async () => {
    let resolveFetch!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolveFetch = r;
    });
    const f = vi
      .fn()
      .mockReturnValueOnce(pending) // fetch #1 stays in flight until we resolve it
      .mockResolvedValue({ ok: true, json: async () => GOOD_PAYLOAD });
    vi.stubGlobal('fetch', f);

    const first = refreshIfStale(); // dispatches fetch #1 (in flight)
    invalidate(); // arrives DURING the in-flight fetch → must not be swallowed
    resolveFetch({ ok: true, json: async () => GOOD_PAYLOAD });
    await first;
    expect(f).toHaveBeenCalledTimes(1);

    // Because the invalidate landed mid-flight, the stale flag survived → refetch.
    await refreshIfStale();
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('TENANT_ROUTING_SOURCE=registry kill switch', () => {
  it('disables the DB path — snapshot always null, fetch never called', async () => {
    process.env.TENANT_ROUTING_SOURCE = 'registry';
    const f = mockFetchResolving(GOOD_PAYLOAD);

    await refreshIfStale();
    expect(f).not.toHaveBeenCalled();
    expect(getRoutingSnapshot()).toBeNull();
  });

  it('default (unset) and explicit "db" enable the DB path', async () => {
    process.env.TENANT_ROUTING_SOURCE = 'db';
    mockFetchResolving(GOOD_PAYLOAD);
    await refreshIfStale();
    expect(getRoutingSnapshot()).not.toBeNull();
  });
});

describe('fail-safe fetch', () => {
  it('a non-OK response keeps the last-good snapshot (no throw)', async () => {
    mockFetchResolving(GOOD_PAYLOAD);
    await refreshIfStale();
    expect(getRoutingSnapshot()!.domainToSlug.get('deoleoloyalty.gifsy.in')).toBe('deoleo');

    invalidate();
    mockFetchResolving({}, false); // 5xx
    await expect(refreshIfStale()).resolves.toBeUndefined();
    // Last-good retained.
    expect(getRoutingSnapshot()!.domainToSlug.get('deoleoloyalty.gifsy.in')).toBe('deoleo');
  });

  it('a network rejection does not throw and leaves a cold cache null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    await expect(refreshIfStale()).resolves.toBeUndefined();
    expect(getRoutingSnapshot()).toBeNull();
  });

  it('a malformed payload (no tenants array) is ignored', async () => {
    mockFetchResolving({ data: {} });
    await refreshIfStale();
    expect(getRoutingSnapshot()).toBeNull();
  });
});
