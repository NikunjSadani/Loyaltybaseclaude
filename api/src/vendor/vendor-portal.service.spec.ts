import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RedemptionStatus } from '@prisma/client';
import { VendorPortalService } from './vendor-portal.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  vendor: { findFirst: jest.fn() },
  vendorTenantGrant: { findFirst: jest.fn() },
  giftCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  rewardCategory: { findFirst: jest.fn(), create: jest.fn() },
  rewardCatalog: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  redemptionOrder: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  redemptionStatusHistory: { create: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
  auditLog: { create: jest.fn().mockResolvedValue({}) },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: jest.fn((fn: (tx: any) => unknown) => fn(mockPrisma)),
};
const mockTenantSettings = { getConversionRate: jest.fn(async () => 1) };
const mockNotifications = { notifyUserWithChannels: jest.fn().mockResolvedValue(undefined) };

const vendor: JwtPayload = { sub: 'vu1', role: 'VENDOR', clientId: 'deoleo', vendorId: 'v1', phone: '9998887777', name: 'Rep' };
const notVendor: JwtPayload = { sub: 'u1', role: 'SSS', clientId: 'deoleo', phone: '9991112222', name: '' };

/** Make resolveScope succeed with the given approvalPolicy. */
function grantScope(approvalPolicy = 'GIFSY_APPROVE') {
  mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'v1', name: 'Acme', status: 'ACTIVE' });
  mockPrisma.vendorTenantGrant.findFirst.mockResolvedValue({ approvalPolicy });
}

