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
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { RewardsService } from './rewards.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { AdminListCatalogQueryDto, UpdatableOrderStatus } from './dto/rewards.dto';
import { parseFulfilmentUploadBuffer } from './rewards-fulfilment.helpers';

const mockPrisma = {
  channelPartner: { findFirst: jest.fn() },
  salesUser: { findFirst: jest.fn() },
  salesUserAssignment: { findFirst: jest.fn() },
  outlet: { findMany: jest.fn() },
  auditLog: { create: jest.fn() },
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
  payoutTransaction: { create: jest.fn() },
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

// OTP is now sent synchronously via Msg91Service (A-2a) — default: succeeds.
const mockMsg91 = {
  sendOtp: jest.fn().mockResolvedValue(undefined),
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '9990001111', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '9991112222', name: '' };
const sales: JwtPayload = { sub: 'salesUser1', role: 'SALES_SO', clientId: 'deoleo', phone: '9993334444', name: '' };

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
        { provide: Msg91Service, useValue: mockMsg91 },
      ],
    }).compile();
    service = module.get(RewardsService);
    // Default: atomic claims (PENDING→CONFIRMED, refund pointsDeducted>0→0, stock
    // decrement) win. Individual tests override to simulate a lost race.
    mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.rewardCatalog.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit1' });
    mockPrisma.outlet.findMany.mockResolvedValue([]); // default: no extra outlet-keyed assignments
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

    it('A-2a: OTP send failure cancels the order, clears the OTP, and 503s', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'RDM-x' });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });
      mockMsg91.sendOtp.mockRejectedValueOnce(new Error('MSG91 unreachable'));

      await expect(service.redeem(partner, { rewardId: 'r1', quantity: 1 }))
        .rejects.toBeInstanceOf(ServiceUnavailableException);

      // No debit happens at redeem, so cleanup = cancel the just-created order + clear the unverified OTP.
      expect(mockPrisma.redemptionOrder.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
      });
      expect(mockPrisma.otpCode.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user1', purpose: 'REDEMPTION_CONFIRM', verifiedAt: null },
      });
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
        data: { status: 'CONFIRMED', pointsDeducted: 1000, valuePaise: 100000n },
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

  // ─── B1 / #50-E — Sales-assisted redemption (redeem on behalf of an outlet) ───

  describe('requireAssignedPartner (sales-on-behalf scoping)', () => {
    // Reach the private resolver via the public redeemForOutlet path; the catalog
    // item lookup succeeds first, so any throw here is the resolver's.
    const fixedItem = {
      id: 'r1', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null,
      pointsCost: 100, redemptionMode: 'GIFT_CARD',
      minRedemptionPoints: null, maxRedemptionPoints: null, stockQuantity: null,
    };

    it('forbids when the caller is not a SalesUser', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.salesUser.findFirst.mockResolvedValue(null);

      await expect(
        service.redeemForOutlet(sales, { rewardId: 'r1', targetPartnerId: 'cp-out' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('throws NotFound when the target outlet is outside the tenant', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null); // cross-tenant

      await expect(
        service.redeemForOutlet(sales, { rewardId: 'r1', targetPartnerId: 'cp-other-tenant' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Lookup is tenant-scoped.
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cp-other-tenant', clientId: 'deoleo', deletedAt: null },
        }),
      );
    });

    it('forbids when the caller has no active assignment to the outlet', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'cp-out', userId: 'outletUser1', user: { id: 'outletUser1', phone: '9000000000' },
      });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'out-1' }]);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue(null); // not assigned

      await expect(
        service.redeemForOutlet(sales, { rewardId: 'r1', targetPartnerId: 'cp-out' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Authorizes by partnerId OR the partner's outletIds (production assignments
      // key on outletId; seed/admin-reassign key on partnerId).
      const where = mockPrisma.salesUserAssignment.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ salesUserId: 'su1', unassignedAt: null });
      expect(where.OR).toEqual([
        { partnerId: 'cp-out' },
        { outletId: { in: ['out-1'] } },
      ]);
    });
  });

  describe('redeemForOutlet', () => {
    const fixedItem = {
      id: 'r1', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null,
      pointsCost: 500, redemptionMode: 'GIFT_CARD',
      minRedemptionPoints: null, maxRedemptionPoints: null, stockQuantity: null,
    };
    const outletPartner = {
      id: 'cp-out', userId: 'outletUser1', user: { id: 'outletUser1', phone: '9000000000' },
    };

    /** Wire a fully-assigned, well-funded outlet. */
    const wireAssigned = () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(outletPartner);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o-out', orderNumber: 'RDM-OUT' });
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });
    };

    it('creates the order against the TARGET outlet, binds the OTP to the OUTLET, supersedes the OUTLET', async () => {
      wireAssigned();

      const res = await service.redeemForOutlet(sales, {
        rewardId: 'r1', quantity: 2, targetPartnerId: 'cp-out',
      });

      // Order belongs to the OUTLET partner.
      const created = mockPrisma.redemptionOrder.create.mock.calls?.[0]?.[0];
      expect(created.data.partnerId).toBe('cp-out');
      expect(created.data.totalPointsCost).toBe(1000); // 500 × 2
      expect(created.data.pointsDeducted).toBe(0);

      // Supersede prior PENDING is scoped to the OUTLET, not the sales user.
      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { partnerId: 'cp-out', status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
      });
      // OTP delete + create are bound to the OUTLET's user, NOT the sales rep.
      expect(mockPrisma.otpCode.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'outletUser1', purpose: 'REDEMPTION_CONFIRM', verifiedAt: null },
      });
      const otpCreate = mockPrisma.otpCode.create.mock.calls?.[0]?.[0];
      expect(otpCreate.data.userId).toBe('outletUser1');
      expect(otpCreate.data.phone).toBe('9000000000');
      expect(otpCreate.data.code).toMatch(/^\d{6}$/);

      // Affordability checked the OUTLET's wallet.
      expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { partnerId: 'cp-out' } });

      // OTP delivered synchronously to the OUTLET's phone (A-2a: Msg91Service.sendOtp).
      expect(mockMsg91.sendOtp).toHaveBeenCalledWith('9000000000', expect.stringMatching(/^\d{6}$/), 'SMS');

      // Audit trail records the operating sales user.
      const audit = mockPrisma.auditLog.create.mock.calls?.[0]?.[0];
      expect(audit.data).toMatchObject({
        action: 'CREATE',
        entityType: 'REDEMPTION_ORDER',
        entityId: 'o-out',
        actorId: 'salesUser1',
        metadata: expect.objectContaining({
          event: 'SALES_ASSISTED_REDEEM', salesUserId: 'salesUser1', partnerId: 'cp-out',
        }),
      });

      expect(res.orderId).toBe('o-out');
      expect(res.requiredPoints).toBe(1000);
    });

    it('rejects insufficient OUTLET balance with 400 and creates NO order', async () => {
      wireAssigned();
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100 }); // < 500

      await expect(
        service.redeemForOutlet(sales, { rewardId: 'r1', targetPartnerId: 'cp-out' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });
  });

  describe('confirmRedeemForOutlet', () => {
    const outletPartner = {
      id: 'cp-out', userId: 'outletUser1', user: { id: 'outletUser1', phone: '9000000000' },
    };
    const pendingOrder = {
      id: 'o-out', status: 'PENDING', partnerId: 'cp-out', orderNumber: 'RDM-OUT',
      totalPointsCost: 1000, quantity: 1, redemptionMode: 'GIFT_CARD',
      partner: { id: 'cp-out', userId: 'outletUser1' },
      reward: { name: 'Amazon ₹500', stockQuantity: null },
    };
    const goodOtp = {
      id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
      expiresAt: new Date(Date.now() + 60_000), verifiedAt: null,
    };

    /** Wire an assigned outlet with a confirmable PENDING order + valid OTP. */
    const wireConfirm = () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(outletPartner);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue(goodOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockWallet.debitRedeem.mockResolvedValue({});
      mockPrisma.redemptionStatusHistory.create.mockResolvedValue({});
    };

    it('re-checks the assignment server-side — Forbidden without it (order alone not trusted)', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(outletPartner);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue(null); // assignment revoked

      await expect(
        service.confirmRedeemForOutlet(sales, {
          orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Never reached the order load / debit.
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('NotFound when the order does not belong to the resolved outlet', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(outletPartner);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);

      await expect(
        service.confirmRedeemForOutlet(sales, {
          orderId: 'o-foreign', otp: '123456', targetPartnerId: 'cp-out',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // The order load is scoped to the resolved outlet partnerId.
      expect(mockPrisma.redemptionOrder.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'o-foreign', partnerId: 'cp-out' } }),
      );
    });

    it('happy path: verifies OTP against the OUTLET user, debits the OUTLET wallet, history actor = sales user', async () => {
      wireConfirm();

      const res = await service.confirmRedeemForOutlet(sales, {
        orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out',
      });

      // OTP looked up for the OUTLET's user (not the sales rep).
      expect(mockPrisma.otpCode.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'outletUser1', purpose: 'REDEMPTION_CONFIRM', verifiedAt: null },
        }),
      );
      // Atomic PENDING→CONFIRMED claim with the valuePaise freeze.
      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o-out', status: 'PENDING' },
        data: { status: 'CONFIRMED', pointsDeducted: 1000, valuePaise: 100000n },
      });
      // Debit targets the OUTLET's wallet (order.partnerId).
      expect(mockWallet.debitRedeem).toHaveBeenCalledWith(
        'cp-out', 1000,
        { referenceId: 'o-out', description: 'Redemption RDM-OUT' },
        mockPrisma,
      );
      // The recorded actor is the operating sales user.
      const hist = mockPrisma.redemptionStatusHistory.create.mock.calls?.[0]?.[0];
      expect(hist.data).toMatchObject({
        orderId: 'o-out', fromStatus: 'PENDING', toStatus: 'CONFIRMED', changedById: 'salesUser1',
      });
      // Confirmation notify goes to the OUTLET's phone.
      expect(mockNotifications.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'outletUser1', recipientPhone: '9000000000' }),
      );
      expect(res.status).toBe('CONFIRMED');
    });

    it('a wrong OTP 401s and does NOT debit', async () => {
      wireConfirm();
      mockPrisma.otpCode.findFirst.mockResolvedValue({ ...goodOtp, code: '999999' });

      await expect(
        service.confirmRedeemForOutlet(sales, {
          orderId: 'o-out', otp: '000000', targetPartnerId: 'cp-out',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
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

  describe('adminListCatalog', () => {
    it('lists ALL statuses (not just ACTIVE), tenant-scoped + non-deleted', async () => {
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([{ id: 'r1', status: 'OUT_OF_STOCK' }]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(1);

      const res = await service.adminListCatalog(gifsy, { status: 'OUT_OF_STOCK' });

      const where = mockPrisma.rewardCatalog.findMany.mock.calls?.[0]?.[0]?.where;
      expect(where).toEqual({ clientId: 'deoleo', deletedAt: null, status: 'OUT_OF_STOCK' });
      // Crucially NOT forced to ACTIVE (that's the partner read) — admin sees inactive items.
      expect(where.status).not.toBe('ACTIVE');
      expect(res.items[0].status).toBe('OUT_OF_STOCK');
    });

    // gap #35 regression: query params arrive as STRINGS over HTTP. The global
    // ValidationPipe (transform:true) must coerce page/limit to Int via the DTO's
    // @Type(() => Number) BEFORE they reach Prisma `take`/`skip` — otherwise
    // Prisma throws PrismaClientValidationError (Int expected, got string) → 500.
    // This used to slip through because the admin route typed @Query() as an
    // inline intersection (erases to `Object` → pipe skips transform).
    it('coerces string page/limit to Int so Prisma take/skip never sees a string', async () => {
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(0);

      // Reproduce the post-ValidationPipe shape: transform raw string query params
      // through the concrete DTO exactly as Nest does with transform:true.
      const dto = plainToInstance(
        AdminListCatalogQueryDto,
        { page: '1', limit: '200' },
        { enableImplicitConversion: true },
      );
      expect(typeof dto.page).toBe('number');
      expect(typeof dto.limit).toBe('number');

      await service.adminListCatalog(gifsy, dto);

      const args = mockPrisma.rewardCatalog.findMany.mock.calls?.[0]?.[0];
      expect(args.take).toBe(200);
      expect(args.skip).toBe(0);
      expect(typeof args.take).toBe('number');
      expect(typeof args.skip).toBe('number');
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

  // ─── P5.4b Bulk fulfilment (download → fill → upload) ─────────────────────────

  describe('getFulfilmentTemplate', () => {
    it('scopes rows to the tenant and the default awaiting-fulfilment status set', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([
        {
          orderNumber: 'RDM-1', redemptionMode: 'GIFT_CARD', status: 'CONFIRMED',
          reward: { name: 'Amazon ₹500' },
        },
      ]);

      const buf = await service.getFulfilmentTemplate(gifsy, {});

      // Tenant scope + default actionable status set (no explicit status/mode filter).
      const call = mockPrisma.redemptionOrder.findMany.mock.calls?.[0]?.[0];
      expect(call.where.partner).toEqual({ user: { clientId: 'deoleo' } });
      expect(call.where.status).toEqual({
        in: expect.arrayContaining(['CONFIRMED', 'PROCESSING', 'DISPATCHED']),
      });
      // Round-trips through the shared helper into a real, parseable xlsx.
      expect(Buffer.isBuffer(buf)).toBe(true);
      const parsed = parseFulfilmentUploadBuffer(buf);
      expect(parsed.rows[0].orderNumber).toBe('RDM-1');
    });

    it('honours an explicit ?status= and ?mode= filter', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      await service.getFulfilmentTemplate(gifsy, {
        status: 'DISPATCHED' as never, mode: 'PHYSICAL_GIFT' as never,
      });
      const call = mockPrisma.redemptionOrder.findMany.mock.calls?.[0]?.[0];
      expect(call.where.status).toBe('DISPATCHED');
      expect(call.where.redemptionMode).toBe('PHYSICAL_GIFT');
    });
  });

  describe('uploadFulfilment', () => {
    /** Build an in-memory upload file from order-fill rows via the real builder. */
    const fileFromRows = (
      rows: { orderNumber: string; mode?: string; status?: string }[],
      fill: Record<number, Partial<Record<string, string>>> = {},
    ): Express.Multer.File => {
      // Write a sheet with the template headers + the fill values under test
      // (same shape the service's parser expects).
      const XLSX = require('xlsx');
      const header = [
        'Order Number', 'Reward', 'Mode', 'Current Status',
        'Voucher Code', 'Voucher Provider', 'Tracking Number', 'Tracking URL', 'New Status',
      ];
      const data = rows.map((r, i) => {
        const f = fill[i] ?? {};
        return [
          r.orderNumber, 'X', r.mode ?? 'GIFT_CARD', r.status ?? 'CONFIRMED',
          f['Voucher Code'] ?? '', f['Voucher Provider'] ?? '',
          f['Tracking Number'] ?? '', f['Tracking URL'] ?? '', f['New Status'] ?? '',
        ];
      });
      const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Fulfilment');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      return { buffer, originalname: 'fill.xlsx' } as Express.Multer.File;
    };

    it('rejects a non-template file (missing Order Number header) with 400', async () => {
      const XLSX = require('xlsx');
      const ws = XLSX.utils.aoa_to_sheet([['Some', 'Other', 'Sheet'], ['a', 'b', 'c']]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Nope');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      await expect(
        service.uploadFulfilment(gifsy, { buffer, originalname: 'x.xlsx' } as Express.Multer.File),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('matches orderNumber and calls transitionOrder per row with the row voucher + New Status', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'oid-1' });
      const spy = jest
        .spyOn(service, 'transitionOrder')
        .mockResolvedValue({ order: { id: 'oid-1' } } as never);

      const file = fileFromRows(
        [{ orderNumber: 'RDM-1' }],
        { 0: { 'Voucher Code': 'GC-XYZ', 'New Status': 'PROCESSING' } },
      );
      const res = await service.uploadFulfilment(gifsy, file);

      // Resolved the order in-tenant by orderNumber.
      expect(mockPrisma.redemptionOrder.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderNumber: 'RDM-1', partner: { user: { clientId: 'deoleo' } } },
        }),
      );
      // Applied via the guarded transition with the row's voucher + target status.
      expect(spy).toHaveBeenCalledWith(gifsy, 'oid-1', expect.objectContaining({
        toStatus: 'PROCESSING',
        voucherCode: 'GC-XYZ',
      }));
      expect(res).toEqual({ processed: 1, succeeded: 1, skipped: 0, failed: 0, errors: [] });
      spy.mockRestore();
    });

    it('rejects a row whose orderNumber belongs to another tenant (T1)', async () => {
      // The order exists in another tenant → the tenant-scoped findFirst returns
      // null, so the row is collected as an error and never transitioned.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
      const tSpy = jest.spyOn(service, 'transitionOrder').mockResolvedValue({} as never);
      const uSpy = jest.spyOn(service, 'updateOrder').mockResolvedValue({} as never);

      const file = fileFromRows(
        [{ orderNumber: 'RDM-OTHER-TENANT' }],
        { 0: { 'New Status': 'PROCESSING', 'Voucher Code': 'GC-X' } },
      );
      const res = await service.uploadFulfilment(gifsy, file);

      expect(mockPrisma.redemptionOrder.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderNumber: 'RDM-OTHER-TENANT', partner: { user: { clientId: 'deoleo' } } },
        }),
      );
      expect(tSpy).not.toHaveBeenCalled();
      expect(uSpy).not.toHaveBeenCalled();
      expect(res.succeeded).toBe(0);
      expect(res.errors).toEqual([
        { row: expect.any(Number), orderNumber: 'RDM-OTHER-TENANT', message: 'Order not found in this tenant' },
      ]);
      tSpy.mockRestore();
      uSpy.mockRestore();
    });

    it('skips an all-blank row (no status, no fill) instead of counting it as a change', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'oid-1' });
      const uSpy = jest.spyOn(service, 'updateOrder').mockResolvedValue({} as never);

      const file = fileFromRows([{ orderNumber: 'RDM-1' }], { 0: {} });
      const res = await service.uploadFulfilment(gifsy, file);

      expect(uSpy).not.toHaveBeenCalled();
      expect(res).toEqual({ processed: 1, succeeded: 0, skipped: 1, failed: 0, errors: [] });
      uSpy.mockRestore();
    });

    it('a blank New Status routes through the non-status updateOrder path', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'oid-1' });
      const tSpy = jest.spyOn(service, 'transitionOrder').mockResolvedValue({} as never);
      const uSpy = jest
        .spyOn(service, 'updateOrder')
        .mockResolvedValue({ order: { id: 'oid-1' } } as never);

      const file = fileFromRows([{ orderNumber: 'RDM-1' }], { 0: { 'Voucher Code': 'GC-ONLY' } });
      const res = await service.uploadFulfilment(gifsy, file);

      expect(tSpy).not.toHaveBeenCalled();
      expect(uSpy).toHaveBeenCalledWith(gifsy, 'oid-1', expect.objectContaining({
        voucherCode: 'GC-ONLY',
      }));
      expect(res.succeeded).toBe(1);
      tSpy.mockRestore();
      uSpy.mockRestore();
    });

    it('collects an unknown orderNumber as an error and continues the batch', async () => {
      // Row 1 unknown (null), row 2 found.
      mockPrisma.redemptionOrder.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'oid-2' });
      const spy = jest.spyOn(service, 'transitionOrder').mockResolvedValue({} as never);

      const file = fileFromRows(
        [{ orderNumber: 'GHOST' }, { orderNumber: 'RDM-2' }],
        { 1: { 'New Status': 'PROCESSING' } },
      );
      const res = await service.uploadFulfilment(gifsy, file);

      expect(res.processed).toBe(2);
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(1);
      expect(res.errors[0]).toMatchObject({ orderNumber: 'GHOST', message: expect.stringContaining('not found') });
      // The good row still went through.
      expect(spy).toHaveBeenCalledWith(gifsy, 'oid-2', expect.objectContaining({ toStatus: 'PROCESSING' }));
      spy.mockRestore();
    });

    it('reports an illegal-edge row in errors without aborting the batch', async () => {
      mockPrisma.redemptionOrder.findFirst
        .mockResolvedValueOnce({ id: 'oid-1' })
        .mockResolvedValueOnce({ id: 'oid-2' });
      const spy = jest
        .spyOn(service, 'transitionOrder')
        .mockRejectedValueOnce(new BadRequestException('Illegal status transition: PENDING → DISPATCHED'))
        .mockResolvedValueOnce({} as never);

      const file = fileFromRows(
        [{ orderNumber: 'RDM-1' }, { orderNumber: 'RDM-2' }],
        { 0: { 'New Status': 'DISPATCHED' }, 1: { 'New Status': 'PROCESSING' } },
      );
      const res = await service.uploadFulfilment(gifsy, file);

      expect(res.processed).toBe(2);
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(1);
      expect(res.errors[0]).toMatchObject({
        orderNumber: 'RDM-1',
        message: expect.stringContaining('Illegal status transition'),
      });
      expect(spy).toHaveBeenCalledTimes(2); // batch continued to row 2
      spy.mockRestore();
    });

    it('collects an unknown New Status value without calling transitionOrder', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'oid-1' });
      const spy = jest.spyOn(service, 'transitionOrder').mockResolvedValue({} as never);

      const file = fileFromRows([{ orderNumber: 'RDM-1' }], { 0: { 'New Status': 'WAT' } });
      const res = await service.uploadFulfilment(gifsy, file);

      expect(spy).not.toHaveBeenCalled();
      expect(res.failed).toBe(1);
      expect(res.errors[0].message).toContain('Unknown New Status');
      spy.mockRestore();
    });
  });

  // ─── P6.5a — valuePaise freeze on confirmRedeem ──────────────────────────

  describe('confirmRedeem — valuePaise frozen as 194R base', () => {
    /**
     * The confirm transaction atomically sets:
     *   status = CONFIRMED, pointsDeducted = requiredPoints, valuePaise = ...
     *
     * valuePaise = roundToRupeePaise(BigInt(points) * 100n / BigInt(conversionRate))
     * Default conversionRate = 1 (env POINTS_CONVERSION_RATE not set in tests).
     * So for 500 points: 500 * 100 / 1 = 50000 paise = ₹500. roundToRupeePaise(50000) = 50000.
     */
    const baseOrder = {
      id: 'o1',
      status: 'PENDING',
      partnerId: 'cp1',
      orderNumber: 'RDM-1',
      totalPointsCost: 500,
      pointsDeducted: 0,
      reward: { id: 'r1', name: 'VCH', stockQuantity: null },
      partner: { id: 'cp1', userId: 'user1' },
    };

    it('sets valuePaise = points * 100 / conversionRate, rounded to rupee, in the claim update', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(baseOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60_000), verifiedAt: null,
      });
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockWallet.debitRedeem.mockResolvedValue({});

      await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });

      // The updateMany (atomic claim) must include valuePaise
      const claimCall = mockPrisma.redemptionOrder.updateMany.mock.calls.find(
        (c: unknown[]) => (c[0] as { where?: { status?: string } }).where?.status === 'PENDING',
      );
      expect(claimCall).toBeDefined();
      const claimData = (claimCall![0] as { data: { status: string; pointsDeducted: number; valuePaise?: bigint } }).data;
      expect(claimData.status).toBe('CONFIRMED');
      expect(claimData.pointsDeducted).toBe(500);
      // 500 points × 100 paise / 1 conversionRate = 50000 paise; round(50000) = 50000
      expect(claimData.valuePaise).toBe(50000n);
    });

    it('valuePaise = 0 when conversionRate env is 0 (guard against division-by-zero)', async () => {
      // Override POINTS_CONVERSION_RATE to 0
      const original = process.env.POINTS_CONVERSION_RATE;
      process.env.POINTS_CONVERSION_RATE = '0';

      // Re-instantiate the service so it picks up the new env
      const module2: TestingModule = await Test.createTestingModule({
        providers: [
          (await import('./rewards.service')).RewardsService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: (await import('../wallet/wallet.service')).WalletService, useValue: mockWallet },
          { provide: (await import('../notifications/notifications.service')).NotificationsService, useValue: mockNotifications },
          { provide: (await import('../notifications/msg91.service')).Msg91Service, useValue: mockMsg91 },
        ],
      }).compile();
      const svc0 = module2.get((await import('./rewards.service')).RewardsService);

      jest.clearAllMocks();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(baseOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60_000), verifiedAt: null,
      });
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockWallet.debitRedeem.mockResolvedValue({});
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.redemptionOrder.update.mockResolvedValue({});
      mockPrisma.redemptionStatusHistory.create.mockResolvedValue({});

      await svc0.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });

      const claimCall = mockPrisma.redemptionOrder.updateMany.mock.calls.find(
        (c: unknown[]) => (c[0] as { where?: { status?: string } }).where?.status === 'PENDING',
      );
      const claimData = (claimCall![0] as { data: { valuePaise?: bigint } }).data;
      expect(claimData.valuePaise).toBe(0n);

      if (original === undefined) delete process.env.POINTS_CONVERSION_RATE;
      else process.env.POINTS_CONVERSION_RATE = original;
    });
  });

  // ─── P6 Bridge — confirmRedeem creates PayoutTransaction for cash modes ──────

  describe('confirmRedeem — P6 payout bridge', () => {
    /**
     * Partner bank snapshot returned by the channelPartner.findFirst inside the tx.
     * The tx mock proxies to mockPrisma, so channelPartner.findFirst serves both
     * the outer requirePartner call (not used in confirmRedeem) and the inner
     * snapshot fetch; we use mockResolvedValueOnce sequencing to differentiate.
     */
    const partnerSnap = {
      bankAccountHolder: 'Ravi Kumar',
      ownerName: 'Ravi Kumar Proprietor',
      upiId: 'ravi@upi',
      bankAccountNumber: '0011223344',
      ifscCode: 'HDFC0001234',
      bankName: 'HDFC Bank',
    };

    /** A PENDING UPI-mode order (valuePaise will be computed as 100000n for 1000 pts). */
    const upiOrder = {
      id: 'o-upi',
      status: 'PENDING',
      partnerId: 'cp1',
      orderNumber: 'RDM-UPI',
      totalPointsCost: 1000,
      quantity: 1,
      redemptionMode: 'UPI',
      partner: { id: 'cp1', userId: 'user1' },
      reward: { name: 'Cash ₹1000', stockQuantity: null },
    };

    /** A PENDING BANK_TRANSFER-mode order. */
    const bankOrder = {
      ...upiOrder,
      id: 'o-bank',
      orderNumber: 'RDM-BANK',
      redemptionMode: 'BANK_TRANSFER',
    };

    /** A PENDING GIFT_CARD order (no payout expected). */
    const giftOrder = {
      ...upiOrder,
      id: 'o-gift',
      orderNumber: 'RDM-GIFT',
      redemptionMode: 'GIFT_CARD',
    };

    const goodOtp = {
      id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
      expiresAt: new Date(Date.now() + 60_000), verifiedAt: null,
    };

    beforeEach(() => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(goodOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockWallet.debitRedeem.mockResolvedValue({});
      mockPrisma.redemptionStatusHistory.create.mockResolvedValue({});
      mockPrisma.payoutTransaction.create.mockResolvedValue({ id: 'pt1' });
      // channelPartner.findFirst returns the bank snapshot (used inside the tx for the snapshot)
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partnerSnap);
    });

    it('UPI confirm: creates a PayoutTransaction with correct fields and PENDING status', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(upiOrder);

      await service.confirmRedeem(partner, { orderId: 'o-upi', otp: '123456' });

      expect(mockPrisma.payoutTransaction.create).toHaveBeenCalledTimes(1);
      const call = mockPrisma.payoutTransaction.create.mock.calls[0][0];
      expect(call.data).toMatchObject({
        partnerId: 'cp1',
        redemptionOrderId: 'o-upi',
        payoutMode: 'UPI',
        status: 'PENDING',
        batchId: null,
        // 1000 pts × 10000 / (1×100) = 100000 paise = ₹1000; roundToRupeePaise(100000n) = 100000n
        amountPaise: 100000n,
        netAmountPaise: 100000n,
        tdsPaise: 0n,
        tdsApplicable: false,
        // beneficiary snapshot from partner KYC
        beneficiaryName: 'Ravi Kumar',    // bankAccountHolder wins over ownerName
        upiId: 'ravi@upi',
        bankAccountNumber: '0011223344',
        ifscCode: 'HDFC0001234',
        bankName: 'HDFC Bank',
      });
    });

    it('BANK_TRANSFER confirm: creates a PayoutTransaction linked to the order', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(bankOrder);

      await service.confirmRedeem(partner, { orderId: 'o-bank', otp: '123456' });

      expect(mockPrisma.payoutTransaction.create).toHaveBeenCalledTimes(1);
      const call = mockPrisma.payoutTransaction.create.mock.calls[0][0];
      expect(call.data.payoutMode).toBe('BANK_TRANSFER');
      expect(call.data.redemptionOrderId).toBe('o-bank');
      expect(call.data.amountPaise).toBe(100000n);
      expect(call.data.status).toBe('PENDING');
    });

    it('GIFT_CARD confirm: does NOT create a PayoutTransaction', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(giftOrder);

      await service.confirmRedeem(partner, { orderId: 'o-gift', otp: '123456' });

      expect(mockPrisma.payoutTransaction.create).not.toHaveBeenCalled();
    });

    it('double-confirm is blocked by the PENDING claim (count=0 → ConflictException, no payout)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(upiOrder);
      // Simulate another tx already flipped the order to CONFIRMED.
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.confirmRedeem(partner, { orderId: 'o-upi', otp: '123456' }),
      ).rejects.toBeInstanceOf(ConflictException);

      // The payout create never runs — the ConflictException is thrown before it.
      expect(mockPrisma.payoutTransaction.create).not.toHaveBeenCalled();
    });

    it('falls back to amountPaise=0n (with a logged warning) when valuePaise would be 0n', async () => {
      // Force conversionRate=0 so valuePaise=0n
      const original = process.env.POINTS_CONVERSION_RATE;
      process.env.POINTS_CONVERSION_RATE = '0';

      const module2 = await Test.createTestingModule({
        providers: [
          (await import('./rewards.service')).RewardsService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: (await import('../wallet/wallet.service')).WalletService, useValue: mockWallet },
          { provide: (await import('../notifications/notifications.service')).NotificationsService, useValue: mockNotifications },
          { provide: (await import('../notifications/msg91.service')).Msg91Service, useValue: mockMsg91 },
        ],
      }).compile();
      const svc0 = module2.get((await import('./rewards.service')).RewardsService);

      jest.clearAllMocks();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(upiOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue(goodOtp);
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockWallet.debitRedeem.mockResolvedValue({});
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.redemptionStatusHistory.create.mockResolvedValue({});
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partnerSnap);
      mockPrisma.payoutTransaction.create.mockResolvedValue({ id: 'pt-warn' });

      await svc0.confirmRedeem(partner, { orderId: 'o-upi', otp: '123456' });

      // Even with zero conversionRate, a PayoutTransaction IS created (with 0n),
      // so the admin can see and correct it.
      expect(mockPrisma.payoutTransaction.create).toHaveBeenCalledTimes(1);
      const call = mockPrisma.payoutTransaction.create.mock.calls[0][0];
      expect(call.data.amountPaise).toBe(0n);
      expect(call.data.netAmountPaise).toBe(0n);

      if (original === undefined) delete process.env.POINTS_CONVERSION_RATE;
      else process.env.POINTS_CONVERSION_RATE = original;
    });

    it('uses ownerName as beneficiaryName when bankAccountHolder is null', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(upiOrder);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        ...partnerSnap,
        bankAccountHolder: null,
      });

      await service.confirmRedeem(partner, { orderId: 'o-upi', otp: '123456' });

      const call = mockPrisma.payoutTransaction.create.mock.calls[0][0];
      expect(call.data.beneficiaryName).toBe('Ravi Kumar Proprietor');
    });
  });
});
