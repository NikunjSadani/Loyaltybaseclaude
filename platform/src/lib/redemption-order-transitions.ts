/**
 * Admin "Advance" options for a redemption order — a MIRROR of the backend's guarded edge-map
 * in `RewardsService.transitionOrder` (api/src/rewards/rewards.service.ts, the `allowed` table)
 * plus its per-order mode guards. The backend is the authority (it 400s anything else); this only
 * stops the console offering moves that can never succeed.
 *
 * Keep NEXT_STATUS identical to the backend table — pinned by
 * src/lib/__tests__/redemption-order-transitions.test.ts.
 */

export const NEXT_STATUS: Readonly<Record<string, readonly string[]>> = {
  // PENDING only cancels: confirmation happens via the member's OTP confirm, never the console.
  PENDING:    ['CANCELLED'],
  CONFIRMED:  ['PROCESSING', 'CANCELLED', 'RETURNED'],
  PROCESSING: ['DISPATCHED', 'FAILED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED', 'RETURNED'],
  // DELIVERED → RETURNED is the v1 value-reversal edge (refunds points).
  DELIVERED:  ['RETURNED'],
};

/** Targets that re-credit the member's points (backend `isRefundTarget`). */
const REFUND_TARGETS = new Set(['CANCELLED', 'RETURNED', 'FAILED']);
/** Forward dispatch targets (backend C-3 `isForwardDispatchTarget`). */
const FORWARD_DISPATCH_TARGETS = new Set(['PROCESSING', 'DISPATCHED', 'DELIVERED']);
const CASH_MODES = new Set(['UPI', 'BANK_TRANSFER']);

export interface TransitionableOrder {
  status: string;
  redemptionMode?: string | null;
  voucherProvider?: string | null;
}

/**
 * The status moves the console may offer for this order:
 *  - cash (UPI / BANK_TRANSFER): none — refunds are UTR=FAILED-driven and settlement is the
 *    payout rail, so the backend rejects both refund targets and forward dispatch moves;
 *  - a Hubble-issued voucher: no refund targets (non-reversible once issued).
 */
export function nextStatusOptions(order: TransitionableOrder): string[] {
  const edges = NEXT_STATUS[order.status] ?? [];
  const isCash = CASH_MODES.has(order.redemptionMode ?? '');
  const isHubble = order.voucherProvider === 'Hubble';
  return edges.filter((to) => {
    if (isCash && (REFUND_TARGETS.has(to) || FORWARD_DISPATCH_TARGETS.has(to))) return false;
    if (isHubble && REFUND_TARGETS.has(to)) return false;
    return true;
  });
}
