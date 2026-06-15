/**
 * Task 1.5 — Permission Catalog
 *
 * This file is the SINGLE SOURCE OF TRUTH for every permission key on the
 * platform. It is a pure, zero-dependency module — no DB, no routes, no I/O.
 *
 * Seed for Task 1.6: role→permission mappings and the can() gate will be
 * built in src/lib/rbac/roles.ts. Nothing here is wired to any route yet
 * (YAGNI — wiring is a 1.6 concern).
 *
 * Groupings are derived directly from the 17 bounded contexts in
 * docs/spec/01-capabilities.md. Group names map to product sections so
 * that 1.6's admin role-config UI can enumerate them meaningfully.
 *
 * Naming convention: "<group>:<action>" — lower-snake for both sides.
 *   - "read"  = view/list/export
 *   - "write" = create/update
 *   - "delete" = soft or hard remove
 *   - "approve" / "reject" = workflow gate actions
 *   - "manage" = full admin control over a sub-resource
 */

// ─────────────────────────────────────────────────────────────────────────────
// PERMISSIONS — nested const object, grouped by capability area.
// The outer key = PermissionGroup; the inner value = the Permission string.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cluster A — Identity, Tenancy & Org
 * ─────────────────────────────────────
 */

/**
 * @capabilityContext §01 · Identity & Access (RBAC)
 * Controls who can read, create, modify, and deactivate admin-portal users,
 * and who can manage roles/permissions themselves.
 */
const USERS = {
  READ:             'users:read',
  WRITE:            'users:write',
  DELETE:           'users:delete',
  MANAGE_ROLES:     'users:manage_roles',
} as const;

/**
 * @capabilityContext §02 · Tenancy & Platform Configuration
 * Controls access to tenant-level settings, feature flags, and branding.
 * Only GIFSY_ADMIN should ever receive these in practice (enforced in 1.6).
 */
const TENANCY = {
  READ:             'tenancy:read',
  WRITE:            'tenancy:write',
  MANAGE_FLAGS:     'tenancy:manage_flags',
} as const;

/**
 * @capabilityContext §03 · Sales Organization
 * Controls visibility and management of the field-sales hierarchy,
 * sales-user assignments, and task configuration.
 */
const SALES_ORG = {
  READ:             'sales_org:read',
  WRITE:            'sales_org:write',
  MANAGE_HIERARCHY: 'sales_org:manage_hierarchy',
  MANAGE_TASKS:     'sales_org:manage_tasks',
} as const;

/**
 * @capabilityContext §04 · Partners & Outlets
 * Controls who can view and modify channel partners and their outlets,
 * including deactivation/reactivation and geo capture.
 */
const PARTNERS = {
  READ:             'partners:read',
  WRITE:            'partners:write',
  DELETE:           'partners:delete',
  MANAGE_OUTLETS:   'partners:manage_outlets',
} as const;

/**
 * Cluster B — Enrollment & Catalog
 * ──────────────────────────────────
 */

/**
 * @capabilityContext §05 · KYC & Enrollment
 * Controls initiation, viewing, approving, and rejecting KYC submissions.
 * Separate keys for the multi-level approval chain vs Gifsy-final approval
 * so that 1.6 can bind them to different role tiers.
 */
const KYC = {
  READ:             'kyc:read',
  INITIATE:         'kyc:initiate',
  APPROVE:          'kyc:approve',
  REJECT:           'kyc:reject',
  GIFSY_APPROVE:    'kyc:gifsy_approve',
  VIEW_DOCUMENTS:   'kyc:view_documents',
} as const;

/**
 * @capabilityContext §06 · Product Catalog
 * Controls access to SKUs and product categories.
 */
const CATALOG = {
  READ:             'catalog:read',
  WRITE:            'catalog:write',
  DELETE:           'catalog:delete',
} as const;

/**
 * Cluster C — Programs & Value
 * ─────────────────────────────
 */

/**
 * @capabilityContext §07 · Schemes & Activations
 * Controls authoring and managing incentive programs (schemes/activations),
 * including enrollment management and export.
 */
const SCHEMES = {
  READ:             'schemes:read',
  WRITE:            'schemes:write',
  DELETE:           'schemes:delete',
  MANAGE_ENROLLMENTS: 'schemes:manage_enrollments',
  EXPORT:           'schemes:export',
} as const;

/**
 * @capabilityContext §08 · Targets & Achievements
 * Controls configuration, upload, and viewing of sales targets and
 * achievement data. This is tracking/display only — not a money path.
 */
const TARGETS = {
  READ:             'targets:read',
  WRITE:            'targets:write',
  UPLOAD:           'targets:upload',
  MANAGE_CONFIG:    'targets:manage_config',
} as const;

