/**
 * Employee Rewards Phase 0 — capability-set resolution.
 *
 * A client's `loyaltyType` selects a DEFAULT capability set; individual boolean
 * capabilities are then overridable per-client via `clients.features.capabilities`
 * (sparse — only the keys present override). Application code should read the
 * resolved CapabilitySet, NEVER `loyaltyType` directly — except `earnerModel`,
 * which is derived from `loyaltyType` by construction and is intentionally NOT
 * overridable (the earner model is the one thing the type fixes).
 *
 * Pure, zero-I/O. Fail-safe: an unknown/absent loyaltyType resolves to the
 * TRADE_LOYALTY defaults (the live product), so a bad/empty value can never
 * accidentally switch a tenant into the compliance-off employee posture.
 */

export type LoyaltyType = 'TRADE_LOYALTY' | 'EMPLOYEE_REWARDS';

export type EarnerModel = 'OUTLET' | 'EMPLOYEE';

export interface CapabilitySet {
  /** Derived from loyaltyType; NOT overridable. */
  earnerModel: EarnerModel;
  kyc: boolean;
  gst: boolean;
  tds: boolean;
  payouts: boolean;
  invoicing: boolean;
  vendorMarketplace: boolean;
  celebratoryUx: boolean;
}

/** The boolean capabilities a client may override via features.capabilities. */
const BOOLEAN_CAPS = [
  'kyc',
  'gst',
  'tds',
  'payouts',
  'invoicing',
  'vendorMarketplace',
  'celebratoryUx',
] as const;

export const TRADE_CAPABILITIES: CapabilitySet = {
  earnerModel: 'OUTLET',
  kyc: true,
  gst: true,
  tds: true,
  payouts: true,
  invoicing: true,
  vendorMarketplace: false,
  celebratoryUx: false,
};

export const EMPLOYEE_CAPABILITIES: CapabilitySet = {
  earnerModel: 'EMPLOYEE',
  kyc: false,
  gst: false,
  tds: false,
  payouts: false,
  invoicing: false,
  vendorMarketplace: true,
  celebratoryUx: true,
};

/**
 * Resolve the effective capability set for a client.
 * @param loyaltyType  the client's loyaltyType (unknown/null → TRADE defaults, fail-safe)
 * @param features     the raw `clients.features` blob; per-client overrides read from
 *                     `features.capabilities.{cap}` (boolean). `earnerModel` is never overridden.
 */
export function resolveCapabilities(
  loyaltyType: LoyaltyType | string | null | undefined,
  features?: Record<string, unknown> | null,
): CapabilitySet {
  const base =
    loyaltyType === 'EMPLOYEE_REWARDS' ? EMPLOYEE_CAPABILITIES : TRADE_CAPABILITIES;
  const out: CapabilitySet = { ...base };

  const overrides =
    features && typeof features === 'object' && features.capabilities &&
    typeof features.capabilities === 'object'
      ? (features.capabilities as Record<string, unknown>)
      : null;
  if (!overrides) return out;

  for (const cap of BOOLEAN_CAPS) {
    if (typeof overrides[cap] === 'boolean') {
      out[cap] = overrides[cap] as boolean;
    }
  }
  // earnerModel intentionally not overridable — it follows loyaltyType.
  return out;
}
