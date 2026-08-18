// Unit tests for WalletService — mirrors the S4 tickets template.
// Covers tenant scoping, the GIFSY-only adjust path + balance rules, the passbook
// pagination ported from the Next routes, and the P5 ledger-aware primitives
// (creditEarn / debitRedeem / reverse / expireDuePoints) + the canonical invariant.
// Run: npx jest src/wallet/wallet.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
  pointsLedger: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  pointExpiryConfig: { findFirst: jest.fn() },
  auditLog: { create: jest.fn() },
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

      it('outlet WITH partner → paginated passbook via the SHARED loadPassbook (row shape preserved)', async () => {
        // resolveAdminOutlet (outlet lookup) then loadPassbook (outlet lookup for outletCode).
        mockPrisma.outlet.findFirst
          .mockResolvedValueOnce({ outletCode: 'OUT-1', name: 'Shop One', ownerName: 'Alice', partnerId: 'cp1' })
          .mockResolvedValueOnce({ outletCode: 'OUT-1' });
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

        const res = await service.adminOutletTransactions(gifsy, 'OUT-1', {});

        expect(res.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
        // Identical passbook row shape as the partner-facing route (shared builder).
        expect(res.transactions[0]).toEqual({
          id: 't1',
          transactionType: 'CREDIT_POINTS_EARNED',
          description: 'Points earned',
          points: 10,
          date: new Date('2026-01-01'),
          balanceType: 'REDEEMABLE',
          balanceAfter: 10,
          referenceType: null,
          referenceId: null,
          fieldName: null,
          narration: null,
        });
        // The passbook wallet belongs to the outlet's partner.
        expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { partnerId: 'cp1' } });
      });
    });
  });
});
