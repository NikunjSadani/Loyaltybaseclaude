/**
 * sales-trade-comparison.ts — typed client for GET /api/sales/trade-comparison.
 *
 * Powers the Bajaj sales-dashboard "Trade comparison" card (SO-and-above). For the caller's
 * subtree (or a drilled-into `memberId`), scoped by `outletType` (RLP = SSS / BSC = WHOLESALER)
 * and an optional `program`, returns the primary-KPI monthly-sale + target-met roll-up for three
 * buckets: current month, last month, and the 3-month average.
 *
 * NOTE on last3Months: the backend surfaces rounded averages of achieved/withTarget there, but the
 * owner's spec renders ONLY the pct for that bucket — the card therefore ignores its achieved/
 * withTarget. They are typed nullable here to match that render contract.
 *
 * The browser calls same-origin `/api/sales/trade-comparison`, which the Next rewrite forwards to
 * the backend `/v1/...`. Returns null on any failure so the caller can show an honest error state.
 */

export interface TradeTargetMet {
  achieved: number | null;
  withTarget: number | null;
  pct: number | null;
}

export interface TradeComparisonBucket {
  monthlySale: number;
  targetMet: TradeTargetMet;
}

export interface TradeComparisonResult {
  outletType: string | null;
  program: string | null;
  kpiCode: string | null;
  kpiName: string | null;
  member?: { id: string; name: string; roleLabel: string };
  buckets: {
    current: TradeComparisonBucket;
    lastMonth: TradeComparisonBucket;
    last3Months: TradeComparisonBucket;
  };
}

/**
 * Fetch the trade comparison for one outlet type (required — the toggle's RLP/BSC code), optionally
 * narrowed to a program and/or drilled into a direct report (`memberId`). Returns null on failure.
 */
export async function fetchTradeComparison(
  outletType: string,
  program?: string,
  memberId?: string,
): Promise<TradeComparisonResult | null> {
  const qs = new URLSearchParams();
  qs.set('outletType', outletType);
  qs.set('program', program ?? '');
  if (memberId) qs.set('memberId', memberId);
  try {
    const res = await fetch(`/api/sales/trade-comparison?${qs.toString()}`);
    const body = await res.json();
    if (!res.ok || !body?.success) return null;
    return body.data as TradeComparisonResult;
  } catch {
    return null;
  }
}
