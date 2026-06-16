// Unit tests for WalletService — mirrors the S4 tickets template.
// Covers tenant scoping, the GIFSY-only adjust path + balance rules, and the
// passbook pagination ported from the Next routes.
// Run: npx jest src/wallet/wallet.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { AdjustType } from './dto/wallet.dto';

const mockTx = {
  wallet: { update: jest.fn() },
  walletTransaction: { create: jest.fn() },
  auditLog: { create: jest.fn() },
};

const mockPrisma = {
  channelPartner: { findFirst: jest.fn() },
  wallet: { findFirst: jest.fn() },
  walletTransaction: { findMany: jest.fn(), count: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [WalletService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(WalletService);
  });

  describe('getWallet', () => {
    it('returns a zeroed summary when the caller has no channel partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      const res = await service.getWallet(partner);
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user1', user: { clientId: 'deoleo' } },
      });
      expect(res.redeemablePoints).toBe(0);
      expect(res.currency).toBe('POINTS');
    });

    it('returns the wallet summary scoped to the caller', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({
        earnedPoints: 100,
        lockedPoints: 10,
        redeemablePoints: 90,
        redeemedPoints: 5,
        expiredPoints: 0,
        lifetimeEarned: 100,
        lifetimeRedeemed: 5,
      });
      const res = await service.getWallet(partner);
      expect(res.redeemablePoints).toBe(90);
      expect(res.lifetimeEarned).toBe(100);
    });
  });

  describe('adjust', () => {
    it('throws NotFound when the partner wallet is outside the tenant', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      await expect(
        service.adjust(gifsy, { partnerId: 'cp1', amount: 10, type: AdjustType.CREDIT, reason: 'x', approvedBy: 'a' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({
        where: { partnerId: 'cp1', partner: { user: { clientId: 'deoleo' } } },
      });
    });

    it('rejects a DEBIT that exceeds the redeemable balance', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5 });
      await expect(
        service.adjust(gifsy, { partnerId: 'cp1', amount: 10, type: AdjustType.DEBIT, reason: 'x', approvedBy: 'a' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('credits the wallet, records a transaction, and writes an audit log', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 50 });
      mockTx.wallet.update.mockResolvedValue({ id: 'w1', redeemablePoints: 60 });
      mockTx.walletTransaction.create.mockResolvedValue({ id: 'tx1' });
      const res = await service.adjust(gifsy, {
        partnerId: 'cp1',
        amount: 10,
        type: AdjustType.CREDIT,
        reason: 'bonus',
        approvedBy: 'a',
      });
      expect(res).toEqual({ transactionId: 'tx1', newBalance: 60 });
      expect(mockTx.wallet.update).toHaveBeenCalledWith({
        where: { id: 'w1' },
        data: {
          earnedPoints: { increment: 10 },
          redeemablePoints: { increment: 10 },
          lifetimeEarned: { increment: 10 },
          lastTransactionAt: expect.any(Date),
        },
      });
      expect(mockTx.walletTransaction.create).toHaveBeenCalled();
      expect(mockTx.auditLog.create).toHaveBeenCalled();
    });
  });

  describe('listTransactions', () => {
    it('targets the caller’s own partner by default', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      const res = await service.listTransactions(partner, { userId: 'someoneElse' });
      // Non-admins cannot inspect another user — userId is ignored.
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user1', user: { clientId: 'deoleo' } },
      });
      expect(res).toEqual({ transactions: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } });
    });

    it('lets a GIFSY admin target another user via userId', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      await service.listTransactions(gifsy, { userId: 'user1' });
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user1', user: { clientId: 'deoleo' } },
      });
    });

    it('returns a paginated passbook with default descriptions', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1' });
      mockPrisma.walletTransaction.findMany.mockResolvedValue([
        {
          id: 't1',
          transactionType: 'CREDIT_POINTS_EARNED',
          description: null,
          points: 10,
          createdAt: new Date('2026-01-01'),
          balanceType: 'REDEEMABLE',
          balanceAfter: 10,
          referenceType: null,
          referenceId: null,
        },
      ]);
      mockPrisma.walletTransaction.count.mockResolvedValue(1);
      const res = await service.listTransactions(partner, {});
      expect(res.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
      expect(res.transactions[0].description).toBe('Points earned');
    });
  });
});
