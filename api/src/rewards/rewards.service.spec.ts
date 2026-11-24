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
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { RewardsService, decodeOrderCursor, encodeOrderCursor, hiddenVoucherFields, maskVoucherCode } from './rewards.service';
import { hashVoucherCode } from './voucher-write-guard';
import { PrismaService } from '../prisma/prisma.service';
import { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { HubblePlaceOrderRejectedError, HubbleService } from '../hubble/hubble.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  AdminListCatalogQueryDto, ListOrdersQueryDto, ORDERS_LIST_MAX_LIMIT, TransitionOrderDto, UpdatableOrderStatus,
  UpdateOrderDto, VoucherCancelledWithVendorDto,
} from './dto/rewards.dto';
import { validate } from 'class-validator';
import { parseFulfilmentUploadBuffer } from './rewards-fulfilment.helpers';

// Employee Rewards Phase 1 — stub the account dual-write helper (own tests in
// reward-account.helper.spec.ts) so redeem tests aren't coupled to its internal tx calls.
jest.mock('../common/reward-account.helper', () => ({
  ensureOutletAccount: jest.fn().mockResolvedValue('acc-x'),
}));

const mockPrisma = {
  // Tenant-wide cancelled-voucher reuse guard (voucher-write-guard.ts) — default: never cancelled.
  cancelledVoucherCode: { findFirst: jest.fn().mockResolvedValue(null), createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  channelPartner: { findFirst: jest.fn() },
  // findMany = the tenant-scoped reporting edges for the downline walk (requireAssignedPartner).
  salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
  salesUserAssignment: { findFirst: jest.fn() },
  // outlet.findFirst + outletTypeClientConfig added for the per-outlet-type Loyalty gate
  // (isLoyaltyEnabledForPartner). Defaulted in beforeEach so existing tests default loyalty ON.
  outlet: { findMany: jest.fn(), findFirst: jest.fn() },
  outletTypeClientConfig: { findUnique: jest.fn() },
  auditLog: { create: jest.fn() },
  wallet: { findFirst: jest.fn() },
  // trackOrder reads the order's refund (CREDIT_REVERSAL) wallet row — order-timeline D5.
  walletTransaction: { findFirst: jest.fn() },
  otpCode: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
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
  redemptionOrder: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn(), findUnique: jest.fn() },
  // Persistent partner wishlist (getWishlist / addToWishlist / removeFromWishlist).
  partnerWishlist: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  redemptionStatusHistory: { create: jest.fn() },
  payoutTransaction: { create: jest.fn() },
  // clients.features read for the Hubble feature flag (default OFF via beforeEach).
  client: { findFirst: jest.fn() },
  // Tenant order-number generation (order-number.helper) runs raw SQL inside the
  // redeem tx: an advisory xact lock + a max-suffix scan. Default: lock ok, no prior
  // rows → sequence starts at 1.
  $executeRaw: jest.fn().mockResolvedValue(1),
  $queryRaw: jest.fn().mockResolvedValue([]),
  // $transaction runs the callback against a tx client that proxies the same mocks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: jest.fn((fn: (tx: any) => unknown) => fn(mockPrisma)),
};

// RBAC Option-X — a GIFSY_STAFF user's resolved GifsyRole permissions (default: none).
const mockGifsyRoles = { getPermissions: jest.fn() };

const mockWallet = {
  debitRedeem: jest.fn(),
  reverse: jest.fn(),
};

const mockNotifications = {
  enqueue: jest.fn().mockResolvedValue({ id: 'n1' }),
  writeInApp: jest.fn().mockResolvedValue({ id: 'n1' }),
  notifyUser: jest.fn().mockResolvedValue(undefined),
  notifyUserWithChannels: jest.fn().mockResolvedValue(undefined),
};

// OTP is now sent synchronously via Msg91Service (A-2a) — default: succeeds.
const mockMsg91 = {
  sendOtp: jest.fn().mockResolvedValue(undefined),
};

// Hubble API client — default CONFIGURED; place/get are set per-test. The flag is OFF
// by default (mockPrisma.client.findFirst → features {}), so these are never hit by the
// legacy confirm tests (isHubbleEligible short-circuits on a missing productId).
const mockHubble = {
  isConfigured: jest.fn().mockReturnValue(true),
  accountFingerprint: jest.fn().mockReturnValue('api.dev.myhubble.money#0000000000000000'),
  placeOrder: jest.fn(),
  getOrderByReference: jest.fn(),
  // Per-brand amounts: issuance re-checks a FIXED brand's denominations. Default = a
  // FLEXIBLE brand (never blocks), so the legacy issuance tests are unaffected.
  getProduct: jest.fn().mockResolvedValue({
    productId: 'amz-1', name: 'Amazon Pay', denominationType: 'FLEXIBLE', denominations: [],
    minValue: 1, maxValue: 100000, maxVouchersPerOrder: 10,
  }),
  getProductForRedeem: jest.fn().mockResolvedValue(null),
};

// Per-tenant settings. Defaults are LENIENT (rate 1, no min-floor, all channels on) so the
// legacy redeem/confirm tests are unaffected; the dedicated "settings enforcement" block
// mutates these per case. Reset in beforeEach.
const LENIENT_SETTINGS = () => ({
  conversionRate: 1,
  minBankTransferAmount: 0,
  minVoucherFreeAmount: 0,
  paceAmberThreshold: 10,
  redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
  salesApp: { ledgerLabel: 'Wallet', upiEnabled: false },
  creditsPayouts: { monthCutoffDay: 28, safetyCapPoints: 50000, safetyCapInr: 100000, fourEyesEnabled: false, notifyEmails: [] },
});
let mockSettings = LENIENT_SETTINGS();
// Per-tenant, per-purpose OTP template id. Default undefined = "use the global env
// template" (unchanged legacy behaviour); the OTP-template block overrides per case.
let mockOtpTemplateId: string | undefined = undefined;
const mockTenantSettings = {
  getEffectiveSettings: jest.fn(async () => mockSettings),
  getConversionRate: jest.fn(async () => mockSettings.conversionRate),
  getOtpTemplateId: jest.fn(async () => mockOtpTemplateId),
};

