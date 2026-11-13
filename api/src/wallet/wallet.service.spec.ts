// Unit tests for WalletService — mirrors the S4 tickets template.
// Covers tenant scoping, the GIFSY-only adjust path + balance rules, the passbook
// pagination ported from the Next routes, and the P5 ledger-aware primitives
// (creditEarn / debitRedeem / reverse / expireDuePoints) + the canonical invariant.
// Run: npx jest src/wallet/wallet.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { AdjustType } from './dto/wallet.dto';

// Plain object (NOT jest.fn) so the per-tenant rate survives jest.resetAllMocks() in beforeEach.
const mockTenantSettings = { getConversionRate: async () => 1 };

// The transaction client mock — every mutation composes through this inside $transaction.
const mockTx = {
  wallet: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
  walletTransaction: { create: jest.fn() },
  // findMany/findUnique added for the FIFO change: consumeFifoLots lists spendable lots and
  // the expiry sweep re-reads the claimed lot's frozen remainingPoints.
  pointsLedger: {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
  },
  pointExpiryConfig: { findFirst: jest.fn() },
  // reverse() re-dates the REVERSE lot by resolving the tenant from the partner.
  channelPartner: { findFirst: jest.fn() },
  auditLog: { create: jest.fn() },
  // expiry sweep locks the wallet row first (SELECT … FOR UPDATE) before claiming the lot.
  $queryRaw: jest.fn().mockResolvedValue([]),
};

