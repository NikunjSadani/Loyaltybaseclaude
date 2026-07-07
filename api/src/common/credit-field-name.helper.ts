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

  // Per batch, the not-yet-consumed rows for THIS outlet (by outlet CODE).
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
        parsed = (raw as (BatchRow & { outletId?: string; awardType?: string })[]).filter(
          (r) => r && r.outletId === outletCode && r.awardType === 'POINTS',
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
