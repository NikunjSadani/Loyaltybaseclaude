// TDD: WalletService
// Covers: earn points, burn points, balance retrieval, insufficient balance guard

import { Test, TestingModule } from '@nestjs/testing';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

const mockPrisma = {
  // $transaction executes the callback, passing itself as the tx object.
  // This lets all inner mockPrisma.wallet.* etc. calls still work after the
  // service wraps earn/burn in a transaction.
  $transaction: jest.fn().mockImplementation((fn: (tx: any) => Promise<any>) => fn(mockPrisma)),
  wallet:            { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  walletTransaction: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  pointsLedger:      { create: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
};

const wallet = {
  id: 'wallet_1', partnerId: 'cp_1',
  redeemablePoints: 500, lockedPoints: 0,
  earnedPoints: 500, redeemedPoints: 0,
  lifetimeEarned: 500, lifetimeRedeemed: 0,
};

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<WalletService>(WalletService);
    jest.clearAllMocks();
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ── Get balance ───────────────────────────────────────────────────────────

  describe('getBalance', () => {
    it('should return wallet for a known partner', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(wallet);
      const result = await service.getBalance('cp_1');
      expect(result.redeemablePoints).toBe(500);
    });

    it('should throw NotFoundException for unknown partner', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      await expect(service.getBalance('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  // ── Earn points ───────────────────────────────────────────────────────────

  describe('earnPoints', () => {
    it('should increase redeemablePoints and lifetimeEarned', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet });
      mockPrisma.wallet.update.mockResolvedValue({
        ...wallet, redeemablePoints: 600, earnedPoints: 600, lifetimeEarned: 600,
      });
      mockPrisma.walletTransaction.create.mockResolvedValue({});
      mockPrisma.pointsLedger.create.mockResolvedValue({});

      const result = await service.earnPoints({
        partnerId:     'cp_1',
        points:        100,
        referenceType: 'INVOICE',
        referenceId:   'inv_1',
        description:   'Sales invoice Jul 2026',
      });

      expect(result.redeemablePoints).toBe(600);
      // Must use atomic increment — never a computed absolute value
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            redeemablePoints: { increment: 100 },
            earnedPoints:     { increment: 100 },
            lifetimeEarned:   { increment: 100 },
          }),
        }),
      );
    });

    it('should reject earning 0 or negative points', async () => {
      await expect(service.earnPoints({ partnerId: 'cp_1', points: 0 }))
        .rejects.toThrow(BadRequestException);
      await expect(service.earnPoints({ partnerId: 'cp_1', points: -10 }))
        .rejects.toThrow(BadRequestException);
    });
  });

  // ── Burn points ───────────────────────────────────────────────────────────

  describe('burnPoints', () => {
    it('should decrease redeemablePoints and increase redeemedPoints atomically', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet });
      mockPrisma.wallet.update.mockResolvedValue({
        ...wallet, redeemablePoints: 300, redeemedPoints: 200, lifetimeRedeemed: 200,
      });
      mockPrisma.walletTransaction.create.mockResolvedValue({});

      const result = await service.burnPoints({
        partnerId:     'cp_1',
        points:        200,
        referenceType: 'PAYOUT',
        referenceId:   'payout_1',
        description:   'Payout request',
      });

      expect(result.redeemablePoints).toBe(300);
      expect(result.redeemedPoints).toBe(200);
      // Must use atomic decrement/increment — never computed absolute values
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            redeemablePoints: { decrement: 200 },
            redeemedPoints:   { increment: 200 },
            lifetimeRedeemed: { increment: 200 },
          }),
        }),
      );
    });

    it('should throw BadRequestException if insufficient balance', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet, redeemablePoints: 100 });
      await expect(
        service.burnPoints({ partnerId: 'cp_1', points: 500 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for 0 or negative burn', async () => {
      await expect(service.burnPoints({ partnerId: 'cp_1', points: 0 }))
        .rejects.toThrow(BadRequestException);
    });
  });

  // ── Transaction safety ───────────────────────────────────────────────────
  //
  // W1 / W2: Earn and burn must run inside prisma.$transaction so that the
  // balance check + update are atomic — preventing double-spend under
  // concurrent requests.
  //
  // RED: currently the service calls wallet.update / walletTransaction.create
  //      directly (no $transaction wrapper), so these tests will FAIL until
  //      the implementation is fixed.

  describe('transaction safety', () => {
    it('W1: earnPoints wraps all DB writes in prisma.$transaction', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet });
      mockPrisma.wallet.update.mockResolvedValue({ ...wallet, redeemablePoints: 600 });
      mockPrisma.walletTransaction.create.mockResolvedValue({});
      mockPrisma.pointsLedger.create.mockResolvedValue({});

      await service.earnPoints({ partnerId: 'cp_1', points: 100 });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('W2: burnPoints wraps all DB writes in prisma.$transaction', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet });
      mockPrisma.wallet.update.mockResolvedValue({ ...wallet, redeemablePoints: 300 });
      mockPrisma.walletTransaction.create.mockResolvedValue({});

      await service.burnPoints({ partnerId: 'cp_1', points: 200 });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── Transaction history ───────────────────────────────────────────────────

  describe('getTransactions', () => {
    it('should return paginated transaction list', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(wallet);
      mockPrisma.walletTransaction.findMany.mockResolvedValue([{ id: 'tx_1', points: 100 }]);
      mockPrisma.walletTransaction.count.mockResolvedValue(1);

      const result = await service.getTransactions('cp_1', { page: 1, limit: 10 });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  // ── Points expiry ─────────────────────────────────────────────────────────
  //
  // PE1: expirePoints must mark PointsLedger entries as isExpired = true
  //      AND decrement redeemablePoints on the wallet inside a $transaction.
  //
  // RED: WalletService has no expirePoints() method yet — these tests fail
  //      until the method is added.

  describe('expirePoints', () => {
    it('PE1: marks expired ledger entries and decrements wallet balance atomically', async () => {
      const expiredLedgers = [
        { id: 'led_1', walletId: 'wallet_1', points: 100, isExpired: false },
        { id: 'led_2', walletId: 'wallet_1', points:  50, isExpired: false },
      ];

      mockPrisma.pointsLedger.findMany.mockResolvedValue(expiredLedgers);
      mockPrisma.pointsLedger.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.wallet.update.mockResolvedValue({
        ...wallet, redeemablePoints: 350, expiredPoints: 150,
      });
      mockPrisma.walletTransaction.create.mockResolvedValue({});

      // Pass a clientId scope (null = all clients)
      const result = await service.expirePoints(null);

      expect(result.expiredCount).toBe(2);
      expect(result.totalPointsExpired).toBe(150);

      // Must use $transaction
      expect(mockPrisma.$transaction).toHaveBeenCalled();

      // Ledger entries marked expired
      expect(mockPrisma.pointsLedger.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isExpired: true }),
        }),
      );

      // Wallet decremented atomically (one update per affected wallet)
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            redeemablePoints: { decrement: 150 },
            expiredPoints:    { increment: 150 },
            lifetimeExpired:  { increment: 150 },
          }),
        }),
      );
    });

    it('PE1b: returns 0 counts when no ledger entries have expired', async () => {
      mockPrisma.pointsLedger.findMany.mockResolvedValue([]);

      const result = await service.expirePoints(null);

      expect(result.expiredCount).toBe(0);
      expect(result.totalPointsExpired).toBe(0);
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    });
  });
});
