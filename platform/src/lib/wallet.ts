import { prisma } from './prisma';
import type { WalletBalance } from '@/types';

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

async function getOrCreateWallet(userId: string, tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) {
  const wallet = await tx.wallet.upsert({
    where: { userId },
    create: {
      userId,
      earnedPoints: 0,
      lockedPoints: 0,
      redeemablePoints: 0,
      redeemedPoints: 0,
      expiredPoints: 0,
    },
    update: {},
  });
  return wallet;
}

// ─── Credit Points ────────────────────────────────────────────────────────────

/**
 * Atomically credit earned points to a user's wallet and record the transaction.
 */
export async function creditPoints(
  userId: string,
  amount: number,
  type: string,
  schemeId?: string,
  invoiceId?: string,
  description?: string
): Promise<void> {
  if (amount <= 0) throw new WalletError('Amount must be positive', 'INVALID_AMOUNT');

  await prisma.$transaction(async (tx) => {
    const wallet = await getOrCreateWallet(userId, tx);

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: { earnedPoints: { increment: amount } },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        userId,
        type,
        bucket: 'EARNED',
        amount,
        balanceAfter: updated.earnedPoints,
        schemeId: schemeId ?? null,
        invoiceId: invoiceId ?? null,
        description: description ?? null,
      },
    });
  });
}

// ─── Debit Points ─────────────────────────────────────────────────────────────

/**
 * Atomically debit redeemable points from a user's wallet. Throws if insufficient.
 */
export async function debitPoints(
  userId: string,
  amount: number,
  type: string,
  description?: string
): Promise<void> {
  if (amount <= 0) throw new WalletError('Amount must be positive', 'INVALID_AMOUNT');

  await prisma.$transaction(async (tx) => {
    const wallet = await getOrCreateWallet(userId, tx);

    if (wallet.redeemablePoints < amount) {
      throw new InsufficientPointsError(wallet.redeemablePoints, amount);
    }

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        redeemablePoints: { decrement: amount },
        redeemedPoints: { increment: amount },
      },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        userId,
        type,
        bucket: 'REDEEMABLE',
        amount: -amount,
        balanceAfter: updated.redeemablePoints,
        description: description ?? null,
      },
    });
  });
}

// ─── Lock Points ──────────────────────────────────────────────────────────────

/**
 * Move earned points into the locked bucket (pending holding period).
 */
export async function lockPoints(
  userId: string,
  amount: number,
  schemeId: string,
  unlockDate: Date
): Promise<void> {
  if (amount <= 0) throw new WalletError('Amount must be positive', 'INVALID_AMOUNT');

  await prisma.$transaction(async (tx) => {
    const wallet = await getOrCreateWallet(userId, tx);

    if (wallet.earnedPoints < amount) {
      throw new InsufficientPointsError(wallet.earnedPoints, amount);
    }

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: {
        earnedPoints: { decrement: amount },
        lockedPoints: { increment: amount },
      },
    });

    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        userId,
        type: 'LOCK',
        bucket: 'LOCKED',
        amount,
        balanceAfter: updated.lockedPoints,
        schemeId,
        description: `Locked until ${unlockDate.toISOString()}`,
      },
    });

    // Store unlock metadata on the transaction for the cron job to query
    await tx.lockedPoints.create({
      data: {
        walletId: wallet.id,
        userId,
        schemeId,
        amount,
        unlockDate,
        isUnlocked: false,
      },
    });
  });
}

// ─── Unlock Points (cron) ─────────────────────────────────────────────────────

/**
 * Cron-job logic: find all locked-point records past their unlock date and move
 * them to the redeemable bucket. Returns the number of records processed.
 */
export async function unlockPoints(): Promise<number> {
  const now = new Date();

  const due = await prisma.lockedPoints.findMany({
    where: { unlockDate: { lte: now }, isUnlocked: false },
  });

  let processed = 0;

  for (const record of due) {
    try {
      await prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.findUnique({ where: { id: record.walletId } });
        if (!wallet) return;

        const updated = await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            lockedPoints: { decrement: record.amount },
            redeemablePoints: { increment: record.amount },
          },
        });

        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            userId: record.userId,
            type: 'UNLOCK',
            bucket: 'REDEEMABLE',
            amount: record.amount,
            balanceAfter: updated.redeemablePoints,
            schemeId: record.schemeId,
            description: 'Holding period expired – points unlocked',
          },
        });

        await tx.lockedPoints.update({
          where: { id: record.id },
          data: { isUnlocked: true, unlockedAt: now },
        });
      });
      processed += 1;
    } catch (err) {
      console.error(`[wallet] Failed to unlock locked-points record ${record.id}:`, err);
    }
  }

  return processed;
}

// ─── Get Wallet Balance ───────────────────────────────────────────────────────

/**
 * Return the current balance breakdown for a user's wallet.
 */
export async function getWalletBalance(userId: string): Promise<WalletBalance> {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });

  if (!wallet) {
    return { earned: 0, locked: 0, redeemable: 0, redeemed: 0, expired: 0, available: 0 };
  }

  return {
    earned: wallet.earnedPoints,
    locked: wallet.lockedPoints,
    redeemable: wallet.redeemablePoints,
    redeemed: wallet.redeemedPoints,
    expired: wallet.expiredPoints,
    available: wallet.redeemablePoints, // alias: what can be spent right now
  };
}

// ─── Reverse Transaction ──────────────────────────────────────────────────────

/**
 * Clawback a previously credited transaction – reverses the points and records
 * a reversal transaction.
 */
export async function reverseTransaction(
  transactionId: string,
  reason: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const original = await tx.walletTransaction.findUnique({
      where: { id: transactionId },
    });

    if (!original) throw new WalletError('Transaction not found', 'NOT_FOUND');
    if (original.reversedById) throw new WalletError('Transaction already reversed', 'ALREADY_REVERSED');

    const wallet = await tx.wallet.findUnique({ where: { id: original.walletId } });
    if (!wallet) throw new WalletError('Wallet not found', 'WALLET_NOT_FOUND');

    // Determine which bucket to reverse and how
    const bucket = original.bucket as string;
    const reverseAmount = Math.abs(original.amount);
    let walletUpdate: Record<string, unknown> = {};

    if (bucket === 'EARNED') {
      if (wallet.earnedPoints < reverseAmount) {
        throw new InsufficientPointsError(wallet.earnedPoints, reverseAmount);
      }
      walletUpdate = { earnedPoints: { decrement: reverseAmount } };
    } else if (bucket === 'REDEEMABLE') {
      if (wallet.redeemablePoints < reverseAmount) {
        throw new InsufficientPointsError(wallet.redeemablePoints, reverseAmount);
      }
      walletUpdate = { redeemablePoints: { decrement: reverseAmount } };
    } else {
      throw new WalletError(`Cannot reverse a transaction in bucket: ${bucket}`, 'UNSUPPORTED_BUCKET');
    }

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: walletUpdate,
    });

    const reversal = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        userId: original.userId,
        type: 'REVERSE',
        bucket: original.bucket,
        amount: -reverseAmount,
        balanceAfter: bucket === 'EARNED' ? updated.earnedPoints : updated.redeemablePoints,
        schemeId: original.schemeId,
        invoiceId: original.invoiceId,
        description: `Reversal of ${transactionId}: ${reason}`,
        reversalReason: reason,
      },
    });

    await tx.walletTransaction.update({
      where: { id: transactionId },
      data: { reversedById: reversal.id },
    });
  });
}
