import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { GiftBackfillService, backfillSellingValuePaise, isFreeAmountRow } from './gift-backfill.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

describe('backfillSellingValuePaise (value = points ÷ rate, in PAISE)', () => {
  it('paise = round(points × 100 ÷ rate) — ÷ rate, not ×', () => {
    expect(backfillSellingValuePaise(1000, 1)).toBe(100000); // 1000 pts @1 → ₹1000
    expect(backfillSellingValuePaise(1000, 2)).toBe(50000); // 1000 pts @2 → ₹500
  });
  it('rate 0 → 0 (guarded, no rate² inflation)', () => {
    expect(backfillSellingValuePaise(1000, 0)).toBe(0);
  });
});

describe('isFreeAmountRow (pointsCost=0 + min/max band)', () => {
  it('true only when pointsCost=0 AND both min & max are set', () => {
    expect(isFreeAmountRow({ pointsCost: 0, minRedemptionPoints: 100, maxRedemptionPoints: 5000 })).toBe(true);
  });
  it('false for a FIXED item (pointsCost > 0)', () => {
    expect(isFreeAmountRow({ pointsCost: 1000, minRedemptionPoints: null, maxRedemptionPoints: null })).toBe(false);
  });
  it('false when pointsCost=0 but the band is incomplete', () => {
    expect(isFreeAmountRow({ pointsCost: 0, minRedemptionPoints: 100, maxRedemptionPoints: null })).toBe(false);
    expect(isFreeAmountRow({ pointsCost: 0, minRedemptionPoints: null, maxRedemptionPoints: 5000 })).toBe(false);
  });
});