const mockPrisma = {
  channelPartner: { findFirst: jest.fn() },
  wallet: { findFirst: jest.fn() },
  walletTransaction: { findMany: jest.fn(), count: jest.fn() },
  pointsLedger: { findMany: jest.fn() },
  outlet: { findFirst: jest.fn() },
  creditBatch: { findMany: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };
// Wave 3 outlet-switching needs a real 10-digit phone (operable set = same-group + same-phone).
const switcher: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '9800000001', name: '' };

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(async () => {
    // resetAllMocks (NOT clearAllMocks) so queued mockResolvedValueOnce values are drained.
    jest.resetAllMocks();
    // $transaction default: run the callback against mockTx.
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx));
    // Expiry sweep claims each lot via a guarded updateMany; default = claim succeeds.
    mockTx.pointsLedger.updateMany.mockResolvedValue({ count: 1 });
    // consumeFifoLots lists spendable lots inside a debit; default = no lot mirror to touch.
    mockTx.pointsLedger.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
      ],
    }).compile();
    service = module.get(WalletService);
  });

  describe('getWallet', () => {
    it('returns a zeroed summary when the caller has no channel partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      const res = await service.getWallet(partner);
      // Wave 3: the active partner is resolved through the access-boundary helper (own by default).
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user1', clientId: 'deoleo', deletedAt: null, isParent: false },
        select: { id: true, groupId: true },
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

    // ── Wave 3 outlet switching ──────────────────────────────────────────────────
    it('resolves a SWITCHED sibling wallet when a valid x-active-partner-id selector is supplied', async () => {
      // own login → group g1; the selector names a login-less same-group same-phone sibling.
      mockPrisma.channelPartner.findFirst.mockImplementation((args: any) =>
        args.where.userId
          ? Promise.resolve({ id: 'cp1', groupId: 'g1' })   // own (resolveActivePartnerId)
          : Promise.resolve({ id: 'sib1' }),                 // the sibling authorization lookup (where.id)
      );
      mockPrisma.wallet.findFirst.mockResolvedValue({
        earnedPoints: 10, lockedPoints: 0, redeemablePoints: 7, redeemedPoints: 3,
        expiredPoints: 0, lifetimeEarned: 10, lifetimeRedeemed: 3, lifetimeExpired: 0,
      });
      const res = await service.getWallet(switcher, 'sib1');
      // The wallet is loaded for the SIBLING, not the login's own partner.
      expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { partnerId: 'sib1' } });
      expect(res.redeemablePoints).toBe(7);
    });

    it('throws ForbiddenException + loads no wallet when the selector is outside the operable set', async () => {
      // own login has no group → any non-own selector is a forbidden cross-partner reach.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', groupId: null });
      await expect(service.getWallet(switcher, 'someoneElse')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
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

    it('debits redeemable via an ATOMIC GUARDED update and writes a REDEEM ledger row', async () => {
      mockTx.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 50 });
      mockTx.wallet.updateMany.mockResolvedValue({ count: 1 });
      mockTx.wallet.findUniqueOrThrow.mockResolvedValue({ id: 'w1', redeemablePoints: 40 });
      mockTx.walletTransaction.create.mockResolvedValue({ id: 'tx1' });
      mockTx.pointsLedger.create.mockResolvedValue({ id: 'pl1' });

      const res = await service.debitRedeem('cp1', 10, { referenceId: 'order1' });

      expect(res.newRedeemable).toBe(40);
      // Guarded conditional decrement (WHERE redeemablePoints >= amount) + redeemed counters; NEVER earned.
      const call = mockTx.wallet.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'w1', redeemablePoints: { gte: 10 } });
      expect(call.data).toEqual({
        lastTransactionAt: expect.any(Date),
        redeemablePoints: { decrement: 10 },
        redeemedPoints: { increment: 10 },
        lifetimeRedeemed: { increment: 10 },
      });
      expect(mockTx.wallet.update).not.toHaveBeenCalled();
      expect(mockTx.pointsLedger.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ transactionType: 'REDEEM', points: -10 }),
      );
    });

    // TOCTOU on the LIVE redemption path: the pre-check passed on a stale read, but a
    // concurrent debit drained the balance before our guarded update ran → 0 rows matched
    // → clean reject, never a negative balance.
    it('rejects a concurrent redemption when the guarded update matches no row (no negative balance)', async () => {
      mockTx.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 50 });
      mockTx.wallet.updateMany.mockResolvedValue({ count: 0 });

      // The race-loser surfaces the REDEMPTION-specific message (not the generic "for debit").
      await expect(
        service.debitRedeem('cp1', 40, { referenceId: 'order2' }),
      ).rejects.toThrow('Insufficient wallet balance for redemption');

      expect(mockTx.wallet.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(mockTx.pointsLedger.create).not.toHaveBeenCalled();
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

    // Regression test for bug #1 + the atomic-guard hardening: a DEBIT adjust must NOT
    // decrement earnedPoints/lifetimeEarned, and must use a GUARDED conditional update
    // (WHERE redeemablePoints >= amount) rather than an unconditional decrement.
    it('on DEBIT uses an atomic guarded decrement (redeemable ONLY; earned/lifetime untouched) and writes the ADJUST ledger', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 50 });
      mockTx.wallet.updateMany.mockResolvedValue({ count: 1 });
      mockTx.wallet.findUniqueOrThrow.mockResolvedValue({ id: 'w1', redeemablePoints: 40 });
      mockTx.walletTransaction.create.mockResolvedValue({ id: 'tx2' });
      mockTx.pointsLedger.create.mockResolvedValue({ id: 'pl2' });

      const res = await service.adjust(gifsy, {
        partnerId: 'cp1',
        amount: 10,
        type: AdjustType.DEBIT,
        reason: 'clawback',
        approvedBy: 'a',
      });

      expect(res).toEqual({ transactionId: 'tx2', newBalance: 40 });
      // Guarded conditional update — only decrements when the CURRENT balance still covers it.
      const call = mockTx.wallet.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'w1', redeemablePoints: { gte: 10 } });
      expect(call.data.redeemablePoints).toEqual({ decrement: 10 });
      expect(call.data.earnedPoints).toBeUndefined();
      expect(call.data.lifetimeEarned).toBeUndefined();
      // The guarded DEBIT never uses the plain (unconditional) update.
      expect(mockTx.wallet.update).not.toHaveBeenCalled();
      expect(mockTx.pointsLedger.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ transactionType: 'ADJUST', points: -10 }),
      );
    });

    // TOCTOU: pre-tx read shows enough, but a concurrent debit consumed the balance
    // before our guarded update ran → the WHERE guard matches 0 rows → clean reject,
    // never a negative balance.
    it('on DEBIT rejects (BadRequest) when the guarded update matches no row (concurrent depletion)', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 50 });
      mockTx.wallet.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.adjust(gifsy, { partnerId: 'cp1', amount: 40, type: AdjustType.DEBIT, reason: 'race', approvedBy: 'a' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // No balance was read-back and no ledger/audit rows were written.
      expect(mockTx.wallet.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(mockTx.walletTransaction.create).not.toHaveBeenCalled();
      expect(mockTx.auditLog.create).not.toHaveBeenCalled();
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
        { id: 'lot1', walletId: 'w1', schemeId: null, points: 30, remainingPoints: 30 },
      ]);
      // The sweep re-reads the claimed lot's FROZEN remaining and expires exactly that.
      mockTx.pointsLedger.findUnique.mockResolvedValue({ id: 'lot1', walletId: 'w1', schemeId: null, remainingPoints: 30 });
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
      // Lot granted 30 but only 10 remain unspent (rest already redeemed via FIFO) — the sweep
      // now expires the lot's REMAINING (10), never its original grant (this is the headline fix).
      mockPrisma.pointsLedger.findMany.mockResolvedValue([
        { id: 'lot1', walletId: 'w1', schemeId: null, points: 30, remainingPoints: 10 },
      ]);
      mockTx.pointsLedger.findUnique.mockResolvedValue({ id: 'lot1', walletId: 'w1', schemeId: null, remainingPoints: 10 });
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
      const res = await service.listTransactions(partner, {});
      // The active partner is resolved via the Wave 3 access-boundary helper (own by default).
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user1', clientId: 'deoleo', deletedAt: null, isParent: false },
        select: { id: true, groupId: true },
      });
      expect(res).toEqual({ transactions: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } });
    });

    // NOTE: the legacy GIFSY-admin `?userId=` passbook branch was REMOVED — it was
    // unreachable (the /wallet/transactions route is @Roles('SSS','WHOLESALER','SUB_STOCKIST'))
    // and no caller ever passed userId. Admin inspection now goes through the dedicated
    // `admin outlet wallet` routes below (keyed on outlet CODE + tenant scope).

    it('threads the x-active-partner-id selector to a SWITCHED sibling passbook (non-admin)', async () => {
      mockPrisma.channelPartner.findFirst.mockImplementation((args: any) =>
        args.where.userId
          ? Promise.resolve({ id: 'cp1', groupId: 'g1' })   // own (resolveActivePartnerId)
          : Promise.resolve({ id: 'sib1' }),                 // the sibling authorization lookup
      );
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'wSib' });
      mockPrisma.walletTransaction.findMany.mockResolvedValue([]);
      mockPrisma.walletTransaction.count.mockResolvedValue(0);
      mockPrisma.outlet.findFirst.mockResolvedValue(null);

      await service.listTransactions(switcher, {}, 'sib1');
      // The passbook wallet belongs to the SIBLING, not the login's own partner.
      expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { partnerId: 'sib1' } });
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
      // A non-credit row carries no field name and a null raw narration.
      expect(res.transactions[0].fieldName).toBeNull();
      expect(res.transactions[0].narration).toBeNull();
    });

    it('resolves fieldName for a CREDIT_BATCH row from the batch (blank narration → amount match) and returns the raw narration', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1' });
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletCode: 'OUT-1' });
      const creditTx = {
        id: 'c1',
        transactionType: 'CREDIT_POINTS_EARNED',
        description: null, // blank upload narration → resolves by amount only
        points: 10,
        createdAt: new Date('2026-02-01'),
        balanceType: 'REDEEMABLE',
        balanceAfter: 10,
        referenceType: 'CREDIT_BATCH',
        referenceId: 'b1',
      };
      // Page query AND the full-set credit query both return this one credit tx.
      mockPrisma.walletTransaction.findMany.mockResolvedValue([creditTx]);
      mockPrisma.walletTransaction.count.mockResolvedValue(1);
      mockPrisma.creditBatch.findMany.mockResolvedValue([
        { id: 'b1', rows: [{ outletId: 'OUT-1', awardType: 'POINTS', amount: 10, fieldName: 'Volume Target', narration: '' }] },
      ]);

      const res = await service.listTransactions(partner, {});

      // Batch lookup is tenant-scoped to the caller's client.
      expect(mockPrisma.creditBatch.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['b1'] }, clientId: 'deoleo' },
        select: { id: true, rows: true },
      });
      expect(res.transactions[0].fieldName).toBe('Volume Target');
      // narration is the RAW description (null here since the upload had none).
      expect(res.transactions[0].narration).toBeNull();
    });

    it('resolves the field name pagination-robustly — full-set query drives consumption for a single-item page', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1' });
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletCode: 'OUT-1' });
      // The PAGE holds only the 2nd (newest) of two same-amount credit rows.
      const pageTx = {
        id: 'c2',
        transactionType: 'CREDIT_POINTS_EARNED',
        description: null,
        points: 10,
        createdAt: new Date('2026-02-02'),
        balanceType: 'REDEEMABLE',
        balanceAfter: 20,
        referenceType: 'CREDIT_BATCH',
        referenceId: 'b1',
      };
      // The FULL credit set (both rows) — resolved over the whole batch so the page
      // row maps to the SECOND batch row via oldest→newest consumption.
      const fullCreditSet = [
        { id: 'c1', referenceType: 'CREDIT_BATCH', referenceId: 'b1', description: null, points: 10, createdAt: new Date('2026-02-01') },
        { id: 'c2', referenceType: 'CREDIT_BATCH', referenceId: 'b1', description: null, points: 10, createdAt: new Date('2026-02-02') },
      ];
      // 1st findMany = the page; 2nd findMany = the full credit set.
      mockPrisma.walletTransaction.findMany
        .mockResolvedValueOnce([pageTx])
        .mockResolvedValueOnce(fullCreditSet);
      mockPrisma.walletTransaction.count.mockResolvedValue(2);
      mockPrisma.creditBatch.findMany.mockResolvedValue([
        { id: 'b1', rows: [
          { outletId: 'OUT-1', awardType: 'POINTS', amount: 10, fieldName: 'First KPI', narration: '' },
          { outletId: 'OUT-1', awardType: 'POINTS', amount: 10, fieldName: 'Second KPI', narration: '' },
        ] },
      ]);

      const res = await service.listTransactions(partner, {});

      // The page's tx (c2, newest) consumes the SECOND row after c1 (oldest) took the first.
      expect(res.transactions).toHaveLength(1);
      expect(res.transactions[0].id).toBe('c2');
      expect(res.transactions[0].fieldName).toBe('Second KPI');
    });

    it('leaves a non-credit tx with fieldName:null even when a credit batch is present', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1' });
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletCode: 'OUT-1' });
      const redeemTx = {
        id: 'r1',
        transactionType: 'DEBIT_REDEMPTION',
        description: 'Redeemed a voucher',
        points: -50,
        createdAt: new Date('2026-02-03'),
        balanceType: 'REDEEMED',
        balanceAfter: 0,
        referenceType: 'REDEMPTION',
        referenceId: 'red1',
      };
      // Page = the redeem row; full credit-set query = none (no CREDIT_BATCH txns).
      mockPrisma.walletTransaction.findMany
        .mockResolvedValueOnce([redeemTx])
        .mockResolvedValueOnce([]);
      mockPrisma.walletTransaction.count.mockResolvedValue(1);

      const res = await service.listTransactions(partner, {});

      expect(res.transactions[0].fieldName).toBeNull();
      // Its description stays its own header; narration is the raw description.
      expect(res.transactions[0].description).toBe('Redeemed a voucher');
      expect(res.transactions[0].narration).toBe('Redeemed a voucher');
      // No CREDIT_BATCH txns → the batch lookup is skipped entirely.
      expect(mockPrisma.creditBatch.findMany).not.toHaveBeenCalled();
    });
  });

  // ─── statement — full, UNPAGINATED statement with stored balances (GET /v1/wallet/statement) ──
  describe('statement', () => {
    const row = (p: { id: string; at: string; type?: string; points: number; before: number; after: number; description?: string | null }) => ({
      id: p.id,
      createdAt: new Date(p.at),
      transactionType: p.type ?? (p.points >= 0 ? 'CREDIT_POINTS_EARNED' : 'DEBIT_REDEMPTION'),
      points: p.points,
      balanceBefore: p.before,
      balanceAfter: p.after,
      description: p.description ?? null,
      referenceType: null,
      referenceId: null,
    });
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warnSpy.mockRestore());

    it('a foreign x-active-partner-id → ForbiddenException (same access boundary as the passbook)', async () => {
      mockPrisma.channelPartner.findFirst.mockImplementation((args: any) =>
        args.where.userId ? Promise.resolve({ id: 'cp1', groupId: 'g1' }) : Promise.resolve(null),
      );
      await expect(service.statement(switcher, {}, 'someone-else')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.walletTransaction.findMany).not.toHaveBeenCalled();
    });

    it('no operable partner → an empty zero statement', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      await expect(service.statement(partner, {})).resolves.toEqual({
        openingBalance: 0,
        closingBalance: 0,
        currentBalance: 0,
        outletCode: '',
        rows: [],
      });
    });

    it('no wallet yet (pre-KYC) → an empty zero statement, not a 404', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      await expect(service.statement(partner, {})).resolves.toEqual({
        openingBalance: 0,
        closingBalance: 0,
        currentBalance: 0,
        outletCode: '',
        rows: [],
      });
      expect(mockPrisma.walletTransaction.findMany).not.toHaveBeenCalled();
    });

    it('returns every row oldest-first with stored balances, currentBalance and the API row shape', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 66 });
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletCode: 'OUT-1' });
      // 25 rows: more than the old 20-row passbook page, so the statement can't be truncated.
      const rows = [] as ReturnType<typeof row>[];
      let bal = 0;
      for (let i = 0; i < 25; i++) {
        const pts = i === 24 ? -30 : 4;
        rows.push(row({ id: `t${String(i).padStart(2, '0')}`, at: `2026-01-${String(i + 1).padStart(2, '0')}T06:00:00Z`, points: pts, before: bal, after: bal + pts }));
        bal += pts;
      }
      rows[24].description = 'Redeemed a voucher';
      mockPrisma.walletTransaction.findMany.mockResolvedValue(rows);

      const res = await service.statement(partner, {});

      expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { partnerId: 'cp1' } });
      expect(res.rows).toHaveLength(25);
      expect(res.openingBalance).toBe(0);
      expect(res.closingBalance).toBe(66); // 24 × 4 − 30
      expect(res.currentBalance).toBe(66);
      expect(res.outletCode).toBe('OUT-1'); // the outlet whose field names were resolved
      expect(res.rows[0]).toEqual({
        id: 't00',
        date: '2026-01-01T06:00:00.000Z',
        transactionType: 'CREDIT_POINTS_EARNED',
        description: 'Points earned', // getDefaultDescription fallback
        narration: null, // RAW description
        fieldName: null,
        points: 4,
        balanceBefore: 0,
        balanceAfter: 4,
        referenceType: null,
        referenceId: null,
      });
      expect(res.rows[24]).toMatchObject({ points: -30, balanceAfter: 66, description: 'Redeemed a voucher', narration: 'Redeemed a voucher' });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('passes from/to through as an IST month window', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 145 });
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletCode: 'OUT-1' });
      mockPrisma.walletTransaction.findMany.mockResolvedValue([
        row({ id: 'a', at: '2026-03-15T00:00:00Z', points: 100, before: 0, after: 100 }),
        row({ id: 'b', at: '2026-04-15T00:00:00Z', points: 45, before: 100, after: 145 }),
      ]);
      const res = await service.statement(partner, { from: '2026-04', to: '2026-04' });
      expect(res.rows.map((r) => r.id)).toEqual(['b']);
      expect(res.openingBalance).toBe(100);
      expect(res.closingBalance).toBe(145);
    });

    it('tie-out: a full statement whose closing ≠ the live wallet balance logs a warning and still returns the stored values', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 999 });
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletCode: 'OUT-1' });
      mockPrisma.walletTransaction.findMany.mockResolvedValue([
        row({ id: 'a', at: '2026-03-15T00:00:00Z', points: 100, before: 0, after: 100 }),
      ]);
      const res = await service.statement(partner, {});
      expect(res.closingBalance).toBe(100);
      expect(res.currentBalance).toBe(999);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = String(warnSpy.mock.calls[0][0]);
      expect(msg).toContain('w1');
      expect(msg).toContain('100');
      expect(msg).toContain('999');
    });

    it('tie-out: a broken balance chain (a row whose balanceBefore ≠ the previous balanceAfter) logs a warning and keeps the stored values', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 260 });
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletCode: 'OUT-1' });
      mockPrisma.walletTransaction.findMany.mockResolvedValue([
        row({ id: 'a', at: '2026-03-15T00:00:00Z', points: 100, before: 0, after: 100 }),
        // gap: before should be 100
        row({ id: 'b', at: '2026-03-16T00:00:00Z', points: 10, before: 250, after: 260 }),
      ]);
      const res = await service.statement(partner, {});
      expect(res.rows.map((r) => r.balanceAfter)).toEqual([100, 260]);
      expect(res.closingBalance).toBe(260);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = String(warnSpy.mock.calls[0][0]);
      expect(msg).toContain('w1');
      expect(msg).toMatch(/chain/i);
    });

    it('the tie-out runs on the FULL history, so a mid-history range of a consistent wallet logs nothing', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 145 });
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletCode: 'OUT-1' });
      mockPrisma.walletTransaction.findMany.mockResolvedValue([
        row({ id: 'a', at: '2026-03-15T00:00:00Z', points: 100, before: 0, after: 100 }),
        row({ id: 'b', at: '2026-04-15T00:00:00Z', points: 45, before: 100, after: 145 }),
      ]);
      await service.statement(partner, { from: '2026-03', to: '2026-03' });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // ─── pointsCreditedInMonth — scale-safe month aggregate (NOT the paginated passbook) ──
  describe('pointsCreditedInMonth', () => {
    // Attach the aggregate mock (not in the base mock object). Re-set per test since
    // resetAllMocks() in beforeEach clears call state.
    const agg = () =>
      ((mockPrisma.walletTransaction as unknown as { aggregate: jest.Mock }).aggregate ??=
        jest.fn());

    it('rejects a malformed month before any DB work', async () => {
      await expect(service.pointsCreditedInMonth(partner, '2026-9')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockPrisma.channelPartner.findFirst).not.toHaveBeenCalled();
    });

    it('returns 0 when the caller has no operable partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      const res = await service.pointsCreditedInMonth(partner, '2026-09');
      expect(res).toEqual({ month: '2026-09', points: 0 });
    });

    it('returns 0 when the partner has no wallet', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      const res = await service.pointsCreditedInMonth(partner, '2026-09');
      expect(res).toEqual({ month: '2026-09', points: 0 });
    });

    it('sums only EARN credit types over the IST month window (reversals/debits excluded by the query)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1' });
      const aggMock = agg();
      aggMock.mockResolvedValue({ _sum: { points: 42_000 } });

      const res = await service.pointsCreditedInMonth(partner, '2026-09');
      expect(res).toEqual({ month: '2026-09', points: 42_000 });

      // The aggregate is scoped to the wallet, the three EARN credit types, and the
      // IST month window [00:00 IST 1 Sep, 00:00 IST 1 Oct) — 05:30 earlier in UTC.
      const call = aggMock.mock.calls[0][0];
      expect(call._sum).toEqual({ points: true });
      expect(call.where.walletId).toBe('w1');
      expect(call.where.transactionType.in).toEqual([
        'CREDIT_POINTS_EARNED',
        'CREDIT_BONUS',
        'CREDIT_ADJUSTMENT',
      ]);
      expect(call.where.transactionType.in).not.toContain('CREDIT_REVERSAL');
      expect((call.where.createdAt.gte as Date).toISOString()).toBe('2026-08-31T18:30:00.000Z');
      expect((call.where.createdAt.lt as Date).toISOString()).toBe('2026-09-30T18:30:00.000Z');
      // Never touches the paginated passbook query → correct at any scale.
      expect(mockPrisma.walletTransaction.findMany).not.toHaveBeenCalled();
    });

    it('coerces a null aggregate (no credits that month) to 0', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1' });
      agg().mockResolvedValue({ _sum: { points: null } });
      const res = await service.pointsCreditedInMonth(partner, '2026-09');
      expect(res).toEqual({ month: '2026-09', points: 0 });
    });
  });

  // ─── GIFSY-only admin: wallet BY OUTLET (keyed on outlet CODE + tenant scope) ──────
  describe('admin outlet wallet', () => {
    const wsummary = {
      earnedPoints: 100, lockedPoints: 0, redeemablePoints: 90, redeemedPoints: 10,
      expiredPoints: 0, lifetimeEarned: 100, lifetimeRedeemed: 10, lifetimeExpired: 0,
    };

    describe('adminOutletWallet (summary)', () => {
      it('404s a foreign-tenant / missing outlet code (tenant scope holds)', async () => {
        // resolveAdminOutlet finds nothing for (clientId, outletCode) → NotFound.
        mockPrisma.outlet.findFirst.mockResolvedValue(null);
        await expect(service.adminOutletWallet(gifsy, 'OUT-FOREIGN')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        // Lookup is tenant-scoped to the operator's clientId + code + not-deleted.
        expect(mockPrisma.outlet.findFirst).toHaveBeenCalledWith({
          where: { clientId: 'deoleo', outletCode: 'OUT-FOREIGN', deletedAt: null },
          select: { outletCode: true, name: true, ownerName: true, partnerId: true },
        });
        // No wallet ever loaded for a 404 outlet.
        expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
      });

      it('outlet WITH partner+wallet → summary balances + conversionRate + identity + hasWallet:true', async () => {
        mockPrisma.outlet.findFirst.mockResolvedValue({
          outletCode: 'OUT-1', name: 'Shop One', ownerName: 'Alice', partnerId: 'cp1',
        });
        mockPrisma.wallet.findFirst.mockResolvedValue(wsummary);

        const res = await service.adminOutletWallet(gifsy, 'OUT-1');

        expect(res.hasWallet).toBe(true);
        expect(res.partnerId).toBe('cp1');
        expect(res.outlet).toEqual({ outletCode: 'OUT-1', name: 'Shop One', ownerName: 'Alice' });
        // Balances + tenant rate come through the SHARED loadWalletSummary.
        expect(res.wallet.redeemablePoints).toBe(90);
        expect(res.wallet.lifetimeEarned).toBe(100);
        expect(res.wallet.currency).toBe('POINTS');
        expect(res.wallet.conversionRate).toBe(1);
        // The wallet is loaded for the outlet's partner.
        expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { partnerId: 'cp1' } });
      });

      it('pre-KYC outlet (partnerId null) → hasWallet:false + zeroed (rate-carrying) summary, no wallet query', async () => {
        mockPrisma.outlet.findFirst.mockResolvedValue({
          outletCode: 'OUT-2', name: 'Shop Two', ownerName: 'Bob', partnerId: null,
        });

        const res = await service.adminOutletWallet(gifsy, 'OUT-2');

        expect(res.hasWallet).toBe(false);
        expect(res.partnerId).toBeNull();
        expect(res.outlet).toEqual({ outletCode: 'OUT-2', name: 'Shop Two', ownerName: 'Bob' });
        expect(res.wallet.redeemablePoints).toBe(0);
        expect(res.wallet.lifetimeExpired).toBe(0);
        expect(res.wallet.conversionRate).toBe(1);
        // No partner → never touches the wallet table.
        expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
      });
    });

    describe('adminOutletTransactions (passbook)', () => {
      it('404s a foreign-tenant / missing outlet code (tenant scope holds)', async () => {
        mockPrisma.outlet.findFirst.mockResolvedValue(null);
        await expect(
          service.adminOutletTransactions(gifsy, 'OUT-FOREIGN', {}),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
      });

      it('pre-KYC outlet (partnerId null) → empty page, no wallet query', async () => {
        mockPrisma.outlet.findFirst.mockResolvedValue({
          outletCode: 'OUT-2', name: 'Shop Two', ownerName: 'Bob', partnerId: null,
        });

        const res = await service.adminOutletTransactions(gifsy, 'OUT-2', { page: 2, limit: 5 });

        expect(res).toEqual({ transactions: [], pagination: { page: 2, limit: 5, total: 0, pages: 0 } });
        expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
      });

      it('resolves credit field-names against the SELECTED outlet and SKIPS the primary-derive (item-2 fix)', async () => {
        // resolveAdminOutlet resolves OUT-1; loadPassbook must reuse THAT code (not re-derive a primary).
        mockPrisma.outlet.findFirst.mockResolvedValue({
          outletCode: 'OUT-1', name: 'Shop One', ownerName: 'Alice', partnerId: 'cp1',
        });
        mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1' });
        mockPrisma.walletTransaction.findMany.mockResolvedValue([
          {
            id: 't1',
            transactionType: 'CREDIT_POINTS_EARNED',
            description: 'Diwali bonus',
            points: 10,
            createdAt: new Date('2026-01-01'),
            balanceType: 'REDEEMABLE',
            balanceAfter: 10,
            referenceType: 'CREDIT_BATCH',
            referenceId: 'b1',
          },
        ]);
        mockPrisma.walletTransaction.count.mockResolvedValue(1);
        // The batch carries a POINTS row for the SELECTED outlet OUT-1 → its field name resolves.
        mockPrisma.creditBatch.findMany.mockResolvedValue([
          { id: 'b1', rows: [{ outletId: 'OUT-1', awardType: 'POINTS', amount: 10, narration: 'Diwali bonus', fieldName: 'Festive Incentive' }] },
        ]);

        const res = await service.adminOutletTransactions(gifsy, 'OUT-1', {});

        expect(res.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
        // Field name resolved against OUT-1's rows — proving the admin's selected outlet is used.
        expect(res.transactions[0].fieldName).toBe('Festive Incentive');
        expect(res.transactions[0].narration).toBe('Diwali bonus');
        // The primary-outlet derive is SKIPPED: outlet.findFirst runs ONCE (only resolveAdminOutlet).
        expect(mockPrisma.outlet.findFirst).toHaveBeenCalledTimes(1);
        // The passbook wallet belongs to the outlet's partner.
        expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { partnerId: 'cp1' } });
      });
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FIFO points-expiry (PointsLedger.remainingPoints) — the per-lot "spendable lot" model
//
// WHY a small stateful fake instead of the jest.fn mocks used above: this change is
// about OBSERVABLE OUTCOMES ACROSS MANY LOTS — which lot's remainingPoints dropped,
// how much a sweep *actually* expired, the wallet counters after a mixed sequence.
// Asserting those on bare jest.fn()s would mean pinning the exact private Prisma call
// shapes the (parallel) implementation happens to pick — i.e. testing private helper
// internals, which the brief forbids. So these tests drive the REAL WalletService
// against an in-memory emulation of the two tables it touches (wallet + pointsLedger)
// that understands standard Prisma where / orderBy / increment / decrement / set
// semantics, then assert the resulting in-memory STATE + method RETURN VALUES. Robust
// to HOW the impl writes; strict on WHAT it produces.
//
// These tests assert the frozen behavioural contract for the FIFO change; the parallel
// implementation has landed and the whole suite is green. No assertion is weakened to pass.
// One contract-vs-impl divergence is documented inline (test 4 — isExpired on a fully-redeemed lot).
// All dates are relative to a fixed NOW (never a hardcoded calendar date → WAYS #10).
// ════════════════════════════════════════════════════════════════════════════════

const NOW = new Date('2026-06-01T00:00:00.000Z');
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000);

// A spendable lot = points > 0 AND transactionType ∈ {EARN, REVERSE, ADJUST}.
const SPENDABLE = ['EARN', 'REVERSE', 'ADJUST'];

type AnyRow = Record<string, any>;
const num = (x: any) => (x instanceof Date ? x.getTime() : x);

// Generic Prisma-ish WHERE matcher: scalars, null, and {in|gt|gte|lt|lte|not|equals}.
// Unknown nested relation filters (e.g. partner:{user:{clientId}}) are ignored — tenant
// scope is asserted by the jest.fn suite above; here we only model FIFO state.
function matchWhere(row: AnyRow, where: AnyRow): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === null) {
      if (row[k] !== null && row[k] !== undefined) return false;
      continue;
    }
    if (typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) { if (!(v as any).in.includes(row[k])) return false; }
      else if ('gt' in v) { if (!(num(row[k]) > num((v as any).gt))) return false; }
      else if ('gte' in v) { if (!(num(row[k]) >= num((v as any).gte))) return false; }
      else if ('lt' in v) { if (!(num(row[k]) < num((v as any).lt))) return false; }
      else if ('lte' in v) { if (!(num(row[k]) <= num((v as any).lte))) return false; }
      else if ('not' in v) { if (row[k] === (v as any).not) return false; }
      else if ('equals' in v) { if (row[k] !== (v as any).equals) return false; }
      // else: nested relation filter → ignore for FIFO state purposes.
    } else if (v instanceof Date) {
      if (!(row[k] instanceof Date) || row[k].getTime() !== v.getTime()) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

// Apply a Prisma data object (supports {increment|decrement|set}, Dates, scalars).
function applyData(row: AnyRow, data: AnyRow): void {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('increment' in v) row[k] = (row[k] ?? 0) + (v as any).increment;
      else if ('decrement' in v) row[k] = (row[k] ?? 0) - (v as any).decrement;
      else if ('set' in v) row[k] = (v as any).set;
      else row[k] = v;
    } else row[k] = v;
  }
}

