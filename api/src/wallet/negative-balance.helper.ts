import { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Owner decision 2 (2026-11-19 — the retailer sees a negative balance as it is): the extra wallet-summary fields a
 * NEGATIVE wallet carries, so every wallet screen (partner app, sales outlet view, admin outlet wallet) can say
 * "You owe 2,986 pts from a reversed credit — it's repaid from your next earnings":
 *   owedPoints        = −redeemablePoints (what must be earned back before anything is redeemable again)
 *   owedFromReversal  = the wallet carries debt booked by a V2 over-reversal (overReversalDebt allocation)
 * A wallet at 0 or above gets NOTHING added — its summary stays byte-identical (every Deoleo wallet: LEGACY never
 * pushes a wallet below 0), and no query is made.
 */
export async function negativeBalanceSignals(
  db: Db,
  wallet: { id: string; redeemablePoints: number } | null | undefined,
): Promise<{ owedPoints?: number; owedFromReversal?: boolean }> {
  if (!wallet || wallet.redeemablePoints >= 0) return {};
  const fromReversal = await db.creditReversalAllocation.count({
    where: { overReversalDebt: true, position: { walletId: wallet.id } },
  });
  return { owedPoints: -wallet.redeemablePoints, owedFromReversal: fromReversal > 0 };
}
