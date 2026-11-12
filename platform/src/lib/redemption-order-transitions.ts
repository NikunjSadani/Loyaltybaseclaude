/**
 * Admin "Advance" options for a redemption order — a MIRROR of the backend's guarded edge-map
 * in `RewardsService.transitionOrder` (api/src/rewards/rewards.service.ts, the `allowed` table)
 * plus its per-order mode guards. The backend is the authority (it 400s anything else); this only
 * stops the console offering moves that can never succeed.
 *
 * Keep NEXT_STATUS identical to the backend table — pinned by
 * src/lib/__tests__/redemption-order-transitions.test.ts.
 */

import { CASH_REDEMPTION_MODES } from '@/lib/redemption-mode';

export const NEXT_STATUS: Readonly<Record<string, readonly string[]>> = {
  // PENDING only cancels: confirmation happens via the member's OTP confirm, never the console.
  PENDING:    ['CANCELLED'],
  CONFIRMED:  ['PROCESSING', 'CANCELLED', 'RETURNED'],
  PROCESSING: ['DISPATCHED', 'FAILED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED', 'RETURNED'],
  // DELIVERED → RETURNED is the v1 value-reversal edge (refunds points).
  DELIVERED:  ['RETURNED'],
};

/** Targets that re-credit the member's points (backend `isRefundTarget` / REFUND_TARGET_STATUSES). */
export const REFUND_TARGETS: ReadonlySet<string> = new Set(['CANCELLED', 'RETURNED', 'FAILED']);
/** Forward dispatch targets (backend C-3 `isForwardDispatchTarget`). */
export const FORWARD_DISPATCH_TARGETS: ReadonlySet<string> = new Set(['PROCESSING', 'DISPATCHED', 'DELIVERED']);

export interface TransitionableOrder {
  status: string;
  redemptionMode?: string | null;
  voucherProvider?: string | null;
  /** The stored voucher code — any non-empty value means "issued". */
  voucherCode?: string | null;
  /** Server indicator for viewers who don't receive the code itself (voucherCode is null). */
  voucherIssued?: boolean;
  /** The order was sent to Hubble and is stuck for ops — no manual refund (a voucher may exist). */
  hubbleNeedsReconcile?: boolean;
  /** Why it is stuck — a "never placed" reason keeps refunds available (mirrors the backend). */
  hubbleReconcileReason?: string | null;
}

/** Mirrors backend HUBBLE_NEVER_PLACED_REASONS: set before any Hubble order was placed. */
export const HUBBLE_NEVER_PLACED_REASONS: ReadonlySet<string> = new Set([
  'HUBBLE_NOT_CONFIGURED',
  'HUBBLE_INVALID_AMOUNT',
]);

/** Mirrors the backend `hasIssuedVoucher` (null / '' / whitespace-only = none). */
export function hasIssuedVoucher(code: string | null | undefined): boolean {
  return typeof code === 'string' && code.trim() !== '';
}

/**
 * The status moves the console may offer for this order:
 *  - cash (UPI / BANK_TRANSFER): none — refunds are UTR=FAILED-driven and settlement is the
 *    payout rail, so the backend rejects both refund targets and forward dispatch moves;
 *  - a Hubble-issued voucher: no refund targets (non-reversible once issued);
 *  - ANY order holding an issued voucher code: no refund targets until ops records
 *    "Voucher cancelled with vendor" (backend VOUCHER_ISSUED_REFUND_BLOCK, all providers).
 */
export function nextStatusOptions(order: TransitionableOrder): string[] {
  const edges = NEXT_STATUS[order.status] ?? [];
  const isCash = CASH_REDEMPTION_MODES.has(order.redemptionMode ?? '');
  const isHubble = (order.voucherProvider ?? '').trim().toLowerCase() === 'hubble';
  const voucherIssued = hasIssuedVoucher(order.voucherCode) || order.voucherIssued === true;
  return edges.filter((to) => {
    if (isCash && (REFUND_TARGETS.has(to) || FORWARD_DISPATCH_TARGETS.has(to))) return false;
    const hubbleBlocksRefund =
      order.hubbleNeedsReconcile === true &&
      !(HUBBLE_NEVER_PLACED_REASONS.has(order.hubbleReconcileReason ?? '') && !voucherIssued && !isHubble);
    if ((isHubble || voucherIssued || hubbleBlocksRefund) && REFUND_TARGETS.has(to)) return false;
    return true;
  });
}
