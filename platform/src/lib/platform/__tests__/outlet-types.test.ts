// TDD: outlet-types logic
// Tests written BEFORE implementation.
// Run: npx vitest run src/lib/platform/__tests__/outlet-types.test.ts

import { describe, it, expect } from 'vitest';
import {
  MASTER_OUTLET_TYPES,
  getActiveOutletTypes,
  canManageOutletTypes,
  applyOutletTypeRename,
  applyOutletTypeToggle,
  defaultOutletTypeClientConfig,
  getOutletTypeClientConfig,
  applyOutletTypeClientConfigUpdate,
  type OutletType,
  type OutletTypeClientConfig,
} from '../outlet-types';

// ── A. Master list ────────────────────────────────────────────────────────────

describe('A – MASTER_OUTLET_TYPES', () => {
  it('A1: contains exactly 4 outlet types', () => {
    expect(MASTER_OUTLET_TYPES).toHaveLength(4);
  });

  it('A2: includes RETAILER, WHOLESALER, SUB_STOCKIST, SSS_TOT codes', () => {
    const codes = MASTER_OUTLET_TYPES.map((t) => t.code);
    expect(codes).toContain('SSS');
    expect(codes).toContain('WHOLESALER');
    expect(codes).toContain('SUB_STOCKIST');
    expect(codes).toContain('SSS_TOT');
  });

  it('A3: all 4 are active by default', () => {
    expect(MASTER_OUTLET_TYPES.every((t) => t.isActive)).toBe(true);
  });

  it('A4: codes are stable identifiers — they must not be renamed by future tests', () => {
    // code ≠ name allows renaming the display label without touching the stable key
    const retailer = MASTER_OUTLET_TYPES.find((t) => t.code === 'SSS')!;
    expect(retailer.code).toBe('SSS');
    // name can be anything — the test just asserts it exists
    expect(retailer.name).toBeTruthy();
  });
});

// ── B. getActiveOutletTypes ────────────────────────────────────────────────────

describe('B – getActiveOutletTypes', () => {
  it('B1: returns all when all are active', () => {
    expect(getActiveOutletTypes(MASTER_OUTLET_TYPES)).toHaveLength(4);
  });

  it('B2: excludes inactive types', () => {
    const mixed: OutletType[] = [
      ...MASTER_OUTLET_TYPES.slice(0, 2),
      { ...MASTER_OUTLET_TYPES[2], isActive: false },
      { ...MASTER_OUTLET_TYPES[3], isActive: false },
    ];
    expect(getActiveOutletTypes(mixed)).toHaveLength(2);
  });

  it('B3: returns empty array when all are inactive', () => {
    const all = MASTER_OUTLET_TYPES.map((t) => ({ ...t, isActive: false }));
    expect(getActiveOutletTypes(all)).toHaveLength(0);
  });
});

// ── C. canManageOutletTypes ───────────────────────────────────────────────────

describe('C – canManageOutletTypes', () => {
  it('C1: GIFSY_ADMIN can manage outlet types', () => {
    expect(canManageOutletTypes('GIFSY_ADMIN')).toBe(true);
  });

  it('C2: CLIENT_ADMIN cannot manage outlet types', () => {
    expect(canManageOutletTypes('CLIENT_ADMIN')).toBe(false);
  });

  it('C3: any sales role cannot manage outlet types', () => {
    expect(canManageOutletTypes('SALES_SO')).toBe(false);
    expect(canManageOutletTypes('SALES_ASM')).toBe(false);
  });
});

// ── D. applyOutletTypeRename ──────────────────────────────────────────────────

describe('D – applyOutletTypeRename', () => {
  it('D1: renames display name while keeping code stable', () => {
    const result = applyOutletTypeRename(MASTER_OUTLET_TYPES, 'SSS', 'Dealer', 'GIFSY_ADMIN');
    const retailer = result.find((t) => t.code === 'SSS')!;
    expect(retailer.name).toBe('Dealer');
    expect(retailer.code).toBe('SSS');   // code unchanged
  });

  it('D2: returns a new array — does not mutate the original', () => {
    const original = MASTER_OUTLET_TYPES;
    const result = applyOutletTypeRename(original, 'SSS', 'Dealer', 'GIFSY_ADMIN');
    expect(result).not.toBe(original);
    expect(original.find((t) => t.code === 'SSS')!.name).not.toBe('Dealer');
  });

  it('D3: does not affect other outlet types', () => {
    const result = applyOutletTypeRename(MASTER_OUTLET_TYPES, 'SSS', 'Dealer', 'GIFSY_ADMIN');
    const wholesaler = result.find((t) => t.code === 'WHOLESALER')!;
    expect(wholesaler.name).toBe('Wholesaler');
  });

  it('D4: throws if caller is not GIFSY_ADMIN', () => {
    expect(() =>
      applyOutletTypeRename(MASTER_OUTLET_TYPES, 'SSS', 'Dealer', 'CLIENT_ADMIN')
    ).toThrow('GIFSY_ADMIN');
  });
});

// ── E. applyOutletTypeToggle ──────────────────────────────────────────────────

