import type { CreditUploadRow } from '@/types';

/** The one rounding sentence used on the preview (and mirrored in the operator guide). */
export const ROUNDING_COPY =
  'Points and ₹ payouts are applied in whole units — each amount is rounded to the nearest whole unit (.5 goes away from zero).';

/** "199.5 → 200 pts" / "₹199.5 → ₹200" / "−199.5 → −200 pts" for a row the parser rounded to a whole unit. */
export function roundedAmountText(r: CreditUploadRow): string {
  if (r.awardType === 'PAYOUT') {
    // r.amount is integer paise (whole rupees × 100); originalAmount is rupees as typed.
    return `₹${r.originalAmount} → ₹${(r.amount / 100).toLocaleString('en-IN')}`;
  }
  // A deduction row (negative points; only with the tenant's negative-deductions setting ON).
  if (r.amount < 0) {
    return `−${Math.abs(r.originalAmount ?? 0)} → −${Math.abs(r.amount).toLocaleString('en-IN')} pts`;
  }
  return `${r.originalAmount} → ${r.amount.toLocaleString('en-IN')} pts`;
}

/** OK rows whose typed amount was rounded (listed under "Before you confirm" → ROUNDED). */
export function roundedRows(rows: CreditUploadRow[]): CreditUploadRow[] {
  return rows.filter((r) => r.status === 'OK' && r.originalAmount !== undefined);
}
