// TDD — RewardsService
// RED: all tests fail until rewards.service.ts is implemented.
//
// Covers:
//   R1: getCatalog returns only ACTIVE items for the correct clientId
//   R2: getCatalog includes userBalance and isAffordable flag
//   R3: initiateRedemption throws BadRequestException on insufficient points
//   R4: initiateRedemption creates PENDING order when points are sufficient
//   R5: confirmRedemption throws BadRequestException if order not found / not PENDING
//   R6: confirmRedemption deducts points and sets order to CONFIRMED (inside $transaction)
//   A1: createCatalogItem persists item with correct clientId
//   A2: updateCatalogItem throws NotFoundException if item not found
//   A3: updateCatalogItem returns updated item
//   A4: softDeleteCatalogItem sets deletedAt + status DISCONTINUED
//   A5: listAdminCatalog returns all items (no active-only filter)

import { Test, TestingModule }           from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RewardsService }                from './rewards.service';
import { PrismaService }                 from '../prisma/prisma.service';

// ── Shared mock ───────────────────────────────────────────────────────────────

const mockPrisma = {
  $transaction: jest.fn().mockImplementation((fn: any) => fn(mockPrisma)),
  rewardCatalog:           { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(),
                             create: jest.fn(), update: jest.fn() },
  rewardCategory:          { findFirst: jest.fn() },
  redemptionOrder:         { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(),
                             findMany: jest.fn(), count: jest.fn() },
  redemptionStatusHistory: { create: jest.fn() },
  wallet:                  { findFirst: jest.fn(), update: jest.fn() },
  walletTransaction:       { create: jest.fn() },
  otpCode:                 { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  channelPartner:          { findFirst: jest.fn() },
  user:                    { findFirst: jest.fn() },
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const activeItem = {
  id: 'rwd_1', clientId: 'client_a', categoryId: 'cat_1',
  code: 'RWD001', name: 'Amazon Gift Card',
  pointsCost: 500, status: 'ACTIVE', deletedAt: null,
  redemptionMode: 'GIFT_CARD',
};

const partner = { id: 'cp_1', userId: 'user_1', clientId: 'client_a' };
const userRecord = { id: 'user_1', phone: '9876543210', clientId: 'client_a' };

const wallet = {
  id: 'wallet_1', partnerId: 'cp_1',
  redeemablePoints: 1000, redeemedPoints: 0,
  lifetimeRedeemed: 0,
};

const deliveryAddress = {
  name: 'Test User', mobile: '9876543210',
  address: '123 Main St', city: 'Mumbai',
  state: 'Maharashtra', pincode: '400001',
};

// ─────────────────────────────────────────────────────────────────────────────

describe('RewardsService', () => {
  let service: RewardsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<RewardsService>(RewardsService);
    jest.clearAllMocks();
    // Reset $transaction to always delegate to callback
    mockPrisma.$transaction.mockImplementation((fn: any) => fn(mockPrisma));
  });

  it('should be defined', () => expect(service).toBeDefined());

  // ── Catalog ───────────────────────────────────────────────────────────────

  describe('getCatalog', () => {
    it('R1: returns only ACTIVE items for the correct clientId', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.wallet.findFirst.mockResolvedValue(wallet);
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([activeItem]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(1);

      const result = await service.getCatalog('client_a', 'user_1', {});

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('rwd_1');
      expect(mockPrisma.rewardCatalog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'ACTIVE',
            deletedAt: null,
            clientId: 'client_a',
          }),
        }),
      );
    });

    it('R2: includes userBalance and isAffordable flag', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet, redeemablePoints: 300 });
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([activeItem]); // pointsCost: 500
      mockPrisma.rewardCatalog.count.mockResolvedValue(1);

      const result = await service.getCatalog('client_a', 'user_1', {});
      expect(result.userBalance).toBe(300);
      expect(result.items[0].isAffordable).toBe(false); // 300 < 500
    });
  });

  // ── Initiate Redemption ───────────────────────────────────────────────────

  describe('initiateRedemption', () => {
    const dto = { rewardId: 'rwd_1', quantity: 1, deliveryAddress };

    beforeEach(() => {
      // Mock OTP creation (SMS side-effect skipped in tests)
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp_1' });
      mockPrisma.user.findFirst.mockResolvedValue(userRecord);
    });

    it('R3: throws BadRequestException if insufficient points', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(activeItem); // pointsCost: 500
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet, redeemablePoints: 200 });

      await expect(
        service.initiateRedemption('user_1', 'client_a', dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('R4: creates PENDING order when points are sufficient', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partner);
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(activeItem); // pointsCost: 500
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet, redeemablePoints: 1000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({
        id: 'order_1', orderNumber: 'RDM-001', status: 'PENDING', totalPointsCost: 500,
      });

      const result = await service.initiateRedemption('user_1', 'client_a', dto);

      expect(result.orderId).toBe('order_1');
      expect(mockPrisma.redemptionOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PENDING', partnerId: 'cp_1' }),
        }),
      );
    });
  });

  // ── Admin: Catalog management ─────────────────────────────────────────────

  describe('Admin catalog', () => {
    const createDto = {
      categoryId: 'cat_1', code: 'RWD999', name: 'Test Gift Card',
      pointsCost: 200, redemptionMode: 'GIFT_CARD',
    };

    it('A1: createCatalogItem persists item with correct clientId', async () => {
      mockPrisma.rewardCatalog.create.mockResolvedValue({
        id: 'rwd_new', clientId: 'client_a', ...createDto,
      });

      const result = await (service as any).createCatalogItem('client_a', createDto);

      expect(result.clientId).toBe('client_a');
      expect(mockPrisma.rewardCatalog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ clientId: 'client_a', code: 'RWD999' }),
        }),
      );
    });

    it('A2: updateCatalogItem throws NotFoundException if item not found', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);

      await expect(
        (service as any).updateCatalogItem('bad_id', 'client_a', { name: 'Updated' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('A3: updateCatalogItem returns updated item', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(activeItem);
      mockPrisma.rewardCatalog.update.mockResolvedValue({ ...activeItem, name: 'Updated Name' });

      const result = await (service as any).updateCatalogItem('rwd_1', 'client_a', { name: 'Updated Name' });

      expect(result.name).toBe('Updated Name');
      expect(mockPrisma.rewardCatalog.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'rwd_1' } }),
      );
    });

    it('A4: softDeleteCatalogItem sets deletedAt and status DISCONTINUED', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(activeItem);
      mockPrisma.rewardCatalog.update.mockResolvedValue({
        ...activeItem, deletedAt: new Date(), status: 'DISCONTINUED',
      });

      await (service as any).softDeleteCatalogItem('rwd_1', 'client_a');

      expect(mockPrisma.rewardCatalog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deletedAt: expect.any(Date),
            status:    'DISCONTINUED',
          }),
        }),
      );
    });

    it('A5: listAdminCatalog returns items including inactive ones', async () => {
      const inactiveItem = { ...activeItem, id: 'rwd_2', status: 'INACTIVE' };
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([activeItem, inactiveItem]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(2);

      const result = await (service as any).listAdminCatalog('client_a', {});

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      // No status filter applied
      const callArgs = mockPrisma.rewardCatalog.findMany.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('status');
    });
  });

  // ── Confirm Redemption ────────────────────────────────────────────────────

  describe('confirmRedemption', () => {
    it('R5: throws BadRequestException if order not found or not PENDING', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);

      await expect(
        service.confirmRedemption('user_1', 'client_a', 'order_1', '123456'),
      ).rejects.toThrow(BadRequestException);
    });

    it('R6: deducts points and marks order CONFIRMED inside a $transaction', async () => {
      const pendingOrder = {
        id: 'order_1', partnerId: 'cp_1', totalPointsCost: 500,
        status: 'PENDING', reward: activeItem,
      };
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp_1', code: '123456', verifiedAt: null, expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockPrisma.wallet.findFirst.mockResolvedValue({ ...wallet, redeemablePoints: 1000 });
      mockPrisma.wallet.update.mockResolvedValue({ ...wallet, redeemablePoints: 500 });
      mockPrisma.walletTransaction.create.mockResolvedValue({});
      mockPrisma.redemptionOrder.update.mockResolvedValue({
        ...pendingOrder, status: 'CONFIRMED',
      });
      mockPrisma.redemptionStatusHistory.create.mockResolvedValue({});

      const result = await service.confirmRedemption('user_1', 'client_a', 'order_1', '123456');

      expect(result.status).toBe('CONFIRMED');
      // All DB writes must happen inside a single $transaction call
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // Points must be deducted atomically
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            redeemablePoints: { decrement: 500 },
            redeemedPoints:   { increment: 500 },
            lifetimeRedeemed: { increment: 500 },
          }),
        }),
      );
    });
  });
});