describe('E – applyOutletTypeToggle', () => {
  it('E1: deactivates an outlet type', () => {
    const result = applyOutletTypeToggle(MASTER_OUTLET_TYPES, 'WHOLESALER', false, 'GIFSY_ADMIN');
    expect(result.find((t) => t.code === 'WHOLESALER')!.isActive).toBe(false);
  });

  it('E2: reactivates an outlet type', () => {
    const deactivated = applyOutletTypeToggle(MASTER_OUTLET_TYPES, 'WHOLESALER', false, 'GIFSY_ADMIN');
    const reactivated = applyOutletTypeToggle(deactivated, 'WHOLESALER', true, 'GIFSY_ADMIN');
    expect(reactivated.find((t) => t.code === 'WHOLESALER')!.isActive).toBe(true);
  });

  it('E3: does not mutate original', () => {
    applyOutletTypeToggle(MASTER_OUTLET_TYPES, 'WHOLESALER', false, 'GIFSY_ADMIN');
    expect(MASTER_OUTLET_TYPES.find((t) => t.code === 'WHOLESALER')!.isActive).toBe(true);
  });

  it('E4: throws if caller is not GIFSY_ADMIN', () => {
    expect(() =>
      applyOutletTypeToggle(MASTER_OUTLET_TYPES, 'WHOLESALER', false, 'SALES_HO')
    ).toThrow('GIFSY_ADMIN');
  });
});

// ── F. OutletTypeClientConfig defaults ───────────────────────────────────────

describe('F – defaultOutletTypeClientConfig', () => {
  it('F1: all feature flags default to true', () => {
    const cfg = defaultOutletTypeClientConfig('deoleo', 'SSS');
    expect(cfg.isEnabled).toBe(true);
    expect(cfg.loyaltyEnabled).toBe(true);
    expect(cfg.schemesEnabled).toBe(true);
    expect(cfg.visibilityEnabled).toBe(true);
    expect(cfg.payoutsEnabled).toBe(true);
    expect(cfg.leaderboardEnabled).toBe(true);
    expect(cfg.targetsEnabled).toBe(true);
    expect(cfg.kycRequired).toBe(true);
  });

  it('F2: displayName defaults to null', () => {
    const cfg = defaultOutletTypeClientConfig('deoleo', 'SSS');
    expect(cfg.displayName).toBeNull();
  });

  it('F3: sets clientId and outletTypeCode correctly', () => {
    const cfg = defaultOutletTypeClientConfig('deoleo', 'WHOLESALER');
    expect(cfg.clientId).toBe('deoleo');
    expect(cfg.outletTypeCode).toBe('WHOLESALER');
  });
});

// ── G. getOutletTypeClientConfig ──────────────────────────────────────────────

describe('G – getOutletTypeClientConfig', () => {
  const configs: OutletTypeClientConfig[] = [
    {
      clientId: 'deoleo', outletTypeCode: 'SSS',
      isEnabled: true, displayName: 'Dealer',
      loyaltyEnabled: true, schemesEnabled: false,
      visibilityEnabled: true, payoutsEnabled: true,
      leaderboardEnabled: false, targetsEnabled: true, kycRequired: true,
    },
  ];

  it('G1: returns the matching config when it exists', () => {
    const result = getOutletTypeClientConfig('deoleo', 'SSS', configs);
    expect(result.displayName).toBe('Dealer');
    expect(result.schemesEnabled).toBe(false);
  });

  it('G2: returns defaults when no config exists for that client+code', () => {
    const result = getOutletTypeClientConfig('deoleo', 'WHOLESALER', configs);
    expect(result.schemesEnabled).toBe(true);   // default
    expect(result.displayName).toBeNull();
  });

  it('G3: configs from different clients do not cross-pollute', () => {
    const result = getOutletTypeClientConfig('clientb', 'SSS', configs);
    // clientb has no config → gets defaults, not deoleo's custom config
    expect(result.displayName).toBeNull();
    expect(result.schemesEnabled).toBe(true);
  });
});

// ── H. applyOutletTypeClientConfigUpdate ─────────────────────────────────────

describe('H – applyOutletTypeClientConfigUpdate', () => {
  const base = defaultOutletTypeClientConfig('deoleo', 'SSS');

  it('H1: GIFSY_ADMIN can update any feature flag', () => {
    const result = applyOutletTypeClientConfigUpdate(base, 'schemesEnabled', false, 'GIFSY_ADMIN');
    expect(result.schemesEnabled).toBe(false);
  });

  it('H2: CLIENT_ADMIN can also update tenant config flags', () => {
    const result = applyOutletTypeClientConfigUpdate(base, 'visibilityEnabled', false, 'CLIENT_ADMIN');
    expect(result.visibilityEnabled).toBe(false);
  });

  it('H3: does not mutate original config', () => {
    applyOutletTypeClientConfigUpdate(base, 'schemesEnabled', false, 'GIFSY_ADMIN');
    expect(base.schemesEnabled).toBe(true);
  });

  it('H4: SALES_HO cannot update tenant config', () => {
    expect(() =>
      applyOutletTypeClientConfigUpdate(base, 'schemesEnabled', false, 'SALES_HO')
    ).toThrow('Permission denied');
  });

  it('H5: toggling isEnabled disables the outlet type for that tenant', () => {
    const result = applyOutletTypeClientConfigUpdate(base, 'isEnabled', false, 'GIFSY_ADMIN');
    expect(result.isEnabled).toBe(false);
  });
});
