/**
 * Outlet types — logic layer for the GIFSY platform.
 *
 * OutletType is a global master list — managed only by GIFSY_ADMIN.
 * OutletTypeClientConfig is per-tenant per-type — configurable by GIFSY_ADMIN
 * or CLIENT_ADMIN after the tenant is onboarded.
 *
 * Pure functions only — no side effects, no API calls.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OutletType {
  /** Stable identifier — never changes even if the display name is updated. */
  code: string;
  /** Display label — can be changed at any time without a migration. */
  name: string;
  description: string;
  isActive: boolean;
  createdAt: string;
}

/**
 * Per-tenant configuration for one outlet type.
 * All feature flags default to true when no explicit config exists.
 */
export interface OutletTypeClientConfig {
  clientId: string;
  outletTypeCode: string;

  /** Show / hide this outlet type in the tenant's program. */
  isEnabled: boolean;
  /** Optional client-specific label override (null = use the global name). */
  displayName: string | null;

  // ── Feature flags ────────────────────────────────────────────────────────
  loyaltyEnabled: boolean;      // can earn / redeem points
  schemesEnabled: boolean;      // eligible for scheme enrolment
  visibilityEnabled: boolean;   // can submit visibility programs
  payoutsEnabled: boolean;      // can receive payouts
  leaderboardEnabled: boolean;  // appears in leaderboard rankings
  targetsEnabled: boolean;      // targets can be assigned
  kycRequired: boolean;         // KYC must be completed before activation
}

export type OutletTypeFeatureFlag = keyof Omit<
  OutletTypeClientConfig,
  'clientId' | 'outletTypeCode' | 'displayName'
>;

// ── Master list ───────────────────────────────────────────────────────────────

/**
 * Seeded global master list.  In production these rows live in the database;
 * this constant is used for dev / tests / initial seed.
 */
export const MASTER_OUTLET_TYPES: OutletType[] = [
  {
    code: 'SSS',
    name: 'SSS',
    description: 'Retail channel partner',
    isActive: true,
    createdAt: '2026-01-01',
  },
  {
    code: 'WHOLESALER',
    name: 'Wholesaler',
    description: 'Wholesale channel partner',
    isActive: true,
    createdAt: '2026-01-01',
  },
  {
    code: 'SUB_STOCKIST',
    name: 'Sub-Stockist',
    description: 'Sub-stockist channel partner',
    isActive: true,
    createdAt: '2026-01-01',
  },
  {
    code: 'SSS_TOT',
    name: 'SSS TOT',
    description: 'Super stockist / TOT channel partner',
    isActive: true,
    createdAt: '2026-01-01',
  },
];

// ── Query helpers ─────────────────────────────────────────────────────────────

/** Returns only the outlet types that are currently active. */
export function getActiveOutletTypes(types: OutletType[]): OutletType[] {
  return types.filter((t) => t.isActive);
}

/**
 * Returns whether the caller role is permitted to manage the global outlet
 * type master list (create / rename / toggle).
 */
export function canManageOutletTypes(role: string): boolean {
  return role === 'GIFSY_ADMIN';
}

// ── Mutations (return new arrays / objects — no mutation) ─────────────────────

/**
 * Returns a new types array with the display name of the given code updated.
 * The stable `code` field is never touched.
 * Throws if the caller is not GIFSY_ADMIN.
 */
export function applyOutletTypeRename(
  types: OutletType[],
  code: string,
  newName: string,
  callerRole: string,
): OutletType[] {
  if (callerRole !== 'GIFSY_ADMIN') {
    throw new Error(
      `Permission denied: only GIFSY_ADMIN can rename outlet types. Attempted by ${callerRole}.`,
    );
  }
  return types.map((t) => (t.code === code ? { ...t, name: newName } : t));
}

/**
 * Returns a new types array with the isActive flag of the given code updated.
 * Throws if the caller is not GIFSY_ADMIN.
 */
export function applyOutletTypeToggle(
  types: OutletType[],
  code: string,
  isActive: boolean,
  callerRole: string,
): OutletType[] {
  if (callerRole !== 'GIFSY_ADMIN') {
    throw new Error(
      `Permission denied: only GIFSY_ADMIN can toggle outlet types. Attempted by ${callerRole}.`,
    );
  }
  return types.map((t) => (t.code === code ? { ...t, isActive } : t));
}

// ── Per-tenant config ─────────────────────────────────────────────────────────

/**
 * Returns the default config for a (clientId, outletTypeCode) pair.
 * All features enabled, no display name override.
 */
export function defaultOutletTypeClientConfig(
  clientId: string,
  outletTypeCode: string,
): OutletTypeClientConfig {
  return {
    clientId,
    outletTypeCode,
    isEnabled: true,
    displayName: null,
    loyaltyEnabled: true,
    schemesEnabled: true,
    visibilityEnabled: true,
    payoutsEnabled: true,
    leaderboardEnabled: true,
    targetsEnabled: true,
    kycRequired: true,
  };
}

/**
 * Looks up the explicit config for a (clientId, outletTypeCode) pair.
 * Falls back to all-defaults if no config has been saved yet.
 */
export function getOutletTypeClientConfig(
  clientId: string,
  outletTypeCode: string,
  configs: OutletTypeClientConfig[],
): OutletTypeClientConfig {
  return (
    configs.find(
      (c) => c.clientId === clientId && c.outletTypeCode === outletTypeCode,
    ) ?? defaultOutletTypeClientConfig(clientId, outletTypeCode)
  );
}

/**
 * Returns a new config with one feature flag updated.
 * GIFSY_ADMIN and CLIENT_ADMIN are both allowed; all other roles throw.
 */
export function applyOutletTypeClientConfigUpdate(
  config: OutletTypeClientConfig,
  flag: OutletTypeFeatureFlag,
  value: boolean,
  callerRole: string,
): OutletTypeClientConfig {
  if (callerRole !== 'GIFSY_ADMIN' && callerRole !== 'CLIENT_ADMIN') {
    throw new Error(
      `Permission denied: only GIFSY_ADMIN or CLIENT_ADMIN can update outlet type config. ` +
        `Attempted by ${callerRole}.`,
    );
  }
  return { ...config, [flag]: value };
}
