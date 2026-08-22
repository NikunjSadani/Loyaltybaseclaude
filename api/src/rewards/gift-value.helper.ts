/**
 * Canonical redemption value freeze (Gift Catalogue & Dispatch, decision §14).
 *
 * For GIFT items the order value is the gift's ₹ selling price × quantity, frozen
 * at redeem — DECOUPLED from the points↔₹ conversion rate, so a later rate change
 * never re-values an already-placed gift. This single number is what 194R
 * (Source-2 sums DELIVERED `valuePaise` per PAN) and the Gift Disbursal report use.
 *
 * Cash rails (UPI / BANK_TRANSFER) are NOT gifts: they keep the existing
 * `points ÷ conversionRate` derivation because the frozen value IS the amount the
 * bank transfer pays out.
 *
 * A FREE_AMOUNT voucher has no fixed selling price (variable amount at redeem), so
 * `sellingValuePaiseSnapshot` is null for it and it too keeps points ÷ rate.
 */

import { roundToRupeePaise } from '../tds/tds.helpers';

export interface FrozenValueArgs {
  /** UPI / BANK_TRANSFER — keep points ÷ rate (this value = the payout amount). */
  isCashMode: boolean;
  /**
   * The gift's ₹ selling price (paise) snapshotted onto the order at redeem, or
   * null for non-gift / variable-amount items (→ fall back to points ÷ rate).
   */
  sellingValuePaiseSnapshot: number | null | undefined;
  /** Order quantity (>= 1). */
  quantity: number;
  /** Points being spent (the confirm-time debit). */
  points: number;
  /** Points↔₹ centi-rate (rate × 100) snapshotted at redeem; 0 → guarded. */
  rateCenti: number;
}

/**
 * Compute the frozen `valuePaise` for an order at confirm time.
 *  - GIFT (non-cash, has a selling-price snapshot) → sellingValuePaise × quantity.
 *  - everything else → round(points ÷ rate) to the rupee (existing behaviour).
 * rate 0 (misconfig) → 0n so the caller's zero-value guard can reject cash paths.
 */
export function computeFrozenValuePaise(args: FrozenValueArgs): bigint {
  const { isCashMode, sellingValuePaiseSnapshot, quantity, points, rateCenti } = args;

  // Use the snapshot ONLY when it is a real, positive value. A null/0 snapshot means
  // no fixed selling price was frozen (e.g. a FREE_AMOUNT choose-your-value voucher, or
  // a backfill that skipped a valueless row) → fall through to points÷rate, which is the
  // actual redeemed value. (A 0 snapshot would otherwise zero out 194R Source-2 + the
  // disbursal report — the FREE_AMOUNT under-reporting bug.)
  if (!isCashMode && sellingValuePaiseSnapshot != null && sellingValuePaiseSnapshot > 0) {
    const qty = quantity && quantity > 0 ? quantity : 1;
    return BigInt(sellingValuePaiseSnapshot) * BigInt(qty);
  }

  // value(₹) = points ÷ rate; centi-rate integer math avoids truncating a
  // fractional rate: paise = points × 10000 ÷ (rate × 100).
  return rateCenti > 0
    ? roundToRupeePaise((BigInt(points) * 10000n) / BigInt(rateCenti))
    : 0n;
}
