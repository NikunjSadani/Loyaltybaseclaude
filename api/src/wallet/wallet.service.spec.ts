// Unit tests for WalletService — mirrors the S4 tickets template.
// Covers tenant scoping, the GIFSY-only adjust path + balance rules, the passbook
// pagination ported from the Next routes, and the P5 ledger-aware primitives
// (creditEarn / debitRedeem / reverse / expireDuePoints) + the canonical invariant.
// Run: npx jest src/wallet/wallet.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { AdjustType } from './dto/wallet.dto';

// The transaction client mock — every mutation composes through this inside $transaction.
const mockTx = {
  wallet: { findFirst: jest.fn(), update: jest.fn() },
  walletTransaction: { create: jest.fn() },
  pointsLedger: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  pointExpiryConfig: { findFirst: jest.fn() },
  auditLog: { create: jest.fn() },
};

const mockPrisma = {
  channelPartner: { findFirst: jest.fn() },
  wallet: { findFirst: jest.fn() },
  walletTransaction: { findMany: jest.fn(), count: jest.fn() },
  pointsLedger: { findMany: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(async () => {
    // resetAllMocks (NOT clearAllMocks) so queued mockResolvedValueOnce values are drained.
    jest.resetAllMocks();
    // $transaction default: run the callback against mockTx.
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx));
    // Expiry sweep claims each lot via a guarded updateMany; default = claim succeeds.
    mockTx.pointsLedger.updateMany.mockResolvedValue({ count: 1 });
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
      expect(res.lifetimeExpired).toBe(0);
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
        lifetimeExpired: 0,
      });
      const res = await service.getWallet(partner);
      expect(res.redeemablePoints).toBe(90);
      expect(res.lifetimeEarned).toBe(100);
    });
  });

  describe('creditEarn', () => {
    it('writes BOTH a WalletTransaction and a PointsLedger row, stamping expiresAt from config', async () => {
      mockTx.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 0 });
      mockTx.pointExpiryConfig.findFirst.mockResolvedValue({ expiryDays: 90 });
      mockTx.wallet.update.mockResolvedValue({ id: 'w1', redeemablePoints: 25 });
      mockTx.walletTransaction.create.mockResolvedValue({ id: 'tx1' });
      mockTx.pointsLedger.create.mockResolvedValue({ id: 'pl1' });

      const res = await service.creditEarn('cp1', 'deoleo', 25, { schemeId: 's1' });

      expect(res).toEqual({ transactionId: 'tx1', newRedeemable: 25, ledgerId: 'pl1' });
      // Credit bumps redeemable + earned + lifetimeEarned (monotonic accumulators).
      expect(mockTx.wallet.update).toHaveBeenCalledWith({
        where: { id: 'w1' },
        data: {
          lastTransactionAt: expect.any(Date),
          redeemablePoints: { increment: 25 },
          earnedPoints: { increment: 25 },
          lifetimeEarned: { increment: 25 },
        },
      });
      expect(mockTx.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ transactionType: 'CREDIT_POINTS_EARNED', points: 25 }),
        }),
      );
      // Ledger EARN row carries the resolved expiresAt.
      const ledgerArg = mockTx.pointsLedger.create.mock.calls[0][0].data;
      expect(ledgerArg.transactionType).toBe('EARN');
      expect(ledgerArg.points).toBe(25);
      expect(ledgerArg.schemeId).toBe('s1');
      expect(ledgerArg.expiresAt).toBeInstanceOf(Date);
    });

    it('stamps a null expiresAt when no expiry config matches the tenant', async () => {
      mockTx.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 0 });
      mockTx.pointExpiryConfig.findFirst.mockResolvedValue(null); // no scheme + no default config
      mockTx.wallet.update.mockResolvedValue({ id: 'w1', redeemablePoints: 10 });
      mockTx.walletTransaction.create.mockResolvedValue({ id: 'tx1' });
      mockTx.pointsLedger.create.mockResolvedValue({ id: 'pl1' });

      await service.creditEarn('cp1', 'deoleo', 10, {});

      expect(mockTx.pointsLedger.create.mock.calls[0][0].data.expiresAt).toBeNull();
    });

    it('throws NotFound when the partner has no wallet', async () => {
      mockTx.wallet.findFirst.mockResolvedValue(null);
      await expect(service.creditEarn('cpX', 'deoleo', 10, {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('debitRedeem', () => {
    it('throws BadRequest when redeemable is insufficient and writes nothing', async () => {
      mockTx.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5 });
      await expect(
        service.debitRedeem('cp1', 10, { referenceId: 'order1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockTx.wallet.update).not.toHaveBeenCalled();
      expect(mockTx.pointsLedger.create).not.toHaveBeenCalled();
    });

    it('debits redeemable and writes a REDEEM ledger row', async () => {
      mockTx.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 50 });
      mockTx.wallet.update.mockResolvedValue({ id: 'w1', redeemablePoints: 40 });
      mockTx.walletTransaction.create.mockResolvedValue({ id: 'tx1' });
      mockTx.pointsLedger.create.mockResolvedValue({ id: 'pl1' });

      const res = await service.debitRedeem('cp1', 10, { referenceId: 'order1' });

      expect(res.newRedeemable).toBe(40);
      // Debit decrements redeemable + bumps redeemed/lifetimeRedeemed; NEVER earned.
      expect(mockTx.wallet.update).toHaveBeenCalledWith({
        where: { id: 'w1' },
        data: {
          lastTransactionAt: expect.any(Date),
          redeemablePoints: { decrement: 10 },
          redeemedPoints: { increment: 10 },
          lifetimeRedeemed: { increment: 10 },
        },
      });
      expect(mockTx.pointsLedger.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ transactionType: 'REDEEM', points: -10 }),
      );
    });
  });

  describe('reverse', () => {
    it('re-credits redeemable WITHOUT bumping lifetimeEarned (a reversal is not new earning)', async () => {
      mockTx.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 20 });
      mockTx.wallet.update.mockResolvedValue({ id: 'w1', redeemablePoints: 30 });
      mockTx.walletTransaction.create.mockResolvedValue({ id: 'tx1' });
      mockTx.pointsLedger.create.mockResolvedValue({ id: 'pl1' });

      await service.reverse('cp1', 10, { referenceId: 'order1' });

      const data = mockTx.wallet.update.mock.calls[0][0].data;
      expect(data.redeemablePoints).toEqual({ increment: 10 });
      expect(data.earnedPoints).toBeUndefined();
      expect(data.lifetimeEarned).toBeUndefined();
      expect(mockTx.pointsLedger.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ transactionType: 'REVERSE', points: 10 }),
      );
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

    it('credits the wallet, writes a WalletTransaction + PointsLedger (ADJUST), and an audit log', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 50 });
      mockTx.wallet.update.mockResolvedValue({ id: 'w1', redeemablePoints: 60 });
      mockTx.walletTransaction.create.mockResolvedValue({ id: 'tx1' });
      mockTx.pointsLedger.create.mockResolvedValue({ id: 'pl1' });

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
          lastTransactionAt: expect.any(Date),
          redeemablePoints: { increment: 10 },
          earnedPoints: { increment: 10 },
          lifetimeEarned: { increment: 10 },
        },
      });
      expect(mockTx.pointsLedger.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ transactionType: 'ADJUST', points: 10 }),
      );
      expect(mockTx.auditLog.create).toHaveBeenCalled();
    });

    // Regression test for bug #1: a DEBIT adjust must NOT decrement earnedPoints/lifetimeEarned.
    it('on DEBIT decrements redeemable ONLY (earned/lifetimeEarned untouched) and writes the ADJUST ledger', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 50 });
      mockTx.wallet.update.mockResolvedValue({ id: 'w1', redeemablePoints: 40 });
      mockTx.walletTransaction.create.mockResolvedValue({ id: 'tx2' });
      mockTx.pointsLedger.create.mockResolvedValue({ id: 'pl2' });

      await service.adjust(gifsy, {
        partnerId: 'cp1',
        amount: 10,
        type: AdjustType.DEBIT,
        reason: 'clawback',
        approvedBy: 'a',
      });

      const data = mockTx.wallet.update.mock.calls[0][0].data;
      expect(data.redeemablePoints).toEqual({ decrement: 10 });
      expect(data.earnedPoints).toBeUndefined();
      expect(data.lifetimeEarned).toBeUndefined();
      expect(mockTx.pointsLedger.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ transactionType: 'ADJUST', points: -10 }),
      );
    });
  });

  describe('expireDuePoints', () => {
    it('is a no-op when no lots are due', async () => {
      mockPrisma.pointsLedger.findMany.mockResolvedValue([]);
      const res = await service.expireDuePoints();
      expect(res).toEqual({ expiredLots: 0, expiredPoints: 0 });
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('expires a due EARN lot: decrements redeemable, bumps expired+lifetimeExpired, marks isExpired', async () => {
      mockPrisma.pointsLedger.findMany.mockResolvedValue([
        { id: 'lot1', walletId: 'w1', schemeId: null, points: 30 },
      ]);
      mockTx.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 50 });
      mockTx.wallet.update.mockResolvedValue({ id: 'w1', redeemablePoints: 20 });
      mockTx.walletTransaction.create.mockResolvedValue({ id: 'tx1' });
      mockTx.pointsLedger.create.mockResolvedValue({ id: 'pl1' });

      const res = await service.expireDuePoints();

      expect(res).toEqual({ expiredLots: 1, expiredPoints: 30 });
      // Source lot claimed with a guarded updateMany (concurrency-safe idempotency).
      expect(mockTx.pointsLedger.updateMany).toHaveBeenCalledWith({
        where: { id: 'lot1', isExpired: false },
        data: { isExpired: true },
      });
      // Aggregates: redeemable down 30, expired + lifetimeExpired up 30.
      expect(mockTx.wallet.update).toHaveBeenCalledWith({
        where: { id: 'w1' },
        data: {
          lastTransactionAt: expect.any(Date),
          redeemablePoints: { decrement: 30 },
          expiredPoints: { increment: 30 },
          lifetimeExpired: { increment: 30 },
        },
      });
      expect(mockTx.pointsLedger.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ transactionType: 'EXPIRE', points: -30 }),
      );
    });

    it('floors the redeemable decrement at the available balance (over-expiry cannot go negative)', async () => {
      // Lot granted 30 but only 10 remain spendable (rest already redeemed).
      mockPrisma.pointsLedger.findMany.mockResolvedValue([
        { id: 'lot1', walletId: 'w1', schemeId: null, points: 30 },
      ]);
      mockTx.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 10 });
      mockTx.pointsLedger.update.mockResolvedValue({ id: 'lot1' });
      mockTx.wallet.update.mockResolvedValue({ id: 'w1', redeemablePoints: 0 });
      mockTx.walletTransaction.create.mockResolvedValue({ id: 'tx1' });
      mockTx.pointsLedger.create.mockResolvedValue({ id: 'pl1' });

      const res = await service.expireDuePoints();

      expect(res).toEqual({ expiredLots: 1, expiredPoints: 10 });
      expect(mockTx.wallet.update).toHaveBeenCalledWith({
        where: { id: 'w1' },
        data: {
          lastTransactionAt: expect.any(Date),
          redeemablePoints: { decrement: 10 },
          expiredPoints: { increment: 10 },
          lifetimeExpired: { increment: 10 },
        },
      });
    });

    it('skips a lot a concurrent sweep already claimed (guarded updateMany count 0 → no balance move)', async () => {
      mockPrisma.pointsLedger.findMany.mockResolvedValue([
        { id: 'lot1', walletId: 'w1', schemeId: null, points: 30 },
      ]);
      // A concurrent run flipped isExpired first → our guarded claim matches 0 rows.
      mockTx.pointsLedger.updateMany.mockResolvedValue({ count: 0 });

      const res = await service.expireDuePoints();

      expect(res).toEqual({ expiredLots: 0, expiredPoints: 0 });
      // No wallet read, no balance mutation, no movement rows once the claim is lost.
      expect(mockTx.wallet.findFirst).not.toHaveBeenCalled();
      expect(mockTx.wallet.update).not.toHaveBeenCalled();
      expect(mockTx.walletTransaction.create).not.toHaveBeenCalled();
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