const mockPrisma = {
  rewardCatalog: { findMany: jest.fn(), update: jest.fn() },
  giftCategory: { findFirst: jest.fn(), create: jest.fn() },
  giftMaster: { findFirst: jest.fn(), create: jest.fn() },
};
let rate = 1;
const mockTenantSettings = { getConversionRate: jest.fn(async () => rate) };
const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' };
const partner: JwtPayload = { sub: 'u1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };

describe('GiftBackfillService', () => {
  let service: GiftBackfillService;

  beforeEach(async () => {
    jest.clearAllMocks();
    rate = 1;
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        GiftBackfillService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
      ],
    }).compile();
    service = mod.get(GiftBackfillService);
  });

  it('rejects a non-operator', async () => {
    await expect(service.run(partner)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('only scans rows missing a giftMasterId (idempotent)', async () => {
    mockPrisma.rewardCatalog.findMany.mockResolvedValue([]);
    await service.run(gifsy, 'deoleo');
    const where = mockPrisma.rewardCatalog.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ deletedAt: null, sourceType: 'PLATFORM', giftMasterId: null, clientId: 'deoleo' });
  });

  it('creates a GiftCategory + GiftMaster and backfills sellingValuePaise (÷ rate)', async () => {
    rate = 2;
    mockPrisma.rewardCatalog.findMany.mockResolvedValue([
      {
        id: 'rcat-1', clientId: 'deoleo', code: 'GIFT-TV', name: 'TV', description: null,
        imageUrls: null, mrpPaise: null, redemptionMode: 'PHYSICAL_GIFT', termsAndConditions: null,
        stockQuantity: null, pointsCost: 1000, sellingValuePaise: null,
        category: { id: 'rc1', code: 'ELEC', name: 'Electronics', imageUrl: null, sortOrder: 0 },
      },
    ]);
    mockPrisma.giftCategory.findFirst.mockResolvedValue(null);
    mockPrisma.giftCategory.create.mockResolvedValue({ id: 'gc-1' });
    mockPrisma.giftMaster.findFirst.mockResolvedValue(null);
    mockPrisma.giftMaster.create.mockResolvedValue({ id: 'gm-1' });
    mockPrisma.rewardCatalog.update.mockResolvedValue({});

    const res = await service.run(gifsy, 'deoleo');

    expect(mockPrisma.giftMaster.create).toHaveBeenCalled();
    const upd = mockPrisma.rewardCatalog.update.mock.calls[0][0];
    expect(upd.data).toMatchObject({
      giftMasterId: 'gm-1',
      giftCategoryId: 'gc-1',
      sellingValuePaise: 50000, // 1000 pts @ rate 2 → ₹500 → 50000 paise
    });
    expect(res).toMatchObject({ scanned: 1, linked: 1, mastersCreated: 1, categoriesCreated: 1, valuesBackfilled: 1, failed: 0 });
  });

  it('reuses an existing GiftMaster/GiftCategory by code (no duplicate on re-run)', async () => {
    mockPrisma.rewardCatalog.findMany.mockResolvedValue([
      {
        id: 'rcat-2', clientId: 'deoleo', code: 'GIFT-TV', name: 'TV', description: null,
        imageUrls: null, mrpPaise: null, redemptionMode: 'PHYSICAL_GIFT', termsAndConditions: null,
        stockQuantity: null, pointsCost: 1000, sellingValuePaise: 99999, // already set → not recomputed
        category: { id: 'rc1', code: 'ELEC', name: 'Electronics', imageUrl: null, sortOrder: 0 },
      },
    ]);
    mockPrisma.giftCategory.findFirst.mockResolvedValue({ id: 'gc-existing' });
    mockPrisma.giftMaster.findFirst.mockResolvedValue({ id: 'gm-existing' });
    mockPrisma.rewardCatalog.update.mockResolvedValue({});

    const res = await service.run(gifsy, 'deoleo');
    expect(mockPrisma.giftMaster.create).not.toHaveBeenCalled();
    expect(mockPrisma.giftCategory.create).not.toHaveBeenCalled();
    const upd = mockPrisma.rewardCatalog.update.mock.calls[0][0];
    expect(upd.data.sellingValuePaise).toBe(99999); // preserved (idempotent)
    expect(res).toMatchObject({ mastersCreated: 0, categoriesCreated: 0, valuesBackfilled: 0, linked: 1 });
  });

  it('SKIPS the value-fill for a FREE_AMOUNT voucher (leaves sellingValuePaise null → no 194R under-report)', async () => {
    rate = 5;
    mockPrisma.rewardCatalog.findMany.mockResolvedValue([
      {
        id: 'rcat-fa', clientId: 'deoleo', code: 'FA-VOUCHER', name: 'Choose-your-value', description: null,
        imageUrls: null, mrpPaise: null, redemptionMode: 'GIFT_CARD', termsAndConditions: null,
        stockQuantity: null,
        // FREE_AMOUNT signal: pointsCost 0 with a min/max band. round(0×100/rate)=0 would
        // otherwise freeze a bogus ₹0 value; the fix leaves sellingValuePaise null.
        pointsCost: 0, minRedemptionPoints: 100, maxRedemptionPoints: 5000, sellingValuePaise: null,
        category: { id: 'rc1', code: 'VOUCH', name: 'Vouchers', imageUrl: null, sortOrder: 0 },
      },
    ]);
    mockPrisma.giftCategory.findFirst.mockResolvedValue({ id: 'gc-1' });
    mockPrisma.giftMaster.findFirst.mockResolvedValue(null);
    mockPrisma.giftMaster.create.mockResolvedValue({ id: 'gm-fa' });
    mockPrisma.rewardCatalog.update.mockResolvedValue({});

    const res = await service.run(gifsy, 'deoleo');

    const upd = mockPrisma.rewardCatalog.update.mock.calls[0][0];
    expect(upd.data.sellingValuePaise).toBeNull(); // NOT 0 — left null for the points÷rate fallback
    expect(mockTenantSettings.getConversionRate).not.toHaveBeenCalled(); // no value-fill attempted
    expect(res).toMatchObject({ linked: 1, valuesBackfilled: 0 });
  });

  it('does NOT merge two tenants’ DIFFERENT products that share a code (dedup namespaced per tenant)', async () => {
    // RewardCatalog.code is only (clientId,code)-unique — two tenants can share "GIFT-TV"
    // for different products. The backfill must create a SEPARATE GiftMaster per tenant.
    mockPrisma.rewardCatalog.findMany.mockResolvedValue([
      {
        id: 'rcat-a', clientId: 'deoleo', code: 'GIFT-TV', name: 'Deoleo TV', description: null,
        imageUrls: null, mrpPaise: null, redemptionMode: 'PHYSICAL_GIFT', termsAndConditions: null,
        stockQuantity: null, pointsCost: 1000, sellingValuePaise: 100,
        category: { id: 'rc1', code: 'ELEC', name: 'Electronics', imageUrl: null, sortOrder: 0 },
      },
      {
        id: 'rcat-b', clientId: 'britannia', code: 'GIFT-TV', name: 'Britannia TV', description: null,
        imageUrls: null, mrpPaise: null, redemptionMode: 'PHYSICAL_GIFT', termsAndConditions: null,
        stockQuantity: null, pointsCost: 1000, sellingValuePaise: 100,
        category: { id: 'rc2', code: 'ELEC', name: 'Electronics', imageUrl: null, sortOrder: 0 },
      },
    ]);
    mockPrisma.giftCategory.findFirst.mockResolvedValue({ id: 'gc-1' });
    // No existing master for EITHER namespaced code → both create fresh (no cross-tenant reuse).
    mockPrisma.giftMaster.findFirst.mockResolvedValue(null);
    mockPrisma.giftMaster.create
      .mockResolvedValueOnce({ id: 'gm-deoleo' })
      .mockResolvedValueOnce({ id: 'gm-britannia' });
    mockPrisma.rewardCatalog.update.mockResolvedValue({});

    const res = await service.run(gifsy);

    // Two DISTINCT masters created; the lookups were namespaced by clientId.
    expect(mockPrisma.giftMaster.create).toHaveBeenCalledTimes(2);
    const lookupCodes = mockPrisma.giftMaster.findFirst.mock.calls.map((c) => c[0].where.code);
    expect(lookupCodes).toEqual(['deoleo:GIFT-TV', 'britannia:GIFT-TV']);
    const createCodes = mockPrisma.giftMaster.create.mock.calls.map((c) => c[0].data.code);
    expect(createCodes).toEqual(['deoleo:GIFT-TV', 'britannia:GIFT-TV']);
    // The two catalog rows link to DIFFERENT masters (no merge).
    const linkedMasters = mockPrisma.rewardCatalog.update.mock.calls.map((c) => c[0].data.giftMasterId);
    expect(linkedMasters).toEqual(['gm-deoleo', 'gm-britannia']);
    expect(res).toMatchObject({ mastersCreated: 2, linked: 2 });
  });
});
