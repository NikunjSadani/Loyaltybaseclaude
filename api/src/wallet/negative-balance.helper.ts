import { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Owner decision 2 + D1 (2026-11-19 — the retailer sees a negative balance as it is; "points owed" = how far below
 * zero the balance is): the extra wallet-summary fields a NEGATIVE wallet carries, so every wallet screen (partner app,
 * sales outlet view, admin outlet wallet) can say "You owe 2,986 pts from a reversed credit — …":
 *   owedPoints        = −redeemablePoints
 *   owedFromReversal  = the CURRENT negative stretch was caused (at least partly) by a credit reversal: a
 *                       CREDIT_REVERSAL movement after the last time the balance was at or above zero (fix round 3 —
 *                       A8 / B1: not "any historical over-reversal", and it covers debt restored / exposed, not only
 *                       over-reversal debt).
 * A wallet at 0 or above gets NOTHING added — its summary stays byte-identical (every Deoleo wallet: LEGACY never
 * pushes a wallet below 0), and no query is made.
 */
export async function negativeBalanceSignals(
  db: Db,
  wallet: { id: string; redeemablePoints: number } | null | undefined,
): Promise<{ owedPoints?: number; owedFromReversal?: boolean }> {
  if (!wallet || wallet.redeemablePoints >= 0) return {};
  const lastNonNegative = await db.walletTransaction.findFirst({
    where: { walletId: wallet.id, balanceAfter: { gte: 0 } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true },
  });
  const reversals = await db.walletTransaction.count({
    where: {
      walletId: wallet.id,
      referenceType: 'CREDIT_REVERSAL',
      ...(lastNonNegative ? { createdAt: { gt: lastNonNegative.createdAt } } : {}),
    },
  });
  return { owedPoints: -wallet.redeemablePoints, owedFromReversal: reversals > 0 };
}