describe('VendorPortalService', () => {
  let service: VendorPortalService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenantSettings.getConversionRate.mockResolvedValue(1);
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        VendorPortalService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();
    service = mod.get(VendorPortalService);
  });

  describe('resolveScope (hard data-boundary + suspend/revoke enforcement)', () => {
    it('rejects a non-vendor caller', async () => {
      await expect(service.getMe(notVendor)).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('rejects a suspended vendor', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'v1', name: 'Acme', status: 'SUSPENDED' });
      await expect(service.getMe(vendor)).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('rejects a vendor with no ACTIVE grant for its tenant', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'v1', name: 'Acme', status: 'ACTIVE' });
      mockPrisma.vendorTenantGrant.findFirst.mockResolvedValue(null);
      await expect(service.getMe(vendor)).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('getMe returns vendor + clientId + approvalPolicy', async () => {
      grantScope('AUTO_LIVE');
      const res = await service.getMe(vendor);
      expect(res).toMatchObject({ vendor: { id: 'v1', status: 'ACTIVE' }, clientId: 'deoleo', approvalPolicy: 'AUTO_LIVE' });
    });
  });

  describe('listCategories (shared GiftCategory taxonomy)', () => {
    it('rejects an unauthorized caller (resolveScope)', async () => {
      await expect(service.listCategories(notVendor)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns only active categories after authorizing the vendor scope', async () => {
      grantScope();
      mockPrisma.giftCategory.findMany.mockResolvedValue([
        { id: 'gc1', parentId: null, code: 'ELEC', name: 'Electronics', imageUrl: null, sortOrder: 0 },
      ]);
      const res = await service.listCategories(vendor);
      expect(mockPrisma.giftCategory.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
      expect(res).toEqual({
        items: [{ id: 'gc1', parentId: null, code: 'ELEC', name: 'Electronics', imageUrl: null, sortOrder: 0 }],
      });
    });
  });

  describe('getCatalogueTemplate (xlsx)', () => {
    it('rejects an unauthorized caller (resolveScope)', async () => {
      await expect(service.getCatalogueTemplate(notVendor)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns a non-empty xlsx buffer for an authorized vendor', async () => {
      grantScope();
      const buf = await service.getCatalogueTemplate(vendor);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(0);
    });
  });

  describe('listCatalogue — hard-scoped by vendorId + clientId', () => {
    it('filters sourceType VENDOR + vendorId + clientId', async () => {
      grantScope();
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([]);
      await service.listCatalogue(vendor);
      expect(mockPrisma.rewardCatalog.findMany.mock.calls[0][0].where).toMatchObject({
        sourceType: 'VENDOR',
        vendorId: 'v1',
        clientId: 'deoleo',
        deletedAt: null,
      });
    });
  });

  describe('createCatalogue', () => {
    const dtoBase = {
      name: 'Earbuds', categoryId: 'gc1', sellingValuePaise: 150000, mrpPaise: 199900,
      redemptionMode: 'PHYSICAL_GIFT' as const, fulfilmentChannel: 'BRAND' as const,
    };
    function primeCreate() {
      mockPrisma.giftCategory.findFirst.mockResolvedValue({ id: 'gc1', code: 'ELEC', name: 'Electronics', imageUrl: null, sortOrder: 0 });
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'rc-cat-1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null); // no code clash
      mockPrisma.rewardCatalog.create.mockImplementation(async ({ data }: never) => ({ id: 'rcat-1', giftCategory: null, ...(data as object) }));
    }

    it('AUTO_LIVE → moderationStatus APPROVED; stamps vendorId/clientId/sourceType', async () => {
      grantScope('AUTO_LIVE');
      primeCreate();
      await service.createCatalogue(vendor, dtoBase);
      const data = mockPrisma.rewardCatalog.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        sourceType: 'VENDOR', vendorId: 'v1', clientId: 'deoleo',
        moderationStatus: 'APPROVED', sellingValuePaise: 150000, pointsCost: 1500,
      });
    });

    it('GIFSY_APPROVE → moderationStatus PENDING', async () => {
      grantScope('GIFSY_APPROVE');
      primeCreate();
      await service.createCatalogue(vendor, dtoBase);
      expect(mockPrisma.rewardCatalog.create.mock.calls[0][0].data.moderationStatus).toBe('PENDING');
    });

    it('enforces price bounds even under AUTO_LIVE (reject over-MRP)', async () => {
      grantScope('AUTO_LIVE');
      primeCreate();
      await expect(
        service.createCatalogue(vendor, { ...dtoBase, sellingValuePaise: 250000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.rewardCatalog.create).not.toHaveBeenCalled();
    });
  });

  describe('updateCatalogue — re-moderation (review #9)', () => {
    const existing = {
      id: 'rcat-1', sourceType: 'VENDOR', vendorId: 'v1', clientId: 'deoleo',
      name: 'Old', sellingValuePaise: 150000, mrpPaise: 199900, giftCategoryId: 'gc1', metadata: null,
    };
    it('material edit under GIFSY_APPROVE resets moderationStatus → PENDING', async () => {
      grantScope('GIFSY_APPROVE');
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(existing);
      mockPrisma.rewardCatalog.update.mockResolvedValue({ ...existing, giftCategory: null });
      await service.updateCatalogue(vendor, 'rcat-1', { name: 'New Name' });
      expect(mockPrisma.rewardCatalog.update.mock.calls[0][0].data.moderationStatus).toBe('PENDING');
    });
    it('material edit under AUTO_LIVE does NOT reset moderation', async () => {
      grantScope('AUTO_LIVE');
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(existing);
      mockPrisma.rewardCatalog.update.mockResolvedValue({ ...existing, giftCategory: null });
      await service.updateCatalogue(vendor, 'rcat-1', { name: 'New Name' });
      expect(mockPrisma.rewardCatalog.update.mock.calls[0][0].data.moderationStatus).toBeUndefined();
    });
    it('404 for another vendor\'s / another tenant\'s item (hard scope)', async () => {
      grantScope('GIFSY_APPROVE');
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      await expect(service.updateCatalogue(vendor, 'rcat-x', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
      // the lookup was hard-scoped
      expect(mockPrisma.rewardCatalog.findFirst.mock.calls[0][0].where).toMatchObject({
        sourceType: 'VENDOR', vendorId: 'v1', clientId: 'deoleo',
      });
    });
  });

  describe('orders — hard scope + restricted transition', () => {
    it('listOrders filters fulfilledByVendorId + partner.clientId', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      await service.listOrders(vendor);
      expect(mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where).toMatchObject({
        fulfilledByVendorId: 'v1',
        partner: { clientId: 'deoleo' },
      });
    });

    it('getOrder 404 for a foreign order', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
      await expect(service.getOrder(vendor, 'o-x')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('transition REJECTS a wallet-touching edge (CANCELLED not in the enum → illegal move)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', status: 'PROCESSING', partnerId: 'cp1', orderNumber: 'D-26-1' });
      // even if a caller forced toStatus CANCELLED past the DTO, the edge map rejects it
      await expect(
        service.transition(vendor, 'o1', { toStatus: 'CANCELLED' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
    });

    it('transition CONFIRMED→PROCESSING succeeds without touching points/valuePaise', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'D-26-1' });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'PROCESSING' });
      await service.transition(vendor, 'o1', { toStatus: 'PROCESSING' as never });
      const data = mockPrisma.redemptionOrder.update.mock.calls[0][0].data;
      expect(data.status).toBe('PROCESSING');
      expect(data).not.toHaveProperty('valuePaise');
      expect(data).not.toHaveProperty('pointsDeducted');
    });

    it('transition to DISPATCHED stamps dispatchedAt + notifies the member', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', status: 'PROCESSING', partnerId: 'cp1', orderNumber: 'D-26-1' });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'DISPATCHED' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'member1', phone: '9990000000', ownerName: 'Asha' });
      await service.transition(vendor, 'o1', { toStatus: 'DISPATCHED' as never, trackingNumber: 'TRK1' });
      expect(mockPrisma.redemptionOrder.update.mock.calls[0][0].data.dispatchedAt).toBeInstanceOf(Date);
      expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalled();
    });

    it('transition is idempotent (same status → skip)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', status: 'DISPATCHED', partnerId: 'cp1', orderNumber: 'D-26-1' });
      const res = await service.transition(vendor, 'o1', { toStatus: 'DISPATCHED' as never });
      expect((res as { skipped?: boolean }).skipped).toBe(true);
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
    });

    it('transition response is the MEMBER-SAFE projection — no valuePaise/pointsDeducted/metadata (HIGH#1)', async () => {
      grantScope();
      // 1) the transition lookup returns the FULL row (incl. sensitive fields)
      mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce({
        id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'D-26-1',
        valuePaise: 150000n, pointsDeducted: 1500, totalPointsCost: 1500,
        conversionRateCenti: 100, metadata: { secret: 1 }, cancelReason: 'x',
      });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'PROCESSING' });
      // 2) getOrder's VENDOR_ORDER_SELECT projection (what prod returns) — member-safe only
      mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce({
        id: 'o1', status: 'PROCESSING', deliveredAt: null, cancelledAt: null,
        updatedAt: new Date(), deliveryName: 'Asha', statusHistory: [],
      });
      const res = await service.transition(vendor, 'o1', { toStatus: 'PROCESSING' as never });
      expect(res.order).not.toHaveProperty('valuePaise');
      expect(res.order).not.toHaveProperty('pointsDeducted');
      expect(res.order).not.toHaveProperty('totalPointsCost');
      expect(res.order).not.toHaveProperty('conversionRateCenti');
      expect(res.order).not.toHaveProperty('metadata');
      expect(res.order).not.toHaveProperty('cancelReason');
      expect(res.order).toMatchObject({ id: 'o1', status: 'PROCESSING' });
    });

    it('transition BLOCKS a CLOSED (terminal) order (MED#4b)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', status: 'DELIVERED', partnerId: 'cp1', orderNumber: 'D-26-1' });
      await expect(
        service.transition(vendor, 'o1', { toStatus: 'PROCESSING' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
    });

    it('updateFulfilment BLOCKS a CLOSED (terminal) order (MED#4b)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', status: 'FAILED' });
      await expect(
        service.updateFulfilment(vendor, 'o1', { trackingNumber: 'TRK9' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
    });

    it('listOrders + getOrder EXCLUDE PENDING (pre-payment) orders (LOW#6)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      await service.listOrders(vendor);
      expect(mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where).toMatchObject({
        fulfilledByVendorId: 'v1',
        partner: { clientId: 'deoleo' },
        status: { not: RedemptionStatus.PENDING },
      });

      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
      await expect(service.getOrder(vendor, 'o1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.redemptionOrder.findFirst.mock.calls[0][0].where).toMatchObject({
        status: { not: RedemptionStatus.PENDING },
      });
    });

    // ── C2 (HIGH): flat row → display shape the FE consumes ──────────────────────
    const flatInWindowRow = () => ({
      id: 'o1', orderNumber: 'D-26-1', status: 'PROCESSING',
      redemptionMode: 'PHYSICAL_GIFT', quantity: 1,
      fulfilmentChannel: 'BRAND', logisticsPartner: null, supplierOrderRef: null,
      trackingNumber: null, trackingUrl: null, voucherCode: null, voucherProvider: null,
      podUrl: null, dispatchedAt: null, deliveredAt: null, cancelledAt: null,
      createdAt: new Date(), updatedAt: new Date(),
      deliveryName: 'Ravi Kumar', deliveryPhone: '9876543210',
      deliveryAddressLine1: '12 MG Road', deliveryAddressLine2: null,
      deliveryCity: 'Pune', deliveryState: 'MH', deliveryPincode: '411001',
      reward: { id: 'rw1', name: 'Bluetooth Speaker', imageUrls: [] },
      statusHistory: [],
    });

    it('getOrder MAPS the flat row → delivery.{name,address,phone} + rewardName (C2)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(flatInWindowRow());
      const res = await service.getOrder(vendor, 'o1');
      expect(res.delivery).toEqual({
        name: 'Ravi Kumar',
        address: '12 MG Road, Pune, MH, 411001',
        phone: '9876543210',
      });
      expect(res.rewardName).toBe('Bluetooth Speaker');
      // PRIVACY (#15): the 194R cost basis must never reach the vendor.
      expect(res).not.toHaveProperty('valuePaise');
      expect(res).not.toHaveProperty('pointsDeducted');
      expect(res).not.toHaveProperty('totalPointsCost');
      expect(res).not.toHaveProperty('sellingValuePaise');
      expect(res).not.toHaveProperty('metadata');
      expect(res).not.toHaveProperty('sourceType');
      expect(res).not.toHaveProperty('moderationStatus');
    });

    it('getOrder PAST the retention window → delivery null / piiWithheld (#16)', async () => {
      grantScope();
      const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...flatInWindowRow(),
        status: 'DELIVERED',
        deliveredAt: longAgo,
        updatedAt: longAgo,
        statusHistory: [{ toStatus: 'DELIVERED', createdAt: longAgo }],
      });
      const res = await service.getOrder(vendor, 'o1');
      expect(res.delivery).toBeNull();
      expect(res.piiWithheld).toBe(true);
      // Non-PII fields stay visible so the vendor still sees the order.
      expect(res.rewardName).toBe('Bluetooth Speaker');
    });

    it('listOrders MAPS rows → rewardName + delivery, no valuePaise (C2 + #15)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([flatInWindowRow()]);
      const res = await service.listOrders(vendor);
      expect(res.items[0].rewardName).toBe('Bluetooth Speaker');
      expect(res.items[0].delivery).toMatchObject({ name: 'Ravi Kumar' });
      expect(res.items[0]).not.toHaveProperty('valuePaise');
      expect(res.items[0]).not.toHaveProperty('totalPointsCost');
    });

    // ── BUG-1 (MED): digital voucher must carry a code before DELIVERED ──────────
    it('transition → DELIVERED on a DIGITAL_VOUCHER order WITHOUT a code is rejected (BUG-1)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'DISPATCHED', partnerId: 'cp1', orderNumber: 'D-26-1',
        fulfilmentChannel: 'DIGITAL_VOUCHER', voucherCode: null,
      });
      await expect(
        service.transition(vendor, 'o1', { toStatus: 'DELIVERED' as never }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
    });

    it('transition → DELIVERED on a DIGITAL_VOUCHER order SUCCEEDS with a code on the dto (BUG-1)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst
        .mockResolvedValueOnce({
          id: 'o1', status: 'DISPATCHED', partnerId: 'cp1', orderNumber: 'D-26-1',
          fulfilmentChannel: 'DIGITAL_VOUCHER', voucherCode: null,
        })
        .mockResolvedValueOnce({
          id: 'o1', status: 'DELIVERED', deliveredAt: new Date(), cancelledAt: null,
          updatedAt: new Date(), reward: null, statusHistory: [],
        });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'DELIVERED' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'm1', phone: '9', ownerName: 'A' });
      const res = await service.transition(vendor, 'o1', {
        toStatus: 'DELIVERED' as never,
        voucherCode: 'AMZ-1234',
      });
      expect(mockPrisma.redemptionOrder.update).toHaveBeenCalled();
      expect(res.order.status).toBe('DELIVERED');
    });

    it('transition → DELIVERED with a STORED voucher code (none on dto) SUCCEEDS (BUG-1)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst
        .mockResolvedValueOnce({
          id: 'o1', status: 'DISPATCHED', partnerId: 'cp1', orderNumber: 'D-26-1',
          fulfilmentChannel: 'DIGITAL_VOUCHER', voucherCode: 'STORED-9999',
        })
        .mockResolvedValueOnce({
          id: 'o1', status: 'DELIVERED', deliveredAt: new Date(), cancelledAt: null,
          updatedAt: new Date(), reward: null, statusHistory: [],
        });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'DELIVERED' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'm1', phone: '9', ownerName: 'A' });
      await service.transition(vendor, 'o1', { toStatus: 'DELIVERED' as never });
      expect(mockPrisma.redemptionOrder.update).toHaveBeenCalled();
    });
  });
});
