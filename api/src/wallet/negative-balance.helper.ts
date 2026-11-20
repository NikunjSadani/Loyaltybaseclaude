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
): Promise<{ owedPoints?: number; owedFromReversal?: boolean }> {
  if (!wallet || wallet.redeemablePoints >= 0) return {};
  const sequenced = (wallet.movementSeq ?? 0) > 0;
  let reversals: number;
  if (sequenced) {
    const lastNonNegative = await db.walletTransaction.findFirst({
      where: { walletId: wallet.id, balanceAfter: { gte: 0 }, seq: { not: null } },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    reversals = await db.walletTransaction.count({
      where: {
        walletId: wallet.id,
        creditReversalId: { not: null },
        ...(lastNonNegative?.seq != null ? { seq: { gt: lastNonNegative.seq } } : {}),
      },
    });
  } else {
    const lastNonNegative = await db.walletTransaction.findFirst({
      where: { walletId: wallet.id, balanceAfter: { gte: 0 } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    });
    reversals = await db.walletTransaction.count({
      where: {
        walletId: wallet.id,
        referenceType: 'CREDIT_REVERSAL',
        ...(lastNonNegative ? { createdAt: { gt: lastNonNegative.createdAt } } : {}),
      },
    });
  }
  return { owedPoints: -wallet.redeemablePoints, owedFromReversal: reversals > 0 };
}
