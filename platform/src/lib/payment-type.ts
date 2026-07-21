/**
 * FE mirror of api/src/common/payment-type.helper.ts — the per-outlet payout MANDATE
 * (`requiredPaymentType`) ↔ the KYC `paymentMode` ('bank' | 'upi'). MUST stay in sync with
 * the backend helper. Used by the outlet-upload validator + the KYC wizard toggle gating.
 *
 * TENANT GATE WINS: UPI is never usable when the tenant's salesApp.upiEnabled is false.
 */
export type OutletPaymentType = 'BANK' | 'UPI' | 'ANY';
export type PaymentMode = 'bank' | 'upi';

/** Case-insensitive parse of an uploaded payout-method cell → the enum, or null if invalid/blank. */
export function parseOutletPaymentType(raw: string | null | undefined): OutletPaymentType | null {
  if (raw == null) return null;
  const v = String(raw).trim().toUpperCase();
  if (v === 'BANK') return 'BANK';
  if (v === 'UPI') return 'UPI';
  if (v === 'ANY') return 'ANY';
  return null;
}

/** The payment modes a rep may use for an outlet, honoring the tenant UPI gate. */
export function allowedPaymentModes(
  requiredType: OutletPaymentType,
  upiEnabled: boolean,
): PaymentMode[] {
  if (requiredType === 'BANK') return ['bank'];
  if (requiredType === 'UPI') return upiEnabled ? ['upi'] : ['bank'];
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

/** Validate a chosen paymentMode against the outlet's mandate + tenant gate. */
export function isPaymentModeAllowed(
  requiredType: OutletPaymentType,
  mode: PaymentMode,
  upiEnabled: boolean,
): boolean {
  return allowedPaymentModes(requiredType, upiEnabled).includes(mode);
}
