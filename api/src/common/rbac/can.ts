/**
 * Task 1.6a — RBAC Permission Engine
 *
 * Pure, zero-dependency module: no DB, no routes, no I/O.
 *
 * Exports:
 *   - DEFAULT_ROLE_PERMISSIONS  – the default role→permission map
 *   - RolePermissionOverride    – shape for per-tenant overrides
 *   - permissionsForRole()      – effective set for a role (default ± overrides)
 *   - can()                     – boolean gate used by 1.6b's requirePermission
 *
 * Storage of per-tenant override rows + the admin UI to edit them is out of
 * scope here (1.6b / follow-up). This module is the engine; callers supply
 * whatever override map they have loaded from DB/config.
 *
 * UserRole source: the `UserRole` enum in prisma/schema.prisma (13:25).
 * Rather than importing from @prisma/client (which requires the generated
 * client to be present at test time and adds a runtime dep to a pure lib),
 * we define a local string union that mirrors the enum exactly. If the schema
 * enum ever changes, update ROLES below and the Prisma enum together.
 */

import { ALL_PERMISSIONS, type Permission } from './permissions';

// ─────────────────────────────────────────────────────────────────────────────
// GIFSY_OPERATED_PERMISSIONS — areas Gifsy operates on the client's behalf.
// These are HIDDEN from CLIENT_ADMIN by default (tenant-overridable).
//
// Operating model (user-confirmed):
//   - tenancy config is Gifsy-owned
//   - visibility self-billing INVOICES are Gifsy-generated (client can't even view)
//   - money SETTLEMENT (bank file, UTR/mark-paid, reversals, fund, batch,
//     reconcile, TDS) is Gifsy-run
//   - ACTIVATION creation/deletion is Gifsy (client can VIEW activations,
//     manage enrollments, see reports)
// ─────────────────────────────────────────────────────────────────────────────

export const GIFSY_OPERATED_PERMISSIONS: Permission[] = [
  'tenancy:write', 'tenancy:write_finance', 'tenancy:manage_flags',
  'invoices:read', 'invoices:manage', 'invoices:upload',
  'credits:download_bank_file', 'credits:mark_paid', 'credits:approve_reversal',
  'payouts:manage_fund', 'payouts:process_batch', 'payouts:reconcile', 'payouts:view_tds',
  'schemes:write', 'schemes:delete',
];

// ─────────────────────────────────────────────────────────────────────────────
// UserRole — mirrors prisma/schema.prisma enum UserRole (line 13).
// Defined locally so this pure module has no @prisma/client dependency.
// Keep in sync with the schema enum; if a value is added/removed there,
// update this union and DEFAULT_ROLE_PERMISSIONS together.
// ─────────────────────────────────────────────────────────────────────────────

export type UserRole =
  | 'GIFSY_ADMIN'
  // RBAC Option-X — Gifsy staff below the Owner tier. Empty by default here; a
  // GIFSY_STAFF user's REAL access is their assigned GifsyRole, resolved in
  // PermissionGuard (not via this static map). Kept in the union so the schema
  // enum and DEFAULT_ROLE_PERMISSIONS stay exhaustively in sync.
  | 'GIFSY_STAFF'
  | 'CLIENT_ADMIN'
  | 'MIS_USER'
  | 'SALES_HO'
  | 'SALES_STATE_HEAD'
  | 'SALES_ASM'
  | 'SALES_SO'
  | 'SALES_ISR'
  | 'SSS'
  | 'WHOLESALER'
  | 'SUB_STOCKIST';

