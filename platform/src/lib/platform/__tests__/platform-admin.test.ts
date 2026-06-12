/**
 * TDD tests for platform admin helpers — client onboarding validation,
 * feature flag update guards, and slug uniqueness checks.
 *
 * Run: npx vitest run src/lib/platform/__tests__/platform-admin.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  validateNewClientSlug,
  applyFeatureFlagUpdate,
  canClientAdminModify,
  buildClientSummary,
  type ClientSummary,
} from '../platform-admin';
import { DEOLEO_CONFIG, CLIENT_B_CONFIG, CLIENT_REGISTRY } from '../client-registry';
import type { ClientConfig } from '../client-config';

// ─────────────────────────────────────────────────────────────────────────────
// validateNewClientSlug
// ─────────────────────────────────────────────────────────────────────────────

describe('validateNewClientSlug', () => {
  it('accepts a valid new slug', () => {
    const errs = validateNewClientSlug('newclient', CLIENT_REGISTRY);
    expect(errs).toEqual([]);
  });

  it('rejects an already-taken slug', () => {
    const errs = validateNewClientSlug('deoleo', CLIENT_REGISTRY);
    expect(errs.some((e) => /taken|exist/i.test(e))).toBe(true);
  });

  it('rejects slugs with uppercase letters', () => {
    const errs = validateNewClientSlug('ClientA', CLIENT_REGISTRY);
    expect(errs.some((e) => /lowercase/i.test(e))).toBe(true);
  });

  it('rejects slugs with spaces', () => {
    const errs = validateNewClientSlug('my client', CLIENT_REGISTRY);
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects slugs shorter than 3 characters', () => {
    const errs = validateNewClientSlug('ab', CLIENT_REGISTRY);
    expect(errs.some((e) => /short|length|character/i.test(e))).toBe(true);
  });

  it('rejects slugs longer than 30 characters', () => {
    const errs = validateNewClientSlug('a'.repeat(31), CLIENT_REGISTRY);
    expect(errs.some((e) => /long|length|character/i.test(e))).toBe(true);
  });

  it('rejects reserved platform slugs', () => {
    for (const reserved of ['www', 'app', 'api', 'admin']) {
      const errs = validateNewClientSlug(reserved, CLIENT_REGISTRY);
      expect(errs.some((e) => /reserved/i.test(e))).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyFeatureFlagUpdate — GIFSY_ADMIN sets flags, CLIENT_ADMIN cannot
// ─────────────────────────────────────────────────────────────────────────────

describe('applyFeatureFlagUpdate', () => {
  it('GIFSY_ADMIN can turn off a feature', () => {
    const updated = applyFeatureFlagUpdate(
      DEOLEO_CONFIG,
      'walletModule',
      false,
      'GIFSY_ADMIN',
    );
    expect(updated.features.walletModule).toBe(false);
  });

  it('GIFSY_ADMIN can turn on a feature', () => {
    const updated = applyFeatureFlagUpdate(
      CLIENT_B_CONFIG,
      'visibilityInvoiceModule',
      true,
      'GIFSY_ADMIN',
    );
    expect(updated.features.visibilityInvoiceModule).toBe(true);
  });

  it('CLIENT_ADMIN cannot change any feature flag', () => {
    expect(() =>
      applyFeatureFlagUpdate(DEOLEO_CONFIG, 'walletModule', false, 'CLIENT_ADMIN'),
    ).toThrow(/permission|not allowed|gifsy/i);
  });

  it('does not mutate the original config', () => {
    const original = DEOLEO_CONFIG.features.walletModule;
    applyFeatureFlagUpdate(DEOLEO_CONFIG, 'walletModule', !original, 'GIFSY_ADMIN');
    expect(DEOLEO_CONFIG.features.walletModule).toBe(original);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// canClientAdminModify
// ─────────────────────────────────────────────────────────────────────────────

describe('canClientAdminModify', () => {
  it('CLIENT_ADMIN can modify branding display name', () => {
    expect(canClientAdminModify('branding.displayName')).toBe(false);
  });

  it('CLIENT_ADMIN cannot modify feature flags', () => {
    expect(canClientAdminModify('features.walletModule')).toBe(false);
  });

  it('CLIENT_ADMIN cannot modify invoicing', () => {
    expect(canClientAdminModify('invoicing.sellerLegalName')).toBe(false);
  });

  it('CLIENT_ADMIN cannot modify approval hierarchy', () => {
    expect(canClientAdminModify('approvalHierarchy')).toBe(false);
  });

  it('CLIENT_ADMIN cannot modify notifications config', () => {
    expect(canClientAdminModify('notifications.msg91AuthKey')).toBe(false);
  });

  // Everything is GIFSY_ADMIN only — CLIENT_ADMIN modifies nothing in config
  it('returns false for any config path', () => {
    const paths = ['branding', 'features', 'partnerClasses', 'wallet', 'slug'];
    for (const p of paths) {
      expect(canClientAdminModify(p)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildClientSummary
// ─────────────────────────────────────────────────────────────────────────────

describe('buildClientSummary', () => {
  it('returns a summary with the correct slug and name', () => {
    const summary: ClientSummary = buildClientSummary(DEOLEO_CONFIG);
    expect(summary.slug).toBe('deoleo');
    expect(summary.displayName).toBe(DEOLEO_CONFIG.branding.displayName);
  });

  it('counts enabled features correctly', () => {
    const deoleo  = buildClientSummary(DEOLEO_CONFIG);
    const clientb = buildClientSummary(CLIENT_B_CONFIG);
    // Deoleo has more features on than Client B
    expect(deoleo.enabledFeatureCount).toBeGreaterThan(clientb.enabledFeatureCount);
  });

  it('reflects the status from ClientConfig', () => {
    const summary = buildClientSummary(CLIENT_B_CONFIG);
    expect(summary.status).toBe('ONBOARDING');
  });
});
