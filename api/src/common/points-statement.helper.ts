// Shared POINTS-STATEMENT builder: the single source of truth for a wallet's
// statement (passbook rows + opening/closing balance), used by BOTH the partner
// wallet (GET /v1/wallet/statement) and the sales outlet ledger (GET /v1/kyc/:id/ledger
// and /ledger/statement), so the two can never drift (mirrors payout-statement.helper).
//
// BALANCE RULE (owner decision D3): the Balance is the STORED `balanceAfter` written
// atomically with each row by WalletService.applyMovement. It is NEVER recomputed as
// Σ signed points — that diverges on clawback-shortfall rows (points −500, balance −300)
// and on pre-FIFO-fix expiry rows that floored at 0. Opening balance = the first in-range
// row's `balanceBefore` (or the last prior row's `balanceAfter` when the range is empty).

/** A WalletTransaction projection — everything the statement needs, nothing more. */
export interface StatementTx {
  id: string;
  createdAt: Date;
  transactionType: string;
  points: number; // SIGNED: + credit, − debit
  balanceBefore: number;
  balanceAfter: number;
  description: string | null;
  referenceType: string | null;
  referenceId: string | null;
}

/** Rows that move the (dormant, always-0) locked bucket, not the redeemable balance. */
export const NON_STATEMENT_TX_TYPES = ['LOCK_HOLDING', 'UNLOCK_HOLDING'] as const;

const byId = (a: StatementTx, b: StatementTx) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Chronological statement order: `createdAt` ASC, and WITHIN a same-timestamp group (several
 * rows written in one DB transaction share Postgres' transaction-start CURRENT_TIMESTAMP) the
 * balance-CHAIN order — each row's `balanceBefore` equals the previous row's `balanceAfter`.
 * When no row chains (corrupt / imported data) it falls back to `id` ASC; it never throws and
 * never drops a row. LOCK_HOLDING / UNLOCK_HOLDING rows are excluded. Pure; input is not mutated.
 */
export function orderStatementRows(rows: StatementTx[]): StatementTx[] {
  const main = rows.filter(
    (r) => !(NON_STATEMENT_TX_TYPES as readonly string[]).includes(r.transactionType),
  );
  main.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || byId(a, b));

  const out: StatementTx[] = [];
  let running: number | undefined; // the previous row's balanceAfter
  let i = 0;
  while (i < main.length) {
    const t = main[i].createdAt.getTime();
    let j = i + 1;
    while (j < main.length && main[j].createdAt.getTime() === t) j++;
    if (j - i === 1) {
      out.push(main[i]);
    } else {
      // Groups are tiny (a handful of rows), so the O(k²) pick is fine.
      const pending = main.slice(i, j); // already id-ASC within the group
      while (pending.length > 0) {
        let pick = -1;
        if (running !== undefined) pick = pending.findIndex((r) => r.balanceBefore === running);
        if (pick === -1) {
          // Chain head: a row whose balanceBefore is not produced by another pending row.
          pick = pending.findIndex(
            (r) => !pending.some((o) => o !== r && o.balanceAfter === r.balanceBefore),
          );
        }
        if (pick === -1) pick = 0; // corrupt chain (cycle) → lowest id
        const [row] = pending.splice(pick, 1);
        out.push(row);
        running = row.balanceAfter;
      }
    }
    running = out[out.length - 1].balanceAfter;
    i = j;
  }
  return out;
}

/**
 * Slice an ORDERED history (see orderStatementRows; it may include rows before the window) to
 * `start <= createdAt < endExclusive` and derive the opening/closing balance from the STORED
 * per-row balances. Either bound may be omitted.
 */
export function buildStatementWindow(
  ordered: StatementTx[],
  window: { start?: Date; endExclusive?: Date },
): { openingBalance: number; closingBalance: number; rows: StatementTx[] } {
  const startMs = window.start?.getTime() ?? -Infinity;
  const endMs = window.endExclusive?.getTime() ?? Infinity;

  let lastBefore: StatementTx | undefined;
  const rows: StatementTx[] = [];
  for (const r of ordered) {
    const ms = r.createdAt.getTime();
    if (ms < startMs) lastBefore = r;
    else if (ms < endMs) rows.push(r);
  }

  if (rows.length > 0) {
    return {
      openingBalance: rows[0].balanceBefore,
      closingBalance: rows[rows.length - 1].balanceAfter,
      rows,
    };
  }
  const carried = lastBefore?.balanceAfter ?? 0;
  return { openingBalance: carried, closingBalance: carried, rows };
}
