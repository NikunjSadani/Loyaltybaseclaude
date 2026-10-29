/**
 * Shared ₹-selling-value → points-cost derivation (single source of truth).
 *
 * value(₹) = points ÷ rate, where `rate` is the tenant conversion rate (points-per-₹),
 * so points = ₹ × rate. `sellingValuePaise / 100` = ₹. A missing / non-positive rate
 * (unset or misconfigured tenant) yields 0 — callers treat a 0 result as "cannot price
 * this fixed item yet" and reject it with a clear message.
 *
 * Used by:
 *   - rewards.service (admin /admin/gifts create/update — PURE DERIVE, no manual input),
 *   - gift-catalogue.service (publish-to-tenant pricing — delegates here).
 */
export function derivePointsCost(sellingValuePaise: number, rate: number): number {
  if (!rate || rate <= 0) return 0;
  return Math.round((sellingValuePaise / 100) * rate);
}