// Default for the in-tx TOCTOU eligibility re-check (`tx.channelPartner.findFirst`).
// All redemption modes now require KYC-APPROVED + active, so a sensible "eligible"
// default lets the legacy confirm tests reach their real assertions; ineligibility
// tests override it per-case.
const ELIGIBLE_FRESH_PARTNER = {
  id: 'cp1',
  userId: 'user1',
  isActive: true,
  deletedAt: null,
  kycSubmissions: [
    { id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') },
  ],
  bankAccountNumber: '0011223344',
  ifscCode: 'HDFC0001234',
  upiId: 'eligible@upi',
  bankAccountHolder: 'Holder',
  ownerName: 'Owner',
  bankName: 'HDFC',
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '9990001111', name: '' };
// An ASSUMED Gifsy operator (working inside a tenant) — platformWide=false, so the
// order write-paths (§12) scope by partner.clientId. An UN-assumed GIFSY_ADMIN is
// platform-wide (cross-tenant) for those same paths (the fulfilment console).
const assumedGifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', assumed: true, phone: '9990001111', name: '' };
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
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: Msg91Service, useValue: mockMsg91 },
        { provide: HubbleService, useValue: mockHubble },
        { provide: GifsyRoleService, useValue: mockGifsyRoles },
      ],
    }).compile();
    service = module.get(RewardsService);
    mockGifsyRoles.getPermissions.mockResolvedValue(new Set());
    mockSettings = LENIENT_SETTINGS();
    // Hubble feature flag OFF by default → the legacy confirm tests are byte-identical
    // (no Hubble call). The dedicated Hubble block flips this on per-case.
    mockPrisma.client.findFirst.mockResolvedValue({ features: {} });
    mockHubble.isConfigured.mockReturnValue(true);
    mockOtpTemplateId = undefined; // default: no per-tenant override (global env template)
    // Default: atomic claims (PENDING→CONFIRMED, refund pointsDeducted>0→0, stock
    // decrement) win. Individual tests override to simulate a lost race.
    mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
    // Supersede-abandoned-PENDING read (shared order-status transition): none by default
    // (explicit, instead of inheriting a previous test's findMany fixture).
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.rewardCatalog.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
    // Claim-before-compare: each OTP verify claims one attempt atomically first (ONE `UPDATE "otp_codes"
    // … RETURNING "attempts"` via $queryRaw) — default: the claim wins as attempt 1; every other raw
    // query (order-number scan) keeps its empty-rows default.
    mockPrisma.$queryRaw.mockImplementation(async (q: any) => (isOtpClaim(q) ? [{ attempts: 1 }] : []));
    // A refused claim re-reads the row for the honest message — default: still live (cap spent).
    mockPrisma.otpCode.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() + 60_000), verifiedAt: null });
    mockPrisma.otpCode.updateMany.mockResolvedValue({ count: 1 });
    // The double-tap tests install a counting implementation (orderReads) — never let it leak.
    mockPrisma.redemptionOrder.findFirst.mockReset();
    mockPrisma.auditLog.create.mockResolvedValue({ id: 'audit1' });
    mockPrisma.outlet.findMany.mockResolvedValue([]); // default: no extra outlet-keyed assignments
    mockPrisma.salesUser.findMany.mockResolvedValue([]); // default: no edges → downline = caller only
    // Per-outlet-type gate defaults (Loyalty + Sales-Assisted Redemption): a WHOLESALER primary
    // outlet + no config row → isLoyaltyEnabledForPartner true (schema default) AND
    // isSalesRedeemEnabledForPartner true (preserve-today default = wholesalers only). Loyalty-off
    // and sales-redeem-off cases override these. (Self-path loyalty tests override findFirst with a
    // code-less outlet — fine, they never call the sales-redeem resolver.)
    mockPrisma.outlet.findFirst.mockResolvedValue({ outletTypeId: 'ot1', outletType: { code: 'WHOLESALER' } });
    mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue(null);
    // Default eligible partner for the in-tx TOCTOU re-check (all modes now gated).
    mockPrisma.channelPartner.findFirst.mockResolvedValue(ELIGIBLE_FRESH_PARTNER);
    // Default eligible catalog item for the in-tx confirm-time re-check (DEF-3): the
    // fixed confirmRedeem/confirmRedeemForOutlet re-load the item inside the tx and
    // abort if it no longer resolves. A deterministic default keeps the legacy confirm
    // tests green without relying on cross-test mock leakage; per-test overrides win.
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'r1' });
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
            // Gift Catalogue moderation gate — only APPROVED items are browsable.
            moderationStatus: 'APPROVED',
            pointsCost: { gte: 10, lte: 200 },
            // Wave-2 vendor visibility cascade (review CRITICAL #2): PLATFORM rows +
            // VENDOR rows only while the vendor is ACTIVE with an ACTIVE grant.
            OR: [
              { sourceType: 'PLATFORM' },
              {
                sourceType: 'VENDOR',
                vendor: { is: { status: 'ACTIVE', grants: { some: { clientId: 'deoleo', status: 'ACTIVE' } } } },
              },
            ],
          },
        }),
      );
      expect(res.userBalance).toBe(100);
      expect(res.items[0].isAffordable).toBe(true);
      expect(res.items[1].isAffordable).toBe(false);
      expect(res.pagination).toEqual({ page: 1, limit: 20, total: 2, pages: 1 });
    });

    it('includes the category relation and surfaces its name as a flat label', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100 });
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([
        { id: 'r1', pointsCost: 50, redemptionMode: 'GIFT_CARD', category: { name: 'Gift Vouchers' } },
      ]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(1);

      const res = await service.listCatalog(partner, {});

      // Member-safe projection: an explicit `select` (NOT include) that carries the
      // category relation for the FE tabs but EXCLUDES ops/internal columns.
      const call = mockPrisma.rewardCatalog.findMany.mock.calls[0][0];
      expect(call.select).toBeDefined();
      expect(call.include).toBeUndefined();
      expect(call.select.category).toEqual({ select: { name: true, sortOrder: true } });
      // Flag OFF (default) → the cost-basis columns are NOT even selected for members, and
      // mrpPaise is never part of the member projection (cost-basis inference leak guard).
      expect(call.select.sellingValuePaise).toBeUndefined();
      expect(call.select.mrpPaise).toBeUndefined();
      // Other ops/internal columns must NOT be selected for members.
      expect(call.select.vendorId).toBeUndefined();
      expect(call.select.giftMasterId).toBeUndefined();
      expect(call.select.giftCategoryId).toBeUndefined();
      expect(call.select.moderationStatus).toBeUndefined();
      // sourceType IS read (to derive the member-safe `requiresConsent` boolean) but is
      // STRIPPED from the response — the raw source/vendor origin never reaches members.
      expect(call.select.sourceType).toBe(true);
      expect(res.items[0]).not.toHaveProperty('sourceType');
      expect(res.items[0]).not.toHaveProperty('mrpPaise');
      // The nested relation is flattened to a plain string label.
      expect(res.items[0].category).toBe('Gift Vouchers');
      expect(res.items[0].redemptionMode).toBe('GIFT_CARD');
    });

    it('surfaces the category sortOrder as a flat categorySort for the dynamic chip row', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100 });
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([
        { id: 'r1', pointsCost: 50, category: { name: 'Electronics', sortOrder: 5 } },
      ]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(1);

      const res = await service.listCatalog(partner, {});
      expect(res.items[0].category).toBe('Electronics');
      expect(res.items[0].categorySort).toBe(5);
    });

    it('derives requiresConsent from sourceType (true for VENDOR) without leaking sourceType', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100 });
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([
        { id: 'r1', pointsCost: 50, sourceType: 'PLATFORM', category: { name: 'A' } },
        { id: 'r2', pointsCost: 60, sourceType: 'VENDOR', category: { name: 'B' } },
      ]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(2);

      const res = await service.listCatalog(partner, {});
      expect(res.items[0]).toMatchObject({ id: 'r1', requiresConsent: false });
      expect(res.items[1]).toMatchObject({ id: 'r2', requiresConsent: true });
      // Never leak the raw origin.
      expect(res.items[0]).not.toHaveProperty('sourceType');
      expect(res.items[1]).not.toHaveProperty('sourceType');
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

    it('flag ON: computes a rate-independent slashPoints AND never leaks mrpPaise/sellingValuePaise', async () => {
      // Flag ON → the slash paths transiently select the cost-basis columns to compute.
      mockPrisma.client.findFirst.mockResolvedValue({ features: { catalogueMrpSlash: true } });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100000 });
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([
        // round(500 × 60000 / 50000) = 600 (> 500) → slash shown; independent of any rate.
        { id: 'r1', pointsCost: 500, mrpPaise: 60000, sellingValuePaise: 50000, category: { name: 'A' } },
      ]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(1);

      const res = await service.listCatalog(partner, {});
      // Flag ON → cost-basis columns ARE selected transiently…
      const call = mockPrisma.rewardCatalog.findMany.mock.calls[0][0];
      expect(call.select.mrpPaise).toBe(true);
      expect(call.select.sellingValuePaise).toBe(true);
      expect(res.items[0].slashPoints).toBe(600);
      // …but NEITHER cost-basis column reaches the member — only the derived slash does.
      expect(res.items[0]).not.toHaveProperty('sellingValuePaise');
      expect(res.items[0]).not.toHaveProperty('mrpPaise');
    });

    it('flag ON: slashPoints is null when the selling value is absent / inverted / FREE_AMOUNT', async () => {
      mockPrisma.client.findFirst.mockResolvedValue({ features: { catalogueMrpSlash: true } });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100000 });
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([
        // no selling value → null
        { id: 'r1', pointsCost: 500, mrpPaise: 60000, sellingValuePaise: null, category: { name: 'A' } },
        // inverted: round(500 × 50000 / 60000) = 417 (< 500) → not strictly greater → null
        { id: 'r2', pointsCost: 500, mrpPaise: 50000, sellingValuePaise: 60000, category: { name: 'A' } },
        // FREE_AMOUNT (pointsCost 0) → null
        { id: 'r3', pointsCost: 0, mrpPaise: 60000, sellingValuePaise: 50000, category: { name: 'A' } },
      ]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(3);

      const res = await service.listCatalog(partner, {});
      expect(res.items.map((i: { slashPoints?: number | null }) => i.slashPoints)).toEqual([null, null, null]);
      res.items.forEach((i: Record<string, unknown>) => {
        expect(i).not.toHaveProperty('sellingValuePaise');
        expect(i).not.toHaveProperty('mrpPaise');
      });
    });

    it('flag OFF (default): no slashPoints emitted and cost-basis columns not even selected, even with mrp+selling set', async () => {
      // Default beforeEach → features {} → catalogueMrpSlash OFF (incl. Deoleo).
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100000 });
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([
        { id: 'r1', pointsCost: 500, mrpPaise: 60000, sellingValuePaise: 50000, category: { name: 'A' } },
      ]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(1);

      const res = await service.listCatalog(partner, {});
      const call = mockPrisma.rewardCatalog.findMany.mock.calls[0][0];
      // Defense-in-depth: the cost-basis columns are not read from the DB when the flag is OFF.
      expect(call.select.mrpPaise).toBeUndefined();
      expect(call.select.sellingValuePaise).toBeUndefined();
      // No slash field, and no cost-basis columns in the response.
      expect(res.items[0]).not.toHaveProperty('slashPoints');
      expect(res.items[0]).not.toHaveProperty('mrpPaise');
      expect(res.items[0]).not.toHaveProperty('sellingValuePaise');
    });
  });

  describe('getCatalogItem', () => {
    it('throws NotFound for an item outside the tenant', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      await expect(service.getCatalogItem(partner, 'r9')).rejects.toBeInstanceOf(NotFoundException);
      const call = mockPrisma.rewardCatalog.findFirst.mock.calls[0][0];
      // status=ACTIVE parity with listCatalog + member-safe select.
      expect(call.where).toEqual({
        id: 'r9',
        deletedAt: null,
        clientId: 'deoleo',
        status: 'ACTIVE',
        moderationStatus: 'APPROVED',
        // Wave-2 vendor visibility cascade (review CRITICAL #2).
        OR: [
          { sourceType: 'PLATFORM' },
          {
            sourceType: 'VENDOR',
            vendor: { is: { status: 'ACTIVE', grants: { some: { clientId: 'deoleo', status: 'ACTIVE' } } } },
          },
        ],
      });
      expect(call.select).toBeDefined();
      // Flag OFF (default) → cost-basis columns NOT selected; mrpPaise never in the member projection.
      expect(call.select.sellingValuePaise).toBeUndefined();
      expect(call.select.mrpPaise).toBeUndefined();
      expect(call.select.moderationStatus).toBeUndefined();
      // sourceType selected only to derive requiresConsent (stripped from the response).
      expect(call.select.sourceType).toBe(true);
    });

    it('returns the item with requiresConsent (false for PLATFORM) and no sourceType (flag OFF → no slashPoints)', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'r1', sourceType: 'PLATFORM' });
      const res = await service.getCatalogItem(partner, 'r1');
      // Flag OFF default → byte-identical to pre-feature: no slashPoints field.
      expect(res).toEqual({ item: { id: 'r1', requiresConsent: false } });
    });

    it('flags requiresConsent true for a VENDOR item without leaking sourceType', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'r1', sourceType: 'VENDOR' });
      const res = await service.getCatalogItem(partner, 'r1');
      expect(res.item).toMatchObject({ id: 'r1', requiresConsent: true });
      expect(res.item).not.toHaveProperty('sourceType');
    });

    it('flag ON: computes slashPoints and selects the cost basis transiently, but strips mrpPaise/sellingValuePaise', async () => {
      mockPrisma.client.findFirst.mockResolvedValue({ features: { catalogueMrpSlash: true } });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', sourceType: 'PLATFORM', pointsCost: 500, mrpPaise: 60000, sellingValuePaise: 50000,
      });
      const res = await service.getCatalogItem(partner, 'r1');
      const call = mockPrisma.rewardCatalog.findFirst.mock.calls[0][0];
      expect(call.select.mrpPaise).toBe(true);
      expect(call.select.sellingValuePaise).toBe(true);
      expect(res.item.slashPoints).toBe(600);
      expect(res.item).not.toHaveProperty('mrpPaise');
      expect(res.item).not.toHaveProperty('sellingValuePaise');
    });

    it('flag OFF: no slashPoints even when the item has mrp + selling value', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', sourceType: 'PLATFORM', pointsCost: 500, mrpPaise: 60000, sellingValuePaise: 50000,
      });
      const res = await service.getCatalogItem(partner, 'r1');
      expect(res.item).not.toHaveProperty('slashPoints');
      expect(res.item).not.toHaveProperty('mrpPaise');
      expect(res.item).not.toHaveProperty('sellingValuePaise');
    });
  });

  describe('createCatalogItem — FREE_AMOUNT completeness guard', () => {
    const baseDto = {
      categoryId: 'cat1',
      code: 'FA-1',
      name: 'Free Amount Voucher',
      redemptionMode: 'GIFT_CARD' as const,
    };
    beforeEach(() => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'cat1', clientId: 'deoleo' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null); // no code clash
      mockPrisma.rewardCatalog.create.mockResolvedValue({ id: 'r-new' });
    });

    it('rejects a pointsCost-0 item with a min but NO max (the un-redeemable-voucher bug)', async () => {
      await expect(
        service.createCatalogItem(gifsy, {
          ...baseDto,
          pointsCost: 0,
          minRedemptionPoints: 250,
          // maxRedemptionPoints omitted
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.rewardCatalog.create).not.toHaveBeenCalled();
    });

    it('rejects a pointsCost-0 item with neither bound', async () => {
      await expect(
        service.createCatalogItem(gifsy, { ...baseDto, pointsCost: 0 } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.rewardCatalog.create).not.toHaveBeenCalled();
    });

    it('accepts a pointsCost-0 item with a complete [min,max] range', async () => {
      await expect(
        service.createCatalogItem(gifsy, {
          ...baseDto,
          pointsCost: 0,
          minRedemptionPoints: 250,
          maxRedemptionPoints: 5000,
        } as never),
      ).resolves.toEqual({ item: { id: 'r-new' } });
      expect(mockPrisma.rewardCatalog.create).toHaveBeenCalled();
    });

    it('accepts a FIXED item (selling value, no bounds) — pointsCost is DERIVED', async () => {
      // Pure derive: no manual pointsCost; a selling value is the price driver (rate 1 → 500 pts).
      await expect(
        service.createCatalogItem(gifsy, { ...baseDto, sellingValuePaise: 50000 } as never),
      ).resolves.toEqual({ item: { id: 'r-new' } });
      const call = mockPrisma.rewardCatalog.create.mock.calls?.[0]?.[0];
      expect(call.data.pointsCost).toBe(500);
    });
  });

  describe('updateCatalogItem — FREE_AMOUNT completeness guard', () => {
    it('rejects clearing max on an existing free-amount voucher (effective max becomes null)', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', clientId: 'deoleo', deletedAt: null,
        pointsCost: 0, minRedemptionPoints: 250, maxRedemptionPoints: 5000, stockQuantity: null,
      });
      await expect(
        service.updateCatalogItem(gifsy, 'r1', { maxRedemptionPoints: null } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.rewardCatalog.update).not.toHaveBeenCalled();
    });

    it('allows a benign edit that keeps the range intact', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', clientId: 'deoleo', deletedAt: null,
        pointsCost: 0, minRedemptionPoints: 250, maxRedemptionPoints: 5000, stockQuantity: null,
      });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'r1', name: 'Renamed' });
      await expect(
        service.updateCatalogItem(gifsy, 'r1', { name: 'Renamed' } as never),
      ).resolves.toEqual({ item: { id: 'r1', name: 'Renamed' } });
      expect(mockPrisma.rewardCatalog.update).toHaveBeenCalled();
    });

    it('clears stale min/max when converting a free-amount voucher to FIXED', async () => {
      // Pure derive: convert FREE→FIXED by clearing the band AND setting a selling value;
      // pointsCost is DERIVED from it (rate 1 → ₹500 → 500 pts), not sent manually.
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', clientId: 'deoleo', deletedAt: null,
        pointsCost: 0, minRedemptionPoints: 250, maxRedemptionPoints: 5000, stockQuantity: null,
      });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'r1' });
      await service.updateCatalogItem(gifsy, 'r1', {
        minRedemptionPoints: null,
        maxRedemptionPoints: null,
        sellingValuePaise: 50000,
      } as never);
      expect(mockPrisma.rewardCatalog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pointsCost: 500,
            minRedemptionPoints: null,
            maxRedemptionPoints: null,
          }),
        }),
      );
    });
  });

  describe('listOrders', () => {
    // Order-timeline D4 (owner): a partner's My Orders HIDES never-confirmed orders — CANCELLED
    // with no history row at/after CONFIRMED and no dispatch/delivery stamp (no points were ever
    // deducted). Applied in the WHERE so findMany + count (pagination) agree. Locked literally.
    const HIDE_NEVER_CONFIRMED = {
      status: 'CANCELLED',
      dispatchedAt: null,
      deliveredAt: null,
      statusHistory: {
        none: {
          OR: [
            { toStatus: { in: ['CONFIRMED', 'PROCESSING', 'DISPATCHED', 'DELIVERED', 'RETURNED', 'FAILED'] } },
            // review: a CONFIRMED→CANCELLED row also proves confirmation (PENDING→CONFIRMED row missing)
            { fromStatus: { in: ['CONFIRMED', 'PROCESSING', 'DISPATCHED', 'DELIVERED', 'RETURNED', 'FAILED'] } },
          ],
        },
      },
    };

    it('D4: the member exclusion is applied to BOTH the page query and the count (pagination stays correct)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(7);

      const res = await service.listOrders(partner, { page: 2, limit: 5 });

      const findWhere = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
      const countWhere = mockPrisma.redemptionOrder.count.mock.calls[0][0].where;
      expect(findWhere.NOT).toEqual(HIDE_NEVER_CONFIRMED);
      expect(countWhere).toEqual(findWhere);
      expect(res.pagination).toEqual({ page: 2, limit: 5, total: 7, pages: 2 });
    });

    it('D4: a member status filter still combines with the exclusion (CANCELLED shows only once-confirmed cancels)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);

      await service.listOrders(partner, { status: 'CANCELLED' as never });

      expect(mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where).toEqual({
        partner: { clientId: 'deoleo' }, partnerId: 'cp1', status: 'CANCELLED', NOT: HIDE_NEVER_CONFIRMED,
      });
    });

    it('D4: admin (GIFSY) order views are unchanged — no exclusion, never-confirmed cancels still listed', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);

      await service.listOrders(gifsy, { status: 'CANCELLED' as never });

      const where = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ partner: { clientId: 'deoleo' }, status: 'CANCELLED' });
      expect(where.NOT).toBeUndefined();
    });

    it('scopes a non-admin to their own partner orders', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);

      await service.listOrders(partner, {});
      // Tenant scope is now the partner's own clientId column (so a login-less
      // switched sibling's orders are visible); non-admin still pins to their partnerId.
      expect(mockPrisma.redemptionOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { partner: { clientId: 'deoleo' }, partnerId: 'cp1', NOT: HIDE_NEVER_CONFIRMED },
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
          where: { partner: { clientId: 'deoleo' }, partnerId: 'none', NOT: HIDE_NEVER_CONFIRMED },
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
          where: { partner: { clientId: 'deoleo' } },
        }),
      );
    });

    it('scopes a SWITCHED non-admin to the sibling partnerId named by x-active-partner-id', async () => {
      // resolveActivePartnerId: own lookup, then the sibling authorization query.
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'grp1' }) // own (login) partner, grouped
        .mockResolvedValueOnce({ id: 'cp-sib' });               // requested sibling is operable
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);

      await service.listOrders(partner, {}, 'cp-sib');
      expect(mockPrisma.redemptionOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { partner: { clientId: 'deoleo' }, partnerId: 'cp-sib', NOT: HIDE_NEVER_CONFIRMED },
        }),
      );
    });

    it('403s a non-admin whose x-active-partner-id is not an operable sibling', async () => {
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'grp1' }) // own partner
        .mockResolvedValueOnce(null);                          // requested id not operable
      await expect(service.listOrders(partner, {}, 'cp-foreign'))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.redemptionOrder.findMany).not.toHaveBeenCalled();
    });

    // ── "Load more" paging (fix/list-caps) ─────────────────────────────────────────
    // Rows newest-first; the service fetches limit+1 to learn whether another page exists.
    const orderRow = (n: number) => ({
      id: `o${String(n).padStart(3, '0')}`,
      status: 'CONFIRMED',
      createdAt: new Date(Date.now() - n * 60_000),
      updatedAt: new Date(Date.now() - n * 60_000),
    });

    it('page mode: page 2 skips page 1, uses a stable (createdAt,id) order and returns the next rows', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      // DB holds 7 rows; page 2 @ limit 5 → rows 6..7 (no extra row → last page).
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([orderRow(6), orderRow(7)]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(7);

      const res = await service.listOrders(partner, { page: 2, limit: 5 });

      const args = mockPrisma.redemptionOrder.findMany.mock.calls[0][0];
      expect(args.skip).toBe(5);
      expect(args.take).toBe(6); // limit + 1 sentinel
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(res.orders.map((o: { id: string }) => o.id)).toEqual(['o006', 'o007']);
      expect(res.nextCursor).toBeNull();
      expect(res.pagination).toEqual({ page: 2, limit: 5, total: 7, pages: 2 });
    });

    it('returns exactly `limit` rows + a nextCursor of the LAST returned row when more exist', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      // limit 3 → the DB answers 4 rows (the sentinel says "more exist").
      const rows = [orderRow(1), orderRow(2), orderRow(3), orderRow(4)];
      mockPrisma.redemptionOrder.findMany.mockResolvedValue(rows);
      mockPrisma.redemptionOrder.count.mockResolvedValue(10);

      const res = await service.listOrders(partner, { limit: 3 });

      expect(res.orders.map((o: { id: string }) => o.id)).toEqual(['o001', 'o002', 'o003']);
      expect(res.nextCursor).toBe(encodeOrderCursor(rows[2].createdAt, 'o003'));
      expect(decodeOrderCursor(res.nextCursor as string)).toEqual({ createdAt: rows[2].createdAt, id: 'o003' });
    });

    it('cursor mode: page 2 = rows strictly after the cursor; D4 exclusion + partner scope kept; total is the full set', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([orderRow(4), orderRow(5)]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(5);
      const at = new Date('2026-10-01T10:00:00.000Z');
      const cursor = encodeOrderCursor(at, 'o003');

      // A cursor REPLACES the offset even if a page is also sent.
      const res = await service.listOrders(partner, { page: 9, limit: 3, cursor });

      const args = mockPrisma.redemptionOrder.findMany.mock.calls[0][0];
      const base = { partner: { clientId: 'deoleo' }, partnerId: 'cp1', NOT: HIDE_NEVER_CONFIRMED };
      expect(args.where).toEqual({
        AND: [
          base,
          { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: 'o003' } }] },
        ],
      });
      expect(args.skip).toBe(0);
      expect(args.take).toBe(4);
      // The count is the WHOLE filtered set (no keyset), still with the D4 exclusion.
      expect(mockPrisma.redemptionOrder.count.mock.calls[0][0].where).toEqual(base);
      expect(res.orders.map((o: { id: string }) => o.id)).toEqual(['o004', 'o005']);
      expect(res.nextCursor).toBeNull();
      expect(res.pagination.total).toBe(5);
    });

    it('cursor mode keeps the SWITCHED-sibling scope (and a status filter) inside the keyset query', async () => {
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'grp1' })
        .mockResolvedValueOnce({ id: 'cp-sib' });
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);
      const at = new Date('2026-10-01T10:00:00.000Z');

      await service.listOrders(
        partner,
        { cursor: encodeOrderCursor(at, 'oX'), status: 'DELIVERED' as never },
        'cp-sib',
      );

      const where = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
      expect(where.AND[0]).toEqual({
        partner: { clientId: 'deoleo' }, partnerId: 'cp-sib', status: 'DELIVERED', NOT: HIDE_NEVER_CONFIRMED,
      });
    });

    it('cursor mode still 403s a forged sibling id (no rows read)', async () => {
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'grp1' })
        .mockResolvedValueOnce(null);
      await expect(
        service.listOrders(partner, { cursor: encodeOrderCursor(new Date(), 'o1') }, 'cp-foreign'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.redemptionOrder.findMany).not.toHaveBeenCalled();
    });

    it('rejects a malformed cursor with 400 (never silently restarts from the top)', async () => {
      await expect(service.listOrders(partner, { cursor: 'not-a-cursor' }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.findMany).not.toHaveBeenCalled();
    });

    // ── View-only tenant-admin list (owner decision: CLIENT_ADMIN sees its OWN tenant's orders) ──
    const clientAdminA: JwtPayload = { sub: 'ca-a', role: 'CLIENT_ADMIN', clientId: 'tenantA', phone: '9990002222', name: '' };

    it('CLIENT_ADMIN of tenant A gets the ADMIN branch scoped to A only (all partners, no D4, no partner lookup)', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(42);

      const res = await service.listOrders(clientAdminA, { limit: 100 });

      expect(mockPrisma.channelPartner.findFirst).not.toHaveBeenCalled();
      const where = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ partner: { clientId: 'tenantA' } });
      expect(where.partnerId).toBeUndefined();
      expect(where.NOT).toBeUndefined();
      expect(mockPrisma.redemptionOrder.count.mock.calls[0][0].where).toEqual({ partner: { clientId: 'tenantA' } });
      expect(res.pagination.total).toBe(42);
    });

    it('CLIENT_ADMIN can never reach another tenant: the partner header is ignored and the scope stays its JWT clientId', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);

      await service.listOrders(clientAdminA, { status: 'DELIVERED' as never }, 'cp-of-tenantB');

      expect(mockPrisma.channelPartner.findFirst).not.toHaveBeenCalled();
      const where = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ partner: { clientId: 'tenantA' }, status: 'DELIVERED' });
      expect(JSON.stringify(where)).not.toContain('tenantB');
    });

    it('CLIENT_ADMIN cursor mode keeps the tenant-A scope inside the keyset query', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);
      const at = new Date('2026-10-01T10:00:00.000Z');

      await service.listOrders(clientAdminA, { cursor: encodeOrderCursor(at, 'oX') });

      const where = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
      expect(where.AND[0]).toEqual({ partner: { clientId: 'tenantA' } });
    });

    it('CLIENT_ADMIN never receives ANY character of a voucher code — null + voucherIssued indicator', async () => {
      const at = new Date('2026-10-01T10:00:00.000Z');
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([
        { id: 'o1', status: 'DELIVERED', voucherCode: 'AMZN-1234-5678-WXYZ', voucherProvider: 'Gifsy', createdAt: at, updatedAt: at },
        { id: 'o2', status: 'CONFIRMED', voucherCode: 'ABC12', voucherProvider: 'Gifsy', createdAt: at, updatedAt: at },
        { id: 'o3', status: 'PENDING', voucherCode: null, voucherProvider: null, createdAt: at, updatedAt: at },
      ]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(3);

      const res = await service.listOrders(clientAdminA, {});
      const [a, b, c] = res.orders as Array<{ voucherCode: string | null; voucherIssued?: boolean; voucherCodeMasked?: boolean }>;

      expect(a).toMatchObject({ voucherCode: null, voucherIssued: true, voucherCodeMasked: true });
      expect(b).toMatchObject({ voucherCode: null, voucherIssued: true, voucherCodeMasked: true });
      expect(c).toMatchObject({ voucherCode: null, voucherIssued: false, voucherCodeMasked: false });
      const body = JSON.stringify(res);
      // No part of any code — not even the last 4.
      for (const frag of ['AMZN', '1234', '5678', 'WXYZ', 'ABC12', 'BC12']) expect(body).not.toContain(frag);
    });

    it('Outlet ID + Phone: operator and CLIENT_ADMIN rows carry partner.outletCode + partner.phone; the member view does not', async () => {
      const at = new Date('2026-10-01T10:00:00.000Z');
      const rows = () => [
        {
          id: 'o1', status: 'DELIVERED', voucherCode: null, createdAt: at, updatedAt: at,
          partner: { id: 'cp1', businessName: 'Shree Stores', phone: '9811111111', user: { phone: '9000000000' }, outlets: [{ outletCode: 'BJ-0042' }] },
        },
        {
          id: 'o2', status: 'DELIVERED', voucherCode: null, createdAt: at, updatedAt: at,
          // No partner phone → the login's phone; no live outlet → null (the UI shows "—").
          partner: { id: 'cp2', businessName: 'Sibling', phone: null, user: { phone: '9822222222' }, outlets: [] },
        },
      ];
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.redemptionOrder.count.mockResolvedValue(2);

      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce(rows());
      const g = await service.listOrders(gifsy, {});
      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce(rows());
      const ca = await service.listOrders(clientAdminA, {});
      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce(rows());
      const m = await service.listOrders(partner, {});

      // The primary live outlet is picked exactly like the redemption report.
      const sel = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].select.partner.select;
      expect(sel.outlets).toEqual({
        where: { deletedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 1,
        select: { outletCode: true },
      });

      for (const res of [g, ca]) {
        expect(res.orders[0].partner).toEqual({ id: 'cp1', businessName: 'Shree Stores', outletCode: 'BJ-0042', phone: '9811111111' });
        expect(res.orders[1].partner).toEqual({ id: 'cp2', businessName: 'Sibling', outletCode: null, phone: '9822222222' });
      }
      // Member view: unchanged shape — no outlet / phone / raw relation fields.
      expect(m.orders[0].partner).toEqual({ id: 'cp1', businessName: 'Shree Stores' });
      expect(JSON.stringify(m)).not.toContain('9811111111');
      expect(JSON.stringify(m)).not.toContain('BJ-0042');
    });

    it('GIFSY and the member (own orders) still receive the real voucher code', async () => {
      const at = new Date('2026-10-01T10:00:00.000Z');
      const row = { id: 'o1', status: 'DELIVERED', voucherCode: 'AMZN-1234-5678-WXYZ', createdAt: at, updatedAt: at };
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([row]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(1);

      const g = await service.listOrders(gifsy, {});
      const m = await service.listOrders(partner, {});

      for (const res of [g, m]) {
        const o = res.orders[0] as { voucherCode: string; voucherCodeMasked?: boolean };
        expect(o.voucherCode).toBe('AMZN-1234-5678-WXYZ');
        expect(o.voucherCodeMasked).toBeUndefined();
      }
    });

    it('item 14: the fulfilling operator list row carries server voucherFillable (canFillStoredVoucher); member + CLIENT_ADMIN never get it, nor pointsDeducted', async () => {
      const at = new Date('2026-10-01T10:00:00.000Z');
      const rows = [
        { id: 'o1', status: 'PROCESSING', voucherCode: 'CARD-1111-2222', voucherPin: null, voucherProvider: 'Croma', redemptionMode: 'GIFT_CARD', pointsDeducted: 500, metadata: {}, createdAt: at, updatedAt: at },
        { id: 'o2', status: 'PROCESSING', voucherCode: 'CARD-1111-2222', voucherPin: null, voucherProvider: 'Croma', redemptionMode: 'GIFT_CARD', pointsDeducted: 0, metadata: {}, createdAt: at, updatedAt: at },
        { id: 'o3', status: 'PROCESSING', voucherCode: 'CARD-1111-2222', voucherPin: null, voucherProvider: 'Hubble', redemptionMode: 'GIFT_CARD', pointsDeducted: 500, metadata: { hubbleStatus: 'SUCCESS' }, createdAt: at, updatedAt: at },
        { id: 'o4', status: 'RETURNED', voucherCode: 'CARD-1111-2222', voucherPin: null, voucherProvider: 'Croma', redemptionMode: 'GIFT_CARD', pointsDeducted: 500, metadata: {}, createdAt: at, updatedAt: at },
      ];
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.redemptionOrder.findMany.mockResolvedValue(rows);
      mockPrisma.redemptionOrder.count.mockResolvedValue(rows.length);

      const g = await service.listOrders(gifsy, {});
      expect(mockPrisma.redemptionOrder.findMany.mock.calls[0][0].select).toMatchObject({ pointsDeducted: true });
      expect((g.orders as Array<{ voucherFillable?: boolean }>).map((o) => o.voucherFillable)).toEqual([true, false, false, false]);
      for (const o of g.orders) expect(o).not.toHaveProperty('pointsDeducted');

      for (const viewer of [partner, clientAdminA]) {
        const res = await service.listOrders(viewer, {});
        for (const o of res.orders) {
          expect(o).not.toHaveProperty('voucherFillable');
          expect(o).not.toHaveProperty('pointsDeducted');
        }
      }
    });

    it('ListOrdersQueryDto caps limit at 500 (500 ok, 501 rejected; default 20 unchanged)', async () => {
      const errs = async (q: Record<string, unknown>) =>
        validate(plainToInstance(ListOrdersQueryDto, q)).then((e) => e.map((x) => x.property));
      expect(ORDERS_LIST_MAX_LIMIT).toBe(500);
      expect(await errs({ limit: '500' })).toEqual([]);
      expect(await errs({ limit: '100', status: 'PENDING' })).toEqual([]);
      expect(await errs({ limit: '501' })).toEqual(['limit']);
      expect(await errs({ limit: '0' })).toEqual(['limit']);
      expect(plainToInstance(ListOrdersQueryDto, {}).limit).toBe(20);
    });

    it('maskVoucherCode: last 4 only for 12+ chars, never the full code', () => {
      expect(maskVoucherCode('123456789012')).toBe('••••9012');
      expect(maskVoucherCode('  ABCDEFGHIJKL  ')).toBe('••••IJKL');
      expect(maskVoucherCode('12345678901')).toBe('••••');
      expect(maskVoucherCode('12345678')).toBe('••••');
      expect(maskVoucherCode('')).toBe('••••');
    });

    it('CLIENT_ADMIN with a blank clientId fails closed (never an unscoped, cross-tenant read)', async () => {
      await expect(service.listOrders({ ...clientAdminA, clientId: '' }, {}))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.redemptionOrder.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.count).not.toHaveBeenCalled();
    });

    it('MIS_USER and sales roles stay on the member branch (own partner only → empty for a non-partner)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);
      const mis: JwtPayload = { sub: 'mis1', role: 'MIS_USER', clientId: 'tenantA', phone: '9990003333', name: '' };

      await service.listOrders(mis, {});
      await service.listOrders(sales, {});

      expect(mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where).toEqual({
        partner: { clientId: 'tenantA' }, partnerId: 'none', NOT: HIDE_NEVER_CONFIRMED,
      });
      expect(mockPrisma.redemptionOrder.findMany.mock.calls[1][0].where).toEqual({
        partner: { clientId: 'deoleo' }, partnerId: 'none', NOT: HIDE_NEVER_CONFIRMED,
      });
    });

    it('GIFSY admin page mode is unchanged apart from the id tie-break (no exclusion, offset paging)', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);

      await service.listOrders(gifsy, { page: 1, limit: 100 });

      const args = mockPrisma.redemptionOrder.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ partner: { clientId: 'deoleo' } });
      expect(args.skip).toBe(0);
      expect(args.take).toBe(101);
    });
  });

  describe('getOrder', () => {
    it('throws NotFound for an order outside the tenant', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
      await expect(service.getOrder(partner, 'o9')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('forbids a non-admin from viewing another partner’s order', async () => {
      // Order belongs to cp-other; the caller's resolved active partner is cp1.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', partnerId: 'cp-other',
        partner: { userId: 'someoneElse' },
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' }); // resolve own
      await expect(service.getOrder(partner, 'o1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns the order for its owner (order.partnerId === resolved active partner)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', partnerId: 'cp1',
        partner: { userId: 'user1' },
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' }); // resolve own
      const res = await service.getOrder(partner, 'o1');
      expect(res.order.id).toBe('o1');
    });

    it('returns a SWITCHED sibling’s order when named by x-active-partner-id', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o2', partnerId: 'cp-sib',
        partner: { userId: null }, // login-less sibling
      });
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'grp1' }) // own partner
        .mockResolvedValueOnce({ id: 'cp-sib' });               // operable sibling
      const res = await service.getOrder(partner, 'o2', 'cp-sib');
      expect(res.order.id).toBe('o2');
    });

    it('MEMBER path uses a member-safe select (excludes ops-only fields) — audit #4', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', partnerId: 'cp1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      await service.getOrder(partner, 'o1');
      const call = mockPrisma.redemptionOrder.findFirst.mock.calls[0][0];
      expect(call.select).toBeDefined();
      expect(call.include).toBeUndefined();
      // ops-only fields must NOT be selected for a member
      expect(call.select.fulfilmentChannel).toBeUndefined();
      expect(call.select.supplierOrderRef).toBeUndefined();
      expect(call.select.fulfilledByVendorId).toBeUndefined();
      expect(call.select.podUrl).toBeUndefined();
      expect(call.select.notes).toBeUndefined();
      expect(call.select.valuePaise).toBeUndefined();
    });

    it('GIFSY path keeps the full detail (include) — audit #4', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', partnerId: 'cp1', reward: {}, partner: {} });
      const res = await service.getOrder(gifsy, 'o1');
      const call = mockPrisma.redemptionOrder.findFirst.mock.calls[0][0];
      expect(call.include).toBeDefined();
      expect(call.select).toBeUndefined();
      expect(res.order.id).toBe('o1');
    });
  });

  describe('trackOrder (member-safe tracking) — audit #5', () => {
    it('omits fulfilmentChannel from the payload and notes from the timeline', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', partnerId: 'cp1', orderNumber: 'D-1', status: 'DISPATCHED',
        reward: { id: 'r1', name: 'TV', imageUrls: [] }, quantity: 1,
        fulfilmentChannel: 'GIFSY_WAREHOUSE', logisticsPartner: 'BlueDart',
        trackingNumber: 'TN1', trackingUrl: null, dispatchedAt: new Date(), deliveredAt: null, cancelledAt: null,
        statusHistory: [{ fromStatus: 'CONFIRMED', toStatus: 'DISPATCHED', createdAt: new Date() }],
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });

      const res = await service.trackOrder(partner, 'o1');

      // fulfilmentChannel is ops-only — never on the member tracking payload.
      expect(res.tracking).not.toHaveProperty('fulfilmentChannel');
      expect(res.tracking.logisticsPartner).toBe('BlueDart'); // courier name IS member-safe
      // The statusHistory SELECT must not request `notes`.
      const call = mockPrisma.redemptionOrder.findFirst.mock.calls[0][0];
      expect(call.include.statusHistory.select).toEqual({ fromStatus: true, toStatus: true, createdAt: true });
      expect(call.include.statusHistory.select.notes).toBeUndefined();
    });

    // Order-timeline D5: "Points refunded" is shown ONLY when a refund was actually recorded —
    // every refund goes through wallet.reverse → a CREDIT_REVERSAL wallet row whose
    // referenceId is the order id (referenceType REDEMPTION_ORDER).
    const trackable = (over: Record<string, unknown> = {}) => ({
      id: 'o1', partnerId: 'cp1', orderNumber: 'D-1', status: 'CANCELLED',
      reward: { id: 'r1', name: 'TV', imageUrls: [] }, quantity: 1,
      logisticsPartner: null, trackingNumber: null, trackingUrl: null,
      dispatchedAt: null, deliveredAt: null, cancelledAt: new Date('2026-05-02T00:00:00Z'),
      statusHistory: [],
      ...over,
    });

    it('D5: returns refundedAt from the order’s CREDIT_REVERSAL wallet row (scoped to the order’s own wallet)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(trackable());
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      const refundedAt = new Date('2026-05-02T00:00:01Z');
      mockPrisma.walletTransaction.findFirst.mockResolvedValue({ createdAt: refundedAt });

      const res = await service.trackOrder(partner, 'o1');

      expect(res.tracking.refundedAt).toEqual(refundedAt);
      expect(mockPrisma.walletTransaction.findFirst).toHaveBeenCalledWith({
        where: {
          transactionType: 'CREDIT_REVERSAL',
          referenceType: 'REDEMPTION_ORDER',
          referenceId: 'o1',
          wallet: { partnerId: 'cp1' },
        },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
    });

    it('D5: refundedAt is null when no refund was recorded (e.g. a cancel that never deducted points)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(trackable());
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(null);

      const res = await service.trackOrder(partner, 'o1');

      expect(res.tracking.refundedAt).toBeNull();
    });

    it('D5: a forbidden (other partner’s) order never reads the wallet', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(trackable({ partnerId: 'cp-other' }));
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });

      await expect(service.trackOrder(partner, 'o1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.walletTransaction.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('updateOrder', () => {
    it('throws NotFound when the order is outside the tenant', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
      // An ASSUMED operator scopes by partner.clientId (§12).
      await expect(
        service.updateOrder(assumedGifsy, 'o9', { trackingNumber: 'TN1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.redemptionOrder.findFirst).toHaveBeenCalledWith({
        where: { id: 'o9', partner: { clientId: 'deoleo' } },
        include: { partner: { select: { clientId: true } } },
      });
    });

    it('updates tracking/notes (NON-status) within the tenant — no voucher write → plain update', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', status: 'CONFIRMED', pointsDeducted: 500, voucherCode: null, voucherProvider: null });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', trackingNumber: 'TN1' });
      const res = await service.updateOrder(gifsy, 'o1', {
        trackingNumber: 'TN1',
      });
      expect(mockPrisma.redemptionOrder.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: {
          trackingNumber: 'TN1',
          trackingUrl: undefined,
          notes: undefined,
        },
      });
      expect(res).toEqual({ order: { id: 'o1', trackingNumber: 'TN1' } });
    });
  });

  // ─── P5.4a CORE redemption pipeline ──────────────────────────────────────────

  // ── Per-outlet-type Loyalty gate (OutletTypeClientConfig.loyaltyEnabled) ─────────────────
  // Server-side enforcement (the FE gate is bypassable via a direct API call). When the active
  // outlet's type has Loyalty OFF, the catalogue is EMPTY and NEW redemptions are blocked.
  describe('per-outlet-type Loyalty gate', () => {
    const loyaltyItem = {
      id: 'r1', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null,
      pointsCost: 500, redemptionMode: 'GIFT_CARD',
      minRedemptionPoints: null, maxRedemptionPoints: null, stockQuantity: null,
    };

    it('listCatalog returns an EMPTY catalogue (same shape) when the outlet type has Loyalty OFF', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100 });
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletTypeId: 'ot1' });
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue({ loyaltyEnabled: false });

      const res = await service.listCatalog(partner, {});

      expect(res).toEqual({
        items: [],
        userBalance: 100,
        pagination: { page: 1, limit: 20, total: 0, pages: 0 },
      });
      // Early return — the catalogue is never queried when Loyalty is off.
      expect(mockPrisma.rewardCatalog.findMany).not.toHaveBeenCalled();
    });

    it('listCatalog behaves normally when Loyalty is ON (config loyaltyEnabled: true)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100 });
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletTypeId: 'ot1' });
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue({ loyaltyEnabled: true });
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([{ id: 'r1', pointsCost: 50 }]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(1);

      const res = await service.listCatalog(partner, {});
      expect(mockPrisma.rewardCatalog.findMany).toHaveBeenCalled();
      expect(res.items).toHaveLength(1);
      expect(res.userBalance).toBe(100);
    });

    it('redeem throws Forbidden when the outlet type has Loyalty OFF (before any wallet debit / order)', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(loyaltyItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletTypeId: 'ot1' });
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue({ loyaltyEnabled: false });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });

      await expect(service.redeem(partner, { rewardId: 'r1', quantity: 1 }))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('redeem proceeds (no Loyalty block) when config loyaltyEnabled: true — creates the PENDING order', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(loyaltyItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletTypeId: 'ot1' });
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue({ loyaltyEnabled: true });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'RDM-x' });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });

      const res = await service.redeem(partner, { rewardId: 'r1', quantity: 1 });
      const created = mockPrisma.redemptionOrder.create.mock.calls?.[0]?.[0];
      expect(created.data.status).toBe('PENDING');
      expect(res.orderId).toBe('o1');
    });

    it('redeem proceeds (default true) when there is NO config row for the outlet type', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(loyaltyItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      // Primary outlet resolves to a type, but no config row exists → schema default true.
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletTypeId: 'ot1' });
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue(null);
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'RDM-x' });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });

      const res = await service.redeem(partner, { rewardId: 'r1', quantity: 1 });
      expect(res.orderId).toBe('o1');
    });
  });

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

    // ── Global settings enforcement (channels + cash/voucher floor + rate snapshot) ──
    it('rejects redeem on a DISABLED redemption channel (server-side) before any order', async () => {
      mockSettings.redemptionChannels = { physicalGifts: true, vouchers: true, bankTransfer: false };
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        ...fixedItem, redemptionMode: 'BANK_TRANSFER', pointsCost: 0,
        minRedemptionPoints: 1, maxRedemptionPoints: 1_000_000,
      });
      await expect(service.redeem(partner, { rewardId: 'r1', amount: 500 }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('enforces the GLOBAL voucher floor even when within the per-item [min,max]', async () => {
      mockSettings.minVoucherFreeAmount = 250; // ₹250 floor, rate 1 → 250 points
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        ...fixedItem, redemptionMode: 'GIFT_CARD', pointsCost: 0,
        minRedemptionPoints: 1, maxRedemptionPoints: 1_000_000, // item range allows it
      });
      // amount 100 → 100 points: passes the per-item min(1) but below the global floor(250).
      await expect(service.redeem(partner, { rewardId: 'r1', amount: 100 }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('snapshots the conversion rate (centi) on the order at redeem time', async () => {
      mockSettings.conversionRate = 2; // centi 200
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'RDM-x' });
      mockPrisma.otpCode.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });

      await service.redeem(partner, { rewardId: 'r1', quantity: 1 });

      const created = mockPrisma.redemptionOrder.create.mock.calls?.[0]?.[0];
      expect(created.data.conversionRateCenti).toBe(200);
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

    it('resolves the per-tenant redemptionSelf template and passes it to sendOtp', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'RDM-x' });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });

      // Unset → sendOtp gets undefined (global env template).
      await service.redeem(partner, { rewardId: 'r1', quantity: 1 });
      expect(mockTenantSettings.getOtpTemplateId).toHaveBeenCalledWith('deoleo', 'redemptionSelf');
      expect(mockMsg91.sendOtp).toHaveBeenCalledWith('9991112222', expect.stringMatching(/^\d{6}$/), 'SMS', undefined);

      // Configured → sendOtp gets the per-tenant template id.
      jest.clearAllMocks();
      mockOtpTemplateId = 'self-tpl';
      await service.redeem(partner, { rewardId: 'r1', quantity: 1 });
      expect(mockMsg91.sendOtp).toHaveBeenCalledWith('9991112222', expect.stringMatching(/^\d{6}$/), 'SMS', 'self-tpl');
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
      // The cancel is a PENDING-guarded claim so it can never undo a concurrent confirm (review fix).
      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
      });
      // The cleanup deletes ONLY this request's OTP row (by id) — never login-wide.
      expect(mockPrisma.otpCode.deleteMany).toHaveBeenLastCalledWith({
        where: { id: 'otp1', verifiedAt: null },
      });
      // Order-timeline D1: the cleanup cancel is recorded in history (same tx).
      expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledWith({
        data: { orderId: 'o1', fromStatus: 'PENDING', toStatus: 'CANCELLED', changedById: 'user1', notes: 'OTP could not be sent' },
      });
    });

    it('review: OTP-send-failure cleanup never touches an order a concurrent confirm already CONFIRMED (no history) and still 503s', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'RDM-x' });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });
      mockMsg91.sendOtp.mockRejectedValueOnce(new Error('MSG91 unreachable'));
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 0 }); // no longer PENDING

      await expect(service.redeem(partner, { rewardId: 'r1', quantity: 1 }))
        .rejects.toThrow('Could not send the confirmation OTP. Please try again in a moment.');

      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
    });

    it('OTP-send-failure cleanup deletes ONLY its own OTP — a CONCURRENT redeem\'s fresh OTP for the same login survives', async () => {
      // In-memory otp_codes table honouring deleteMany's where (id / userId / purpose / verifiedAt).
      type Otp = { id: string; userId: string; purpose: string; verifiedAt: Date | null };
      let otps: Otp[] = [];
      const matches = (o: Otp, w: Partial<Otp>) =>
        (w.id === undefined || o.id === w.id) &&
        (w.userId === undefined || o.userId === w.userId) &&
        (w.purpose === undefined || o.purpose === w.purpose) &&
        (w.verifiedAt === undefined || o.verifiedAt === w.verifiedAt);
      mockPrisma.otpCode.deleteMany.mockImplementation(async ({ where }: { where: Partial<Otp> }) => {
        const before = otps.length;
        otps = otps.filter((o) => !matches(o, where));
        return { count: before - otps.length };
      });
      mockPrisma.otpCode.create.mockImplementation(async ({ data }: { data: Otp }) => {
        const row = { ...data, id: 'otp-mine', verifiedAt: null };
        otps.push(row);
        return row;
      });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'RDM-x' });
      // While OUR SMS send is in flight, a concurrent redeem (same login, e.g. another outlet)
      // commits its own fresh OTP — then our send fails.
      mockMsg91.sendOtp.mockImplementationOnce(async () => {
        otps.push({ id: 'otp-concurrent', userId: 'user1', purpose: 'REDEMPTION_CONFIRM', verifiedAt: null });
        throw new Error('MSG91 unreachable');
      });

      await expect(service.redeem(partner, { rewardId: 'r1', quantity: 1 }))
        .rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(otps.map((o) => o.id)).toEqual(['otp-concurrent']);
      mockPrisma.otpCode.deleteMany.mockReset();
      mockPrisma.otpCode.create.mockReset();
    });

    it('D1: superseding abandoned PENDING orders on redeem writes one PENDING→CANCELLED history row each', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o-new', orderNumber: 'RDM-x' });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([{ id: 'old1' }, { id: 'old2' }]);

      await service.redeem(partner, { rewardId: 'r1', quantity: 1 });

      expect(mockPrisma.redemptionOrder.findMany).toHaveBeenCalledWith({
        where: { partnerId: 'cp1', status: 'PENDING' },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      for (const id of ['old1', 'old2']) {
        expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
          where: { id, partnerId: 'cp1', status: 'PENDING' },
          data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
        });
        expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledWith({
          data: { orderId: id, fromStatus: 'PENDING', toStatus: 'CANCELLED', changedById: 'user1', notes: 'Superseded — OTP not completed' },
        });
      }
      expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledTimes(2);
      // Superseding never touches money.
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('review: a superseded order that a concurrent confirm wins (claim count 0) gets no history row and redeem proceeds', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o-new', orderNumber: 'RDM-x' });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([{ id: 'raced' }]);
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 0 }); // confirmed concurrently

      const res = await service.redeem(partner, { rewardId: 'r1', quantity: 1 });

      expect(res.orderId).toBe('o-new');
      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'raced', partnerId: 'cp1', status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
      });
      expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
    });

    it('D1: no abandoned PENDING orders → no supersede write and no history row', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o-new', orderNumber: 'RDM-x' });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });

      await service.redeem(partner, { rewardId: 'r1', quantity: 1 });

      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
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
      // KYC-APPROVED + active: required for ALL redemption modes (all-mode gate).
      partner: {
        id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
        kycSubmissions: [{ status: 'APPROVED' }],
      },
      reward: { name: 'Amazon ₹500', stockQuantity: null },
    };

    it('bumps attempts (atomic claim) and 401s on a wrong OTP', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });

      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '000000' }))
        .rejects.toThrow('Invalid OTP. 2 attempts remaining.');
      const claims = mockPrisma.$queryRaw.mock.calls.filter((c: any[]) => isOtpClaim(c[0]));
      expect(claims).toHaveLength(1);
      expect(claims[0][0].values).toEqual(['otp1', 3]);
      // the claim is never refunded on a miss
      expect(mockPrisma.otpCode.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { attempts: { decrement: 1 } } }),
      );
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('claim-before-compare: a lost claim → the existing 401 "Too many attempts", the code is never compared, no debit', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000),
      });
      refuseOtpClaims();
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });

      const err = await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe('Too many attempts — please restart the redemption.');
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    });

    it('L1 wording: a lost claim on a code that EXPIRED meanwhile → "OTP expired", no debit', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000),
      });
      refuseOtpClaims();
      mockPrisma.otpCode.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() - 1000), verifiedAt: null });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toThrow('OTP expired — please restart the redemption.');
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('L1 wording: a lost claim on a code that is GONE → "No active OTP found", no debit', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000),
      });
      refuseOtpClaims();
      mockPrisma.otpCode.findUnique.mockResolvedValue(null);
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toThrow('No active OTP found. Please restart the redemption.');
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('#3: the in-tx OTP consume is CONDITIONAL — already used → "No active OTP", tx aborts, no debit', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      mockPrisma.otpCode.updateMany.mockImplementation(async ({ data }: any) =>
        (data?.verifiedAt ? { count: 0 } : { count: 1 }));
      const err = await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe('No active OTP found. Please restart the redemption.');
      expect(mockPrisma.otpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp1', verifiedAt: null }, data: { verifiedAt: expect.any(Date) },
      });
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('#4 double-tap: claim lost but the order is already CONFIRMED → Conflict "Order is no longer awaiting confirmation"', async () => {
      // 1st read = the confirm's own order load; any re-read after the lost claim sees CONFIRMED.
      // (An implementation, not a Once-queue: clearAllMocks never drains Once values → no leak.)
      orderReads(pendingOrder, { status: 'CONFIRMED' });
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      refuseOtpClaims();
      const err = await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe('Order is no longer awaiting confirmation');
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('#4 double-tap: OTP already consumed (no active row) and order CONFIRMED → the same Conflict', async () => {
      orderReads(pendingOrder, { status: 'CONFIRMED' });
      mockPrisma.otpCode.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      const err = await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe('Order is no longer awaiting confirmation');
    });

    it('#4: a lost claim on a still-PENDING order keeps "Too many attempts"', async () => {
      orderReads(pendingOrder, { status: 'PENDING' });
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      refuseOtpClaims();
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toThrow('Too many attempts — please restart the redemption.');
    });

    it('claim-before-compare: a CORRECT code gives its claimed attempt back (a failed debit can be retried as before)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CONFIRMED' });

      await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });
      expect(mockPrisma.otpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp1', attempts: { gt: 0 } },
        data: { attempts: { decrement: 1 } },
      });
    });

    it('claim-before-compare: 100 parallel confirms (all reading attempts=0), right code LAST → no success, no debit', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      const row = simulateOtpClaims(mockPrisma);

      const otps = Array.from({ length: 100 }, (_, i) => (i === 99 ? '123456' : String(200000 + i)));
      const results = await Promise.allSettled(otps.map((otp) => service.confirmRedeem(partner, { orderId: 'o1', otp })));
      const msgs = results.map((r) => (r.status === 'rejected' ? (r.reason as Error).message : 'OK'));
      expect(msgs.filter((m) => m.startsWith('Invalid OTP'))).toHaveLength(3);
      // Exact remaining per winner, from each claim's post-increment value (was "2 …" for all three).
      expect(msgs.filter((m) => m.startsWith('Invalid OTP')).sort()).toEqual([
        'Invalid OTP. 0 attempts remaining.',
        'Invalid OTP. 1 attempt remaining.',
        'Invalid OTP. 2 attempts remaining.',
      ]);
      expect(msgs.filter((m) => m === 'Too many attempts — please restart the redemption.')).toHaveLength(97);
      expect(msgs).not.toContain('OK');
      expect(row.attempts).toBe(3);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('rejects a non-PENDING order with 400', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ ...pendingOrder, status: 'CONFIRMED' });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('forbids confirming an order that is not the resolved active partner’s', async () => {
      // Order belongs to cp-other; caller's resolved active partner is cp1 (default).
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder, partnerId: 'cp-other', partner: { id: 'cp-other', userId: 'someoneElse' },
      });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('forbids confirm + never debits when the outlet type’s Loyalty was turned OFF between redeem and confirm (TOCTOU)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      // Loyalty disabled for this outlet's type AFTER the PENDING order was created.
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletTypeId: 'ot1' });
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue({ loyaltyEnabled: false });

      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(ForbiddenException);
      // The throw is inside the tx, before the debit → points never move (rollback).
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('Finding-1: a REP-STAGED order (metadata.salesInitiatedById) is BLOCKED via self-confirm once the type has Sales-Assisted Redemption OFF — no debit', async () => {
      // The rep staged this order (redeem-for-outlet); OTP went to the outlet's own phone. If the
      // admin disables the type's sales-assisted redemption, the OWNER must not finish it via self-confirm.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ ...pendingOrder, metadata: { salesInitiatedById: 'su1' } });
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      // Loyalty stays ON (undefined→true); sales-assisted redemption explicitly OFF for this type.
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue({ salesAssistedRedeemEnabled: false });

      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toThrow('Sales-assisted redemption is not enabled for this outlet type.');
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('Finding-1: a genuine SELF order (no salesInitiatedById marker) is UNAFFECTED by the sales-redeem flag being OFF — still debits', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder); // no metadata marker
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CONFIRMED' });
      // Sales-assisted redemption OFF must NOT gate a self-redeem (loyalty stays the governing flag).
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue({ salesAssistedRedeemEnabled: false, loyaltyEnabled: true });

      const res = await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });
      expect(res.status).toBe('CONFIRMED');
      expect(mockWallet.debitRedeem).toHaveBeenCalled();
    });

    it('review: inside the confirm tx the order is claim + history insert, then OTP consume, then debit', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });

      await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });

      const claimOrder = mockPrisma.redemptionOrder.updateMany.mock.invocationCallOrder[0];
      const histOrder = mockPrisma.redemptionStatusHistory.create.mock.invocationCallOrder[0];
      // The OTP consume is now the CONDITIONAL updateMany carrying verifiedAt (#3).
      const markIdx = mockPrisma.otpCode.updateMany.mock.calls.findIndex((c: any[]) => c[0]?.data?.verifiedAt);
      const otpOrder = mockPrisma.otpCode.updateMany.mock.invocationCallOrder[markIdx];
      const debitOrder = mockWallet.debitRedeem.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(histOrder);
      expect(histOrder).toBeLessThan(otpOrder);
      expect(otpOrder).toBeLessThan(debitOrder);
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

      // OTP marked verified — conditionally (#3).
      expect(mockPrisma.otpCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'otp1', verifiedAt: null }, data: { verifiedAt: expect.any(Date) },
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
      // REDEMPTION_CONFIRMED fans out to the redeeming partner: IN_APP + PUSH (inside
      // notifyUserWithChannels) + config-driven paid channels, deep-linking to /partner/rewards.
      expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user1',
          eventKey: 'REDEMPTION_CONFIRMED',
          event: 'REDEMPTION_CONFIRMED',
          url: '/partner/rewards',
        }),
      );
      expect(res.status).toBe('CONFIRMED');
    });

    it('GIFT value-freeze: valuePaise = sellingValuePaise × qty from the redeem snapshot, rate-immune (§14)', async () => {
      // points=1000 @ rate 1 would give 100000n via the fallback; the gift snapshot
      // (50000 paise × qty 1 = 50000n) must WIN, proving the value is decoupled from rate.
      mockSettings.conversionRate = 5; // deliberately different — must be ignored for gifts
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'PHYSICAL_GIFT',
        quantity: 1,
        metadata: { sellingValuePaiseSnapshot: 50000 },
        reward: { name: 'Smart TV', stockQuantity: null, sellingValuePaise: 50000 },
      });
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CONFIRMED' });

      await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });

      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'PENDING' },
        data: { status: 'CONFIRMED', pointsDeducted: 1000, valuePaise: 50000n },
      });
    });

    it('GIFT value-freeze handles qty>1 (sellingValuePaise × quantity)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'PHYSICAL_GIFT',
        quantity: 3,
        totalPointsCost: 3000,
        metadata: { sellingValuePaiseSnapshot: 50000 },
        reward: { name: 'Smart TV', stockQuantity: null, sellingValuePaise: 50000 },
      });
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CONFIRMED' });

      await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });

      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: 'PENDING' },
        data: { status: 'CONFIRMED', pointsDeducted: 3000, valuePaise: 150000n }, // 50000 × 3
      });
    });

    it('paid-channel recipient is the OUTLET OWNER (partner.phone/ownerName); free channels keep the acting user', async () => {
      // The outlet owner's phone/name differ from the acting login (a switched-sibling redemption).
      // The paid channel must reach the OWNER; the free channels still address the acting user.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        partner: {
          ...pendingOrder.partner,
          phone: '9998887777',
          ownerName: 'Owner Name',
        },
      });
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CONFIRMED' });

      await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });

      expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledWith(
        expect.objectContaining({
          // Free channels: still the acting user (partner.sub = 'user1', phone 9991112222).
          userId: 'user1',
          eventKey: 'REDEMPTION_CONFIRMED',
          // Paid channel now addresses the outlet owner, NOT the acting login.
          recipientPhone: '9998887777',
          vars: expect.objectContaining({ ownerName: 'Owner Name' }),
        }),
      );
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
      // A lost claim records no CONFIRMED history row (shared transition gates on count).
      expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
    });

    // ── ELIGIBILITY GATE — all modes require KYC-APPROVED + active ─────────────

    it('GLB-1b: rejects a UPI redemption when the partner KYC is not APPROVED', async () => {
      // Partner KYC status is PENDING_RSM_APPROVAL — not APPROVED.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'UPI',
        partner: {
          id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'PENDING_RSM_APPROVAL' }],
        },
      });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
      // Gate fires before the OTP is verified and before any debit.
      expect(mockPrisma.otpCode.findFirst).not.toHaveBeenCalled();
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('GLB-1b: rejects a UPI redemption when the partner has no KYC submission', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'UPI',
        partner: {
          id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
          kycSubmissions: [],
        },
      });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('GLB-1b: rejects a BANK_TRANSFER redemption when the partner is inactive', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'BANK_TRANSFER',
        partner: {
          id: 'cp1', userId: 'user1', isActive: false, deletedAt: null,
          kycSubmissions: [{ status: 'APPROVED' }],
        },
      });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('GLB-1b: rejects a BANK_TRANSFER redemption when the partner is soft-deleted', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'BANK_TRANSFER',
        partner: {
          id: 'cp1', userId: 'user1', isActive: true, deletedAt: new Date(),
          kycSubmissions: [{ status: 'APPROVED' }],
        },
      });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    // ── BENEFICIARY-PRESENCE GUARD (pre-debit) ────────────────────────────────

    it('rejects a UPI redemption when the partner has NEITHER bank NOR upi (pre-debit)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'UPI',
        partner: {
          id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'APPROVED' }],
          // No rails at all.
          bankAccountNumber: null, ifscCode: null, upiId: null,
        },
      });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toThrow('Add your bank or UPI details');
      // Guard sits before OTP verification and any debit.
      expect(mockPrisma.otpCode.findFirst).not.toHaveBeenCalled();
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('rejects a BANK_TRANSFER redemption with a partial bank rail (acct but no IFSC) and no upi', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'BANK_TRANSFER',
        partner: {
          id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'APPROVED' }],
          // Incomplete bank rail (no IFSC), no upi → not payable.
          bankAccountNumber: '0011223344', ifscCode: null, upiId: null,
        },
      });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('allows a UPI redemption when ONLY upi is present (no bank)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'UPI',
        partner: {
          id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'APPROVED' }],
          bankAccountNumber: null, ifscCode: null, upiId: 'only@upi',
        },
      });
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      // Resolver own-lookup + in-tx TOCTOU re-read + bank snapshot all proxy this
      // mock; id 'cp1' makes the resolved active partner == order.partnerId.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'cp1', isActive: true, deletedAt: null,
        kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
        bankAccountHolder: null, ownerName: 'Owner', upiId: 'only@upi',
        bankAccountNumber: null, ifscCode: null, bankName: null,
      });
      mockPrisma.payoutTransaction.create.mockResolvedValue({ id: 'pt1' });

      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .resolves.toMatchObject({ status: 'CONFIRMED' });
      expect(mockWallet.debitRedeem).toHaveBeenCalled();
    });

    it('allows a BANK_TRANSFER redemption when ONLY a complete bank rail is present (no upi)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'BANK_TRANSFER',
        partner: {
          id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'APPROVED' }],
          bankAccountNumber: '0011223344', ifscCode: 'HDFC0001234', upiId: null,
        },
      });
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      // id 'cp1' so the resolver's own-lookup == order.partnerId (also serves the
      // in-tx TOCTOU re-read + bank snapshot, which proxy the same mock).
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'cp1', isActive: true, deletedAt: null,
        kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
        bankAccountHolder: 'Holder', ownerName: 'Owner', upiId: null,
        bankAccountNumber: '0011223344', ifscCode: 'HDFC0001234', bankName: 'HDFC',
      });
      mockPrisma.payoutTransaction.create.mockResolvedValue({ id: 'pt1' });

      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .resolves.toMatchObject({ status: 'CONFIRMED' });
      expect(mockWallet.debitRedeem).toHaveBeenCalled();
    });

    it('APPLIES the KYC gate to non-cash (GIFT_CARD) redemptions too (owner decision 2026-06-27)', async () => {
      // A GIFT_CARD order with a non-APPROVED partner is now REJECTED — no value or
      // goods to an unverified outlet. (Previously the gate was cash-only.)
      const nonCashOrder = {
        ...pendingOrder,
        redemptionMode: 'GIFT_CARD',
        partner: {
          id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'PENDING_SO_APPROVAL' }],
        },
      };
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(nonCashOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
      // Gate fires before the OTP is verified and before any debit.
      expect(mockPrisma.otpCode.findFirst).not.toHaveBeenCalled();
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    // ── GLB-2: ZERO-VALUE HARD FAIL (cash modes) ──────────────────────────────

    it('GLB-2: hard-fails inside the transaction when valuePaise would be 0 for a UPI redemption', async () => {
      // POINTS_CONVERSION_RATE is read at module init. We simulate a zero-value
      // result by using 0 totalPointsCost (0 pts × any rate = 0 paise). The gate
      // catches this inside the transaction — before the claim and wallet debit.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        totalPointsCost: 0, // causes valuePaise = 0n
        redemptionMode: 'UPI',
        partner: {
          id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'APPROVED' }],
          // Rail present so the pre-tx beneficiary guard passes and we reach GLB-2.
          bankAccountNumber: '0011223344', ifscCode: 'HDFC0001234', upiId: 'ravi@upi',
        },
      });
      // The resolver own-lookup (id 'cp1' == order.partnerId) + in-tx TOCTOU re-read
      // both proxy this mock; APPROVED so we reach GLB-2.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'cp1', isActive: true, deletedAt: null,
        kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
      });
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
      // The transaction rolled back — no debit and no order flip.
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'CONFIRMED' }) }),
      );
    });

    it('GLB-2: does NOT hard-fail for a non-cash (GIFT_CARD) order with zero points (no payout)', async () => {
      // Non-cash modes never create a PayoutTransaction, so zero valuePaise is safe.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        totalPointsCost: 0,
        redemptionMode: 'GIFT_CARD',
        partner: {
          id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'APPROVED' }],
        },
      });
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      // Should NOT throw BadRequest from GLB-2 (debitRedeem may still get called).
      await expect(service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' }))
        .resolves.toMatchObject({ status: 'CONFIRMED' });
    });

    // ── AUDIT FIX (MED): per-order OTP binding ────────────────────────────────
    // A login can now hold concurrent PENDING orders across outlets (login picker), whose
    // REDEMPTION_CONFIRM OTPs share the same login user. Before the fix the confirm returned the
    // LATEST unverified OTP regardless of order, so confirming order A could consume order B's OTP.
    // The OtpCode.referenceId scope binds each confirm to the OTP issued for THAT order.
    it('MED: an OTP issued for order B cannot confirm order A; the per-order OTP confirms B', async () => {
      const orderA = { ...pendingOrder, id: 'orderA', partnerId: 'cp1', orderNumber: 'RDM-A' };
      const orderB = { ...pendingOrder, id: 'orderB', partnerId: 'cp1', orderNumber: 'RDM-B' };
      // The ONLY live OTP is the one BOUND to order B (referenceId 'orderB'); order A has none.
      mockPrisma.otpCode.findFirst.mockImplementation((args: { where?: { referenceId?: string } }) =>
        Promise.resolve(
          args?.where?.referenceId === 'orderB'
            ? { id: 'otpB', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000) }
            : null,
        ),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'orderB', status: 'CONFIRMED' });

      // Confirming order A (with what the user believes is the OTP) finds NO order-A OTP → 401, no debit.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(orderA);
      await expect(service.confirmRedeem(partner, { orderId: 'orderA', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();

      // The correct per-order OTP confirms order B, and the lookup is scoped to order B's id.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(orderB);
      const res = await service.confirmRedeem(partner, { orderId: 'orderB', otp: '123456' });
      expect(res.status).toBe('CONFIRMED');
      expect(mockPrisma.otpCode.findFirst).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { userId: 'user1', purpose: 'REDEMPTION_CONFIRM', verifiedAt: null, referenceId: 'orderB' },
        }),
      );
      expect(mockWallet.debitRedeem).toHaveBeenCalledWith(
        'cp1', 1000, { referenceId: 'orderB', description: 'Redemption RDM-B' }, mockPrisma,
      );
    });

    it('MED: redeem binds the created OTP to the new order id (referenceId)', async () => {
      const fixedItem = {
        id: 'r1', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null,
        pointsCost: 500, redemptionMode: 'GIFT_CARD',
        minRedemptionPoints: null, maxRedemptionPoints: null, stockQuantity: null,
      };
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o-new', orderNumber: 'RDM-NEW' });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });

      await service.redeem(partner, { rewardId: 'r1', quantity: 1 });

      const otpCreate = mockPrisma.otpCode.create.mock.calls?.[0]?.[0];
      expect(otpCreate.data.referenceId).toBe('o-new'); // bound to the created order
    });
  });

  // ─── Wave 3 login-picker: partner-self outlet switching (x-active-partner-id) ──
  //
  // A multi-outlet login operates its own partner OR a login-less same-group,
  // same-phone sibling named by the `x-active-partner-id` header (threaded as
  // requestedPartnerId). resolveActivePartnerId is the whole access boundary:
  //   - own-lookup (findFirst by userId) resolves the login's own partner + groupId
  //   - a switch is authorized by a SECOND findFirst (the sibling operability query)
  // The MONEY INVARIANT: a switched redeem/confirm debits the SIBLING's wallet and
  // writes the SIBLING's order — never the login's own.
  describe('Wave 3 — partner-self outlet switching', () => {
    const fixedItem = {
      id: 'r1', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null,
      pointsCost: 500, redemptionMode: 'GIFT_CARD',
      minRedemptionPoints: null, maxRedemptionPoints: null, stockQuantity: null,
    };

    // ── redeem ──────────────────────────────────────────────────────────────
    it('no header → own partner: wallet + order target the login’s own partner', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' }); // own, ungrouped
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o1', orderNumber: 'RDM-x' });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });

      await service.redeem(partner, { rewardId: 'r1', quantity: 1 }); // NO header

      expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { partnerId: 'cp1' } });
      const created = mockPrisma.redemptionOrder.create.mock.calls?.[0]?.[0];
      expect(created.data.partnerId).toBe('cp1');
    });

    it('valid sibling header → redeem debits/creates against the SIBLING, OTP stays login-level', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      // resolveActivePartnerId: own-lookup (grouped) then the sibling operability query.
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'grp1' }) // login's own partner
        .mockResolvedValueOnce({ id: 'cp-sib' });               // requested sibling is operable
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o-sib', orderNumber: 'RDM-SIB' });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([{ id: 'old-sib' }]); // an abandoned PENDING

      const res = await service.redeem(partner, { rewardId: 'r1', quantity: 2 }, 'cp-sib');

      // Affordability + order + supersede all target the SIBLING.
      expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { partnerId: 'cp-sib' } });
      const created = mockPrisma.redemptionOrder.create.mock.calls?.[0]?.[0];
      expect(created.data.partnerId).toBe('cp-sib');
      expect(created.data.totalPointsCost).toBe(1000); // 500 × 2
      // Supersede is scoped to the SIBLING: same { partnerId, status: PENDING } predicate, now
      // read first and applied as a per-order claim through the shared status transition.
      expect(mockPrisma.redemptionOrder.findMany).toHaveBeenCalledWith({
        where: { partnerId: 'cp-sib', status: 'PENDING' },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'old-sib', partnerId: 'cp-sib', status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
      });
      // OTP is LOGIN-level: bound to + cleared for user.sub, not the sibling.
      expect(mockPrisma.otpCode.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user1', purpose: 'REDEMPTION_CONFIRM', verifiedAt: null },
      });
      const otpCreate = mockPrisma.otpCode.create.mock.calls?.[0]?.[0];
      expect(otpCreate.data.userId).toBe('user1');
      expect(res.orderId).toBe('o-sib');
    });

    it('forbidden header → ForbiddenException, NO order created and NO wallet debit', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'grp1' }) // own partner
        .mockResolvedValueOnce(null);                          // requested id is NOT operable

      await expect(service.redeem(partner, { rewardId: 'r1', quantity: 1 }, 'cp-foreign'))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    // ── confirm ─────────────────────────────────────────────────────────────
    it('confirm on a switched redeem STAYS on the sibling: debit + claim target order.partnerId', async () => {
      const switchedOrder = {
        id: 'o-sib', status: 'PENDING', partnerId: 'cp-sib', orderNumber: 'RDM-SIB',
        totalPointsCost: 1000, quantity: 1, redemptionMode: 'GIFT_CARD',
        // Login-less sibling: userId is null — the OLD userId-based ownership check
        // would 403 this; the new order.partnerId === activePartnerId check allows it.
        partner: {
          id: 'cp-sib', userId: null, isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'APPROVED' }],
        },
        reward: { name: 'Gift', stockQuantity: null },
      };
      // 1st findFirst = resolver own (grouped); 2nd = sibling operability (authorizes
      // cp-sib); 3rd+ = the in-tx TOCTOU re-read → beforeEach default (eligible).
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'grp1' })
        .mockResolvedValueOnce({ id: 'cp-sib' });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(switchedOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60000),
      });
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w-sib', redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o-sib', status: 'CONFIRMED' });

      const res = await service.confirmRedeem(partner, { orderId: 'o-sib', otp: '123456' }, 'cp-sib');

      // OTP verified against the LOGIN user (login-level), not the sibling — AND scoped to THIS order.
      expect(mockPrisma.otpCode.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user1', purpose: 'REDEMPTION_CONFIRM', verifiedAt: null, referenceId: 'o-sib' },
        }),
      );
      // Debit + claim target the SIBLING wallet/order (order.partnerId), never cp1.
      expect(mockWallet.debitRedeem).toHaveBeenCalledWith(
        'cp-sib', 1000,
        { referenceId: 'o-sib', description: 'Redemption RDM-SIB' },
        mockPrisma,
      );
      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o-sib', status: 'PENDING' },
        data: { status: 'CONFIRMED', pointsDeducted: 1000, valuePaise: 100000n },
      });
      expect(res.status).toBe('CONFIRMED');
    });

    it('confirm with a forbidden header → ForbiddenException before any order load or debit', async () => {
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'grp1' }) // own
        .mockResolvedValueOnce(null);                          // requested not operable
      await expect(
        service.confirmRedeem(partner, { orderId: 'o-sib', otp: '123456' }, 'cp-foreign'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.redemptionOrder.findFirst).not.toHaveBeenCalled();
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    // ── reads ───────────────────────────────────────────────────────────────
    it('listCatalog affordability uses the SWITCHED sibling’s wallet', async () => {
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'grp1' })
        .mockResolvedValueOnce({ id: 'cp-sib' });
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 750 });
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([{ id: 'r1', pointsCost: 500 }]);
      mockPrisma.rewardCatalog.count.mockResolvedValue(1);

      const res = await service.listCatalog(partner, {}, 'cp-sib');
      expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { partnerId: 'cp-sib' } });
      expect(res.userBalance).toBe(750);
      expect(res.items[0].isAffordable).toBe(true);
    });

    it('getCatalogItem 403s a forbidden selector but is otherwise identity-agnostic', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'r1' });
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', groupId: 'grp1' })
        .mockResolvedValueOnce(null); // requested id not operable
      await expect(service.getCatalogItem(partner, 'r1', 'cp-foreign'))
        .rejects.toBeInstanceOf(ForbiddenException);
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
      // F5: authorizes EXACTLY the outlet-list row shape (SalesService.buildOutlets) — an
      // OUTLET-keyed assignment whose outlet belongs to this partner, is not deleted and is
      // not admin-PARKED (null-safe NOT_PARKED_OUTLET OR-wrap). No partnerId-only branch.
      const where = mockPrisma.salesUserAssignment.findFirst.mock.calls[0][0].where;
      expect(where).toEqual({
        salesUserId: { in: ['su1'] },
        unassignedAt: null,
        outletId: { not: null },
        outlet: {
          partnerId: 'cp-out',
          deletedAt: null,
          OR: [{ kycIntent: null }, { kycIntent: { not: 'PARKED' } }],
        },
      });
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

    it('BLOCKS with 403 (no order) when the outlet type has Sales-Assisted Redemption explicitly OFF', async () => {
      wireAssigned();
      // Explicit per-type disable wins over the wholesaler preserve-today default.
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue({ salesAssistedRedeemEnabled: false });
      await expect(
        service.redeemForOutlet(sales, { rewardId: 'r1', quantity: 1, targetPartnerId: 'cp-out' }),
      ).rejects.toThrow('Sales-assisted redemption is not enabled for this outlet type.');
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('BLOCKS with 403 for a non-wholesaler type when UNSET (preserve-today default OFF)', async () => {
      wireAssigned();
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletTypeId: 'ot9', outletType: { code: 'SSS' } });
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue(null); // unset → default off for SSS
      await expect(
        service.redeemForOutlet(sales, { rewardId: 'r1', quantity: 1, targetPartnerId: 'cp-out' }),
      ).rejects.toThrow('Sales-assisted redemption is not enabled for this outlet type.');
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('creates the order against the TARGET outlet, binds the OTP to the OUTLET, supersedes the OUTLET', async () => {
      wireAssigned();
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([{ id: 'old-out' }]); // an abandoned PENDING

      const res = await service.redeemForOutlet(sales, {
        rewardId: 'r1', quantity: 2, targetPartnerId: 'cp-out',
      });

      // Order belongs to the OUTLET partner.
      const created = mockPrisma.redemptionOrder.create.mock.calls?.[0]?.[0];
      expect(created.data.partnerId).toBe('cp-out');
      expect(created.data.totalPointsCost).toBe(1000); // 500 × 2
      expect(created.data.pointsDeducted).toBe(0);

      // Supersede prior PENDING is scoped to the OUTLET, not the sales user.
      expect(mockPrisma.redemptionOrder.findMany).toHaveBeenCalledWith({
        where: { partnerId: 'cp-out', status: 'PENDING' },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'old-out', partnerId: 'cp-out', status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
      });
      // ...and the superseded order now gets its PENDING→CANCELLED history row (actor = the rep).
      expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: 'old-out',
          fromStatus: 'PENDING',
          toStatus: 'CANCELLED',
          changedById: 'salesUser1',
          notes: 'Superseded — OTP not completed',
        },
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
      // 4th arg = resolved per-tenant template (undefined here → global env template).
      expect(mockMsg91.sendOtp).toHaveBeenCalledWith('9000000000', expect.stringMatching(/^\d{6}$/), 'SMS', undefined);

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

    it('D1: OTP send failure cancels the just-created order through the shared transition (history row, actor = rep) and 503s', async () => {
      wireAssigned();
      mockMsg91.sendOtp.mockRejectedValueOnce(new Error('MSG91 unreachable'));

      await expect(service.redeemForOutlet(sales, { rewardId: 'r1', quantity: 1, targetPartnerId: 'cp-out' }))
        .rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o-out', status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
      });
      expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledWith({
        data: { orderId: 'o-out', fromStatus: 'PENDING', toStatus: 'CANCELLED', changedById: 'salesUser1', notes: 'OTP could not be sent' },
      });
      // Cleanup deletes ONLY this request's OTP row (by id), never the outlet-login-wide set.
      expect(mockPrisma.otpCode.deleteMany).toHaveBeenLastCalledWith({
        where: { id: 'otp1', verifiedAt: null },
      });
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('OTP-send-failure cleanup leaves a CONCURRENT redeem\'s fresh OTP for the same outlet untouched', async () => {
      wireAssigned();
      type Otp = { id: string; userId: string; purpose: string; verifiedAt: Date | null };
      let otps: Otp[] = [];
      const matches = (o: Otp, w: Partial<Otp>) =>
        (w.id === undefined || o.id === w.id) &&
        (w.userId === undefined || o.userId === w.userId) &&
        (w.purpose === undefined || o.purpose === w.purpose) &&
        (w.verifiedAt === undefined || o.verifiedAt === w.verifiedAt);
      mockPrisma.otpCode.deleteMany.mockImplementation(async ({ where }: { where: Partial<Otp> }) => {
        const before = otps.length;
        otps = otps.filter((o) => !matches(o, where));
        return { count: before - otps.length };
      });
      mockPrisma.otpCode.create.mockImplementation(async ({ data }: { data: Otp }) => {
        const row = { ...data, id: 'otp-mine', verifiedAt: null };
        otps.push(row);
        return row;
      });
      // A second rep / the owner's self-redeem for the SAME outlet commits a fresh OTP while our send is in flight.
      mockMsg91.sendOtp.mockImplementationOnce(async () => {
        otps.push({ id: 'otp-concurrent', userId: 'outletUser1', purpose: 'REDEMPTION_CONFIRM', verifiedAt: null });
        throw new Error('MSG91 unreachable');
      });

      await expect(service.redeemForOutlet(sales, { rewardId: 'r1', quantity: 1, targetPartnerId: 'cp-out' }))
        .rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(otps.map((o) => o.id)).toEqual(['otp-concurrent']);
      mockPrisma.otpCode.deleteMany.mockReset();
      mockPrisma.otpCode.create.mockReset();
    });

    it('review: OTP-send-failure cleanup leaves an already-CONFIRMED outlet order untouched (no history) and still 503s', async () => {
      wireAssigned();
      mockMsg91.sendOtp.mockRejectedValueOnce(new Error('MSG91 unreachable'));
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.redeemForOutlet(sales, { rewardId: 'r1', quantity: 1, targetPartnerId: 'cp-out' }))
        .rejects.toThrow('Could not send the confirmation OTP. Please try again in a moment.');

      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
    });

    it('resolves the per-tenant redemptionSales template and passes it to sendOtp', async () => {
      wireAssigned();
      mockOtpTemplateId = 'sales-tpl';

      await service.redeemForOutlet(sales, { rewardId: 'r1', targetPartnerId: 'cp-out' });

      expect(mockTenantSettings.getOtpTemplateId).toHaveBeenCalledWith('deoleo', 'redemptionSales');
      // Sent to the OUTLET's phone with the resolved per-tenant template.
      expect(mockMsg91.sendOtp).toHaveBeenCalledWith('9000000000', expect.stringMatching(/^\d{6}$/), 'SMS', 'sales-tpl');
    });

    it('rejects insufficient OUTLET balance with 400 and creates NO order', async () => {
      wireAssigned();
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 100 }); // < 500

      await expect(
        service.redeemForOutlet(sales, { rewardId: 'r1', targetPartnerId: 'cp-out' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });

    it('ship-to name falls back to the outlet owner when the FE sends the gift name (HIGH#2)', async () => {
      wireAssigned();
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ ...fixedItem, name: 'SuperBrand TV' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ ...outletPartner, ownerName: 'Asha Retail' });
      await service.redeemForOutlet(sales, {
        rewardId: 'r1', targetPartnerId: 'cp-out',
        deliveryAddress: { name: 'SuperBrand TV', mobile: '9000000000', address: '1 MG Rd', city: 'Pune', state: 'MH', pincode: '411001' },
      } as never);
      const created = mockPrisma.redemptionOrder.create.mock.calls?.[0]?.[0];
      expect(created.data.deliveryName).toBe('Asha Retail');
    });

    it('ship-to name falls back to the outlet owner when the FE sends a blank name (HIGH#2)', async () => {
      wireAssigned();
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ ...outletPartner, ownerName: 'Asha Retail' });
      await service.redeemForOutlet(sales, {
        rewardId: 'r1', targetPartnerId: 'cp-out',
        deliveryAddress: { name: '   ', mobile: '9000000000', address: '1 MG Rd', city: 'Pune', state: 'MH', pincode: '411001' },
      } as never);
      const created = mockPrisma.redemptionOrder.create.mock.calls?.[0]?.[0];
      expect(created.data.deliveryName).toBe('Asha Retail');
    });

    it('a VENDOR item with NO vendorId is BLOCKED — no orphan/undispatchable order (LOW#7)', async () => {
      wireAssigned();
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ ...fixedItem, sourceType: 'VENDOR', vendorId: null });
      await expect(
        service.redeemForOutlet(sales, { rewardId: 'r1', targetPartnerId: 'cp-out', consent: true } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
    });
  });

  describe('confirmRedeemForOutlet', () => {
    const outletPartner = {
      id: 'cp-out', userId: 'outletUser1', user: { id: 'outletUser1', phone: '9000000000' },
      // Outlet OWNER identity (distinct from the login user's phone above) — the paid-channel
      // recipient for REDEMPTION_CONFIRMED, consistent with every other event.
      phone: '9000000001', ownerName: 'Outlet Owner',
      // Eligibility fields: this object also doubles as the in-tx TOCTOU freshPartner
      // (wireConfirm sets channelPartner.findFirst = outletPartner). All modes gated.
      isActive: true, deletedAt: null,
      kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
    };
    const pendingOrder = {
      id: 'o-out', status: 'PENDING', partnerId: 'cp-out', orderNumber: 'RDM-OUT',
      totalPointsCost: 1000, quantity: 1, redemptionMode: 'GIFT_CARD',
      // KYC-APPROVED + active: required for ALL redemption modes (all-mode gate).
      partner: {
        id: 'cp-out', userId: 'outletUser1', isActive: true, deletedAt: null,
        kycSubmissions: [{ status: 'APPROVED' }],
      },
      reward: { name: 'Amazon ₹500', stockQuantity: null },
    };
    // Factory (NOT a shared const): expiresAt is computed at TEST-RUN time. A describe-level const is
    // evaluated when Jest COLLECTS the file, so under full-suite load a test running >60 s later saw
    // an already-expired OTP ("OTP expired" flake, 2026-11-10).
    const goodOtp = () => ({
      id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
      expiresAt: new Date(Date.now() + 60_000), verifiedAt: null,
    });

    /** Wire an assigned outlet with a confirmable PENDING order + valid OTP. */
    const wireConfirm = () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(outletPartner);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue(goodOtp());
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockWallet.debitRedeem.mockResolvedValue({});
      mockPrisma.redemptionStatusHistory.create.mockResolvedValue({});
    };

    it('claim-before-compare: 100 parallel sales-assisted confirms, right code LAST → no success, no debit', async () => {
      wireConfirm();
      const row = simulateOtpClaims(mockPrisma);
      const otps = Array.from({ length: 100 }, (_, i) => (i === 99 ? '123456' : String(200000 + i)));
      const results = await Promise.allSettled(otps.map((otp) =>
        service.confirmRedeemForOutlet(sales, { orderId: 'o-out', otp, targetPartnerId: 'cp-out' })));
      const msgs = results.map((r) => (r.status === 'rejected' ? (r.reason as Error).message : 'OK'));
      expect(msgs.filter((m) => m.startsWith('Invalid OTP'))).toHaveLength(3);
      // Exact remaining per winner, from each claim's post-increment value (was "2 …" for all three).
      expect(msgs.filter((m) => m.startsWith('Invalid OTP')).sort()).toEqual([
        'Invalid OTP. 0 attempts remaining.',
        'Invalid OTP. 1 attempt remaining.',
        'Invalid OTP. 2 attempts remaining.',
      ]);
      expect(msgs.filter((m) => m === 'Too many attempts — please restart the redemption.')).toHaveLength(97);
      expect(msgs).not.toContain('OK');
      expect(row.attempts).toBe(3);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('#4 double-tap (sales-assisted): lost claim on an already-CONFIRMED order → Conflict', async () => {
      wireConfirm();
      orderReads(pendingOrder, { status: 'CONFIRMED' });
      refuseOtpClaims();
      const err = await service.confirmRedeemForOutlet(sales, {
        orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out',
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe('Order is no longer awaiting confirmation');
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('#3 (sales-assisted): the in-tx OTP consume is conditional — already used → "No active OTP", no debit', async () => {
      wireConfirm();
      mockPrisma.otpCode.updateMany.mockImplementation(async ({ data }: any) =>
        (data?.verifiedAt ? { count: 0 } : { count: 1 }));
      const err = await service.confirmRedeemForOutlet(sales, {
        orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out',
      }).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe('No active OTP found. Please restart the redemption.');
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('claim-before-compare: sales-assisted lost claim → existing 401 "Too many attempts", no debit', async () => {
      wireConfirm();
      refuseOtpClaims();
      const err = await service.confirmRedeemForOutlet(sales, {
        orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out',
      }).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toBe('Too many attempts — please restart the redemption.');
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('TOCTOU: if Sales-Assisted Redemption is turned OFF mid-flight, confirm is blocked and NO debit happens', async () => {
      wireConfirm();
      // Admin disables the outlet type's sales-assisted redemption between redeem and confirm.
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue({ salesAssistedRedeemEnabled: false });
      await expect(
        service.confirmRedeemForOutlet(sales, {
          orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out',
        }),
      ).rejects.toThrow('Sales-assisted redemption is not enabled for this outlet type.');
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

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

      // OTP looked up for the OUTLET's user (not the sales rep) — AND scoped to THIS order.
      expect(mockPrisma.otpCode.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'outletUser1', purpose: 'REDEMPTION_CONFIRM', verifiedAt: null, referenceId: 'o-out' },
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
      // Confirmation fan-out: FREE channels (IN_APP + PUSH) address the outlet's partner USER
      // (userId), but the PAID channel now addresses the OUTLET OWNER's phone (partner.phone),
      // NOT the login user's phone — consistent with every other event.
      expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'outletUser1',
          recipientPhone: '9000000001',
          eventKey: 'REDEMPTION_CONFIRMED',
          event: 'REDEMPTION_CONFIRMED',
          url: '/partner/rewards',
        }),
      );
      expect(res.status).toBe('CONFIRMED');
    });

    it('a wrong OTP 401s and does NOT debit', async () => {
      wireConfirm();
      mockPrisma.otpCode.findFirst.mockResolvedValue({ ...goodOtp(), code: '999999' });

      await expect(
        service.confirmRedeemForOutlet(sales, {
          orderId: 'o-out', otp: '000000', targetPartnerId: 'cp-out',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    // ── ELIGIBILITY GATE for the OUTLET — all modes require KYC-APPROVED ───────

    it('GLB-1b: rejects a UPI outlet redemption when the outlet KYC is not APPROVED', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(outletPartner);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'UPI',
        partner: {
          id: 'cp-out', userId: 'outletUser1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'PENDING_SO_APPROVAL' }],
        },
      });
      await expect(
        service.confirmRedeemForOutlet(sales, {
          orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.otpCode.findFirst).not.toHaveBeenCalled();
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('GLB-1b: rejects a BANK_TRANSFER outlet redemption when the outlet is inactive', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(outletPartner);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'BANK_TRANSFER',
        partner: {
          id: 'cp-out', userId: 'outletUser1', isActive: false, deletedAt: null,
          kycSubmissions: [{ status: 'APPROVED' }],
        },
      });
      await expect(
        service.confirmRedeemForOutlet(sales, {
          orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('APPLIES the KYC gate to non-cash outlet redemptions too (owner decision 2026-06-27)', async () => {
      // GIFT_CARD outlet order with a non-APPROVED partner is now REJECTED — no value
      // or goods to an unverified outlet via the sales-assisted path.
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(outletPartner);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'GIFT_CARD',
        partner: {
          id: 'cp-out', userId: 'outletUser1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'DRAFT' }],
        },
      });
      mockPrisma.otpCode.findFirst.mockResolvedValue(goodOtp());

      await expect(
        service.confirmRedeemForOutlet(sales, {
          orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    // ── GLB-2: ZERO-VALUE HARD FAIL for outlet cash redemptions ──────────────

    it('GLB-2: hard-fails inside the tx when valuePaise is 0 for a BANK_TRANSFER outlet redemption', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(outletPartner);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      // 0 totalPointsCost → valuePaise = 0n → hard-fail.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        totalPointsCost: 0,
        redemptionMode: 'BANK_TRANSFER',
        partner: {
          id: 'cp-out', userId: 'outletUser1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'APPROVED' }],
        },
      });
      mockPrisma.otpCode.findFirst.mockResolvedValue(goodOtp());
      await expect(
        service.confirmRedeemForOutlet(sales, {
          orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    // ── BENEFICIARY-PRESENCE GUARD (pre-debit, outlet) ───────────────────────

    it('rejects an outlet cash redemption when the outlet has NEITHER bank NOR upi', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue(outletPartner);
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'UPI',
        partner: {
          id: 'cp-out', userId: 'outletUser1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'APPROVED' }],
          bankAccountNumber: null, ifscCode: null, upiId: null,
        },
      });
      await expect(
        service.confirmRedeemForOutlet(sales, {
          orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out',
        }),
      ).rejects.toThrow('Add your bank or UPI details');
      expect(mockPrisma.otpCode.findFirst).not.toHaveBeenCalled();
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('allows an outlet cash redemption when at least one rail (upi) is present', async () => {
      mockPrisma.salesUser.findFirst.mockResolvedValue({ id: 'su1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        // outlet partner resolution + in-tx TOCTOU/snapshot read all proxy here.
        ...outletPartner,
        isActive: true, deletedAt: null,
        kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
        bankAccountHolder: null, ownerName: 'Outlet Owner', upiId: 'outlet@upi',
        bankAccountNumber: null, ifscCode: null, bankName: null,
      });
      mockPrisma.salesUserAssignment.findFirst.mockResolvedValue({ id: 'asg1' });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...pendingOrder,
        redemptionMode: 'UPI',
        partner: {
          id: 'cp-out', userId: 'outletUser1', isActive: true, deletedAt: null,
          kycSubmissions: [{ status: 'APPROVED' }],
          bankAccountNumber: null, ifscCode: null, upiId: 'outlet@upi',
        },
      });
      mockPrisma.otpCode.findFirst.mockResolvedValue(goodOtp());
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockWallet.debitRedeem.mockResolvedValue({});
      mockPrisma.redemptionStatusHistory.create.mockResolvedValue({});
      mockPrisma.payoutTransaction.create.mockResolvedValue({ id: 'pt1' });

      await expect(
        service.confirmRedeemForOutlet(sales, {
          orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out',
        }),
      ).resolves.toMatchObject({ status: 'CONFIRMED' });
      expect(mockWallet.debitRedeem).toHaveBeenCalled();
    });
  });

  // ─── Sales-assisted redeem: WHOLE-DOWNLINE scoping (mirrors GET /v1/sales/outlets) ───
  describe('requireAssignedPartner — whole-downline scoping (same scope as /sales/outlets)', () => {
    // Tenant 'deoleo' hierarchy (edges as SalesService.getMyOutlets loads them):
    //   su-ho → su-asm → su-so → { su-isr1, su-isr2 }      su-asm2 → su-isr3
    // plus su-x in ANOTHER tenant whose reportingToId (bogusly) points at su-asm.
    const EDGES = [
      { id: 'su-ho', reportingToId: null, clientId: 'deoleo' },
      { id: 'su-asm', reportingToId: 'su-ho', clientId: 'deoleo' },
      { id: 'su-so', reportingToId: 'su-asm', clientId: 'deoleo' },
      { id: 'su-isr1', reportingToId: 'su-so', clientId: 'deoleo' },
      { id: 'su-isr2', reportingToId: 'su-so', clientId: 'deoleo' },
      { id: 'su-asm2', reportingToId: 'su-ho', clientId: 'deoleo' },
      { id: 'su-isr3', reportingToId: 'su-asm2', clientId: 'deoleo' },
      { id: 'su-x', reportingToId: 'su-asm', clientId: 'other' },
    ];
    type Asg = { salesUserId: string; partnerId: string | null; outletId: string | null; unassignedAt: Date | null };
    let assignments: Asg[];
    let outlets: Record<string, { partnerId: string; deletedAt: Date | null; kycIntent: string | null }>;

    const jwt = (salesUserId: string, role = 'SALES_ASM'): JwtPayload => ({
      sub: `user-${salesUserId}`, role, clientId: 'deoleo', phone: '9990000000', name: '',
    });

    const fixedItem = {
      id: 'r1', clientId: 'deoleo', status: 'ACTIVE', deletedAt: null,
      pointsCost: 500, redemptionMode: 'GIFT_CARD',
      minRedemptionPoints: null, maxRedemptionPoints: null, stockQuantity: null,
    };
    const outletPartner = {
      id: 'cp-out', userId: 'outletUser1', user: { id: 'outletUser1', phone: '9000000000' },
      phone: '9000000001', ownerName: 'Outlet Owner', isActive: true, deletedAt: null,
      kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
    };
    const pendingOrder = {
      id: 'o-out', status: 'PENDING', partnerId: 'cp-out', orderNumber: 'RDM-OUT',
      totalPointsCost: 1000, quantity: 1, redemptionMode: 'GIFT_CARD',
      partner: { id: 'cp-out', userId: 'outletUser1', isActive: true, deletedAt: null, kycSubmissions: [{ status: 'APPROVED' }] },
      reward: { name: 'Amazon ₹500', stockQuantity: null },
    };

    beforeEach(() => {
      // cp-out's outlet out-1 is assigned (outletId-keyed, the master-upload shape) to su-isr1.
      assignments = [{ salesUserId: 'su-isr1', partnerId: null, outletId: 'out-1', unassignedAt: null }];
      // Caller resolution: JWT sub `user-<suId>` → that SalesUser, tenant-scoped.
      mockPrisma.salesUser.findFirst.mockImplementation(async ({ where }: any) => {
        const id = String(where.userId).replace(/^user-/, '');
        const e = EDGES.find((x) => x.id === id && x.clientId === where.clientId);
        return e ? { id: e.id } : null;
      });
      // Edge list honours the tenant filter (as Prisma would) — the cross-tenant su-x is excluded.
      // G3: also honours a `deletedAt: null` filter, so a walker that drops deleted nodes really loses them.
      mockPrisma.salesUser.findMany.mockImplementation(async ({ where }: any) => {
        const tenant = where?.clientId ?? where?.user?.clientId;
        return (EDGES as Array<(typeof EDGES)[number] & { deletedAt?: Date | null }>)
          .filter((e) => tenant === undefined || e.clientId === tenant)
          .filter((e) => !(where && 'deletedAt' in where && where.deletedAt === null && e.deletedAt))
          .map(({ id, reportingToId, deletedAt }) => ({ id, reportingToId, userId: `user-${id}`, isActive: true, deletedAt: deletedAt ?? null }));
      });
      mockPrisma.channelPartner.findFirst.mockImplementation(async ({ where }: any) =>
        // The in-tx TOCTOU re-check looks up by id only (no clientId) — honour clientId when given.
        where.id === 'cp-out' && (where.clientId === undefined || where.clientId === 'deoleo') ? outletPartner : null,
      );
      // Outlet fixture (the relation the guard filters through): out-1 belongs to cp-out.
      outlets = { 'out-1': { partnerId: 'cp-out', deletedAt: null, kycIntent: null } };
      // Evaluate the guard's real where-clause against the assignment + outlet fixtures, with
      // Prisma semantics (a relation filter on a null outletId never matches; `{ not: X }` on a
      // NULL column is false — hence the OR-wrap with `{ kycIntent: null }`).
      mockPrisma.salesUserAssignment.findFirst.mockImplementation(async ({ where }: any) => {
        const inIds: string[] = where.salesUserId?.in ?? [where.salesUserId];
        const outletMatches = (a: Asg): boolean => {
          if (where.outletId && 'not' in where.outletId && where.outletId.not === null && a.outletId == null) return false;
          if (!where.outlet) return true;
          const o = a.outletId ? outlets[a.outletId] : undefined;
          if (!o) return false;
          const w = where.outlet;
          if (w.partnerId !== undefined && o.partnerId !== w.partnerId) return false;
          if (w.deletedAt === null && o.deletedAt !== null) return false;
          if (w.OR) {
            return (w.OR as any[]).some((c) =>
              c.kycIntent === null ? o.kycIntent === null : o.kycIntent != null && o.kycIntent !== c.kycIntent.not,
            );
          }
          return true;
        };
        const hit = assignments.find(
          (a) =>
            inIds.includes(a.salesUserId) &&
            (where.unassignedAt === null ? a.unassignedAt === null : true) &&
            outletMatches(a),
        );
        return hit ? { id: 'asg-hit' } : null;
      });
      // Redeem + confirm plumbing.
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(fixedItem);
      mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 5000 });
      mockPrisma.redemptionOrder.create.mockResolvedValue({ id: 'o-out', orderNumber: 'RDM-OUT' });
      mockPrisma.otpCode.create.mockResolvedValue({ id: 'otp1' });
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(pendingOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60_000), verifiedAt: null,
      });
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockWallet.debitRedeem.mockResolvedValue({});
      mockPrisma.redemptionStatusHistory.create.mockResolvedValue({});
    });

    const redeem = (u: JwtPayload) => service.redeemForOutlet(u, { rewardId: 'r1', quantity: 1, targetPartnerId: 'cp-out' });
    const confirm = (u: JwtPayload) =>
      service.confirmRedeemForOutlet(u, { orderId: 'o-out', otp: '123456', targetPartnerId: 'cp-out' });

    it('loads edges with EXACTLY the getMyOutlets query (shared deleted-aware loader, tenant-scoped, no isActive filter)', async () => {
      await redeem(jwt('su-asm'));
      expect(mockPrisma.salesUser.findMany).toHaveBeenCalledWith({
        where: { clientId: 'deoleo' },
        select: { id: true, reportingToId: true, userId: true, isActive: true, deletedAt: true },
      });
      const where = mockPrisma.salesUserAssignment.findFirst.mock.calls[0][0].where;
      expect([...where.salesUserId.in].sort()).toEqual(['su-asm', 'su-isr1', 'su-isr2', 'su-so']);
    });

    it('G3: with the SO soft-deleted, the ASM above can still redeem + confirm for the ISR\'s outlet (same scope as the list); the SO is not in scope', async () => {
      const so = EDGES.find((e) => e.id === 'su-so') as { deletedAt?: Date | null };
      so.deletedAt = new Date('2026-11-01');
      try {
        await expect(redeem(jwt('su-asm'))).resolves.toBeDefined();
        await expect(confirm(jwt('su-asm'))).resolves.toMatchObject({ status: 'CONFIRMED' });
        const where = mockPrisma.salesUserAssignment.findFirst.mock.calls[0][0].where;
        expect([...where.salesUserId.in].sort()).toEqual(['su-asm', 'su-isr1', 'su-isr2']);
        // A sibling ASM is still refused (branch isolation unchanged).
        await expect(redeem(jwt('su-asm2'))).rejects.toThrow(new ForbiddenException('You are not assigned to this outlet'));
      } finally {
        so.deletedAt = null;
      }
    });

    it('manager (ASM) redeems for a subordinate rep\'s outlet → allowed; OTP still bound to the OUTLET', async () => {
      await expect(redeem(jwt('su-asm'))).resolves.toBeDefined();
      expect(mockPrisma.redemptionOrder.create.mock.calls[0][0].data.partnerId).toBe('cp-out');
      expect(mockPrisma.otpCode.create.mock.calls[0][0].data).toMatchObject({
        userId: 'outletUser1', purpose: 'REDEMPTION_CONFIRM',
      });
    });

    it('manager (ASM) confirms for a subordinate rep\'s outlet → allowed; debits the OUTLET wallet', async () => {
      await expect(confirm(jwt('su-asm'))).resolves.toMatchObject({ status: 'CONFIRMED' });
      expect(mockPrisma.otpCode.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: 'outletUser1', referenceId: 'o-out' }) }),
      );
      expect(mockWallet.debitRedeem).toHaveBeenCalledWith('cp-out', 1000, expect.anything(), mockPrisma);
    });

    it('a deep ancestor (HO, 3 levels up) is allowed on both redeem and confirm', async () => {
      await expect(redeem(jwt('su-ho', 'SALES_HO'))).resolves.toBeDefined();
      await expect(confirm(jwt('su-ho', 'SALES_HO'))).resolves.toMatchObject({ status: 'CONFIRMED' });
    });

    it('the assigned rep himself is still allowed (reps unchanged)', async () => {
      await expect(redeem(jwt('su-isr1', 'SALES_ISR'))).resolves.toBeDefined();
      await expect(confirm(jwt('su-isr1', 'SALES_ISR'))).resolves.toMatchObject({ status: 'CONFIRMED' });
    });

    it('a sibling rep (another rep\'s outlet) → 403 with the same message, on redeem AND confirm', async () => {
      await expect(redeem(jwt('su-isr2', 'SALES_ISR'))).rejects.toThrow(
        new ForbiddenException('You are not assigned to this outlet'),
      );
      await expect(confirm(jwt('su-isr2', 'SALES_ISR'))).rejects.toThrow(
        new ForbiddenException('You are not assigned to this outlet'),
      );
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('a manager OUTSIDE the downline (other branch ASM) → 403 on redeem AND confirm', async () => {
      await expect(redeem(jwt('su-asm2'))).rejects.toThrow(new ForbiddenException('You are not assigned to this outlet'));
      await expect(confirm(jwt('su-asm2'))).rejects.toThrow(new ForbiddenException('You are not assigned to this outlet'));
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('an outlet assigned to a subordinate who is in ANOTHER tenant (bogus edge) → 403 (edges are tenant-scoped)', async () => {
      assignments = [{ salesUserId: 'su-x', partnerId: 'cp-out', outletId: 'out-1', unassignedAt: null }];
      await expect(redeem(jwt('su-asm'))).rejects.toThrow(new ForbiddenException('You are not assigned to this outlet'));
      await expect(confirm(jwt('su-asm'))).rejects.toThrow(new ForbiddenException('You are not assigned to this outlet'));
    });

    // ── F5: the guard matches the outlet LIST exactly (buildOutlets row shape) ──
    it('F5: an admin-PARKED outlet (hidden from the list) → 403 for the assigned rep AND the manager, on redeem and confirm', async () => {
      outlets['out-1'].kycIntent = 'PARKED';
      for (const u of [jwt('su-isr1', 'SALES_ISR'), jwt('su-asm')]) {
        await expect(redeem(u)).rejects.toThrow(new ForbiddenException('You are not assigned to this outlet'));
        await expect(confirm(u)).rejects.toThrow(new ForbiddenException('You are not assigned to this outlet'));
      }
      expect(mockPrisma.redemptionOrder.create).not.toHaveBeenCalled();
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('F5: a NOT_INTERESTED outlet stays visible in the list → still allowed (null-safe parked filter)', async () => {
      outlets['out-1'].kycIntent = 'NOT_INTERESTED';
      await expect(redeem(jwt('su-isr1', 'SALES_ISR'))).resolves.toBeDefined();
      await expect(redeem(jwt('su-asm'))).resolves.toBeDefined();
    });

    it('F5: a partnerId-only assignment (outletId null — never in the list) → 403 for rep and manager', async () => {
      assignments = [{ salesUserId: 'su-isr1', partnerId: 'cp-out', outletId: null, unassignedAt: null }];
      for (const u of [jwt('su-isr1', 'SALES_ISR'), jwt('su-asm')]) {
        await expect(redeem(u)).rejects.toThrow(new ForbiddenException('You are not assigned to this outlet'));
        await expect(confirm(u)).rejects.toThrow(new ForbiddenException('You are not assigned to this outlet'));
      }
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('F5: a DELETED outlet → 403 for rep and manager', async () => {
      outlets['out-1'].deletedAt = new Date();
      for (const u of [jwt('su-isr1', 'SALES_ISR'), jwt('su-asm')]) {
        await expect(redeem(u)).rejects.toThrow(new ForbiddenException('You are not assigned to this outlet'));
      }
    });

    it('F5: an outlet-keyed assignment to ANOTHER partner\'s outlet never authorizes this partner', async () => {
      outlets['out-9'] = { partnerId: 'cp-other', deletedAt: null, kycIntent: null };
      assignments = [{ salesUserId: 'su-isr1', partnerId: 'cp-out', outletId: 'out-9', unassignedAt: null }];
      await expect(redeem(jwt('su-isr1', 'SALES_ISR'))).rejects.toThrow(
        new ForbiddenException('You are not assigned to this outlet'),
      );
    });

    it('a cross-tenant OUTLET is still rejected before any assignment check (tenant isolation unchanged)', async () => {
      await expect(
        service.redeemForOutlet(jwt('su-asm'), { rewardId: 'r1', targetPartnerId: 'cp-other-tenant' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.salesUserAssignment.findFirst).not.toHaveBeenCalled();
    });

    it('an UNASSIGNED outlet (unassignedAt set) is rejected for the manager and the ex-rep alike — as the list hides it', async () => {
      assignments = [{ salesUserId: 'su-isr1', partnerId: null, outletId: 'out-1', unassignedAt: new Date() }];
      await expect(redeem(jwt('su-asm'))).rejects.toThrow(new ForbiddenException('You are not assigned to this outlet'));
      await expect(redeem(jwt('su-isr1', 'SALES_ISR'))).rejects.toThrow(
        new ForbiddenException('You are not assigned to this outlet'),
      );
      expect(mockPrisma.salesUserAssignment.findFirst.mock.calls[0][0].where.unassignedAt).toBeNull();
    });

    it('MIS_USER mirrors the outlet list: no tenant-wide bypass — without a SalesUser row it is forbidden', async () => {
      const mis: JwtPayload = { sub: 'user-mis', role: 'MIS_USER', clientId: 'deoleo', phone: '9990000001', name: '' };
      await expect(redeem(mis)).rejects.toThrow(
        new ForbiddenException('Only sales users may redeem on behalf of an outlet'),
      );
      await expect(confirm(mis)).rejects.toThrow(
        new ForbiddenException('Only sales users may redeem on behalf of an outlet'),
      );
      expect(mockPrisma.salesUserAssignment.findFirst).not.toHaveBeenCalled();
    });

    it('MIS_USER is excluded by the same @Roles gate as /sales/outlets (role sets identical)', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RewardsController } = require('./rewards.controller');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SalesController } = require('../sales/sales.controller');
      const rf = new (require('@nestjs/core').Reflector)();
      const salesRoles: string[] = rf.getAllAndOverride('roles', [SalesController.prototype.getMyOutlets, SalesController]);
      for (const m of ['redeemForOutlet', 'confirmRedeemForOutlet']) {
        const r: string[] = rf.getAllAndOverride('roles', [RewardsController.prototype[m], RewardsController]);
        expect([...r].sort()).toEqual([...salesRoles].sort());
        expect(r).not.toContain('MIS_USER');
      }
    });
  });

  describe('transitionOrder', () => {
    // The status write is now a compare-and-set `updateMany where { id, status: <read status> }`
    // (the only redemptionOrder.updateMany whose `where` carries `status`).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const casCall = (): any =>
      mockPrisma.redemptionOrder.updateMany.mock.calls
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any[]) => c[0])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .find((a: any) => a?.where && 'status' in a.where);

    beforeEach(() => {
      // Post-CAS in-tx re-read (row lock held): carries the authoritative pointsDeducted.
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockImplementation(
        async ({ where }: { where: { id: string } }) => ({ id: where.id, pointsDeducted: 1000, voucherCode: null }),
      );
    });
    afterEach(() => {
      // clearAllMocks keeps implementations — drop this block's stateful fakes so they can't
      // leak into later describes (the top-level beforeEach re-seeds updateMany's default).
      mockPrisma.redemptionOrder.findFirst.mockReset();
      mockPrisma.redemptionOrder.updateMany.mockReset();
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockReset();
    });

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
      const upd = casCall();
      expect(upd.data.cancelledAt).toBeInstanceOf(Date);
    });

    it('does NOT double-refund when the atomic refund claim is lost (count 0)', async () => {
      // A concurrent refund-transition already zeroed pointsDeducted → claim matches 0 rows.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'RDM-x', pointsDeducted: 1000,
      });
      mockPrisma.redemptionOrder.updateMany
        .mockResolvedValueOnce({ count: 1 }) // status CAS wins…
        .mockResolvedValueOnce({ count: 0 }); // …but the refund claim is lost
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'user1', phone: '9991112222' });

      await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED });
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('REJECTS a manual CANCELLED for a cash (UPI) redemption — reversal is UTR-driven', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'RDM-x',
        pointsDeducted: 1000, redemptionMode: 'UPI',
      });
      await expect(
        service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // No refund, no write — the cash redemption cannot be manually cancelled.
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      expect(mockWallet.reverse).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
    });

    it('REJECTS a manual CANCELLED for a cash (BANK_TRANSFER) redemption too', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'PROCESSING', partnerId: 'cp1', orderNumber: 'RDM-x',
        pointsDeducted: 1000, redemptionMode: 'BANK_TRANSFER',
      });
      await expect(
        service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('REJECTS a manual RETURNED for a cash (UPI) redemption — would double-pay (BUG-1)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'RDM-x',
        pointsDeducted: 1000, redemptionMode: 'UPI',
      });
      await expect(
        service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.RETURNED }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // The refund must NOT fire — the PayoutTransaction is still payable via UTR.
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('REJECTS a manual FAILED for a cash (BANK_TRANSFER) redemption — would double-pay (BUG-1)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'PROCESSING', partnerId: 'cp1', orderNumber: 'RDM-x',
        pointsDeducted: 1000, redemptionMode: 'BANK_TRANSFER',
      });
      await expect(
        service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.FAILED }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('STILL allows CANCELLED for a non-cash (gift card) redemption + refunds once', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'RDM-x',
        pointsDeducted: 1000, redemptionMode: 'GIFT_CARD',
      });
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CANCELLED' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'user1', phone: '9991112222' });

      await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED });

      expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', pointsDeducted: { gt: 0 } },
        data: { pointsDeducted: 0 },
      });
      expect(mockWallet.reverse).toHaveBeenCalled();
      const upd = casCall();
      expect(upd.data.cancelledAt).toBeInstanceOf(Date);
    });

    it('DELIVERED→RETURNED (gift) zeroes valuePaise AND refunds points (§12 reversal)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'DELIVERED', partnerId: 'cp1', orderNumber: 'RDM-x',
        pointsDeducted: 1000, redemptionMode: 'PHYSICAL_GIFT',
      });
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'RETURNED' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'user1', phone: '9991112222' });

      await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.RETURNED });

      // valuePaise zeroed so 194R Source-2 + the disbursal report drop it.
      const upd = casCall();
      expect(upd.data.valuePaise).toBe(0n);
      // Points refunded via the atomic claim + wallet.reverse.
      expect(mockWallet.reverse).toHaveBeenCalledWith(
        'cp1', 1000, { referenceId: 'o1', description: 'Refund RDM-x' }, mockPrisma,
      );
    });

    it('is IDEMPOTENT — a no-op request for the current status skips write + notification', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'DISPATCHED', partnerId: 'cp1', orderNumber: 'RDM-x', pointsDeducted: 1000,
      });
      const res = await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.DISPATCHED });
      expect(res).toMatchObject({ skipped: true });
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
      expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
    });

    it('stamps the dispatch fields (channel/partner/supplierOrderRef/POD) alongside a move', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'RDM-x',
        pointsDeducted: 1000, redemptionMode: 'PHYSICAL_GIFT',
      });
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'PROCESSING' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'user1', phone: '9991112222' });

      await service.transitionOrder(gifsy, 'o1', {
        toStatus: UpdatableOrderStatus.PROCESSING,
        fulfilmentChannel: 'GIFSY_WAREHOUSE' as never,
        logisticsPartner: 'BlueDart',
        supplierOrderRef: 'AMZ-123',
      });
      const upd = casCall();
      expect(upd.data).toMatchObject({
        fulfilmentChannel: 'GIFSY_WAREHOUSE',
        logisticsPartner: 'BlueDart',
        supplierOrderRef: 'AMZ-123',
      });
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

      const upd = casCall();
      expect(upd.data.dispatchedAt).toBeInstanceOf(Date);
      expect(upd.data.trackingNumber).toBe('TN9');
      expect(mockWallet.reverse).not.toHaveBeenCalled(); // forward move, no refund
      const hist = mockPrisma.redemptionStatusHistory.create.mock.calls?.[0]?.[0];
      expect(hist.data).toMatchObject({ orderId: 'o1', fromStatus: 'PROCESSING', toStatus: 'DISPATCHED' });
    });

    it('scopes the order load by partner.clientId for an ASSUMED operator (tenant)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
      await expect(
        service.transitionOrder(assumedGifsy, 'o9', { toStatus: UpdatableOrderStatus.PROCESSING }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.redemptionOrder.findFirst).toHaveBeenCalledWith({
        where: { id: 'o9', partner: { clientId: 'deoleo' } },
        include: { partner: { select: { clientId: true } } },
      });
    });

    it('loads cross-tenant (no partner filter) for an UN-assumed platform OWNER (console)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
      await expect(
        service.transitionOrder(gifsy, 'o9', { toStatus: UpdatableOrderStatus.PROCESSING }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.redemptionOrder.findFirst).toHaveBeenCalledWith({
        where: { id: 'o9' },
        include: { partner: { select: { clientId: true } } },
      });
    });

    // ── Race guard: the status write is a compare-and-set on the status that was READ. ──
    // A stateful in-memory order row: every caller's pre-tx read sees the SAME snapshot (the
    // stale-read / concurrent-click window), while updateMany honours its `where` against the
    // LIVE row — exactly the Postgres semantics the CAS relies on.
    describe('compare-and-set race guard', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let row: Record<string, any>;
      const installOrderRow = (initial: Record<string, unknown>) => {
        row = { ...initial };
        const snapshot = { ...initial };
        mockPrisma.redemptionOrder.findFirst.mockImplementation(async () => ({ ...snapshot }));
        mockPrisma.redemptionOrder.updateMany.mockImplementation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async ({ where, data }: { where: any; data: Record<string, unknown> }) => {
            if (where.id !== row.id) return { count: 0 };
            if ('status' in where && where.status !== row.status) return { count: 0 };
            if (where.pointsDeducted?.gt !== undefined && !(row.pointsDeducted > where.pointsDeducted.gt)) {
              return { count: 0 };
            }
            for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
            return { count: 1 };
          },
        );
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockImplementation(async () => ({ ...row }));
      };
      const giftOrder = (status: string) => ({
        id: 'o1', status, partnerId: 'cp1', orderNumber: 'RDM-x',
        pointsDeducted: 1000, redemptionMode: 'PHYSICAL_GIFT', voucherCode: null,
      });

      it('two concurrent CANCELLED from the same state → exactly one wins, loser 409, ONE refund + ONE history row', async () => {
        installOrderRow(giftOrder('CONFIRMED'));

        const results = await Promise.allSettled([
          service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED }),
          service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED }),
        ]);

        const won = results.filter((r) => r.status === 'fulfilled');
        const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        expect(lost[0].reason).toBeInstanceOf(ConflictException);
        expect(lost[0].reason.getStatus()).toBe(409);
        expect(lost[0].reason.message).toBe('Order status changed — refresh and try again');
        expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
        expect(mockWallet.reverse).toHaveBeenCalledWith(
          'cp1', 1000, { referenceId: 'o1', description: 'Refund RDM-x' }, mockPrisma,
        );
        expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledTimes(1);
        expect(row.status).toBe('CANCELLED');
        expect(row.pointsDeducted).toBe(0);
        // The winner's response reflects the refund claim.
        expect((won[0] as PromiseFulfilledResult<{ order: { pointsDeducted: number } }>).value.order.pointsDeducted).toBe(0);
      });

      it('two concurrent DISPATCHED (double click) → one write, one history row, loser 409', async () => {
        installOrderRow(giftOrder('PROCESSING'));

        const results = await Promise.allSettled([
          service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.DISPATCHED }),
          service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.DISPATCHED }),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        expect(lost).toHaveLength(1);
        expect(lost[0].reason).toBeInstanceOf(ConflictException);
        expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledTimes(1);
        // Only the winner notifies the member.
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
        expect(mockWallet.reverse).not.toHaveBeenCalled();
        expect(row.status).toBe('DISPATCHED');
      });

      it('RETURNED racing DELIVERED from DISPATCHED → exactly one lands; the refund runs only if RETURNED won', async () => {
        installOrderRow(giftOrder('DISPATCHED'));

        const results = await Promise.allSettled([
          service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.RETURNED }),
          service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.DELIVERED }),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        expect(lost[0].reason).toBeInstanceOf(ConflictException);
        expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledTimes(1);
        if (row.status === 'RETURNED') {
          expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
          expect(row.pointsDeducted).toBe(0);
        } else {
          expect(row.status).toBe('DELIVERED');
          expect(mockWallet.reverse).not.toHaveBeenCalled();
          expect(row.pointsDeducted).toBe(1000); // a delivered order keeps its debit
        }
      });

      it('a STALE read (order already moved on) → 409, NO refund, NO history, row untouched', async () => {
        installOrderRow(giftOrder('PROCESSING'));
        // Someone else dispatched it after our read was taken.
        row.status = 'DISPATCHED';

        await expect(
          service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED }),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(mockWallet.reverse).not.toHaveBeenCalled();
        expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
        expect(row).toMatchObject({ status: 'DISPATCHED', pointsDeducted: 1000 });
      });

      it('the CAS is the FIRST write and is keyed on the status that was read', async () => {
        installOrderRow(giftOrder('CONFIRMED'));
        await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED });
        const first = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
        // A refund-target claim also requires NO issued voucher code on the row at write time.
        expect(first.where).toEqual({
          id: 'o1', OR: [{ voucherCode: null }, { voucherCode: '' }], status: 'CONFIRMED',
        });
        expect(first.data.status).toBe('CANCELLED');
      });
    });
  });

  // ─── Issued-voucher refund block + "Voucher cancelled with vendor" (owner money rule) ───
  describe('issued-voucher refund block', () => {
    const BLOCK = "A voucher code was issued for this order. Record 'Voucher cancelled with vendor' first, then refund.";
    const voucherOrder = (status: string, extra: Record<string, unknown> = {}) => ({
      id: 'o1', status, partnerId: 'cp1', orderNumber: 'RDM-v', pointsDeducted: 1000,
      redemptionMode: 'GIFT_CARD', voucherCode: 'AMZN-1234-5678-WXYZ', voucherProvider: 'Gifsy', ...extra,
    });
    afterEach(() => {
      mockPrisma.redemptionOrder.findFirst.mockReset();
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockReset();
    });

    it.each([
      ['CONFIRMED', UpdatableOrderStatus.CANCELLED],
      ['CONFIRMED', UpdatableOrderStatus.RETURNED],
      ['PROCESSING', UpdatableOrderStatus.FAILED],
      ['PROCESSING', UpdatableOrderStatus.CANCELLED],
      ['DISPATCHED', UpdatableOrderStatus.RETURNED],
      ['DELIVERED', UpdatableOrderStatus.RETURNED],
    ])('blocks %s → %s while a voucher code is on the order (no write, no refund)', async (from, to) => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(voucherOrder(from));
      await expect(service.transitionOrder(gifsy, 'o1', { toStatus: to })).rejects.toThrow(BLOCK);
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('blocks a refund that tries to ISSUE a code on the same call (dto.voucherCode)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(voucherOrder('CONFIRMED', { voucherCode: null, voucherProvider: null }));
      await expect(service.transitionOrder(gifsy, 'o1', {
        toStatus: UpdatableOrderStatus.CANCELLED, voucherCode: 'NEW-CODE-9999',
      })).rejects.toThrow(BLOCK);
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('a forward move on a voucher order is unaffected (no voucher guard on the claim)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(voucherOrder('CONFIRMED'));
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValue({ id: 'o1', status: 'PROCESSING', pointsDeducted: 1000, voucherCode: 'AMZN-1234-5678-WXYZ' });
      await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.PROCESSING });
      expect(mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].where).toEqual({ id: 'o1', status: 'CONFIRMED' });
    });

    it('a code set CONCURRENTLY after the read makes the refund claim lose → 409, no refund', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(voucherOrder('CONFIRMED', { voucherCode: null, voucherProvider: null }));
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 }); // guard rejects the row
      await expect(service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED }))
        .rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].where.OR).toEqual([{ voucherCode: null }, { voucherCode: '' }]);
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('the bulk fulfilment upload path is blocked too (routes through transitionOrder)', async () => {
      const spy = jest.spyOn(service, 'transitionOrder');
      mockPrisma.redemptionOrder.findFirst
        .mockResolvedValueOnce({ id: 'o1' })               // upload: resolve the row by orderNumber
        .mockResolvedValueOnce(voucherOrder('CONFIRMED')); // transitionOrder read
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const XLSX = require('xlsx');
      const ws = XLSX.utils.aoa_to_sheet([
        ['Order Number', 'Reward', 'Mode', 'Current Status', 'Voucher Code', 'Voucher Provider', 'Tracking Number', 'Tracking URL', 'New Status'],
        ['RDM-v', 'X', 'GIFT_CARD', 'CONFIRMED', '', '', '', '', 'CANCELLED'],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Fulfilment');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      const res = await service.uploadFulfilment(gifsy, { buffer, originalname: 'f.xlsx' } as Express.Multer.File);
      expect(spy).toHaveBeenCalled();
      expect(res.failed).toBe(1);
      expect(res.errors[0].message).toBe(BLOCK);
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    describe('voucherCancelledWithVendor', () => {
      const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '9990002222', name: '' };
      const staff: JwtPayload = { sub: 'st1', role: 'GIFSY_STAFF', clientId: 'deoleo', assumed: true, phone: '9990004444', name: '' };

      it('clears the code + provider by CAS on the current code, audits reason + MASKED code, then a refund is allowed', async () => {
        const logSpy = jest.spyOn((service as unknown as { logger: { log: (m: string) => void } }).logger, 'log');
        mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce(voucherOrder('CONFIRMED'));
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1', status: 'CONFIRMED', voucherCode: null, voucherProvider: null, updatedAt: new Date() });

        const res = await service.voucherCancelledWithVendor(gifsy, 'o1', '  Vendor ref VC-77 refunded  ');

        expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'o1', voucherCode: 'AMZN-1234-5678-WXYZ',
            OR: [{ voucherProvider: null }, { NOT: { voucherProvider: { equals: 'hubble', mode: 'insensitive' } } }],
          },
          data: { voucherCode: null, voucherPin: null, voucherProvider: null },
        });
        // Tenant-wide reuse record: sha256 of the NORMALISED code (never the code itself).
        expect(mockPrisma.cancelledVoucherCode.createMany).toHaveBeenCalledWith({
          data: [{ clientId: 'deoleo', codeHash: hashVoucherCode('amzn-1234-5678-wxyz'), orderId: 'o1', cancelledById: 'admin1' }],
          skipDuplicates: true,
        });
        expect(JSON.stringify(mockPrisma.cancelledVoucherCode.createMany.mock.calls)).not.toContain('AMZN');
        // F4: the post-write re-read never selects the code.
        const reread = mockPrisma.redemptionOrder.findUniqueOrThrow.mock.calls[0][0];
        expect(reread.select).not.toHaveProperty('voucherCode');
        const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
        expect(audit).toMatchObject({ actorId: 'admin1', action: 'UPDATE', entityType: 'REDEMPTION_ORDER', entityId: 'o1' });
        expect(audit.metadata).toMatchObject({
          event: 'VOUCHER_CANCELLED_WITH_VENDOR', reason: 'Vendor ref VC-77 refunded', clearedVoucherCode: '••••WXYZ',
        });
        // Never the full code — not in the audit row, the logs, or the response.
        const everything = JSON.stringify([mockPrisma.auditLog.create.mock.calls, logSpy.mock.calls, res]);
        expect(everything).not.toContain('AMZN-1234-5678');
        expect(res.order.voucherCode).toBeNull();
        // No status change → no member-timeline row.
        expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();

        // The refund now passes the guard (the row has no code).
        mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce(voucherOrder('CONFIRMED', { voucherCode: null, voucherProvider: null }));
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1', status: 'CANCELLED', pointsDeducted: 1000, voucherCode: null });
        mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'user1', phone: '9991112222' });
        await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED });
        expect(mockWallet.reverse).toHaveBeenCalledWith('cp1', 1000, expect.anything(), mockPrisma);
      });

      it('double-click race: the second CAS matches 0 rows → 409 and writes NO audit row', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(voucherOrder('CONFIRMED'));
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValue({ id: 'o1', status: 'CONFIRMED', voucherCode: null, voucherProvider: null, updatedAt: new Date() });
        mockPrisma.redemptionOrder.updateMany
          .mockResolvedValueOnce({ count: 1 })  // first click wins
          .mockResolvedValueOnce({ count: 0 }); // second click: code already cleared

        const results = await Promise.allSettled([
          service.voucherCancelledWithVendor(gifsy, 'o1', 'r1'),
          service.voucherCancelledWithVendor(gifsy, 'o1', 'r2'),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason).toBeInstanceOf(ConflictException);
        expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['CLIENT_ADMIN', clientAdmin],
        ['GIFSY_STAFF', staff],
        ['partner', partner],
      ])('%s is forbidden (no read, no write)', async (_n, who) => {
        await expect(service.voucherCancelledWithVendor(who, 'o1', 'r')).rejects.toBeInstanceOf(ForbiddenException);
        expect(mockPrisma.redemptionOrder.findFirst).not.toHaveBeenCalled();
        expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      });

      it('requires a non-empty reason', async () => {
        await expect(service.voucherCancelledWithVendor(gifsy, 'o1', '   ')).rejects.toBeInstanceOf(BadRequestException);
        expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      });

      it('an order with no code → 409; a Hubble voucher is refused (non-reversible)', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce(voucherOrder('CONFIRMED', { voucherCode: null }));
        await expect(service.voucherCancelledWithVendor(gifsy, 'o1', 'r')).rejects.toBeInstanceOf(ConflictException);
        mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce(voucherOrder('CONFIRMED', { voucherProvider: 'Hubble' }));
        await expect(service.voucherCancelledWithVendor(gifsy, 'o1', 'r')).rejects.toBeInstanceOf(BadRequestException);
        expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      });

      it('DTO: reason is trimmed and required (blank → invalid)', async () => {
        const errs = async (q: Record<string, unknown>) =>
          validate(plainToInstance(VoucherCancelledWithVendorDto, q)).then((e) => e.map((x) => x.property));
        expect(await errs({ reason: 'ok' })).toEqual([]);
        expect(await errs({ reason: '   ' })).toEqual(['reason']);
        expect(await errs({})).toEqual(['reason']);
        expect(await errs({ reason: 'x'.repeat(501) })).toEqual(['reason']);
      });
    });
  });

  // ─── VOUCHER WRITE INVARIANT + code visibility (money + identity audits) ─────────────────
  // "A stored voucher code can never be cleared or replaced except by POST voucher-cancelled."
  describe('voucher write invariant', () => {
    const paid = (extra: Record<string, unknown> = {}) => ({
      id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'RDM-w', pointsDeducted: 500,
      redemptionMode: 'GIFT_CARD', voucherCode: null, voucherProvider: null, ...extra,
    });
    const issued = (extra: Record<string, unknown> = {}) => paid({ voucherCode: 'AMZN-1234-5678-WXYZ', voucherProvider: 'Gifsy', ...extra });
    afterEach(() => {
      mockPrisma.redemptionOrder.findFirst.mockReset();
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockReset();
    });
    const noWrite = () => {
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    };

    describe('updateOrder (PATCH + bulk non-status rows)', () => {
      it('clearing a stored code (null) is rejected, so the refund block still holds', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(issued());
        await expect(service.updateOrder(gifsy, 'o1', { voucherCode: null as never })).rejects.toThrow(/cleared or blank/);
        noWrite();
        await expect(service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED }))
          .rejects.toThrow(/Voucher cancelled with vendor/);
        expect(mockWallet.reverse).not.toHaveBeenCalled();
      });

      it.each([
        ['blank code', { voucherCode: '   ' }],
        ['null provider', { voucherProvider: null }],
        ['blank provider', { voucherProvider: '' }],
      ])('%s is a 400 with no write', async (_n, dto) => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid());
        await expect(service.updateOrder(gifsy, 'o1', dto as never)).rejects.toBeInstanceOf(BadRequestException);
        noWrite();
      });

      it('overwriting a stored code is a 400 "already issued" with no write', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(issued());
        await expect(service.updateOrder(gifsy, 'o1', { voucherCode: 'OTHER-CODE-0000' }))
          .rejects.toThrow("A voucher code is already issued; use 'Voucher cancelled with vendor' first.");
        noWrite();
      });

      it('re-sending the SAME stored code is an idempotent no-op (no voucher column written)', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(issued());
        mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1' });
        await service.updateOrder(gifsy, 'o1', { voucherCode: '  AMZN-1234-5678-WXYZ ', trackingNumber: 'TN' });
        const data = mockPrisma.redemptionOrder.update.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('voucherCode');
        expect(data.trackingNumber).toBe('TN');
      });

      it('a NEW code on a paid open order is a CAS (no code stored + writable status + paid); a lost claim is a 409', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid());
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1', voucherCode: 'NEW-CODE-1' });
        await service.updateOrder(gifsy, 'o1', { voucherCode: ' NEW-CODE-1 ' });
        const call = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
        expect(call.data.voucherCode).toBe('NEW-CODE-1');
        expect(call.where.id).toBe('o1');
        expect(call.where.AND).toEqual(expect.arrayContaining([
          { OR: [{ voucherCode: null }, { voucherCode: '' }] },
          { status: { in: ['CONFIRMED', 'PROCESSING', 'DISPATCHED'] } },
          { pointsDeducted: { gt: 0 } },
        ]));

        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(service.updateOrder(gifsy, 'o1', { voucherCode: 'NEW-CODE-2' })).rejects.toBeInstanceOf(ConflictException);
      });

      it.each([
        ['CANCELLED', { status: 'CANCELLED', pointsDeducted: 0 }],
        ['PENDING', { status: 'PENDING', pointsDeducted: 0 }],
        ['RETURNED', { status: 'RETURNED', pointsDeducted: 0 }],
        ['DELIVERED', { status: 'DELIVERED' }],
        ['unpaid CONFIRMED', { pointsDeducted: 0 }],
      ])('a code on a %s order is a 400 with no write', async (_n, extra) => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid(extra));
        await expect(service.updateOrder(gifsy, 'o1', { voucherCode: 'LATE-CODE-1' }))
          .rejects.toThrow(/only be issued on a confirmed, paid order/);
        noWrite();
      });

      it('a stored Hubble provider can never be relabelled, and Hubble is never hand-set', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid({ voucherProvider: 'Hubble' }));
        await expect(service.updateOrder(gifsy, 'o1', { voucherProvider: 'Gifsy' })).rejects.toThrow(/Hubble integration/);
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid());
        await expect(service.updateOrder(gifsy, 'o1', { voucherProvider: 'hubble' })).rejects.toThrow("The 'Hubble' provider is set by the integration only.");
        noWrite();
      });

      it('bulk upload: a blank-status row writing a code on a refunded order is a ROW error (no write)', async () => {
        mockPrisma.redemptionOrder.findFirst
          .mockResolvedValueOnce({ id: 'o1' })
          .mockResolvedValueOnce(paid({ status: 'CANCELLED', pointsDeducted: 0 }));
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const XLSX = require('xlsx');
        const ws = XLSX.utils.aoa_to_sheet([
          ['Order Number', 'Reward', 'Mode', 'Current Status', 'Voucher Code', 'Voucher Provider', 'Tracking Number', 'Tracking URL', 'New Status'],
          ['RDM-w', 'X', 'GIFT_CARD', 'CANCELLED', 'LATE-CODE-9', '', '', '', ''],
        ]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Fulfilment');
        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
        const res = await service.uploadFulfilment(gifsy, { buffer, originalname: 'f.xlsx' } as Express.Multer.File);
        expect(res.failed).toBe(1);
        expect(res.errors[0].message).toMatch(/only be issued on a confirmed, paid order/);
        noWrite();
      });

      // ── Re-audit of 9ea8fd5 ──
      it.each([
        ['stored provider "HUBBLE" (any case)', { voucherProvider: 'HUBBLE' }],
        ['hubbleNeedsReconcile flag', { metadata: { hubbleNeedsReconcile: true } }],
        ['a Hubble order id in metadata', { metadata: { hubbleOrderId: 'hub-9' } }],
        ['hubbleStatus PROCESSING', { metadata: { hubbleStatus: 'PROCESSING' } }],
      ])('a Hubble-managed order (%s) refuses ANY manual voucher write', async (_n, extra) => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid(extra));
        await expect(service.updateOrder(gifsy, 'o1', { voucherCode: 'MANUAL-1' })).rejects.toThrow(/Hubble integration/);
        noWrite();
      });

      it('merely Hubble-ELIGIBLE (flag turned on later, never sent to Hubble — no marker) does NOT block a manual code', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid({ rewardId: 'r1' }));
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1' });
        await service.updateOrder(gifsy, 'o1', { voucherCode: 'MANUAL-1' });
        expect(mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].data.voucherCode).toBe('MANUAL-1');
        // No eligibility lookup at all.
        expect(mockPrisma.rewardCatalog.findFirst).not.toHaveBeenCalled();
      });

      it.each(['UPI', 'BANK_TRANSFER'])('a cash (%s) redemption refuses a voucher code', async (mode) => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid({ redemptionMode: mode }));
        await expect(service.updateOrder(gifsy, 'o1', { voucherCode: 'CODE-1' })).rejects.toThrow('A cash redemption cannot carry a voucher code.');
        noWrite();
      });

      it('a code CANCELLED anywhere in the tenant can never be re-written (normalised: case + whitespace)', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid({ partner: { clientId: 'bajaj' } }));
        mockPrisma.cancelledVoucherCode.findFirst.mockResolvedValueOnce({ id: 'cv1' });
        await expect(service.updateOrder(gifsy, 'o1', { voucherCode: '  amzn-1234 5678-wxyz ' }))
          .rejects.toThrow("This voucher code was cancelled with the vendor and can't be reused.");
        // Looked up in the ORDER's tenant by the normalised hash.
        expect(mockPrisma.cancelledVoucherCode.findFirst).toHaveBeenCalledWith({
          where: { clientId: 'bajaj', codeHash: hashVoucherCode('AMZN-12345678-WXYZ') },
          select: { id: true },
        });
        noWrite();
        // A different code is fine.
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1' });
        await service.updateOrder(gifsy, 'o1', { voucherCode: 'FRESH-CODE-2' });
      });

      it('the new-code CAS also pins the row version (updatedAt) as read', async () => {
        const at = new Date('2026-11-01T10:00:00.000Z');
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid({ updatedAt: at }));
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1' });
        await service.updateOrder(gifsy, 'o1', { voucherCode: 'NEW-9' });
        expect(mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].where.AND).toEqual(
          expect.arrayContaining([{ updatedAt: at }]),
        );
      });

      it('a NEW code via PATCH writes an AuditLog row (masked code, actor, path) and notifies the member', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid());
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1' });
        const notifySpy = jest.spyOn(service as unknown as { notifyVoucherIssued: (a: string, b: string) => Promise<void> }, 'notifyVoucherIssued')
          .mockResolvedValue(undefined);
        await service.updateOrder(gifsy, 'o1', { voucherCode: 'GIFT-ABCD-9876' });
        const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
        expect(audit).toMatchObject({ actorId: 'admin1', entityType: 'REDEMPTION_ORDER', entityId: 'o1' });
        expect(audit.metadata).toMatchObject({ event: 'VOUCHER_ISSUED_MANUAL', path: 'PATCH /rewards/orders/:id', voucherCode: '••••9876' });
        expect(JSON.stringify(mockPrisma.auditLog.create.mock.calls)).not.toContain('GIFT-ABCD');
        expect(notifySpy).toHaveBeenCalledWith('o1', 'deoleo');
      });

      it('trimmed compare: a stored code with stray spaces + the same code re-sent is a no-op, not an "overwrite"', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(issued({ voucherCode: ' AMZN-1234-5678-WXYZ  ' }));
        mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1' });
        await service.updateOrder(gifsy, 'o1', { voucherCode: 'AMZN-1234-5678-WXYZ' });
        expect(mockPrisma.redemptionOrder.update.mock.calls[0][0].data).not.toHaveProperty('voucherCode');
        expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      });

      it('same-status transition WITH a new code applies it through the guarded write (not silently dropped)', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid({ status: 'PROCESSING' }));
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1', voucherCode: 'NEW-SAME-1' });
        const res = await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.PROCESSING, voucherCode: 'NEW-SAME-1' });
        expect(res.skipped).toBe(true);
        expect(mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].data.voucherCode).toBe('NEW-SAME-1');
        expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled(); // no status move
        expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
      });

      it('same-status transition with a code on an order that already has one → 400 (no silent overwrite)', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(issued({ status: 'PROCESSING' }));
        await expect(service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.PROCESSING, voucherCode: 'OTHER-1' }))
          .rejects.toThrow(/already issued/);
        noWrite();
      });

      it('DTO: null / blank voucher fields are invalid; omitted is fine', async () => {
        const errs = async (q: Record<string, unknown>) =>
          validate(plainToInstance(UpdateOrderDto, q)).then((e) => e.map((x) => x.property).sort());
        expect(await errs({ trackingNumber: 'TN' })).toEqual([]);
        expect(await errs({ voucherCode: 'GC-1' })).toEqual([]);
        expect(await errs({ voucherCode: null })).toEqual(['voucherCode']);
        expect(await errs({ voucherCode: '  ' })).toEqual(['voucherCode']);
        expect(await errs({ voucherProvider: null })).toEqual(['voucherProvider']);
        const t = await validate(plainToInstance(TransitionOrderDto, { toStatus: 'DELIVERED', voucherCode: null }));
        expect(t.map((x) => x.property)).toEqual(['voucherCode']);
      });
    });

    describe('transitionOrder (every edge)', () => {
      it('DELIVERED with voucherCode null never clears the stored code (400, no write)', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(issued({ status: 'DISPATCHED' }));
        await expect(service.transitionOrder(gifsy, 'o1', {
          toStatus: UpdatableOrderStatus.DELIVERED, voucherCode: null as never,
        })).rejects.toBeInstanceOf(BadRequestException);
        noWrite();
      });

      it('a forward move cannot overwrite a stored code (400, no write)', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(issued());
        await expect(service.transitionOrder(gifsy, 'o1', {
          toStatus: UpdatableOrderStatus.PROCESSING, voucherCode: 'OTHER-CODE-0000',
        })).rejects.toThrow(/already issued/);
        noWrite();
      });
    });
  });

  describe('voucher code visibility (operator reads)', () => {
    const staff: JwtPayload = { sub: 'st1', role: 'GIFSY_STAFF', clientId: 'deoleo', assumed: true, gifsyRoleId: 'role-1', phone: '9990004444', name: '' };
    const at = new Date('2026-10-01T10:00:00.000Z');
    const row = { id: 'o1', status: 'DELIVERED', voucherCode: 'AMZN-1234-5678-WXYZ', voucherProvider: 'Gifsy', createdAt: at, updatedAt: at };
    afterEach(() => mockPrisma.redemptionOrder.findFirst.mockReset());

    it('read-only GIFSY_STAFF (no rewards:manage_orders) gets only the issued indicator in listOrders', async () => {
      mockGifsyRoles.getPermissions.mockResolvedValue(new Set(['rewards:read']));
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([row]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(1);
      const res = await service.listOrders(staff, {});
      expect(mockGifsyRoles.getPermissions).toHaveBeenCalledWith('role-1');
      expect(res.orders[0]).toMatchObject({ voucherCode: null, voucherIssued: true });
      expect(JSON.stringify(res)).not.toContain('WXYZ');
    });

    it('GIFSY_STAFF WITH rewards:manage_orders gets the full code (they fulfil)', async () => {
      mockGifsyRoles.getPermissions.mockResolvedValue(new Set(['rewards:read', 'rewards:manage_orders']));
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([row]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(1);
      const res = await service.listOrders(staff, {});
      expect((res.orders[0] as { voucherCode: string }).voucherCode).toBe('AMZN-1234-5678-WXYZ');
    });

    it('getOrder (operator branch): read-only staff get the indicator only; GIFSY_ADMIN gets the full code', async () => {
      mockGifsyRoles.getPermissions.mockResolvedValue(new Set(['rewards:read']));
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ ...row, reward: null, partner: null });
      const s = await service.getOrder(staff, 'o1');
      expect(s.order).toMatchObject({ voucherCode: null, voucherIssued: true });
      expect(JSON.stringify(s)).not.toContain('WXYZ');

      const g = await service.getOrder(gifsy, 'o1');
      expect((g.order as { voucherCode: string }).voucherCode).toBe('AMZN-1234-5678-WXYZ');
    });
  });

  // ─── Voucher PIN (card number + PIN gift cards) — visibility matrix ───────────────────────────
  describe('voucher PIN visibility (card + PIN gift cards)', () => {
    const staff: JwtPayload = { sub: 'st1', role: 'GIFSY_STAFF', clientId: 'deoleo', assumed: true, gifsyRoleId: 'role-1', phone: '9990004444', name: '' };
    const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '9990002222', name: '' };
    const at = new Date();
    const row = {
      id: 'o1', partnerId: 'cp1', status: 'DELIVERED', voucherCode: '6001220012345678', voucherPin: '482913',
      voucherProvider: 'Hubble', createdAt: at, updatedAt: at,
    };
    const leaks = (res: unknown) => {
      const body = JSON.stringify(res);
      return ['6001220012345678', '5678', '482913'].some((frag) => body.includes(frag));
    };
    afterEach(() => mockPrisma.redemptionOrder.findFirst.mockReset());

    it('hiddenVoucherFields nulls the PIN with the code (no "has PIN" hint)', () => {
      expect(hiddenVoucherFields('6001220012345678')).toEqual({
        voucherCode: null, voucherPin: null, voucherIssued: true, voucherCodeMasked: true,
      });
      expect(hiddenVoucherFields(null)).toEqual({
        voucherCode: null, voucherPin: null, voucherIssued: false, voucherCodeMasked: false,
      });
    });

    it('listOrders: CLIENT_ADMIN + read-only GIFSY_STAFF get NEITHER card number nor PIN — only the issued flag', async () => {
      mockGifsyRoles.getPermissions.mockResolvedValue(new Set(['rewards:read']));
      for (const u of [clientAdmin, staff]) {
        mockPrisma.redemptionOrder.findMany.mockResolvedValue([row]);
        mockPrisma.redemptionOrder.count.mockResolvedValue(1);
        const res = await service.listOrders(u, {});
        expect(res.orders[0]).toMatchObject({ voucherCode: null, voucherPin: null, voucherIssued: true });
        expect(leaks(res)).toBe(false);
      }
    });

    it('listOrders: the member (own orders), GIFSY_ADMIN and a fulfilling GIFSY_STAFF get BOTH', async () => {
      mockGifsyRoles.getPermissions.mockResolvedValue(new Set(['rewards:read', 'rewards:manage_orders']));
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      for (const u of [partner, gifsy, staff]) {
        mockPrisma.redemptionOrder.findMany.mockResolvedValue([row]);
        mockPrisma.redemptionOrder.count.mockResolvedValue(1);
        const res = await service.listOrders(u, {});
        expect(res.orders[0]).toMatchObject({ voucherCode: '6001220012345678', voucherPin: '482913' });
      }
      // The member select asks for the PIN column.
      expect(mockPrisma.redemptionOrder.findMany.mock.calls[0][0].select.voucherPin).toBe(true);
    });

    it('SALES rep NEVER gets the card number or PIN from listOrders — even if their login resolved to a partner', async () => {
      // Worst case: the rep's login resolves to an outlet (cp1) whose order holds a card + PIN.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([row]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(1);
      for (const role of ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR']) {
        const res = await service.listOrders({ ...sales, role }, {});
        expect(res.orders[0]).toMatchObject({ voucherCode: null, voucherPin: null });
        expect(leaks(res)).toBe(false);
      }
    });

    it('SALES rep NEVER gets the card number or PIN from getOrder (member branch)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(row);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      const res = await service.getOrder(sales, 'o1');
      expect(res.order).toMatchObject({ voucherCode: null, voucherPin: null });
      expect(leaks(res)).toBe(false);
    });

    it('getOrder: the member gets card number + PIN (member-safe select includes voucherPin)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(row);
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      const res = await service.getOrder(partner, 'o1');
      expect(res.order).toMatchObject({ voucherCode: '6001220012345678', voucherPin: '482913' });
      expect(mockPrisma.redemptionOrder.findFirst.mock.calls[0][0].select.voucherPin).toBe(true);
    });

    it('getOrder (operator branch): read-only staff get neither; GIFSY_ADMIN gets both', async () => {
      mockGifsyRoles.getPermissions.mockResolvedValue(new Set(['rewards:read']));
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ ...row, reward: null, partner: null });
      const s = await service.getOrder(staff, 'o1');
      expect(s.order).toMatchObject({ voucherCode: null, voucherPin: null, voucherIssued: true });
      expect(leaks(s)).toBe(false);
      const g = await service.getOrder(gifsy, 'o1');
      expect(g.order).toMatchObject({ voucherCode: '6001220012345678', voucherPin: '482913' });
    });

    it('getFulfilmentOrder (dispatch console): a fulfilling operator gets the PIN; a non-fulfilling one gets neither', async () => {
      const detail = {
        ...row, orderNumber: 'RDM-1', redemptionMode: 'GIFT_CARD', quantity: 1, totalPointsCost: 500,
        valuePaise: 50000n, reward: { name: 'Amazon' }, partner: { businessName: 'S', clientId: null },
        fulfilledByVendor: null, statusHistory: [],
      };
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(detail);
      const g = await service.getFulfilmentOrder(gifsy, 'o1');
      expect(g).toMatchObject({ voucherCode: '6001220012345678', voucherPin: '482913' });
      mockGifsyRoles.getPermissions.mockResolvedValue(new Set(['rewards:read']));
      const s = await service.getFulfilmentOrder(staff, 'o1');
      expect(s).toMatchObject({ voucherCode: null, voucherPin: null });
      expect(leaks(s)).toBe(false);
    });
  });

  // ─── Voucher PIN — manual issuance paths, cancel, bulk upload, Hubble, sales confirm ──────────
  describe('voucher PIN writes (card + PIN gift cards)', () => {
    const paid = (extra: Record<string, unknown> = {}) => ({
      id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'RDM-p', pointsDeducted: 500,
      redemptionMode: 'GIFT_CARD', voucherCode: null, voucherPin: null, voucherProvider: null,
      partner: { clientId: 'deoleo' }, ...extra,
    });
    afterEach(() => {
      mockPrisma.redemptionOrder.findFirst.mockReset();
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockReset();
    });

    it('updateOrder: a code + PIN lands in ONE guarded write (PIN trimmed); the audit masks the PIN', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid());
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1' });
      await service.updateOrder(gifsy, 'o1', { voucherCode: '6001220012345678', voucherPin: ' 482913 ' });
      const call = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
      expect(call.data).toMatchObject({ voucherCode: '6001220012345678', voucherPin: '482913' });
      expect(call.where.AND).toEqual(expect.arrayContaining([{ OR: [{ voucherCode: null }, { voucherCode: '' }] }]));
      const audit = JSON.stringify(mockPrisma.auditLog.create.mock.calls[0][0]);
      expect(audit).toContain('"voucherPin":"••••"');
      expect(audit).not.toContain('482913');
    });

    it('updateOrder: a code WITHOUT a PIN writes no PIN column (number-only manual voucher unchanged)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid());
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1' });
      await service.updateOrder(gifsy, 'o1', { voucherCode: 'AMZ-ONLY-1234', voucherPin: '   ' });
      const data = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].data;
      expect(data.voucherCode).toBe('AMZ-ONLY-1234');
      expect(data).not.toHaveProperty('voucherPin');
    });

    it('a PIN without a card number is a 400 "Enter the card number before the PIN" (PATCH + transition), no write', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid());
      await expect(service.updateOrder(gifsy, 'o1', { voucherPin: '4829' }))
        .rejects.toThrow('Enter the card number before the PIN');
      await expect(service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.PROCESSING, voucherPin: '4829' }))
        .rejects.toThrow('Enter the card number before the PIN');
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.redemptionOrder.update).not.toHaveBeenCalled();
    });

    it('changing a SAVED PIN is a 400 (PIN-specific message); re-sending the same PIN is a no-op', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid({ voucherCode: 'CARD-1111-2222', voucherPin: '1111' }));
      await expect(service.updateOrder(gifsy, 'o1', { voucherPin: '9999' }))
        .rejects.toThrow("A PIN is already saved for this voucher; use 'Voucher cancelled with vendor' to replace it.");
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1' });
      await service.updateOrder(gifsy, 'o1', { voucherCode: 'CARD-1111-2222', voucherPin: '1111', trackingNumber: 'T' });
      const data = mockPrisma.redemptionOrder.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('voucherPin');
      expect(data).not.toHaveProperty('voucherCode');
    });

    it('SET-ONCE: adding a PIN to an issued code (DELIVERED, member already notified) → guarded write, masked audit, voucher re-sent', async () => {
      const updatedAt = new Date(Date.now() - 5 * 60_000);
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(
        paid({ status: 'DELIVERED', voucherCode: 'CARD-1111-2222', voucherProvider: 'Croma', updatedAt }),
      );
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1' });
      const notify = jest
        .spyOn(service as unknown as { notifyVoucherIssued: (a: string, b: string) => Promise<void> }, 'notifyVoucherIssued')
        .mockResolvedValue(undefined);
      await service.updateOrder(gifsy, 'o1', { voucherCode: 'CARD-1111-2222', voucherPin: ' 4455 ' });
      const call = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
      expect(call.data).toMatchObject({ voucherPin: '4455' });
      expect(call.data).not.toHaveProperty('voucherCode');
      // Two writers can't both set it: the claim pins the code, a still-null PIN and the row version.
      expect(call.where.AND).toEqual(
        expect.arrayContaining([{ voucherCode: 'CARD-1111-2222' }, { voucherPin: null }, { updatedAt }]),
      );
      const audit = JSON.stringify(mockPrisma.auditLog.create.mock.calls[0][0]);
      expect(audit).toContain('VOUCHER_PIN_ADDED_MANUAL');
      expect(audit).not.toContain('4455');
      expect(notify).toHaveBeenCalledWith('o1', 'deoleo');
      notify.mockRestore();
    });

    it('SET-ONCE: the losing concurrent PIN writer gets a 409, no audit, no notification', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid({ voucherCode: 'CARD-1111-2222' }));
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });
      const notify = jest
        .spyOn(service as unknown as { notifyVoucherIssued: (a: string, b: string) => Promise<void> }, 'notifyVoucherIssued')
        .mockResolvedValue(undefined);
      await expect(service.updateOrder(gifsy, 'o1', { voucherPin: '4455' })).rejects.toThrow(ConflictException);
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      notify.mockRestore();
    });

    const spyNotify = () =>
      jest
        .spyOn(service as unknown as { notifyVoucherIssued: (a: string, b: string) => Promise<void> }, 'notifyVoucherIssued')
        .mockResolvedValue(undefined);

    it('B4 double submit: losing to an IDENTICAL PIN is a successful no-op (no 409, no audit, no notification)', async () => {
      const updatedAt = new Date(Date.now() - 60_000);
      mockPrisma.redemptionOrder.findFirst
        .mockResolvedValueOnce(paid({ status: 'DELIVERED', voucherCode: 'CARD-1111-2222', updatedAt }))
        // the retry re-reads: the winner stored the same PIN
        .mockResolvedValueOnce(paid({ status: 'DELIVERED', voucherCode: 'CARD-1111-2222', voucherPin: '4455' }));
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });
      mockPrisma.redemptionOrder.findUnique.mockResolvedValueOnce({ voucherCode: 'CARD-1111-2222', voucherPin: '4455' });
      mockPrisma.redemptionOrder.update.mockResolvedValueOnce({ id: 'o1', voucherPin: '4455' });
      const notify = spyNotify();
      await expect(service.updateOrder(gifsy, 'o1', { voucherCode: 'CARD-1111-2222', voucherPin: ' 4455 ' })).resolves.toBeDefined();
      expect(mockPrisma.redemptionOrder.update.mock.calls[0][0].data).not.toHaveProperty('voucherPin');
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      notify.mockRestore();
    });

    it('B4: losing to a DIFFERENT PIN (or a cleared code) stays a 409', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid({ voucherCode: 'CARD-1111-2222' }));
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });
      mockPrisma.redemptionOrder.findUnique.mockResolvedValueOnce({ voucherCode: 'CARD-1111-2222', voucherPin: '9999' });
      await expect(service.updateOrder(gifsy, 'o1', { voucherPin: '4455' })).rejects.toThrow(ConflictException);
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });
      mockPrisma.redemptionOrder.findUnique.mockResolvedValueOnce({ voucherCode: null, voucherPin: null });
      await expect(service.updateOrder(gifsy, 'o1', { voucherPin: '4455' })).rejects.toThrow(ConflictException);
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('B4 transition double submit: the loser re-reads, sees the same PIN + moved status → skipped no-op, no notifications', async () => {
      mockPrisma.redemptionOrder.findFirst
        .mockResolvedValueOnce(paid({ status: 'DISPATCHED', voucherCode: 'CARD-1111-2222', fulfilmentChannel: 'DIGITAL_VOUCHER' }))
        .mockResolvedValueOnce(paid({ status: 'DELIVERED', voucherCode: 'CARD-1111-2222', voucherPin: '4455', fulfilmentChannel: 'DIGITAL_VOUCHER' }))
        .mockResolvedValueOnce(paid({ status: 'DELIVERED', voucherCode: 'CARD-1111-2222', voucherPin: '4455', fulfilmentChannel: 'DIGITAL_VOUCHER' }));
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });
      mockPrisma.redemptionOrder.findUnique.mockResolvedValueOnce({ voucherCode: 'CARD-1111-2222', voucherPin: '4455' });
      mockPrisma.redemptionOrder.update.mockResolvedValueOnce({ id: 'o1' });
      const notify = spyNotify();
      const res = await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.DELIVERED, voucherPin: '4455' });
      expect(res).toMatchObject({ skipped: true });
      expect(notify).not.toHaveBeenCalled();
      expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
      notify.mockRestore();
    });

    it('B1: a PIN ADDED on a status change sends BOTH the re-sent voucher AND the ORDER_DELIVERED milestone (with tracking)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(
        paid({ status: 'DISPATCHED', voucherCode: 'CARD-1111-2222', fulfilmentChannel: 'DIGITAL_VOUCHER' }),
      );
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValue({
        id: 'o1', status: 'DELIVERED', voucherCode: 'CARD-1111-2222', voucherPin: '4455', pointsDeducted: 500,
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ userId: 'u-owner', phone: '9990000001', ownerName: 'Asha' });
      const notify = spyNotify();
      await service.transitionOrder(gifsy, 'o1', {
        toStatus: UpdatableOrderStatus.DELIVERED, voucherPin: '4455', trackingNumber: 'TRK-9',
      });
      expect(notify).toHaveBeenCalledWith('o1', 'deoleo');
      expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledWith(
        expect.objectContaining({ eventKey: 'ORDER_DELIVERED', vars: expect.objectContaining({ trackingId: 'TRK-9' }) }),
      );
      notify.mockRestore();
    });

    it('B1: a NEW code issued on a status change still suppresses the milestone (VOUCHER_ISSUED supersedes it)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid({ status: 'PROCESSING' }));
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValue({
        id: 'o1', status: 'DISPATCHED', voucherCode: 'CARD-9', pointsDeducted: 500,
      });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ userId: 'u-owner', phone: '9990000001', ownerName: 'Asha' });
      const notify = spyNotify();
      await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.DISPATCHED, voucherCode: 'CARD-9' });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
      notify.mockRestore();
    });

    it('B5: a provider may be SET ONCE on a stored code whose provider is NULL (CAS incl. voucherProvider null), no audit / notify', async () => {
      const updatedAt = new Date(Date.now() - 60_000);
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid({ voucherCode: 'CARD-1111-2222', updatedAt }));
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1' });
      const notify = spyNotify();
      await service.updateOrder(gifsy, 'o1', { voucherCode: 'CARD-1111-2222', voucherProvider: 'Croma' });
      const call = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
      expect(call.data).toMatchObject({ voucherProvider: 'Croma' });
      expect(call.data).not.toHaveProperty('voucherCode');
      expect(call.where.AND).toEqual(
        expect.arrayContaining([{ voucherCode: 'CARD-1111-2222' }, { voucherProvider: null }, { updatedAt }]),
      );
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      notify.mockRestore();
    });

    it('B5: provider + PIN together on a stored code with no provider → one CAS write; changing a SET provider stays 400', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce(paid({ voucherCode: 'CARD-1111-2222' }));
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1' });
      const notify = spyNotify();
      await service.updateOrder(gifsy, 'o1', { voucherProvider: 'Croma', voucherPin: '4455' });
      const call = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
      expect(call.data).toMatchObject({ voucherProvider: 'Croma', voucherPin: '4455' });
      expect(call.where.AND).toEqual(expect.arrayContaining([{ voucherPin: null }, { voucherProvider: null }]));
      expect(notify).toHaveBeenCalledTimes(1);
      notify.mockRestore();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce(paid({ voucherCode: 'CARD-1111-2222', voucherProvider: 'Gifsy' }));
      await expect(service.updateOrder(gifsy, 'o1', { voucherProvider: 'Croma' }))
        .rejects.toThrow("A voucher code is already issued; use 'Voucher cancelled with vendor' first.");
    });

    it('a coded order MAY switch to a physical channel (physical gift cards carry codes/PINs) — no voucher claim', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(
        paid({ voucherCode: 'CARD-1111-2222', voucherPin: '4455', fulfilmentChannel: 'DIGITAL_VOUCHER' }),
      );
      mockPrisma.redemptionOrder.update.mockResolvedValueOnce({ id: 'o1', fulfilmentChannel: 'GIFSY_WAREHOUSE' });
      await service.updateOrder(gifsy, 'o1', { fulfilmentChannel: 'GIFSY_WAREHOUSE' as never });
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
      const call = mockPrisma.redemptionOrder.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'o1' });
      expect(call.data).toMatchObject({ fulfilmentChannel: 'GIFSY_WAREHOUSE' });
      // The stored code / PIN are never touched by a channel change.
      expect(call.data).not.toHaveProperty('voucherCode');
      expect(call.data).not.toHaveProperty('voucherPin');
    });

    it('bulk upload: a Voucher Code / PIN cell stored as a NUMBER is a row error and is not applied', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const XLSX = require('xlsx');
      const ws = XLSX.utils.aoa_to_sheet([
        ['Order Number', 'Voucher Code', 'Voucher PIN'],
        ['RDM-p', 6001220012345678, ''],
        ['RDM-q', 'CARD-1', 42],
        ['RDM-r', 'CARD-2', '0042'],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Fulfilment');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      const spy = jest.spyOn(service, 'updateOrder').mockResolvedValue({ order: {} } as never);
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1' });
      const res = await service.uploadFulfilment(gifsy, { buffer, originalname: 'f.xlsx' } as Express.Multer.File);
      expect(res.succeeded).toBe(1);
      expect(res.errors).toEqual([
        { row: 2, orderNumber: 'RDM-p', message: 'Voucher Code/PIN must be entered as text — format the column as Text and re-type it' },
        { row: 3, orderNumber: 'RDM-q', message: 'Voucher Code/PIN must be entered as text — format the column as Text and re-type it' },
      ]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(gifsy, 'o1', expect.objectContaining({ voucherCode: 'CARD-2', voucherPin: '0042' }));
      spy.mockRestore();
    });

    it('transitionOrder: a code + PIN on a forward move is written with the status claim', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(paid());
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValue({ id: 'o1', status: 'PROCESSING', voucherCode: 'CARD-9', pointsDeducted: 500 });
      await service.transitionOrder(gifsy, 'o1', {
        toStatus: UpdatableOrderStatus.PROCESSING, voucherCode: 'CARD-9', voucherPin: '7777',
      });
      const claim = mockPrisma.redemptionOrder.updateMany.mock.calls.find(
        ([a]) => (a as { data?: { status?: string } }).data?.status === 'PROCESSING',
      );
      expect((claim![0] as { data: Record<string, unknown> }).data).toMatchObject({ voucherCode: 'CARD-9', voucherPin: '7777' });
    });

    it('"Voucher cancelled with vendor" clears the PIN with the code (and the response carries neither)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...paid({ voucherCode: 'CARD-1111-2222', voucherPin: '1111', voucherProvider: 'Gifsy' }), metadata: {},
      });
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1', status: 'CONFIRMED', voucherProvider: null });
      const res = await service.voucherCancelledWithVendor(gifsy, 'o1', 'vendor ref 1');
      expect(mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].data).toMatchObject({ voucherCode: null, voucherPin: null });
      expect(res.order).toMatchObject({ voucherCode: null, voucherPin: null });
      expect(JSON.stringify(mockPrisma.auditLog.create.mock.calls)).not.toContain('1111');
    });

    it('bulk upload: the optional "Voucher PIN" column is applied with the code (non-status row)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const XLSX = require('xlsx');
      const ws = XLSX.utils.aoa_to_sheet([
        ['Order Number', 'Reward', 'Mode', 'Current Status', 'Voucher Code', 'Voucher PIN', 'Voucher Provider', 'Tracking Number', 'Tracking URL', 'New Status'],
        ['RDM-p', 'X', 'GIFT_CARD', 'CONFIRMED', 'CARD-55', '0042', '', '', '', ''],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Fulfilment');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      const spy = jest.spyOn(service, 'updateOrder').mockResolvedValue({ order: {} } as never);
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1' });
      const res = await service.uploadFulfilment(gifsy, { buffer, originalname: 'f.xlsx' } as Express.Multer.File);
      expect(res.succeeded).toBe(1);
      expect(spy).toHaveBeenCalledWith(gifsy, 'o1', expect.objectContaining({ voucherCode: 'CARD-55', voucherPin: '0042' }));
      spy.mockRestore();
    });

    it('UpdateOrderDto / TransitionOrderDto: voucherPin optional, trimmed, max 64', async () => {
      const errs = async (cls: new () => object, o: Record<string, unknown>) =>
        validate(plainToInstance(cls, o)).then((e) => e.map((x) => x.property));
      expect(await errs(UpdateOrderDto, { voucherCode: 'C', voucherPin: '1234' })).toEqual([]);
      expect(await errs(UpdateOrderDto, { voucherCode: 'C', voucherPin: 'x'.repeat(65) })).toEqual(['voucherPin']);
      expect(await errs(TransitionOrderDto, { toStatus: 'PROCESSING', voucherPin: 'x'.repeat(64) })).toEqual([]);
      expect((plainToInstance(UpdateOrderDto, { voucherPin: '  12 ' }) as { voucherPin: string }).voucherPin).toBe('12');
    });

    it('SALES confirm (redeem-for-outlet, Hubble branch) response never carries a voucher code or PIN', async () => {
      // confirmRedeemForOutlet returns finishHubbleConfirm's { orderId, status, message } on the
      // Hubble branch (and the same three keys on the manual branch) — pinned on the shared helper.
      const svc = service as unknown as {
        issueHubbleVoucherForOrder: (...a: unknown[]) => Promise<string>;
        finishHubbleConfirm: (o: unknown, c: unknown) => Promise<Record<string, unknown>>;
      };
      const issue = jest.spyOn(svc, 'issueHubbleVoucherForOrder').mockResolvedValue('DELIVERED');
      const res = await svc.finishHubbleConfirm(
        { id: 'o1' },
        { clientId: 'deoleo', actorId: 'salesUser1', notifyUserId: 'u', recipientPhone: null, ownerName: 'O', rewardName: 'R', points: 1 },
      );
      expect(Object.keys(res).sort()).toEqual(['message', 'orderId', 'status']);
      issue.mockRestore();
    });
  });

  // ─── Final re-audit (e6b4357): Hubble ops exits, tenant-wide reuse, order-tenant notifications ───
  describe('Hubble ops exits + order-tenant scoping', () => {
    const stuck = (extra: Record<string, unknown> = {}) => ({
      id: 'o1', status: 'PROCESSING', partnerId: 'cp1', orderNumber: 'RDM-h', pointsDeducted: 500,
      redemptionMode: 'GIFT_CARD', voucherCode: null, voucherProvider: 'Hubble',
      metadata: { hubbleStatus: 'PROCESSING', hubbleOrderId: 'hub-1', hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_PROCESSING_NOT_FOUND' },
      partner: { clientId: 'bajaj' },
      ...extra,
    });
    const staffMgr: JwtPayload = { sub: 'st1', role: 'GIFSY_STAFF', clientId: 'bajaj', assumed: true, gifsyRoleId: 'r', phone: '9990004444', name: '' };
    afterEach(() => {
      mockPrisma.redemptionOrder.findFirst.mockReset();
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockReset();
    });

    it('GIFSY_ADMIN manual override fulfils a stuck Hubble order: code + manual provider, flag cleared, audited with the reason', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(stuck());
      mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 1 });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1' });
      const notifySpy = jest.spyOn(service as unknown as { notifyVoucherIssued: (a: string, b: string) => Promise<void> }, 'notifyVoucherIssued')
        .mockResolvedValue(undefined);

      await service.updateOrder(gifsy, 'o1', {
        voucherCode: 'POOL-CODE-7777', manualOverride: true, overrideReason: '  Hubble down — issued from pool ',
      });

      const call = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
      expect(call.data.voucherCode).toBe('POOL-CODE-7777');
      expect(call.data.voucherProvider).toBe('Manual');
      expect(call.data.metadata).toMatchObject({
        hubbleNeedsReconcile: false,
        hubbleStatus: 'MANUAL_OVERRIDE',
        hubbleManualOverride: { by: 'admin1', reason: 'Hubble down — issued from pool', previousReason: 'HUBBLE_PROCESSING_NOT_FOUND' },
      });
      // CAS still pins "no code + provider as read (Hubble)".
      expect(call.where.AND).toEqual(expect.arrayContaining([
        { OR: [{ voucherCode: null }, { voucherCode: '' }] },
        { voucherProvider: 'Hubble' },
      ]));
      const audit = mockPrisma.auditLog.create.mock.calls[0][0].data.metadata;
      expect(audit).toMatchObject({ manualOverride: true, overrideReason: 'Hubble down — issued from pool', voucherCode: '••••7777' });
      // Notified under the ORDER's tenant (bajaj), not the caller's.
      expect(notifySpy).toHaveBeenCalledWith('o1', 'bajaj');
    });

    it('without the override, a stuck Hubble order refuses a manual code (400, no write)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(stuck());
      await expect(service.updateOrder(gifsy, 'o1', { voucherCode: 'POOL-1' })).rejects.toThrow(/sent to the Hubble integration/);
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-GIFSY_ADMIN (staff)', () => [staffMgr, stuck(), { voucherCode: 'X-1', manualOverride: true, overrideReason: 'r' }], ForbiddenException],
      ['no reason', () => [gifsy, stuck(), { voucherCode: 'X-1', manualOverride: true }], BadRequestException],
      ['no code', () => [gifsy, stuck(), { manualOverride: true, overrideReason: 'r' }], BadRequestException],
      ['an order never sent to Hubble', () => [gifsy, stuck({ voucherProvider: null, metadata: {} }), { voucherCode: 'X-1', manualOverride: true, overrideReason: 'r' }], BadRequestException],
      ['an order that already has a code (no overwrite, even with override)', () => [gifsy, stuck({ voucherCode: 'HUB-REAL-1' }), { voucherCode: 'X-1', manualOverride: true, overrideReason: 'r' }], BadRequestException],
      ['a cash order', () => [gifsy, stuck({ redemptionMode: 'UPI' }), { voucherCode: 'X-1', manualOverride: true, overrideReason: 'r' }], BadRequestException],
    ])('override refused for %s', async (_n, args, err) => {
      const [who, order, dto] = (args as () => [JwtPayload, Record<string, unknown>, Record<string, unknown>])();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(order);
      await expect(service.updateOrder(who, 'o1', dto as never)).rejects.toBeInstanceOf(err as never);
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    });

    it('override still refuses a code cancelled elsewhere in the tenant', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(stuck());
      mockPrisma.cancelledVoucherCode.findFirst.mockResolvedValueOnce({ id: 'cv' });
      await expect(service.updateOrder(gifsy, 'o1', { voucherCode: 'OLD-CODE-1', manualOverride: true, overrideReason: 'r' }))
        .rejects.toThrow(/can't be reused/);
    });

    it('a manual REFUND on any Hubble-marked order is blocked (not just provider=Hubble)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(stuck({ voucherProvider: null, status: 'CONFIRMED' }));
      await expect(service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED }))
        .rejects.toThrow(/sent to Hubble cannot be cancelled/);
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    // ── Never-placed Hubble orders stay refundable (owner decision on the item-7 dead end) ──
    const flagged = (reason: string, extra: Record<string, unknown> = {}) => ({
      id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'RDM-n', pointsDeducted: 500,
      redemptionMode: 'GIFT_CARD', voucherCode: null, voucherProvider: null,
      metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: reason, hubbleReconcileAt: '2026-11-09T00:00:00Z' },
      ...extra,
    });

    it.each(['HUBBLE_NOT_CONFIGURED', 'HUBBLE_INVALID_AMOUNT'])(
      'a %s order (nothing ever placed with Hubble, no code) CAN be refunded by hand', async (reason) => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(flagged(reason));
        mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValue({ id: 'o1', status: 'CANCELLED', pointsDeducted: 500, voucherCode: null });
        mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'user1', phone: '9991112222' });
        await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED });
        expect(mockWallet.reverse).toHaveBeenCalledWith('cp1', 500, expect.anything(), mockPrisma);
      },
    );

    it.each([
      'HUBBLE_INDETERMINATE',
      'HUBBLE_PROCESSING_NOT_FOUND',
      'HUBBLE_SUCCESS_NO_CODE',
      'HUBBLE_UNKNOWN_STATUS:WEIRD',
      'HUBBLE_SUCCESS_MANUAL_CODE_PRESENT',
      'HUBBLE_UNEXPECTED',
    ])('a %s order stays refund-BLOCKED (Hubble may hold / have issued a voucher)', async (reason) => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(flagged(reason));
      await expect(service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED }))
        .rejects.toThrow(/sent to Hubble cannot be cancelled/);
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it.each([
      ['a Hubble order id', { metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_NOT_CONFIGURED', hubbleOrderId: 'hub-1' } }],
      ['provider Hubble', { voucherProvider: 'Hubble' }],
      ['a hubbleStatus', { metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INVALID_AMOUNT', hubbleStatus: 'PROCESSING' } }],
    ])('a "never placed" reason WITH another Hubble trace (%s) stays refund-blocked', async (_n, extra) => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(flagged('HUBBLE_NOT_CONFIGURED', extra));
      await expect(service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED }))
        .rejects.toThrow(/sent to Hubble cannot be cancelled/);
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('a never-placed order WITH a stored code is still refund-blocked (code present → not "never placed")', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(flagged('HUBBLE_NOT_CONFIGURED', { voucherCode: 'MANUAL-1' }));
      // The Hubble-marker block fires first (isHubbleNeverPlaced requires no code); the issued-voucher
      // block would refuse it too. Either way: 400, no refund.
      await expect(service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    // ── Whole-change audit fixes ──
    it('an overridden order re-flagged SUCCESS_MANUAL_CODE_PRESENT stays refund-blocked (open flag beats MANUAL_OVERRIDE)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(flagged('HUBBLE_SUCCESS_MANUAL_CODE_PRESENT', {
        metadata: { hubbleStatus: 'MANUAL_OVERRIDE', hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_SUCCESS_MANUAL_CODE_PRESENT' },
      }));
      await expect(service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED }))
        .rejects.toThrow(/sent to Hubble cannot be cancelled/);
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('a whitespace-only stored code is "no code": the refund proceeds and its claim pins that exact value', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(flagged('X', { voucherCode: '   ', metadata: {} }));
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValue({ id: 'o1', status: 'CANCELLED', pointsDeducted: 500, voucherCode: '   ' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'user1', phone: '9991112222' });
      await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.CANCELLED });
      expect(mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].where).toMatchObject({ voucherCode: '   ', status: 'CONFIRMED' });
      expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
    });

    it('the tenant-wide reuse check runs INSIDE the write tx, after the advisory lock and before the claim', async () => {
      const seq: string[] = [];
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'R', pointsDeducted: 500, redemptionMode: 'GIFT_CARD',
        voucherCode: null, voucherProvider: null, metadata: {}, partner: { clientId: 'bajaj' },
      });
      mockPrisma.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => { seq.push('tx'); return fn(mockPrisma); });
      mockPrisma.$executeRaw.mockImplementationOnce(async () => { seq.push('lock'); return 1; });
      mockPrisma.cancelledVoucherCode.findFirst.mockImplementationOnce(async () => { seq.push('lookup'); return null; });
      mockPrisma.redemptionOrder.updateMany.mockImplementationOnce(async () => { seq.push('claim'); return { count: 1 }; });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1' });
      await service.updateOrder(gifsy, 'o1', { voucherCode: 'NEW-INTX-1' });
      expect(seq).toEqual(['tx', 'lock', 'lookup', 'claim']);
    });

    it('voucher-cancel takes the same (tenant, code) advisory lock in its tx', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce({
        id: 'o1', orderNumber: 'R', status: 'CONFIRMED', voucherCode: 'MANUAL-CODE-1', voucherProvider: 'Gifsy',
        metadata: {}, partner: { clientId: 'bajaj' },
      });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1', status: 'CONFIRMED', voucherProvider: null, updatedAt: new Date() });
      await service.voucherCancelledWithVendor(gifsy, 'o1', 'r');
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mockPrisma.$executeRaw.mock.calls)).not.toContain('MANUAL-CODE-1');
    });

    it('same-status transition with ONLY tracking applies it (bulk rows no longer drop it)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(flagged('X', { status: 'DISPATCHED', metadata: {} }));
      mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', trackingNumber: 'TRK-9' });
      const res = await service.transitionOrder(gifsy, 'o1', {
        toStatus: UpdatableOrderStatus.DISPATCHED, trackingNumber: 'TRK-9', trackingUrl: 'https://t/9',
      });
      expect(res.skipped).toBe(true);
      expect(mockPrisma.redemptionOrder.update.mock.calls[0][0].data).toMatchObject({ trackingNumber: 'TRK-9', trackingUrl: 'https://t/9' });
      expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
    });

    it('transition-issued code notifies under the ORDER tenant', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        id: 'o1', status: 'CONFIRMED', partnerId: 'cp1', orderNumber: 'R', pointsDeducted: 500, redemptionMode: 'GIFT_CARD',
        voucherCode: null, voucherProvider: null, metadata: {}, partner: { clientId: 'bajaj' },
      });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValue({ id: 'o1', status: 'PROCESSING', pointsDeducted: 500, voucherCode: 'NEW-T-1' });
      const notifySpy = jest.spyOn(service as unknown as { notifyVoucherIssued: (a: string, b: string) => Promise<void> }, 'notifyVoucherIssued')
        .mockResolvedValue(undefined);
      await service.transitionOrder(gifsy, 'o1', { toStatus: UpdatableOrderStatus.PROCESSING, voucherCode: 'NEW-T-1' });
      expect(notifySpy).toHaveBeenCalledWith('o1', 'bajaj');
    });

    it('voucher-cancel: a MANUAL code on a HUBBLE_FAILED_VOUCHER_PRESENT order can be cancelled and releases the Hubble flag', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce({
        id: 'o1', orderNumber: 'R', status: 'CONFIRMED', voucherCode: 'MANUAL-CODE-1', voucherProvider: 'Gifsy',
        metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_FAILED_VOUCHER_PRESENT' },
        partner: { clientId: 'bajaj' },
      });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1', status: 'CONFIRMED', voucherProvider: null, updatedAt: new Date() });
      await service.voucherCancelledWithVendor(gifsy, 'o1', 'vendor ref 9');
      const data = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].data;
      expect(data).toMatchObject({ voucherCode: null, voucherProvider: null });
      expect(data.metadata).toMatchObject({ hubbleNeedsReconcile: false, hubbleStatus: 'RELEASED' });
      expect(mockPrisma.cancelledVoucherCode.createMany.mock.calls[0][0].data[0].clientId).toBe('bajaj');
    });

    it('voucher-cancel: a HUBBLE-ISSUED code is never cancellable (hubbleVoucher in metadata)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce({
        id: 'o1', orderNumber: 'R', status: 'DELIVERED', voucherCode: 'CARD-1', voucherProvider: 'Gifsy',
        metadata: { hubbleVoucher: { id: 'v1' } }, partner: { clientId: 'bajaj' },
      });
      await expect(service.voucherCancelledWithVendor(gifsy, 'o1', 'r')).rejects.toThrow(/Hubble-issued voucher cannot be cancelled/);
      expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
    });

    it('voucher-cancel: a SUCCESS_MANUAL_CODE_PRESENT order keeps its Hubble flag (Hubble DID issue a voucher)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce({
        id: 'o1', orderNumber: 'R', status: 'CONFIRMED', voucherCode: 'MANUAL-CODE-1', voucherProvider: 'Gifsy',
        metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_SUCCESS_MANUAL_CODE_PRESENT' },
        partner: { clientId: 'bajaj' },
      });
      mockPrisma.redemptionOrder.findUniqueOrThrow.mockResolvedValueOnce({ id: 'o1', status: 'CONFIRMED', voucherProvider: null, updatedAt: new Date() });
      await service.voucherCancelledWithVendor(gifsy, 'o1', 'r');
      expect(mockPrisma.redemptionOrder.updateMany.mock.calls[0][0].data).not.toHaveProperty('metadata');
    });

    it('retryHubbleReconcile: GIFSY_ADMIN runs the existing reconcile for that order and audits the outcome', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValueOnce({ id: 'o1', orderNumber: 'R', status: 'PROCESSING', metadata: { hubbleReconcileReason: 'HUBBLE_INDETERMINATE' } });
      const spy = jest.spyOn(service, 'reconcileHubbleOrder').mockResolvedValue('DELIVERED');
      const res = await service.retryHubbleReconcile(gifsy, 'o1');
      expect(spy).toHaveBeenCalledWith('o1', { actorId: 'admin1', source: 'OPS_RETRY' });
      expect(res).toEqual({ orderId: 'o1', outcome: 'DELIVERED' });
      expect(mockPrisma.auditLog.create.mock.calls[0][0].data.metadata).toMatchObject({
        event: 'HUBBLE_RECONCILE_RETRY', outcome: 'DELIVERED', reconcileReasonBefore: 'HUBBLE_INDETERMINATE',
      });
    });

    it.each([['GIFSY_STAFF', staffMgr], ['CLIENT_ADMIN', { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '1', name: '' } as JwtPayload]])(
      'retryHubbleReconcile: %s is forbidden', async (_n, who) => {
        const spy = jest.spyOn(service, 'reconcileHubbleOrder');
        await expect(service.retryHubbleReconcile(who, 'o1')).rejects.toBeInstanceOf(ForbiddenException);
        expect(spy).not.toHaveBeenCalled();
      },
    );

    it('listOrders: operators see "needs reconcile" + reason; members never see metadata or the flags', async () => {
      const at = new Date();
      const row = { id: 'o1', status: 'PROCESSING', voucherCode: null, createdAt: at, updatedAt: at,
        metadata: { hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE', sellingValuePaise: 50000 } };
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([row]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(1);
      const op = await service.listOrders(gifsy, {});
      expect(op.orders[0]).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' });
      expect(op.orders[0]).not.toHaveProperty('metadata');

      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      const mem = await service.listOrders(partner, {});
      expect(mem.orders[0]).not.toHaveProperty('metadata');
      expect(mem.orders[0]).not.toHaveProperty('hubbleNeedsReconcile');
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
    // Pure derive: a FIXED item carries a ₹ selling value (the price driver); pointsCost is
    // DERIVED server-side (rate 1 default → 50000 paise = ₹500 → 500 pts). No manual pointsCost.
    const base = {
      categoryId: 'c1',
      code: 'AMZ500',
      name: 'Amazon ₹500',
      sellingValuePaise: 50000,
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

    it('persists an optional sellingValuePaise', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'c1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      mockPrisma.rewardCatalog.create.mockResolvedValue({ id: 'r1' });
      await service.createCatalogItem(gifsy, { ...base, mrpPaise: 60000, sellingValuePaise: 50000 });
      const call = mockPrisma.rewardCatalog.create.mock.calls?.[0]?.[0];
      expect(call.data.sellingValuePaise).toBe(50000);
    });

    it('rejects sellingValuePaise > mrpPaise', async () => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'c1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      await expect(
        service.createCatalogItem(gifsy, { ...base, mrpPaise: 50000, sellingValuePaise: 60000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.rewardCatalog.create).not.toHaveBeenCalled();
    });
  });

  describe('catalog pointsCost — PURE DERIVE (selling value × conversion rate)', () => {
    const fixedBase = {
      categoryId: 'c1',
      code: 'FX-1',
      name: 'Fixed reward',
      redemptionMode: 'GIFT_CARD' as const,
    };

    beforeEach(() => {
      mockPrisma.rewardCategory.findFirst.mockResolvedValue({ id: 'c1' });
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null); // no code clash
      mockPrisma.rewardCatalog.create.mockResolvedValue({ id: 'r-new' });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'r1' });
    });

    it('CREATE FIXED: derives pointsCost = round(sellingValue/100 × rate)', async () => {
      mockSettings.conversionRate = 2; // 2 points per ₹
      await service.createCatalogItem(gifsy, { ...fixedBase, sellingValuePaise: 50000 } as never);
      const call = mockPrisma.rewardCatalog.create.mock.calls?.[0]?.[0];
      expect(call.data.pointsCost).toBe(1000); // ₹500 × 2
      expect(call.data.sellingValuePaise).toBe(50000);
    });

    it('CREATE FIXED: rounds to the nearest point', async () => {
      mockSettings.conversionRate = 1.5;
      await service.createCatalogItem(gifsy, { ...fixedBase, sellingValuePaise: 33300 } as never);
      const call = mockPrisma.rewardCatalog.create.mock.calls?.[0]?.[0];
      expect(call.data.pointsCost).toBe(500); // round(333 × 1.5 = 499.5) = 500
    });

    it('CREATE FIXED: a missing selling value is rejected (400 — selling value is the price driver)', async () => {
      await expect(
        service.createCatalogItem(gifsy, { ...fixedBase } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.rewardCatalog.create).not.toHaveBeenCalled();
    });

    it('CREATE FIXED: a derived-0 pointsCost (rate unset/0) is rejected', async () => {
      mockSettings.conversionRate = 0; // rate not configured
      await expect(
        service.createCatalogItem(gifsy, { ...fixedBase, sellingValuePaise: 50000 } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.rewardCatalog.create).not.toHaveBeenCalled();
    });

    it('CREATE FREE_AMOUNT: pointsCost stays 0 + band; no selling value required; derive does NOT apply', async () => {
      mockSettings.conversionRate = 2;
      await service.createCatalogItem(gifsy, {
        ...fixedBase,
        minRedemptionPoints: 100,
        maxRedemptionPoints: 5000,
      } as never);
      const call = mockPrisma.rewardCatalog.create.mock.calls?.[0]?.[0];
      expect(call.data.pointsCost).toBe(0);
      expect(call.data.minRedemptionPoints).toBe(100);
      expect(call.data.maxRedemptionPoints).toBe(5000);
    });

    it('UPDATE FIXED: keeps the stored pointsCost when no selling value is present (transition safety)', async () => {
      mockSettings.conversionRate = 2; // would derive differently IF a selling value existed
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', code: 'FX-1', stockQuantity: null, pointsCost: 777, sellingValuePaise: null,
        minRedemptionPoints: null, maxRedemptionPoints: null,
      });
      await service.updateCatalogItem(gifsy, 'r1', { name: 'Renamed' } as never);
      const call = mockPrisma.rewardCatalog.update.mock.calls?.[0]?.[0];
      expect(call.data.pointsCost).toBe(777); // kept, NOT re-derived (no selling value to price from)
    });

    it('UPDATE FIXED: re-derives when a selling value is provided', async () => {
      mockSettings.conversionRate = 2;
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', code: 'FX-1', stockQuantity: null, pointsCost: 777, sellingValuePaise: null,
        minRedemptionPoints: null, maxRedemptionPoints: null,
      });
      await service.updateCatalogItem(gifsy, 'r1', { sellingValuePaise: 60000 } as never);
      const call = mockPrisma.rewardCatalog.update.mock.calls?.[0]?.[0];
      expect(call.data.pointsCost).toBe(1200); // ₹600 × 2
      expect(call.data.sellingValuePaise).toBe(60000);
    });

    it('FINDING 1: a benign edit does NOT re-price a FIXED item even with a STORED selling value', async () => {
      // Money audit: an unrelated edit must never silently re-derive from the stored selling
      // value at the current rate. Stored pointsCost must survive a name-only PATCH unchanged.
      mockSettings.conversionRate = 3; // would derive 600 from the stored ₹200 IF it re-priced
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', code: 'FX-1', stockQuantity: null, pointsCost: 100, sellingValuePaise: 20000,
        minRedemptionPoints: null, maxRedemptionPoints: null,
      });
      await service.updateCatalogItem(gifsy, 'r1', { name: 'Renamed' } as never);
      const call = mockPrisma.rewardCatalog.update.mock.calls?.[0]?.[0];
      expect(call.data.pointsCost).toBe(100); // UNCHANGED — no silent re-price
      // The rate is not even read for an edit that doesn't change the selling value.
      expect(mockTenantSettings.getConversionRate).not.toHaveBeenCalled();
    });

    it('FINDING 2: a benign edit is NOT locked out by a 0/unset rate when a selling value is stored', async () => {
      // Money audit (worse): once a FIXED item has a stored selling value, every PATCH used to
      // re-derive → derived < 1 at rate 0 → 400, making the item un-editable (can't deactivate).
      // Now a PATCH without a new selling value keeps the stored pointsCost and never reads the rate.
      mockSettings.conversionRate = 0; // rate not configured
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', code: 'FX-1', stockQuantity: 5, pointsCost: 500, sellingValuePaise: 50000,
        minRedemptionPoints: null, maxRedemptionPoints: null,
      });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'r1' });
      // Deactivating must succeed (no 400) and keep the stored price.
      await expect(
        service.updateCatalogItem(gifsy, 'r1', { status: 'INACTIVE' } as never),
      ).resolves.toEqual({ item: { id: 'r1' } });
      const call = mockPrisma.rewardCatalog.update.mock.calls?.[0]?.[0];
      expect(call.data.pointsCost).toBe(500); // kept
      expect(call.data.status).toBe('INACTIVE');
      expect(mockTenantSettings.getConversionRate).not.toHaveBeenCalled();
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
      // Pure derive: a FIXED item with no selling value keeps its stored pointsCost on UPDATE.
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', code: 'AMZ500', stockQuantity: 0, pointsCost: 500, sellingValuePaise: null,
        minRedemptionPoints: null, maxRedemptionPoints: null,
      });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'r1' });
      await service.updateCatalogItem(gifsy, 'r1', { status: 'ACTIVE' });
      const call = mockPrisma.rewardCatalog.update.mock.calls?.[0]?.[0];
      expect(call.data.status).toBe('OUT_OF_STOCK');
    });

    it('allows ACTIVE when effective stock is positive', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', code: 'AMZ500', stockQuantity: 5, pointsCost: 500, sellingValuePaise: null,
        minRedemptionPoints: null, maxRedemptionPoints: null,
      });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'r1' });
      await service.updateCatalogItem(gifsy, 'r1', { status: 'ACTIVE' });
      const call = mockPrisma.rewardCatalog.update.mock.calls?.[0]?.[0];
      expect(call.data.status).toBe('ACTIVE');
    });

    it('persists an optional sellingValuePaise', async () => {
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', code: 'AMZ500', stockQuantity: 5, mrpPaise: 60000,
        minRedemptionPoints: null, maxRedemptionPoints: null,
      });
      mockPrisma.rewardCatalog.update.mockResolvedValue({ id: 'r1' });
      await service.updateCatalogItem(gifsy, 'r1', { sellingValuePaise: 50000 });
      const call = mockPrisma.rewardCatalog.update.mock.calls?.[0]?.[0];
      expect(call.data.sellingValuePaise).toBe(50000);
    });

    it('rejects an EFFECTIVE sellingValuePaise > mrpPaise (payload selling value vs stored MRP)', async () => {
      // Stored MRP 50000; a PATCH raising selling value to 60000 must be rejected.
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
        id: 'r1', code: 'AMZ500', stockQuantity: 5, mrpPaise: 50000,
        minRedemptionPoints: null, maxRedemptionPoints: null,
      });
      await expect(
        service.updateCatalogItem(gifsy, 'r1', { sellingValuePaise: 60000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.rewardCatalog.update).not.toHaveBeenCalled();
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

      const buf = await service.getFulfilmentTemplate(assumedGifsy, {});

      // Tenant scope (assumed operator → partner.clientId, §12) + default actionable set.
      const call = mockPrisma.redemptionOrder.findMany.mock.calls?.[0]?.[0];
      expect(call.where.partner).toEqual({ clientId: 'deoleo' });
      expect(call.where.status).toEqual({
        in: expect.arrayContaining(['CONFIRMED', 'PROCESSING', 'DISPATCHED']),
      });
      // Round-trips through the shared helper into a real, parseable xlsx.
      expect(Buffer.isBuffer(buf)).toBe(true);
      const parsed = parseFulfilmentUploadBuffer(buf);
      expect(parsed.rows[0].orderNumber).toBe('RDM-1');
    });

    it('adds the partner Outlet ID (primary live outlet) and registered phone columns', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([
        {
          orderNumber: 'RDM-1', redemptionMode: 'GIFT_CARD', status: 'CONFIRMED',
          reward: { name: 'Amazon ₹500' },
          partner: { phone: '9811111111', user: { phone: '9000000000' }, outlets: [{ outletCode: 'BJ-0042' }] },
        },
        {
          orderNumber: 'RDM-2', redemptionMode: 'GIFT_CARD', status: 'CONFIRMED',
          reward: { name: 'Amazon ₹500' },
          // No partner phone → the login's phone; no live outlet → blank.
          partner: { phone: null, user: { phone: '9822222222' }, outlets: [] },
        },
      ]);
      const buf = await service.getFulfilmentTemplate(assumedGifsy, {});

      const call = mockPrisma.redemptionOrder.findMany.mock.calls?.[0]?.[0];
      expect(call.include.partner.select.outlets).toEqual({
        where: { deletedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 1,
        select: { outletCode: true },
      });
      const XLSX = require('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
      const h = aoa[0] as string[];
      expect(aoa[1][h.indexOf('Outlet ID')]).toBe('BJ-0042');
      expect(aoa[1][h.indexOf('Phone')]).toBe('9811111111');
      expect(aoa[2][h.indexOf('Outlet ID')]).toBe('');
      expect(aoa[2][h.indexOf('Phone')]).toBe('9822222222');
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

    it('memory-safety: caps the error list at 500 (failed keeps the true total)', async () => {
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null); // every row: order not found
      const rows = Array.from({ length: 510 }, (_, i) => ({ orderNumber: `RDM-${i}` }));
      const fill = Object.fromEntries(rows.map((_, i) => [i, { 'New Status': 'PROCESSING' }]));
      const res = await service.uploadFulfilment(gifsy, fileFromRows(rows, fill));
      expect(res.failed).toBe(510);
      expect(res.errors).toHaveLength(500);
      expect(res.errorsTruncated).toBe(true);
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
      const res = await service.uploadFulfilment(assumedGifsy, file);

      // Resolved the order in-tenant by orderNumber (assumed operator → partner.clientId).
      expect(mockPrisma.redemptionOrder.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderNumber: 'RDM-1', partner: { clientId: 'deoleo' } },
        }),
      );
      // Applied via the guarded transition with the row's voucher + target status.
      expect(spy).toHaveBeenCalledWith(assumedGifsy, 'oid-1', expect.objectContaining({
        toStatus: 'PROCESSING',
        voucherCode: 'GC-XYZ',
      }));
      expect(res).toEqual({ processed: 1, succeeded: 1, skipped: 0, failed: 0, errors: [], errorsTruncated: false });
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
      const res = await service.uploadFulfilment(assumedGifsy, file);

      expect(mockPrisma.redemptionOrder.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orderNumber: 'RDM-OTHER-TENANT', partner: { clientId: 'deoleo' } },
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
      expect(res).toEqual({ processed: 1, succeeded: 0, skipped: 1, failed: 0, errors: [], errorsTruncated: false });
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
      // KYC-APPROVED + active: required for ALL redemption modes (all-mode gate).
      partner: {
        id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
        kycSubmissions: [{ status: 'APPROVED' }],
      },
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

    it('valuePaise = 0 when the tenant conversionRate is 0 (guard against division-by-zero)', async () => {
      // Rate now comes from TenantSettingsService, not env. baseOrder has no per-order
      // snapshot (conversionRateCenti), so confirm falls back to the live tenant rate (0).
      mockSettings.conversionRate = 0;
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

      await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });

      const claimCall = mockPrisma.redemptionOrder.updateMany.mock.calls.find(
        (c: unknown[]) => (c[0] as { where?: { status?: string } }).where?.status === 'PENDING',
      );
      const claimData = (claimCall![0] as { data: { valuePaise?: bigint } }).data;
      expect(claimData.valuePaise).toBe(0n);
    });

    it('FREEZE: confirm values the order at the SNAPSHOT rate, not the live rate', async () => {
      // Order snapshotted at rate 2 (centi 200); admin since changed the live rate to 5.
      // valuePaise must use the snapshot: 500 points × 100 / 200 = 25000 paise (₹250).
      mockSettings.conversionRate = 5;
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ ...baseOrder, conversionRateCenti: 200 });
      mockPrisma.otpCode.findFirst.mockResolvedValue({
        id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
        expiresAt: new Date(Date.now() + 60_000), verifiedAt: null,
      });
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockWallet.debitRedeem.mockResolvedValue({});
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.redemptionOrder.update.mockResolvedValue({});
      mockPrisma.redemptionStatusHistory.create.mockResolvedValue({});

      await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });

      const claimCall = mockPrisma.redemptionOrder.updateMany.mock.calls.find(
        (c: unknown[]) => (c[0] as { where?: { status?: string } }).where?.status === 'PENDING',
      );
      const claimData = (claimCall![0] as { data: { valuePaise?: bigint } }).data;
      expect(claimData.valuePaise).toBe(25000n);
    });
  });

  // ─── P6 Bridge — confirmRedeem creates PayoutTransaction for cash modes ──────

  describe('confirmRedeem — P6 payout bridge', () => {
    /**
     * Partner bank snapshot returned by the channelPartner.findFirst inside the tx.
     * The tx mock proxies to mockPrisma, so channelPartner.findFirst serves both
     * the TOCTOU eligibility re-check (first call in tx) and the bank snapshot fetch
     * (second call in tx). We include KYC fields so the TOCTOU check passes, and bank
     * fields so the snapshot fetch succeeds — extra fields are ignored by each select.
     */
    const partnerSnap = {
      // Wave 3: confirmRedeem now resolves the active partner via channelPartner.findFirst
      // (own-lookup) BEFORE the tx, so this shared override must carry the id the order is on.
      id: 'cp1',
      // Eligibility fields (TOCTOU in-tx re-check)
      isActive: true,
      deletedAt: null,
      kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
      // Bank snapshot fields
      bankAccountHolder: 'Ravi Kumar',
      ownerName: 'Ravi Kumar Proprietor',
      upiId: 'ravi@upi',
      bankAccountNumber: '0011223344',
      ifscCode: 'HDFC0001234',
      bankName: 'HDFC Bank',
    };

    /** A PENDING UPI-mode order (valuePaise will be computed as 100000n for 1000 pts).
     *  partner must include kycSubmissions for the pre-tx GLB-1b eligibility gate. */
    const upiOrder = {
      id: 'o-upi',
      status: 'PENDING',
      partnerId: 'cp1',
      orderNumber: 'RDM-UPI',
      totalPointsCost: 1000,
      quantity: 1,
      redemptionMode: 'UPI',
      partner: {
        id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
        kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
        // Beneficiary rails present so the pre-tx beneficiary-presence guard passes.
        bankAccountNumber: '0011223344', ifscCode: 'HDFC0001234', upiId: 'ravi@upi',
      },
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

    // Factory (NOT a shared const): expiresAt is computed at TEST-RUN time. A describe-level const is
    // evaluated when Jest COLLECTS the file, so under full-suite load a test running >60 s later saw
    // an already-expired OTP ("OTP expired" flake, 2026-11-10).
    const goodOtp = () => ({
      id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
      expiresAt: new Date(Date.now() + 60_000), verifiedAt: null,
    });

    beforeEach(() => {
      mockPrisma.otpCode.findFirst.mockResolvedValue(goodOtp());
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
      // Partner has a BANK-ONLY beneficiary → the rail is BANK_TRANSFER.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        ...partnerSnap,
        upiId: null,
        bankAccountNumber: '0011223344',
        ifscCode: 'HDFC0001234',
      });

      await service.confirmRedeem(partner, { orderId: 'o-bank', otp: '123456' });

      expect(mockPrisma.payoutTransaction.create).toHaveBeenCalledTimes(1);
      const call = mockPrisma.payoutTransaction.create.mock.calls[0][0];
      expect(call.data.payoutMode).toBe('BANK_TRANSFER');
      expect(call.data.redemptionOrderId).toBe('o-bank');
      expect(call.data.amountPaise).toBe(100000n);
      expect(call.data.status).toBe('PENDING');
    });

    // ── MONEY-PATH: the payout RAIL follows the PARTNER's on-file beneficiary,
    //    NOT the catalogue item's stored redemptionMode (the unified "Cash Payout"
    //    item always stores BANK_TRANSFER, but a UPI-only partner must still be
    //    paid via UPI, and a bank-only partner via BANK_TRANSFER). ──────────────

    it('rail follows the beneficiary: a BANK_TRANSFER-mode item with a UPI-ONLY partner pays out via UPI', async () => {
      // Catalogue item mode = BANK_TRANSFER (the canonical "Cash Payout" stored value)…
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(bankOrder);
      // …but the partner's on-file beneficiary is UPI-only.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        ...partnerSnap,
        upiId: 'upionly@upi',
        bankAccountNumber: null,
        ifscCode: null,
        bankName: null,
      });

      await service.confirmRedeem(partner, { orderId: 'o-bank', otp: '123456' });

      const call = mockPrisma.payoutTransaction.create.mock.calls[0][0];
      expect(call.data.payoutMode).toBe('UPI');
      expect(call.data.upiId).toBe('upionly@upi');
      expect(call.data.bankAccountNumber).toBeNull();
    });

    it('rail follows the beneficiary: a UPI-mode item with a BANK-ONLY partner pays out via BANK_TRANSFER', async () => {
      // Legacy catalogue item mode = UPI…
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(upiOrder);
      // …but the partner's on-file beneficiary is bank-only.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        ...partnerSnap,
        upiId: null,
        bankAccountNumber: '5566778899',
        ifscCode: 'ICIC0005678',
        bankName: 'ICICI Bank',
      });

      await service.confirmRedeem(partner, { orderId: 'o-upi', otp: '123456' });

      const call = mockPrisma.payoutTransaction.create.mock.calls[0][0];
      expect(call.data.payoutMode).toBe('BANK_TRANSFER');
      expect(call.data.bankAccountNumber).toBe('5566778899');
      expect(call.data.upiId).toBeNull();
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

    it('GLB-2: throws BadRequestException (not 0n fallback) when valuePaise is 0 for a cash UPI mode', async () => {
      // GLB-2: cash modes with valuePaise=0n hard-fail inside the transaction
      // (POINTS_CONVERSION_RATE=0 → valuePaise=0n → BadRequest before debit/payout).
      // The old "fallback to 0n" behavior was superseded — the zero-value fallback
      // only applies to non-cash modes (where no PayoutTransaction is created).
      // Rate now comes from TenantSettingsService. upiOrder has no snapshot → live rate 0.
      mockSettings.conversionRate = 0;
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(upiOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue(goodOtp());
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockWallet.debitRedeem.mockResolvedValue({});
      mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.redemptionStatusHistory.create.mockResolvedValue({});
      mockPrisma.channelPartner.findFirst.mockResolvedValue(partnerSnap);
      mockPrisma.payoutTransaction.create.mockResolvedValue({ id: 'pt-warn' });

      // GLB-2 fires inside the tx: valuePaise=0n for UPI → BadRequest, tx rolls back.
      await expect(service.confirmRedeem(partner, { orderId: 'o-upi', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
      // No PayoutTransaction created (tx rolled back before the payout create).
      expect(mockPrisma.payoutTransaction.create).not.toHaveBeenCalled();
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
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

  // ─── GLB-1b / TOCTOU — additional eligibility gate coverage ─────────────────

  describe('confirmRedeem — GLB-1b cash-eligibility extended coverage', () => {
    // Factory (NOT a shared const): expiresAt is computed at TEST-RUN time. A describe-level const is
    // evaluated when Jest COLLECTS the file, so under full-suite load a test running >60 s later saw
    // an already-expired OTP ("OTP expired" flake, 2026-11-10).
    const goodOtp = () => ({
      id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3,
      expiresAt: new Date(Date.now() + 60_000), verifiedAt: null,
    });

    /** An order whose partner is APPROVED at the pre-tx read. */
    const approvedCashOrder = {
      id: 'o-cash',
      status: 'PENDING',
      partnerId: 'cp1',
      orderNumber: 'RDM-CASH',
      totalPointsCost: 500,
      quantity: 1,
      redemptionMode: 'UPI',
      partner: {
        id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
        kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
        // Beneficiary rails present so the pre-tx beneficiary-presence guard passes.
        bankAccountNumber: '9988776655', ifscCode: 'ICIC0001234', upiId: 'alice@upi',
      },
      reward: { name: 'Cash ₹500', stockQuantity: null },
    };

    it('pre-tx gate throws before OTP check when partner KYC is not APPROVED', async () => {
      // Partner has PENDING_SO_APPROVAL status → pre-tx eligibility gate fires immediately.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
        ...approvedCashOrder,
        partner: {
          id: 'cp1', userId: 'user1', isActive: true, deletedAt: null,
          kycSubmissions: [{ id: 'ks1', status: 'PENDING_SO_APPROVAL', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
        },
      });
      await expect(service.confirmRedeem(partner, { orderId: 'o-cash', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
      // Gate fires before the OTP lookup — OTP never queried.
      expect(mockPrisma.otpCode.findFirst).not.toHaveBeenCalled();
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
    });

    it('TOCTOU in-tx re-check: pre-tx eligible but in-tx fresh-read ineligible throws without debit', async () => {
      // Pre-tx: partner is APPROVED. In-tx fresh read returns RE_KYC_REQUIRED.
      // The TOCTOU guard must catch the suspension and throw, rolling back the tx.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(approvedCashOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue(goodOtp());
      mockPrisma.otpCode.update.mockResolvedValue({});

      // The first channelPartner.findFirst (in-tx TOCTOU) returns ineligible partner;
      // since $transaction proxies to mockPrisma and there is only one channelPartner
      // lookup per-call sequence, a single mockResolvedValue suffices.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'cp1', // Wave 3: also serves the pre-tx active-partner own-lookup (must match order.partnerId)
        isActive: true,
        deletedAt: null,
        kycSubmissions: [{ id: 'ks1', status: 'RE_KYC_REQUIRED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
      });

      await expect(service.confirmRedeem(partner, { orderId: 'o-cash', otp: '123456' }))
        .rejects.toBeInstanceOf(BadRequestException);
      // Tx rolled back — no debit and no payout.
      expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
      expect(mockPrisma.payoutTransaction.create).not.toHaveBeenCalled();
    });

    it('fully eligible APPROVED partner completes confirmRedeem for a UPI order', async () => {
      // End-to-end happy path: pre-tx gate passes, TOCTOU passes, debit + payout created.
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(approvedCashOrder);
      mockPrisma.otpCode.findFirst.mockResolvedValue(goodOtp());
      mockPrisma.otpCode.update.mockResolvedValue({});
      mockWallet.debitRedeem.mockResolvedValue({});
      mockPrisma.redemptionStatusHistory.create.mockResolvedValue({});
      mockPrisma.payoutTransaction.create.mockResolvedValue({ id: 'pt1' });
      // Both TOCTOU check and bank snapshot return partnerSnap (which has APPROVED KYC).
      // Wave 3: also serves the pre-tx active-partner own-lookup (id must match order.partnerId).
      mockPrisma.channelPartner.findFirst.mockResolvedValue({
        id: 'cp1', isActive: true, deletedAt: null,
        kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
        bankAccountHolder: 'Alice', ownerName: 'Alice Owner', upiId: 'alice@upi',
        bankAccountNumber: '9988776655', ifscCode: 'ICIC0001234', bankName: 'ICICI',
      });

      const res = await service.confirmRedeem(partner, { orderId: 'o-cash', otp: '123456' });

      expect(res.status).toBe('CONFIRMED');
      expect(mockWallet.debitRedeem).toHaveBeenCalledTimes(1);
      expect(mockPrisma.payoutTransaction.create).toHaveBeenCalledTimes(1);
      const ptCall = mockPrisma.payoutTransaction.create.mock.calls[0][0];
      expect(ptCall.data.payoutMode).toBe('UPI');
      expect(ptCall.data.status).toBe('PENDING');
    });
  });

  // ─── Dispatch console (cross-tenant fulfilment queue) ────────────────────────
  describe('listFulfilmentOrders', () => {
    it('rejects a non-operator at the data boundary (audit #6)', async () => {
      await expect(service.listFulfilmentOrders(partner, {})).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.redemptionOrder.findMany).not.toHaveBeenCalled();
    });

    it('platformWide OWNER may narrow to one tenant via q.clientId', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);
      await service.listFulfilmentOrders(gifsy, { clientId: 'acme' });
      const call = mockPrisma.redemptionOrder.findMany.mock.calls[0][0];
      expect(call.where.partner).toEqual({ clientId: 'acme' });
    });

    it('ASSUMED operator is HARD-pinned — q.clientId cannot override the tenant (no leak)', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);
      await service.listFulfilmentOrders(assumedGifsy, { clientId: 'acme' });
      const call = mockPrisma.redemptionOrder.findMany.mock.calls[0][0];
      expect(call.where.partner).toEqual({ clientId: 'deoleo' }); // pinned, NOT acme
    });

    it('date-only createdAt filter uses INCLUSIVE IST day bounds, not raw new Date (IST boundary fix)', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);
      await service.listFulfilmentOrders(gifsy, { from: '2026-08-01', to: '2026-08-31' });
      const call = mockPrisma.redemptionOrder.findMany.mock.calls[0][0];

      // from → 00:00:00.000 IST of 2026-08-01 = 2026-07-31T18:30:00.000Z (NOT raw 05:30 IST).
      expect(call.where.createdAt.gte.toISOString()).toBe('2026-07-31T18:30:00.000Z');
      // to → 23:59:59.999 IST of 2026-08-31 = 2026-08-31T18:29:59.999Z (NOT the old raw
      // new Date('2026-08-31') = 00:00Z = 05:30 IST, which truncated almost the whole day).
      expect(call.where.createdAt.lte.toISOString()).toBe('2026-08-31T18:29:59.999Z');

      // An order created at 23:00 IST on the to-date (2026-08-31T17:30:00Z) is NOW INCLUDED
      // (it was dropped by the old raw-new-Date upper bound of 2026-08-31T00:00:00Z).
      const lateOnToDate = new Date('2026-08-31T17:30:00.000Z');
      expect(lateOnToDate.getTime()).toBeLessThanOrEqual(call.where.createdAt.lte.getTime());
      expect(lateOnToDate.getTime()).toBeGreaterThanOrEqual(call.where.createdAt.gte.getTime());
    });

    it('omits the createdAt filter when neither from nor to is given', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(0);
      await service.listFulfilmentOrders(gifsy, {});
      const call = mockPrisma.redemptionOrder.findMany.mock.calls[0][0];
      expect(call.where.createdAt).toBeUndefined();
    });

    it('annotates each order with a channel-aware SLA + stringifies BigInt valuePaise', async () => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([
        {
          id: 'o1', status: 'CONFIRMED', fulfilmentChannel: 'GIFSY_WAREHOUSE',
          dispatchedAt: null, valuePaise: 50000n, statusHistory: [{ createdAt: new Date() }],
        },
      ]);
      mockPrisma.redemptionOrder.count.mockResolvedValue(1);
      const res = await service.listFulfilmentOrders(gifsy, {});
      expect(res.items[0].dispatchSla).toEqual(
        expect.objectContaining({ applicable: true }),
      );
      expect(res.items[0].valuePaise).toBe('50000');
    });
  });

  describe('getFulfilmentOrder', () => {
    it('rejects a non-operator at the data boundary (audit #6)', async () => {
      await expect(service.getFulfilmentOrder(partner, 'o1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.redemptionOrder.findFirst).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // HUBBLE MONEY — GIFT_CARD auto-issuance (Bajaj-only, flag-gated). Covers the
  // money-safety matrix: SUCCESS→voucher+DELIVERED, PROCESSING→pending, FAILED→refund,
  // idempotent-recovery, indeterminate→no-refund, flag/eligibility gating, webhook reconcile.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Hubble auto-issuance', () => {
    const loadedOrder = (over: Record<string, unknown> = {}) => ({
      id: 'o1',
      orderNumber: 'RDM-x',
      partnerId: 'cp1',
      status: 'CONFIRMED',
      voucherCode: null,
      pointsDeducted: 1000,
      valuePaise: 50000n, // ₹500
      redemptionMode: 'GIFT_CARD',
      metadata: {},
      // owner lookup (reconcile) selects partner.clientId; harmless extra field for issue path.
      partner: { clientId: 'deoleo' },
      reward: { metadata: { hubbleProductId: 'amz-1' } },
      ...over,
    });

    describe('issueHubbleVoucherForOrder', () => {
      it('SUCCESS → stores the voucher + marks DELIVERED, no refund', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockHubble.placeOrder.mockResolvedValue({
          status: 'SUCCESS',
          id: 'hub-1',
          vouchers: [{ id: 'v1', cardType: 'CARD_NUMBER_SECURED', cardNumber: 'CARD-123', cardPin: null, validTill: '2027-01-01', amount: 500 }],
        });

        const out = await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');

        expect(out).toBe('DELIVERED');
        // referenceId = our order id; amount = valuePaise/100 (rupees); free-denomination.
        expect(mockHubble.placeOrder).toHaveBeenCalledWith(
          expect.objectContaining({
            productId: 'amz-1',
            referenceId: 'o1',
            amount: 500,
            denominationDetails: [{ denomination: 500, quantity: 1 }],
            customerDetails: null,
          }),
        );
        // DELIVERED + voucher persisted via the atomic status claim.
        const deliverCall = mockPrisma.redemptionOrder.updateMany.mock.calls.find(
          ([arg]) => (arg as { data?: { status?: string } })?.data?.status === 'DELIVERED',
        );
        expect(deliverCall).toBeDefined();
        expect((deliverCall![0] as { data: Record<string, unknown> }).data).toEqual(
          expect.objectContaining({
            status: 'DELIVERED',
            voucherCode: 'CARD-123',
            voucherProvider: 'Hubble',
            fulfilmentChannel: 'DIGITAL_VOUCHER',
          }),
        );
        expect(mockWallet.reverse).not.toHaveBeenCalled();
      });

      it.each([
        // [label, voucher, expected voucherCode, expected voucherPin]
        ['card number + PIN (CARD_AND_PIN_NO_SECURED) → code = number, PIN stored',
          { cardType: 'CARD_AND_PIN_NO_SECURED', cardNumber: ' 6001220012345678 ', cardPin: ' 482913 ' }, '6001220012345678', '482913'],
        ['number only (CARD_NUMBER_SECURED) → unchanged, no PIN',
          { cardType: 'CARD_NUMBER_SECURED', cardNumber: 'CARD-123', cardPin: null }, 'CARD-123', null],
        ['PIN only → the PIN IS the code (unchanged), no separate PIN',
          { cardType: 'PIN_SECURED', cardNumber: '', cardPin: 'PIN-777' }, 'PIN-777', null],
      ])('SUCCESS %s', async (_label, voucher, code, pin) => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockHubble.placeOrder.mockResolvedValue({ status: 'SUCCESS', id: 'hub-1', vouchers: [{ id: 'v1', ...voucher }] });
        const out = await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');
        expect(out).toBe('DELIVERED');
        const deliverCall = mockPrisma.redemptionOrder.updateMany.mock.calls.find(
          ([arg]) => (arg as { data?: { status?: string } })?.data?.status === 'DELIVERED',
        );
        const data = (deliverCall![0] as { data: Record<string, unknown> }).data;
        // Same guarded claim carries the code AND the PIN.
        expect(data.voucherCode).toBe(code);
        expect(data.voucherPin).toBe(pin);
        // Neither the PIN nor the card number is duplicated into metadata.
        const meta = JSON.stringify(data.metadata);
        expect(meta).not.toContain('482913');
        expect(meta).not.toContain('6001220012345678');
      });

      it('PROCESSING → marks PROCESSING (pending external), no refund', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockHubble.placeOrder.mockResolvedValue({ status: 'PROCESSING', id: 'hub-1', vouchers: [] });

        const out = await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');

        expect(out).toBe('PROCESSING');
        const procCall = mockPrisma.redemptionOrder.updateMany.mock.calls.find(
          ([arg]) => (arg as { data?: { status?: string } })?.data?.status === 'PROCESSING',
        );
        expect(procCall).toBeDefined();
        expect(mockWallet.reverse).not.toHaveBeenCalled();
      });

      it('FAILED → refunds the points (atomic claim) + marks FAILED', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockHubble.placeOrder.mockResolvedValue({ status: 'FAILED', failureReason: 'wallet empty' });

        const out = await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');

        expect(out).toBe('FAILED_REFUNDED');
        // Reuses the canonical reversal path with the order's debited points.
        expect(mockWallet.reverse).toHaveBeenCalledWith(
          'cp1',
          1000,
          expect.objectContaining({ referenceId: 'o1' }),
          expect.anything(),
        );
        const failCall = mockPrisma.redemptionOrder.updateMany.mock.calls.find(
          ([arg]) => (arg as { data?: { status?: string } })?.data?.status === 'FAILED',
        );
        expect(failCall).toBeDefined();
      });

      it('idempotent recovery: a placeOrder throw recovers SUCCESS via get-by-reference, no double-issue/refund', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockHubble.placeOrder.mockRejectedValue(new Error('timeout'));
        mockHubble.getOrderByReference.mockResolvedValue({
          status: 'SUCCESS',
          id: 'hub-1',
          vouchers: [{ cardNumber: 'CARD-9', cardType: 'CARD_NUMBER_SECURED' }],
        });

        const out = await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');

        expect(out).toBe('DELIVERED');
        expect(mockHubble.getOrderByReference).toHaveBeenCalledWith('o1');
        expect(mockWallet.reverse).not.toHaveBeenCalled();
      });

      // CANARY (owner 2026-11-15): a recovery "not found" is only trusted when a KNOWN delivered Hubble
      // order of the same tenant comes back SUCCESS through the same lookup.
      const CANARY = { id: 'c1', supplierOrderRef: 'hub-c1', metadata: { hubbleAccount: 'api.dev.myhubble.money#0000000000000000' } };
      const CANARY_OK = { status: 'SUCCESS', id: 'hub-c1', referenceId: 'c1', vouchers: [{ cardNumber: 'C' }] };
      /** o1 → Hubble "no order"; the canary c1 → `canary` (default: found, SUCCESS). */
      const noOrderWithCanary = (canary: unknown = CANARY_OK) =>
        mockHubble.getOrderByReference.mockImplementation(async (ref: string) => {
          if (ref !== 'c1') return null;
          if (canary instanceof Error) throw canary;
          return canary;
        });

      const REJECTED = () => new HubblePlaceOrderRejectedError(400, 'E102');

      it('H1: placeOrder TIMEOUT / 5xx / network + recovery "not found" → NEVER refunded at confirm; CONFIRMED + HUBBLE_INDETERMINATE; no canary needed', async () => {
        for (const err of [
          new Error('Hubble request failed: Hubble did not respond within 15s'),
          new Error('Hubble placeOrder non-success HTTP 503'),
          new Error('Hubble request failed: fetch failed'),
          new Error('Hubble placeOrder non-success HTTP 409'),
        ]) {
          jest.clearAllMocks();
          mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
          mockPrisma.redemptionOrder.update.mockResolvedValue({});
          mockHubble.placeOrder.mockRejectedValue(err);
          noOrderWithCanary();

          expect(await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1')).toBe('PENDING_INDETERMINATE');
          expect(mockWallet.reverse).not.toHaveBeenCalled();
          expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
          expect(mockPrisma.redemptionOrder.findMany).not.toHaveBeenCalled(); // no canary — never refundable here
          const metas = mockPrisma.redemptionOrder.update.mock.calls.map((c) => c[0].data.metadata as Record<string, unknown>);
          expect(metas.some((m) => m.hubbleNeedsReconcile === true && m.hubbleReconcileReason === 'HUBBLE_INDETERMINATE')).toBe(true);
        }
      });

      it('definitive 4xx rejection (HTTP 400/422 Hubble error) + recovery 404 → null + canary verified → refund immediately (as before)', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockPrisma.redemptionOrder.findMany.mockReset();
        mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce([CANARY]);
        mockHubble.placeOrder.mockRejectedValue(REJECTED());
        noOrderWithCanary();

        const out = await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');

        expect(out).toBe('FAILED_REFUNDED');
        expect(mockWallet.reverse).toHaveBeenCalled();
        expect(mockHubble.getOrderByReference).toHaveBeenCalledWith('c1');
        // Any tenant on the same Hubble account (credentials are platform-wide) — no tenant filter in SQL.
        const where = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
        expect(where).toMatchObject({ id: { not: 'o1' }, status: 'DELIVERED' });
        expect(where.partner).toBeUndefined();
      });

      it.each([
        ['no canary order exists', [] as unknown[], CANARY_OK as unknown, /no delivered Hubble order/],
        ['the canary is ALSO "not found" (wrong route / gateway 404)', [CANARY], null, /also returned "not found"/],
        ['the canary lookup throws', [CANARY], new Error('HTTP 503'), /canary lookup failed/],
        ['the canary comes back non-SUCCESS', [CANARY], { ...CANARY_OK, status: 'PROCESSING' }, /not SUCCESS/],
      ])('rejected + recovery "not found" but %s → NOT refunded; CONFIRMED + HUBBLE_INDETERMINATE (retryable); recorded + audited', async (_n, rows, canary, why) => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockPrisma.redemptionOrder.findMany.mockReset();
        mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce(rows);
        mockPrisma.redemptionOrder.update.mockResolvedValue({});
        mockHubble.placeOrder.mockRejectedValue(REJECTED());
        noOrderWithCanary(canary);

        const out = await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');

        // Fail closed into the same pending state as an indeterminate placement (ops retry may refund later).
        expect(out).toBe('PENDING_INDETERMINATE');
        expect(mockWallet.reverse).not.toHaveBeenCalled();
        // No refund claim / FAILED flip at all.
        expect(mockPrisma.redemptionOrder.updateMany).not.toHaveBeenCalled();
        const metas = mockPrisma.redemptionOrder.update.mock.calls.map((c) => c[0].data.metadata as Record<string, unknown>);
        expect(metas.some((m) => m.hubbleNeedsReconcile === true && m.hubbleReconcileReason === 'HUBBLE_INDETERMINATE')).toBe(true);
        const unverified = metas.find((m) => m.hubbleNoOrderUnverified)?.hubbleNoOrderUnverified as Record<string, unknown>;
        expect(unverified).toMatchObject({ source: 'CONFIRM', by: 'actor1' });
        expect(String(unverified.why)).toMatch(why);
        const audits = mockPrisma.auditLog.create.mock.calls.filter(
          (c) => (c[0] as { data: { metadata: { event: string } } }).data.metadata.event === 'HUBBLE_NO_ORDER_UNVERIFIED',
        );
        expect(audits).toHaveLength(1);
        expect(audits[0][0].data.metadata).toMatchObject({ source: 'CONFIRM' });
      });

      it.each([
        // No canary rows queued for the timeout: the canary is never consulted there (an unconsumed Once would leak).
        ['a placeOrder timeout + recovery "not found" (PENDING_INDETERMINATE)', () => new Error('Hubble request failed: Hubble did not respond within 15s'), null],
        ['a rejection whose "not found" could not be verified (NO_HUBBLE_ORDER_UNVERIFIED)', REJECTED, []],
      ])('confirm response for %s: CONFIRMED, honest pending copy (never issued / refunded / failed / shortly / a refund promise)', async (_n, err, rows) => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockPrisma.redemptionOrder.findMany.mockReset();
        if (rows) mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce(rows);
        mockPrisma.redemptionOrder.update.mockResolvedValue({});
        mockHubble.placeOrder.mockRejectedValue(err());
        noOrderWithCanary();

        const res = await (service as unknown as {
          finishHubbleConfirm: (o: unknown, c: unknown) => Promise<{ status: string; message: string }>;
        }).finishHubbleConfirm(
          { id: 'o1', orderNumber: 'RDM-x' },
          { clientId: 'deoleo', actorId: 'actor1', notifyUserId: 'u1', recipientPhone: null, ownerName: 'O', rewardName: 'Amazon Voucher', points: 500 },
        );

        expect(res.status).toBe('CONFIRMED');
        expect(res.message).toBe(
          'Redemption confirmed. Your voucher is taking longer than usual — we’re checking with the voucher provider. It will appear in your orders once issued; our team will follow up if there’s a problem.',
        );
        expect(res.message).not.toMatch(/has been issued|refund|failed|try again|shortly|returned/i);
        expect(mockWallet.reverse).not.toHaveBeenCalled();
        const n = mockNotifications.notifyUserWithChannels.mock.calls.at(-1)![0];
        expect(n).toMatchObject({ eventKey: 'REDEMPTION_CONFIRMED', event: 'REDEMPTION_CONFIRMED', body: res.message });
      });

      it('INDETERMINATE (place + recover both throw) → pending reconcile, NEVER refunds (no double-pay risk)', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockHubble.placeOrder.mockRejectedValue(new Error('timeout'));
        mockHubble.getOrderByReference.mockRejectedValue(new Error('still down'));

        const out = await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');

        expect(out).toBe('PENDING_INDETERMINATE');
        expect(mockWallet.reverse).not.toHaveBeenCalled();
        // flagged for reconcile (metadata patch), not a status flip.
        expect(mockPrisma.redemptionOrder.update).toHaveBeenCalled();
      });

      it('idempotent: an already-DELIVERED order with a voucher is a SKIPPED no-op (no placeOrder)', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(
          loadedOrder({ status: 'DELIVERED', voucherCode: 'CARD-OLD' }),
        );
        const out = await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');
        expect(out).toBe('SKIPPED');
        expect(mockHubble.placeOrder).not.toHaveBeenCalled();
      });

      // ── Issued-voucher protection on the Hubble paths (money re-audit) ──
      it('SUCCESS never overwrites a MANUAL code: the claim requires no code; a lost claim with a code present flags ops', async () => {
        const errSpy = jest.spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error');
        mockPrisma.redemptionOrder.findFirst
          .mockResolvedValueOnce(loadedOrder())                                            // loadHubbleOrder
          .mockResolvedValueOnce({ status: 'CONFIRMED', voucherCode: 'MANUAL-CODE-1', voucherProvider: 'Gifsy' }) // post-claim re-read
          .mockResolvedValueOnce({ metadata: {} });                                        // markHubblePendingReconcile
        mockHubble.placeOrder.mockResolvedValue({
          status: 'SUCCESS', id: 'hub-1', vouchers: [{ cardNumber: 'CARD-1', cardType: 'CARD_NUMBER_SECURED' }],
        });
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 }); // the guarded DELIVERED claim loses

        await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');

        const claim = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
        expect(claim.where.OR).toEqual([{ voucherCode: null }, { voucherCode: '' }]);
        expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
        expect(errSpy.mock.calls.some(([m]) => /manual voucher code is already on the order/.test(String(m)))).toBe(true);
        const flag = mockPrisma.redemptionOrder.update.mock.calls.at(-1)![0];
        expect(flag.data.metadata).toMatchObject({ hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_SUCCESS_MANUAL_CODE_PRESENT' });
      });

      // ── Honest DELIVERED (audit M1): the outcome is DELIVERED only when the order really holds
      // a delivered code — a SUCCESS that was left pending must not tell the member "issued". ──
      const confirmVia = () =>
        (service as unknown as {
          finishHubbleConfirm: (o: unknown, c: unknown) => Promise<{ status: string; message: string }>;
        }).finishHubbleConfirm(
          { id: 'o1', orderNumber: 'RDM-x' },
          { clientId: 'deoleo', actorId: 'actor1', notifyUserId: 'u1', recipientPhone: null, ownerName: 'O', rewardName: 'Amazon Voucher', points: 500 },
        );

      it('M1: SUCCESS with NO voucher code → PENDING_RECONCILE outcome; confirm status is NOT DELIVERED and never says "issued"', async () => {
        mockPrisma.redemptionOrder.findFirst
          .mockResolvedValueOnce(loadedOrder())       // loadHubbleOrder
          .mockResolvedValueOnce({ metadata: {} });   // markHubblePendingReconcile
        mockHubble.placeOrder.mockResolvedValue({ status: 'SUCCESS', id: 'hub-1', vouchers: [] });

        const res = await confirmVia();

        expect(res.status).toBe('CONFIRMED');
        expect(res.status).not.toBe('DELIVERED');
        expect(res.message).not.toMatch(/has been issued/);
        // A stuck state: the owner's pending copy — never "shortly".
        expect(res.message).toMatch(/taking longer than usual/);
        expect(res.message).not.toMatch(/shortly/);
        // No DELIVERED claim was even attempted; flagged for reconcile.
        expect(
          mockPrisma.redemptionOrder.updateMany.mock.calls.some(([a]) => (a as { data?: { status?: string } })?.data?.status === 'DELIVERED'),
        ).toBe(false);
        const flag = mockPrisma.redemptionOrder.update.mock.calls.at(-1)![0];
        expect(flag.data.metadata).toMatchObject({ hubbleReconcileReason: 'HUBBLE_SUCCESS_NO_CODE' });
      });

      it('M1: SUCCESS but a MANUAL code is already on the open order (claim lost) → outcome PENDING_RECONCILE; confirm NOT DELIVERED', async () => {
        mockPrisma.redemptionOrder.findFirst
          .mockResolvedValueOnce(loadedOrder())
          .mockResolvedValueOnce({ status: 'CONFIRMED', voucherCode: 'MANUAL-CODE-1', voucherProvider: 'Gifsy' })
          .mockResolvedValueOnce({ metadata: {} });
        mockHubble.placeOrder.mockResolvedValue({
          status: 'SUCCESS', id: 'hub-1', vouchers: [{ cardNumber: 'CARD-1', cardType: 'CARD_NUMBER_SECURED' }],
        });
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });

        const res = await confirmVia();

        expect(res.status).toBe('CONFIRMED');
        expect(res.message).not.toMatch(/has been issued/);
      });

      it('M1: issueHubbleVoucherForOrder reports PENDING_RECONCILE (not DELIVERED) for the manual-code-present lost claim', async () => {
        mockPrisma.redemptionOrder.findFirst
          .mockResolvedValueOnce(loadedOrder())
          .mockResolvedValueOnce({ status: 'PROCESSING', voucherCode: 'MANUAL-CODE-1', voucherProvider: 'Gifsy' })
          .mockResolvedValueOnce({ metadata: {} });
        mockHubble.placeOrder.mockResolvedValue({
          status: 'SUCCESS', id: 'hub-1', vouchers: [{ cardNumber: 'CARD-1', cardType: 'CARD_NUMBER_SECURED' }],
        });
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });
        expect(await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1')).toBe('PENDING_RECONCILE');
      });

      it('M1: a lost claim because a CONCURRENT apply already delivered it (DELIVERED + code) is still DELIVERED', async () => {
        mockPrisma.redemptionOrder.findFirst
          .mockResolvedValueOnce(loadedOrder())
          .mockResolvedValueOnce({ status: 'DELIVERED', voucherCode: 'CARD-1', voucherProvider: 'Hubble' });
        mockHubble.placeOrder.mockResolvedValue({
          status: 'SUCCESS', id: 'hub-1', vouchers: [{ cardNumber: 'CARD-1', cardType: 'CARD_NUMBER_SECURED' }],
        });
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });
        expect(await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1')).toBe('DELIVERED');
      });

      it('M1: normal SUCCESS with a code → confirm status DELIVERED + the "issued" message', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockHubble.placeOrder.mockResolvedValue({
          status: 'SUCCESS', id: 'hub-1', vouchers: [{ cardNumber: 'CARD-1', cardType: 'CARD_NUMBER_SECURED' }],
        });
        const notify = jest
          .spyOn(service as unknown as { notifyVoucherIssued: (a: string, b: string) => Promise<void> }, 'notifyVoucherIssued')
          .mockResolvedValue(undefined);

        const res = await confirmVia();

        expect(res.status).toBe('DELIVERED');
        expect(res.message).toMatch(/has been issued/);
        expect(notify).toHaveBeenCalledWith('o1', 'deoleo');
        notify.mockRestore();
      });

      it('FAILED / not-found-on-recovery never refunds an order holding a code (guarded claims) and flags ops', async () => {
        mockPrisma.redemptionOrder.findFirst
          .mockResolvedValueOnce(loadedOrder())                                         // loadHubbleOrder
          .mockResolvedValueOnce({ metadata: {} })                                      // in-tx metadata re-read (refund stamp)
          .mockResolvedValueOnce({ status: 'CONFIRMED', voucherCode: 'MANUAL-CODE-1' }) // post-flip re-read
          .mockResolvedValueOnce({ metadata: {} });                                     // reconcile flag read
        mockHubble.placeOrder.mockRejectedValue(new HubblePlaceOrderRejectedError(400, 'E102'));
        // "definitively never placed" (canary verified) → refund path
        mockPrisma.redemptionOrder.findMany.mockReset();
        mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce([{ id: 'c1', supplierOrderRef: 'hub-c1', metadata: {}, partner: { clientId: 'deoleo' } }]);
        mockHubble.getOrderByReference.mockImplementation(async (ref: string) =>
          ref === 'c1' ? { status: 'SUCCESS', id: 'hub-c1', referenceId: 'c1', vouchers: [] } : null,
        );
        mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 0 }); // both guarded claims refuse (code on row)

        const out = await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');
        // Blocked → never reported as "refunded" to the member.
        expect(out).toBe('PENDING_RECONCILE');

        const [refund, flip] = mockPrisma.redemptionOrder.updateMany.mock.calls.map((c) => c[0]);
        expect(refund.where.OR).toEqual([{ voucherCode: null }, { voucherCode: '' }]);
        expect(flip.where.OR).toEqual([{ voucherCode: null }, { voucherCode: '' }]);
        expect(mockWallet.reverse).not.toHaveBeenCalled();
        const flag = mockPrisma.redemptionOrder.update.mock.calls.at(-1)![0];
        expect(flag.data.metadata).toMatchObject({ hubbleReconcileReason: 'HUBBLE_FAILED_VOUCHER_PRESENT' });
      });

      it('PROCESSING on an order ops already took over (MANUAL_OVERRIDE) is NOT re-stamped Hubble — flagged instead', async () => {
        mockPrisma.redemptionOrder.findFirst
          .mockResolvedValueOnce(loadedOrder({ metadata: { hubbleStatus: 'MANUAL_OVERRIDE', hubbleNeedsReconcile: false } }))
          .mockResolvedValueOnce({ metadata: {} }); // markHubblePendingReconcile read
        mockHubble.placeOrder.mockResolvedValue({ status: 'PROCESSING', id: 'hub-1', vouchers: [] });
        await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');
        const procCall = mockPrisma.redemptionOrder.updateMany.mock.calls.find(
          ([arg]) => (arg as { data?: { status?: string } })?.data?.status === 'PROCESSING',
        );
        expect(procCall).toBeUndefined();
        const flag = mockPrisma.redemptionOrder.update.mock.calls.at(-1)![0];
        expect(flag.data.metadata).toMatchObject({ hubbleReconcileReason: 'HUBBLE_PROCESSING_AFTER_MANUAL' });
      });

      it('the PROCESSING claim pins no-code + the row version; a lost claim on a still-CONFIRMED order is flagged', async () => {
        const at = new Date('2026-11-09T10:00:00.000Z');
        mockPrisma.redemptionOrder.findFirst
          .mockResolvedValueOnce(loadedOrder({ updatedAt: at }))
          .mockResolvedValueOnce({ status: 'CONFIRMED' })  // post-loss re-read
          .mockResolvedValueOnce({ metadata: {} });        // flag read
        mockHubble.placeOrder.mockResolvedValue({ status: 'PROCESSING', id: 'hub-1', vouchers: [] });
        mockPrisma.redemptionOrder.updateMany.mockResolvedValueOnce({ count: 0 });
        await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');
        const claim = mockPrisma.redemptionOrder.updateMany.mock.calls[0][0];
        // The place-attempt evidence writes are CAS'd on the loaded version (`at`) and stamp a known
        // new version; the PROCESSING claim pins THAT version (our own writes must not make it lose).
        const evidence = mockPrisma.redemptionOrder.update.mock.calls.slice(0, 2).map((c) => c[0]);
        expect(evidence[0].where).toMatchObject({ id: 'o1', updatedAt: at });
        expect(evidence[1].where).toMatchObject({ id: 'o1', updatedAt: evidence[0].data.updatedAt });
        expect(claim.where).toMatchObject({ status: 'CONFIRMED', updatedAt: evidence[1].data.updatedAt, OR: [{ voucherCode: null }, { voucherCode: '' }] });
        expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
        const flag = mockPrisma.redemptionOrder.update.mock.calls.at(-1)![0];
        expect(flag.data.metadata).toMatchObject({ hubbleReconcileReason: 'HUBBLE_PROCESSING_CLAIM_LOST' });
      });

      it('D1: SUCCESS writes ONE DELIVERED history row (fromStatus null) via the shared transition', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockHubble.placeOrder.mockResolvedValue({
          status: 'SUCCESS', id: 'hub-1', vouchers: [{ cardNumber: 'CARD-1', cardType: 'CARD_NUMBER_SECURED' }],
        });
        await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');
        expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledTimes(1);
        expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledWith({
          data: { orderId: 'o1', fromStatus: null, toStatus: 'DELIVERED', changedById: 'actor1', notes: 'Hubble voucher issued' },
        });
      });

      it('D1: SUCCESS that loses the claim (already resolved) writes NO history row', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockHubble.placeOrder.mockResolvedValue({
          status: 'SUCCESS', id: 'hub-1', vouchers: [{ cardNumber: 'CARD-1', cardType: 'CARD_NUMBER_SECURED' }],
        });
        mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 0 });
        await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');
        expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
      });

      it('D1: FAILED refund path is unchanged (claim → reverse → guarded FAILED flip) and records ONE FAILED row', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockHubble.placeOrder.mockResolvedValue({ status: 'FAILED', failureReason: 'wallet empty' });
        await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');
        const nonTerminal = { in: ['CONFIRMED', 'PROCESSING', 'PENDING'] };
        expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
          where: { id: 'o1', pointsDeducted: { gt: 0 }, status: nonTerminal, OR: [{ voucherCode: null }, { voucherCode: '' }] },
          data: { pointsDeducted: 0 },
        });
        expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
        expect(mockWallet.reverse).toHaveBeenCalledWith(
          'cp1', 1000, { referenceId: 'o1', description: 'Refund RDM-x (Hubble failed)' }, mockPrisma,
        );
        expect(mockPrisma.redemptionOrder.updateMany).toHaveBeenCalledWith({
          where: { id: 'o1', status: nonTerminal, OR: [{ voucherCode: null }, { voucherCode: '' }] },
          data: {
            status: 'FAILED',
            valuePaise: 0n,
            voucherProvider: 'Hubble',
            cancelReason: 'wallet empty',
            notes: 'Hubble issuance failed: wallet empty',
            // Stamped as refunded-on-Hubble (late webhooks re-checked) + any open flag closed.
            metadata: expect.objectContaining({
              hubbleNeedsReconcile: false,
              hubbleReconcileResolution: 'FAILED_REFUNDED',
              hubbleRefund: expect.objectContaining({ reason: 'wallet empty', by: 'actor1', source: 'HUBBLE_FAILED' }),
            }),
          },
        });
        expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledTimes(1);
        expect(mockPrisma.redemptionStatusHistory.create).toHaveBeenCalledWith({
          data: {
            orderId: 'o1', fromStatus: null, toStatus: 'FAILED', changedById: 'actor1',
            notes: 'Hubble failed — points refunded: wallet empty',
          },
        });
      });

      it('D1: a FAILED flip that matches no row (order already terminal) no longer writes a stray FAILED history row', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockHubble.placeOrder.mockResolvedValue({ status: 'FAILED', failureReason: 'wallet empty' });
        mockPrisma.redemptionOrder.updateMany.mockResolvedValue({ count: 0 }); // refund claim + flip both lose
        await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');
        expect(mockWallet.reverse).not.toHaveBeenCalled();
        expect(mockPrisma.redemptionStatusHistory.create).not.toHaveBeenCalled();
      });

      it('not configured → leaves the order for ops (pending), never refunds', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder());
        mockHubble.isConfigured.mockReturnValue(false);
        const out = await service.issueHubbleVoucherForOrder('o1', 'deoleo', 'actor1');
        expect(out).toBe('PENDING_RECONCILE');
        expect(mockHubble.placeOrder).not.toHaveBeenCalled();
        expect(mockWallet.reverse).not.toHaveBeenCalled();
      });
    });

    describe('reconcileHubbleOrder (webhook)', () => {
      it('fetches authoritative state by reference and completes a PROCESSING order to DELIVERED', async () => {
        mockPrisma.client.findFirst.mockResolvedValue({ features: { hubbleVoucherEnabled: true } });
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder({ status: 'PROCESSING' }));
        mockHubble.getOrderByReference.mockResolvedValue({
          status: 'SUCCESS',
          id: 'hub-1',
          vouchers: [{ cardNumber: 'CARD-7', cardType: 'CARD_NUMBER_SECURED' }],
        });

        const out = await service.reconcileHubbleOrder('o1');

        expect(out).toBe('DELIVERED');
        // Webhook NEVER places a new order — it only reconciles.
        expect(mockHubble.placeOrder).not.toHaveBeenCalled();
        expect(mockHubble.getOrderByReference).toHaveBeenCalledWith('o1');
      });

      it('reconcile FAILED → refunds the points idempotently', async () => {
        mockPrisma.client.findFirst.mockResolvedValue({ features: { hubbleVoucherEnabled: true } });
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder({ status: 'PROCESSING' }));
        mockHubble.getOrderByReference.mockResolvedValue({ status: 'FAILED', failureReason: 'expired' });

        const out = await service.reconcileHubbleOrder('o1');

        expect(out).toBe('FAILED_REFUNDED');
        expect(mockWallet.reverse).toHaveBeenCalled();
      });

      // AUDIT-FIX (Lane B #2): reconcile re-asserts eligibility, so it must NOT touch a
      // flag-off / non-GIFT_CARD order even if Hubble holds a record for that reference.
      it('SKIPS a flag-OFF tenant order (no apply, no refund) even if Hubble returns SUCCESS', async () => {
        mockPrisma.client.findFirst.mockResolvedValue({ features: {} }); // flag OFF
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(loadedOrder({ status: 'PROCESSING' }));
        mockHubble.getOrderByReference.mockResolvedValue({
          status: 'SUCCESS',
          vouchers: [{ cardNumber: 'CARD-X', cardType: 'CARD_NUMBER_SECURED' }],
        });

        const out = await service.reconcileHubbleOrder('o1');

        expect(out).toBe('SKIPPED');
        expect(mockHubble.getOrderByReference).not.toHaveBeenCalled();
        expect(mockWallet.reverse).not.toHaveBeenCalled();
      });

      it('SKIPS a non-GIFT_CARD order (cash) without reading Hubble', async () => {
        mockPrisma.client.findFirst.mockResolvedValue({ features: { hubbleVoucherEnabled: true } });
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(
          loadedOrder({ status: 'PROCESSING', redemptionMode: 'BANK_TRANSFER' }),
        );

        const out = await service.reconcileHubbleOrder('o1');

        expect(out).toBe('SKIPPED');
        expect(mockHubble.getOrderByReference).not.toHaveBeenCalled();
        expect(mockWallet.reverse).not.toHaveBeenCalled();
      });

      it('unknown referenceId → SKIPPED (no throw)', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
        const out = await service.reconcileHubbleOrder('nope');
        expect(out).toBe('SKIPPED');
      });
    });

    describe('confirm wiring + flag/eligibility gating', () => {
      const giftCardPending = {
        id: 'o1', status: 'PENDING', partnerId: 'cp1', orderNumber: 'RDM-x',
        totalPointsCost: 1000, quantity: 1, redemptionMode: 'GIFT_CARD',
        partner: { id: 'cp1', userId: 'user1', isActive: true, deletedAt: null, phone: '9', ownerName: 'O', kycSubmissions: [{ status: 'APPROVED' }] },
        reward: { name: 'Amazon ₹500', stockQuantity: null, metadata: { hubbleProductId: 'amz-1' } },
      };
      // Factory (NOT a shared const): compute expiresAt at TEST-RUN time, not when Jest
      // builds the describe tree. A describe-scope `new Date(Date.now()+60000)` is fixed at
      // build time and lapses if the full suite takes >60s to reach these tests (flake).
      const validOtp = () => ({ id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 3_600_000) });

      it('flag ON + GIFT_CARD with productId → issues the voucher (placeOrder called, status DELIVERED)', async () => {
        // 1st findFirst = confirm load (PENDING); 2nd = loadHubbleOrder (CONFIRMED + value).
        mockPrisma.redemptionOrder.findFirst
          .mockResolvedValueOnce(giftCardPending)
          .mockResolvedValue(loadedOrder());
        mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp());
        mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
        mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CONFIRMED' });
        mockPrisma.client.findFirst.mockResolvedValue({ features: { hubbleVoucherEnabled: true } });
        mockHubble.placeOrder.mockResolvedValue({
          status: 'SUCCESS', id: 'hub-1',
          vouchers: [{ cardNumber: 'CARD-123', cardType: 'CARD_NUMBER_SECURED' }],
        });

        const res = await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });

        expect(mockWallet.debitRedeem).toHaveBeenCalled(); // debit still happens first
        expect(mockHubble.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ referenceId: 'o1', productId: 'amz-1' }));
        expect(res.status).toBe('DELIVERED');
      });

      it('flag OFF → byte-identical manual path (NO placeOrder, status CONFIRMED)', async () => {
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(giftCardPending);
        mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp());
        mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
        mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CONFIRMED' });
        mockPrisma.client.findFirst.mockResolvedValue({ features: {} }); // flag OFF

        const res = await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });

        expect(mockHubble.placeOrder).not.toHaveBeenCalled();
        expect(res.status).toBe('CONFIRMED');
      });

      it('non-Hubble GIFT_CARD (no productId) → short-circuits BEFORE the flag read (byte-identical)', async () => {
        const noProductId = { ...giftCardPending, reward: { name: 'Amazon ₹500', stockQuantity: null, metadata: {} } };
        mockPrisma.redemptionOrder.findFirst.mockResolvedValue(noProductId);
        mockPrisma.otpCode.findFirst.mockResolvedValue(validOtp());
        mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 5000 });
        mockPrisma.redemptionOrder.update.mockResolvedValue({ id: 'o1', status: 'CONFIRMED' });
        mockPrisma.client.findFirst.mockResolvedValue({ features: { hubbleVoucherEnabled: true } });

        const res = await service.confirmRedeem(partner, { orderId: 'o1', otp: '123456' });

        expect(mockHubble.placeOrder).not.toHaveBeenCalled();
        // Eligibility short-circuits on the missing productId → the tenant flag is never read.
        expect(mockPrisma.client.findFirst).not.toHaveBeenCalled();
        expect(res.status).toBe('CONFIRMED');
      });
    });
  });

  // ── Persistent partner wishlist ───────────────────────────────────────────────
  describe('wishlist', () => {
    // resolveActive → resolveActivePartnerId reads channelPartner.findFirst for the
    // login's OWN partner. Default: partner `user1` owns `cpA` (ungrouped).
    beforeEach(() => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cpA', groupId: null });
      mockPrisma.partnerWishlist.upsert.mockResolvedValue({ id: 'w1' });
      mockPrisma.partnerWishlist.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.partnerWishlist.findMany.mockResolvedValue([]);
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'r1' });
    });

    it('add → list shows it; delete → list no longer shows it', async () => {
      // ADD
      const added = await service.addToWishlist(partner, 'r1');
      expect(added).toEqual({ success: true, wishlisted: true, rewardId: 'r1' });
      expect(mockPrisma.partnerWishlist.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { partnerId_rewardId: { partnerId: 'cpA', rewardId: 'r1' } },
          create: { clientId: 'deoleo', partnerId: 'cpA', rewardId: 'r1' },
          update: {},
        }),
      );

      // LIST — reward is projected member-safe + the category flattened to a label.
      mockPrisma.partnerWishlist.findMany.mockResolvedValue([
        {
          rewardId: 'r1',
          createdAt: new Date('2026-02-01'),
          reward: { id: 'r1', name: 'Gift Card', pointsCost: 50, category: { name: 'Vouchers' } },
        },
      ]);
      const list = await service.getWishlist(partner);
      expect(list.rewardIds).toEqual(['r1']);
      expect(list.items[0]).toMatchObject({ id: 'r1', name: 'Gift Card', category: 'Vouchers' });
      expect(mockPrisma.partnerWishlist.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ partnerId: 'cpA', clientId: 'deoleo' }),
        }),
      );

      // DELETE
      const removed = await service.removeFromWishlist(partner, 'r1');
      expect(removed).toEqual({ success: true, wishlisted: false, rewardId: 'r1' });
      expect(mockPrisma.partnerWishlist.deleteMany).toHaveBeenCalledWith({
        where: { partnerId: 'cpA', rewardId: 'r1', clientId: 'deoleo' },
      });

      // LIST after delete → empty
      mockPrisma.partnerWishlist.findMany.mockResolvedValue([]);
      const after = await service.getWishlist(partner);
      expect(after.rewardIds).toEqual([]);
      expect(after.items).toEqual([]);
    });

    it('idempotent add (twice) → upsert no-op, success both times (single row by the unique constraint)', async () => {
      const a = await service.addToWishlist(partner, 'r1');
      const b = await service.addToWishlist(partner, 'r1');
      expect(a.wishlisted).toBe(true);
      expect(b.wishlisted).toBe(true);
      expect(mockPrisma.partnerWishlist.upsert).toHaveBeenCalledTimes(2);
      // Every call is an idempotent no-op update ({}), so a duplicate never creates a second row.
      expect(
        mockPrisma.partnerWishlist.upsert.mock.calls.every(
          (c) => Object.keys((c[0] as { update: object }).update).length === 0,
        ),
      ).toBe(true);
    });

    it('cross-tenant rewardId → rejected (404), nothing stored', async () => {
      // The reward does not exist under the caller's clientId.
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      await expect(service.addToWishlist(partner, 'foreign-reward')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // The lookup was tenant-scoped, and NO wishlist row was written.
      expect(mockPrisma.rewardCatalog.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'foreign-reward',
            clientId: 'deoleo',
            deletedAt: null,
          }),
        }),
      );
      expect(mockPrisma.partnerWishlist.upsert).not.toHaveBeenCalled();
    });

    it('scoping: a partner cannot read/act on another partner wishlist via x-active-partner-id', async () => {
      // Own partner is cpA (ungrouped) → a foreign active-partner selector is forbidden.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cpA', groupId: null });
      await expect(service.getWishlist(partner, 'cpB')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.addToWishlist(partner, 'r1', 'cpB')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      // Never read/wrote another partner's rows.
      expect(mockPrisma.partnerWishlist.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.partnerWishlist.upsert).not.toHaveBeenCalled();
    });

    // ── Member-visibility gates (security FIX 1) ───────────────────────────────
    // vendorVisibilityFilter(clientId) → the PLATFORM-or-active-granted-VENDOR OR clause.
    const VENDOR_VISIBILITY = {
      OR: [
        { sourceType: 'PLATFORM' },
        {
          sourceType: 'VENDOR',
          vendor: { is: { status: 'ACTIVE', grants: { some: { clientId: 'deoleo', status: 'ACTIVE' } } } },
        },
      ],
    };

    it('addToWishlist applies the FULL member-visibility filter (status/moderation/soft-delete/vendor)', async () => {
      await service.addToWishlist(partner, 'r1');
      expect(mockPrisma.rewardCatalog.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'r1',
            clientId: 'deoleo',
            deletedAt: null,
            status: 'ACTIVE',
            moderationStatus: 'APPROVED',
            ...VENDOR_VISIBILITY,
          }),
        }),
      );
    });

    it('getWishlist filters the reward relation by the SAME member-visibility gates', async () => {
      await service.getWishlist(partner);
      expect(mockPrisma.partnerWishlist.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            partnerId: 'cpA',
            clientId: 'deoleo',
            reward: {
              is: {
                deletedAt: null,
                status: 'ACTIVE',
                moderationStatus: 'APPROVED',
                ...VENDOR_VISIBILITY,
              },
            },
          },
        }),
      );
    });

    // A reward hidden by ANY catalogue gate — suspended-vendor / grant-revoked /
    // DISCONTINUED|INACTIVE status / PENDING|REJECTED moderation / soft-deleted — is
    // excluded by the member-visibility `where`, so the tenant-scoped findFirst returns
    // null. Each such case therefore collapses to "not found": the add is rejected and
    // (via the same relation filter) the row never appears in getWishlist.
    it.each([
      'suspended-vendor (vendorVisibilityFilter)',
      'DISCONTINUED / INACTIVE status',
      'PENDING / REJECTED moderation',
      'soft-deleted (deletedAt set)',
    ])('cannot add a reward hidden by: %s → 404, nothing stored', async (_gate) => {
      // The member-visibility where excludes it → findFirst resolves null.
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      await expect(service.addToWishlist(partner, 'hidden')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mockPrisma.partnerWishlist.upsert).not.toHaveBeenCalled();
    });

    it('a reward hidden by a gate does not appear in getWishlist (filtered out by the DB)', async () => {
      // The relation filter drops the hidden row → findMany returns only the visible one.
      mockPrisma.partnerWishlist.findMany.mockResolvedValue([
        {
          rewardId: 'visible1',
          createdAt: new Date('2026-02-02'),
          reward: { id: 'visible1', name: 'Live Gift', pointsCost: 40, category: { name: 'Vouchers' } },
        },
      ]);
      const res = await service.getWishlist(partner);
      expect(res.rewardIds).toEqual(['visible1']);
      expect(res.rewardIds).not.toContain('hidden');
      expect(res.items).toHaveLength(1);
    });

    it('flag ON: getWishlist computes slashPoints and strips mrpPaise/sellingValuePaise', async () => {
      mockPrisma.client.findFirst.mockResolvedValue({ features: { catalogueMrpSlash: true } });
      mockPrisma.partnerWishlist.findMany.mockResolvedValue([
        {
          rewardId: 'r1',
          createdAt: new Date('2026-02-02'),
          reward: {
            id: 'r1', name: 'Gift', pointsCost: 500, mrpPaise: 60000, sellingValuePaise: 50000,
            category: { name: 'Vouchers' },
          },
        },
      ]);
      const res = await service.getWishlist(partner);
      // Flag ON → the nested reward select pulls the cost basis transiently…
      const call = mockPrisma.partnerWishlist.findMany.mock.calls[0][0];
      expect(call.select.reward.select.mrpPaise).toBe(true);
      expect(call.select.reward.select.sellingValuePaise).toBe(true);
      expect(res.items[0].slashPoints).toBe(600);
      // …but neither cost-basis column reaches the member.
      expect(res.items[0]).not.toHaveProperty('mrpPaise');
      expect(res.items[0]).not.toHaveProperty('sellingValuePaise');
    });

    it('flag OFF (default): getWishlist emits no slashPoints and never selects the cost basis', async () => {
      mockPrisma.partnerWishlist.findMany.mockResolvedValue([
        {
          rewardId: 'r1',
          createdAt: new Date('2026-02-02'),
          reward: {
            id: 'r1', name: 'Gift', pointsCost: 500, mrpPaise: 60000, sellingValuePaise: 50000,
            category: { name: 'Vouchers' },
          },
        },
      ]);
      const res = await service.getWishlist(partner);
      const call = mockPrisma.partnerWishlist.findMany.mock.calls[0][0];
      expect(call.select.reward.select.mrpPaise).toBeUndefined();
      expect(call.select.reward.select.sellingValuePaise).toBeUndefined();
      expect(res.items[0]).not.toHaveProperty('slashPoints');
      expect(res.items[0]).not.toHaveProperty('mrpPaise');
      expect(res.items[0]).not.toHaveProperty('sellingValuePaise');
    });

    it('loyalty-OFF outlet type → add rejected (404) and getWishlist empty (no DB read of rows)', async () => {
      // Per-outlet-type Loyalty gate OFF for this outlet's type.
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletTypeId: 'ot1', outletType: { code: 'KIRANA' } });
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue({ loyaltyEnabled: false });

      await expect(service.addToWishlist(partner, 'r1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.partnerWishlist.upsert).not.toHaveBeenCalled();

      const res = await service.getWishlist(partner);
      expect(res).toEqual({ items: [], rewardIds: [] });
      expect(mockPrisma.partnerWishlist.findMany).not.toHaveBeenCalled();
    });

    it('remove a non-wishlisted reward → no-op success', async () => {
      mockPrisma.partnerWishlist.deleteMany.mockResolvedValue({ count: 0 });
      const res = await service.removeFromWishlist(partner, 'never-saved');
      expect(res).toEqual({ success: true, wishlisted: false, rewardId: 'never-saved' });
    });
  });
});

