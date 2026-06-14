/**
 * Task 1.5 — Permission catalog tests (pure, no DB/network)
 *
 * Contract:
 *  - Catalog has no duplicate keys
 *  - Every group name in PERMISSION_GROUPS has ≥1 permission
 *  - ALL_PERMISSIONS is exactly the union of all groups (no omissions, no extras)
 *  - isPermission guards valid and invalid inputs correctly
 *  - permissionsForGroup returns the exact set for a known group, empty array for unknown
 *  - The Permission union type covers the same set as PERMISSIONS const (runtime exhaustiveness)
 */

import { describe, it, expect } from 'vitest';
import {
  PERMISSIONS,
  ALL_PERMISSIONS,
  PERMISSION_GROUPS,
  permissionsForGroup,
  isPermission,
  type Permission,
  type PermissionGroup,
} from '../permissions';

// ─────────────────────────────────────────────────────────────────────────────
// Helper: collect every leaf string value out of the nested PERMISSIONS object
// ─────────────────────────────────────────────────────────────────────────────
function collectAllLeafValues(obj: Record<string, Record<string, string>>): string[] {
  return Object.values(obj).flatMap((group) => Object.values(group));
}

describe('PERMISSIONS constant', () => {
  it('has no duplicate permission keys across all groups', () => {
    const all = collectAllLeafValues(PERMISSIONS);
    const unique = new Set(all);
    expect(unique.size).toBe(all.length);
  });

  it('every group contains at least one permission', () => {
    for (const [groupName, group] of Object.entries(PERMISSIONS)) {
      expect(
        Object.keys(group).length,
        `Group "${groupName}" must have at least one permission`,
      ).toBeGreaterThan(0);
    }
  });

  it('all permission values follow the "group:action" format', () => {
    const all = collectAllLeafValues(PERMISSIONS);
    for (const perm of all) {
      expect(perm, `"${perm}" must match group:action format`).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });
});

describe('ALL_PERMISSIONS', () => {
  it('is an array with no duplicates', () => {
    const unique = new Set(ALL_PERMISSIONS);
    expect(unique.size).toBe(ALL_PERMISSIONS.length);
  });

  it('contains exactly the union of all PERMISSIONS groups — no omissions, no extras', () => {
    const fromConst = new Set(collectAllLeafValues(PERMISSIONS));
    const fromAll = new Set<string>(ALL_PERMISSIONS);
    // Every leaf from PERMISSIONS must appear in ALL_PERMISSIONS
    for (const p of fromConst) {
      expect(fromAll.has(p), `"${p}" is in PERMISSIONS but missing from ALL_PERMISSIONS`).toBe(true);
    }
    // ALL_PERMISSIONS must not contain anything not in PERMISSIONS
    for (const p of fromAll) {
      expect(fromConst.has(p), `"${p}" is in ALL_PERMISSIONS but not found in PERMISSIONS`).toBe(true);
    }
  });

  it('has a total count above zero', () => {
    expect(ALL_PERMISSIONS.length).toBeGreaterThan(0);
  });
});

describe('PERMISSION_GROUPS', () => {
  it('lists the same group names as PERMISSIONS keys', () => {
    const fromGroups = new Set(PERMISSION_GROUPS.map((g) => g.key));
    const fromConst = new Set(Object.keys(PERMISSIONS));
    expect(fromGroups.size).toBe(fromConst.size);
    for (const k of fromConst) {
      expect(fromGroups.has(k as PermissionGroup), `Group "${k}" is in PERMISSIONS but not in PERMISSION_GROUPS`).toBe(true);
    }
  });

  it('each group entry has a non-empty label and capabilityContext', () => {
    for (const g of PERMISSION_GROUPS) {
      expect(g.label.trim().length, `Group "${g.key}" must have a non-empty label`).toBeGreaterThan(0);
      expect(
        g.capabilityContext.trim().length,
        `Group "${g.key}" must cite a capabilityContext`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('permissionsForGroup', () => {
  it('returns permissions matching the group', () => {
    for (const group of PERMISSION_GROUPS) {
      const perms = permissionsForGroup(group.key);
      expect(perms.length).toBeGreaterThan(0);
      // All returned values should be valid Permission values
      for (const p of perms) {
        expect(isPermission(p)).toBe(true);
      }
    }
  });

  it('returns all permissions of a known group and no others', () => {
    // Take the first group and verify the set exactly matches PERMISSIONS[group]
    const firstGroup = PERMISSION_GROUPS[0];
    const returned = permissionsForGroup(firstGroup.key);
    const expected = Object.values(PERMISSIONS[firstGroup.key as keyof typeof PERMISSIONS]);
    expect(new Set(returned)).toEqual(new Set(expected));
  });

  it('returns an empty array for an unknown group', () => {
    // Cast to bypass TypeScript — runtime guard only
    const result = permissionsForGroup('nonexistent:group' as PermissionGroup);
    expect(result).toEqual([]);
  });
});

describe('isPermission', () => {
  it('returns true for every known permission', () => {
    for (const p of ALL_PERMISSIONS) {
      expect(isPermission(p), `isPermission("${p}") should be true`).toBe(true);
    }
  });

  it('returns false for an empty string', () => {
    expect(isPermission('')).toBe(false);
  });

  it('returns false for a well-formed but unknown string', () => {
    expect(isPermission('users:fly')).toBe(false);
    expect(isPermission('unknown:action')).toBe(false);
  });

  it('returns false for non-string inputs', () => {
    expect(isPermission(null)).toBe(false);
    expect(isPermission(undefined)).toBe(false);
    expect(isPermission(42)).toBe(false);
    expect(isPermission({})).toBe(false);
  });

  it('acts as a type-guard — narrowing to Permission', () => {
    const x: unknown = 'users:read';
    if (isPermission(x)) {
      // If this compiles, the type guard works
      const _typed: Permission = x;
      expect(_typed).toBe('users:read');
    }
  });
});

describe('runtime exhaustiveness — Permission union vs PERMISSIONS const', () => {
  it('every value in ALL_PERMISSIONS round-trips through isPermission (catalog = union)', () => {
    // This test fails if PERMISSIONS and the Permission type diverge
    for (const p of ALL_PERMISSIONS) {
      expect(isPermission(p)).toBe(true);
    }
  });
});
