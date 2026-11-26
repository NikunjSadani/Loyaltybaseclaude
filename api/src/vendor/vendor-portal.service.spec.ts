import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RedemptionStatus } from '@prisma/client';
import { VendorPortalService } from './vendor-portal.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  // (tenant, code) advisory lock taken by voucher issuance (voucher-write-guard lockVoucherCode).
  $executeRaw: jest.fn().mockResolvedValue(1),
  // Tenant-wide cancelled-voucher reuse guard (voucher-write-guard.ts) — default: never cancelled.
  cancelledVoucherCode: { findFirst: jest.fn().mockResolvedValue(null), createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  vendor: { findFirst: jest.fn() },
  vendorTenantGrant: { findFirst: jest.fn() },
  giftCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  rewardCategory: { findFirst: jest.fn(), create: jest.fn() },
  rewardCatalog: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  redemptionOrder: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
  // programLabel + Hubble-eligibility reads (voucher issuance helpers).
  client: { findUnique: jest.fn(), findFirst: jest.fn() },
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
    // Status write = compare-and-set claim; wins by default (race tests override).
    mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.redemptionOrder.findUniqueOrThrow.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({ id: where.id }),
    );
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
      // CONTRACT GUARD: `isActive` MUST be in the select. The vendor item-editor picker
      // filters categories on `isActive`; omitting it (the original bug) made the FE read
      // `undefined` (falsy) and hide EVERY category, leaving the picker empty even though
      // categories existed and were returned.
      expect(mockPrisma.giftCategory.findMany.mock.calls[0][0].select).toEqual(
        expect.objectContaining({ isActive: true }),
      );
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

  describe('uploadCatalogue — memory-safety: only failed rows are echoed', () => {
    it('returns counts + the failed rows only (no per-row entry for created rows)', async () => {
      grantScope('AUTO_LIVE');
      mockPrisma.giftCategory.findFirst.mockResolvedValue({ id: 'gc1', code: 'ELEC', name: 'Electronics', imageUrl: null, sortOrder: 0 });
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'rc-cat-1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      mockPrisma.rewardCatalog.create.mockImplementation(async ({ data }: never) => ({ id: 'rcat-1', giftCategory: null, ...(data as object) }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const XLSX = require('xlsx');
      const ws = XLSX.utils.aoa_to_sheet([
        ['Name', 'Category Code', 'Selling Value (paise)', 'MRP (paise)', 'Description', 'Image URLs', 'Redemption Mode', 'Fulfilment Channel', 'Stock Quantity'],
        ['Earbuds', 'ELEC', 150000, 199900, '', '', 'PHYSICAL_GIFT', 'BRAND', ''],
        ['Speaker', '', 150000, 199900, '', '', 'PHYSICAL_GIFT', 'BRAND', ''], // missing category → fails
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Catalogue');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

      const res = await service.uploadCatalogue(vendor, { buffer } as Express.Multer.File);
      expect(res).toMatchObject({ total: 2, created: 1, failed: 1, problemRowCount: 1, problemRowsTruncated: false });
      expect(res).not.toHaveProperty('results');
      expect(res.problemRows).toEqual([{ rowIndex: expect.any(Number), error: 'Category Code is required' }]);
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
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    });

    it('transition can never refund a voucher order with an issued code (every refund edge rejected, no write)', async () => {
      grantScope();
      for (const toStatus of ['CANCELLED', 'RETURNED', 'FAILED']) {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
          id: 'o1', status: 'DISPATCHED', partnerId: 'cp1', orderNumber: 'D-26-1',
          voucherCode: 'AMZN-1234-5678', voucherProvider: 'Gifsy',
        });
        await expect(
          service.transition(vendor, 'o1', { toStatus: toStatus as never }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      ['CONFIRMED', 'PROCESSING', { metadata: { hubblePlaceAttemptAt: '2026-11-24T05:15:00.000Z' } }],
      ['PROCESSING', 'DISPATCHED', { voucherProvider: 'Hubble', metadata: { hubbleStatus: 'PROCESSING' } }],
      ['DISPATCHED', 'DELIVERED', { metadata: { hubbleOrderId: 'h1' } }],
    ])('audit L: a vendor can NOT move a Hubble-handed order without a code forward (%s → %s)', async (from, to, extra) => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: from, partnerId: 'cp1', orderNumber: 'D-26-1', voucherCode: null, ...extra,
      });
      await expect(service.transition(vendor, 'o1', { toStatus: to as never })).rejects.toThrow(
        "This voucher is being issued via API — a Gifsy admin can retry via API to fetch the code, or 'Fulfil manually'.",
      );
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    });

    it('transition CONFIRMED→PROCESSING succeeds without touching points/valuePaise', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'D-26-1' });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'PROCESSING' });
      await service.transition(vendor, 'o1', { toStatus: 'PROCESSING' as never });
      const data = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].data;
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
      expect(mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].data.dispatchedAt).toBeInstanceOf(Date);
      expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalled();
    });

    it('order-timeline D1: the vendor transition writes its history row via the shared status transition (same tx)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', status: 'PROCESSING', partnerId: 'cp1', orderNumber: 'D-26-1' });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'DISPATCHED' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      await service.transition(vendor, 'o1', { toStatus: 'DISPATCHED' as never, trackingNumber: 'TRK1', notes: 'n1' });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // Compare-and-set on the status READ (PROCESSING), re-pinned to this vendor.
      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', fulfilledByVendorId: 'v1', status: 'PROCESSING' },
        data: expect.objectContaining({ status: 'DISPATCHED', trackingNumber: 'TRK1', dispatchedAt: expect.any(Date) }),
      });
      expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledWith({
        data: { orderId: 'o1', fromStatus: 'PROCESSING', toStatus: 'DISPATCHED', changedById: 'vu1', notes: 'n1' },
      });
    });

    it('transition is idempotent (same status → skip)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', status: 'DISPATCHED', partnerId: 'cp1', orderNumber: 'D-26-1' });
      const res = await service.transition(vendor, 'o1', { toStatus: 'DISPATCHED' as never });
      expect((res as { skipped?: boolean }).skipped).toBe(true);
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
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
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    });

    it('updateFulfilment BLOCKS a CLOSED (terminal) order (MED#4b)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', status: 'FAILED' });
      await expect(
        service.updateFulfilment(vendor, 'o1', { trackingNumber: 'TRK9' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    });

    // VOUCHER WRITE INVARIANT (shared voucher-write-guard): a vendor can never clear / blank /
    // overwrite a stored code, nor write one on an unpaid order; a new code is a CAS.
    describe('voucher write invariant (vendor)', () => {
      const open = (extra: Record<string, unknown> = {}) => ({
        id: 'o1', status: 'PROCESSING', partnerId: 'cp1', orderNumber: 'D-26-1', pointsDeducted: 500,
        voucherCode: null, voucherProvider: null, fulfilledByVendorId: 'v1', ...extra,
      });
      afterEach(() => mockPrisma.redemptionOrder.findFirst.mockReset());

      it.each([
        ['clear (null)', { voucherCode: null }],
        ['blank', { voucherCode: '  ' }],
        ['overwrite', { voucherCode: 'OTHER-0000' }],
      ])('updateFulfilment %s on a stored code → 400, no write', async (_n, dto) => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open({ voucherCode: 'AMZ-STORED-1234', voucherProvider: 'Vendor' }));
        await expect(service.updateFulfilment(vendor, 'o1', dto as never)).rejects.toBeInstanceOf(BadRequestException);
        expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      });

      it('voucherFillable parity: true EXACTLY when the vendor updateFulfilment / transition would accept a PIN add', async () => {
        const base = open({ voucherCode: 'VEND-CODE-4321', voucherProvider: 'Croma', voucherPin: null, redemptionMode: 'GIFT_CARD', metadata: {} });
        const cases: Record<string, unknown>[] = [
          base,
          { ...base, status: 'CONFIRMED' },
          { ...base, status: 'DISPATCHED' },
          // Gifsy still fills a DELIVERED order; the vendor may not (closed to the vendor).
          { ...base, status: 'DELIVERED' },
          { ...base, status: 'RETURNED' },
          { ...base, status: 'FAILED' },
          { ...base, status: 'CANCELLED' },
          { ...base, pointsDeducted: 0 },
          { ...base, voucherProvider: 'Hubble' },
          { ...base, metadata: { hubbleStatus: 'SUCCESS' } },
          { ...base, redemptionMode: 'UPI' },
          { ...base, voucherCode: null },
        ];
        for (const row of cases) {
          for (const path of ['fulfilment', 'transition'] as const) {
            if (path === 'transition' && row.status !== 'DISPATCHED') continue; // DISPATCHED→DELIVERED is the one vendor PIN-carrying move tested here
            jest.clearAllMocks();
            mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
            grantScope();
            mockPrisma.redemptionOrder.findFirst.mockResolvedValue(row);
            const view = (await service.getOrder(vendor, 'o1')) as { voucherFillable: boolean };
            const attempt =
              path === 'fulfilment'
                ? service.updateFulfilment(vendor, 'o1', { voucherPin: '42' } as never)
                : service.transition(vendor, 'o1', { toStatus: 'DELIVERED', voucherPin: '42' } as never);
            await attempt.catch(() => undefined);
            const accepted = mockPrisma.redemptionOrder.updateMany.mock.calls.some(
              (c: unknown[]) => (c[0] as { data?: { voucherPin?: string } }).data?.voucherPin === '42',
            );
            expect({ status: row.status, path, fillable: view.voucherFillable }).toEqual({
              status: row.status,
              path,
              fillable: accepted,
            });
          }
        }
        // Sanity: the base (PROCESSING, paid, manual code, no PIN) is fillable.
        jest.clearAllMocks();
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(base);
        expect(((await service.getOrder(vendor, 'o1')) as { voucherFillable: boolean }).voucherFillable).toBe(true);
      });

      it('the vendor order view never carries pointsDeducted / metadata (selected only to derive voucherFillable)', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(
          open({ voucherCode: 'VEND-CODE-4321', metadata: { fulfilmentChannel: 'BRAND', hubbleStatus: null }, valuePaise: 50000 }),
        );
        const view = (await service.getOrder(vendor, 'o1')) as Record<string, unknown>;
        expect(view).not.toHaveProperty('pointsDeducted');
        expect(view).not.toHaveProperty('metadata');
        expect(view).not.toHaveProperty('valuePaise');
        expect(view).toHaveProperty('voucherFillable');
        const list = await (mockPrisma.redemptionOrder.findMany.mockResolvedValue([
          open({ voucherCode: 'VEND-CODE-4321', metadata: {} }),
        ]), service.listOrders(vendor));
        expect(list.items[0]).not.toHaveProperty('pointsDeducted');
        expect(list.items[0]).not.toHaveProperty('metadata');
      });

      it('updateFulfilment: a code on an unpaid order → 400, no write', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open({ pointsDeducted: 0 }));
        await expect(service.updateFulfilment(vendor, 'o1', { voucherCode: 'NEW-1' } as never))
          .rejects.toThrow(/only be issued on a confirmed, paid order/);
        expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      });

      it('updateFulfilment: a NEW code carries the voucher CAS alongside the vendor scope', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open());
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        await service.updateFulfilment(vendor, 'o1', { voucherCode: 'NEW-1' } as never);
        const { where, data } = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
        expect(data.voucherCode).toBe('NEW-1');
        expect(where.fulfilledByVendorId).toBe('v1');
        expect(where.AND).toEqual(expect.arrayContaining([{ OR: [{ voucherCode: null }, { voucherCode: '' }] }]));
      });

      it('updateFulfilment: a NEW code writes a masked AuditLog row and sends the member VOUCHER_ISSUED', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open());
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.redemptionOrder.findUnique.mockResolvedValueOnce({
          voucherCode: 'VEND-CODE-4321', valuePaise: 50000n, orderNumber: 'D-26-1',
          reward: { name: 'Amazon 500' }, partner: { userId: 'm1', phone: '9', ownerName: 'A' },
        });
        mockPrisma.client.findUnique.mockResolvedValueOnce({ branding: { displayName: 'Bajaj' }, internalName: 'bajaj' });
        await service.updateFulfilment(vendor, 'o1', { voucherCode: 'VEND-CODE-4321' } as never);
        const audit = mockPrisma.auditLog.create.mock.calls.find((c) => c[0]?.data?.metadata?.event === 'VOUCHER_ISSUED_MANUAL')?.[0];
        expect(audit?.data).toMatchObject({ actorId: vendor.sub, entityId: 'o1' });
        expect(audit?.data.metadata).toMatchObject({ path: 'PATCH /vendor/orders/:id/fulfilment', voucherCode: '••••4321' });
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledWith(
          expect.objectContaining({ eventKey: 'VOUCHER_ISSUED', userId: 'm1' }),
        );
      });

      it('updateFulfilment: a card number + PIN lands in the same guarded write; the member is told both; the PIN is never audited', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open());
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.redemptionOrder.findUnique.mockResolvedValueOnce({
          voucherCode: '6001220012345678', voucherPin: '482913', valuePaise: 50000n, orderNumber: 'D-26-1',
          reward: { name: 'Croma 500' }, partner: { userId: 'm1', phone: '9', ownerName: 'A' },
        });
        mockPrisma.client.findUnique.mockResolvedValueOnce({ branding: { displayName: 'Bajaj' }, internalName: 'bajaj' });
        await service.updateFulfilment(vendor, 'o1', { voucherCode: '6001220012345678', voucherPin: ' 482913 ' } as never);
        const { data } = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
        expect(data).toMatchObject({ voucherCode: '6001220012345678', voucherPin: '482913' });
        expect(JSON.stringify(mockPrisma.auditLog.create.mock.calls)).not.toContain('482913');
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledWith(expect.objectContaining({
          eventKey: 'VOUCHER_ISSUED',
          body: 'Your Croma 500 voucher is ready — card no. and PIN are in My Orders.',
          vars: expect.objectContaining({ code: '6001220012345678 | PIN: 482913' }),
          maskedVars: { code: '6001220012345678' },
        }));
      });

      it('updateFulfilment: SET-ONCE — a PIN added to the issued code is guarded on a null PIN, audited masked, and re-sends the voucher', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open({ status: 'DISPATCHED', voucherCode: 'VEND-CODE-4321', voucherPin: null }));
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.redemptionOrder.findUnique.mockResolvedValueOnce({
          voucherCode: 'VEND-CODE-4321', voucherPin: '7788', valuePaise: 50000n, orderNumber: 'D-26-1',
          reward: { name: 'Croma 500' }, partner: { userId: 'm1', phone: '9', ownerName: 'A' },
        });
        mockPrisma.client.findUnique.mockResolvedValueOnce({ branding: { displayName: 'Bajaj' }, internalName: 'bajaj' });
        await service.updateFulfilment(vendor, 'o1', { voucherPin: '7788' } as never);
        const { where, data } = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
        expect(data).toMatchObject({ voucherPin: '7788' });
        expect(data).not.toHaveProperty('voucherCode');
        expect(where.AND).toEqual(expect.arrayContaining([{ voucherCode: 'VEND-CODE-4321' }, { voucherPin: null }]));
        const audit = mockPrisma.auditLog.create.mock.calls.find((c) => c[0]?.data?.metadata?.event === 'VOUCHER_PIN_ADDED_MANUAL')?.[0];
        expect(audit?.data.metadata).toMatchObject({ voucherCode: '••••4321', voucherPin: '••••' });
        expect(JSON.stringify(mockPrisma.auditLog.create.mock.calls)).not.toContain('7788');
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledWith(expect.objectContaining({ eventKey: 'VOUCHER_ISSUED' }));
      });

      it('updateFulfilment: changing a saved PIN → 400 PIN-specific, no write', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open({ voucherCode: 'VEND-CODE-4321', voucherPin: '7788' }));
        await expect(service.updateFulfilment(vendor, 'o1', { voucherPin: '1111' } as never))
          .rejects.toThrow('A PIN is already saved for this voucher');
        expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      });

      it('updateFulfilment: a PIN without a card number → 400, no write', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open());
        await expect(service.updateFulfilment(vendor, 'o1', { voucherPin: '4829' } as never))
          .rejects.toThrow('Enter the card number before the PIN');
        expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      });

      it('same-status transition WITH a new code applies it via the guarded updateFulfilment (not dropped)', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open({ status: 'PROCESSING' }));
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        const res = await service.transition(vendor, 'o1', { toStatus: 'PROCESSING', voucherCode: 'SAME-STATUS-1' } as never);
        expect(res.skipped).toBe(true);
        const { where, data } = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
        expect(data.voucherCode).toBe('SAME-STATUS-1');
        expect(where.fulfilledByVendorId).toBe('v1');
        expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
      });

      it('same-status transition with ONLY tracking applies it via updateFulfilment (not dropped)', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open({ status: 'DISPATCHED' }));
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        const res = await service.transition(vendor, 'o1', { toStatus: 'DISPATCHED', trackingNumber: 'TRK-V', trackingUrl: 'https://t/v' } as never);
        expect(res.skipped).toBe(true);
        expect(mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].data).toMatchObject({ trackingNumber: 'TRK-V', trackingUrl: 'https://t/v' });
      });

      it('a code cancelled elsewhere in the tenant is refused for a vendor too', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open());
        mockPrisma.cancelledVoucherCode.findFirst.mockResolvedValueOnce({ id: 'cv' });
        await expect(service.updateFulfilment(vendor, 'o1', { voucherCode: 'OLD-1' } as never)).rejects.toThrow(/can't be reused/);
        expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      });

      it('updateFulfilment: a Hubble-managed order refuses a vendor code', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open({ metadata: { hubbleStatus: 'PROCESSING' } }));
        await expect(service.updateFulfilment(vendor, 'o1', { voucherCode: 'NEW-1' } as never)).rejects.toThrow(/issuance via API/);
        expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      });

      it('B1: transition that ADDS a PIN sends BOTH the re-sent voucher AND the ORDER_DELIVERED milestone (with tracking)', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(
          open({ status: 'DISPATCHED', voucherCode: 'VEND-CODE-4321', voucherPin: null, fulfilmentChannel: 'DIGITAL_VOUCHER' }),
        );
        mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValue({ id: 'o1', status: 'DELIVERED' });
        mockPrisma.redemptionOrder.findUnique.mockResolvedValueOnce({
          voucherCode: 'VEND-CODE-4321', voucherPin: '7788', valuePaise: 50000n, orderNumber: 'D-26-1',
          reward: { name: 'Croma 500' }, partner: { userId: 'm1', phone: '9', ownerName: 'A' },
        });
        mockPrisma.client.findUnique.mockResolvedValueOnce({ branding: { displayName: 'Bajaj' }, internalName: 'bajaj' });
        mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'm1', phone: '9', ownerName: 'A' });
        await service.transition(vendor, 'o1', { toStatus: 'DELIVERED', voucherPin: '7788', trackingNumber: 'TRK-1' } as never);
        const events = mockNotifications.notifyUserWithChannels.mock.calls.map((c) => c[0].eventKey);
        expect(events).toEqual(expect.arrayContaining(['VOUCHER_ISSUED', 'ORDER_DELIVERED']));
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledWith(
          expect.objectContaining({ eventKey: 'ORDER_DELIVERED', vars: expect.objectContaining({ trackingId: 'TRK-1' }) }),
        );
      });

      it('B1: transition that issues a NEW code still sends only VOUCHER_ISSUED (milestone suppressed)', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open({ status: 'PROCESSING' }));
        mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValue({ id: 'o1', status: 'DISPATCHED' });
        mockPrisma.redemptionOrder.findUnique.mockResolvedValueOnce({
          voucherCode: 'NEW-CODE-1', valuePaise: 50000n, orderNumber: 'D-26-1',
          reward: { name: 'Amazon 500' }, partner: { userId: 'm1', phone: '9', ownerName: 'A' },
        });
        mockPrisma.client.findUnique.mockResolvedValueOnce({ branding: { displayName: 'Bajaj' }, internalName: 'bajaj' });
        mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'm1', phone: '9', ownerName: 'A' });
        await service.transition(vendor, 'o1', { toStatus: 'DISPATCHED', voucherCode: 'NEW-CODE-1' } as never);
        const events = mockNotifications.notifyUserWithChannels.mock.calls.map((c) => c[0].eventKey);
        expect(events).toEqual(['VOUCHER_ISSUED']);
      });

      it('B4: a double-submitted identical PIN — the loser re-reads the same PIN and succeeds as a no-op (no audit, no notify)', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst
          .mockResolvedValueOnce(open({ status: 'DISPATCHED', voucherCode: 'VEND-CODE-4321', voucherPin: null }))
          .mockResolvedValueOnce(open({ status: 'DISPATCHED', voucherCode: 'VEND-CODE-4321', voucherPin: '7788' }))
          .mockResolvedValue(open({ status: 'DISPATCHED', voucherCode: 'VEND-CODE-4321', voucherPin: '7788' }));
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
        mockPrisma.redemptionOrder.findUnique.mockResolvedValueOnce({ voucherCode: 'VEND-CODE-4321', voucherPin: '7788' });
        await expect(service.updateFulfilment(vendor, 'o1', { voucherPin: '7788' } as never)).resolves.toBeDefined();
        expect(mockPrisma.redemptionOrder.updateMany.mock.calls[1][0].data).not.toHaveProperty('voucherPin');
        expect(mockPrisma.auditLog.create.mock.calls.some((c) => c[0]?.data?.metadata?.event === 'VOUCHER_PIN_ADDED_MANUAL')).toBe(false);
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
      });

      it('B4: losing to a DIFFERENT PIN stays a 409', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open({ status: 'DISPATCHED', voucherCode: 'VEND-CODE-4321', voucherPin: null }));
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });
        mockPrisma.redemptionOrder.findUnique.mockResolvedValueOnce({ voucherCode: 'VEND-CODE-4321', voucherPin: '1111' });
        await expect(service.updateFulfilment(vendor, 'o1', { voucherPin: '7788' } as never)).rejects.toBeInstanceOf(ConflictException);
      });

      it('a coded order MAY switch to a physical channel (physical gift cards carry codes) — no voucher claim', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open({ voucherCode: 'VEND-CODE-4321', fulfilmentChannel: 'DIGITAL_VOUCHER' }));
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        await service.updateFulfilment(vendor, 'o1', { fulfilmentChannel: 'BRAND' } as never).catch(() => undefined);
        const call = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
        expect(call.data).toMatchObject({ fulfilmentChannel: 'BRAND' });
        expect(call.data).not.toHaveProperty('voucherCode');
        expect(JSON.stringify(call.where)).not.toContain('voucherCode');
      });

      it.each([
        ['clear (null)', { voucherCode: null }],
        ['overwrite', { voucherCode: 'OTHER-0000' }],
      ])('transition → DELIVERED with %s on a stored code → 400, no write', async (_n, extra) => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(open({ status: 'DISPATCHED', voucherCode: 'AMZ-STORED-1234' }));
        await expect(service.transition(vendor, 'o1', { toStatus: 'DELIVERED', ...extra } as never))
          .rejects.toBeInstanceOf(BadRequestException);
        expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      });
    });

    // Concurrency: the open/assigned checks come from a read; the write must re-assert them
    // atomically so a close / reassignment that lands between read and write is never overwritten.
    describe('updateFulfilment guarded write (read-then-write race)', () => {
      const dto = { trackingNumber: 'TRK9' } as never;

      it('writes via a CAS that re-asserts open + this vendor + this tenant', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst
          .mockResolvedValueOnce({ id: 'o1', status: 'PROCESSING' }) // the pre-check read
          .mockResolvedValueOnce({ id: 'o1', status: 'PROCESSING' }); // getOrder re-read
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        await service.updateFulfilment(vendor, 'o1', dto);
        expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
        expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledTimes(1);
        const { where, data } = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
        expect(where).toEqual({
          id: 'o1',
          fulfilledByVendorId: 'v1',
          partner: { clientId: 'deoleo' },
          status: {
            notIn: expect.arrayContaining(['DELIVERED', 'RETURNED', 'CANCELLED', 'FAILED', 'PENDING']),
          },
        });
        expect(data).toMatchObject({ trackingNumber: 'TRK9' });
      });

      // Evaluate the write's where-clause against the row's CURRENT (post-race) state.
      const rowNow = (row: { status: string; fulfilledByVendorId: string; clientId: string }) =>
        async ({ where }: {
          where: { fulfilledByVendorId?: string; partner?: { clientId: string }; status?: { notIn?: string[] } };
        }) => {
          const ok =
            (where.fulfilledByVendorId === undefined || where.fulfilledByVendorId === row.fulfilledByVendorId) &&
            (where.partner === undefined || where.partner.clientId === row.clientId) &&
            !(where.status?.notIn ?? []).includes(row.status);
          return { count: ok ? 1 : 0 };
        };

      it('order CLOSED concurrently (open on read, now DELIVERED) → 409, no write applied, no re-read', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce({ id: 'o1', status: 'DISPATCHED' });
        mockPrisma.redemptionOrder.updateMany.mockImplementationOnce(
          rowNow({ status: 'DELIVERED', fulfilledByVendorId: 'v1', clientId: 'deoleo' }),
        );
        const err = await service.updateFulfilment(vendor, 'o1', dto).catch((e) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.message).toBe('Order status changed — refresh and try again');
        expect(mockPrisma.redemptionOrder.findFirst).toHaveBeenCalledTimes(1);
      });

      it('order REASSIGNED to another vendor concurrently (now v2) → 409', async () => {
        grantScope();
        mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce({ id: 'o1', status: 'CONFIRMED' });
        mockPrisma.redemptionOrder.updateMany.mockImplementationOnce(
          rowNow({ status: 'CONFIRMED', fulfilledByVendorId: 'v2', clientId: 'deoleo' }),
        );
        await expect(service.updateFulfilment(vendor, 'o1', dto)).rejects.toBeInstanceOf(ConflictException);
      });
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
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    });

    it('transition → DELIVERED on a DIGITAL_VOUCHER order SUCCEEDS with a code on the dto (BUG-1)', async () => {
      grantScope();
      mockPrisma.redemptionOrder.findFirst
        .mockResolvedValueOnce({
          id: 'o1', status: 'DISPATCHED', partnerId: 'cp1', orderNumber: 'D-26-1',
          fulfilmentChannel: 'DIGITAL_VOUCHER', voucherCode: null, pointsDeducted: 500,
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
      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalled();
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
      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalled();
    });

    // ── Race guard: compare-and-set on the status the vendor READ ────────────────
    describe('compare-and-set race guard', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let row: Record<string, any>;
      afterEach(() => {
        mockPrisma.redemptionOrder.findFirst.mockReset();
        mockPrisma.redemptionOrder.updateMany.mockReset();
      });
      const installOrderRow = (initial: Record<string, unknown>) => {
        row = { ...initial };
        const snapshot = { ...initial };
        // Every pre-tx read (transition lookup AND the post-write getOrder projection) sees
        // the same stale snapshot; only updateMany consults the LIVE row.
        mockPrisma.redemptionOrder.findFirst.mockImplementation(async () => ({
          ...snapshot, updatedAt: new Date(), reward: null, statusHistory: [],
        }));
        mockPrisma.redemptionOrder.updateMany.mockImplementation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async ({ where, data }: { where: any; data: Record<string, unknown> }) => {
            if (where.id !== row.id) return { count: 0 };
            if ('status' in where && where.status !== row.status) return { count: 0 };
            if ('fulfilledByVendorId' in where && where.fulfilledByVendorId !== row.fulfilledByVendorId) {
              return { count: 0 };
            }
            for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
            return { count: 1 };
          },
        );
      };
      const vendorOrder = (status: string) => ({
        id: 'o1', status, partnerId: 'cp1', orderNumber: 'D-26-1', fulfilledByVendorId: 'v1',
      });

      it('two concurrent DISPATCHED (double click) → exactly one wins, loser 409, ONE history row + ONE notification', async () => {
        grantScope();
        installOrderRow(vendorOrder('PROCESSING'));
        mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'm1', phone: '9', ownerName: 'A' });

        const results = await Promise.allSettled([
          service.transition(vendor, 'o1', { toStatus: 'DISPATCHED' as never }),
          service.transition(vendor, 'o1', { toStatus: 'DISPATCHED' as never }),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        expect(lost).toHaveLength(1);
        expect(lost[0].reason).toBeInstanceOf(ConflictException);
        expect(lost[0].reason.getStatus()).toBe(409);
        expect(lost[0].reason.message).toBe('Order status changed — refresh and try again');
        expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledTimes(1);
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
        expect(row.status).toBe('DISPATCHED');
      });

      it('a STALE read (Gifsy cancelled the order meanwhile) → 409, no write, no history, no notification', async () => {
        grantScope();
        installOrderRow(vendorOrder('PROCESSING'));
        row.status = 'CANCELLED'; // moved by Gifsy after the vendor's read

        await expect(
          service.transition(vendor, 'o1', { toStatus: 'DISPATCHED' as never }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(row.status).toBe('CANCELLED');
        expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
      });

      it('an order RE-ASSIGNED to another vendor after the read → 409 (claim re-pinned to this vendor)', async () => {
        grantScope();
        installOrderRow(vendorOrder('PROCESSING'));
        row.fulfilledByVendorId = 'v2';

        await expect(
          service.transition(vendor, 'o1', { toStatus: 'DISPATCHED' as never }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(row.status).toBe('PROCESSING');
        expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
      });
    });
  });
});
