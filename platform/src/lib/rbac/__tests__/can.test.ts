/**
 * Task 1.6a — RBAC Permission Engine tests (pure, no DB/network)
 *
 * Contract under test:
 *   - DEFAULT_ROLE_PERMISSIONS contains the correct set for each role
 *   - GIFSY_ADMIN has every permission
 *   - CLIENT_ADMIN has everything except tenancy:write / tenancy:manage_flags
 *   - MIS_USER has only :read perms + reports:export
 *   - SALES_* and partner roles default to []
 *   - permissionsForRole() resolves defaults and tenant overrides correctly
 *   - can() returns true/false correctly
 *   - Unknown role → [] / false
 *   - Sanity: every default set is a subset of ALL_PERMISSIONS (no stray keys)
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  permissionsForRole,
  can,
  type TenantRoleOverrides,
} from '../can';
import { ALL_PERMISSIONS, type Permission } from '../permissions';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ALL_SET = new Set<string>(ALL_PERMISSIONS);

function isSubsetOfAllPermissions(perms: Permission[]): boolean {
  return perms.every((p) => ALL_SET.has(p));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sanity: every default set is a subset of ALL_PERMISSIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('DEFAULT_ROLE_PERMISSIONS — sanity', () => {
  it('every role default set contains only known Permission values', () => {
    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      expect(
        isSubsetOfAllPermissions(perms),
        `Role "${role}" default set contains unknown permission(s): ${
          perms.filter((p) => !ALL_SET.has(p)).join(', ')
        }`,
      ).toBe(true);
    }
  });

  it('covers all 11 UserRole values', () => {
    const expectedRoles = [
      'GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER',
      'SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR',
      'SSS', 'WHOLESALER', 'SUB_STOCKIST',
    ];
    for (const role of expectedRoles) {
      expect(
        Object.prototype.hasOwnProperty.call(DEFAULT_ROLE_PERMISSIONS, role),
        `DEFAULT_ROLE_PERMISSIONS is missing role "${role}"`,
      ).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GIFSY_ADMIN
// ─────────────────────────────────────────────────────────────────────────────

describe('GIFSY_ADMIN', () => {
  it('has every permission in the catalog', () => {
    const set = new Set(DEFAULT_ROLE_PERMISSIONS.GIFSY_ADMIN);
    for (const p of ALL_PERMISSIONS) {
      expect(set.has(p), `GIFSY_ADMIN missing "${p}"`).toBe(true);
    }
  });

  it('can() returns true for tenancy:write', () => {
    expect(can('GIFSY_ADMIN', 'tenancy:write')).toBe(true);
  });

  it('can() returns true for tenancy:manage_flags', () => {
    expect(can('GIFSY_ADMIN', 'tenancy:manage_flags')).toBe(true);
  });

  it('can() returns true for users:delete', () => {
    expect(can('GIFSY_ADMIN', 'users:delete')).toBe(true);
  });

  it('can() returns true for kyc:gifsy_approve', () => {
    expect(can('GIFSY_ADMIN', 'kyc:gifsy_approve')).toBe(true);
  });

  it('can() returns true for credits:mark_paid', () => {
    expect(can('GIFSY_ADMIN', 'credits:mark_paid')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT_ADMIN
// ─────────────────────────────────────────────────────────────────────────────

describe('CLIENT_ADMIN', () => {
  it('has tenancy:read', () => {
    expect(can('CLIENT_ADMIN', 'tenancy:read')).toBe(true);
  });

  it('does NOT have tenancy:write', () => {
    expect(can('CLIENT_ADMIN', 'tenancy:write')).toBe(false);
  });

  it('does NOT have tenancy:manage_flags', () => {
    expect(can('CLIENT_ADMIN', 'tenancy:manage_flags')).toBe(false);
  });

  it('has users:write', () => {
    expect(can('CLIENT_ADMIN', 'users:write')).toBe(true);
  });

  it('has kyc:approve', () => {
    expect(can('CLIENT_ADMIN', 'kyc:approve')).toBe(true);
  });

  it('has reports:export', () => {
    expect(can('CLIENT_ADMIN', 'reports:export')).toBe(true);
  });

  it('has credits:confirm_payout', () => {
    expect(can('CLIENT_ADMIN', 'credits:confirm_payout')).toBe(true);
  });

  it('has payouts:manage_fund', () => {
    expect(can('CLIENT_ADMIN', 'payouts:manage_fund')).toBe(true);
  });

  it('has all permissions that are NOT tenancy:write or tenancy:manage_flags', () => {
    const excluded = new Set(['tenancy:write', 'tenancy:manage_flags']);
    const clientAdminSet = new Set(DEFAULT_ROLE_PERMISSIONS.CLIENT_ADMIN);
    for (const p of ALL_PERMISSIONS) {
      if (excluded.has(p)) {
        expect(clientAdminSet.has(p), `CLIENT_ADMIN should NOT have "${p}"`).toBe(false);
      } else {
        expect(clientAdminSet.has(p), `CLIENT_ADMIN should have "${p}"`).toBe(true);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MIS_USER
// ─────────────────────────────────────────────────────────────────────────────

describe('MIS_USER', () => {
  it('has reports:read', () => {
    expect(can('MIS_USER', 'reports:read')).toBe(true);
  });

  it('has users:read', () => {
    expect(can('MIS_USER', 'users:read')).toBe(true);
  });

  it('has reports:export', () => {
    expect(can('MIS_USER', 'reports:export')).toBe(true);
  });

  it('has every :read permission from the catalog', () => {
    const readPerms = ALL_PERMISSIONS.filter((p) => p.endsWith(':read'));
    for (const p of readPerms) {
      expect(can('MIS_USER', p), `MIS_USER missing read perm "${p}"`).toBe(true);
    }
  });

  it('does NOT have users:write', () => {
    expect(can('MIS_USER', 'users:write')).toBe(false);
  });

  it('does NOT have kyc:approve', () => {
    expect(can('MIS_USER', 'kyc:approve')).toBe(false);
  });

  it('does NOT have tenancy:write', () => {
    expect(can('MIS_USER', 'tenancy:write')).toBe(false);
  });

  it('does NOT have credits:upload', () => {
    expect(can('MIS_USER', 'credits:upload')).toBe(false);
  });

  it('does NOT have reports:manage_scheduled', () => {
    expect(can('MIS_USER', 'reports:manage_scheduled')).toBe(false);
  });

  it('its permission set contains only :read perms and reports:export', () => {
    const misPerms = DEFAULT_ROLE_PERMISSIONS.MIS_USER;
    for (const p of misPerms) {
      const isReadPerm = p.endsWith(':read');
      const isReportsExport = p === 'reports:export';
      expect(
        isReadPerm || isReportsExport,
        `MIS_USER should not have "${p}" (not a :read or reports:export)`,
      ).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SALES_* roles — empty by default
// ─────────────────────────────────────────────────────────────────────────────

describe('SALES_* roles — empty default', () => {
  const salesRoles = ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'] as const;

  it('all SALES_* roles default to an empty permission set', () => {
    for (const role of salesRoles) {
      expect(
        permissionsForRole(role).length,
        `${role} should default to [] but has ${permissionsForRole(role).length} perms`,
      ).toBe(0);
    }
  });

  it('can() returns false for SALES_HO on any permission', () => {
    expect(can('SALES_HO', 'reports:read')).toBe(false);
    expect(can('SALES_HO', 'users:read')).toBe(false);
    expect(can('SALES_HO', 'tenancy:read')).toBe(false);
  });

  it('can() returns false for SALES_SO on any permission', () => {
    expect(can('SALES_SO', 'sales_org:read')).toBe(false);
    expect(can('SALES_SO', 'kyc:read')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Partner roles — empty by default
// ─────────────────────────────────────────────────────────────────────────────

describe('Partner roles (SSS, WHOLESALER, SUB_STOCKIST) — empty default', () => {
  const partnerRoles = ['SSS', 'WHOLESALER', 'SUB_STOCKIST'] as const;

  it('all partner roles default to an empty permission set', () => {
    for (const role of partnerRoles) {
      expect(
        permissionsForRole(role).length,
        `${role} should default to [] but has ${permissionsForRole(role).length} perms`,
      ).toBe(0);
    }
  });

  it('can() returns false for SSS on any permission', () => {
    expect(can('SSS', 'reports:read')).toBe(false);
    expect(can('SSS', 'wallet:read')).toBe(false);
    expect(can('SSS', 'partners:read')).toBe(false);
  });

  it('can() returns false for WHOLESALER on any permission', () => {
    expect(can('WHOLESALER', 'rewards:read')).toBe(false);
  });

  it('can() returns false for SUB_STOCKIST on any permission', () => {
    expect(can('SUB_STOCKIST', 'kyc:read')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unknown role
// ─────────────────────────────────────────────────────────────────────────────

describe('unknown role', () => {
  it('permissionsForRole returns [] for an unknown role string', () => {
    expect(permissionsForRole('SUPER_DUPER_ADMIN')).toEqual([]);
    expect(permissionsForRole('')).toEqual([]);
    expect(permissionsForRole('gifsy_admin')).toEqual([]); // case-sensitive
  });

  it('can() returns false for an unknown role', () => {
    expect(can('NOT_A_ROLE', 'users:read')).toBe(false);
    expect(can('', 'reports:read')).toBe(false);
    expect(can('client_admin', 'users:write')).toBe(false); // case-sensitive
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant overrides
// ─────────────────────────────────────────────────────────────────────────────

describe('tenant overrides', () => {
  it('granting a perm to MIS_USER via override makes can() true', () => {
    const overrides: TenantRoleOverrides = {
      MIS_USER: [...DEFAULT_ROLE_PERMISSIONS.MIS_USER, 'reports:manage_scheduled'],
    };
    // Normally MIS_USER cannot manage scheduled reports
    expect(can('MIS_USER', 'reports:manage_scheduled')).toBe(false);
    // With override it can
    expect(can('MIS_USER', 'reports:manage_scheduled', overrides)).toBe(true);
  });

  it('revoking a perm from CLIENT_ADMIN via override makes can() false', () => {
    // Strip kyc:approve from CLIENT_ADMIN
    const overrides: TenantRoleOverrides = {
      CLIENT_ADMIN: DEFAULT_ROLE_PERMISSIONS.CLIENT_ADMIN.filter(
        (p) => p !== 'kyc:approve',
      ),
    };
    expect(can('CLIENT_ADMIN', 'kyc:approve')).toBe(true);
    expect(can('CLIENT_ADMIN', 'kyc:approve', overrides)).toBe(false);
    // Other perms still work
    expect(can('CLIENT_ADMIN', 'users:write', overrides)).toBe(true);
  });

  it('granting perms to a SALES_* role via override makes can() true', () => {
    const overrides: TenantRoleOverrides = {
      SALES_HO: ['reports:read', 'reports:export'],
    };
    expect(can('SALES_HO', 'reports:read')).toBe(false);
    expect(can('SALES_HO', 'reports:read', overrides)).toBe(true);
    expect(can('SALES_HO', 'reports:export', overrides)).toBe(true);
    // Non-overridden roles are still unaffected
    expect(can('SALES_ASM', 'reports:read', overrides)).toBe(false);
  });

  it('an empty override array for a role removes all its permissions', () => {
    const overrides: TenantRoleOverrides = {
      CLIENT_ADMIN: [],
    };
    expect(can('CLIENT_ADMIN', 'users:write', overrides)).toBe(false);
    expect(can('CLIENT_ADMIN', 'tenancy:read', overrides)).toBe(false);
  });

  it('overrides only affect the listed role; other roles use their defaults', () => {
    const overrides: TenantRoleOverrides = {
      MIS_USER: ['reports:read'],
    };
    // GIFSY_ADMIN still has everything (no override for it)
    expect(can('GIFSY_ADMIN', 'tenancy:write', overrides)).toBe(true);
    // CLIENT_ADMIN still has its default
    expect(can('CLIENT_ADMIN', 'users:write', overrides)).toBe(true);
  });

  it('permissionsForRole with no overrides param behaves identically to default', () => {
    expect(permissionsForRole('CLIENT_ADMIN')).toEqual(DEFAULT_ROLE_PERMISSIONS.CLIENT_ADMIN);
    expect(permissionsForRole('GIFSY_ADMIN')).toEqual(DEFAULT_ROLE_PERMISSIONS.GIFSY_ADMIN);
    expect(permissionsForRole('MIS_USER')).toEqual(DEFAULT_ROLE_PERMISSIONS.MIS_USER);
  });
});
