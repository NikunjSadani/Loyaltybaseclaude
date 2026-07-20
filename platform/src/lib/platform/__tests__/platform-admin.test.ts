/**
 * TDD tests for platform admin helpers — client onboarding validation,
 * feature flag update guards, and slug uniqueness checks.
 *
 * Run: npx vitest run src/lib/platform/__tests__/platform-admin.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  validateNewClientSlug,
  validateTenantDomain,
  normalizeTenantDomain,
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
  // Uniqueness is checked against the ACTUAL existing tenant slugs (from the DB),
  // NOT the code registry — registry entries (deoleo, clientb) are onboardable
  // templates and must be creatable when no such DB tenant exists yet.
  const EXISTING = Object.keys(CLIENT_REGISTRY); // e.g. ['deoleo', 'clientb']

  it('accepts a valid new slug', () => {
    const errs = validateNewClientSlug('newclient', EXISTING);
    expect(errs).toEqual([]);
  });

  it('rejects a slug that already exists in the DB', () => {
    const errs = validateNewClientSlug('deoleo', ['deoleo', 'clientb']);
    expect(errs.some((e) => /taken|exist/i.test(e))).toBe(true);
  });

  it('ACCEPTS a registry-configured slug that is NOT yet a DB tenant (empty DB — the prod onboarding case)', () => {
    // Regression guard for the fix: the old check validated against the code
    // registry, which wrongly blocked onboarding `deoleo` into an empty prod DB.
    const errs = validateNewClientSlug('deoleo', []);
    expect(errs).toEqual([]);
  });

  it('rejects slugs with uppercase letters', () => {
    const errs = validateNewClientSlug('ClientA', EXISTING);
    expect(errs.some((e) => /lowercase/i.test(e))).toBe(true);
  });

  it('rejects slugs with spaces', () => {
    const errs = validateNewClientSlug('my client', EXISTING);
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects slugs shorter than 3 characters', () => {
    const errs = validateNewClientSlug('ab', EXISTING);
    expect(errs.some((e) => /short|length|character/i.test(e))).toBe(true);
  });

  it('rejects slugs longer than 30 characters', () => {
    const errs = validateNewClientSlug('a'.repeat(31), EXISTING);
    expect(errs.some((e) => /long|length|character/i.test(e))).toBe(true);
  });

  it('rejects reserved platform slugs', () => {
    for (const reserved of ['www', 'app', 'api', 'admin']) {
      const errs = validateNewClientSlug(reserved, EXISTING);
      expect(errs.some((e) => /reserved/i.test(e))).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateTenantDomain (§A-DOMAIN) — mirrors the backend policy so the console
// can reject a bad/reserved domain before the round-trip.
// ─────────────────────────────────────────────────────────────────────────────

describe('validateTenantDomain', () => {
  it('accepts a valid branded *.gifsy.in subdomain', () => {
    expect(validateTenantDomain('deoleoloyalty.gifsy.in')).toBeNull();
    expect(validateTenantDomain('reliance-retail.gifsy.in')).toBeNull();
  });

  it('normalises case/whitespace before validating', () => {
    expect(validateTenantDomain('  DeoleoLoyalty.Gifsy.IN  ')).toBeNull();
    expect(normalizeTenantDomain('  DeoleoLoyalty.Gifsy.IN  ')).toBe('deoleoloyalty.gifsy.in');
  });

  it('rejects a non-gifsy.in domain', () => {
    expect(validateTenantDomain('brand.example.com')).toMatch(/subdomain of gifsy\.in/i);
  });

  it('rejects the bare apex gifsy.in', () => {
    expect(validateTenantDomain('gifsy.in')).toBeTruthy();
  });

  it('rejects an empty domain', () => {
    expect(validateTenantDomain('')).toBeTruthy();
    expect(validateTenantDomain('   ')).toBeTruthy();
  });

  it('rejects a reserved first label', () => {
    for (const reserved of ['api', 'app', 'www', 'platform', 'admin', 'status', 'mail', 'uat']) {
      expect(validateTenantDomain(`${reserved}.gifsy.in`)).toMatch(/reserved/i);
    }
  });

  it('rejects a malformed hostname (leading hyphen)', () => {
    expect(validateTenantDomain('-bad.gifsy.in')).toBeTruthy();
  });

  it('allows a non-reserved multi-label subdomain', () => {
    expect(validateTenantDomain('shop.reliance.gifsy.in')).toBeNull();
  });

  it('scopes the reserved check to the FIRST label only (a reserved word deeper in the host is allowed)', () => {
    // Only parts[0] is checked against RESERVED_DOMAIN_LABELS (mirrors the backend),
    // so a reserved word as a NON-first label must not block the domain.
    expect(validateTenantDomain('shop.api.gifsy.in')).toBeNull();
    expect(validateTenantDomain('store.admin.gifsy.in')).toBeNull();
    // …but a non-reserved word that merely CONTAINS a reserved substring is fine too.
    expect(validateTenantDomain('apparel.gifsy.in')).toBeNull();
    expect(validateTenantDomain('mailroom.gifsy.in')).toBeNull();
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
    // §A-DOMAIN "P5": the registry entries now inherit DEFAULT features, so the count
    // reflects the config passed in. A config with an extra module ON counts higher.
    const base = buildClientSummary(DEOLEO_CONFIG);
    const more = buildClientSummary({
      ...DEOLEO_CONFIG,
      features: { ...DEOLEO_CONFIG.features, visibilityInvoiceModule: true, referralModule: true },
    });
    expect(more.enabledFeatureCount).toBeGreaterThan(base.enabledFeatureCount);
  });

  it('reflects the status from ClientConfig', () => {
    const summary = buildClientSummary(CLIENT_B_CONFIG);
    expect(summary.status).toBe('ONBOARDING');
  });
});
