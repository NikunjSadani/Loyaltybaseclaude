/**
 * Test fixtures for GET /api/wallet/statement — the REAL response shape the wallet page reads
 * (replaces the old paginated /api/wallet/transactions mock). `points` is SIGNED (debits
 * negative) exactly as the backend stores it; rows are OLDEST first; balanceBefore is derived
 * from balanceAfter − points so every fixture is a consistent balance chain.
 */
import type { StatementApiRow } from '@/lib/wallet-statement/statement-model';

export type StatementRowInput = Pick<StatementApiRow, 'id' | 'transactionType' | 'description' | 'points' | 'date' | 'balanceAfter'> &
  Partial<StatementApiRow>;

export function statementRow(r: StatementRowInput): StatementApiRow {
  return {
    narration: null,
    fieldName: null,
    referenceType: null,
    referenceId: null,
    balanceBefore: r.balanceAfter - r.points,
    ...r,
  };
}

/** `{ success, data }` envelope for /api/wallet/statement. Input rows may be in any order. */
export function statementPayload(rows: StatementRowInput[], outletCode = 'OUT-1') {
  const ordered = rows.map(statementRow).sort((a, b) => +new Date(a.date) - +new Date(b.date));
  const opening = ordered.length ? ordered[0].balanceBefore : 0;
  const closing = ordered.length ? ordered[ordered.length - 1].balanceAfter : 0;
  return {
    success: true,
    data: { openingBalance: opening, closingBalance: closing, currentBalance: closing, outletCode, rows: ordered },
  };
}
