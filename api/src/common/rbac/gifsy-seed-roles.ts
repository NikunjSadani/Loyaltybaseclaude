/**
 * RBAC Option-X — the two seeded (isSystem) Gifsy operator roles: Ops and
 * Project Manager. This is the SINGLE SOURCE OF TRUTH for their permission
 * sets, matching the design doc "Seed roles" section exactly.
 *
 * These roles are `isSystem: true` → editable/renamable in the P1+ UI but the
 * delete path blocks them. The seed (prisma/seed-gifsy-roles.ts) upserts them
 * by (clientId, name) so re-running never duplicates.
 *
 * Every key here is a valid Permission (permissions.ts) and NONE are in the
 * Reserved set — a guarded invariant in gifsy-seed-roles.spec.ts.
 *
 * Pure, zero-I/O module.
 */

import type { Permission } from './permissions';

export const GIFSY_ROLES_CLIENT_ID = 'gifsy';

/**
 * Ops — KYC review · visibility · employees(sales org) · outlets(partners) ·
 * schemes · targets · tickets. No finance, no reserved keys.
 */
export const OPS_PERMISSIONS: Permission[] = [
  // KYC & Enrollment (no kyc:initiate)
  'kyc:read',
  'kyc:approve',
  'kyc:reject',
  'kyc:gifsy_approve',
  'kyc:view_documents',
  // Visibility (POSM)
  'visibility:read',
  'visibility:write',
  'visibility:approve',
  'visibility:reject',
  'visibility:view_fraud_log',
  // Sales organization
  'sales_org:read',
  'sales_org:write',
  'sales_org:manage_hierarchy',
  'sales_org:manage_tasks',
  // Partners & outlets
  'partners:read',
  'partners:write',
  'partners:delete',
  'partners:manage_outlets',
  // Schemes & activations
  'schemes:read',
  'schemes:write',
  'schemes:delete',
  'schemes:manage_enrollments',
  'schemes:export',
  // Targets & achievements
  'targets:read',
  'targets:write',
  'targets:upload',
  'targets:manage_config',
  // Support (tickets)
  'support:read',
  'support:write',
  'support:escalate',
  'support:manage',
];

/**
 * Project Manager — all of Ops, plus finance-VIEW (read-only), dashboards/
 * reports, and the gift catalogue (rewards). No reserved keys.
 */
export const PROJECT_MANAGER_PERMISSIONS: Permission[] = [
  ...OPS_PERMISSIONS,
  // Finance — read-only (none of these are reserved)
  'credits:read',
  'payouts:read',
  'payouts:view_tds',
  'invoices:read',
  // Reporting & analytics
  'reports:read',
  'reports:export',
  // Rewards & redemption (gift catalogue)
  'rewards:read',
  'rewards:write',
  'rewards:manage_inventory',
  'rewards:manage_orders',
];

export interface SeedGifsyRole {
  name: string;
  description: string;
  isSystem: boolean;
  permissions: Permission[];
}

export const GIFSY_SEED_ROLES: SeedGifsyRole[] = [
  {
    name: 'Ops',
    description:
      'KYC review, visibility, sales org, outlets, schemes, targets, and tickets. No finance.',
    isSystem: true,
    permissions: OPS_PERMISSIONS,
  },
  {
    name: 'Project Manager',
    description:
      'Everything Ops can do, plus read-only finance, dashboards/reports, and the gift catalogue.',
    isSystem: true,
    permissions: PROJECT_MANAGER_PERMISSIONS,
  },
];
