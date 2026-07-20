/**
 * TDD tests for the ClientConfig type system and pure helper functions.
 * Run: npx vitest run src/lib/platform/__tests__/client-config.test.ts
 *
 * §A-DOMAIN "P5": the in-code CLIENT_REGISTRY is now a MINIMAL fallback — each entry
 * spreads DEFAULT_CLIENT_CONFIG and overrides only identity + branding. Rich
 * per-tenant features/partnerClasses/invoicing/hierarchy are DB-served, so the pure
 * helpers below are exercised against a local RICH_CONFIG fixture rather than the
 * (now minimal) DEOLEO_CONFIG seed.
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
import { DEFAULT_CLIENT_CONFIG } from '../default-client-config';

// A fully-populated config for exercising the pure helpers (independent of the
// reduced registry). Spreads DEFAULT then adds the rich fields the helpers read.
const RICH_CONFIG: ClientConfig = {
  ...DEFAULT_CLIENT_CONFIG,
  slug: 'rich',
  internalName: 'Rich Co',
  branding: { ...DEFAULT_CLIENT_CONFIG.branding, displayName: 'Rich Co', primaryColor: '#16a34a' },
  features: {
    ...DEFAULT_CLIENT_CONFIG.features,
    visibilityInvoiceModule: true,
    nonKycOutletCampaigns: true,
    multiLevelApproval: true,
  },
  partnerClasses: [
    { key: 'GOLD',     displayName: 'Gold',     color: '#d97706', order: 1 },
    { key: 'SILVER',   displayName: 'Silver',   color: '#6b7280', order: 2 },
    { key: 'STANDARD', displayName: 'Standard', color: '#2563eb', order: 3 },
  ],
  approvalHierarchy: {
    levels: [
      { roleKey: 'L1', displayName: 'Sales Officer', shortName: 'SO', canInitiateKyc: true, canApproveKyc: false, canViewAllOutlets: false },
      { roleKey: 'L2', displayName: 'Regional Sales Manager', shortName: 'RSM', canInitiateKyc: false, canApproveKyc: true, canViewAllOutlets: true },
    ],
    requireGifsyFinalApproval: true,
  },
  invoicing: { ...DEFAULT_CLIENT_CONFIG.invoicing, sellerGstin: '19AABCT1234A1ZX', sellerState: 'West Bengal' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Deoleo seed config — now a MINIMAL registry fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('DEOLEO_CONFIG seed (minimal registry fallback)', () => {
  it('has a valid slug', () => {
    expect(DEOLEO_CONFIG.slug).toBe('deoleo');
  });

  it('keeps the branded domain seed for cold-start domain→slug resolution', () => {
    expect(DEOLEO_CONFIG.domains).toContain('deoleoloyalty.gifsy.in');
  });

  it('keeps the tenant branding (cold-start fallback before the DB overlay warms)', () => {
    expect(DEOLEO_CONFIG.branding.primaryColor).toBe('#16a34a');
    expect(DEOLEO_CONFIG.branding.displayName).toBe('Deoleo India');
  });

  it('inherits DEFAULT (conservative) features — rich per-tenant flags are DB-served', () => {
    // The registry no longer carries per-tenant feature richness; it mirrors DEFAULT.
    expect(DEOLEO_CONFIG.features).toEqual(DEFAULT_CLIENT_CONFIG.features);
    expect(isFeatureEnabled(DEOLEO_CONFIG, 'walletModule')).toBe(true);
    expect(isFeatureEnabled(DEOLEO_CONFIG, 'visibilityInvoiceModule')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isFeatureEnabled
// ─────────────────────────────────────────────────────────────────────────────

describe('isFeatureEnabled', () => {
  const cfg = (overrides: Partial<ClientConfig['features']>): ClientConfig => ({
    ...RICH_CONFIG,
    features: { ...RICH_CONFIG.features, ...overrides },
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
      isFeatureEnabled(RICH_CONFIG, 'nonExistentFlag' as FeatureKey),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getApprovalLevel
// ─────────────────────────────────────────────────────────────────────────────

describe('getApprovalLevel', () => {
  it('returns the matching level', () => {
    const lvl = getApprovalLevel(RICH_CONFIG, 'L1');
    expect(lvl).not.toBeNull();
    expect(lvl!.roleKey).toBe('L1');
  });

  it('returns null for a non-existent level key', () => {
    expect(getApprovalLevel(RICH_CONFIG, 'L99')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPartnerClass
// ─────────────────────────────────────────────────────────────────────────────

describe('getPartnerClass', () => {
  it('returns the matching partner class config', () => {
    const gold = getPartnerClass(RICH_CONFIG, 'GOLD');
    expect(gold).not.toBeNull();
    expect(gold!.key).toBe('GOLD');
    expect(gold!.displayName).toBeDefined();
    expect(gold!.color).toBeDefined();
  });

  it('returns null for an unknown class key', () => {
    expect(getPartnerClass(RICH_CONFIG, 'DIAMOND')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateClientConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('validateClientConfig', () => {
  it('returns an error when slug is empty', () => {
    const errs = validateClientConfig({ ...RICH_CONFIG, slug: '' });
    expect(errs.some((e) => /slug/i.test(e))).toBe(true);
  });

  it('returns an error when displayName is empty', () => {
    const errs = validateClientConfig({
      ...RICH_CONFIG,
      branding: { ...RICH_CONFIG.branding, displayName: '' },
    });
    expect(errs.some((e) => /displayName|name/i.test(e))).toBe(true);
  });

  it('returns an error when primaryColor is not a valid hex', () => {
    const errs = validateClientConfig({
      ...RICH_CONFIG,
      branding: { ...RICH_CONFIG.branding, primaryColor: 'not-a-color' },
    });
    expect(errs.some((e) => /color/i.test(e))).toBe(true);
  });

  it('returns an error when approval hierarchy has zero levels', () => {
    const errs = validateClientConfig({
      ...RICH_CONFIG,
      approvalHierarchy: { ...RICH_CONFIG.approvalHierarchy, levels: [] },
    });
    expect(errs.some((e) => /level|hierarchy/i.test(e))).toBe(true);
  });

  it('returns an error when no partner classes are defined', () => {
    const errs = validateClientConfig({
      ...RICH_CONFIG,
      partnerClasses: [],
    });
    expect(errs.some((e) => /partner class/i.test(e))).toBe(true);
  });

  it('returns an error when invoicing seller name is empty', () => {
    const errs = validateClientConfig({
      ...RICH_CONFIG,
      invoicing: { ...RICH_CONFIG.invoicing, sellerLegalName: '' },
    });
    expect(errs.some((e) => /seller|invoic/i.test(e))).toBe(true);
  });

  it('a fully-populated rich config validates with zero errors', () => {
    expect(validateClientConfig(RICH_CONFIG)).toEqual([]);
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

  // ── AF-9: the output feeds a `<style dangerouslySetInnerHTML>` sink, so a
  //         malformed/attacker-controlled primaryColor must never break out of
  //         the <style> element. The builder falls back to a safe hex.
  it('AF-9: never emits a </style> or <script> breakout for a malicious color', () => {
    const evil: ClientConfig = {
      ...DEOLEO_CONFIG,
      branding: {
        ...DEOLEO_CONFIG.branding,
        primaryColor: 'red}</style><script>alert(1)</script>',
      },
    };
    const css = buildCssVariables(evil);
    expect(css).not.toContain('</style>');
    expect(css).not.toContain('<script>');
    expect(css).not.toContain('alert(1)');
    // Falls back to the safe default so the variable still renders.
    expect(css).toContain('#16a34a');
  });

  it('AF-9: the raw-interpolated --brand-primary is always a 6-digit hex', () => {
    for (const bad of ['', 'rgb(0,0,0)', '#xyzxyz', '#fff', 'green', '#12345', '#1234567']) {
      const css = buildCssVariables({
        ...DEOLEO_CONFIG,
        branding: { ...DEOLEO_CONFIG.branding, primaryColor: bad },
      });
      const m = /--brand-primary:\s*([^;]+);/.exec(css);
      expect(m).not.toBeNull();
      expect(m![1].trim()).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('AF-9: a valid custom hex still passes through untouched', () => {
    const css = buildCssVariables({
      ...DEOLEO_CONFIG,
      branding: { ...DEOLEO_CONFIG.branding, primaryColor: '#abcdef' },
    });
    expect(css).toContain('--brand-primary: #abcdef;');
  });
});
