import { prisma } from './prisma';
import type { WalletBalance } from '@/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaTx = any; // Will be replaced with Prisma.TransactionClient once schema is generated

// ─── Typed Errors ─────────────────────────────────────────────────────────────

export class WalletError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

export class InsufficientPointsError extends WalletError {
  constructor(available: number, requested: number) {
    super(
      `Insufficient points: requested ${requested}, available ${available}`,
      'INSUFFICIENT_POINTS'
    );
    this.name = 'InsufficientPointsError';
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function getWalletByPartnerId(partnerId: string, tx: PrismaTx) {
  const wallet = await tx.wallet.findFirst({ where: { partnerId } });
  if (!wallet) throw new WalletError('Wallet not found for partner', 'WALLET_NOT_FOUND');
  return wallet;
}

// ─── Credit Points ────────────────────────────────────────────────────────────

/**
 * Atomically credit earned points to a partner's wallet and record the transaction.
 */
export async function creditPoints(
  partnerId: string,
  amount: number,
  _type: string,
  _schemeId?: string,
  referenceId?: string,
  description?: string
): Promise<void> {
  if (amount <= 0) throw new WalletError('Amount must be positive', 'INVALID_AMOUNT');

  await prisma.$transaction(async (tx: PrismaTx) => {
    const wallet = await getWalletByPartnerId(partnerId, tx);

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        earnedPoints: { increment: amount },
        redeemablePoints: { increment: amount },
        lifetimeEarned: { increment: amount },
        lastTransactionAt: new Date(),
      },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        transactionType: 'CREDIT_POINTS_EARNED',
        points: amount,
        balanceBefore: updated.earnedPoints - amount,
        balanceAfter: updated.earnedPoints,
        balanceType: 'EARNED',
        referenceType: referenceId ? 'SALES_INVOICE' : null,
        referenceId: referenceId ?? null,
        description: description ?? null,
      },
    });
  });
}

// ─── Debit Points ─────────────────────────────────────────────────────────────

/**
 * Atomically debit redeemable points from a partner's wallet. Throws if insufficient.
 */
export async function debitPoints(
  partnerId: string,
  amount: number,
  _type: string,
  description?: string
): Promise<void> {
  if (amount <= 0) throw new WalletError('Amount must be positive', 'INVALID_AMOUNT');

  await prisma.$transaction(async (tx: PrismaTx) => {
    const wallet = await getWalletByPartnerId(partnerId, tx);

    if (wallet.redeemablePoints < amount) {
      throw new InsufficientPointsError(wallet.redeemablePoints, amount);
    }

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        redeemablePoints: { decrement: amount },
        redeemedPoints: { increment: amount },
        lifetimeRedeemed: { increment: amount },
        lastTransactionAt: new Date(),
      },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        transactionType: 'DEBIT_REDEMPTION',
        points: -amount,
        balanceBefore: updated.redeemablePoints + amount,
        balanceAfter: updated.redeemablePoints,
        balanceType: 'REDEEMABLE',
        description: description ?? null,
      },
    });
  });
}

// ─── Get Wallet Balance ───────────────────────────────────────────────────────

/**
 * Return the current balance breakdown for a partner's wallet.
 */
export async function getWalletBalance(partnerId: string): Promise<WalletBalance> {
  const wallet = await prisma.wallet.findFirst({ where: { partnerId } });

  if (!wallet) {
    return { earned: 0, locked: 0, redeemable: 0, redeemed: 0, expired: 0, available: 0 };
  }

  return {
    earned: wallet.earnedPoints,
    locked: wallet.lockedPoints,
    redeemable: wallet.redeemablePoints,
    redeemed: wallet.redeemedPoints,
    expired: wallet.expiredPoints,
    available: wallet.redeemablePoints,
  };
}
