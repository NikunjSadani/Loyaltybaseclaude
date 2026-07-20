/**
 * §A-DOMAIN Phase 6 — ACCEPTANCE regression slice (deterministic, in-gate).
 *
 * This is the resolver-layer half of the P6 acceptance criterion (A-DOMAIN-PLAN.md
 * §4 phase 6): "a 2nd tenant provisioned ENTIRELY via console/DB routes + renders;
 * cross-tenant isolation still green; Deoleo unaffected."
 *
 * It primes the routing cache with a payload shaped EXACTLY like the backend
 * `GET /v1/tenants/routing` response (see api/src/tenant-routing/tenant-routing.service.ts:
 * `{ data: { tenants: [{ slug, status, domains, branding }] } }`) and drives the
 * REAL resolver (`resolveTenantSync` / `resolveClientConfig`) — no browser, no
 * network (fetch is stubbed). It asserts, in ONE place mapped to the acceptance:
 *
 *   1. A 2nd tenant whose slug is PROVABLY NOT in CLIENT_REGISTRY routes purely from
 *      the DB map — for a BRANDED domain whose label ≠ slug (the deoleoloyalty→deoleo
 *      pattern), which the registry could never supply.
 *   2. That 2nd tenant's branding RESOLVES (synthesised from the DB branding).
 *   3. The routing DEPENDS on the DB, not the registry: under the
 *      `TENANT_ROUTING_SOURCE=registry` kill switch the same branded host no longer
 *      resolves to the slug.
 *   4. Deoleo is UNAFFECTED: its branded domain still → deoleo and its registry
 *      branding is intact even when the DB branding is empty (the staging reality).
 *   5. Resolver-layer cross-tenant isolation: neither tenant's domain ever resolves
 *      to the other.
 *
 * DATA-level cross-tenant isolation (a logged-in tenant-A user cannot READ tenant-B
 * rows) is a backend-scoping property, covered by the Playwright specs
 * `e2e/clientAdmin/cross-tenant.e2e.ts` + `e2e/clientbAdmin/cross-tenant.e2e.ts`
 * (both directions) and is intentionally NOT re-implemented here.
 *
 * A full browser load of a never-before-configured `*.gifsy.in` host (real DNS/edge)
 * is covered by the P3 live-edge verify (a never-configured probe host returned a
 * Next 404 through worker→frontend, i.e. fail-closed routing, not a CF black-hole)
 * and is deliberately NOT faked here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveTenantSync,
  resolveClientConfig,
} from '../tenant-resolution';
import { CLIENT_REGISTRY } from '../client-registry';
import { refreshIfStale, __resetRoutingCacheForTests } from '../tenant-routing-cache';

// A 2nd tenant provisioned ENTIRELY via DB — slug + branded domain that the code
// registry does NOT know about. `zenithco` must NOT be a CLIENT_REGISTRY key (the
// premise is self-checked in the first test so a future registry addition re-fails
// this file rather than silently making it vacuous).
const DB_ONLY_SLUG = 'zenithco';
const DB_ONLY_BRANDED_HOST = 'zenith-rewards.example.in'; // label ("zenith-rewards") ≠ slug ("zenithco")

// A routing payload shaped like the backend endpoint's response envelope. Deoleo's
// DB branding is deliberately EMPTY (the staging reality — deoleo branding lives in
// the registry); the 2nd tenant carries full DB branding.
const ROUTING_PAYLOAD = {
  success: true,
  data: {
    tenants: [
      {
        slug: 'deoleo',
        status: 'ACTIVE',
        domains: ['deoleoloyalty.gifsy.in', 'deoleo.gifsy.in'],
        branding: { displayName: '', primaryColor: '', logoUrl: '', wordmarkWhiteUrl: '', faviconUrl: '' },
      },
      {
        slug: DB_ONLY_SLUG,
        status: 'ONBOARDING',
        domains: [DB_ONLY_BRANDED_HOST, `${DB_ONLY_SLUG}.gifsy.in`],
        branding: { displayName: 'Zenith Rewards (DB)', primaryColor: '#7c3aed', faviconUrl: 'https://cdn/zenith.ico' },
      },
    ],
  },
};

async function primeRoutingCache(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
  await refreshIfStale();
}

describe('§A-DOMAIN P6 acceptance — DB-provisioned 2nd tenant routing (resolver layer)', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
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

  it('the 2nd tenant is NOT in the code registry (premise — DB is the only source)', () => {
    expect(CLIENT_REGISTRY[DB_ONLY_SLUG]).toBeUndefined();
  });

  it('(1) a DB-only tenant\'s BRANDED domain (label ≠ slug) routes to its slug PURELY from the DB map', async () => {
    await primeRoutingCache(ROUTING_PAYLOAD);
    const { slug } = resolveTenantSync(DB_ONLY_BRANDED_HOST);
    expect(slug).toBe(DB_ONLY_SLUG);
    // Its canonical subdomain resolves too.
    expect(resolveTenantSync(`${DB_ONLY_SLUG}.gifsy.in`).slug).toBe(DB_ONLY_SLUG);
  });

  it('(2) the DB-only tenant\'s BRANDING resolves (synthesised from the DB branding)', async () => {
    await primeRoutingCache(ROUTING_PAYLOAD);
    const { config } = resolveTenantSync(DB_ONLY_BRANDED_HOST);
    expect(config).not.toBeNull();
    expect(config!.slug).toBe(DB_ONLY_SLUG);
    expect(config!.branding.displayName).toBe('Zenith Rewards (DB)');
    expect(config!.branding.primaryColor).toBe('#7c3aed');
    expect(config!.branding.faviconUrl).toBe('https://cdn/zenith.ico');
  });

  it('(3) routing DEPENDS on the DB, not the registry: the kill switch stops the DB-only host resolving', async () => {
    process.env.TENANT_ROUTING_SOURCE = 'registry';
    await primeRoutingCache(ROUTING_PAYLOAD);
    // With the DB source disabled the branded host is unknown to the registry, so it
    // never resolves to the DB slug (it falls to the bare-domain/subdomain heuristic).
    expect(resolveTenantSync(DB_ONLY_BRANDED_HOST).slug).not.toBe(DB_ONLY_SLUG);
    // And there is no synthesised config for it — an unknown tenant fails closed.
    expect(resolveClientConfig(DB_ONLY_SLUG)).toBeNull();
  });

  it('(4) Deoleo is UNAFFECTED: branded domain still → deoleo, registry branding intact despite empty DB branding', async () => {
    await primeRoutingCache(ROUTING_PAYLOAD);
    const { slug, config } = resolveTenantSync('deoleoloyalty.gifsy.in');
    expect(slug).toBe('deoleo');
    // Empty DB branding must NOT clobber the registry — the sign-in screen still paints Deoleo green.
    expect(config!.branding.displayName).toBe('Deoleo India');
    expect(config!.branding.primaryColor).toBe('#16a34a');
    // The secondary deoleo subdomain resolves too.
    expect(resolveTenantSync('deoleo.gifsy.in').slug).toBe('deoleo');
  });

  it('(5) resolver-layer cross-tenant isolation: neither tenant\'s host resolves to the other', async () => {
    await primeRoutingCache(ROUTING_PAYLOAD);
    // deoleo's hosts never yield the 2nd tenant…
    expect(resolveTenantSync('deoleoloyalty.gifsy.in').slug).not.toBe(DB_ONLY_SLUG);
    expect(resolveTenantSync('deoleo.gifsy.in').slug).not.toBe(DB_ONLY_SLUG);
    // …and the 2nd tenant's hosts never yield deoleo.
    expect(resolveTenantSync(DB_ONLY_BRANDED_HOST).slug).not.toBe('deoleo');
    expect(resolveTenantSync(`${DB_ONLY_SLUG}.gifsy.in`).slug).not.toBe('deoleo');
  });
});