/**
 * @capabilityContext §09 · Wallet & Points
 * Controls who can view partner wallets and perform admin adjustments.
 * Expiry config management is a separate key for fine-grained control.
 */
const WALLET = {
  READ:             'wallet:read',
  ADJUST:           'wallet:adjust',
  MANAGE_EXPIRY:    'wallet:manage_expiry',
} as const;

/**
 * @capabilityContext §10 · Rewards & Redemption
 * Controls gift catalog management, inventory, and viewing/managing
 * redemption orders.
 */
const REWARDS = {
  READ:             'rewards:read',
  WRITE:            'rewards:write',
  MANAGE_INVENTORY: 'rewards:manage_inventory',
  MANAGE_ORDERS:    'rewards:manage_orders',
} as const;

/**
 * Cluster D — Finance, Engagement & Ops
 * ───────────────────────────────────────
 */

/**
 * @capabilityContext §11 · Visibility
 * Controls in-store branding program submissions, approval workflow,
 * and fraud log review.
 */
const VISIBILITY = {
  READ:             'visibility:read',
  WRITE:            'visibility:write',
  APPROVE:          'visibility:approve',
  REJECT:           'visibility:reject',
  VIEW_FRAUD_LOG:   'visibility:view_fraud_log',
} as const;

/**
 * @capabilityContext §12a · Awards & Credits (Finance — push)
 * Controls the single award path: uploading credit batches, confirming
 * payouts, downloading bank files, marking paid with UTR, and approving
 * reversals. Separate from redemption payouts (§12b).
 */
const CREDITS = {
  READ:             'credits:read',
  UPLOAD:           'credits:upload',
  CONFIRM_PAYOUT:   'credits:confirm_payout',
  DOWNLOAD_BANK_FILE: 'credits:download_bank_file',
  MARK_PAID:        'credits:mark_paid',
  REQUEST_REVERSAL: 'credits:request_reversal',
  APPROVE_REVERSAL: 'credits:approve_reversal',
  MANAGE_FIELDS:    'credits:manage_fields',
} as const;

/**
 * @capabilityContext §12b · Redemption Payouts & Fund (Finance — pull)
 * Controls fund top-up management, payout batch processing, reconciliation,
 * and TDS record access.
 */
const PAYOUTS = {
  READ:             'payouts:read',
  MANAGE_FUND:      'payouts:manage_fund',
  PROCESS_BATCH:    'payouts:process_batch',
  RECONCILE:        'payouts:reconcile',
  VIEW_TDS:         'payouts:view_tds',
} as const;

/**
 * @capabilityContext §12c · Visibility Self-Billing Invoicing (Finance — invoicing)
 * Controls invoice generation, listing, upload, and the admin view of
 * partner-facing invoices.
 */
const INVOICES = {
  READ:             'invoices:read',
  MANAGE:           'invoices:manage',
  UPLOAD:           'invoices:upload',
} as const;

/**
 * @capabilityContext §13 · Engagement (Banners, Notifications, Leaderboard)
 * Controls banner configuration, notification template authoring, and
 * leaderboard configuration per tenant.
 */
const ENGAGEMENT = {
  READ:             'engagement:read',
  MANAGE_BANNERS:   'engagement:manage_banners',
  MANAGE_NOTIFICATIONS: 'engagement:manage_notifications',
  MANAGE_LEADERBOARD:   'engagement:manage_leaderboard',
} as const;

/**
 * @capabilityContext §14 · Reporting & Analytics
 * Controls access to dashboards and scheduled/exported reports.
 * Per spec: report access control ties to configurable RBAC (Gap #2).
 */
const REPORTS = {
  READ:             'reports:read',
  EXPORT:           'reports:export',
  MANAGE_SCHEDULED: 'reports:manage_scheduled',
} as const;

/**
 * @capabilityContext §15 · Support (Tickets)
 * Controls creating, viewing, and managing support tickets including
 * escalation and Gifsy-admin management.
 */