// ─────────────────────────────────────────────────────────────────────────────
// Derived permission sets — built programmatically from the 1.5 catalog.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GIFSY_ADMIN: platform operator — every permission in the catalog.
 * Literal spread so the array is independent (mutations don't affect the catalog).
 */
const GIFSY_ADMIN_PERMISSIONS: Permission[] = [...ALL_PERMISSIONS];

/**
 * CLIENT_ADMIN: full admin within the tenant, but Gifsy operates certain
 * platform areas on the client's behalf (see GIFSY_OPERATED_PERMISSIONS above).
 *
 * CLIENT_ADMIN RETAINS (among others): tenancy:read, credits:read,
 * credits:upload, credits:confirm_payout, credits:manage_fields, payouts:read,
 * schemes:read, schemes:manage_enrollments, schemes:export, all visibility/*
 * (capture/approve/reject/fraud-log), users/partners/kyc/catalog/targets/
 * wallet/rewards/engagement/reports/support.
 *
 * CLIENT_ADMIN LOSES everything in GIFSY_OPERATED_PERMISSIONS.
 */
const _GIFSY_OPERATED_SET = new Set<string>(GIFSY_OPERATED_PERMISSIONS);
const CLIENT_ADMIN_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter(
  (p) => !_GIFSY_OPERATED_SET.has(p),
);

/**
 * MIS_USER: read-only observer across the platform.
 *
 * Receives every permission whose action segment is `read` (i.e. ends in `:read`)
 * plus `reports:export` (standard for a data/analytics persona).
 * No writes, approvals, manages, or uploads by default.
 */
const MIS_USER_PERMISSIONS: Permission[] = [
  ...ALL_PERMISSIONS.filter((p) => p.endsWith(':read')),
  'reports:export' as Permission,
];

/**
 * SALES_* and partner roles → empty default set.
 *
 * Rationale (taxonomy decisions #1 and #4 from docs/plans/reconcile/P1-identity-tenancy.md):
 *   Sales users (SALES_HO, SALES_STATE_HEAD, SALES_ASM, SALES_SO, SALES_ISR)
 *   and channel-partner users (SSS, WHOLESALER, SUB_STOCKIST) operate through
 *   the proxy's portal routing and hierarchy/identity data-scoping, NOT through
 *   admin-portal permission keys. Their access is governed by which sub-app the
 *   proxy grants them, not by the RBAC permission catalog.
 *
 *   A tenant CAN grant specific permissions to these roles via an override
 *   (e.g. giving SALES_HO access to reports:read), but the default is empty
 *   so no accidental admin-portal access is conferred by role alone.
 */
const EMPTY_PERMISSIONS: Permission[] = [];

/**
 * SALES capture roles get the two Visibility (POSM) capture permissions by default.
 *
 * Sales reps legitimately hit the @RequirePermission('visibility:read'|'visibility:write')
 * capture/upload/media-readback routes (visibility is sales-captured, D8). Without this,
 * a future `RBAC_ENFORCEMENT` flip would 403 sales on their own capture flow even though
 * the per-route @Roles gate allows them. Kept minimal (visibility only) so no other
 * admin-portal access is conferred by role alone; a tenant override can still replace it.
 */
const SALES_VISIBILITY_PERMISSIONS: Permission[] = ['visibility:read', 'visibility:write'];

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT_ROLE_PERMISSIONS — the canonical default map
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  GIFSY_ADMIN:       GIFSY_ADMIN_PERMISSIONS,
  // GIFSY_STAFF grants NOTHING by default — access comes from the assigned
  // GifsyRole, resolved per-request in PermissionGuard (never via can()).
  GIFSY_STAFF:       EMPTY_PERMISSIONS,
  CLIENT_ADMIN:      CLIENT_ADMIN_PERMISSIONS,
  MIS_USER:          MIS_USER_PERMISSIONS,
  // Sales roles — only the Visibility (POSM) capture permissions by default (see rationale
  // above + SALES_VISIBILITY_PERMISSIONS); everything else stays proxy/hierarchy-governed.
  SALES_HO:          SALES_VISIBILITY_PERMISSIONS,
  SALES_STATE_HEAD:  SALES_VISIBILITY_PERMISSIONS,
  SALES_ASM:         SALES_VISIBILITY_PERMISSIONS,
  SALES_SO:          SALES_VISIBILITY_PERMISSIONS,
  SALES_ISR:         SALES_VISIBILITY_PERMISSIONS,
  // Partner/channel roles — empty by default (see rationale above)
  SSS:               EMPTY_PERMISSIONS,
  WHOLESALER:        EMPTY_PERMISSIONS,
  SUB_STOCKIST:      EMPTY_PERMISSIONS,
};

// ─────────────────────────────────────────────────────────────────────────────
// Override shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-tenant role permission overrides.
 *
 * Design: a partial replacement map — if a role key is present, its value
 * REPLACES the default set entirely. This is the simplest and most predictable
 * shape: no additive/subtractive arithmetic to reason about at runtime, and
 * it's easy to store as a JSON column (e.g. Client.rolePermissions: Json).
 *
 * Example (granting SALES_HO read access to reports):
 *   { SALES_HO: ['reports:read', 'reports:export'] }
 *
 * If you need additive/subtractive semantics (grant/revoke deltas on top of the
 * default), use RolePermissionDelta instead — but full-replacement is recommended
 * for clarity and auditability.
 *
 * Storage of this map is a 1.6b concern; this module is the engine.
 */
export type TenantRoleOverrides = Partial<Record<string, Permission[]>>;

// ─────────────────────────────────────────────────────────────────────────────
// permissionsForRole()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the effective permission set for `role`.
 *
 * Resolution order:
 *   1. If `overrides` provides a full replacement for this role → use it.
 *   2. Otherwise → use DEFAULT_ROLE_PERMISSIONS[role].
 *   3. Unknown role (not in the enum and not in overrides) → [].
 *
 * Pure: no DB, no I/O, no side effects.
 */
export function permissionsForRole(
  role: string,
  overrides?: TenantRoleOverrides,
): Permission[] {
  // Return a COPY in every branch so a caller mutating the result can't corrupt
  // the shared default constants (esp. the single EMPTY array shared by the
  // sales/partner roles).
  // Tenant override takes full precedence
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, role)) {
    return [...(overrides[role] ?? [])];
  }
  // Default map
  if (Object.prototype.hasOwnProperty.call(DEFAULT_ROLE_PERMISSIONS, role)) {
    return [...DEFAULT_ROLE_PERMISSIONS[role as UserRole]];
  }
  // Unknown role
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// can()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true iff the effective permission set for `role` includes `permission`.
 *
 * This is the gate that 1.6b's requirePermission middleware will call.
 * Pure: no DB, no I/O, no side effects.
 *
 * @param role        - The user's role string (e.g. 'CLIENT_ADMIN')
 * @param permission  - A Permission key from the 1.5 catalog (e.g. 'users:write')
 * @param overrides   - Optional per-tenant override map (from DB/config at request time)
 */
export function can(
  role: string,
  permission: Permission,
  overrides?: TenantRoleOverrides,
): boolean {
  return permissionsForRole(role, overrides).includes(permission);
}
