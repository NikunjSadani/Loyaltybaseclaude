/**
 * Partner "My Orders" step model (docs/plans/ORDER-TIMELINE-STEPPER-PLAN.md §3, owner D1–D5).
 * Pure — no React, no fetch. One builder feeds both the compact progress bar (no history)
 * and the dated vertical stepper (history + refundedAt from GET /api/rewards/orders/:id/track).
 */

export type OrderKind = 'physical' | 'voucher' | 'cash';
export type StepState = 'complete' | 'current' | 'upcoming' | 'failed';

export interface OrderStep {
  key: string;
  label: string;
  state: StepState;
  date?: string;
  sublabel?: string;
}

/** The member-safe order fields the builder reads (all from the list endpoint). */
export interface OrderTimelineInput {
  status: string;
  redemptionMode?: string | null;
  voucherCode?: string | null;
  createdAt: string;
  /** Accepted but deliberately never used as a step date (any later edit moves it). */
  updatedAt?: string | null;
  dispatchedAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  trackingNumber?: string | null;
}

export interface HistoryEntry {
  fromStatus: string | null;
  toStatus: string;
  createdAt: string;
}

/** What `/track` adds when the partner expands an order. */
export interface OrderTracking {
  timeline: HistoryEntry[];
  /** When the order's points were refunded (its CREDIT_REVERSAL wallet row), else null. */
  refundedAt?: string | null;
}

export const REFUND_COPY = 'Points refunded to your wallet';

const VOUCHER_MODES = new Set(['GIFT_CARD', 'VOUCHER']);
const CASH_MODES = new Set(['UPI', 'BANK_TRANSFER']);
const TERMINAL = new Set(['CANCELLED', 'FAILED', 'RETURNED']);

/** Same voucher rule as the page's `isVoucher` (mode OR a code present). */
export function orderKind(o: Pick<OrderTimelineInput, 'redemptionMode' | 'voucherCode'>): OrderKind {
  const mode = o.redemptionMode ?? '';
  if (VOUCHER_MODES.has(mode) || !!o.voucherCode) return 'voucher';
  if (CASH_MODES.has(mode)) return 'cash';
  return 'physical';
}

type Template = { key: string; label: string; status: string }[];
const PLACED = { key: 'placed', label: 'Order placed', status: 'PENDING' };
const CONFIRMED = { key: 'confirmed', label: 'Confirmed', status: 'CONFIRMED' };
const TEMPLATES: Record<OrderKind, Template> = {
  physical: [
    PLACED,
    CONFIRMED,
    { key: 'processing', label: 'Processing', status: 'PROCESSING' },
    { key: 'dispatched', label: 'Dispatched', status: 'DISPATCHED' },
    { key: 'delivered', label: 'Delivered', status: 'DELIVERED' },
  ],
  voucher: [PLACED, CONFIRMED, { key: 'issued', label: 'Voucher issued', status: 'DELIVERED' }],
  cash: [{ ...PLACED, label: 'Request placed' }, CONFIRMED, { key: 'paid', label: 'Paid to your bank', status: 'DELIVERED' }],
};

/** Template index a status proves was reached (vouchers/cash fold PROCESSING/DISPATCHED into Confirmed). */
function reachedIndex(kind: OrderKind, status: string): number | undefined {
  const last = TEMPLATES[kind].length - 1;
  switch (status) {
    case 'PENDING': return 0;
    case 'CONFIRMED': return 1;
    case 'PROCESSING': return kind === 'physical' ? 2 : 1;
    case 'DISPATCHED': return kind === 'physical' ? 3 : 1;
    case 'DELIVERED': return last;
    default: return undefined;
  }
}

const validDate = (d?: string | null) => (d && !Number.isNaN(new Date(d).getTime()) ? d : undefined);

export function buildOrderSteps(order: OrderTimelineInput, tracking?: OrderTracking): OrderStep[] {
  const kind = orderKind(order);
  const template = TEMPLATES[kind];
  const last = template.length - 1;
  const history = [...(tracking?.timeline ?? [])].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  // Latest history row per toStatus (an order can in theory revisit a status; newest wins).
  const historyDate = (status: string) =>
    validDate([...history].reverse().find((h) => h.toStatus === status)?.createdAt);
  const columnDate = (status: string) =>
    status === 'PENDING' ? order.createdAt
      : status === 'DISPATCHED' ? order.dispatchedAt
        : status === 'DELIVERED' ? order.deliveredAt
          : status === 'CANCELLED' ? order.cancelledAt
            : undefined;
  const dateFor = (status: string) => historyDate(status) ?? validDate(columnDate(status));
  const issued = kind === 'voucher' && !!order.voucherCode;

  const step = (i: number, state: StepState): OrderStep => {
    const t = template[i];
    const s: OrderStep = { key: t.key, label: t.label, state };
    const date = state === 'upcoming' ? undefined : dateFor(t.status);
    if (date) s.date = date;
    if (t.key === 'dispatched' && order.trackingNumber && state !== 'upcoming') {
      s.sublabel = `Tracking: ${order.trackingNumber}`;
    }
    return s;
  };

  // Terminal branch: the steps actually reached, then one failed step; no upcoming steps.
  if (TERMINAL.has(order.status)) {
    const evidence = [
      1, // every listed terminal order got past OTP (never-confirmed cancels are hidden — D4)
      ...history.map((h) => reachedIndex(kind, h.toStatus) ?? 0),
      order.dispatchedAt ? reachedIndex(kind, 'DISPATCHED')! : 0,
      order.deliveredAt || issued ? last : 0,
    ];
    const reached = Math.max(...evidence);
    const steps = template.slice(0, reached + 1).map((_, i) => step(i, 'complete'));
    const label =
      order.status === 'CANCELLED' ? 'Cancelled'
        : order.status === 'RETURNED' ? 'Returned'
          : kind === 'cash' ? 'Payment failed' : 'Failed';
    const failed: OrderStep = { key: order.status.toLowerCase(), label, state: 'failed' };
    const date = dateFor(order.status);
    if (date) failed.date = date;
    if (tracking?.refundedAt) failed.sublabel = REFUND_COPY;
    return [...steps, failed];
  }

  let current = reachedIndex(kind, order.status);
  if (current === undefined) {
    // Unknown / future status (e.g. REVERSED): never throw, show it as-is.
    return [step(0, 'complete'), { key: 'status', label: order.status, state: 'current' }];
  }
  if (order.status === 'PENDING') current = 1; // waiting on the OTP to confirm
  // Ops can march a manual voucher through PROCESSING/DISPATCHED: it is "being issued" until a code exists.
  if (kind === 'voucher' && (order.status === 'PROCESSING' || order.status === 'DISPATCHED')) current = last;
  if ((issued && order.status !== 'PENDING') || order.status === 'DELIVERED') current = last + 1; // finished

  return template.map((_, i) => {
    const s = step(i, i < current! ? 'complete' : i === current ? 'current' : 'upcoming');
    if (s.state === 'current' && order.status === 'PENDING') s.sublabel = 'Waiting for OTP confirmation';
    if (s.state === 'current' && kind === 'voucher' && i === last) s.sublabel = 'Being processed';
    return s;
  });
}
