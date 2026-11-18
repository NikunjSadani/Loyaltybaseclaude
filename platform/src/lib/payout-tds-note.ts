import type { PayoutLedgerEntry } from '@/types';

function fmtInr(n: number) {
  return `₹${n.toLocaleString('en-IN')}`;
}

/**
 * The ONE plain-words TDS note for a payout row — shared by the on-screen statement row
 * (PayoutStatementRow) and the downloaded statement (buildStatementDoc), so they can never drift.
 * null when no TDS was withheld.
 */
export function payoutTdsNote(p: Pick<PayoutLedgerEntry, 'tdsWithheldPaise' | 'settledByTds' | 'grossAmountPaise' | 'payoutAmountPaise'>): string | null {
  if (!p.tdsWithheldPaise) return null;
  return p.settledByTds
    ? `Withheld as TDS ${fmtInr(p.tdsWithheldPaise / 100)} — ₹0 paid to you`
    : `TDS ${fmtInr(p.tdsWithheldPaise / 100)} withheld from ${fmtInr((p.grossAmountPaise ?? p.payoutAmountPaise + p.tdsWithheldPaise) / 100)}`;
}
