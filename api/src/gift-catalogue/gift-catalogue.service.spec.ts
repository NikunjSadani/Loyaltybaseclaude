import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { GiftCatalogueService } from './gift-catalogue.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  giftCategory: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  giftMaster: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
  rewardCategory: { findFirst: jest.fn(), create: jest.fn() },
  rewardCatalog: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  client: { findMany: jest.fn(), findUnique: jest.fn() },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: jest.fn((arg: any) =>
    Array.isArray(arg) ? Promise.all(arg) : arg(mockPrisma),
  ),
};

let rate = 1;
const mockTenantSettings = { getConversionRate: jest.fn(async () => rate) };

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9990001111', name: '' };
const partner: JwtPayload = { sub: 'u1', role: 'RETAILER', clientId: 'deoleo', phone: '9991112222', name: '' };

describe('GiftCatalogueService', () => {
  let service: GiftCatalogueService;

  beforeEach(async () => {
    jest.clearAllMocks();
    rate = 1;
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        GiftCatalogueService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
      ],
    }).compile();
    service = mod.get(GiftCatalogueService);
  });

  describe('data-boundary guard', () => {
    it('rejects a non-operator at the service layer', async () => {
      await expect(service.listMasters(partner, {})).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.createMaster(partner, {} as never)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.publish(partner, 'm1', { publications: [] } as never)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('derivePointsCost (₹ → points; value = points ÷ rate)', () => {
    it('points = ₹ × rate', () => {
      expect(service.derivePointsCost(50000, 1)).toBe(500); // ₹500 × 1
      expect(service.derivePointsCost(50000, 2)).toBe(1000); // ₹500 × 2
    });
    it('rate 0 → 0 (guarded)', () => {
      expect(service.derivePointsCost(50000, 0)).toBe(0);
    });
  });

  describe('publish — first publish to a tenant', () => {
    const master = {
      id: 'm1',
      status: 'ACTIVE',
      categoryId: 'gc1',
      code: 'GIFT-TV',
      name: 'Smart TV',
      description: 'desc',
      imageUrls: ['https://x/y.png'],
      mrpPaise: 6000000,
      redemptionMode: 'PHYSICAL_GIFT',
      termsAndConditions: 'tnc',
      stockQuantity: 10,
      category: { code: 'ELEC', name: 'Electronics', imageUrl: null, sortOrder: 0 },
    };

    it('creates a PLATFORM catalog row with derived pointsCost + APPROVED moderation', async () => {
      rate = 2;
      mockPrisma.giftMaster.findFirst.mockResolvedValue(master);
      mockPrisma.rewardCategory.findFirst.mockResolvedValue(null); // no mirrored category yet
      mockPrisma.rewardCategory.create.mockResolvedValue({ id: 'rc-cat-1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null); // no existing row, no code clash
      mockPrisma.rewardCatalog.create.mockImplementation(async ({ data }: never) => ({ id: 'rcat-1', ...(data as object) }));

      const res = await service.publish(gifsy, 'm1', {
        publications: [{ clientId: 'deoleo', sellingValuePaise: 50000 }],
      });

      const call = mockPrisma.rewardCatalog.create.mock.calls[0][0];
      expect(call.data).toMatchObject({
        clientId: 'deoleo',
        sourceType: 'PLATFORM',
        moderationStatus: 'APPROVED',
        giftMasterId: 'm1',
        giftCategoryId: 'gc1',
        categoryId: 'rc-cat-1',
        sellingValuePaise: 50000,
        pointsCost: 1000, // ₹500 × rate 2
        code: 'GIFT-TV',
      });
      expect(res.published).toBe(1);
      expect(res.failed).toBe(0);
    });

    it('requires sellingValuePaise on the first publish', async () => {
      mockPrisma.giftMaster.findFirst.mockResolvedValue(master);
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'rc-cat-1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);

      const res = await service.publish(gifsy, 'm1', { publications: [{ clientId: 'deoleo' }] });
      expect(res.failed).toBe(1);
      expect(res.results[0].error).toMatch(/sellingValuePaise is required/);
    });
  });

  describe('publish — re-publish is the PRICE EDITOR (operator-set price applies)', () => {
    const republishMaster = {
      id: 'm1', status: 'ACTIVE', categoryId: 'gc1', code: 'GIFT-TV', name: 'Smart TV v2',
      description: 'new', imageUrls: [], mrpPaise: 1, redemptionMode: 'PHYSICAL_GIFT',
      termsAndConditions: 't', stockQuantity: 5,
      category: { code: 'ELEC', name: 'Electronics', imageUrl: null, sortOrder: 0 },
    };

    it('re-publish refreshes CONTENT + applies an EXPLICIT price; PRESERVES pointsCost when omitted (no silent re-price)', async () => {
      // AUDIT FIX (#3): with pointsCost OMITTED, the stored pointsCost is PRESERVED — it is
      // NOT silently re-derived from the current rate (which would shift the member price on
      // any rate drift). An explicit sellingValuePaise is still applied (the price editor).
      rate = 3; // a rate change since first publish — must NOT move pointsCost
      mockPrisma.giftMaster.findFirst.mockResolvedValue(republishMaster);
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'rc-cat-1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'rcat-1', status: 'ACTIVE', sellingValuePaise: 50000, pointsCost: 500 });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'rcat-1', sellingValuePaise: 99999, pointsCost: 500 });

      const res = await service.publish(gifsy, 'm1', {
        publications: [{ clientId: 'deoleo', sellingValuePaise: 99999 }],
      });

      const call = mockPrisma.rewardCatalog.update.mock.calls[0][0];
      expect(call.data).toMatchObject({
        name: 'Smart TV v2',
        description: 'new',
        sellingValuePaise: 99999,
        pointsCost: 500, // PRESERVED (existing) — NOT re-derived to 999.99 × 3
      });
      // An ACTIVE row is NOT force-re-activated (no status forced).
      expect(call.data.status).toBeUndefined();
      expect(res.results[0].action).toBe('updated');
    });

    it('re-publish APPLIES an explicitly-sent pointsCost', async () => {
      rate = 1;
      mockPrisma.giftMaster.findFirst.mockResolvedValue(republishMaster);
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'rc-cat-1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'rcat-1', status: 'ACTIVE', sellingValuePaise: 50000, pointsCost: 500 });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'rcat-1' });

      await service.publish(gifsy, 'm1', {
        publications: [{ clientId: 'deoleo', sellingValuePaise: 70000, pointsCost: 777 }],
      });

      const call = mockPrisma.rewardCatalog.update.mock.calls[0][0];
      expect(call.data).toMatchObject({ sellingValuePaise: 70000, pointsCost: 777 });
    });

    it('re-publishing a previously-UNPUBLISHED (DISCONTINUED) row RE-ACTIVATES it', async () => {
      rate = 1;
      mockPrisma.giftMaster.findFirst.mockResolvedValue(republishMaster);
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'rc-cat-1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'rcat-1', status: 'DISCONTINUED', sellingValuePaise: 50000, pointsCost: 500 });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'rcat-1' });

      await service.publish(gifsy, 'm1', { publications: [{ clientId: 'deoleo', sellingValuePaise: 50000 }] });

      const call = mockPrisma.rewardCatalog.update.mock.calls[0][0];
      expect(call.data.status).toBe('ACTIVE'); // DISCONTINUED → ACTIVE on re-publish
    });

    it('does NOT un-hide a paused OUT_OF_STOCK row on re-publish', async () => {
      rate = 1;
      mockPrisma.giftMaster.findFirst.mockResolvedValue(republishMaster);
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'rc-cat-1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'rcat-1', status: 'OUT_OF_STOCK', sellingValuePaise: 50000, pointsCost: 500 });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'rcat-1' });

      await service.publish(gifsy, 'm1', { publications: [{ clientId: 'deoleo', sellingValuePaise: 50000 }] });

      const call = mockPrisma.rewardCatalog.update.mock.calls[0][0];
      expect(call.data.status).toBeUndefined(); // OUT_OF_STOCK left untouched (not force-ACTIVE)
    });

    it('unpublishClientIds DISCONTINUE the tenant row (in-flight orders keep their FK)', async () => {
      const master = {
        id: 'm1', status: 'ACTIVE', categoryId: 'gc1', code: 'GIFT-TV', name: 'TV',
        description: '', imageUrls: [], mrpPaise: 1, redemptionMode: 'PHYSICAL_GIFT',
        termsAndConditions: '', stockQuantity: 5,
        category: { code: 'ELEC', name: 'Electronics', imageUrl: null, sortOrder: 0 },
      };
      mockPrisma.giftMaster.findFirst.mockResolvedValue(master);
      mockPrisma.rewardCatalog.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.publish(gifsy, 'm1', {
        publications: [],
        unpublishClientIds: ['deoleo'],
      });

      expect(mockPrisma.rewardCatalog.updateMany).toHaveBeenCalledWith({
        where: { clientId: 'deoleo', giftMasterId: 'm1', deletedAt: null },
        data: { status: 'DISCONTINUED' },
      });
      expect(res.unpublished).toBe(1);
    });
  });

  describe('archiveMaster hides published rows', () => {
    it('sets ARCHIVED + DISCONTINUEs its catalog rows', async () => {
      mockPrisma.giftMaster.findFirst.mockResolvedValue({ id: 'm1', status: 'ACTIVE' });
      mockPrisma.giftMaster.update.mockResolvedValue({ id: 'm1', status: 'ARCHIVED' });
      mockPrisma.rewardCatalog.updateMany.mockResolvedValue({ count: 3 });

      const res = await service.archiveMaster(gifsy, 'm1');
      expect(mockPrisma.rewardCatalog.updateMany).toHaveBeenCalledWith({
        where: { giftMasterId: 'm1', deletedAt: null },
        data: { status: 'DISCONTINUED' },
      });
      expect(res.hiddenRows).toBe(3);
    });
  });

  describe('getPublishMatrix excludes the Gifsy operator tenant', () => {
    it('never lists clientId "gifsy" as a candidate publish target', async () => {
      mockPrisma.giftMaster.findFirst.mockResolvedValue({ id: 'm1' });
      mockPrisma.client.findMany.mockResolvedValue([{ id: 'deoleo', internalName: 'Deoleo' }]);
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([]);

      await service.getPublishMatrix(gifsy, 'm1');

      const where = mockPrisma.client.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ status: 'ACTIVE', id: { not: 'gifsy' } });
    });
  });
});