const SUPPORT = {
  READ:             'support:read',
  WRITE:            'support:write',
  ESCALATE:         'support:escalate',
  MANAGE:           'support:manage',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// PERMISSIONS — the root catalog object (exported for runtime enumeration)
// ─────────────────────────────────────────────────────────────────────────────

export const PERMISSIONS = {
  USERS,
  TENANCY,
  SALES_ORG,
  PARTNERS,
  KYC,
  CATALOG,
  SCHEMES,
  TARGETS,
  WALLET,
  REWARDS,
  VISIBILITY,
  CREDITS,
  PAYOUTS,
  INVOICES,
  ENGAGEMENT,
  REPORTS,
  SUPPORT,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Permission — string-literal union type derived exhaustively from the const
// ─────────────────────────────────────────────────────────────────────────────

type LeafValues<T> = T extends Record<string, infer V>
  ? V extends Record<string, infer W>
    ? W
    : V
  : never;

export type Permission = LeafValues<typeof PERMISSIONS>;

// ─────────────────────────────────────────────────────────────────────────────
// PermissionGroup — the group key type
// ─────────────────────────────────────────────────────────────────────────────

export type PermissionGroup = keyof typeof PERMISSIONS;

// ─────────────────────────────────────────────────────────────────────────────
// ALL_PERMISSIONS — flat array, no duplicates; derived from the const
// ─────────────────────────────────────────────────────────────────────────────

export const ALL_PERMISSIONS: Permission[] = (
  Object.values(PERMISSIONS) as Record<string, string>[]
).flatMap((group) => Object.values(group)) as Permission[];

// ─────────────────────────────────────────────────────────────────────────────
// PERMISSION_GROUPS — metadata for each group (used by admin role-config UIs)
// ─────────────────────────────────────────────────────────────────────────────

export interface PermissionGroupMeta {
  /** The key matching PERMISSIONS[key] */
  key: PermissionGroup;
  /** Human-readable label for the admin UI */
  label: string;
  /** The capability context this group was derived from (§ number + name) */
  capabilityContext: string;
}

export const PERMISSION_GROUPS: PermissionGroupMeta[] = [
  {
    key: 'USERS',
    label: 'User Management',
    capabilityContext: '§01 · Identity & Access (RBAC)',
  },
  {
    key: 'TENANCY',
    label: 'Tenancy & Platform Configuration',
    capabilityContext: '§02 · Tenancy & Platform Configuration',
  },
  {
    key: 'SALES_ORG',
    label: 'Sales Organization',
    capabilityContext: '§03 · Sales Organization',
  },
  {
    key: 'PARTNERS',
    label: 'Partners & Outlets',
    capabilityContext: '§04 · Partners & Outlets',
  },
  {
    key: 'KYC',
    label: 'KYC & Enrollment',
    capabilityContext: '§05 · KYC & Enrollment',
  },
  {
    key: 'CATALOG',
    label: 'Product Catalog',
    capabilityContext: '§06 · Product Catalog',
  },
  {
    key: 'SCHEMES',
    label: 'Schemes & Activations',
    capabilityContext: '§07 · Schemes & Activations',
  },
  {
    key: 'TARGETS',
    label: 'Targets & Achievements',
    capabilityContext: '§08 · Targets & Achievements',
  },
  {
    key: 'WALLET',
    label: 'Wallet & Points',
    capabilityContext: '§09 · Wallet & Points',
  },
  {
    key: 'REWARDS',
    label: 'Rewards & Redemption',
    capabilityContext: '§10 · Rewards & Redemption',
  },
  {
    key: 'VISIBILITY',
    label: 'Visibility Programs',
    capabilityContext: '§11 · Visibility',
  },
  {
    key: 'CREDITS',
    label: 'Awards & Credits',
    capabilityContext: '§12a · Awards & Credits (Finance — push)',
  },
  {
    key: 'PAYOUTS',
    label: 'Redemption Payouts & Fund',
    capabilityContext: '§12b · Redemption Payouts & Fund (Finance — pull)',
  },
  {
    key: 'INVOICES',
    label: 'Invoicing',
    capabilityContext: '§12c · Visibility Self-Billing Invoicing (Finance — invoicing)',
  },
  {
    key: 'ENGAGEMENT',
    label: 'Engagement (Banners, Notifications, Leaderboard)',
    capabilityContext: '§13 · Engagement',
  },
  {
    key: 'REPORTS',
    label: 'Reporting & Analytics',
    capabilityContext: '§14 · Reporting & Analytics',
  },
  {
    key: 'SUPPORT',
    label: 'Support (Tickets)',
    capabilityContext: '§15 · Support (Tickets)',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all permissions that belong to the given group.
 * Returns an empty array for an unknown group key.
 *
 * Used by the admin role-config UI to list available permissions per section.
 */
export function permissionsForGroup(group: PermissionGroup): Permission[] {
  const groupObj = PERMISSIONS[group];
  if (!groupObj) return [];
  return Object.values(groupObj) as Permission[];
}

/**
 * Type guard — narrows an unknown value to Permission.
 *
 * Useful in 1.6's can() gate for validating stored permission strings
 * loaded from DB before comparing them.
 */
export function isPermission(x: unknown): x is Permission {
  if (typeof x !== 'string') return false;
  return (ALL_PERMISSIONS as string[]).includes(x);
}
