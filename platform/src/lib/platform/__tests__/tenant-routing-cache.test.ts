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
  refreshOnMiss,
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

describe('failure backoff — a down API is not retried on every render', () => {
  it('NO snapshot yet (cold instance): only a SHORT ~3s backoff, so DB-only tenants recover fast', async () => {
    const f = vi.fn().mockRejectedValue(new Error('down'));
    vi.stubGlobal('fetch', f);
    await ensureWarm();
    expect(f).toHaveBeenCalledTimes(1);

    now += 2_999;
    await ensureWarm();
    await refreshIfStale();
    expect(f).toHaveBeenCalledTimes(1);
    expect(getRoutingSnapshot()).toBeNull(); // registry fallback meanwhile

    now += 2;
    f.mockResolvedValue({ ok: true, json: async () => GOOD_PAYLOAD });
    await ensureWarm();
    expect(f).toHaveBeenCalledTimes(2);
    expect(getRoutingSnapshot()).not.toBeNull();
  });

  it('NO snapshot yet: refreshOnMiss is still allowed once the 5s miss floor passes', async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error('cold timeout'));
    vi.stubGlobal('fetch', f);
    await ensureWarm(); // the one cold-API timeout
    now += 5_001;
    f.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { tenants: [{ slug: 'bajaj', status: 'ACTIVE', domains: [], branding: { displayName: 'Bajaj' } }] } }),
    });
    await refreshOnMiss();
    expect(f).toHaveBeenCalledTimes(2);
    expect(getRoutingSnapshot()?.slugToBranding.get('bajaj')).toEqual({ displayName: 'Bajaj' });
  });

  it('WITH a last-good snapshot: a failed refresh backs off the full 30s (SWR + miss), last-good kept', async () => {
    const f = mockFetchResolving(GOOD_PAYLOAD);
    await refreshIfStale();
    const good = getRoutingSnapshot();
    now += 61_000;
    f.mockResolvedValue({ ok: false, json: async () => ({}) });
    await refreshIfStale();
    expect(f).toHaveBeenCalledTimes(2);
    now += 10_000;
    await refreshIfStale();
    await refreshOnMiss();
    expect(f).toHaveBeenCalledTimes(2); // backing off
    expect(getRoutingSnapshot()).toBe(good);
    now += 20_001;
    await refreshIfStale();
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('a success clears the backoff (normal 60s TTL resumes)', async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error('down'));
    vi.stubGlobal('fetch', f);
    await refreshIfStale();
    now += 30_001;
    f.mockResolvedValue({ ok: true, json: async () => GOOD_PAYLOAD });
    await refreshIfStale();
    now += 60_001;
    await refreshIfStale();
    expect(f).toHaveBeenCalledTimes(3);
  });

  // invalidate() has no production caller today (tenant create/edit runs in the API, not a
  // Next server action); this pins its contract for any future same-process caller.
  it('invalidate() bypasses the backoff', async () => {
    const f = vi.fn().mockRejectedValue(new Error('down'));
    vi.stubGlobal('fetch', f);
    await refreshIfStale();
    invalidate();
    await refreshIfStale();
    expect(f).toHaveBeenCalledTimes(2);
  });
});

// ── Render-path miss refresh (a tenant created AFTER this instance warmed) ────────────────
describe('refreshOnMiss — awaited, coalesced, throttled, bounded, never throws', () => {
  it('forces a refetch even while the snapshot is still inside its TTL (new tenant appears now)', async () => {
    const f = mockFetchResolving(GOOD_PAYLOAD);
    await refreshIfStale();
    expect(f).toHaveBeenCalledTimes(1);

    now += 10_000; // fresh (< 60s TTL) but older than the 5s miss floor
    f.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { tenants: [...GOOD_PAYLOAD.data.tenants, { slug: 'bajaj', status: 'ACTIVE', domains: [], branding: { displayName: 'Bajaj' } }] },
      }),
    });
    await refreshOnMiss();
    expect(f).toHaveBeenCalledTimes(2);
    expect(getRoutingSnapshot()?.slugToBranding.get('bajaj')).toEqual({ displayName: 'Bajaj' });
  });

  it('does NOT refetch when the snapshot was fetched < 5s ago (a genuine miss stays a miss)', async () => {
    const f = mockFetchResolving(GOOD_PAYLOAD);
    await refreshIfStale();
    now += 1_000;
    await refreshOnMiss();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('throttles repeated misses to one fetch per 5s even when fetches keep failing (no snapshot)', async () => {
    const f = vi.fn().mockRejectedValue(new Error('down'));
    vi.stubGlobal('fetch', f);
    await refreshOnMiss();
    await refreshOnMiss();
    await refreshOnMiss();
    expect(f).toHaveBeenCalledTimes(1);
    expect(getRoutingSnapshot()).toBeNull(); // failure → unchanged (registry fallback)
    now += 5_001;
    await refreshOnMiss(); // no snapshot → only the short backoff, so the 5s floor governs
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent misses onto ONE fetch', async () => {
    const f = mockFetchResolving(GOOD_PAYLOAD);
    await Promise.all([refreshOnMiss(), refreshOnMiss(), refreshOnMiss(), refreshIfStale()]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('keeps the last-good snapshot on a non-OK / malformed response and resolves', async () => {
    const f = mockFetchResolving(GOOD_PAYLOAD);
    await refreshIfStale();
    const before = getRoutingSnapshot();
    now += 10_000;
    f.mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(refreshOnMiss()).resolves.toBeUndefined();
    expect(getRoutingSnapshot()).toBe(before);
  });

  it('never waits longer than ~2s even if fetch ignores its abort signal (no hung render)', async () => {
    // Fake ONLY the timers (Date.now stays on the deterministic spy) — no wall clock involved.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // never settles
      let done = false;
      const p = refreshOnMiss().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a no-op under TENANT_ROUTING_SOURCE=registry', async () => {
    process.env.TENANT_ROUTING_SOURCE = 'registry';
    const f = mockFetchResolving(GOOD_PAYLOAD);
    await refreshOnMiss();
    expect(f).not.toHaveBeenCalled();
  });
});
