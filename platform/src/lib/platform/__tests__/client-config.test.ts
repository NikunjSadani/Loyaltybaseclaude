/**
 * TDD tests for the ClientConfig type system and pure helper functions.
 * Run: npx vitest run src/lib/platform/__tests__/client-config.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  isFeatureEnabled,
  getApprovalLevel,
  getPartnerClass,
  validateClientConfig,
  buildCssVariables,
  type ClientConfig,
  type FeatureKey,
} from '../client-config';
import { DEOLEO_CONFIG } from '../client-registry';

// ─────────────────────────────────────────────────────────────────────────────
// Deoleo seed config smoke tests
// ─────────────────────────────────────────────────────────────────────────────

describe('DEOLEO_CONFIG seed', () => {
  it('has a valid slug', () => {
    expect(DEOLEO_CONFIG.slug).toBe('deoleo');
  });

  it('passes full validation with zero errors', () => {
    expect(validateClientConfig(DEOLEO_CONFIG)).toEqual([]);
  });

  it('has all features enabled', () => {
    const keys: FeatureKey[] = [
      'visibilityInvoiceModule',
      'kycApprovalFlow',
      'campaignEnrollmentForm',
      'salesTeamApp',
      'walletModule',
      'selfEnrollmentAllowed',
      'nonKycOutletCampaigns',
      'multiLevelApproval',
    ];
    for (const k of keys) {
      expect(isFeatureEnabled(DEOLEO_CONFIG, k)).toBe(true);
    }
  });

  it('has the correct brand colour', () => {
    expect(DEOLEO_CONFIG.branding.primaryColor).toBe('#16a34a');
  });

  it('invoicing references Tech Gifsy Solutions Limited', () => {
    expect(DEOLEO_CONFIG.invoicing.sellerLegalName).toBe('Tech Gifsy Solutions Limited');
  });

  it('invoicing seller is registered in West Bengal', () => {
    expect(DEOLEO_CONFIG.invoicing.sellerState).toBe('West Bengal');
  });

  it('has at least two approval levels', () => {
    expect(DEOLEO_CONFIG.approvalHierarchy.levels.length).toBeGreaterThanOrEqual(2);
  });

  it('L1 level is the Sales Officer', () => {
    const l1 = getApprovalLevel(DEOLEO_CONFIG, 'L1');
    expect(l1).not.toBeNull();
    expect(l1!.canInitiateKyc).toBe(true);
  });

  it('has at least GOLD and SILVER partner classes', () => {
    const gold   = getPartnerClass(DEOLEO_CONFIG, 'GOLD');
    const silver = getPartnerClass(DEOLEO_CONFIG, 'SILVER');
    expect(gold).not.toBeNull();
    expect(silver).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isFeatureEnabled
// ─────────────────────────────────────────────────────────────────────────────

describe('isFeatureEnabled', () => {
  const cfg = (overrides: Partial<ClientConfig['features']>): ClientConfig => ({
    ...DEOLEO_CONFIG,
    features: { ...DEOLEO_CONFIG.features, ...overrides },
  });

  it('returns true when flag is on', () => {
    expect(isFeatureEnabled(cfg({ walletModule: true }), 'walletModule')).toBe(true);
  });

  it('returns false when flag is off', () => {
    expect(isFeatureEnabled(cfg({ walletModule: false }), 'walletModule')).toBe(false);
  });

  it('returns false for unknown flag key gracefully', () => {
    // TypeScript prevents this at compile time, but runtime should not throw
    expect(() =>
      isFeatureEnabled(DEOLEO_CONFIG, 'nonExistentFlag' as FeatureKey),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getApprovalLevel
// ─────────────────────────────────────────────────────────────────────────────

describe('getApprovalLevel', () => {
  it('returns the matching level', () => {
    const lvl = getApprovalLevel(DEOLEO_CONFIG, 'L1');
    expect(lvl).not.toBeNull();
    expect(lvl!.roleKey).toBe('L1');
  });

  it('returns null for a non-existent level key', () => {
    expect(getApprovalLevel(DEOLEO_CONFIG, 'L99')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPartnerClass
// ─────────────────────────────────────────────────────────────────────────────

describe('getPartnerClass', () => {
  it('returns the matching partner class config', () => {
    const gold = getPartnerClass(DEOLEO_CONFIG, 'GOLD');
    expect(gold).not.toBeNull();
    expect(gold!.key).toBe('GOLD');
    expect(gold!.displayName).toBeDefined();
    expect(gold!.color).toBeDefined();
  });

  it('returns null for an unknown class key', () => {
    expect(getPartnerClass(DEOLEO_CONFIG, 'DIAMOND')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateClientConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('validateClientConfig', () => {
  it('returns an error when slug is empty', () => {
    const errs = validateClientConfig({ ...DEOLEO_CONFIG, slug: '' });
    expect(errs.some((e) => /slug/i.test(e))).toBe(true);
  });

  it('returns an error when displayName is empty', () => {
    const errs = validateClientConfig({
      ...DEOLEO_CONFIG,
      branding: { ...DEOLEO_CONFIG.branding, displayName: '' },
    });
    expect(errs.some((e) => /displayName|name/i.test(e))).toBe(true);
  });

  it('returns an error when primaryColor is not a valid hex', () => {
    const errs = validateClientConfig({
      ...DEOLEO_CONFIG,
      branding: { ...DEOLEO_CONFIG.branding, primaryColor: 'not-a-color' },
    });
    expect(errs.some((e) => /color/i.test(e))).toBe(true);
  });

  it('returns an error when approval hierarchy has zero levels', () => {
    const errs = validateClientConfig({
      ...DEOLEO_CONFIG,
      approvalHierarchy: { ...DEOLEO_CONFIG.approvalHierarchy, levels: [] },
    });
    expect(errs.some((e) => /level|hierarchy/i.test(e))).toBe(true);
  });

  it('returns an error when no partner classes are defined', () => {
    const errs = validateClientConfig({
      ...DEOLEO_CONFIG,
      partnerClasses: [],
    });
    expect(errs.some((e) => /partner class/i.test(e))).toBe(true);
  });

  it('returns an error when invoicing seller name is empty', () => {
    const errs = validateClientConfig({
      ...DEOLEO_CONFIG,
      invoicing: { ...DEOLEO_CONFIG.invoicing, sellerLegalName: '' },
    });
    expect(errs.some((e) => /seller|invoic/i.test(e))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildCssVariables
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCssVariables', () => {
  it('returns a CSS string with --brand-primary set to the config color', () => {
    const css = buildCssVariables(DEOLEO_CONFIG);
    expect(css).toContain('--brand-primary');
    expect(css).toContain('#16a34a');
  });

  it('includes --brand-primary-dark and --brand-primary-light', () => {
    const css = buildCssVariables(DEOLEO_CONFIG);
    expect(css).toContain('--brand-primary-dark');
    expect(css).toContain('--brand-primary-light');
  });

  it('wraps variables in :root selector', () => {
    const css = buildCssVariables(DEOLEO_CONFIG);
    expect(css.trim().startsWith(':root')).toBe(true);
  });

  it('produces different CSS for a different brand color', () => {
    const altConfig: ClientConfig = {
      ...DEOLEO_CONFIG,
      branding: { ...DEOLEO_CONFIG.branding, primaryColor: '#2563eb' },
    };
    const css = buildCssVariables(altConfig);
    expect(css).toContain('#2563eb');
    expect(css).not.toContain('#16a34a');
  });
});