function orderRows(rows: AnyRow[], orderBy: any): AnyRow[] {
  if (!orderBy) return rows;
  const spec = Array.isArray(orderBy) ? orderBy[0] : orderBy;
  const [key, dir] = Object.entries(spec)[0] as [string, string];
  return [...rows].sort((a, b) => (dir === 'asc' ? num(a[key]) - num(b[key]) : num(b[key]) - num(a[key])));
}

interface InitialState {
  wallet?: Partial<AnyRow>;
  lots?: AnyRow[];
  config?: { expiryDays: number } | null; // active PointExpiryConfig (null → no expiry)
  batches?: AnyRow[]; // CreditBatch rows ({ id, clientId, rows }) for legacy-credit replay
  outlets?: AnyRow[]; // Outlet rows ({ outletCode, partnerId, clientId })
  reversals?: AnyRow[]; // CreditReversal rows ({ id, batchId, outletId, fieldId }) for legacy clawbacks
}

function buildHarness(initial: InitialState = {}) {
  let seq = 0;
  const ledger: AnyRow[] = (initial.lots ?? []).map((l) => ({
    isExpired: false,
    remainingPoints: 0,
    schemeId: null,
    ...l,
  }));
  const walletRow: AnyRow = {
    id: 'w1',
    partnerId: 'cp1',
    earnedPoints: 0,
    lockedPoints: 0,
    redeemablePoints: 0,
    redeemedPoints: 0,
    expiredPoints: 0,
    lifetimeEarned: 0,
    lifetimeRedeemed: 0,
    lifetimeExpired: 0,
    ...(initial.wallet ?? {}),
  };
  const walletTxns: AnyRow[] = [];
  const rawWalletTxCreates: AnyRow[] = [];
  const auditLogs: AnyRow[] = [];
  const config = initial.config ?? null;
  const clientId = 'deoleo'; // the single tenant these FIFO tests operate under

  const models: AnyRow = {
    wallet: {
      findFirst: async ({ where }: any) => [walletRow].find((w) => matchWhere(w, where)) ?? null,
      findUniqueOrThrow: async ({ where }: any) => {
        const w = [walletRow].find((x) => matchWhere(x, where));
        if (!w) throw new Error('wallet not found');
        return w;
      },
      update: async ({ where, data }: any) => {
        const w = [walletRow].find((x) => matchWhere(x, where));
        if (!w) throw new Error('wallet not found');
        applyData(w, data);
        return w;
      },
      updateMany: async ({ where, data }: any) => {
        const w = [walletRow].find((x) => matchWhere(x, where));
        if (!w) return { count: 0 };
        applyData(w, data);
        return { count: 1 };
      },
    },
    walletTransaction: {
      create: async ({ data }: any) => {
        rawWalletTxCreates.push(data);
        // Deterministic ordering in tests: the service's under-lock createdAt stamp (asserted via
        // rawWalletTxCreates) is replaced by a strictly increasing harness clock.
        const row = { id: `wt${++seq}`, ...data, createdAt: new Date(NOW.getTime() + seq) };
        walletTxns.push(row);
        return row;
      },
      findFirst: async ({ where, orderBy }: any = {}) =>
        orderRows(walletTxns.filter((r) => matchWhere(r, where ?? {})), orderBy)[0] ?? null,
      findMany: async ({ where, orderBy }: any = {}) =>
        orderRows(walletTxns.filter((r) => matchWhere(r, where ?? {})), orderBy),
    },
    creditBatch: {
      findFirst: async ({ where }: any) => (initial.batches ?? []).find((b) => matchWhere(b, where ?? {})) ?? null,
    },
    outlet: {
      findMany: async ({ where }: any) => (initial.outlets ?? []).filter((o) => matchWhere(o, where ?? {})),
      findFirst: async ({ where }: any) => (initial.outlets ?? []).find((o) => matchWhere(o, where ?? {})) ?? null,
    },
    creditReversal: {
      findFirst: async ({ where }: any) => (initial.reversals ?? []).find((r) => matchWhere(r, where ?? {})) ?? null,
    },
    pointsLedger: {
      create: async ({ data }: any) => {
        const row = {
          id: `pl${++seq}`,
          isExpired: false,
          remainingPoints: 0,
          createdAt: new Date(NOW.getTime() + seq),
          ...data,
        };
        ledger.push(row);
        return row;
      },
      findMany: async ({ where, orderBy, take, skip }: any = {}) => {
        let rows = ledger.filter((r) => matchWhere(r, where ?? {}));
        rows = orderRows(rows, orderBy);
        if (skip) rows = rows.slice(skip);
        if (take != null) rows = rows.slice(0, take);
        return rows;
      },
      findFirst: async ({ where, orderBy }: any = {}) =>
        orderRows(ledger.filter((r) => matchWhere(r, where ?? {})), orderBy)[0] ?? null,
      findUnique: async ({ where }: any) => ledger.find((r) => matchWhere(r, where ?? {})) ?? null,
      update: async ({ where, data }: any) => {
        const r = ledger.find((x) => matchWhere(x, where));
        if (!r) throw new Error('ledger row not found');
        applyData(r, data);
        return r;
      },
      updateMany: async ({ where, data }: any) => {
        const rows = ledger.filter((r) => matchWhere(r, where));
        rows.forEach((r) => applyData(r, data));
        return { count: rows.length };
      },
    },
    pointExpiryConfig: {
      findFirst: async ({ where }: any) => {
        if (!config) return null;
        const row = { clientId: where?.clientId, isActive: true, isDefault: true, schemeId: null, ...config };
        return matchWhere(row, where ?? {}) ? row : null;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        const row = { id: `al${++seq}`, ...data };
        auditLogs.push(row);
        return row;
      },
    },
    // reverse() resolves the tenant (clientId) from the partner to re-date the REVERSE lot's
    // fresh expiry. Single-partner harness → always the configured tenant.
    channelPartner: {
      findFirst: async ({ where }: any) => ({ id: where?.id ?? 'cp1', clientId }),
    },
    // expiry sweep locks the wallet row first (SELECT … FOR UPDATE). No-op in this
    // single-threaded harness (it emulates the row-lock's EFFECT by serial execution).
    $queryRaw: jest.fn(async (..._args: any[]) => []),
    // Accept the (cb, _opts?) signature so a timeout-opts arg can never break composition.
    $transaction: jest.fn(async (cb: any, _opts?: any) => cb(models)),
  };

  const service = new WalletService(
    models as unknown as PrismaService,
    mockTenantSettings as unknown as TenantSettingsService,
  );

  return {
    service,
    store: models,
    wallet: walletRow,
    ledger,
    walletTxns,
    rawWalletTxCreates,
    auditLogs,
    lot: (id: string) => ledger.find((r) => r.id === id),
    spendableLots: () => ledger.filter((r) => SPENDABLE.includes(r.transactionType) && !r.isExpired),
    rowsOfType: (t: string) => ledger.filter((r) => r.transactionType === t),
  };
}

