/**
 * §A-DOMAIN "P5" — normalizeFeatures shapes a raw (possibly sparse) DB features
 * blob into a fully-populated FeatureFlags with conservative defaults, so FE
 * consumers can read nested keys (partnerApp.showLeaderboard) without null guards.
 */

import { describe, it, expect } from 'vitest';
import { normalizeFeatures, DEFAULT_FEATURES } from '../tenant-features';

describe('normalizeFeatures', () => {
  it('returns full DEFAULT_FEATURES for an empty / missing blob', () => {
    expect(normalizeFeatures(undefined)).toEqual(DEFAULT_FEATURES);
    expect(normalizeFeatures(null)).toEqual(DEFAULT_FEATURES);
    expect(normalizeFeatures({})).toEqual(DEFAULT_FEATURES);
  });

  it('always yields a nested partnerApp object even when the blob omits it', () => {
    const f = normalizeFeatures({ walletModule: true });
    expect(f.partnerApp).toBeDefined();
    expect(typeof f.partnerApp.showLeaderboard).toBe('boolean');
  });

  it('passes through real DB values over the defaults', () => {
    const f = normalizeFeatures({
      visibilityInvoiceModule: true,
      walletModule: false,
      partnerApp: { showLeaderboard: true },
    });
    expect(f.visibilityInvoiceModule).toBe(true);
    expect(f.walletModule).toBe(false);
    expect(f.partnerApp.showLeaderboard).toBe(true);
    // Unspecified partnerApp siblings fall back to defaults.
    expect(f.partnerApp.showWallet).toBe(DEFAULT_FEATURES.partnerApp.showWallet);
  });

  it('ignores non-boolean junk and falls back to the default for that key', () => {
    const f = normalizeFeatures({ walletModule: 'yes', partnerApp: { showLeaderboard: 1 } });
    expect(f.walletModule).toBe(DEFAULT_FEATURES.walletModule);
    expect(f.partnerApp.showLeaderboard).toBe(DEFAULT_FEATURES.partnerApp.showLeaderboard);
  });
});
