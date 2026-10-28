/**
 * Canonical user-facing labels for a reward-catalogue item's `redemptionMode`
 * (the backend PayoutMode enum: GIFT_CARD | PHYSICAL_GIFT | UPI | BANK_TRANSFER).
 *
 * The two cash modes (UPI / BANK_TRANSFER) are a single product concept —
 * "Cash Payout" (points → ₹, settled to the partner's on-file beneficiary). The
 * backend keeps BOTH enum values valid (no enum change / no data migration); the
 * admin editor now offers one canonical "Cash Payout" (stored as BANK_TRANSFER),
 * and every display of a raw mode is routed through this helper so EXISTING
 * stored-UPI/BANK items read as "Cash Payout" too.
 */
export type RedemptionMode = 'GIFT_CARD' | 'PHYSICAL_GIFT' | 'UPI' | 'BANK_TRANSFER';

/** Cash modes (points → ₹). Both display as "Cash Payout". */
export const CASH_REDEMPTION_MODES: ReadonlySet<string> = new Set(['UPI', 'BANK_TRANSFER']);

/** The canonical stored value for a cash catalogue item (UPI collapses to it). */
export const CANONICAL_CASH_MODE: RedemptionMode = 'BANK_TRANSFER';

/**
 * Map a stored `redemptionMode` to its user-facing label.
 * - UPI | BANK_TRANSFER → "Cash Payout"
 * - GIFT_CARD           → "Gift Card / Voucher"
 * - PHYSICAL_GIFT       → "Physical Gift"
 * - null/undefined      → "—"  (preserves existing `?? '—'` display)
 * - any unknown string  → the raw value (honest fallback for a future mode)
 */
export function redemptionModeLabel(mode: string | null | undefined): string {
  switch (mode) {
    case 'UPI':
    case 'BANK_TRANSFER':
      return 'Cash Payout';
    case 'GIFT_CARD':
      return 'Gift Card / Voucher';
    case 'PHYSICAL_GIFT':
      return 'Physical Gift';
    default:
      return mode ?? '—';
  }
}

/** Collapse a stored mode to the canonical select value (UPI → BANK_TRANSFER). */
export function canonicalRedemptionMode(mode: string): string {
  return mode === 'UPI' ? CANONICAL_CASH_MODE : mode;
}