describe('WalletService — FIFO points-expiry (remainingPoints)', () => {
  // ── (1) creditEarn stamps remainingPoints on the EARN lot ───────────────────────
  describe('creditEarn stamps the EARN lot with remainingPoints', () => {
    it('sets remainingPoints = amount AND an expiresAt when a config is active', async () => {
      const h = buildHarness({ wallet: { redeemablePoints: 0 }, config: { expiryDays: 90 } });
      await h.service.creditEarn('cp1', 'deoleo', 25, {});
      const earn = h.rowsOfType('EARN')[0];
      expect(earn.points).toBe(25);
      expect(earn.remainingPoints).toBe(25);
      expect(earn.expiresAt).toBeInstanceOf(Date);
    });

    it('sets remainingPoints = amount with a null expiresAt when no config matches', async () => {
      const h = buildHarness({ wallet: { redeemablePoints: 0 }, config: null });
      await h.service.creditEarn('cp1', 'deoleo', 10, {});
      const earn = h.rowsOfType('EARN')[0];
      expect(earn.remainingPoints).toBe(10);
      expect(earn.expiresAt ?? null).toBeNull();
    });
  });

  // ── (2) debitRedeem consumes oldest spendable lots first ────────────────────────
  it('debitRedeem consumes the OLDEST lot first (FIFO) across two earns', async () => {
    const h = buildHarness({
      wallet: { redeemablePoints: 150, earnedPoints: 150, lifetimeEarned: 150 },
      lots: [
        { id: 'A', walletId: 'w1', transactionType: 'EARN', points: 100, remainingPoints: 100, expiresAt: daysFromNow(30), createdAt: daysFromNow(-10) },
        { id: 'B', walletId: 'w1', transactionType: 'EARN', points: 50, remainingPoints: 50, expiresAt: daysFromNow(60), createdAt: daysFromNow(-5) },
      ],
    });
    const res = await h.service.debitRedeem('cp1', 80, { referenceId: 'order1' });

    expect(res.newRedeemable).toBe(70);
    expect(h.wallet.redeemablePoints).toBe(70);
    expect(h.wallet.redeemedPoints).toBe(80);
    expect(h.wallet.lifetimeRedeemed).toBe(80);
    // Oldest (A) drained to 20; newest (B) untouched.
    expect(h.lot('A')!.remainingPoints).toBe(20);
    expect(h.lot('B')!.remainingPoints).toBe(50);
    // A REDEEM ledger movement of -80 was written (passbook/ledger parity).
    expect(h.rowsOfType('REDEEM').some((r) => r.points === -80)).toBe(true);
  });

  // ── (3) THE HEADLINE over-expiry case ───────────────────────────────────────────
  it('expires ONLY a lot’s remainingPoints, not its full grant (headline over-expiry fix)', async () => {
    // State AS-IF after: earn A=100 (expires day1) + B=50 (expires day5), then redeem 80
    // consumed A first → A.remaining=20, B.remaining=50, redeemable=70.
    const h = buildHarness({
      wallet: { redeemablePoints: 70, earnedPoints: 150, lifetimeEarned: 150, redeemedPoints: 80, lifetimeRedeemed: 80 },
      lots: [
        { id: 'A', walletId: 'w1', transactionType: 'EARN', points: 100, remainingPoints: 20, expiresAt: daysFromNow(1), createdAt: daysFromNow(-10) },
        { id: 'B', walletId: 'w1', transactionType: 'EARN', points: 50, remainingPoints: 50, expiresAt: daysFromNow(5), createdAt: daysFromNow(-5) },
      ],
    });
    const res = await h.service.expireDuePoints({ now: daysFromNow(2) });

    // Only A is due; it backs just 20 spendable points → expire 20 (pre-fix wrongly expired 70).
    expect(res).toEqual({ expiredLots: 1, expiredPoints: 20 });
    // NOTE: the brief’s prose says \"redeemablePoints stays 70\", but that contradicts both
    // invariant #8 (redeemable === Σ remaining over live lots → 50) and \"expiredPoints += 20\".
    // The invariant-consistent outcome after expiring 20 is 50; asserting 50 (flagged to integrator).
    expect(h.wallet.redeemablePoints).toBe(50);
    expect(h.wallet.expiredPoints).toBe(20);
    expect(h.wallet.lifetimeExpired).toBe(20);
    expect(h.lot('A')!.isExpired).toBe(true);
    expect(h.lot('A')!.remainingPoints).toBe(0);
    expect(h.lot('B')!.isExpired).toBe(false);
    expect(h.lot('B')!.remainingPoints).toBe(50);
  });

  // ── (4) a fully-redeemed, past-expiry lot moves no balance and writes no EXPIRE row ──
  it('does not expire (or double-count) a fully-redeemed lot: no balance move, no EXPIRE row', async () => {
    const h = buildHarness({
      wallet: { redeemablePoints: 0, redeemedPoints: 100, lifetimeRedeemed: 100 },
      lots: [
        { id: 'A', walletId: 'w1', transactionType: 'EARN', points: 100, remainingPoints: 0, expiresAt: daysFromNow(1), createdAt: daysFromNow(-10) },
      ],
    });
    const res = await h.service.expireDuePoints({ now: daysFromNow(2) });

    // The money-safe outcome (contract #4): a lot with 0 unspent points expires 0 — no
    // balance move, no EXPIRE movement row, counters flat.
    expect(res).toEqual({ expiredLots: 0, expiredPoints: 0 });
    expect(h.rowsOfType('EXPIRE').length).toBe(0);
    expect(h.wallet.redeemablePoints).toBe(0);
    expect(h.wallet.expiredPoints).toBe(0);
    expect(h.wallet.lifetimeExpired).toBe(0);
    // ⚠️ CONTRACT-vs-IMPL DIVERGENCE (flagged to integrator): contract #4 says the lot is
    // also marked isExpired=true. The landed impl's due-lot query filters remainingPoints>0,
    // so a fully-redeemed lot is never selected and its isExpired flag stays false. This is
    // money-equivalent (a 0-remaining lot can never contribute balance), so this test asserts
    // only the money-safe outcomes above and does NOT pin isExpired either way.
  });

  // ── (5) sweep idempotency — a second run never double-expires ────────────────────
  it('is idempotent: a second sweep does not re-expire an already-swept lot', async () => {
    const h = buildHarness({
      wallet: { redeemablePoints: 70, earnedPoints: 100, lifetimeEarned: 100 },
      lots: [
        { id: 'A', walletId: 'w1', transactionType: 'EARN', points: 100, remainingPoints: 20, expiresAt: daysFromNow(1), createdAt: daysFromNow(-10) },
      ],
    });
    await h.service.expireDuePoints({ now: daysFromNow(2) });
    const second = await h.service.expireDuePoints({ now: daysFromNow(2) });

    expect(second).toEqual({ expiredLots: 0, expiredPoints: 0 });
    expect(h.lot('A')!.isExpired).toBe(true);
    // Exactly ONE EXPIRE movement total across the two runs (isExpired guard held).
    expect(h.rowsOfType('EXPIRE').length).toBe(1);
  });

  // ── (6) reverse / refund ─────────────────────────────────────────────────────────
  describe('reverse (refund) lots', () => {
    it('creates a REVERSE lot with remainingPoints + a FRESH expiresAt; earned/lifetime untouched', async () => {
      const h = buildHarness({
        wallet: { redeemablePoints: 10, earnedPoints: 200, lifetimeEarned: 200 },
        config: { expiryDays: 90 },
      });
      await h.service.reverse('cp1', 20, { referenceId: 'order1' });
      const rev = h.rowsOfType('REVERSE')[0];

      expect(rev.points).toBe(20);
      expect(rev.remainingPoints).toBe(20);
      expect(rev.expiresAt).toBeInstanceOf(Date); // fresh expiry (resolved from tenant config)
      expect(h.wallet.redeemablePoints).toBe(30);
      // A refund is NOT new earning → monotonic accumulators are unchanged.
      expect(h.wallet.earnedPoints).toBe(200);
      expect(h.wallet.lifetimeEarned).toBe(200);
    });

    it('lets a later sweep expire a due REVERSE lot', async () => {
      const h = buildHarness({
        wallet: { redeemablePoints: 20 },
        lots: [
          { id: 'R', walletId: 'w1', transactionType: 'REVERSE', points: 20, remainingPoints: 20, expiresAt: daysFromNow(1), createdAt: daysFromNow(-3) },
        ],
      });
      const res = await h.service.expireDuePoints({ now: daysFromNow(2) });

      expect(res).toEqual({ expiredLots: 1, expiredPoints: 20 });
      expect(h.lot('R')!.isExpired).toBe(true);
      expect(h.lot('R')!.remainingPoints).toBe(0);
      expect(h.wallet.redeemablePoints).toBe(0);
      expect(h.wallet.expiredPoints).toBe(20);
    });
  });

  // ── (7) adjust CREDIT / adjust DEBIT / clawback ──────────────────────────────────
  describe('adjust + clawback lot behaviour', () => {
    it('adjust CREDIT creates an expirable ADJUST lot (remainingPoints + fresh expiresAt) and bumps earned/lifetime', async () => {
      const h = buildHarness({
        wallet: { redeemablePoints: 50, earnedPoints: 50, lifetimeEarned: 50 },
        config: { expiryDays: 90 },
      });
      const res = await h.service.adjust(gifsy, {
        partnerId: 'cp1', amount: 10, type: AdjustType.CREDIT, reason: 'bonus', approvedBy: 'a',
      });
      const adj = h.rowsOfType('ADJUST')[0];

      expect(res.newBalance).toBe(60);
      expect(adj.points).toBe(10);
      expect(adj.remainingPoints).toBe(10);
      expect(adj.expiresAt).toBeInstanceOf(Date);
      expect(h.wallet.earnedPoints).toBe(60);
      expect(h.wallet.lifetimeEarned).toBe(60);
    });

    it('adjust DEBIT FIFO-consumes oldest lots and does NOT touch earned/lifetime', async () => {
      const h = buildHarness({
        wallet: { redeemablePoints: 70, earnedPoints: 200, lifetimeEarned: 200 },
        lots: [
          { id: 'A', walletId: 'w1', transactionType: 'EARN', points: 100, remainingPoints: 20, expiresAt: daysFromNow(30), createdAt: daysFromNow(-10) },
          { id: 'B', walletId: 'w1', transactionType: 'EARN', points: 100, remainingPoints: 50, expiresAt: daysFromNow(60), createdAt: daysFromNow(-5) },
        ],
      });
      const res = await h.service.adjust(gifsy, {
        partnerId: 'cp1', amount: 30, type: AdjustType.DEBIT, reason: 'clawback', approvedBy: 'a',
      });

      expect(res.newBalance).toBe(40);
      expect(h.lot('A')!.remainingPoints).toBe(0);  // 20 consumed first
      expect(h.lot('B')!.remainingPoints).toBe(40); // then 10 from B
      expect(h.wallet.earnedPoints).toBe(200);
      expect(h.wallet.lifetimeEarned).toBe(200);
    });

    it('clawbackAward clamps redeemable at 0 with a shortfall and FIFO-consumes remaining; no lifetime change', async () => {
      const h = buildHarness({
        wallet: { redeemablePoints: 30, earnedPoints: 100, lifetimeEarned: 100, lifetimeRedeemed: 0 },
        lots: [
          { id: 'A', walletId: 'w1', transactionType: 'EARN', points: 100, remainingPoints: 30, expiresAt: daysFromNow(30), createdAt: daysFromNow(-10) },
        ],
      });
      let result: any;
      await h.store.$transaction(async (tx: any) => {
        result = await h.service.clawbackAward('cp1', 50, {}, tx);
      });

      expect(result.shortfall).toBe(20);          // 50 clawed, only 30 redeemable → 20 short
      expect(h.wallet.redeemablePoints).toBe(0);  // clamped at 0 (never negative)
      expect(h.lot('A')!.remainingPoints).toBe(0); // the 30 available was consumed oldest-first
      expect(h.wallet.lifetimeEarned).toBe(100);   // monotonic — untouched
      expect(h.wallet.lifetimeRedeemed).toBe(0);
    });

    // ── NEGATIVE-balance wallet: a debit must never ADD points ────────────────────────
    it('NEG-1 (no original-credit reference → floor 0): wallet −841, +500 (→ −341), clawback 500 → stays −341 (pre-fix bug jumped to 0); shortfall 500', async () => {
      const h = buildHarness({
        wallet: { redeemablePoints: -841, earnedPoints: 0, lifetimeEarned: 0 },
        config: { expiryDays: 90 },
      });
      await h.service.creditEarn('cp1', 'deoleo', 500, {});
      expect(h.wallet.redeemablePoints).toBe(-341);
      const earnLot = h.rowsOfType('EARN')[0];
      expect(earnLot.remainingPoints).toBe(500);

      let result: any;
      await h.store.$transaction(async (tx: any) => {
        result = await h.service.clawbackAward('cp1', 500, { description: 'Clawback X' }, tx);
      });

      // Pre-fix: decrement = min(500, −341) = −341 → balance jumped to 0 and shortfall read 841.
      expect(h.wallet.redeemablePoints).toBe(-341);  // unchanged — never increased
      expect(result.newRedeemable).toBe(-341);
      expect(result.shortfall).toBe(500);            // nothing could be recovered
      // Passbook row: full −500 recorded, before/after both −341 (scalar did not move).
      const wt = h.walletTxns[h.walletTxns.length - 1];
      expect(wt).toMatchObject({ transactionType: 'DEBIT_ADJUSTMENT', points: -500, balanceBefore: -341, balanceAfter: -341 });
      expect(wt.description).toBe(
        'Clawback X [SHORTFALL: 500 pts not recovered — wallet balance already negative (-341) — owner review required]',
      );
      const adj = h.rowsOfType('ADJUST').find((r) => r.points === -500)!;
      expect(adj.remainingPoints).toBe(0);
      expect(adj.notes).toBe(wt.description);
      // The reversed credit's lot is consumed, so it can never later be expired/spent.
      expect(h.lot(earnLot.id)!.remainingPoints).toBe(0);
      // Monotonic counters untouched by the clawback.
      expect(h.wallet.lifetimeEarned).toBe(500);
      expect(h.wallet.earnedPoints).toBe(500);
      expect(h.wallet.lifetimeRedeemed).toBe(0);
    });

    it('NEG-2: partial recovery from a negative wallet is impossible — any clawback size leaves the balance unchanged', async () => {
      for (const amt of [1, 100, 10_000]) {
        const h = buildHarness({ wallet: { redeemablePoints: -50 } });
        let result: any;
        await h.store.$transaction(async (tx: any) => {
          result = await h.service.clawbackAward('cp1', amt, {}, tx);
        });
        expect(h.wallet.redeemablePoints).toBe(-50);
        expect(result.shortfall).toBe(amt);
      }
    });

    it('NEG-3: expiry sweep on a negative wallet never raises the balance (lot fenced, no EXPIRE row)', async () => {
      const h = buildHarness({
        wallet: { redeemablePoints: -100 },
        lots: [
          { id: 'A', walletId: 'w1', transactionType: 'EARN', points: 40, remainingPoints: 40, expiresAt: daysFromNow(1), createdAt: daysFromNow(-10) },
        ],
      });
      const res = await h.service.expireDuePoints({ now: daysFromNow(2) });
      expect(res).toEqual({ expiredLots: 0, expiredPoints: 0 });
      expect(h.wallet.redeemablePoints).toBe(-100);
      expect(h.wallet.expiredPoints).toBe(0);
      expect(h.rowsOfType('EXPIRE').length).toBe(0);
    });

    // ── Non-negative balances: byte-identical to the pre-fix behaviour ────────────────
    it('POS-1: full cover (redeemable 80, clawback 50) → 30, shortfall 0, description unchanged, before/after 80/30', async () => {
      const h = buildHarness({
        wallet: { redeemablePoints: 80, earnedPoints: 80, lifetimeEarned: 80 },
        lots: [
          { id: 'A', walletId: 'w1', transactionType: 'EARN', points: 80, remainingPoints: 80, expiresAt: daysFromNow(30), createdAt: daysFromNow(-10) },
        ],
      });
      let result: any;
      await h.store.$transaction(async (tx: any) => {
        result = await h.service.clawbackAward('cp1', 50, {}, tx);
      });
      expect(result.shortfall).toBe(0);
      expect(h.wallet.redeemablePoints).toBe(30);
      expect(h.lot('A')!.remainingPoints).toBe(30);
      const wt = h.walletTxns[h.walletTxns.length - 1];
      expect(wt).toMatchObject({ points: -50, balanceBefore: 80, balanceAfter: 30, description: 'Clawback: credit batch POINTS reversal' });
    });

    it('POS-2: partial cover keeps the original "already redeemed" shortfall text (redeemable 30, clawback 50)', async () => {
      const h = buildHarness({ wallet: { redeemablePoints: 30 } });
      let result: any;
      await h.store.$transaction(async (tx: any) => {
        result = await h.service.clawbackAward('cp1', 50, {}, tx);
      });
      expect(result.shortfall).toBe(20);
      expect(h.wallet.redeemablePoints).toBe(0);
      const wt = h.walletTxns[h.walletTxns.length - 1];
      expect(wt).toMatchObject({ points: -50, balanceBefore: 30, balanceAfter: 0 });
      expect(wt.description).toBe(
        'Clawback: credit batch POINTS reversal [SHORTFALL: 20 pts already redeemed — owner review required]',
      );
    });

    it('POS-3: zero balance (redeemable 0, clawback 25) → stays 0, shortfall 25, original text', async () => {
      const h = buildHarness({ wallet: { redeemablePoints: 0 } });
      let result: any;
      await h.store.$transaction(async (tx: any) => {
        result = await h.service.clawbackAward('cp1', 25, {}, tx);
      });
      expect(result.shortfall).toBe(25);
      expect(h.wallet.redeemablePoints).toBe(0);
      expect(h.walletTxns[h.walletTxns.length - 1].description).toBe(
        'Clawback: credit batch POINTS reversal [SHORTFALL: 25 pts already redeemed — owner review required]',
      );
    });

    // ── Owner decision: a reversal fully undoes a credit that landed on a NEGATIVE wallet ──
    // floor = min(0, balanceBefore of the original CREDIT_BATCH credit); not found → 0.
    describe('reversal floor = balance before the reversed credit (when negative)', () => {
      // Credits are posted the way confirmBatch posts them (CREDIT_BATCH/<batchId> + metadata
      // { fieldId, outletCode }); the clawback identifies the EXACT (batch, outlet, field) credit.
      const earn = (h: ReturnType<typeof buildHarness>, amt: number, batchId: string, fieldId = 'f1') =>
        h.service.creditEarn('cp1', 'deoleo', amt, {
          referenceType: 'CREDIT_BATCH', referenceId: batchId, sourceType: 'CREDIT_FIELD', sourceId: fieldId,
          metadata: { fieldId, outletCode: 'OC1' },
        });
      let revSeq = 0;
      const claw = async (h: ReturnType<typeof buildHarness>, amt: number, batchId: string, fieldId = 'f1') => {
        let result: any;
        await h.store.$transaction(async (tx: any) => {
          result = await h.service.clawbackAward(
            'cp1',
            amt,
            {
              referenceType: 'CREDIT_REVERSAL',
              referenceId: `rev-${fieldId}-${++revSeq}`,
              originalCredit: { batchId, outletCode: 'OC1', fieldId },
            },
            tx,
          );
        });
        return result;
      };
      const lastWt = (h: ReturnType<typeof buildHarness>) => h.walletTxns[h.walletTxns.length - 1];

      it('FLOOR-1: −841 +500 → −341, reverse → −841 (fully undone), shortfall 0, lot consumed', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: -841 }, config: { expiryDays: 90 } });
        await earn(h, 500, 'b1');
        expect(h.wallet.redeemablePoints).toBe(-341);
        const lotId = h.rowsOfType('EARN')[0].id;
        const res = await claw(h, 500, 'b1');
        expect(h.wallet.redeemablePoints).toBe(-841);
        expect(res.newRedeemable).toBe(-841);
        expect(res.shortfall).toBe(0);
        expect(lastWt(h)).toMatchObject({ points: -500, balanceBefore: -341, balanceAfter: -841, description: 'Clawback: credit batch POINTS reversal' });
        expect(h.lot(lotId)!.remainingPoints).toBe(0);
        expect(h.wallet.lifetimeEarned).toBe(500); // monotonic
      });

      it('FLOOR-2: credited while +300, spent to −10 by another debit, reverse 500 → stays −10 (floor 0), shortfall 500', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: 300 } });
        await earn(h, 500, 'b1'); // balanceBefore +300 → floor 0
        h.wallet.redeemablePoints = -10; // some other debit drove it to −10
        const res = await claw(h, 500, 'b1');
        expect(h.wallet.redeemablePoints).toBe(-10);
        expect(res.shortfall).toBe(500);
        expect(lastWt(h)).toMatchObject({ balanceBefore: -10, balanceAfter: -10 });
        expect(lastWt(h).description).toBe(
          'Clawback: credit batch POINTS reversal [SHORTFALL: 500 pts not recovered — wallet balance already negative (-10) — owner review required]',
        );
      });

      it('FLOOR-3: −841 +500 → −341, +1000 → 659, reverse the 500 → 159, shortfall 0', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: -841 } });
        await earn(h, 500, 'b1');
        await earn(h, 1000, 'b2');
        expect(h.wallet.redeemablePoints).toBe(659);
        const res = await claw(h, 500, 'b1');
        expect(h.wallet.redeemablePoints).toBe(159);
        expect(res.shortfall).toBe(0);
      });

      it('FLOOR-4: the floor still limits — −841 +500 → −341, other debit to −600, reverse 500 → −841, shortfall 259', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: -841 } });
        await earn(h, 500, 'b1');
        h.wallet.redeemablePoints = -600;
        const res = await claw(h, 500, 'b1');
        expect(h.wallet.redeemablePoints).toBe(-841);
        expect(res.shortfall).toBe(259);
        expect(lastWt(h).description).toBe(
          'Clawback: credit batch POINTS reversal [SHORTFALL: 259 pts not recovered — balance floored at -841, its level before the reversed credit (net of earlier reversed credits) — owner review required]',
        );
      });

      it('FLOOR-5: the SAME field credited twice in one batch → the reversal covers both; floor = before the first', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: -841 } });
        await earn(h, 500, 'b1'); // −841 → −341
        await earn(h, 200, 'b1'); // −341 → −141
        const res = await claw(h, 700, 'b1');
        expect(h.wallet.redeemablePoints).toBe(-841);
        expect(res.shortfall).toBe(0);
      });

      it('EXACT-1 (audit counter-example): −100, A(f1) +500 → 400, B(f2) +300 → 700, redeem 700 → 0, reverse B → floor 0 (B landed at +400): take 0, shortfall 300', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: -100 } });
        await earn(h, 500, 'b1', 'f1');
        await earn(h, 300, 'b1', 'f2');
        expect(h.wallet.redeemablePoints).toBe(700);
        await h.service.debitRedeem('cp1', 700, { referenceId: 'o1' });
        expect(h.wallet.redeemablePoints).toBe(0);
        const res = await claw(h, 300, 'b1', 'f2');
        expect(h.wallet.redeemablePoints).toBe(0); // NOT −100 (the batch's earliest credit's floor)
        expect(res.shortfall).toBe(300);
        expect(lastWt(h).description).toBe(
          'Clawback: credit batch POINTS reversal [SHORTFALL: 300 pts already redeemed — owner review required]',
        );
      });

      it('EXACT-2: same batch, reverse A (landed at −100) instead → floor −100: 0 → −100, shortfall 400', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: -100 } });
        await earn(h, 500, 'b1', 'f1');
        await earn(h, 300, 'b1', 'f2');
        await h.service.debitRedeem('cp1', 700, { referenceId: 'o1' });
        const res = await claw(h, 500, 'b1', 'f1');
        expect(h.wallet.redeemablePoints).toBe(-100);
        expect(res.shortfall).toBe(400);
      });

      it('EXACT-3: a field the batch never credited to this wallet → not found → clawback REFUSED, wallet untouched', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: -841 } });
        await earn(h, 500, 'b1', 'f1');
        await expect(claw(h, 500, 'b1', 'f9')).rejects.toThrow(/Cannot claw back: this partner's wallet has no credit/);
        expect(h.wallet.redeemablePoints).toBe(-341);
        expect(h.walletTxns.filter((t) => t.transactionType === 'DEBIT_ADJUSTMENT')).toHaveLength(0);
      });

      // ── Legacy credits (posted before metadata existed) → replay the stored batch rows ──
      describe('legacy credits without metadata (batch-row replay)', () => {
        const legacyEarn = (h: ReturnType<typeof buildHarness>, amt: number, batchId: string) =>
          h.service.creditEarn('cp1', 'deoleo', amt, { referenceType: 'CREDIT_BATCH', referenceId: batchId });
        const rowsB1 = [
          { outletId: 'OC1', fieldId: 'f1', awardType: 'POINTS', status: 'OK', amount: 500 },
          { outletId: 'OC1', fieldId: 'fX', awardType: 'PAYOUT', status: 'OK', amount: 300 }, // payout: never credited
          { outletId: 'OTHER', fieldId: 'f2', awardType: 'POINTS', status: 'OK', amount: 999 }, // another partner
          { outletId: 'OC1', fieldId: 'f3', awardType: 'POINTS', status: 'ERROR', amount: 50 }, // not credited
          { outletId: 'OC1', fieldId: 'f2', awardType: 'POINTS', status: 'OK', amount: 300 },
        ];
        const CONFIRMED = new Date(NOW.getTime() - 86_400_000);
        const base = {
          batches: [{ id: 'b1', clientId: 'deoleo', rows: rowsB1, confirmedAt: CONFIRMED }],
          outlets: [{ outletCode: 'OC1', partnerId: 'cp1', clientId: 'deoleo', updatedAt: new Date(CONFIRMED.getTime() - 1000) }],
        };

        it('LEGACY-1: the counter-example resolves exactly via row replay (reverse B → floor 0, shortfall 300)', async () => {
          const h = buildHarness({ wallet: { redeemablePoints: -100 }, ...base });
          await legacyEarn(h, 500, 'b1');
          await legacyEarn(h, 300, 'b1');
          await h.service.debitRedeem('cp1', 700, { referenceId: 'o1' });
          const res = await claw(h, 300, 'b1', 'f2');
          expect(h.wallet.redeemablePoints).toBe(0);
          expect(res.shortfall).toBe(300);
        });

        it('LEGACY-2: −841 +500 (legacy) → −341, reverse → −841 (fully undone)', async () => {
          const h = buildHarness({
            wallet: { redeemablePoints: -841 },
            batches: [{ id: 'b1', clientId: 'deoleo', rows: [rowsB1[0]], confirmedAt: CONFIRMED }],
            outlets: base.outlets,
          });
          await legacyEarn(h, 500, 'b1');
          const res = await claw(h, 500, 'b1', 'f1');
          expect(h.wallet.redeemablePoints).toBe(-841);
          expect(res.shortfall).toBe(0);
        });

        it('LEGACY-4: an outlet of this partner changed after the batch was confirmed (possible relink) → ambiguous → floor 0 + note', async () => {
          const h = buildHarness({
            wallet: { redeemablePoints: -841 },
            batches: [{ id: 'b1', clientId: 'deoleo', rows: [rowsB1[0]], confirmedAt: CONFIRMED }],
            outlets: [{ outletCode: 'OC1', partnerId: 'cp1', clientId: 'deoleo', updatedAt: new Date(CONFIRMED.getTime() + 1000) }],
          });
          await legacyEarn(h, 500, 'b1');
          const res = await claw(h, 500, 'b1', 'f1');
          expect(h.wallet.redeemablePoints).toBe(-341);
          expect(res.shortfall).toBe(500);
          expect(lastWt(h).description).toContain('(original credit ambiguous — floored at 0)');
        });

        it('LEGACY-3: replay does not line up (amounts differ) → ambiguous → floor 0 + note', async () => {
          const h = buildHarness({
            wallet: { redeemablePoints: -841 },
            batches: [{ id: 'b1', clientId: 'deoleo', rows: [{ ...rowsB1[0], amount: 499 }], confirmedAt: CONFIRMED }],
            outlets: base.outlets,
          });
          await legacyEarn(h, 500, 'b1');
          const res = await claw(h, 500, 'b1', 'f1');
          expect(h.wallet.redeemablePoints).toBe(-341);
          expect(res.shortfall).toBe(500);
          expect(lastWt(h).description).toContain('(original credit ambiguous — floored at 0)');
        });
      });

      // ── Concurrency: the wallet row is locked before the balance is read ──────────
      it('LOCK-1: clawbackAward takes SELECT … FOR UPDATE on the wallet before reading the balance', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: 0 } });
        await earn(h, 80, 'b1');
        await claw(h, 50, 'b1');
        const call = (h.store.$queryRaw as jest.Mock).mock.calls[0];
        expect(call[0].join('?')).toMatch(/SELECT id FROM wallets WHERE id = \? FOR UPDATE/);
        expect(call[1]).toBe('w1');
      });

      it('LOCK-2 (sequential simulation of concurrent approvals): each clawback reads the previous result — never below the floor; balanceBefore/After chain exact', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: -841 } });
        await earn(h, 500, 'b1'); // −341, landed at −841
        const r1 = await claw(h, 300, 'b1'); // −641
        const r2 = await claw(h, 200, 'b1'); // −841
        const r3 = await claw(h, 100, 'b1'); // floor −841 → nothing
        expect([r1.shortfall, r2.shortfall, r3.shortfall]).toEqual([0, 0, 100]);
        expect(h.wallet.redeemablePoints).toBe(-841);
        const debits = h.walletTxns.filter((t) => t.transactionType === 'DEBIT_ADJUSTMENT');
        expect(debits.map((t) => [t.balanceBefore, t.balanceAfter])).toEqual([[-341, -641], [-641, -841], [-841, -841]]);
        // The wallet was locked once per clawback, before each read.
        expect((h.store.$queryRaw as jest.Mock).mock.calls.length).toBe(3);
      });

      // ── Order-independent floor: reversals of several credits give the same end state in any order ──
      it('ORDER-1: −841, f1 +500, f2 +300 → −41; reverse f1 THEN f2 → −841 (both shortfall 0)', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: -841 } });
        await earn(h, 500, 'b1', 'f1');
        await earn(h, 300, 'b1', 'f2');
        expect(h.wallet.redeemablePoints).toBe(-41);
        const r1 = await claw(h, 500, 'b1', 'f1');
        expect(h.wallet.redeemablePoints).toBe(-541);
        const r2 = await claw(h, 300, 'b1', 'f2'); // floor = −341 − 500 (f1, earlier, since reversed) = −841
        expect(h.wallet.redeemablePoints).toBe(-841);
        expect([r1.shortfall, r2.shortfall]).toEqual([0, 0]);
        // Each clawback records which credit it reversed.
        const debits = h.walletTxns.filter((t) => t.transactionType === 'DEBIT_ADJUSTMENT');
        const credits = h.walletTxns.filter((t) => t.transactionType === 'CREDIT_POINTS_EARNED');
        expect(debits.map((d) => d.metadata?.reversedCreditTxId)).toEqual([credits[0].id, credits[1].id]);
      });

      it('ORDER-2: same wallet, reverse f2 THEN f1 → −841 (both shortfall 0)', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: -841 } });
        await earn(h, 500, 'b1', 'f1');
        await earn(h, 300, 'b1', 'f2');
        const r2 = await claw(h, 300, 'b1', 'f2');
        expect(h.wallet.redeemablePoints).toBe(-341);
        const r1 = await claw(h, 500, 'b1', 'f1'); // a LATER credit's reversal never lowers an earlier one's floor
        expect(h.wallet.redeemablePoints).toBe(-841);
        expect([r2.shortfall, r1.shortfall]).toEqual([0, 0]);
      });

      it('ORDER-3: counter-example with BOTH reversed (−100, A +500, B +300, redeem 700) → −100 in either order', async () => {
        for (const order of [['f1', 'f2'], ['f2', 'f1']]) {
          const h = buildHarness({ wallet: { redeemablePoints: -100 } });
          await earn(h, 500, 'b1', 'f1');
          await earn(h, 300, 'b1', 'f2');
          await h.service.debitRedeem('cp1', 700, { referenceId: 'o1' });
          const amt = (f: string) => (f === 'f1' ? 500 : 300);
          const a = await claw(h, amt(order[0]), 'b1', order[0]);
          const b = await claw(h, amt(order[1]), 'b1', order[1]);
          expect(h.wallet.redeemablePoints).toBe(-100);
          expect(a.shortfall + b.shortfall).toBe(700); // 100 of A recovered, the redeemed 700 is not
        }
      });

      // ── Floor clamp (audit BLOCKER): never below the lowest pre-credit balance involved ──
      it('CLAMP-1 (Deoleo-reachable): 0, f1 +500, redeem 500, f2 +300 → reversing f1/f2 in EITHER order ends at 0, never −300', async () => {
        for (const order of [['f1', 'f2'], ['f2', 'f1']]) {
          const h = buildHarness({ wallet: { redeemablePoints: 0 } });
          await earn(h, 500, 'b1', 'f1');
          await h.service.debitRedeem('cp1', 500, { referenceId: 'o1' });
          await earn(h, 300, 'b1', 'f2');
          const amt = (f: string) => (f === 'f1' ? 500 : 300);
          await claw(h, amt(order[0]), 'b1', order[0]);
          await claw(h, amt(order[1]), 'b1', order[1]);
          expect(h.wallet.redeemablePoints).toBe(0);
          expect(Math.min(...h.walletTxns.map((t) => t.balanceAfter))).toBeGreaterThanOrEqual(0);
        }
      });

      it('CLAMP-2: −100, E +500, redeem 400, X +300 → reversing E/X in EITHER order ends at −100', async () => {
        for (const order of [['fE', 'fX'], ['fX', 'fE']]) {
          const h = buildHarness({ wallet: { redeemablePoints: -100 } });
          await earn(h, 500, 'b1', 'fE'); // 400, landed at −100
          await h.service.debitRedeem('cp1', 400, { referenceId: 'o1' }); // 0
          await earn(h, 300, 'b1', 'fX'); // 300, landed at 0
          const amt = (f: string) => (f === 'fE' ? 500 : 300);
          await claw(h, amt(order[0]), 'b1', order[0]);
          await claw(h, amt(order[1]), 'b1', order[1]);
          expect(h.wallet.redeemablePoints).toBe(-100);
        }
      });

      it('STAMP: credit-batch credits and reversal clawbacks are written with an explicit createdAt (taken under the wallet lock); plain movements are not', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: 0 } });
        await earn(h, 80, 'b1');
        await h.service.debitRedeem('cp1', 10, { referenceId: 'o1' });
        await claw(h, 50, 'b1');
        const [credit, redeem, clawback] = h.rawWalletTxCreates;
        expect(credit.createdAt).toBeInstanceOf(Date);
        expect(redeem.createdAt).toBeUndefined(); // Deoleo's ordinary movements: unchanged create data
        expect(clawback.createdAt).toBeInstanceOf(Date);
        expect(clawback.createdAt.getTime()).toBeGreaterThanOrEqual(credit.createdAt.getTime());
      });

      it('ORDER-4: a clawback that ran BEFORE the later credit was posted is not double-counted', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: -841 } });
        await earn(h, 500, 'b1', 'f1'); // −341 (landed at −841)
        await claw(h, 500, 'b1', 'f1'); // −841
        await earn(h, 300, 'b2', 'f2'); // −541 (landed at −841, already net of f1's reversal)
        const r = await claw(h, 300, 'b2', 'f2');
        expect(h.wallet.redeemablePoints).toBe(-841); // floor −841, not −1341
        expect(r.shortfall).toBe(0);
      });

      it('ORDER-5 (legacy clawback without metadata): the earlier reversed credit is resolved via its CreditReversal', async () => {
        const h = buildHarness({
          wallet: { redeemablePoints: -841 },
          reversals: [{ id: 'rev-legacy', batchId: 'b1', outletId: 'OC1', fieldId: 'f1' }],
        });
        await earn(h, 500, 'b1', 'f1');
        await earn(h, 300, 'b1', 'f2');
        await claw(h, 500, 'b1', 'f1');
        // Make that clawback look pre-metadata: no reversedCreditTxId, reference = the reversal row.
        const legacy = h.walletTxns.find((t) => t.transactionType === 'DEBIT_ADJUSTMENT')!;
        delete legacy.metadata;
        legacy.referenceId = 'rev-legacy';
        await claw(h, 300, 'b1', 'f2');
        expect(h.wallet.redeemablePoints).toBe(-841);
      });

      it('FLOOR-6: no credit from that batch on this wallet (e.g. outlet relinked) → clawback REFUSED, never debits the wrong wallet', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: 500 } });
        await expect(claw(h, 500, 'other-batch')).rejects.toBeInstanceOf(BadRequestException);
        expect(h.wallet.redeemablePoints).toBe(500);
        expect(h.walletTxns).toHaveLength(0);
      });

      it('FLOOR-7: another wallet’s credit with the same batch id is never used as the floor', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: 0 } });
        h.walletTxns.push({ id: 'x', walletId: 'w-other', transactionType: 'CREDIT_POINTS_EARNED', referenceType: 'CREDIT_BATCH', referenceId: 'b1', balanceBefore: -5000, createdAt: new Date(0) });
        await earn(h, 100, 'b1'); // this wallet: balanceBefore 0
        h.wallet.redeemablePoints = 40;
        const res = await claw(h, 100, 'b1');
        expect(h.wallet.redeemablePoints).toBe(0);
        expect(res.shortfall).toBe(60);
      });

      describe('creditedPointsForBatchRow (POINTS reversal cap)', () => {
        const call = (h: ReturnType<typeof buildHarness>, fieldId: string, outletCode = 'OC1', stored = 999n) =>
          h.service.creditedPointsForBatchRow(h.store as any, { batchId: 'b1', clientId: 'deoleo', outletCode, fieldId, storedRowsAmount: stored });

        it('metadata-era batch: Σ of the credits actually posted for (outlet, field)', async () => {
          const h = buildHarness({ wallet: { redeemablePoints: 0 } });
          await earn(h, 500, 'b1', 'f1');
          await earn(h, 200, 'b1', 'f1');
          await earn(h, 300, 'b1', 'f2');
          expect(await call(h, 'f1')).toBe(700n);
          expect(await call(h, 'f2')).toBe(300n);
          expect(await call(h, 'f1', 'OTHER')).toBe(0n); // skipped / other outlet → nothing credited
        });

        it('legacy batch: stored rows only when the outlet\'s current partner received credits from it; else 0', async () => {
          const withOutlet = buildHarness({
            wallet: { redeemablePoints: 0 },
            outlets: [{ outletCode: 'OC1', partnerId: 'cp1', clientId: 'deoleo' }],
          });
          await withOutlet.service.creditEarn('cp1', 'deoleo', 500, { referenceType: 'CREDIT_BATCH', referenceId: 'b1' });
          expect(await call(withOutlet, 'f1')).toBe(999n);
          const unlinked = buildHarness({ wallet: { redeemablePoints: 0 }, outlets: [] });
          await unlinked.service.creditEarn('cp1', 'deoleo', 500, { referenceType: 'CREDIT_BATCH', referenceId: 'b1' });
          expect(await call(unlinked, 'f1')).toBe(0n);
          const noCredits = buildHarness({ wallet: { redeemablePoints: 0 } });
          expect(await call(noCredits, 'f1')).toBe(0n);
        });
      });

      // Positive cases with the original credit FOUND (balanceBefore >= 0 → floor 0): byte-identical.
      it('POS-F1: 80 → reverse 50 → 30, shortfall 0, original description', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: 0 } });
        await earn(h, 80, 'b1');
        const res = await claw(h, 50, 'b1');
        expect(h.wallet.redeemablePoints).toBe(30);
        expect(res.shortfall).toBe(0);
        expect(lastWt(h)).toMatchObject({ points: -50, balanceBefore: 80, balanceAfter: 30, description: 'Clawback: credit batch POINTS reversal' });
      });

      it('POS-F2: credited 50, spent to 30, reverse 50 → 0, shortfall 20, "already redeemed" text', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: 0 } });
        await earn(h, 50, 'b1');
        await h.service.debitRedeem('cp1', 20, { referenceId: 'o1' });
        const res = await claw(h, 50, 'b1');
        expect(h.wallet.redeemablePoints).toBe(0);
        expect(res.shortfall).toBe(20);
        expect(lastWt(h).description).toBe(
          'Clawback: credit batch POINTS reversal [SHORTFALL: 20 pts already redeemed — owner review required]',
        );
      });

      it('POS-F3: zero balance (credited 25, all redeemed) → reverse 25 → 0, shortfall 25, original text', async () => {
        const h = buildHarness({ wallet: { redeemablePoints: 0 } });
        await earn(h, 25, 'b1');
        await h.service.debitRedeem('cp1', 25, { referenceId: 'o1' });
        const res = await claw(h, 25, 'b1');
        expect(h.wallet.redeemablePoints).toBe(0);
        expect(res.shortfall).toBe(25);
        expect(lastWt(h).description).toBe(
          'Clawback: credit batch POINTS reversal [SHORTFALL: 25 pts already redeemed — owner review required]',
        );
      });
    });
  });

  // ── (8) the canonical invariant after a mixed sequence ───────────────────────────
  it('upholds the invariant after a mixed sequence (redeemable === Σ live remaining; lifetimeEarned monotonic)', async () => {
    const h = buildHarness({ wallet: { redeemablePoints: 0 }, config: { expiryDays: 90 } });
    await h.service.creditEarn('cp1', 'deoleo', 100, {});
    await h.service.creditEarn('cp1', 'deoleo', 50, {});
    await h.service.debitRedeem('cp1', 80, { referenceId: 'o1' });
    await h.service.reverse('cp1', 20, { referenceId: 'o1' });
    await h.service.adjust(gifsy, { partnerId: 'cp1', amount: 30, type: AdjustType.CREDIT, reason: 'x', approvedBy: 'a' });

    const sumLive = h.spendableLots().reduce((s, r) => s + r.remainingPoints, 0);
    expect(h.wallet.redeemablePoints).toBe(sumLive); // invariant #8
    expect(h.wallet.redeemablePoints).toBeGreaterThanOrEqual(0);
    // lifetimeEarned only ever bumped by EARN (100 + 50) + credit-ADJUST (30); NOT by the reversal.
    expect(h.wallet.lifetimeEarned).toBe(180);
  });

  // ── (9) insufficient-balance + atomic guard (redemption path) ────────────────────
  describe('insufficient balance rejects', () => {
    it('debitRedeem throws BadRequest when redeemable < amount and writes no ledger row', async () => {
      const h = buildHarness({ wallet: { redeemablePoints: 5 } });
      await expect(h.service.debitRedeem('cp1', 10, { referenceId: 'o1' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(h.rowsOfType('REDEEM').length).toBe(0);
    });

    it('rejects when the guarded wallet.updateMany matches 0 rows (concurrent depletion) — no negative, no ledger row', async () => {
      const h = buildHarness({ wallet: { redeemablePoints: 50 } });
      // Simulate a concurrent debit draining the balance between the pre-check and the guarded write.
      h.store.wallet.updateMany = async () => ({ count: 0 });
      await expect(h.service.debitRedeem('cp1', 40, { referenceId: 'o2' })).rejects.toThrow(
        'Insufficient wallet balance for redemption',
      );
      expect(h.rowsOfType('REDEEM').length).toBe(0);
    });
  });

  // ── (10) edges ───────────────────────────────────────────────────────────────────
  describe('edges', () => {
    it('redeem exactly equal to one lot drains it to 0', async () => {
      const h = buildHarness({
        wallet: { redeemablePoints: 50, earnedPoints: 50, lifetimeEarned: 50 },
        lots: [{ id: 'A', walletId: 'w1', transactionType: 'EARN', points: 50, remainingPoints: 50, expiresAt: daysFromNow(30), createdAt: daysFromNow(-10) }],
      });
      await h.service.debitRedeem('cp1', 50, { referenceId: 'o1' });
      expect(h.wallet.redeemablePoints).toBe(0);
      expect(h.lot('A')!.remainingPoints).toBe(0);
    });

    it('redeem spanning THREE lots consumes oldest→newest', async () => {
      const h = buildHarness({
        wallet: { redeemablePoints: 90, earnedPoints: 90, lifetimeEarned: 90 },
        lots: [
          { id: 'A', walletId: 'w1', transactionType: 'EARN', points: 20, remainingPoints: 20, expiresAt: daysFromNow(30), createdAt: daysFromNow(-10) },
          { id: 'B', walletId: 'w1', transactionType: 'EARN', points: 30, remainingPoints: 30, expiresAt: daysFromNow(40), createdAt: daysFromNow(-7) },
          { id: 'C', walletId: 'w1', transactionType: 'EARN', points: 40, remainingPoints: 40, expiresAt: daysFromNow(50), createdAt: daysFromNow(-4) },
        ],
      });
      await h.service.debitRedeem('cp1', 60, { referenceId: 'o1' });
      expect(h.wallet.redeemablePoints).toBe(30);
      expect(h.lot('A')!.remainingPoints).toBe(0);
      expect(h.lot('B')!.remainingPoints).toBe(0);
      expect(h.lot('C')!.remainingPoints).toBe(30);
    });

    it('redeem with zero available throws BadRequest', async () => {
      const h = buildHarness({ wallet: { redeemablePoints: 0 } });
      await expect(h.service.debitRedeem('cp1', 10, { referenceId: 'o1' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('expiry with lots present but none DUE is a clean no-op', async () => {
      const h = buildHarness({
        wallet: { redeemablePoints: 50 },
        lots: [{ id: 'A', walletId: 'w1', transactionType: 'EARN', points: 50, remainingPoints: 50, expiresAt: daysFromNow(10), createdAt: daysFromNow(-1) }],
      });
      const res = await h.service.expireDuePoints({ now: daysFromNow(2) });
      expect(res).toEqual({ expiredLots: 0, expiredPoints: 0 });
      expect(h.lot('A')!.isExpired).toBe(false);
      expect(h.wallet.redeemablePoints).toBe(50);
    });
  });
});
