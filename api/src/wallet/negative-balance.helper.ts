import { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Owner decision 2 + D1 (2026-11-19 — the retailer sees a negative balance as it is; "points owed" = how far below
 * zero the balance is): the extra wallet-summary fields a NEGATIVE wallet carries, so every wallet screen (partner app,
 * sales outlet view, admin outlet wallet) can say "You owe 2,986 pts from a reversed credit — …":
 *   owedPoints        = −redeemablePoints
 *   owedFromReversal  = the CURRENT negative stretch was caused (at least partly) by a credit reversal: a wallet row of a
 *                       credit reversal AFTER the last row that left the balance at or above zero.
 * Fix round 4 (item 2): "after" is decided by the per-wallet movement `seq` on a sequenced wallet (exact under the
 * wallet lock — no clock ties, no earn-before-lock race); a wallet that was never sequenced (only LEGACY rows, which
 * never take a balance below zero by reversal) falls back to row timestamps.
 * A wallet at 0 or above gets NOTHING added — its summary stays byte-identical (every Deoleo wallet), and no query is
 * made.
 */
export async function negativeBalanceSignals(
  db: Db,
  wallet: { id: string; redeemablePoints: number; movementSeq?: number | null } | null | undefined,
): Promise<{ owedPoints?: number; owedFromReversal?: boolean; owedFromDeduction?: boolean; owedDeductionFields?: string[] }> {
  if (!wallet || wallet.redeemablePoints >= 0) return {};
  const sequenced = (wallet.movementSeq ?? 0) > 0;
  let reversals: number;
  // F4 (upload deductions): an UNDO give-back is a credit (CREDIT_REVERSAL) linked to a reversal — never a cause of a
  // negative balance, so it is not counted as "from a reversed credit".
  const notGiveBack = { transactionType: { not: 'CREDIT_REVERSAL' as const } };
  const deductionWhere = { transactionType: 'DEBIT_ADJUSTMENT' as const, referenceType: 'CREDIT_BATCH' };
  let deductions: Array<{ metadata: Prisma.JsonValue }>;
  const lastSeqRow = sequenced
    ? await db.walletTransaction.findFirst({
        where: { walletId: wallet.id, balanceAfter: { gte: 0 }, seq: { not: null } },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      })
    : null;
  if (sequenced && lastSeqRow?.seq != null) {
    reversals = await db.walletTransaction.count({
      where: { walletId: wallet.id, creditReversalId: { not: null }, seq: { gt: lastSeqRow.seq }, ...notGiveBack },
    });
    deductions = (await db.walletTransaction.findMany({
      where: { walletId: wallet.id, ...deductionWhere, seq: { gt: lastSeqRow.seq } },
      select: { metadata: true },
    })) ?? [];
  } else {
    // Never sequenced, or (round 5, B7) the last row at or above zero carries no seq (history from before
    // sequencing): compare by row time.
    const lastNonNegative = await db.walletTransaction.findFirst({
      where: { walletId: wallet.id, balanceAfter: { gte: 0 } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    });
    reversals = await db.walletTransaction.count({
      where: {
        walletId: wallet.id,
        referenceType: 'CREDIT_REVERSAL',
        ...notGiveBack,
        ...(lastNonNegative ? { createdAt: { gt: lastNonNegative.createdAt } } : {}),
      },
    });
    deductions = (await db.walletTransaction.findMany({
      where: { walletId: wallet.id, ...deductionWhere, ...(lastNonNegative ? { createdAt: { gt: lastNonNegative.createdAt } } : {}) },
      select: { metadata: true },
    })) ?? [];
  }
  // owedFromDeduction: an upload deduction in the current negative stretch → "balance is below zero because points were
  // deducted (<field>)". Only rows tagged kind UPLOAD_DEDUCTION count (a manual debit never goes below zero).
  const fields: string[] = [];
  for (const d of deductions) {
    const m = d.metadata && typeof d.metadata === 'object' && !Array.isArray(d.metadata) ? (d.metadata as Record<string, unknown>) : null;
    if (m?.kind !== 'UPLOAD_DEDUCTION') continue;
    const f = typeof m.fieldName === 'string' ? m.fieldName : null;
    if (f && !fields.includes(f)) fields.push(f);
    else if (!f && fields.length === 0) fields.push('');
  }
  const owedFromDeduction = fields.length > 0;
  return {
    owedPoints: -wallet.redeemablePoints,
    owedFromReversal: reversals > 0,
    ...(owedFromDeduction ? { owedFromDeduction: true, owedDeductionFields: fields.filter((f) => f) } : {}),
  };
}
