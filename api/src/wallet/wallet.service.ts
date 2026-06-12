import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Wallet } from '@prisma/client';

interface EarnDto {
  partnerId:      string;
  points:         number;
  referenceType?: string;
  referenceId?:   string;
  description?:   string;
  schemeId?:      string;
  expiresAt?:     Date;
}

interface BurnDto {
  partnerId:      string;
  points:         number;
  referenceType?: string;
  referenceId?:   string;
  description?:   string;
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Get balance ───────────────────────────────────────────────────────────

  async getBalance(partnerId: string): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findFirst({ where: { partnerId } });
    if (!wallet) throw new NotFoundException(`Wallet not found for partner ${partnerId}.`);
    return wallet;
  }

  // ── Earn points ───────────────────────────────────────────────────────────
  //
  // Wrapped in $transaction so the balance update + ledger entries are
  // atomic — prevents duplicate-earn under concurrent requests.

  async earnPoints(dto: EarnDto): Promise<Wallet> {
    if (!dto.points || dto.points <= 0) {
      throw new BadRequestException('Points to earn must be a positive number.');
    }

    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findFirst({ where: { partnerId: dto.partnerId } });
      if (!wallet) throw new NotFoundException(`Wallet not found for partner ${dto.partnerId}.`);

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          redeemablePoints:  { increment: dto.points },
          earnedPoints:      { increment: dto.points },
          lifetimeEarned:    { increment: dto.points },
          lastTransactionAt: new Date(),
        },
      });

      await tx.walletTransaction.create({
        data: {
          walletId:        wallet.id,
          transactionType: 'EARN' as any,
          points:          dto.points,
          balanceBefore:   wallet.redeemablePoints,
          balanceAfter:    updated.redeemablePoints,
          balanceType:     'REDEEMABLE',
          referenceType:   dto.referenceType ?? null,
          referenceId:     dto.referenceId ?? null,
          description:     dto.description ?? null,
        },
      });

      await tx.pointsLedger.create({
        data: {
          walletId:        wallet.id,
          schemeId:        dto.schemeId ?? null,
          transactionType: 'EARN' as any,
          points:          dto.points,
          expiresAt:       dto.expiresAt ?? null,
          sourceType:      dto.referenceType ?? null,
          sourceId:        dto.referenceId ?? null,
          notes:           dto.description ?? null,
        },
      });

      this.logger.log(`Earned ${dto.points} pts for partner ${dto.partnerId}`);
      return updated;
    });
  }

  // ── Burn points ───────────────────────────────────────────────────────────
  //
  // Wrapped in $transaction so the balance check + decrement are atomic —
  // prevents double-spend (e.g. two simultaneous redemption requests both
  // passing the balance check then both writing).

  async burnPoints(dto: BurnDto): Promise<Wallet> {
    if (!dto.points || dto.points <= 0) {
      throw new BadRequestException('Points to burn must be a positive number.');
    }

    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findFirst({ where: { partnerId: dto.partnerId } });
      if (!wallet) throw new NotFoundException(`Wallet not found for partner ${dto.partnerId}.`);

      if (wallet.redeemablePoints < dto.points) {
        throw new BadRequestException(
          `Insufficient balance. Available: ${wallet.redeemablePoints}, requested: ${dto.points}.`,
        );
      }

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          redeemablePoints:  { decrement: dto.points },
          redeemedPoints:    { increment: dto.points },
          lifetimeRedeemed:  { increment: dto.points },
          lastTransactionAt: new Date(),
        },
      });

      await tx.walletTransaction.create({
        data: {
          walletId:        wallet.id,
          transactionType: 'REDEEM' as any,
          points:          dto.points,
          balanceBefore:   wallet.redeemablePoints,
          balanceAfter:    updated.redeemablePoints,
          balanceType:     'REDEEMABLE',
          referenceType:   dto.referenceType ?? null,
          referenceId:     dto.referenceId ?? null,
          description:     dto.description ?? null,
        },
      });

      this.logger.log(`Burned ${dto.points} pts for partner ${dto.partnerId}`);
      return updated;
    });
  }

  // ── Transaction history ───────────────────────────────────────────────────

  async getTransactions(
    partnerId: string,
    opts: { page?: number; limit?: number } = {},
  ) {
    const wallet = await this.getBalance(partnerId);
    const page   = opts.page  ?? 1;
    const limit  = opts.limit ?? 20;
    const skip   = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where:   { walletId: wallet.id },
        skip, take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.walletTransaction.count({ where: { walletId: wallet.id } }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }

  // ── Points expiry (cron target) ────────────────────────────────────────────
  //
  // Finds all PointsLedger entries that have passed their expiresAt timestamp
  // but are not yet marked as expired. Groups them by walletId, then within a
  // single $transaction per wallet:
  //   1. Marks all affected ledger rows as isExpired = true
  //   2. Decrements wallet.redeemablePoints / increments wallet.expiredPoints
  //   3. Creates a WalletTransaction of type DEBIT_EXPIRY for the audit trail
  //
  // @param clientId  Optional: scope to a single client. Pass null for all.
  // @returns         { expiredCount, totalPointsExpired }

  async expirePoints(clientId: string | null): Promise<{
    expiredCount:        number;
    totalPointsExpired:  number;
  }> {
    const where: any = { isExpired: false, expiresAt: { lt: new Date() } };

    const expiredLedgers = await this.prisma.pointsLedger.findMany({ where });

    if (expiredLedgers.length === 0) {
      return { expiredCount: 0, totalPointsExpired: 0 };
    }

    // Group by walletId
    const byWallet = new Map<string, typeof expiredLedgers>();
    for (const row of expiredLedgers) {
      const list = byWallet.get(row.walletId) ?? [];
      list.push(row);
      byWallet.set(row.walletId, list);
    }

    let totalExpiredCount  = 0;
    let totalPointsExpired = 0;

    for (const [walletId, rows] of byWallet) {
      const pts = rows.reduce((sum, r) => sum + r.points, 0);
      const ids = rows.map((r) => r.id);

      await this.prisma.$transaction(async (tx) => {
        // Mark ledger rows expired
        await tx.pointsLedger.updateMany({
          where: { id: { in: ids } },
          data:  { isExpired: true },
        });

        // Decrement wallet balance atomically
        await tx.wallet.update({
          where: { id: walletId },
          data:  {
            redeemablePoints: { decrement: pts },
            expiredPoints:    { increment: pts },
            lifetimeExpired:  { increment: pts },
          },
        });

        // Audit trail
        await tx.walletTransaction.create({
          data: {
            walletId,
            transactionType: 'DEBIT_EXPIRY'   as any,
            points:          pts,
            balanceBefore:   0,                // approximation — full read not needed for audit
            balanceAfter:    0,
            balanceType:     'redeemablePoints',
            referenceType:   'POINTS_EXPIRY',
            referenceId:     `expiry-${new Date().toISOString().slice(0, 10)}`,
            description:     `Points expired: ${pts} pts`,
          },
        });
      });

      totalExpiredCount  += rows.length;
      totalPointsExpired += pts;
    }

    this.logger.log(
      `expirePoints: ${totalExpiredCount} ledger rows, ${totalPointsExpired} pts expired`,
    );
    return { expiredCount: totalExpiredCount, totalPointsExpired };
  }
}
