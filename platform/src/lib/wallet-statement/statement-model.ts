/**
 * Shared FE wallet-statement MODEL — the single source of truth for what the partner wallet AND
 * the sales outlet ledger downloads contain. Both pages build a StatementDoc here and hand it to
 * the same Excel / PDF renderers, so the two files can never drift.
 *
 * The points rows + opening/closing balance come from the backend statement endpoints
 * (GET /api/wallet/statement, GET /api/kyc/:id/ledger/statement), which use the STORED per-row
 * balances (owner decision D3). Nothing here recomputes a balance. ₹ payout rows are interleaved
 * with NO balance (D8). Lines are OLDEST first (D12). The download ignores the on-screen
 * Earn/Burn/KPI filters (D4) — callers pass the full range.
 */
import type { PayoutLedgerEntry } from '@/types';
import { istMonthKey } from '@/lib/ist-date';
import { payoutTdsNote } from '@/lib/payout-tds-note';

/** One row of the backend statement response (shared by both statement endpoints). */
export interface StatementApiRow {
  id: string;
  date: string; // ISO instant
  transactionType: string;
  description: string; // narration, else the per-type default
  narration: string | null; // RAW upload narration
  fieldName: string | null;
  points: number; // signed
  balanceBefore: number;
  balanceAfter: number;
  referenceType: string | null;
  referenceId: string | null;
}

export interface StatementApiResponse {
  openingBalance: number;
  closingBalance: number;
  currentBalance: number;
  rows: StatementApiRow[]; // OLDEST first
}

export type StatementLine =
  | { kind: 'points'; id: string; date: Date; description: string; type: string; points: number; balance: number }
  | { kind: 'payout'; id: string; date: Date; description: string; type: string; amountInr: number; utr: string };

export interface StatementDoc {
  title: string;
  outletName: string;
  outletCode: string;
  periodLabel: string; // e.g. "Apr 2026 – Jun 2026"
  openingBalance: number;
  closingBalance: number;
  lines: StatementLine[]; // OLDEST first
  generatedAt: Date;
}

/** Fixed document title (owner decision D11). */
export const STATEMENT_TITLE = 'Wallet Statement';

const TYPE_LABEL: Record<string, string> = {
  CREDIT_POINTS_EARNED: 'Earned',
  CREDIT_BONUS: 'Bonus',
  CREDIT_REVERSAL: 'Reversal',
  CREDIT_ADJUSTMENT: 'Credit adjustment',
  DEBIT_REDEMPTION: 'Redeemed',
  DEBIT_EXPIRY: 'Expired',
  DEBIT_ADJUSTMENT: 'Debit adjustment',
};

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "YYYY-MM" → "Apr 2026" (pure string maths — no timezone involved). */
function monthKeyLabel(key: string): string {
  const [y, m] = key.split('-');
  return `${MONTH_SHORT[Number(m) - 1] ?? m} ${y}`;
}

/** "Apr 2026" for a single month, else "Apr 2026 – Jun 2026". */
export function periodLabel(from: string, to: string): string {
  return from === to ? monthKeyLabel(from) : `${monthKeyLabel(from)} – ${monthKeyLabel(to)}`;
}

/** First instant of an IST month ("YYYY-MM" → 00:00 IST on the 1st), for an undated payout. */
function istMonthStart(key: string): Date {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1) - 330 * 60_000);
}

/**
 * A DEBIT_ADJUSTMENT row that carries a field name is an UPLOAD DEDUCTION (negative points in a credits upload).
 * A manual debit has no field name and keeps "Debit adjustment".
 */
export function isUploadDeductionRow(r: { transactionType: string; fieldName?: string | null }): boolean {
  return r.transactionType === 'DEBIT_ADJUSTMENT' && !!r.fieldName;
}

/** Type label for a statement / passbook row ("Deducted" for an upload deduction). */
export function statementTypeLabel(r: { transactionType: string; fieldName?: string | null }): string {
  if (isUploadDeductionRow(r)) return 'Deducted';
  return TYPE_LABEL[r.transactionType] ?? r.transactionType;
}

function pointsLine(r: StatementApiRow): StatementLine {
  // An upload deduction's server text already names the field ("320 points deducted — Target, November 2026 ·
  // <narration>") — never prefix the field name again.
  const description = isUploadDeductionRow(r)
    ? (r.narration ?? r.description)
    : r.fieldName
    ? r.narration
      ? `${r.fieldName} · ${r.narration}`
      : r.fieldName
    : r.description;
  return {
    kind: 'points',
    id: r.id,
    date: new Date(r.date),
    description,
    type: statementTypeLabel(r),
    points: r.points,
    balance: r.balanceAfter,
  };
}

function payoutLine(p: PayoutLedgerEntry): StatementLine {
  // Same dating as the on-screen statement: paid date once money hit, else when it was added.
  const date = p.paidAt ? new Date(p.paidAt) : p.uploadedAt ? new Date(p.uploadedAt) : istMonthStart(p.period);
  // B-L1: the same TDS note as the on-screen row; a payout settled by TDS has no UTR.
  const tdsNote = payoutTdsNote(p);
  return {
    kind: 'payout',
    id: p.id,
    date,
    description: `${p.kpiLabel} · ${monthKeyLabel(p.period)}${tdsNote ? ` · ${tdsNote}` : ''}`,
    type: p.status === 'PAID' ? 'Payout' : 'Payout (Pending)',
    amountInr: p.payoutAmountPaise / 100,
    utr: p.settledByTds ? '' : (p.utr ?? ''),
  };
}

/**
 * Build the downloadable statement. `api` is the backend statement for [from..to]; `payouts` is
 * the outlet's payout history (any range — filtered here to the same IST month window).
 */
export function buildStatementDoc(
  api: StatementApiResponse,
  payouts: PayoutLedgerEntry[],
  meta: { outletName: string; outletCode: string; from: string; to: string },
): StatementDoc {
  const points = api.rows.map(pointsLine); // already oldest-first in balance-chain order

  const payoutLines = payouts
    .filter((p) => p.status !== 'FAILED')
    .map(payoutLine)
    .filter((l) => {
      const k = istMonthKey(l.date);
      return k >= meta.from && k <= meta.to;
    })
    .sort((a, b) => +a.date - +b.date);

  // Stable merge: points keep their chain order; a payout goes after points at the same instant.
  const lines: StatementLine[] = [];
  let j = 0;
  for (const pl of points) {
    while (j < payoutLines.length && +payoutLines[j].date < +pl.date) lines.push(payoutLines[j++]);
    lines.push(pl);
  }
  while (j < payoutLines.length) lines.push(payoutLines[j++]);

  return {
    title: STATEMENT_TITLE,
    outletName: meta.outletName,
    outletCode: meta.outletCode,
    periodLabel: periodLabel(meta.from, meta.to),
    openingBalance: api.openingBalance,
    closingBalance: api.closingBalance,
    lines,
    generatedAt: new Date(),
  };
}
