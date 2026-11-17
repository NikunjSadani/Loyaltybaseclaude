import { pointsForAmount } from '@/lib/hubble-product';

/**
 * The ₹ redemption band of a typed-amount (FREE_AMOUNT) voucher, as the redeemer sees it.
 * Shared by the partner voucher sheet (partner/rewards) and the sales-assisted "redeem for
 * outlet" sheet (sales/catalogue).
 *
 * The ADMIN sets the band per item in POINTS (RewardCatalog.minRedemptionPoints /
 * maxRedemptionPoints — for a Hubble brand the admin save validates it sits inside the brand's
 * real range). The server checks `round(amount × rate)` against [min, max] points, so the ₹
 * edges here are the smallest / largest WHOLE rupee whose points land inside the band — the
 * sheet's block and the server's check therefore agree exactly at any rate.
 *   min = the higher of the item's min and the tenant floor (₹)
 *         (the floor alone when the item has no min, or the rate is unknown)
 *   max = the item's max (null when the item has none, or the rate is unknown → no max shown)
 */
export function voucherAmountBand(
  item: { minRedemptionPoints?: number | null; maxRedemptionPoints?: number | null },
  floorInr: number,
  rate: number,
): { min: number; max: number | null } {
  const floor = Number.isFinite(floorInr) && floorInr > 0 ? floorInr : 0;
  const hasRate = Number.isFinite(rate) && rate > 0;
  const minPts = item.minRedemptionPoints;
  const maxPts = item.maxRedemptionPoints;
  let itemMin: number | null = null;
  let itemMax: number | null = null;
  if (hasRate && minPts != null && minPts > 0) {
    // ceil(minPts / rate) always clears the band (round(x) ≥ n when x ≥ n); step down while a
    // smaller whole rupee still rounds into it (non-integer rates).
    let a = Math.max(1, Math.ceil(minPts / rate));
    for (let i = 0; i < 1000 && a > 1 && pointsForAmount(a - 1, rate) >= minPts; i++) a--;
    itemMin = a;
  }
  if (hasRate && maxPts != null && maxPts > 0) {
    // floor(maxPts / rate) never exceeds it; step up while a larger whole rupee still rounds into it.
    let a = Math.floor(maxPts / rate);
    for (let i = 0; i < 1000 && pointsForAmount(a + 1, rate) <= maxPts; i++) a++;
    itemMax = a;
  }
  return { min: Math.max(floor, itemMin ?? 0), max: itemMax };
}