/**
 * Claim-before-compare (2026-11-10): simulate the OtpCode row's atomic conditional increment — the
 * ONLY serialisation point — so N parallel verifies that all READ attempts=0 can be exercised.
 */
function simulateOtpClaims(db: { $queryRaw: jest.Mock; otpCode: { updateMany: jest.Mock } }, maxAttempts = 3) {
  const state = { attempts: 0 };
  // The claim: ONE `UPDATE "otp_codes" … WHERE … "attempts" < $2 RETURNING "attempts"` (values [id, max]).
  db.$queryRaw.mockImplementation(async (q: any) => {
    if (!isOtpClaim(q)) return [];
    await new Promise((r) => setImmediate(r)); // interleave the parallel callers
    if (state.attempts < (q.values?.[1] ?? maxAttempts)) { state.attempts++; return [{ attempts: state.attempts }]; }
    return [];
  });
  db.otpCode.updateMany.mockImplementation(async ({ data }: any) => {
    await new Promise((r) => setImmediate(r));
    if (data?.attempts?.decrement) { if (state.attempts > 0) state.attempts--; return { count: 1 }; }
    return { count: 1 };
  });
  return state;
}

/** Is this $queryRaw call the OTP attempt claim (common/otp-attempt)? */
function isOtpClaim(q: any): boolean {
  return typeof q?.text === 'string' && q.text.includes('UPDATE "otp_codes"');
}

/** The OTP attempt claim is refused (cap spent / already verified); other raw queries keep [] rows. */
function refuseOtpClaims() {
  mockPrisma.$queryRaw.mockImplementation(async () => []);
}

/** redemptionOrder.findFirst: the first call returns `first`, every later call `rest` (double-tap re-read). */
function orderReads(first: unknown, rest: unknown) {
  let n = 0;
  mockPrisma.redemptionOrder.findFirst.mockImplementation(async () => (n++ === 0 ? first : rest));
}
