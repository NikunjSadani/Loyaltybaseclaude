// Unit tests for RewardsService — mirrors the S4 tickets/wallet templates.
// Covers tenant scoping, per-item affordability, order ownership checks, and the
// GIFSY-only order update ported from the Next routes.
// Run: npx jest src/rewards/rewards.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RewardsService } from './rewards.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { UpdatableOrderStatus } from './dto/rewards.dto';

const mockPrisma = {
  channelPartner: { findFirst: jest.fn() },
  wallet: { findFirst: jest.fn() },
  rewardCatalog: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  redemptionOrder: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };

describe('RewardsService', () => {
  let service: RewardsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [RewardsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(RewardsService);
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
        service.updateOrder(gifsy, 'o9', { status: UpdatableOrderStatus.DISPATCHED }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.redemptionOrder.findFirst).toHaveBeenCalledWith({
        where: { id: 'o9', partner: { user: { clientId: 'deoleo' } } },
      });
    });

    it('updates status/tracking/notes within the tenant', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1' });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'DISPATCHED' });
      const res = await service.updateOrder(gifsy, 'o1', {
        status: UpdatableOrderStatus.DISPATCHED,
        trackingNumber: 'TN1',
      });
      expect(mockPrisma.redemptionOrder.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { status: 'DISPATCHED', trackingNumber: 'TN1', trackingUrl: undefined, notes: undefined },
      });
      expect(res).toEqual({ order: { id: 'o1', status: 'DISPATCHED' } });
    });
  });
});
