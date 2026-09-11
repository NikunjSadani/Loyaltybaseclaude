import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GiftCatalogueService } from './gift-catalogue.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { StorageService } from '../storage/storage.service';
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

const mockStorage = {
  generateKey: jest.fn((folder: string, name: string) => `${folder}/2026-09/uuid-${name}`),
  uploadFile: jest.fn(async (_buf: Buffer, key: string) => `https://storage.googleapis.com/gifsy-platform-files/${key}`),
  downloadBytes: jest.fn(async (_key: string) => ({ bytes: PNG_BYTES, contentType: 'image/png' })),
};

/** Minimal valid image bytes (PNG magic) for the sniff-passing upload tests. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const makeFile = (buffer: Buffer, size = buffer.length, originalname = 'gift.png'): Express.Multer.File =>
  ({ buffer, size, originalname } as Express.Multer.File);

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9990001111', name: '' };
const partner: JwtPayload = { sub: 'u1', role: 'RETAILER', clientId: 'deoleo', phone: '9991112222', name: '' };
const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '9992223333', name: '' };
const otherAdmin: JwtPayload = { sub: 'ca2', role: 'CLIENT_ADMIN', clientId: 'acme', phone: '9993334444', name: '' };

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
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();
    service = mod.get(GiftCatalogueService);
  });

  describe('uploadGiftImage (private store + proxy path — sniff + 5 MB cap)', () => {
    it('stores a GIFSY (master) image under _platform/ and returns the proxy path', async () => {
      const res = await service.uploadGiftImage(gifsy, makeFile(PNG_BYTES));
      expect(mockStorage.generateKey).toHaveBeenCalledWith('gift-catalogue/_platform', 'gift.png');
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(PNG_BYTES, expect.stringContaining('gift-catalogue/_platform/'), 'image/png');
      // Returns an auth-gated proxy path, NOT a raw bucket URL (the bucket is private).
      expect(res.url).toMatch(/^\/api\/gift-images\?key=/);
      expect(res.url).not.toContain('storage.googleapis.com');
      expect(decodeURIComponent(res.url)).toContain('gift-catalogue/_platform/');
    });

    it('folds a CLIENT_ADMIN image under its own <clientId>/ folder', async () => {
      const res = await service.uploadGiftImage(clientAdmin, makeFile(PNG_BYTES));
      expect(mockStorage.generateKey).toHaveBeenCalledWith('gift-catalogue/deoleo', 'gift.png');
      expect(decodeURIComponent(res.url)).toContain('gift-catalogue/deoleo/');
    });

    it('rejects a missing / empty file', async () => {
      await expect(service.uploadGiftImage(gifsy, undefined as never)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.uploadGiftImage(gifsy, makeFile(Buffer.alloc(0)))).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects a file over the 5 MB cap', async () => {
      await expect(
        service.uploadGiftImage(gifsy, makeFile(PNG_BYTES, 5 * 1024 * 1024 + 1)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects a non-image masquerade (PDF magic bytes) — images only', async () => {
      const pdf = Buffer.from('%PDF-1.7\n', 'latin1');
      await expect(service.uploadGiftImage(gifsy, makeFile(pdf))).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects bytes that sniff to nothing (HTML/script payload)', async () => {
      const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
      await expect(service.uploadGiftImage(gifsy, makeFile(html))).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });
  });

  describe('serveGiftImage (private stream + tenant fence)', () => {
    it('streams a _platform image to any authenticated user (cacheable), capped at 5 MB', async () => {
      const res = await service.serveGiftImage(partner, 'gift-catalogue/_platform/2026-09/uuid-gift.png');
      expect(res.contentType).toBe('image/png');
      expect(res.cachePublic).toBe(true);
      expect(mockStorage.downloadBytes).toHaveBeenCalledWith('gift-catalogue/_platform/2026-09/uuid-gift.png', 5 * 1024 * 1024);
    });

    it('streams a tenant image to its OWN tenant (NOT cacheable)', async () => {
      const res = await service.serveGiftImage(clientAdmin, 'gift-catalogue/deoleo/2026-09/uuid-gift.png');
      expect(res.contentType).toBe('image/png');
      expect(res.cachePublic).toBe(false);
    });

    it('404s a traversal / malformed key before any storage read (defense-in-depth)', async () => {
      for (const bad of [
        'gift-catalogue/_platform/../../kyc/deoleo/2026-09/pan.jpg', // traversal disguised under _platform
        'gift-catalogue//2026-09/x.png', // empty scope segment
        'gift-catalogue/_platform/2026-09/x.png\\..\\y', // backslash
        'gift-catalogue/_platform', // too few segments
      ]) {
        await expect(service.serveGiftImage(gifsy, bad)).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });

    it('lets an un-assumed GIFSY operator read any tenant image', async () => {
      const res = await service.serveGiftImage(gifsy, 'gift-catalogue/deoleo/2026-09/uuid-gift.png');
      expect(res.contentType).toBe('image/png');
    });

    it('404s a cross-tenant read (tenant fence)', async () => {
      await expect(
        service.serveGiftImage(otherAdmin, 'gift-catalogue/deoleo/2026-09/uuid-gift.png'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });

    it('404s any key outside the gift-catalogue prefix (no arbitrary-object read)', async () => {
      await expect(
        service.serveGiftImage(gifsy, 'kyc/deoleo/2026-09/pan.jpg'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.downloadBytes).not.toHaveBeenCalled();
    });

    it('404s a missing object', async () => {
      mockStorage.downloadBytes.mockResolvedValueOnce(null as never);
      await expect(
        service.serveGiftImage(gifsy, 'gift-catalogue/_platform/2026-09/uuid-missing.png'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a stored object whose type is not renderable', async () => {
      mockStorage.downloadBytes.mockResolvedValueOnce({ bytes: PNG_BYTES, contentType: 'application/pdf' } as never);
      await expect(
        service.serveGiftImage(gifsy, 'gift-catalogue/_platform/2026-09/uuid-x.pdf'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
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

    it('re-publish with NO price at all preserves BOTH stored sellingValuePaise and pointsCost (rate drift ignored)', async () => {
      // C-2: the publication omits BOTH sellingValuePaise and pointsCost. The stored
      // price falls back (existing.sellingValuePaise) and the stored pointsCost is
      // PRESERVED verbatim — never re-derived from the current conversion rate. Also
      // proves an ACTIVE row is not force-reactivated.
      rate = 5; // large rate drift since first publish — must NOT move pointsCost
      mockPrisma.giftMaster.findFirst.mockResolvedValue(republishMaster);
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'rc-cat-1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'rcat-1', status: 'ACTIVE', sellingValuePaise: 50000, pointsCost: 500,
      });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'rcat-1', sellingValuePaise: 50000, pointsCost: 500 });

      const res = await service.publish(gifsy, 'm1', {
        publications: [{ clientId: 'deoleo' }], // no sellingValuePaise, no pointsCost
      });

      const call = mockPrisma.rewardCatalog.update.mock.calls[0][0];
      expect(call.data.sellingValuePaise).toBe(50000); // fell back to stored
      expect(call.data.pointsCost).toBe(500); // PRESERVED — NOT 500 × 5 re-derive
      expect(call.data.status).toBeUndefined(); // ACTIVE row not force-reactivated
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
