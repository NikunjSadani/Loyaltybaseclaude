// Unit tests for RewardsService — mirrors the S4 tickets/wallet templates.
// Covers tenant scoping, per-item affordability, order ownership checks, and the
// GIFSY-only order update ported from the Next routes.
// Run: npx jest src/rewards/rewards.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { RewardsService } from './rewards.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { UpdatableOrderStatus } from './dto/rewards.dto';

const mockPrisma = {
  channelPartner: { findFirst: jest.fn() },
  wallet: { findFirst: jest.fn() },
  otpCode: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
  rewardCategory: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  rewardCatalog: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  redemptionOrder: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  redemptionStatusHistory: { create: jest.fn() },
  // $transaction runs the callback against a tx client that proxies the same mocks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: jest.fn((fn: (tx: any) => unknown) => fn(mockPrisma)),
};

const mockWallet = {
  debitRedeem: jest.fn(),
  reverse: jest.fn(),
};

const mockNotifications = {
  enqueue: jest.fn().mockResolvedValue({ id: 'n1' }),
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '9990001111', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '9991112222', name: '' };

describe('RewardsService', () => {
  let service: RewardsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWallet },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    service = module.get(RewardsService);
    // Default: atomic claims (PENDING→CONFIRMED, refund pointsDeducted>0→0, stock
    // decrement) win. Individual tests override to simulate a lost race.
    mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.rewardCatalog.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
  });

  describe('listCatalog', () => {
    it('scopes by clientId/status and flags affordability against the wallet balance', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100 });
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([
        { id: 'r1', pointsCost: 50 },
        { id: 'r2', pointsCost: 150 },
      ]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(2);

      const res = await service.listCatalog(partner, { minPoints: 10, maxPoints: 200 });

      expect(mockPrisma.rewardCatalog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'ACTIVE',
            deletedAt: null,
            clientId: 'deoleo',
            pointsCost: { gte: 10, lte: 200 },
          },
        }),
      );
      expect(res.userBalance).toBe(100);
      expect(res.items[0].isAffordable).toBe(true);
      expect(res.items[1].isAffordable).toBe(false);
      expect(res.pagination).toEqual({ page: 1, limit: 20, total: 2, pages: 1 });
    });

    it('defaults the balance to 0 when the caller has no partner/wallet', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([{ id: 'r1', pointsCost: 50 }]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(1);

      const res = await service.listCatalog(partner, {});
      expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
      expect(res.userBalance).toBe(0);
      expect(res.items[0].isAffordable).toBe(false);
    });
  });

  describe('getCatalogItem', () => {
    it('throws NotFound for an item outside the tenant', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      await expect(service.getCatalogItem(partner, 'r9')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.rewardCatalog.findFirst).toHaveBeenCalledWith({
        where: { id: 'r9', deletedAt: null, clientId: 'deoleo' },
      });
    });

    it('returns the item when found', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'r1' });
      const res = await service.getCatalogItem(partner, 'r1');
      expect(res).toEqual({ item: { id: 'r1' } });
    });
  });

  describe('listOrders', () => {
    it('scopes a non-admin to their own partner orders', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);

      await service.listOrders(partner, {});
      expect(mockPrisma.redemptionOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { partner: { user: { clientId: 'deoleo' } }, partnerId: 'cp1' },
        }),
      );
    });

    it('falls back to a sentinel partnerId when the non-admin has no partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);

      await service.listOrders(partner, {});
      expect(mockPrisma.redemptionOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { partner: { user: { clientId: 'deoleo' } }, partnerId: 'none' },
        }),
      );
    });

    it('lets a GIFSY admin see all tenant orders (no partner filter)', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);

      await service.listOrders(gifsy, { status: undefined });
      expect(mockPrisma.channelPartner.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { partner: { user: { clientId: 'deoleo' } } },
        }),
      );
    });
  });

  describe('getOrder', () => {
    it('throws NotFound for an order outside the tenant', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
      await expect(service.getOrder(partner, 'o9')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('forbids a non-admin from viewing another user’s order', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1',
        partner: { userId: 'someoneElse' },
      });
      await expect(service.getOrder(partner, 'o1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns the order for its owner', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1',
        partner: { userId: 'user1' },
      });
      const res = await service.getOrder(partner, 'o1');
      expect(res.order.id).toBe('o1');
    });
  });

  describe('updateOrder', () => {
    it('throws NotFound when the order is outside the tenant', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
      await expect(
        service.updateOrder(gifsy, 'o9', { trackingNumber: 'TN1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.redemptionOrder.findFirst).toHaveBeenCalledWith({
        where: { id: 'o9', partner: { user: { clientId: 'deoleo' } } },
      });
    });

    it('updates tracking/voucher/notes (NON-status) within the tenant', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1' });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', trackingNumber: 'TN1' });
      const res = await service.updateOrder(gifsy, 'o1', {
        trackingNumber: 'TN1',
        voucherCode: 'GC-XYZ',
      });
      expect(mockPrisma.redemptionOrder.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: {
          trackingNumber: 'TN1',
          trackingUrl: undefined,
          voucherCode: 'GC-XYZ',
          voucherProvider: undefined,
          notes: undefined,
        },
      });
      expect(res).toEqual({ order: { id: 'o1', trackingNumber: 'TN1' } });
    });
  });

  // ─── P5.4a CORE redemption pipeline ──────────────────────────────────────────

  describe('redeem', () => {
    const fixedItem = {
      id: 'r1', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null,
      pointsCost: 500, redemptionMode: 'GIFT_CARD',
      minRedemptionPoints: null, maxRedemptionPoints: null, stockQuantity: null,
    };

    it('rejects insufficient balance with 400 and creates NO order', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100 });

      await expect(service.redeem(partner, { rewardId: 'r1', quantity: 1 }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('rejects a FREE_AMOUNT amount outside [min,max] with 400', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        ...fixedItem, pointsCost: 0, minRedemptionPoints: 100, maxRedemptionPoints: 1000,
      });
      // amount 50 × rate 1 = 50 points < min 100 → 400 (before partner/wallet lookups).
      await expect(service.redeem(partner, { rewardId: 'r1', amount: 50 }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('happy path: creates a PENDING order, clears prior OTPs, stores a new OTP', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'RDM-x' });
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });

      const res = await service.redeem(partner, { rewardId: 'r1', quantity: 2 });

      const created = mockPrisma.redemptionOrder.create.mock.calls?.[0]?.[0];
      expect(created.data.status).toBe('PENDING');
      expect(created.data.totalPointsCost).toBe(1000); // 500 × 2
      expect(created.data.pointsDeducted).toBe(0);
      expect(created.data.partnerId).toBe('cp1');
      // OTP lifecycle: clear prior unverified, then store a REDEMPTION_CONFIRM code.
      expect(mockPrisma.otpCode.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user1', purpose: 'REDEMPTION_CONFIRM', verifiedAt: null },
      });
      const otpCreate = mockPrisma.otpCode.create.mock.calls?.[0]?.[0];
      expect(otpCreate.data.purpose).toBe('REDEMPTION_CONFIRM');
      expect(otpCreate.data.userId).toBe('user1');
      expect(otpCreate.data.code).toMatch(/^\d{6}$/);
      expect(res.requiredPoints).toBe(1000);
      expect(res.orderId).toBe('o1');
    });

    it('requires a delivery address for PHYSICAL_GIFT', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ ...fixedItem, redemptionMode: 'PHYSICAL_GIFT' });
      await expect(service.redeem(partner, { rewardId: 'r1' }))
        .rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('confirmRedeem', () => {
    const pendingOrder = {
      id: 'o1', status: 'PENDING', partnerId: 'cp1', orderNumber: 'RDM-x',
      totalPointsCost: 1000, quantity: 1,
      partner: { id: 'cp1', userId: 'user1' },
      reward: { name: 'Amazon ₹500', stockQuantity: null },
    };

    it('bumps attempts and 401s on a wrong OTP', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });

      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '000000' }))
        .rejects.toBeInstanceOf(UnauthorizedException);
      expect(mockPrisma.otpCode.update).toHaveBeenCalledWith({
        where: { id: 'otp1' },
        data: { attempts: 1 },
      });
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('rejects a non-PENDING order with 400', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ ...pendingOrder, status: 'CONFIRMED' });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('forbids confirming another user’s order', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder, partner: { id: 'cp1', userId: 'someoneElse' },
      });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(ForbiddenException);
    });

    it('happy path: debits via WalletService(tx), sets CONFIRMED, writes history', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CONFIRMED' });

      const res = await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });

      // OTP marked verified.
      expect(mockPrisma.otpCode.update).toHaveBeenCalledWith({
        where: { id: 'otp1' }, data: { verifiedAt: expect.any(Date) },
      });
      // Debit goes through WalletService with the tx client + order ref.
      expect(mockWallet.debitRedeem).toHaveBeenCalledWith(
        'cp1', 1000,
        { referenceId: 'o1', description: 'Redemption RDM-x' },
        mockPrisma, // tx proxy
      );
      // The order flip is the atomic concurrency gate (guarded updateMany), not a
      // bare update — only a PENDING row is claimed → CONFIRMED.
      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'PENDING' },
        data: { status: 'CONFIRMED', pointsDeducted: 1000 },
      });
      const hist = mockPrisma.redemptionStatusHistory.create.mock.calls?.[0]?.[0];
      expect(hist.data).toMatchObject({ orderId: 'o1', fromStatus: 'PENDING', toStatus: 'CONFIRMED', changedById: 'user1' });
      expect(res.status).toBe('CONFIRMED');
    });

    it('a concurrent double-confirm is blocked (claim count 0 → no debit)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      // Another confirm already flipped the order → our PENDING claim matches 0 rows.
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(ConflictException);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });
  });

  describe('transitionOrder', () => {
    it('rejects an illegal edge (PENDING→DISPATCHED) with 400', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'PENDING', partnerId: 'cp1', orderNumber: 'RDM-x', pointsDeducted: 0,
      });
      await expect(
        service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.DISPATCHED }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
    });

    it('CONFIRMED→CANCELLED claims the refund atomically and reverses via WalletService', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'RDM-x', pointsDeducted: 1000,
      });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CANCELLED' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'user1', phone: '9991112222' });

      await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED });

      // Refund is gated by an atomic pointsDeducted>0→0 claim (one winner only).
      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', pointsDeducted: { gt: 0 } },
        data: { pointsDeducted: 0 },
      });
      expect(mockWallet.reverse).toHaveBeenCalledWith(
        'cp1', 1000,
        { referenceId: 'o1', description: 'Refund RDM-x' },
        mockPrisma,
      );
      const upd = mockPrisma.redemptionOrder.update.mock.calls?.[0]?.[0];
      expect(upd.data.cancelledAt).toBeInstanceOf(Date);
    });

    it('does NOT double-refund when the atomic refund claim is lost (count 0)', async () => {
      // A concurrent refund-transition already zeroed pointsDeducted → claim matches 0 rows.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'RDM-x', pointsDeducted: 1000,
      });
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 0 }); // lost the claim
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CANCELLED' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'user1', phone: '9991112222' });

      await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED });
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('PROCESSING→DISPATCHED stamps dispatchedAt and writes history', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'PROCESSING', partnerId: 'cp1', orderNumber: 'RDM-x', pointsDeducted: 1000,
      });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'DISPATCHED' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'user1', phone: '9991112222' });

      await service.transitionOrder(gifsy, 'o1', {
        toStatus: UpdatableOrderStatus.DISPATCHED, trackingNumber: 'TN9',
      });

      const upd = mockPrisma.redemptionOrder.update.mock.calls?.[0]?.[0];
      expect(upd.data.dispatchedAt).toBeInstanceOf(Date);
      expect(upd.data.trackingNumber).toBe('TN9');
      expect(mockWallet.reverse).not.toHaveBeenCalled(); // forward move, no refund
      const hist = mockPrisma.redemptionStatusHistory.create.mock.calls?.[0]?.[0];
      expect(hist.data).toMatchObject({ orderId: 'o1', fromStatus: 'PROCESSING', toStatus: 'DISPATCHED' });
    });

    it('scopes the order load by clientId (tenant)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
      await expect(
        service.transitionOrder(gifsy, 'o9', { toStatus: UpdatableOrderStatus.PROCESSING }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.redemptionOrder.findFirst).toHaveBeenCalledWith({
        where: { id: 'o9', partner: { user: { clientId: 'deoleo' } } },
      });
    });
  });

  // ─── P5.3 Admin Catalog CRUD ─────────────────────────────────────────────────

  describe('createCategory', () => {
    it('stamps clientId and creates a tenant-scoped category', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue(null); // no code clash
      mockPrisma.rewardCategory.create.mockResolvedValue({ id: 'c1' });

      const res = await service.createCategory(gifsy, { code: 'VOUCHERS', name: 'Vouchers' });

      const call = mockPrisma.rewardCategory.create.mock.calls?.[0]?.[0];
      expect(call.data.clientId).toBe('deoleo');
      expect(call.data.code).toBe('VOUCHERS');
      expect(call.data.isActive).toBe(true);
      expect(res).toEqual({ category: { id: 'c1' } });
    });

    it('rejects a duplicate code within the tenant', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'existing' });
      await expect(
        service.createCategory(gifsy, { code: 'VOUCHERS', name: 'Vouchers' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a parentId outside the tenant', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue(null); // parent lookup -> null
      await expect(
        service.createCategory(gifsy, { code: 'SUB', name: 'Sub', parentId: 'other-tenant-cat' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('listCategories', () => {
    it('lists ALL tenant categories incl. inactive (no isActive filter)', async () => {
      mockPrisma.rewardCategory.findMany.mockResolvedValue([{ id: 'c1' }]);
      const res = await service.listCategories(gifsy);
      const call = mockPrisma.rewardCategory.findMany.mock.calls?.[0]?.[0];
      expect(call.where).toEqual({ clientId: 'deoleo' });
      expect(res).toEqual({ categories: [{ id: 'c1' }] });
    });
  });

  describe('updateCategory', () => {
    it('throws NotFound for a category outside the tenant', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue(null);
      await expect(
        service.updateCategory(gifsy, 'c9', { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updates within the tenant', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'c1', code: 'OLD' });
      mockPrisma.rewardCategory.update.mockResolvedValue({ id: 'c1', name: 'New' });
      const res = await service.updateCategory(gifsy, 'c1', { name: 'New' });
      const call = mockPrisma.rewardCategory.update.mock.calls?.[0]?.[0];
      expect(call.where).toEqual({ id: 'c1' });
      expect(call.data.name).toBe('New');
      expect(res).toEqual({ category: { id: 'c1', name: 'New' } });
    });
  });

  describe('deleteCategory', () => {
    it('blocks deletion when the category has active catalog items', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'c1' });
      mockPrisma.rewardCatalog.count.mockResolvedValue(2);
      await expect(service.deleteCategory(gifsy, 'c1')).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.rewardCategory.update).not.toHaveBeenCalled();
    });

    it('soft-deletes (isActive=false) when empty', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'c1' });
      mockPrisma.rewardCatalog.count.mockResolvedValue(0);
      mockPrisma.rewardCategory.update.mockResolvedValue({ id: 'c1', isActive: false });
      await service.deleteCategory(gifsy, 'c1');
      expect(mockPrisma.rewardCategory.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { isActive: false },
      });
    });
  });

  describe('createCatalogItem', () => {
    const base = {
      categoryId: 'c1',
      code: 'AMZ500',
      name: 'Amazon ₹500',
      pointsCost: 500,
      redemptionMode: 'GIFT_CARD' as const,
    };

    it('rejects a cross-tenant categoryId', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue(null); // category not in tenant
      await expect(service.createCatalogItem(gifsy, base)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockPrisma.rewardCatalog.create).not.toHaveBeenCalled();
    });

    it('rejects min > max', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'c1' });
      await expect(
        service.createCatalogItem(gifsy, {
          ...base,
          pointsCost: 0,
          minRedemptionPoints: 1000,
          maxRedemptionPoints: 500,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('forces OUT_OF_STOCK when stockQuantity is 0', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'c1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null); // no code clash
      mockPrisma.rewardCatalog.create.mockResolvedValue({ id: 'r1' });
      await service.createCatalogItem(gifsy, { ...base, status: 'ACTIVE', stockQuantity: 0 });
      const call = mockPrisma.rewardCatalog.create.mock.calls?.[0]?.[0];
      expect(call.data.status).toBe('OUT_OF_STOCK');
      expect(call.data.clientId).toBe('deoleo');
    });

    it('creates with defaults when valid (stamps clientId, default status ACTIVE)', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'c1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      mockPrisma.rewardCatalog.create.mockResolvedValue({ id: 'r1' });
      const res = await service.createCatalogItem(gifsy, base);
      const call = mockPrisma.rewardCatalog.create.mock.calls?.[0]?.[0];
      expect(call.data.status).toBe('ACTIVE');
      expect(res).toEqual({ item: { id: 'r1' } });
    });
  });

  describe('updateCatalogItem', () => {
    it('scopes the guard read by clientId + deletedAt (tenant + soft-delete)', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      await expect(
        service.updateCatalogItem(gifsy, 'r1', { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.rewardCatalog.findFirst).toHaveBeenCalledWith({
        where: { id: 'r1', clientId: 'deoleo', deletedAt: null },
      });
      expect(mockPrisma.rewardCatalog.update).not.toHaveBeenCalled();
    });

    it('cannot re-list a 0-stock item via a bare { status: ACTIVE } PATCH', async () => {
      // Stored item is out of stock; payload tries to re-activate without resending stock.
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', code: 'AMZ500', stockQuantity: 0,
        minRedemptionPoints: null, maxRedemptionPoints: null,
      });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'r1' });
      await service.updateCatalogItem(gifsy, 'r1', { status: 'ACTIVE' });
      const call = mockPrisma.rewardCatalog.update.mock.calls?.[0]?.[0];
      expect(call.data.status).toBe('OUT_OF_STOCK');
    });

    it('allows ACTIVE when effective stock is positive', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', code: 'AMZ500', stockQuantity: 5,
        minRedemptionPoints: null, maxRedemptionPoints: null,
      });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'r1' });
      await service.updateCatalogItem(gifsy, 'r1', { status: 'ACTIVE' });
      const call = mockPrisma.rewardCatalog.update.mock.calls?.[0]?.[0];
      expect(call.data.status).toBe('ACTIVE');
    });
  });

  describe('deleteCatalogItem', () => {
    it('throws NotFound for an item outside the tenant / already deleted', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      await expect(service.deleteCatalogItem(gifsy, 'r9')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('soft-deletes by setting deletedAt, dropping the item from the active read', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'r1' });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'r1', deletedAt: new Date() });
      await service.deleteCatalogItem(gifsy, 'r1');
      const call = mockPrisma.rewardCatalog.update.mock.calls?.[0]?.[0];
      expect(call.where).toEqual({ id: 'r1' });
      expect(call.data.deletedAt).toBeInstanceOf(Date);
    });
  });
});
