// RBAC Option-X — reserved permission set.
// Run: npx jest src/common/rbac/reserved-permissions.spec.ts

import { RESERVED_PERMISSIONS, isReserved } from './reserved-permissions';
import { ALL_PERMISSIONS, isPermission } from './permissions';

describe('RESERVED_PERMISSIONS', () => {
  // The exact list from the design doc "Reserved set" section.
  const EXPECTED = [
    'wallet:adjust',
    'wallet:manage_expiry',
    'credits:upload',
    'credits:confirm_payout',
    'credits:download_bank_file',
    'credits:mark_paid',
    'credits:request_reversal',
    'credits:approve_reversal',
    'credits:manage_fields',
    'payouts:manage_fund',
    'payouts:process_batch',
    'payouts:reconcile',
    'invoices:manage',
    'invoices:upload',
    'tenancy:read',
    'tenancy:write',
    'tenancy:manage_flags',
    'users:manage_roles',
    'users:delete',
  ];

  it('matches the design-doc reserved set exactly (order-independent)', () => {
    expect([...RESERVED_PERMISSIONS].sort()).toEqual([...EXPECTED].sort());
  });

  it('has 19 entries and no duplicates', () => {
    expect(RESERVED_PERMISSIONS).toHaveLength(19);
    expect(new Set(RESERVED_PERMISSIONS).size).toBe(19);
  });

  it('contains only valid Permission keys', () => {
    for (const p of RESERVED_PERMISSIONS) {
      expect(isPermission(p)).toBe(true);
    }
  });

  it('does NOT reserve read-only finance keys (PM holds these)', () => {
    for (const p of ['credits:read', 'payouts:read', 'payouts:view_tds', 'invoices:read']) {
      expect(isReserved(p)).toBe(false);
    }
  });
});

describe('isReserved()', () => {
  it('returns true for every reserved key', () => {
    for (const p of RESERVED_PERMISSIONS) expect(isReserved(p)).toBe(true);
  });

  it('returns false for a non-reserved valid permission', () => {
    expect(isReserved('kyc:read')).toBe(false);
    expect(isReserved('rewards:write')).toBe(false);
  });

  it('returns false for an unknown / garbage key', () => {
    expect(isReserved('not:a:key')).toBe(false);
    expect(isReserved('')).toBe(false);
  });

  it('every non-reserved catalog permission is not reserved', () => {
    const reserved = new Set<string>(RESERVED_PERMISSIONS);
    for (const p of ALL_PERMISSIONS) {
      if (!reserved.has(p)) expect(isReserved(p)).toBe(false);
    }
  });
});
