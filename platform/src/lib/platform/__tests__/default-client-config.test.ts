/**
 * §A-DOMAIN "P5" — the reduced CLIENT_REGISTRY + DEFAULT_CLIENT_CONFIG contract.
 *
 * Locks the invariants the reduction must preserve:
 *   - the registry entries inherit DEFAULT features (no rich per-tenant flags in code);
 *   - per-tenant BRANDING + the branded domain seed survive as the cold-start fallback;
 *   - resolveClientConfig returns a DEFAULT-based config OVERLAID with DB branding for a
 *     known slug, and null (fail-closed) for an unknown one;
 *   - the kill-switch domain→slug fallback still resolves deoleoloyalty.gifsy.in → deoleo.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_CLIENT_CONFIG } from '../default-client-config';
import { DEOLEO_CONFIG, CLIENT_B_CONFIG } from '../client-registry';
import { resolveSlugFromHostname, resolveClientConfig, applyDbBranding } from '../tenant-resolution';
import type { PublicBranding } from '../tenant-routing-cache';

describe('DEFAULT_CLIENT_CONFIG', () => {
  it('has a fully-shaped features blob with a nested partnerApp', () => {
    expect(DEFAULT_CLIENT_CONFIG.features.partnerApp).toBeDefined();
    // Conservative defaults: visibility OFF, wallet ON, leaderboard OFF.
    expect(DEFAULT_CLIENT_CONFIG.features.visibilityInvoiceModule).toBe(false);
    expect(DEFAULT_CLIENT_CONFIG.features.walletModule).toBe(true);
    expect(DEFAULT_CLIENT_CONFIG.features.partnerApp.showLeaderboard).toBe(false);
  });

  it('has neutral placeholder branding (real branding is DB-overlaid)', () => {
    expect(DEFAULT_CLIENT_CONFIG.branding.primaryColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(DEFAULT_CLIENT_CONFIG.slug).toBe('default');
  });
});

describe('reduced CLIENT_REGISTRY entries', () => {
  it('inherit DEFAULT features (per-tenant richness is DB-served, not in code)', () => {
    expect(DEOLEO_CONFIG.features).toEqual(DEFAULT_CLIENT_CONFIG.features);
    expect(CLIENT_B_CONFIG.features).toEqual(DEFAULT_CLIENT_CONFIG.features);
  });

  it('retain per-tenant branding + the branded domain seed for cold-start fallback', () => {
    expect(DEOLEO_CONFIG.branding.displayName).toBe('Deoleo India');
    expect(DEOLEO_CONFIG.domains).toContain('deoleoloyalty.gifsy.in');
    expect(CLIENT_B_CONFIG.branding.primaryColor).toBe('#2563eb');
  });
});

describe('resolveClientConfig with the reduced registry', () => {
  it('kill-switch fallback: the branded domain still resolves to its slug', () => {
    // Registry domain seed only (no DB snapshot primed in this pure test).
    expect(resolveSlugFromHostname('deoleoloyalty.gifsy.in')).toBe('deoleo');
  });

  it('returns a DEFAULT-based (branding-retained) config for a known slug', () => {
    const cfg = resolveClientConfig('deoleo');
    expect(cfg).not.toBeNull();
    expect(cfg!.features).toEqual(DEFAULT_CLIENT_CONFIG.features);
    expect(cfg!.branding.displayName).toBe('Deoleo India');
  });

  it('fail-closed: an unknown slug with no DB branding → null', () => {
    expect(resolveClientConfig('no-such-tenant')).toBeNull();
  });

  it('overlays DB branding on top of the DEFAULT-based registry config', () => {
    // applyDbBranding is the overlay primitive resolveClientConfig uses.
    const db: PublicBranding = { primaryColor: '#abcdef', wordmarkColorUrl: 'https://cdn/x.png' };
    const cfg = applyDbBranding('deoleo', DEOLEO_CONFIG, db);
    expect(cfg!.branding.primaryColor).toBe('#abcdef');
    expect(cfg!.branding.wordmarkColorUrl).toBe('https://cdn/x.png');
    // Non-branding config stays the DEFAULT-inherited registry value.
    expect(cfg!.features).toEqual(DEFAULT_CLIENT_CONFIG.features);
  });
});
