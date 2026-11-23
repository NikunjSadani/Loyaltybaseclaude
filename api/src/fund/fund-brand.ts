/**
 * Voucher BRAND key for the per-client brand discount (decision 14). The reward catalogue has NO brand column, so
 * the brand is derived from the catalogue item, most specific first:
 *   1. metadata.brand / metadata.brandName (the same keys the redemption report reads)  → `brand:<lower-case name>`
 *   2. the Hubble product id (every amount of one Hubble brand shares it)               → `hubble:<productId>`
 *   3. the catalogue item itself (a manual voucher with neither)                         → `item:<rewardId>`
 * The label is the brand name, else the item name. Pure.
 */
export interface FundBrand {
  brandKey: string;
  brandLabel: string;
}

function metaObj(m: unknown): Record<string, unknown> | null {
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
}

export function voucherBrandOf(reward: { id: string; name: string; metadata: unknown }): FundBrand {
  const m = metaObj(reward.metadata);
  for (const k of ['brand', 'brandName']) {
    const v = m?.[k];
    if (typeof v === 'string' && v.trim()) {
      return { brandKey: `brand:${v.trim().toLowerCase()}`, brandLabel: v.trim() };
    }
  }
  const pid = m?.hubbleProductId;
  if (typeof pid === 'string' && pid.trim()) {
    return { brandKey: `hubble:${pid.trim()}`, brandLabel: reward.name };
  }
  return { brandKey: `item:${reward.id}`, brandLabel: reward.name };
}
