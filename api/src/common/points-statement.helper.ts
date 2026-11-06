import { BadRequestException } from '@nestjs/common';
import { CreditBatchReader, resolveCreditFieldNames } from './credit-field-name.helper';
import { istMonthBounds } from './ist-date';

// Shared POINTS-STATEMENT builder:the single source of truth for a wallet's
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
  return repairChainInversions(out);
}

/**
 * How far ahead (in createdAt time) the repair pass may look for the row that continues the chain.
 * createdAt is Postgres' TRANSACTION-START time, and the credit / payout batch transactions run with
 * `timeout: 180_000` (credits.service, payouts.service). So a batch row can be stamped up to ~180 s
 * EARLIER than a redemption that committed before the batch read the wallet. 200 s covers that with
 * margin; rows are never moved further than this, so a genuine break stays where it is (and the
 * D10 tie-out warning still fires for it).
 */
export const CHAIN_REPAIR_WINDOW_MS = 200_000;

/**
 * Bounded repair: when a row's balanceBefore ≠ the previous row's balanceAfter, look ahead (only
 * within CHAIN_REPAIR_WINDOW_MS of that row's stamp) for the first row whose balanceBefore DOES
 * match, and move it up into place. No match → leave the break as-is. Each move strictly fixes the
 * link at position i, so the pass terminates; it is O(n·k) with k = rows inside the window.
 */
function repairChainInversions(rows: StatementTx[]): StatementTx[] {
  const out = rows.slice();
  for (let i = 1; i < out.length; i++) {
    const want = out[i - 1].balanceAfter;
    if (out[i].balanceBefore === want) continue;
    const limit = out[i].createdAt.getTime() + CHAIN_REPAIR_WINDOW_MS;
    for (let j = i + 1; j < out.length && out[j].createdAt.getTime() <= limit; j++) {
      if (out[j].balanceBefore === want) {
        const [row] = out.splice(j, 1);
        out.splice(i, 0, row);
        break;
      }
    }
  }
  return out;
}

/**
 * Slice an ORDERED history (see orderStatementRows; it may include rows before the window) to
 * `start <= createdAt < endExclusive` and derive the opening/closing balance from the STORED
 * per-row balances. Either bound may be omitted.
 *
 * Window membership uses each row's EFFECTIVE time = the running max of createdAt along the ordered
 * list. For a plain chronological list that IS createdAt; for a row the repair pass moved after a
 * later-stamped row, it is that later stamp. So every range is a CONTIGUOUS slice of the ordered
 * chain — a repaired pair (or a same-timestamp group) never straddles a range edge, and adjacent
 * ranges always tie out (closing of one = opening of the next).
 */
