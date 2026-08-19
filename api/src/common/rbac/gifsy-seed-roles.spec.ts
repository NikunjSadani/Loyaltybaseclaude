// RBAC Option-X — seeded Gifsy operator role definitions + the seed function.
// Run: npx jest src/common/rbac/gifsy-seed-roles.spec.ts

import {
  OPS_PERMISSIONS,
  PROJECT_MANAGER_PERMISSIONS,
  GIFSY_SEED_ROLES,
  GIFSY_ROLES_CLIENT_ID,
} from './gifsy-seed-roles';
import { isPermission } from './permissions';
import { RESERVED_PERMISSIONS } from './reserved-permissions';
import { seedGifsyRoles } from '../../../prisma/seed-gifsy-roles';

// The exact sets from the design doc "Seed roles" section.
const EXPECTED_OPS = [
  'kyc:read', 'kyc:approve', 'kyc:reject', 'kyc:gifsy_approve', 'kyc:view_documents',
  'visibility:read', 'visibility:write', 'visibility:view_fraud_log',
  'sales_org:read', 'sales_org:write', 'sales_org:manage_hierarchy', 'sales_org:manage_tasks',
  'partners:read', 'partners:write', 'partners:delete', 'partners:manage_outlets',
  'schemes:read', 'schemes:write', 'schemes:delete', 'schemes:manage_enrollments', 'schemes:export',
  'targets:read', 'targets:write', 'targets:upload', 'targets:manage_config',
  'support:read', 'support:write', 'support:escalate',
];

const EXPECTED_PM_EXTRA = [
  'credits:read',
  'payouts:read', 'payouts:view_tds',
  'invoices:read',
  'reports:read', 'reports:export',
  'rewards:read', 'rewards:write', 'rewards:manage_inventory', 'rewards:manage_orders',
];

describe('Ops seed role', () => {
  it('matches the design-doc Ops set exactly', () => {
    expect([...OPS_PERMISSIONS].sort()).toEqual([...EXPECTED_OPS].sort());
  });

  it('has no duplicates and only valid keys', () => {
    expect(new Set(OPS_PERMISSIONS).size).toBe(OPS_PERMISSIONS.length);
    OPS_PERMISSIONS.forEach((p) => expect(isPermission(p)).toBe(true));
  });

  it('holds NO reserved permission', () => {
    const reserved = new Set<string>(RESERVED_PERMISSIONS);
    OPS_PERMISSIONS.forEach((p) => expect(reserved.has(p)).toBe(false));
  });
});

describe('Project Manager seed role', () => {
  it('is a strict superset of Ops', () => {
    OPS_PERMISSIONS.forEach((p) => expect(PROJECT_MANAGER_PERMISSIONS).toContain(p));
  });

  it('matches the design-doc PM set exactly (Ops + finance-view + reports + rewards)', () => {
    expect([...PROJECT_MANAGER_PERMISSIONS].sort()).toEqual(
      [...EXPECTED_OPS, ...EXPECTED_PM_EXTRA].sort(),
    );
  });

  it('has no duplicates and only valid keys', () => {
    expect(new Set(PROJECT_MANAGER_PERMISSIONS).size).toBe(PROJECT_MANAGER_PERMISSIONS.length);
    PROJECT_MANAGER_PERMISSIONS.forEach((p) => expect(isPermission(p)).toBe(true));
  });

  it('holds NO reserved permission (read-only finance is not reserved)', () => {
    const reserved = new Set<string>(RESERVED_PERMISSIONS);
    PROJECT_MANAGER_PERMISSIONS.forEach((p) => expect(reserved.has(p)).toBe(false));
  });
});

describe('GIFSY_SEED_ROLES metadata', () => {
  it('defines exactly Ops + Project Manager, both isSystem', () => {
    expect(GIFSY_SEED_ROLES.map((r) => r.name)).toEqual(['Ops', 'Project Manager']);
    GIFSY_SEED_ROLES.forEach((r) => expect(r.isSystem).toBe(true));
  });
});

describe('seedGifsyRoles() — idempotent upsert', () => {
  it('upserts both roles under clientId=gifsy with the exact permission sets', async () => {
    const upsert = jest.fn().mockImplementation((args) =>
      Promise.resolve({ id: `id-${args.create.name}`, name: args.create.name }),
    );
    await seedGifsyRoles({ gifsyRole: { upsert } });

    expect(upsert).toHaveBeenCalledTimes(2);

    const opsCall = upsert.mock.calls.find((c) => c[0].where.clientId_name.name === 'Ops')![0];
    expect(opsCall.where.clientId_name.clientId).toBe(GIFSY_ROLES_CLIENT_ID);
    expect(opsCall.create.isSystem).toBe(true);
    expect([...opsCall.create.permissions].sort()).toEqual([...EXPECTED_OPS].sort());
    // update path carries the same permissions (converges an existing row)
    expect([...opsCall.update.permissions].sort()).toEqual([...EXPECTED_OPS].sort());

    const pmCall = upsert.mock.calls.find(
      (c) => c[0].where.clientId_name.name === 'Project Manager',
    )![0];
    expect([...pmCall.create.permissions].sort()).toEqual(
      [...EXPECTED_OPS, ...EXPECTED_PM_EXTRA].sort(),
    );
  });
});
