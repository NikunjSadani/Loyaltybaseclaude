// Per-brand Hubble gift-card amounts (owner-approved 2026-11-11) + whole-rupee redemption
// amounts (owner decision 2026-11-11, ALL tenants). Same harness shape as rewards.service.spec.ts.
// Run: npx jest src/rewards/rewards.hubble-denominations.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RewardsService } from './rewards.service';
import { PrismaService } from '../prisma/prisma.service';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import {
  HubbleNotConfiguredError,
  HubbleProduct,
  HubbleProductNotFoundError,
  HubbleService,
} from '../hubble/hubble.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { RedeemDto, SalesRedeemDto } from './dto/rewards.dto';

jest.mock('../common/reward-account.helper', () => ({
  ensureOutletAccount: jest.fn().mockResolvedValue('acc-x'),
}));

const mockPrisma = {
  cancelledVoucherCode: { findFirst: jest.fn().mockResolvedValue(null), createMany: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  salesUserAssignment: { findFirst: jest.fn() },
  outlet: { findMany: jest.fn(), findFirst: jest.fn() },
  outletTypeClientConfig: { findUnique: jest.fn() },
  auditLog: { create: jest.fn() },
  wallet: { findFirst: jest.fn() },
  walletTransaction: { findFirst: jest.fn() },
  otpCode: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
  rewardCategory: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  rewardCatalog: {
    findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(),
  },
  redemptionOrder: {
    findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(),
    updateMany: jest.fn(), findUniqueOrThrow: jest.fn(),
  },
  partnerWishlist: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  redemptionStatusHistory: { create: jest.fn() },
  payoutTransaction: { create: jest.fn() },
  client: { findFirst: jest.fn() },
  $executeRaw: jest.fn().mockResolvedValue(1),
  $queryRaw: jest.fn().mockResolvedValue([]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: jest.fn((fn: (tx: any) => unknown) => fn(mockPrisma)),
};

const mockWallet = { debitRedeem: jest.fn(), reverse: jest.fn() };
const mockNotifications = {
  enqueue: jest.fn().mockResolvedValue({ id: 'n1' }),
  writeInApp: jest.fn().mockResolvedValue({ id: 'n1' }),
  notifyUser: jest.fn().mockResolvedValue(undefined),
  notifyUserWithChannels: jest.fn().mockResolvedValue(undefined),
};
const mockMsg91 = { sendOtp: jest.fn().mockResolvedValue(undefined) };
const mockHubble = {
  isConfigured: jest.fn().mockReturnValue(true),
  accountFingerprint: jest.fn().mockReturnValue('api.dev.myhubble.money#0000000000000000'),
  placeOrder: jest.fn(),
  getOrderByReference: jest.fn(),
  getProduct: jest.fn(),
  // Redeem-time fast lookup: delegates to getProduct; any error → null ("skip the check").
  getProductForRedeem: jest.fn(),
};
const SETTINGS = () => ({
  conversionRate: 1,
  minBankTransferAmount: 0,
  minVoucherFreeAmount: 0,
  paceAmberThreshold: 10,
  redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
  salesApp: { ledgerLabel: 'Wallet', upiEnabled: false },
  creditsPayouts: { monthCutoffDay: 28, safetyCapPoints: 50000, safetyCapInr: 100000, fourEyesEnabled: false, notifyEmails: [] },
});
let mockSettings = SETTINGS();
const mockTenantSettings = {
  getEffectiveSettings: jest.fn(async () => mockSettings),
  getConversionRate: jest.fn(async () => mockSettings.conversionRate),
  getOtpTemplateId: jest.fn(async () => undefined),
};

const FIXED_PRODUCT: HubbleProduct = {
  productId: 'fk-1', name: 'Flipkart', denominationType: 'FIXED',
  denominations: [150, 175, 300, 1250, 2500, 5000, 7500, 10000], minValue: 150, maxValue: 10000, maxVouchersPerOrder: 10,
};
const FLEX_PRODUCT: HubbleProduct = {
  productId: 'amz-1', name: 'Amazon Pay', denominationType: 'FLEXIBLE',
  denominations: [], minValue: 500, maxValue: 10000, maxVouchersPerOrder: 10,
};

const bajajAdmin: JwtPayload = { sub: 'admin1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '9990001111', name: '' };
const bajajPartner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'bajaj', phone: '9991112222', name: '' };
const bajajSales: JwtPayload = { sub: 'salesUser1', role: 'SALES_SO', clientId: 'bajaj', phone: '9993334444', name: '' };
const deoleoPartner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '9991112222', name: '' };

const flagOn = () => mockPrisma.client.findFirst.mockResolvedValue({ features: { hubbleVoucherEnabled: true } });

/** A Flipkart "choose from amounts" item as the admin would save it (rate 1). */
const listItem = (over: Record<string, unknown> = {}) => ({
  id: 'r-fk', clientId: 'bajaj', status: 'ACTIVE', deletedAt: null, sourceType: 'PLATFORM',
  pointsCost: 0, redemptionMode: 'GIFT_CARD', sellingValuePaise: null,
  minRedemptionPoints: 150, maxRedemptionPoints: 1250, stockQuantity: null,
  metadata: { hubbleProductId: 'fk-1', hubbleDenominations: [150, 300, 1250] },
  ...over,
});

describe('Hubble per-brand amounts + whole-rupee redemption amounts', () => {
  let service: RewardsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWallet },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: Msg91Service, useValue: mockMsg91 },
        { provide: HubbleService, useValue: mockHubble },
        { provide: GifsyRoleService, useValue: { getPermissions: jest.fn().mockResolvedValue(new Set()) } },
      ],
    }).compile();
    service = module.get(RewardsService);
    mockSettings = SETTINGS();
    mockPrisma.client.findFirst.mockResolvedValue({ features: {} });
    mockHubble.isConfigured.mockReturnValue(true);
    mockHubble.getProduct.mockReset();
    // Default live brand: FLEXIBLE ₹1–₹1,00,000 (never blocks); cases override.
    mockHubble.getProduct.mockResolvedValue({ ...FLEX_PRODUCT, minValue: 1, maxValue: 100000 });
    mockHubble.getProductForRedeem.mockImplementation((id: string) =>
      Promise.resolve().then(() => mockHubble.getProduct(id)).catch(() => null));
    mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.findFirst.mockReset();
    mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });
    mockPrisma.auditLog.create.mockResolvedValue({ id: 'a1' });
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.salesUser.findMany.mockResolvedValue([]);
    mockPrisma.outlet.findFirst.mockResolvedValue({ outletTypeId: 'ot1', outletType: { code: 'WHOLESALER' } });
    mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue(null);
    mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
    mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100000 });
    mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'RDM-1' });
  });

  // ─── Whole-rupee amounts: the DTO gate (ALL tenants, vouchers + cash, self + sales) ───
  describe('RedeemDto.amount — whole rupees only', () => {
    it.each([RedeemDto, SalesRedeemDto])('%p: 750.5 → "Enter a whole-rupee amount"; 750 → valid', async (Cls) => {
      const extra = Cls === SalesRedeemDto ? { targetPartnerId: 'cp-out' } : {};
      const bad = await validate(plainToInstance(Cls, { rewardId: 'r1', amount: 750.5, ...extra }));
      const amountErr = bad.find((e) => e.property === 'amount');
      expect(amountErr).toBeDefined();
      expect(Object.values(amountErr!.constraints ?? {})).toContain('Enter a whole-rupee amount');
      const ok = await validate(plainToInstance(Cls, { rewardId: 'r1', amount: 750, ...extra }));
      expect(ok.find((e) => e.property === 'amount')).toBeUndefined();
    });

    it('a numeric string "750.5" is also refused (implicit Number conversion, still not an integer)', async () => {
      const bad = await validate(plainToInstance(RedeemDto, { rewardId: 'r1', amount: '750.5' }));
      expect(bad.find((e) => e.property === 'amount')).toBeDefined();
    });

    it('amount stays optional (fixed-price items send none)', async () => {
      const ok = await validate(plainToInstance(RedeemDto, { rewardId: 'r1', quantity: 1 }));
      expect(ok).toHaveLength(0);
    });
  });

  // ─── Redeem (self) ───
  describe('redeem — Hubble amounts list', () => {
    it('an amount NOT in the list → 400 listing the choices, before any order/points', async () => {
      flagOn();
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem());
      await expect(service.redeem(bajajPartner, { rewardId: 'r-fk', amount: 277 }))
        .rejects.toThrow('Choose one of the available amounts: ₹150, ₹300, ₹1,250.');
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('a listed amount → order created, points = amount × rate, chosen face value frozen on the order', async () => {
      flagOn();
      mockSettings.conversionRate = 2;
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem());
      const res = await service.redeem(bajajPartner, { rewardId: 'r-fk', amount: 1250 });
      const created = mockPrisma.redemptionOrder.create.mock.calls[0][0];
      // 1250 × 2 = 2500 points: OUTSIDE the stored band [150,1250] (saved at rate 1) — a listed
      // amount skips the stale band, so a later rate change never locks members out.
      expect(created.data.totalPointsCost).toBe(2500);
      expect(res.requiredPoints).toBe(2500);
      expect(created.data.metadata).toEqual({ sellingValuePaiseSnapshot: 125000 });
    });

    it('the global minimum voucher amount still applies to a listed amount', async () => {
      flagOn();
      mockSettings.minVoucherFreeAmount = 200;
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem());
      await expect(service.redeem(bajajPartner, { rewardId: 'r-fk', amount: 150 }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('quantity > 1 on a Hubble gift card → 400 (one voucher per redemption)', async () => {
      flagOn();
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem({
        pointsCost: 300, minRedemptionPoints: null, maxRedemptionPoints: null, sellingValuePaise: 30000,
        metadata: { hubbleProductId: 'fk-1' },
      }));
      await expect(service.redeem(bajajPartner, { rewardId: 'r-fk', quantity: 2 }))
        .rejects.toThrow(/one per redemption/);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('a FLEXIBLE Hubble item (no list) freezes the typed whole-rupee amount as the face value', async () => {
      flagOn();
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem({
        minRedemptionPoints: 500, maxRedemptionPoints: 10000, metadata: { hubbleProductId: 'amz-1' },
      }));
      await service.redeem(bajajPartner, { rewardId: 'r-fk', amount: 777 });
      expect(mockPrisma.redemptionOrder.create.mock.calls[0][0].data.metadata).toEqual({ sellingValuePaiseSnapshot: 77700 });
    });

    it('service-level backstop: a non-integer amount on a Hubble item → 400 (if the DTO gate is bypassed)', async () => {
      flagOn();
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem({ metadata: { hubbleProductId: 'amz-1' }, minRedemptionPoints: 1, maxRedemptionPoints: 10000 }));
      await expect(service.redeem(bajajPartner, { rewardId: 'r-fk', amount: 750.5 }))
        .rejects.toThrow('Enter a whole-rupee amount');
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('flag OFF → the list is not enforced (plain variable-amount behaviour)', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem({ maxRedemptionPoints: 5000 }));
      await service.redeem(bajajPartner, { rewardId: 'r-fk', amount: 277 });
      expect(mockPrisma.redemptionOrder.create).toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.create.mock.calls[0][0].data.metadata).toBeUndefined();
    });

    it('DEOLEO byte-identical: a non-Hubble free-amount item never reads the tenant flag', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', clientId: 'deoleo', status: 'ACTIVE', pointsCost: 0, redemptionMode: 'GIFT_CARD',
        minRedemptionPoints: 100, maxRedemptionPoints: 5000, stockQuantity: null, sellingValuePaise: null, metadata: null,
      });
      await service.redeem(deoleoPartner, { rewardId: 'r1', amount: 277 });
      expect(mockPrisma.client.findFirst).not.toHaveBeenCalled();
      expect(mockHubble.getProduct).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.create.mock.calls[0][0].data.metadata).toBeUndefined();
    });
  });

  // ─── Redeem (sales-assisted) ───
  describe('redeemForOutlet — Hubble amounts list', () => {
    const wire = () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp-out', userId: 'ou1', user: { id: 'ou1', phone: '9000000000' } });
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
    };

    it('an amount NOT in the list → 400, no order', async () => {
      flagOn(); wire();
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem());
      await expect(service.redeemForOutlet(bajajSales, { rewardId: 'r-fk', amount: 500, targetPartnerId: 'cp-out' }))
        .rejects.toThrow(/Choose one of the available amounts/);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('a listed amount → order for the outlet, chosen face value frozen alongside salesInitiatedById', async () => {
      flagOn(); wire();
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem());
      await service.redeemForOutlet(bajajSales, { rewardId: 'r-fk', amount: 300, targetPartnerId: 'cp-out' });
      const created = mockPrisma.redemptionOrder.create.mock.calls[0][0];
      expect(created.data.partnerId).toBe('cp-out');
      expect(created.data.totalPointsCost).toBe(300);
      expect(created.data.metadata).toEqual({ sellingValuePaiseSnapshot: 30000, salesInitiatedById: 'salesUser1' });
    });
  });

  // ─── Member catalogue projection ───
  describe('member catalogue — amountOptions', () => {
    it('listCatalog exposes amountOptions for a list item and NEVER the raw metadata/productId', async () => {
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([
        { id: 'r-fk', pointsCost: 0, redemptionMode: 'GIFT_CARD', sourceType: 'PLATFORM', metadata: { hubbleProductId: 'fk-1', hubbleDenominations: [150, 300] } },
        { id: 'r-x', pointsCost: 50, redemptionMode: 'GIFT_CARD', sourceType: 'PLATFORM', metadata: null },
      ]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(2);
      const res = await service.listCatalog(bajajPartner, {});
      expect(res.items[0]).toMatchObject({ id: 'r-fk', amountOptions: [150, 300] });
      expect(res.items[0]).not.toHaveProperty('metadata');
      expect(JSON.stringify(res)).not.toContain('fk-1');
      // A non-Hubble item gains NO new keys (byte-identical for Deoleo).
      expect(res.items[1]).not.toHaveProperty('amountOptions');
      expect(res.items[1]).not.toHaveProperty('metadata');
    });

    it('getCatalogItem strips metadata and projects amountOptions', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r-fk', pointsCost: 0, redemptionMode: 'GIFT_CARD', sourceType: 'PLATFORM',
        metadata: { hubbleProductId: 'fk-1', hubbleDenominations: [150] },
      });
      const res = await service.getCatalogItem(bajajPartner, 'r-fk');
      expect(res.item).toMatchObject({ amountOptions: [150] });
      expect(res.item).not.toHaveProperty('metadata');
    });
  });

  // ─── Admin: load product ───
  describe('getHubbleProductForAdmin', () => {
    it('flag OFF → 400 (Hubble not enabled for this program), no Hubble call', async () => {
      await expect(service.getHubbleProductForAdmin(bajajAdmin, 'fk-1')).rejects.toThrow(/not enabled/);
      expect(mockHubble.getProduct).not.toHaveBeenCalled();
    });

    it('returns the product + rate + minimum voucher amount', async () => {
      flagOn();
      mockSettings.minVoucherFreeAmount = 100;
      mockHubble.getProduct.mockResolvedValue(FIXED_PRODUCT);
      await expect(service.getHubbleProductForAdmin(bajajAdmin, 'fk-1')).resolves.toEqual({
        product: FIXED_PRODUCT, conversionRate: 1, minVoucherFreeAmount: 100,
      });
    });

    it.each([
      [new HubbleProductNotFoundError('x'), NotFoundException],
      [new HubbleNotConfiguredError(), ServiceUnavailableException],
      [new Error('Hubble getProduct HTTP 503'), ServiceUnavailableException],
    ])('%p → %p', async (err, Expected) => {
      flagOn();
      mockHubble.getProduct.mockRejectedValue(err);
      await expect(service.getHubbleProductForAdmin(bajajAdmin, 'x')).rejects.toBeInstanceOf(Expected);
    });
  });

  // ─── Admin: create ───
  describe('createCatalogItem — Hubble amounts', () => {
    const base = { categoryId: 'c1', code: 'FK', name: 'Flipkart', redemptionMode: 'GIFT_CARD' as const };
    beforeEach(() => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'c1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      mockPrisma.rewardCatalog.create.mockResolvedValue({ id: 'r-new' });
    });

    it('FIXED brand + chosen subset → variable-amount shape with the derived band + list in metadata', async () => {
      flagOn();
      mockSettings.conversionRate = 2;
      mockHubble.getProduct.mockResolvedValue(FIXED_PRODUCT);
      await service.createCatalogItem(bajajAdmin, { ...base, hubbleProductId: ' fk-1 ', hubbleDenominations: [1250, 150, 300] });
      const data = mockPrisma.rewardCatalog.create.mock.calls[0][0].data;
      expect(data.pointsCost).toBe(0);
      expect(data.minRedemptionPoints).toBe(300); // 150 × 2
      expect(data.maxRedemptionPoints).toBe(2500); // 1250 × 2
      expect(data.metadata).toEqual({ hubbleProductId: 'fk-1', hubbleDenominations: [150, 300, 1250] });
    });

    it('an amount the FIXED brand does not issue → 400, nothing saved', async () => {
      flagOn();
      mockHubble.getProduct.mockResolvedValue(FIXED_PRODUCT);
      await expect(service.createCatalogItem(bajajAdmin, { ...base, hubbleProductId: 'fk-1', hubbleDenominations: [150, 277] }))
        .rejects.toThrow(/can't issue ₹277/);
      expect(mockPrisma.rewardCatalog.create).not.toHaveBeenCalled();
    });

    it('FIXED brand with a free range (the staging Flipkart ₹100–10,000 bug) → 400', async () => {
      flagOn();
      mockHubble.getProduct.mockResolvedValue(FIXED_PRODUCT);
      await expect(service.createCatalogItem(bajajAdmin, { ...base, hubbleProductId: 'fk-1', minRedemptionPoints: 100, maxRedemptionPoints: 10000 }))
        .rejects.toThrow(/choose which amounts/);
      expect(mockPrisma.rewardCatalog.create).not.toHaveBeenCalled();
    });

    it('FLEXIBLE brand: a free range outside Hubble limits → 400; inside → saved', async () => {
      flagOn();
      mockHubble.getProduct.mockResolvedValue(FLEX_PRODUCT);
      await expect(service.createCatalogItem(bajajAdmin, { ...base, hubbleProductId: 'amz-1', minRedemptionPoints: 100, maxRedemptionPoints: 10000 }))
        .rejects.toThrow(/must sit inside/);
      await service.createCatalogItem(bajajAdmin, { ...base, hubbleProductId: 'amz-1', minRedemptionPoints: 500, maxRedemptionPoints: 10000 });
      expect(mockPrisma.rewardCatalog.create.mock.calls[0][0].data.metadata).toEqual({ hubbleProductId: 'amz-1' });
    });

    it('fixed-price Hubble item: a selling value the brand cannot issue → 400', async () => {
      flagOn();
      mockHubble.getProduct.mockResolvedValue(FIXED_PRODUCT);
      await expect(service.createCatalogItem(bajajAdmin, { ...base, hubbleProductId: 'fk-1', sellingValuePaise: 50000 }))
        .rejects.toThrow(/can't issue a ₹500/);
    });

    it('amounts without Hubble (flag OFF) → 400', async () => {
      await expect(service.createCatalogItem(bajajAdmin, { ...base, hubbleProductId: 'fk-1', hubbleDenominations: [150] }))
        .rejects.toThrow(/only be chosen for a Hubble gift card/);
    });

    it('amounts list but Hubble NOT configured → 503 (cannot verify); no list → saved unchecked (as before)', async () => {
      flagOn();
      mockHubble.getProduct.mockRejectedValue(new HubbleNotConfiguredError());
      await expect(service.createCatalogItem(bajajAdmin, { ...base, hubbleProductId: 'fk-1', hubbleDenominations: [150] }))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      await service.createCatalogItem(bajajAdmin, { ...base, hubbleProductId: 'fk-1', sellingValuePaise: 50000 });
      expect(mockPrisma.rewardCatalog.create).toHaveBeenCalledTimes(1);
    });

    it('DEOLEO byte-identical: no productId → no flag read, no Hubble call, no metadata', async () => {
      await service.createCatalogItem({ ...bajajAdmin, clientId: 'deoleo' }, { ...base, sellingValuePaise: 50000 });
      expect(mockPrisma.client.findFirst).not.toHaveBeenCalled();
      expect(mockHubble.getProduct).not.toHaveBeenCalled();
      expect(mockPrisma.rewardCatalog.create.mock.calls[0][0].data.metadata).toBeUndefined();
    });
  });

  // ─── Admin: update ───
  describe('updateCatalogItem — Hubble amounts', () => {
    const stored = () => ({
      ...listItem(), code: 'FK', mrpPaise: null,
    });
    beforeEach(() => mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'r-fk' }));

    it('an unrelated edit (name) on a Hubble item does NOT call Hubble and leaves metadata alone', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(stored());
      await service.updateCatalogItem(bajajAdmin, 'r-fk', { name: 'Flipkart gift card' });
      expect(mockHubble.getProduct).not.toHaveBeenCalled();
      const data = mockPrisma.rewardCatalog.update.mock.calls[0][0].data;
      expect(data.metadata).toBeUndefined();
      expect(data.pointsCost).toBe(0);
    });

    it('changing the list → re-validated against Hubble, band re-derived, metadata merged', async () => {
      flagOn();
      mockHubble.getProduct.mockResolvedValue(FIXED_PRODUCT);
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(stored());
      await service.updateCatalogItem(bajajAdmin, 'r-fk', { hubbleProductId: 'fk-1', hubbleDenominations: [300, 5000] });
      const data = mockPrisma.rewardCatalog.update.mock.calls[0][0].data;
      expect(data.minRedemptionPoints).toBe(300);
      expect(data.maxRedemptionPoints).toBe(5000);
      expect(data.metadata).toEqual({ hubbleProductId: 'fk-1', hubbleDenominations: [300, 5000] });
    });

    it('an invalid new amount → 400, no write', async () => {
      flagOn();
      mockHubble.getProduct.mockResolvedValue(FIXED_PRODUCT);
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(stored());
      await expect(service.updateCatalogItem(bajajAdmin, 'r-fk', { hubbleDenominations: [999] }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.rewardCatalog.update).not.toHaveBeenCalled();
    });

    it('[] clears the list (item reverts to the band in the payload — validated for a FIXED brand → 400)', async () => {
      flagOn();
      mockHubble.getProduct.mockResolvedValue(FIXED_PRODUCT);
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(stored());
      await expect(service.updateCatalogItem(bajajAdmin, 'r-fk', { hubbleDenominations: [], minRedemptionPoints: 100, maxRedemptionPoints: 1000 }))
        .rejects.toThrow(/choose which amounts/);
    });

    it('clearing the productId drops the list too', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(stored());
      await service.updateCatalogItem(bajajAdmin, 'r-fk', { hubbleProductId: '' });
      const data = mockPrisma.rewardCatalog.update.mock.calls[0][0].data;
      expect(data.metadata).toEqual({});
      expect(mockHubble.getProduct).not.toHaveBeenCalled();
    });

    it('DEOLEO byte-identical: a GIFT_CARD edit sending hubbleProductId "" writes exactly what it did before', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', code: 'AMZ', clientId: 'deoleo', pointsCost: 500, redemptionMode: 'GIFT_CARD', sellingValuePaise: 50000,
        mrpPaise: null, minRedemptionPoints: null, maxRedemptionPoints: null, stockQuantity: null, metadata: null,
      });
      await service.updateCatalogItem({ ...bajajAdmin, clientId: 'deoleo' }, 'r1', {
        name: 'Amazon', hubbleProductId: '', minRedemptionPoints: undefined, maxRedemptionPoints: undefined,
      });
      expect(mockPrisma.client.findFirst).not.toHaveBeenCalled();
      expect(mockHubble.getProduct).not.toHaveBeenCalled();
      const data = mockPrisma.rewardCatalog.update.mock.calls[0][0].data;
      expect(data.metadata).toEqual({});
      expect(data.minRedemptionPoints).toBeNull();
    });
  });

  // ─── Issuance defence in depth (audit M2: reads the ORDER; a miss is refunded at once) ───
  describe('issueHubbleVoucherForOrder — amount defence', () => {
    const order = (over: Record<string, unknown> = {}) => ({
      id: 'o1', orderNumber: 'RDM-1', partnerId: 'cp1', status: 'CONFIRMED', voucherCode: null,
      pointsDeducted: 300, valuePaise: 30000n, quantity: 1, redemptionMode: 'GIFT_CARD',
      metadata: { sellingValuePaiseSnapshot: 30000 },
      partner: { clientId: 'bajaj' },
      reward: { metadata: { hubbleProductId: 'fk-1', hubbleDenominations: [150, 300] } },
      ...over,
    });
    const failedClaim = () =>
      mockPrisma.redemptionOrder.updateMany.mock.calls
        .map(([a]) => a as { data?: { status?: string } })
        .find((a) => a.data?.status === 'FAILED');

    it('FIXED brand and the amount is not a live denomination → never placed, refunded NOW (FAILED_REFUNDED)', async () => {
      mockHubble.getProduct.mockResolvedValue({ ...FIXED_PRODUCT, denominations: [150, 175] });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(order());
      const out = await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'a1');
      expect(out).toBe('FAILED_REFUNDED');
      expect(mockHubble.placeOrder).not.toHaveBeenCalled();
      expect(mockWallet.reverse).toHaveBeenCalledWith('cp1', 300, expect.objectContaining({ referenceId: 'o1' }), expect.anything());
      expect(failedClaim()).toBeDefined();
    });

    it('the order value drifted from its frozen face value → never placed, refunded', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(order({ valuePaise: 27700n }));
      const out = await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'a1');
      expect(out).toBe('FAILED_REFUNDED');
      expect(mockHubble.placeOrder).not.toHaveBeenCalled();
    });

    it("an admin editing the item's list AFTER the order does not block it (the ORDER is checked, not the item)", async () => {
      mockHubble.getProduct.mockResolvedValue(FIXED_PRODUCT);
      mockHubble.placeOrder.mockResolvedValue({ status: 'PROCESSING', id: 'h1', vouchers: [] });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(order({
        reward: { metadata: { hubbleProductId: 'fk-1', hubbleDenominations: [1250] } }, // ₹300 removed since
      }));
      await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'a1');
      expect(mockHubble.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 300 }));
    });

    it('a FIXED brand whose list Hubble did not return is UNKNOWN → placed (Hubble validates)', async () => {
      mockHubble.getProduct.mockResolvedValue({ ...FIXED_PRODUCT, denominations: [] });
      mockHubble.placeOrder.mockResolvedValue({ status: 'PROCESSING', id: 'h1', vouchers: [] });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(order());
      await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'a1');
      expect(mockHubble.placeOrder).toHaveBeenCalled();
    });

    it('a legacy order with quantity 2 (frozen ₹500 × 2) is consistent and still placed', async () => {
      mockHubble.placeOrder.mockResolvedValue({ status: 'PROCESSING', id: 'h1', vouchers: [] });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(order({
        valuePaise: 100000n, quantity: 2, metadata: { sellingValuePaiseSnapshot: 50000 },
        reward: { metadata: { hubbleProductId: 'amz-1' } },
      }));
      await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'a1');
      expect(mockHubble.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: 1000 }));
    });

    it('a valid amount is placed as ONE voucher of that denomination', async () => {
      mockHubble.getProduct.mockResolvedValue(FIXED_PRODUCT);
      mockHubble.placeOrder.mockResolvedValue({ status: 'PROCESSING', id: 'h1', vouchers: [] });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(order());
      await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'a1');
      expect(mockHubble.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
        productId: 'fk-1', amount: 300, denominationDetails: [{ denomination: 300, quantity: 1 }],
      }));
    });

    it('a product lookup failure does NOT block issuance (Hubble still validates)', async () => {
      mockHubble.getProduct.mockRejectedValue(new Error('timeout'));
      mockHubble.placeOrder.mockResolvedValue({ status: 'PROCESSING', id: 'h1', vouchers: [] });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(order({ reward: { metadata: { hubbleProductId: 'amz-1' } } }));
      await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'a1');
      expect(mockHubble.placeOrder).toHaveBeenCalled();
    });

    it('a FLEXIBLE brand is not pre-checked against its min/max (existing FAILED → refund path)', async () => {
      mockHubble.getProduct.mockResolvedValue(FLEX_PRODUCT);
      mockHubble.placeOrder.mockResolvedValue({ status: 'PROCESSING', id: 'h1', vouchers: [] });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(order({
        valuePaise: 27700n, metadata: { sellingValuePaiseSnapshot: 27700 }, reward: { metadata: { hubbleProductId: 'amz-1' } },
      }));
      await service.issueHubbleVoucherForOrder('o1', 'bajaj', 'a1');
      expect(mockHubble.placeOrder).toHaveBeenCalled();
    });
  });

  // ─── Redeem-time LIVE brand check (audit M2 + L1): 400 before any debit ───
  describe('redeem — live Hubble brand check', () => {
    it('FIXED brand no longer issues a listed amount → 400 naming what is available, no order', async () => {
      flagOn();
      mockHubble.getProduct.mockResolvedValue({ ...FIXED_PRODUCT, denominations: [150, 1250] });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem());
      await expect(service.redeem(bajajPartner, { rewardId: 'r-fk', amount: 300 }))
        .rejects.toThrow("₹300 isn't available for this gift card right now. Available: ₹150, ₹1,250.");
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it("L1: FLEXIBLE brand without a list enforces Hubble's RUPEE min (₹277 on Amazon ₹500+) → 400, no order", async () => {
      flagOn();
      mockHubble.getProduct.mockResolvedValue(FLEX_PRODUCT);
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem({
        minRedemptionPoints: 1, maxRedemptionPoints: 10000, metadata: { hubbleProductId: 'amz-1' },
      }));
      await expect(service.redeem(bajajPartner, { rewardId: 'r-fk', amount: 277 }))
        .rejects.toThrow('This gift card can only be issued for an amount between ₹500 and ₹10,000.');
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('fixed-price Hubble item whose selling value the brand cannot issue → 400 before any order', async () => {
      flagOn();
      mockHubble.getProduct.mockResolvedValue(FIXED_PRODUCT);
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem({
        pointsCost: 500, minRedemptionPoints: null, maxRedemptionPoints: null, sellingValuePaise: 50000,
        metadata: { hubbleProductId: 'fk-1' },
      }));
      await expect(service.redeem(bajajPartner, { rewardId: 'r-fk', quantity: 1 })).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('a lookup failure / Hubble not configured / unknown FIXED list never blocks the redeem', async () => {
      flagOn();
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem());
      const setups = [
        () => mockHubble.getProduct.mockRejectedValue(new Error('timeout')),
        () => mockHubble.getProduct.mockRejectedValue(new HubbleNotConfiguredError()),
        () => mockHubble.getProduct.mockResolvedValue({ ...FIXED_PRODUCT, denominations: [] }),
      ];
      for (const setup of setups) {
        setup();
        mockPrisma.redemptionOrder.create.mockClear();
        await service.redeem(bajajPartner, { rewardId: 'r-fk', amount: 300 });
        expect(mockPrisma.redemptionOrder.create).toHaveBeenCalledTimes(1);
      }
    });

    it('L4 wording: a non-whole-rupee fixed price → "must be a whole-rupee amount"; a FLEXIBLE brand with no limits gets no fake range', async () => {
      flagOn();
      const fixedPrice = (sellingValuePaise: number) => listItem({
        pointsCost: 500, minRedemptionPoints: null, maxRedemptionPoints: null, sellingValuePaise,
        metadata: { hubbleProductId: 'amz-1' },
      });
      mockHubble.getProduct.mockResolvedValue(FLEX_PRODUCT);
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedPrice(75050));
      await expect(service.redeem(bajajPartner, { rewardId: 'r-fk', quantity: 1 }))
        .rejects.toThrow('This gift card must be a whole-rupee amount.');
      // FLEXIBLE with NO limits and a valid whole rupee → issuable → order created (no range text needed).
      mockHubble.getProduct.mockResolvedValue({ ...FLEX_PRODUCT, minValue: null, maxValue: null });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedPrice(50000));
      await service.redeem(bajajPartner, { rewardId: 'r-fk', quantity: 1 });
      expect(mockPrisma.redemptionOrder.create).toHaveBeenCalledTimes(1);
    });

    it('the redeem-time check uses the FAST lookup (getProductForRedeem), never the 15 s one', async () => {
      flagOn();
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem());
      await service.redeem(bajajPartner, { rewardId: 'r-fk', amount: 300 });
      expect(mockHubble.getProductForRedeem).toHaveBeenCalledWith('fk-1');
    });

    it('the sales-assisted path gets the same live check', async () => {
      flagOn();
      mockHubble.getProduct.mockResolvedValue(FLEX_PRODUCT);
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp-out', userId: 'ou1', user: { id: 'ou1', phone: '9000000000' } });
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(listItem({
        minRedemptionPoints: 1, maxRedemptionPoints: 10000, metadata: { hubbleProductId: 'amz-1' },
      }));
      await expect(service.redeemForOutlet(bajajSales, { rewardId: 'r-fk', amount: 100, targetPartnerId: 'cp-out' }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });
  });

  // ─── Audit M1 (unknown FIXED list) + L4 (explicit fixed-price PATCH) ───
  describe('catalogue — unknown FIXED list + explicit fixed-price PATCH', () => {
    it('M1: FIXED brand whose list Hubble did not return → admin-entered amounts accepted (whole rupees, ≥ tenant minimum)', async () => {
      flagOn();
      mockSettings.minVoucherFreeAmount = 200;
      mockHubble.getProduct.mockResolvedValue({ ...FIXED_PRODUCT, denominations: [] });
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'c1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      mockPrisma.rewardCatalog.create.mockResolvedValue({ id: 'r-new' });
      const base = { categoryId: 'c1', code: 'FK', name: 'Flipkart', redemptionMode: 'GIFT_CARD' as const, hubbleProductId: 'fk-1' };
      await service.createCatalogItem(bajajAdmin, { ...base, hubbleDenominations: [300, 200] });
      expect(mockPrisma.rewardCatalog.create.mock.calls[0][0].data.metadata)
        .toEqual({ hubbleProductId: 'fk-1', hubbleDenominations: [200, 300] });
      await expect(service.createCatalogItem(bajajAdmin, { ...base, code: 'FK2', hubbleDenominations: [175] }))
        .rejects.toThrow(/below this program's minimum/);
      await expect(service.createCatalogItem(bajajAdmin, { ...base, code: 'FK3', minRedemptionPoints: 100, maxRedemptionPoints: 1000 }))
        .rejects.toThrow(/enter the amounts Hubble shows/);
    });

    it('L4: PATCH with min/max explicitly null + a selling value (no amounts field) clears the list → fixed price', async () => {
      flagOn();
      mockHubble.getProduct.mockResolvedValue(FIXED_PRODUCT);
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ ...listItem(), code: 'FK', mrpPaise: null });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'r-fk' });
      await service.updateCatalogItem(bajajAdmin, 'r-fk', {
        minRedemptionPoints: null as unknown as undefined,
        maxRedemptionPoints: null as unknown as undefined,
        sellingValuePaise: 30000,
      });
      const data = mockPrisma.rewardCatalog.update.mock.calls[0][0].data;
      expect(data.metadata).toEqual({ hubbleProductId: 'fk-1' });
      expect(data.pointsCost).toBe(300);
      expect(data.minRedemptionPoints).toBeNull();
      expect(data.maxRedemptionPoints).toBeNull();
    });
  });
});
