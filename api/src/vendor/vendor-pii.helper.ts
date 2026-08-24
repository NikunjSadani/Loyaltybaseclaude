/**
 * Vendor PII retention / time-boxing (Gift Catalogue & Dispatch, decision #16) —
 * PURE + DI-free.
 *
 * A vendor receives the FULL delivery name/address/phone (decision #15 — exactly what
 * is needed to ship). But the vendor's view of that PII is TIME-BOXED: withheld once
 * the order has been in a TERMINAL state for longer than `vendorPiiRetentionDays`
 * (default 180 = 6 months, covering refund + warranty). The order/status/tracking
 * remain visible to the vendor; ONLY the PII fields are blanked, and ONLY in the
 * vendor's view — Gifsy ops + the member keep full access, nothing is deleted.
 *
 * An OPEN return/warranty/dispute PAUSES the clock: while the order is still in-flight
 * (non-terminal) the vendor keeps address visibility. RETURNED is treated as an open
 * dispute state → PII stays visible (the clock is paused until it resolves, which in
 * v1 has no further state, so RETURNED keeps PII indefinitely — the safe direction).
 */

import { RedemptionStatus } from '@prisma/client';

/** Default retention window (days) after an order reaches a terminal state. */
export const VENDOR_PII_RETENTION_DAYS = 180;

/**
 * Terminal states whose completion STARTS the retention clock. RETURNED is
 * deliberately EXCLUDED — an open return/dispute pauses the clock (decision #16).
 */
const RETENTION_CLOCK_STATES: RedemptionStatus[] = [
  RedemptionStatus.DELIVERED,
  RedemptionStatus.CANCELLED,
  RedemptionStatus.FAILED,
];

export interface VendorPiiStatusHistoryEntry {
  toStatus: RedemptionStatus;
  createdAt: Date;
}

export interface VendorPiiOrderShape {
  status: RedemptionStatus;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  updatedAt: Date;
  /**
   * Status-history transition rows (optional). The `createdAt` of the transition INTO
   * the current terminal state is the STABLE retention-clock start — immune to later
   * `updatedAt` bumps (Wave-2 audit MED#4). Supplied by the vendor order select; when
   * absent the derivation falls back to `updatedAt`.
   */
  statusHistory?: VendorPiiStatusHistoryEntry[];
}

/**
 * Resolve the STABLE timestamp at which the order entered its CURRENT terminal state —
 * the retention-clock start. Order of preference (Wave-2 audit MED#4 + LOW#7):
 *   1. the dedicated write-once column (deliveredAt / cancelledAt) when set;
 *   2. the status-history transition INTO the current terminal state (the source of
 *      truth for FAILED, which has no dedicated column, and a fallback for a
 *      DELIVERED/CANCELLED row whose column was never stamped);
 *   3. `updatedAt` as a LAST resort so a terminal order ALWAYS ages out (never stays
 *      visible forever). This is safe because vendor writes on terminal orders are now
 *      blocked (vendor-portal MED#4b), so `updatedAt` can no longer restart the clock.
 */
function resolveTerminalAt(order: VendorPiiOrderShape): Date | null {
  if (order.status === RedemptionStatus.DELIVERED && order.deliveredAt) return order.deliveredAt;
  if (order.status === RedemptionStatus.CANCELLED && order.cancelledAt) return order.cancelledAt;

  const histAt = (order.statusHistory ?? [])
    .filter((h) => h.toStatus === order.status)
    .map((h) => h.createdAt)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  if (histAt) return histAt;

  return order.updatedAt ?? null;
}

/**
 * True when the vendor's view of an order should WITHHOLD delivery PII — i.e. the
 * order has been terminal (DELIVERED/CANCELLED/FAILED) for MORE than `retentionDays`.
 * In-flight orders and RETURNED (open dispute) always return false (PII shown). The
 * terminal timestamp comes from a STABLE source ({@link resolveTerminalAt}) so a
 * later mutation cannot reset the clock (Wave-2 audit MED#4).
 */
export function shouldWithholdVendorPii(
  order: VendorPiiOrderShape,
  now: Date = new Date(),
  retentionDays: number = VENDOR_PII_RETENTION_DAYS,
): boolean {
  if (!RETENTION_CLOCK_STATES.includes(order.status)) return false;

  const terminalAt = resolveTerminalAt(order);
  if (!terminalAt) return false; // no timestamp at all → cannot age it out; keep visible

  const ageMs = now.getTime() - terminalAt.getTime();
  return ageMs > retentionDays * 24 * 60 * 60 * 1000;
}

/** The order PII fields the vendor view blanks once retention elapses. */
export const VENDOR_PII_FIELDS = [
  'deliveryName',
  'deliveryPhone',
  'deliveryAddressLine1',
  'deliveryAddressLine2',
  'deliveryCity',
  'deliveryState',
  'deliveryPincode',
] as const;

/**
 * Return a shallow copy of an order-view object with the PII fields nulled when
 * {@link shouldWithholdVendorPii} is true; otherwise return it unchanged. Adds a
 * `piiWithheld` boolean so the FE can show a "retained-for-privacy" note.
 */
export function applyVendorPiiRetention<T extends VendorPiiOrderShape & Record<string, unknown>>(
  order: T,
  now: Date = new Date(),
  retentionDays: number = VENDOR_PII_RETENTION_DAYS,
): T & { piiWithheld: boolean } {
  const withhold = shouldWithholdVendorPii(order, now, retentionDays);
  if (!withhold) return { ...order, piiWithheld: false };
  const masked: Record<string, unknown> = { ...order, piiWithheld: true };
  for (const f of VENDOR_PII_FIELDS) masked[f] = null;
  return masked as T & { piiWithheld: boolean };
}
