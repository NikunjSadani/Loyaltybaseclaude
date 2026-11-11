/**
 * Hubble product contract (mirrors api/src/hubble/hubble.service.ts `HubbleProduct` and the
 * GET /v1/admin/rewards/hubble-products/:productId response). Amounts are whole RUPEES.
 *   FIXED    — Hubble issues only the listed `denominations` (e.g. Flipkart ₹150/₹300/…).
 *   FLEXIBLE — any whole-rupee amount between `minValue` and `maxValue` (e.g. Amazon Pay).
 */
export interface HubbleProduct {
  productId: string;
  name: string;
  denominationType: 'FIXED' | 'FLEXIBLE';
  denominations: number[];
  minValue: number | null;
  maxValue: number | null;
  maxVouchersPerOrder: number | null;
}

export interface HubbleProductLookup {
  product: HubbleProduct;
  /** Tenant points-per-₹ — points for an amount = round(amount × rate) (backend rule). */
  conversionRate: number;
  /** Tenant minimum voucher amount (₹) — smaller amounts can never be redeemed. */
  minVoucherFreeAmount: number;
}

/** Points the backend charges for a ₹ amount (Math.round, same as the redeem path). */
export function pointsForAmount(amount: number, conversionRate: number): number {
  return Math.round(amount * conversionRate);
}
