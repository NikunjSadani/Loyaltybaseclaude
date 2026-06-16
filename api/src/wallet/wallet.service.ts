import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WalletTransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { AdjustType, AdjustWalletDto, ListTransactionsQueryDto } from './dto/wallet.dto';

/**
 * Wallet & Points — ported from platform/src/app/api/wallet/* onto /v1.
 * Tenant-scoped by clientId (from the session-bound JWT). Admin adjustments are
 * GIFSY-only (enforced by @Roles on the controller; tenant scope re-checked here).
 * Business logic lives here; the controller is a thin HTTP adapter.
 */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  // 1 point = ₹1 by default; overridable via env (matches the source route).
  private readonly conversionRate = parseFloat(process.env.POINTS_CONVERSION_RATE ?? '1');

  /** GET /v1/wallet — the caller's own wallet summary (zeros if no partner/wallet). */
  async getWallet(user: JwtPayload) {
    const emptyWallet = {
      earnedPoints: 0,
      lockedPoints: 0,
      redeemablePoints: 0,
      redeemedPoints: 0,
      expiredPoints: 0,
      lifetimeEarned: 0,
      lifetimeRedeemed: 0,
      currency: 'POINTS',
      conversionRate: this.conversionRate,
    };

    const channelPartner = await this.prisma.channelPartner.findFirst({
      where: { userId: user.sub, user: { clientId: user.clientId } },
    });
    if (!channelPartner) return emptyWallet;

    const wallet = await this.prisma.wallet.findFirst({
      where: { partnerId: channelPartner.id },
    });
    if (!wallet) return emptyWallet;

    return {
      earnedPoints: wallet.earnedPoints,
      lockedPoints: wallet.lockedPoints,
      redeemablePoints: wallet.redeemablePoints,
      redeemedPoints: wallet.redeemedPoints,
      expiredPoints: wallet.expiredPoints,
      lifetimeEarned: wallet.lifetimeEarned,
      lifetimeRedeemed: wallet.lifetimeRedeemed,
      currency: 'POINTS',
      conversionRate: this.conversionRate,
    };
  }

  /** POST /v1/wallet/adjust — GIFSY-only manual credit/debit on a partner wallet. */
  async adjust(user: JwtPayload, dto: AdjustWalletDto) {
    // GIFSY-only is enforced by @Roles on the controller; tenant scope checked here.
    const wallet = await this.prisma.wallet.findFirst({
      where: { partnerId: dto.partnerId, partner: { user: { clientId: user.clientId } } },
    });
    if (!wallet) throw new NotFoundException('Wallet not found for this partner');

    if (dto.type === AdjustType.DEBIT && wallet.redeemablePoints < dto.amount) {
      throw new BadRequestException('Insufficient wallet balance for debit');
    }

    const isCredit = dto.type === AdjustType.CREDIT;
    const transactionType: WalletTransactionType = isCredit
      ? 'CREDIT_ADJUSTMENT'
      : 'DEBIT_ADJUSTMENT';
    const balanceBefore = wallet.redeemablePoints;

    const result = await this.prisma.$transaction(async (tx) => {
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          earnedPoints: isCredit ? { increment: dto.amount } : { decrement: dto.amount },
          redeemablePoints: isCredit ? { increment: dto.amount } : { decrement: dto.amount },
          lifetimeEarned: isCredit ? { increment: dto.amount } : undefined,
          lastTransactionAt: new Date(),
        },
      });

      const txRecord = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          transactionType,
          points: isCredit ? dto.amount : -dto.amount,
          balanceBefore,
          balanceAfter: updatedWallet.redeemablePoints,
          balanceType: 'REDEEMABLE',
          description: `Manual ${dto.type.toLowerCase()} by admin. Reason: ${dto.reason}`,
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'WALLET',
          entityId: wallet.id,
          actorId: user.sub,
          metadata: {
            partnerId: dto.partnerId,
            amount: dto.amount,
            type: dto.type,
            reason: dto.reason,
            approvedBy: dto.approvedBy,
            transactionId: txRecord.id,
          },
        },
      });

      return { updatedWallet, txRecord };
    });

    return {
      transactionId: result.txRecord.id,
      newBalance: result.updatedWallet.redeemablePoints,
    };
  }

  /** GET /v1/wallet/transactions — paginated passbook for the caller (or another user, GIFSY-only). */
  async listTransactions(user: JwtPayload, q: ListTransactionsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const emptyResult = {
      transactions: [],
      pagination: { page, limit, total: 0, pages: 0 },
    };

    // GIFSY admins may target another user's passbook via ?userId=; everyone else sees their own.
    const targetUserId =
      q.userId && user.role === 'GIFSY_ADMIN' ? q.userId : user.sub;

    const channelPartner = await this.prisma.channelPartner.findFirst({
      where: { userId: targetUserId, user: { clientId: user.clientId } },
    });
    if (!channelPartner) return emptyResult;

    const wallet = await this.prisma.wallet.findFirst({
      where: { partnerId: channelPartner.id },
    });
    if (!wallet) return emptyResult;

    const where: Prisma.WalletTransactionWhereInput = { walletId: wallet.id };
    if (q.type) where.transactionType = q.type;

    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    const passbook = transactions.map((t) => ({
      id: t.id,
      transactionType: t.transactionType,
      description: t.description ?? this.getDefaultDescription(t.transactionType),
      points: t.points,
      date: t.createdAt,
      balanceType: t.balanceType,
      balanceAfter: t.balanceAfter,
      referenceType: t.referenceType,
      referenceId: t.referenceId,
    }));

    return {
      transactions: passbook,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  private getDefaultDescription(transactionType: string): string {
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
}
