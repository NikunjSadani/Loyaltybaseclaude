import { OutletPaymentType } from '@prisma/client';

/**
 * The single source of truth for the per-outlet payout MANDATE (`Outlet.requiredPaymentType`)
 * ↔ the captured KYC `paymentMode` ('bank' | 'upi'). Shared by:
 *   - the outlet-upload validator (parse + reject UPI-under-tenant-off)
 *   - the KYC submit validation (reject a mismatched paymentMode)
 *   - the FE KYC wizard (pin/lock the toggle) — mirrored in platform/src/lib/payment-type.ts
 *
 * TENANT GATE WINS: UPI is NEVER usable when the tenant's salesApp.upiEnabled is false — the
 * per-outlet config can't enable a mode the tenant disabled. The upload validator rejects a
 * `UPI` row for a UPI-disabled tenant, so a UPI-required outlet should never coexist with
 * upiEnabled=false; if it somehow does (e.g. the tenant later turns UPI off), the helpers
 * degrade that outlet to BANK rather than block KYC.
 */
export type PaymentMode = 'bank' | 'upi';

/** Case-insensitive parse of an uploaded payout-method cell → the enum, or null if invalid/blank. */
export function parseOutletPaymentType(raw: string | null | undefined): OutletPaymentType | null {
  if (raw == null) return null;
  const v = String(raw).trim().toUpperCase();
  if (v === 'BANK') return OutletPaymentType.BANK;
  if (v === 'UPI') return OutletPaymentType.UPI;
  if (v === 'ANY') return OutletPaymentType.ANY;
  return null;
}

/** The payment modes a rep may use for an outlet, honoring the tenant UPI gate. */
export function allowedPaymentModes(
  requiredType: OutletPaymentType,
  upiEnabled: boolean,
): PaymentMode[] {
  if (requiredType === OutletPaymentType.BANK) return ['bank'];
  if (requiredType === OutletPaymentType.UPI) return upiEnabled ? ['upi'] : ['bank'];
  // ANY → rep chooses among tenant-allowed modes.
  return upiEnabled ? ['bank', 'upi'] : ['bank'];
}

/** The one mode the form must PIN (rep can't change), or null when the rep may choose. */
export function pinnedPaymentMode(
  requiredType: OutletPaymentType,
  upiEnabled: boolean,
): PaymentMode | null {
  const allowed = allowedPaymentModes(requiredType, upiEnabled);
  return allowed.length === 1 ? allowed[0] : null;
}

/** Validate a submitted paymentMode against the outlet's mandate + tenant gate. */
export function isPaymentModeAllowed(
  requiredType: OutletPaymentType,
  mode: PaymentMode,
  upiEnabled: boolean,
): boolean {
  return allowedPaymentModes(requiredType, upiEnabled).includes(mode);
}