export function buildStatementWindow(
  ordered: StatementTx[],
  window: { start?: Date; endExclusive?: Date },
): { openingBalance: number; closingBalance: number; rows: StatementTx[] } {
  const startMs = window.start?.getTime() ?? -Infinity;
  const endMs = window.endExclusive?.getTime() ?? Infinity;

  let lastBefore: StatementTx | undefined;
  const rows: StatementTx[] = [];
  let effective = -Infinity;
  for (const r of ordered) {
    effective = Math.max(effective, r.createdAt.getTime());
    const ms = effective;
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

/** Fallback description per transaction type (used when the row carries no narration). */
export function defaultTxDescription(transactionType: string): string {
  const map: Record<string, string> = {
    CREDIT_POINTS_EARNED: 'Points earned',
    CREDIT_BONUS: 'Bonus points credited',
    CREDIT_REVERSAL: 'Points reversed to wallet',
    CREDIT_ADJUSTMENT: 'Manual credit adjustment',
    DEBIT_REDEMPTION: 'Points redeemed',
    DEBIT_EXPIRY: 'Points expired',
    DEBIT_ADJUSTMENT: 'Manual debit adjustment',
    LOCK_HOLDING: 'Points locked',
    UNLOCK_HOLDING: 'Points unlocked',
  };
  return map[transactionType] ?? 'Wallet transaction';
}

// ─── DB loader ────────────────────────────────────────────────────────────────

/** Hard cap on rows in ONE requested range (the download). No-range (on-screen) loads are uncapped. */
export const MAX_STATEMENT_ROWS = 20_000;

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The minimal Prisma shape the loader needs (PrismaService or a tx client both satisfy it). */
export interface PointsStatementReader extends CreditBatchReader {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma's generic findMany args
  walletTransaction: { findMany: (args: any) => Promise<StatementTx[]> };
}

export type StatementRow = StatementTx & { fieldName: string | null };

export interface PointsStatement {
  openingBalance: number;
  closingBalance: number;
  rows: StatementRow[]; // OLDEST first
  /** Integrity of the WHOLE history (not just the window), for the caller's D10 tie-out warning. */
  historyClosingBalance: number | null; // last row's balanceAfter, null when the wallet has no rows
  chainBreaks: number; // rows whose balanceBefore ≠ the previous row's balanceAfter
}

/**
 * Load a wallet's full, UNPAGINATED points statement for an optional IST month range
 * (`from`/`to` = 'YYYY-MM', both or neither, inclusive). Loads ALL main rows for the wallet in
 * one query (per-wallet, indexed on walletId) so the same-timestamp chain ordering is correct at
 * the window edge, then orders → windows → caps → attaches the credit field name (resolved over
 * ALL the wallet's CREDIT_BATCH rows, exactly like loadPassbook, so consumption order is right).
 *
 * Tenant scope / caller authorization of `walletId` is the CALLER's responsibility; `clientId`
 * scopes the credit-batch lookup.
 */
export async function loadPointsStatement(
  prisma: PointsStatementReader,
  args: { walletId: string; clientId: string; outletCode: string; from?: string; to?: string },
): Promise<PointsStatement> {
  const { from, to } = args;
  if ((from === undefined) !== (to === undefined)) {
    throw new BadRequestException('Provide both from and to (YYYY-MM), or neither.');
  }
  let window: { start?: Date; endExclusive?: Date } = {};
  if (from !== undefined && to !== undefined) {
    if (!MONTH_KEY.test(from) || !MONTH_KEY.test(to)) {
      throw new BadRequestException('from and to must be YYYY-MM months.');
    }
    if (from > to) throw new BadRequestException('from must not be after to.');
    window = { start: istMonthBounds(from).start, endExclusive: istMonthBounds(to).endExclusive };
  }

  const all = await prisma.walletTransaction.findMany({
    where: { walletId: args.walletId, transactionType: { notIn: [...NON_STATEMENT_TX_TYPES] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      createdAt: true,
      transactionType: true,
      points: true,
      balanceBefore: true,
      balanceAfter: true,
      description: true,
      referenceType: true,
      referenceId: true,
    },
  });

  const ordered = orderStatementRows(all);
  const { openingBalance, closingBalance, rows } = buildStatementWindow(ordered, window);
  let chainBreaks = 0;
  for (let k = 1; k < ordered.length; k++) {
    if (ordered[k].balanceBefore !== ordered[k - 1].balanceAfter) chainBreaks++;
  }
  // The cap guards a requested RANGE (the download). The no-range load feeds the SCREENS (partner
  // wallet, sales ledger) and is never capped — a cap there would blank the statement.
  if (from !== undefined && rows.length > MAX_STATEMENT_ROWS) {
    throw new BadRequestException(
      `This statement has more than ${MAX_STATEMENT_ROWS} transactions. Please narrow the date range.`,
    );
  }

  const fieldNameByTxId = await resolveCreditFieldNames(
    prisma,
    args.clientId,
    args.outletCode,
    all.filter((r) => r.referenceType === 'CREDIT_BATCH'),
  );

  return {
    openingBalance,
    closingBalance,
    rows: rows.map((r) => ({ ...r, fieldName: fieldNameByTxId.get(r.id) ?? null })),
    historyClosingBalance: ordered.length ? ordered[ordered.length - 1].balanceAfter : null,
    chainBreaks,
  };
}

// ─── API response (shared by /wallet/statement and /kyc/:id/ledger/statement) ──

export interface StatementApiRow {
  id: string;
  date: string; // ISO instant (the FE formats it in IST)
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
  currentBalance: number; // live Wallet.redeemablePoints (what the balance card shows)
  outletCode: string; // the outlet the statement (and its credit field names) was resolved for
  rows: StatementApiRow[]; // OLDEST first
}

export const EMPTY_STATEMENT: StatementApiResponse = Object.freeze({
  openingBalance: 0,
  closingBalance: 0,
  currentBalance: 0,
  outletCode: '',
  rows: [],
}) as StatementApiResponse;

/**
 * Load + present a wallet's statement, and run the D10 tie-out on the FULL history: when the
 * last stored balanceAfter ≠ the live Wallet.redeemablePoints, or the balance chain has breaks,
 * log a server warning for ops — and STILL return the stored values (never block, no
 * partner-facing note).
 */
export async function buildStatementResponse(
  prisma: PointsStatementReader,
  logger: { warn: (message: string) => void },
  args: {
    wallet: { id: string; redeemablePoints: number };
    clientId: string;
    outletCode: string;
    from?: string;
    to?: string;
  },
): Promise<StatementApiResponse> {
  const { wallet } = args;
  const stmt = await loadPointsStatement(prisma, {
    walletId: wallet.id,
    clientId: args.clientId,
    outletCode: args.outletCode,
    from: args.from,
    to: args.to,
  });

  const historyClosing = stmt.historyClosingBalance ?? 0;
  if (historyClosing !== wallet.redeemablePoints || stmt.chainBreaks > 0) {
    logger.warn(
      `Wallet statement tie-out mismatch: walletId=${wallet.id} ` +
        `lastBalanceAfter=${historyClosing} redeemablePoints=${wallet.redeemablePoints} ` +
        `chainBreaks=${stmt.chainBreaks}`,
    );
  }

  return {
    openingBalance: stmt.openingBalance,
    closingBalance: stmt.closingBalance,
    currentBalance: wallet.redeemablePoints,
    outletCode: args.outletCode,
    rows: stmt.rows.map((r) => ({
      id: r.id,
      date: r.createdAt.toISOString(),
      transactionType: r.transactionType,
      description: r.description ?? defaultTxDescription(r.transactionType),
      narration: r.description,
      fieldName: r.fieldName,
      points: r.points,
      balanceBefore: r.balanceBefore,
      balanceAfter: r.balanceAfter,
      referenceType: r.referenceType,
      referenceId: r.referenceId,
    })),
  };
}
