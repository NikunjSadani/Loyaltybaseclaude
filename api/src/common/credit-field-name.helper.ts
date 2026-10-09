// Shared credit FIELD NAME resolver — used by BOTH the sales outlet ledger
// (kyc.service.ledger) and the partner's own wallet passbook (wallet.service.
// listTransactions), so the two screens can never drift.
//
// WalletTransaction does not persist the field name (it stores the CreditBatch
// id as referenceId + the narration as description). We resolve it read-time
// from the batch's `rows` JSON. Each credit tx maps 1:1 to one batch row
// (creditEarn is called once per POINTS row, in row order); we replay that by
// CONSUMING rows, so even same-amount / blank-narration rows map deterministically.

/** The minimal Prisma shape this helper needs (PrismaService or a tx client both satisfy it). */
export interface CreditBatchReader {
  creditBatch: { findMany: (args: unknown) => Promise<Array<{ id: string; rows: unknown }>> };
}

/** A credit-batch transaction as consumed by the resolver. */
export interface CreditTxn {
  id: string;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  points: number;
  createdAt: Date;
}

/**
 * Resolve the credit FIELD NAME for each CREDIT_BATCH transaction in `txns`.
 *
 * Returns a Map keyed by transaction id → resolved field name (or `null` for a
 * non-credit tx / a tx with no matching batch row). Callers may pass `txns` in
 * ANY order — the resolver sorts the credit txns oldest→newest internally so
 * consumption order mirrors the credit-time creditEarn call order.
 *
 * @param prisma      PrismaService or a $transaction client (only `creditBatch.findMany` is used).
 * @param clientId    Tenant scope for the batch lookup (never cross-tenant).
 * @param outletCode  The outlet CODE whose rows we replay (matched against `row.outletId`).
 * @param txns        The transactions to resolve (any order; non-CREDIT_BATCH ignored).
 */
export async function resolveCreditFieldNames(
  prisma: CreditBatchReader,
  clientId: string,
  outletCode: string,
  txns: CreditTxn[],
): Promise<Map<string, string | null>> {
  // The TRADE passbook matches batch rows by OUTLET code (`row.outletId`). Byte-identical to the
  // original behaviour — the match predicate is the only thing factored out so the EMPLOYEE variant
  // below can reuse the exact same consumption algorithm.
  return resolveCreditFieldNamesBy(
    prisma,
    clientId,
    txns,
    (r) => r.outletId === outletCode,
  );
}

/**
 * Employee Rewards Workstream 2 — the EMPLOYEE passbook variant of `resolveCreditFieldNames`.
 * Identical consumption algorithm, but matches batch rows by EMPLOYEE code: the employee credit
 * batch (CreditsService.confirmEmployeeBatch) resolves an employeeCode via `row.employeeCode ??
 * row.outletId` (the shared bulk row shape), so this mirrors that fallback. The TRADE resolver above
 * is untouched (it keys on `row.outletId`).
 */
export async function resolveEmployeeCreditFieldNames(
  prisma: CreditBatchReader,
  clientId: string,
  employeeCode: string,
  txns: CreditTxn[],
): Promise<Map<string, string | null>> {
  return resolveCreditFieldNamesBy(
    prisma,
    clientId,
    txns,
    (r) => (r.employeeCode ?? r.outletId) === employeeCode,
  );
}

/** Row fields the match predicate may read (plus the consumption fields below). */
type MatchableBatchRow = {
  fieldName?: string;
  amount?: number;
  narration?: string;
  outletId?: string;
  employeeCode?: string;
  awardType?: string;
};

/**
 * Shared core for both the TRADE (`resolveCreditFieldNames`) and EMPLOYEE
 * (`resolveEmployeeCreditFieldNames`) resolvers. The ONLY thing that varies is how a batch row is
 * matched to the ledger owner (`rowMatches`) — everything else (POINTS-only filter, oldest→newest
 * consumption, amount+narration tiebreak) is identical, so both passbooks can never drift.
 */
async function resolveCreditFieldNamesBy(
  prisma: CreditBatchReader,
  clientId: string,
  txns: CreditTxn[],
  rowMatches: (row: MatchableBatchRow) => boolean,
): Promise<Map<string, string | null>> {
  const fieldNameByTxId = new Map<string, string | null>();

  const creditTxns = txns.filter(
    (tx) => tx.referenceType === 'CREDIT_BATCH' && tx.referenceId,
  );
  if (creditTxns.length === 0) return fieldNameByTxId;

  const creditBatchIds = [
    ...new Set(creditTxns.map((tx) => tx.referenceId as string)),
  ];

  const batches = await prisma.creditBatch.findMany({
    where: { id: { in: creditBatchIds }, clientId },
    select: { id: true, rows: true },
  });

  // Per batch, the not-yet-consumed rows for THIS owner (matched by the caller's predicate).
  type BatchRow = { fieldName?: string; amount?: number; narration?: string };
  const rowsByBatch = new Map<string, BatchRow[]>();
  for (const batch of batches) {
    let parsed: BatchRow[] = [];
    // Defensive: a malformed/absent `rows` → treat as no rows (never throw).
    try {
      const raw = batch.rows as unknown;
      if (Array.isArray(raw)) {
        // POINTS rows only — a PAYOUT row (amount in paise) never credits the
        // wallet, so excluding it avoids a numeric amount collision consuming
        // the wrong row.
        parsed = (raw as MatchableBatchRow[]).filter(
          (r) => r && rowMatches(r) && r.awardType === 'POINTS',
        );
      }
    } catch {
      parsed = [];
    }
    rowsByBatch.set(batch.id, parsed);
  }

  // Iterate credit transactions OLDEST→NEWEST so consumption order mirrors the
  // credit-time creditEarn call order. Sort internally so callers may pass any order.
  const creditTxsOldestFirst = creditTxns
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const tx of creditTxsOldestFirst) {
    const pool = rowsByBatch.get(tx.referenceId as string);
    if (!pool || pool.length === 0) {
      fieldNameByTxId.set(tx.id, null);
      continue;
    }
    const txDesc = tx.description ?? '';
    // Prefer an amount + narration match; fall back to amount-only.
    let idx = pool.findIndex(
      (r) => r.amount === tx.points && (r.narration ?? '') === txDesc,
    );
    if (idx === -1) idx = pool.findIndex((r) => r.amount === tx.points);
    if (idx === -1) {
      fieldNameByTxId.set(tx.id, null);
      continue;
    }
    const [row] = pool.splice(idx, 1); // CONSUME so same-amount rows map 1:1
    fieldNameByTxId.set(tx.id, row.fieldName ?? null);
  }

  return fieldNameByTxId;
}
