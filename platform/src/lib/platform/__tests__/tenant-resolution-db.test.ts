/**
 * §A-DOMAIN Phase 2 — DB-aware tenant resolution tests.
 *
 * Split from tenant-resolution.test.ts (which pins the registry-only behaviour).
 * Here we test:
 *   - the PURE map-driven resolver (`resolveSlugFromDomainMap`): DB map wins over
 *     registry, all existing rules preserved;
 *   - the PURE branding overlay (`applyDbBranding`): non-empty DB field wins, empty
 *     DB field falls back to registry, DB-only tenant synthesises a config;
 *   - the snapshot-integrated `resolveTenantSync` / `resolveClientConfig` with a
 *     primed cache (fetch mocked — no real network) and the registry kill switch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveSlugFromDomainMap,
  applyDbBranding,
  resolveTenantSync,
  resolveTenant,
  resolveClientConfig,
  DEFAULT_DEV_SLUG,
} from '../tenant-resolution';
import { DEOLEO_CONFIG } from '../client-registry';
import { refreshIfStale, __resetRoutingCacheForTests } from '../tenant-routing-cache';
import type { PublicBranding } from '../tenant-routing-cache';

const EMPTY = new Map<string, string>();

// ── PURE resolver ────────────────────────────────────────────────────────────
describe('resolveSlugFromDomainMap (pure)', () => {
  it('DB map wins: a merged map maps a branded host to its DB slug', () => {
    // Simulates registry(deoleoloyalty→deoleo) with a DB override to another tenant.
    const merged = new Map([['deoleoloyalty.gifsy.in', 'newco']]);
    expect(resolveSlugFromDomainMap('deoleoloyalty.gifsy.in', merged)).toBe('newco');
  });

  it('map lookup wins over the subdomain heuristic', () => {
    const map = new Map([['weird.example.com', 'deoleo']]);
    expect(resolveSlugFromDomainMap('weird.example.com', map)).toBe('deoleo');
  });

  it('falls back to the subdomain heuristic when the map lacks the host', () => {
    expect(resolveSlugFromDomainMap('clientb.gifsy.in', EMPTY)).toBe('clientb');
  });

  it('preserves the operator-console rule (app.gifsy.in → gifsy)', () => {
    expect(resolveSlugFromDomainMap('app.gifsy.in', EMPTY)).toBe('gifsy');
    expect(resolveSlugFromDomainMap('uat.app.gifsy.in', EMPTY)).toBe('gifsy');
  });

  it('preserves localhost/empty → dev default', () => {
    expect(resolveSlugFromDomainMap('localhost', EMPTY)).toBe(DEFAULT_DEV_SLUG);
    expect(resolveSlugFromDomainMap('', EMPTY)).toBe(DEFAULT_DEV_SLUG);
  });

  it('preserves the uat.-prefix strip before the map lookup', () => {
    const map = new Map([['deoleoloyalty.gifsy.in', 'deoleo']]);
    expect(resolveSlugFromDomainMap('uat.deoleoloyalty.gifsy.in', map)).toBe('deoleo');
  });

  it('preserves reserved-label and bare-domain → null', () => {
    expect(resolveSlugFromDomainMap('admin.gifsy.in', EMPTY)).toBeNull();
    expect(resolveSlugFromDomainMap('gifsy.in', EMPTY)).toBeNull();
  });
});

// ── PURE branding overlay ──────────────────────────────────────────────────────
describe('applyDbBranding (pure)', () => {
  it('overlays a NON-EMPTY DB field over the registry, keeping the rest', () => {
    const db: PublicBranding = { primaryColor: '#000000', wordmarkColorUrl: 'https://cdn/wm.png' };
    const cfg = applyDbBranding('deoleo', DEOLEO_CONFIG, db);
    expect(cfg!.branding.primaryColor).toBe('#000000');
    expect(cfg!.branding.wordmarkColorUrl).toBe('https://cdn/wm.png');
    // Untouched registry fields survive.
    expect(cfg!.branding.displayName).toBe('Deoleo India');
    expect(cfg!.branding.logoUrl).toBe(DEOLEO_CONFIG.branding.logoUrl);
    // Non-branding config is preserved by reference-spread.
    expect(cfg!.features).toEqual(DEOLEO_CONFIG.features);
  });

  it('an EMPTY DB field falls back to the registry (the staging reality)', () => {
    const db: PublicBranding = { displayName: '', primaryColor: '', logoUrl: '' };
    const cfg = applyDbBranding('deoleo', DEOLEO_CONFIG, db);
    expect(cfg!.branding.displayName).toBe('Deoleo India');
    expect(cfg!.branding.primaryColor).toBe('#16a34a');
  });

  it('rejects a non-6-hex DB primaryColor and keeps the registry color (hex guard)', () => {
    for (const bad of ['red', '#fff', 'javascript:alert(1)', '#1234567', 'rgb(0,0,0)']) {
      const cfg = applyDbBranding('deoleo', DEOLEO_CONFIG, { primaryColor: bad });
      expect(cfg!.branding.primaryColor).toBe('#16a34a'); // registry retained
    }
    // A valid 6-hex value IS accepted.
    expect(applyDbBranding('deoleo', DEOLEO_CONFIG, { primaryColor: '#ABCDEF' })!.branding.primaryColor).toBe('#ABCDEF');
  });

  it('no DB branding at all returns the registry config unchanged', () => {
    expect(applyDbBranding('deoleo', DEOLEO_CONFIG, undefined)).toBe(DEOLEO_CONFIG);
  });

  it('synthesises a minimal config for a DB-only tenant (no registry entry)', () => {
    const db: PublicBranding = { displayName: 'New Co', primaryColor: '#123456', faviconUrl: 'https://cdn/fav.ico' };
    const cfg = applyDbBranding('newco', null, db);
    expect(cfg).not.toBeNull();
    expect(cfg!.slug).toBe('newco');
    expect(cfg!.branding.displayName).toBe('New Co');
    expect(cfg!.branding.primaryColor).toBe('#123456');
    expect(cfg!.branding.faviconUrl).toBe('https://cdn/fav.ico');
    // A full, renderable config is produced.
    expect(cfg!.partnerClasses.length).toBeGreaterThan(0);
    expect(cfg!.approvalHierarchy.levels.length).toBeGreaterThan(0);
  });

  it('unknown everywhere (no registry, no DB branding) → null (fail-closed)', () => {
    expect(applyDbBranding('ghost', null, undefined)).toBeNull();
    expect(applyDbBranding('ghost', null, {})).toBeNull();
    // All-empty DB branding is also "nothing to show" → null.
    expect(applyDbBranding('ghost', null, { displayName: '', primaryColor: '' })).toBeNull();
  });
});

// ── Snapshot-integrated resolution (fetch mocked) ──────────────────────────────
describe('resolveTenantSync / resolveClientConfig with a primed cache', () => {
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

  async function primeCache(tenants: unknown[]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { tenants } }) }));
    await refreshIfStale();
  }

  it('a DB branded domain (not in the registry) resolves to its tenant + DB branding', async () => {
    await primeCache([
      { slug: 'deoleo', status: 'ACTIVE', domains: ['deoleo-new-brand.com'], branding: { primaryColor: '#111111' } },
    ]);
    const { slug, config } = resolveTenantSync('deoleo-new-brand.com');
    expect(slug).toBe('deoleo');
    expect(config!.branding.primaryColor).toBe('#111111'); // DB overlaid
    expect(config!.branding.displayName).toBe('Deoleo India'); // registry retained
  });

  it('the registry custom-domain still resolves when the DB map lacks it (fallback ladder)', async () => {
    await primeCache([{ slug: 'deoleo', status: 'ACTIVE', domains: [], branding: {} }]);
    // deoleoloyalty.gifsy.in is only in the registry map, not the DB map here.
    expect(resolveTenantSync('deoleoloyalty.gifsy.in').slug).toBe('deoleo');
  });

  it('a DB-only tenant synthesises a config so it still renders', async () => {
    await primeCache([
      { slug: 'acme', status: 'ONBOARDING', domains: ['acme.example.com'], branding: { displayName: 'Acme Rewards', primaryColor: '#654321' } },
    ]);
    const { slug, config } = resolveTenantSync('acme.example.com');
    expect(slug).toBe('acme');
    expect(config).not.toBeNull();
    expect(config!.branding.displayName).toBe('Acme Rewards');
    expect(config!.branding.primaryColor).toBe('#654321');
  });

  it('empty DB branding does not clobber registry values via resolveClientConfig', async () => {
    await primeCache([
      { slug: 'deoleo', status: 'ACTIVE', domains: [], branding: { displayName: '', primaryColor: '' } },
    ]);
    const cfg = resolveClientConfig('deoleo');
    expect(cfg!.branding.displayName).toBe('Deoleo India');
    expect(cfg!.branding.primaryColor).toBe('#16a34a');
  });

  it('TENANT_ROUTING_SOURCE=registry ignores the DB path entirely', async () => {
    process.env.TENANT_ROUTING_SOURCE = 'registry';
    await primeCache([
      { slug: 'deoleo', status: 'ACTIVE', domains: ['deoleo-new-brand.com'], branding: { primaryColor: '#111111' } },
    ]);
    // DB map ignored → the branded DB-only host does not resolve to deoleo.
    expect(resolveTenantSync('deoleo-new-brand.com').slug).not.toBe('deoleo');
    // …and branding stays pure registry.
    expect(resolveClientConfig('deoleo')!.branding.primaryColor).toBe('#16a34a');
  });

  it('cold start (no snapshot) falls back to the registry', () => {
    // No primeCache — snapshot is null.
    const { slug, config } = resolveTenantSync('deoleoloyalty.gifsy.in');
    expect(slug).toBe('deoleo');
    expect(config!.branding.primaryColor).toBe('#16a34a');
  });

  it('SYNC cold resolution of a DB-only BRANDED host returns the bare label (the hazard resolveTenant fixes)', () => {
    // No cache warm: the sync path can only see the registry, which lacks this host,
    // so the subdomain heuristic returns the label — NOT the correct slug.
    expect(resolveTenantSync('clientbrewards.gifsy.in').slug).toBe('clientbrewards');
  });

  it('resolveTenant (async) block-warms the cache so a cold DB-only branded host resolves correctly', async () => {
    // Fresh instance (null snapshot). The endpoint maps the branded host → clientb.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            tenants: [
              { slug: 'clientb', status: 'ACTIVE', domains: ['clientbrewards.gifsy.in'], branding: { primaryColor: '#222222' } },
            ],
          },
        }),
      }),
    );
    // ensureWarm awaits the fetch on cold start → the DB map is available before resolving.
    const { slug, config } = await resolveTenant('clientbrewards.gifsy.in');
    expect(slug).toBe('clientb'); // correct DB slug, NOT the bare label
    expect(config!.branding.primaryColor).toBe('#222222');
  });
});
