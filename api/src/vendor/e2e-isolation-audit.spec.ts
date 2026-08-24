/**
 * GIFT CATALOGUE & DISPATCH — ISOLATION / RBAC / VENDOR-LIFECYCLE audit lane.
 *
 * Whole-module adversarial regression suite (final gate across all 3 build waves).
 * Every test asserts a HARD isolation invariant from GIFT-CATALOGUE-AND-DISPATCH-DESIGN.md
 * (§2 isolation invariants, §12 review hardening) + the auditor's edge-case matrix.
 *
 * Known-defect cases are `it.skip`-marked with a `// BUG:` note and enumerated in the
 * audit report (section C) so the suite stays green while the gaps are tracked.
 *
 * Run: cd api && npx jest src/vendor/e2e-isolation-audit.spec.ts --no-coverage
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RedemptionStatus } from '@prisma/client';
import { VendorPortalService } from './vendor-portal.service';
import { GiftDisbursalService } from './gift-disbursal.service';
import { VendorAdminService } from './vendor-admin.service';
import { GiftCatalogueService } from '../gift-catalogue/gift-catalogue.service';
import { RewardsService } from '../rewards/rewards.service';
import { WalletService } from '../wallet/wallet.service';
import { Msg91Service } from '../notifications/msg91.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { assertVendorPriceBounds, VendorPriceError } from './vendor-pricing.helper';
import { vendorVisibilityFilter } from '../rewards/rewards.service';

// DEF-3 drives the REAL confirmRedeem through to its in-tx item re-check; stub the
// account dual-write helper (its own tests live in reward-account.helper.spec.ts) so
// the redeem path isn't coupled to its internal tx calls (mirrors rewards.service.spec).
jest.mock('../common/reward-account.helper', () => ({
  ensureOutletAccount: jest.fn().mockResolvedValue('acc-x'),
}));

// ── Shared Prisma mock ────────────────────────────────────────────────────────
const mockPrisma = {
  vendor: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  vendorTenantGrant: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  giftCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  rewardCategory: { findFirst: jest.fn(), create: jest.fn() },
  rewardCatalog: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  redemptionOrder: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  redemptionStatusHistory: { create: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
  otpCode: { findFirst: jest.fn(), update: jest.fn() },
  client: { findMany: jest.fn(), findFirst: jest.fn() },
  user: { findMany: jest.fn(), create: jest.fn() },
  auditLog: { create: jest.fn().mockResolvedValue({}) },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: jest.fn((fn: (tx: any) => unknown) => fn(mockPrisma)),
};
const mockTenantSettings = {
  getConversionRate: jest.fn(async () => 1),
  getEffectiveSettings: jest.fn(async () => ({ conversionRate: 1 })),
  getOtpTemplateId: jest.fn(async () => undefined),
};
const mockNotifications = { notifyUserWithChannels: jest.fn().mockResolvedValue(undefined) };
const mockWallet = { debitRedeem: jest.fn(), reverse: jest.fn() };
const mockMsg91 = { sendOtp: jest.fn().mockResolvedValue(undefined) };

// Vendor A pinned to tenant `deoleo`.
const vendorA: JwtPayload = { sub: 'vuA', role: 'VENDOR', clientId: 'deoleo', vendorId: 'vA', phone: '9990000001', name: 'A' };

function grantScopeActive(policy = 'GIFSY_APPROVE') {
  mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'vA', name: 'Acme', status: 'ACTIVE' });
  mockPrisma.vendorTenantGrant.findFirst.mockResolvedValue({ approvalPolicy: policy });
}

describe('Gift Catalogue & Dispatch — ISOLATION / RBAC / VENDOR-LIFECYCLE audit', () => {
  let portal: VendorPortalService;
  let disbursal: GiftDisbursalService;
  let vendorAdmin: VendorAdminService;
  let catalogue: GiftCatalogueService;
  let rewards: RewardsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenantSettings.getConversionRate.mockResolvedValue(1);
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        VendorPortalService,
        GiftDisbursalService,
        VendorAdminService,
        GiftCatalogueService,
        RewardsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: WalletService, useValue: mockWallet },
        { provide: Msg91Service, useValue: mockMsg91 },
      ],
    }).compile();
    portal = mod.get(VendorPortalService);
    disbursal = mod.get(GiftDisbursalService);
    vendorAdmin = mod.get(VendorAdminService);
    catalogue = mod.get(GiftCatalogueService);
    rewards = mod.get(RewardsService);
  });

  // ── ISO-1..4  Cross-vendor / cross-tenant hard scoping (vendor portal) ────────
  describe('vendor portal is HARD-scoped by vendorId AND clientId on every read/write', () => {
    it('ISO-1 getOrder: another vendor/tenant order is 404 (not a leak) + where carries the double scope', async () => {
      grantScopeActive();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null); // foreign id → no row
      await expect(portal.getOrder(vendorA, 'foreign-order')).rejects.toBeInstanceOf(NotFoundException);
      const where = mockPrisma.redemptionOrder.findFirst.mock.calls[0][0].where;
      expect(where.fulfilledByVendorId).toBe('vA');
      expect(where.partner).toEqual({ clientId: 'deoleo' });
      // PENDING (pre-payment) orders are hidden from the vendor.
      expect(where.status).toEqual({ not: RedemptionStatus.PENDING });
    });

    it('ISO-2 updateCatalogue: another vendor/tenant item is 404 + where carries vendorId+clientId+sourceType', async () => {
      grantScopeActive();
      mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
      await expect(
        portal.updateCatalogue(vendorA, 'foreign-item', { name: 'x' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      const where = mockPrisma.rewardCatalog.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ sourceType: 'VENDOR', vendorId: 'vA', clientId: 'deoleo', deletedAt: null });
    });

    it('ISO-3 updateFulfilment: another vendor/tenant order is 404 + double scope', async () => {
      grantScopeActive();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
      await expect(
        portal.updateFulfilment(vendorA, 'foreign-order', { trackingNumber: 'T' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      const where = mockPrisma.redemptionOrder.findFirst.mock.calls[0][0].where;
      expect(where.fulfilledByVendorId).toBe('vA');
      expect(where.partner).toEqual({ clientId: 'deoleo' });
    });

    it('ISO-4 listOrders/listCatalogue: queries always pin vendorId + clientId', async () => {
      grantScopeActive();
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.rewardCatalog.findMany.mockResolvedValue([]);
      await portal.listOrders(vendorA);
      await portal.listCatalogue(vendorA);
      const ordWhere = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
      expect(ordWhere.fulfilledByVendorId).toBe('vA');
      expect(ordWhere.partner).toEqual({ clientId: 'deoleo' });
      const catWhere = mockPrisma.rewardCatalog.findMany.mock.calls[0][0].where;
      expect(catWhere).toMatchObject({ sourceType: 'VENDOR', vendorId: 'vA', clientId: 'deoleo', deletedAt: null });
    });
  });

  // ── LIFE-1..3  Suspend / revoke lifecycle (portal side, immediate) ────────────
  describe('suspend/revoke takes effect immediately at the portal data boundary', () => {
    it('LIFE-1 suspended vendor is Forbidden on every request (independent of token TTL)', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'vA', name: 'Acme', status: 'SUSPENDED' });
      await expect(portal.listOrders(vendorA)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(portal.listCatalogue(vendorA)).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('LIFE-2 revoked grant (no ACTIVE grant for the pinned tenant) is Forbidden', async () => {
      mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'vA', name: 'Acme', status: 'ACTIVE' });
      mockPrisma.vendorTenantGrant.findFirst.mockResolvedValue(null);
      await expect(portal.listCatalogue(vendorA)).rejects.toBeInstanceOf(ForbiddenException);
      // grant lookup is pinned to the token's clientId + status ACTIVE (deny-by-default)
      const where = mockPrisma.vendorTenantGrant.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ vendorId: 'vA', clientId: 'deoleo', status: 'ACTIVE' });
    });
    it('LIFE-3 a VENDOR JWT missing vendorId cannot resolve a scope', async () => {
      const broken = { ...vendorA, vendorId: undefined } as JwtPayload;
      await expect(portal.listCatalogue(broken)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── TRAN-1..3  Vendor transition is wallet-FREE + forward-only ────────────────
  describe('vendor transition excludes every wallet-touching edge (review CRITICAL #4)', () => {
    function orderInState(status: RedemptionStatus) {
      grantScopeActive();
      mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', status, partnerId: 'p1', orderNumber: 'RDM-1' });
    }
    it('TRAN-1 CONFIRMED → CANCELLED is rejected (refund edge stays Gifsy-only)', async () => {
      orderInState(RedemptionStatus.CONFIRMED);
      await expect(
        portal.transition(vendorA, 'o1', { toStatus: 'CANCELLED' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
    it('TRAN-2 DISPATCHED → RETURNED is rejected (value-reversal stays Gifsy-only)', async () => {
      orderInState(RedemptionStatus.DISPATCHED);
      await expect(
        portal.transition(vendorA, 'o1', { toStatus: 'RETURNED' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('TRAN-3 a terminal (DELIVERED) order is immutable to the vendor', async () => {
      orderInState(RedemptionStatus.DELIVERED);
      await expect(
        portal.transition(vendorA, 'o1', { toStatus: 'PROCESSING' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('TRAN-4 illegal skip CONFIRMED → DELIVERED is rejected', async () => {
      orderInState(RedemptionStatus.CONFIRMED);
      await expect(
        portal.transition(vendorA, 'o1', { toStatus: 'DELIVERED' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── PRICE-1..4  Vendor price bounds enforced even under AUTO_LIVE ──────────────
  describe('vendor price bounds (enforced on every write incl. AUTO_LIVE — 194R integrity)', () => {
    it('PRICE-1 selling above MRP is rejected', () => {
      expect(() => assertVendorPriceBounds({ sellingValuePaise: 20000, mrpPaise: 10000 })).toThrow(VendorPriceError);
    });
    it('PRICE-2 MRP is required (missing → reject)', () => {
      expect(() => assertVendorPriceBounds({ sellingValuePaise: 5000, mrpPaise: null })).toThrow(VendorPriceError);
    });
    it('PRICE-3 selling below the ₹1 floor is rejected', () => {
      expect(() => assertVendorPriceBounds({ sellingValuePaise: 50, mrpPaise: 10000 })).toThrow(VendorPriceError);
    });
    it('PRICE-4 selling <= MRP and above floor is accepted', () => {
      expect(() => assertVendorPriceBounds({ sellingValuePaise: 9000, mrpPaise: 10000 })).not.toThrow();
    });
    it('PRICE-5 createCatalogue rejects an over-MRP price BEFORE any write', async () => {
      grantScopeActive('AUTO_LIVE'); // even auto-live enforces bounds
      await expect(
        portal.createCatalogue(vendorA, {
          name: 'G', sellingValuePaise: 20000, mrpPaise: 10000, categoryId: 'c1', redemptionMode: 'PHYSICAL_GIFT',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.rewardCatalog.create).not.toHaveBeenCalled();
    });
  });

  // ── VIS-1..3  Member-catalogue vendor visibility cascade ──────────────────────
  describe('vendorVisibilityFilter (member reads/redeem) — the suspend/revoke cascade', () => {
    it('VIS-1 PLATFORM rows are always visible', () => {
      const f = vendorVisibilityFilter('deoleo');
      expect(f.OR).toEqual(
        expect.arrayContaining([expect.objectContaining({ sourceType: 'PLATFORM' })]),
      );
    });
    it('VIS-2 VENDOR rows require vendor ACTIVE + an ACTIVE grant for THIS tenant', () => {
      const f = vendorVisibilityFilter('deoleo');
      const vendorBranch = (f.OR as Array<Record<string, unknown>>).find((b) => b.sourceType === 'VENDOR');
      expect(vendorBranch).toMatchObject({
        vendor: { is: { status: 'ACTIVE', grants: { some: { clientId: 'deoleo', status: 'ACTIVE' } } } },
      });
    });
    it('VIS-3 the grant predicate is pinned to the querying tenant (no cross-tenant grant satisfies it)', () => {
      const f = vendorVisibilityFilter('tenantX');
      const vendorBranch = (f.OR as Array<Record<string, unknown>>).find((b) => b.sourceType === 'VENDOR') as any;
      expect(vendorBranch.vendor.is.grants.some.clientId).toBe('tenantX');
    });
  });

  // ── RPT-1..2  Gift Disbursal report — tenant force-scoping ────────────────────
  describe('gift disbursal report force-scopes a CLIENT_ADMIN to their own tenant', () => {
    const clientAdminX: JwtPayload = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'tenantX', phone: '9', name: '' };

    beforeEach(() => {
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
      mockPrisma.client.findMany.mockResolvedValue([]);
      mockPrisma.vendor.findMany.mockResolvedValue([]);
    });

    it('RPT-1 a foreign ?clientId is IGNORED — the query pins the caller tenant', async () => {
      await disbursal.report(clientAdminX, { clientId: 'tenantY' } as never);
      const where = mockPrisma.redemptionOrder.findMany.mock.calls[0][0].where;
      expect(where.partner).toEqual({ clientId: 'tenantX' }); // NOT tenantY
    });

    it('RPT-2 a non-operator, non-CLIENT_ADMIN role is Forbidden', async () => {
      const sales: JwtPayload = { sub: 's', role: 'SSS', clientId: 'tenantX', phone: '9', name: '' };
      await expect(disbursal.report(sales, {} as never)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // REGRESSION LOCKS — former known defects (DEF-1/2/3), now FIXED in source. These
  // assert the FIX and fail loudly if it ever regresses.
  // ══════════════════════════════════════════════════════════════════════════════

  // DEF-1 (was HIGH): VendorAdminService WRITE methods gated on `assertOperator`
  // (GIFSY_ADMIN *or* GIFSY_STAFF). A scoped/assumed GIFSY_STAFF could create vendors,
  // grant ANY tenant, create logins, suspend and revoke — platform-wide. FIXED: the write
  // methods now call `assertOwner` (GIFSY_ADMIN only → 'Vendor administration is owner-only').
  it('DEF-1 createVendor/createGrant reject a GIFSY_STAFF (owner-only); a GIFSY_ADMIN proceeds', async () => {
    const staff: JwtPayload = { sub: 'st1', role: 'GIFSY_STAFF', clientId: 'deoleo', assumed: true, phone: '9', name: 'S' };
    const owner: JwtPayload = { sub: 'ad1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9', name: 'A' };

    // A scoped/assumed GIFSY_STAFF is rejected BEFORE any write (assertOwner is line 1).
    await expect(
      vendorAdmin.createVendor(staff, { name: 'Acme' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      vendorAdmin.createGrant(staff, 'vA', { clientId: 'deoleo', approvalPolicy: 'GIFSY_APPROVE' } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.vendor.create).not.toHaveBeenCalled();
    expect(mockPrisma.vendorTenantGrant.create).not.toHaveBeenCalled();

    // The OWNER proceeds — the vendor write goes through.
    mockPrisma.vendor.create.mockResolvedValue({ id: 'vNew', name: 'Acme', status: 'ACTIVE' });
    const createdVendor = await vendorAdmin.createVendor(owner, { name: 'Acme' } as never);
    expect(createdVendor).toMatchObject({ id: 'vNew' });
    expect(mockPrisma.vendor.create).toHaveBeenCalledTimes(1);

    // The OWNER also reaches the grant write (new-grant path).
    mockPrisma.vendor.findFirst.mockResolvedValue({ id: 'vA', status: 'ACTIVE' });
    mockPrisma.client.findFirst.mockResolvedValue({ id: 'deoleo' });
    mockPrisma.vendorTenantGrant.findUnique.mockResolvedValue(null);
    mockPrisma.vendorTenantGrant.create.mockResolvedValue({ id: 'gNew', status: 'ACTIVE' });
    const grant = await vendorAdmin.createGrant(
      owner, 'vA', { clientId: 'deoleo', approvalPolicy: 'GIFSY_APPROVE' } as never,
    );
    expect(grant).toMatchObject({ id: 'gNew' });
    expect(mockPrisma.vendorTenantGrant.create).toHaveBeenCalledTimes(1);
  });

  // DEF-2 (was HIGH): GiftCatalogueService.approveModeration did NOT scope by
  // tenantScope(user), so an assumed GIFSY_STAFF pinned to tenant X could approve a PENDING
  // item belonging to tenant Y. FIXED: the findFirst is now scoped by tenantScope(user)
  // (undefined = platform-wide owner → sees all; a scoped/assumed operator → 404 on a
  // foreign-tenant item).
  it('DEF-2 approveModeration is tenant-scoped for an assumed operator (foreign item → 404); un-assumed owner is unscoped', async () => {
    const assumedStaff: JwtPayload = { sub: 'st1', role: 'GIFSY_STAFF', clientId: 'deoleo', assumed: true, phone: '9', name: 'S' };
    // Scoped lookup: the where carries clientId:'deoleo', so tenantY's item never matches
    // → resolves null → NotFound (no cross-tenant moderation).
    mockPrisma.rewardCatalog.findFirst.mockResolvedValueOnce(null);
    await expect(
      catalogue.approveModeration(assumedStaff, 'item-tenantY'),
    ).rejects.toBeInstanceOf(NotFoundException);
    const scopedWhere = mockPrisma.rewardCatalog.findFirst.mock.calls[0][0].where;
    expect(scopedWhere.clientId).toBe('deoleo');
    expect(mockPrisma.rewardCatalog.update).not.toHaveBeenCalled();

    // Un-assumed OWNER (platform-wide): the lookup carries NO clientId, so it can moderate
    // any tenant's item.
    const owner: JwtPayload = { sub: 'ad1', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '9', name: 'A' };
    mockPrisma.rewardCatalog.findFirst.mockResolvedValueOnce({ id: 'item-tenantY', clientId: 'tenantY' });
    mockPrisma.rewardCatalog.update.mockResolvedValueOnce({ id: 'item-tenantY', moderationStatus: 'APPROVED' });
    const res = await catalogue.approveModeration(owner, 'item-tenantY');
    expect(res).toMatchObject({ moderationStatus: 'APPROVED' });
    const ownerWhere = mockPrisma.rewardCatalog.findFirst.mock.calls[1][0].where;
    expect('clientId' in ownerWhere).toBe(false);
  });

  // DEF-3 (was MED): confirmRedeem did NOT re-validate moderationStatus='APPROVED' +
  // vendorVisibilityFilter at confirm time — an item rejected / vendor suspended / grant
  // revoked between redeem and OTP-confirm still debited the member. FIXED: the confirm tx
  // re-loads the item with the same redeem-time filter and aborts (BadRequest, no debit) if
  // it no longer resolves. Driven through the REAL RewardsService.confirmRedeem to the in-tx
  // re-check (the level the service specs use); the sibling confirmRedeemForOutlet mirrors it.
  it('DEF-3 confirmRedeem re-checks item availability in-tx: a now-unreachable item → 400 and NO debit', async () => {
    const member: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '9990000009', name: 'M' };
    const approvedKyc = [{ id: 'ks', status: 'APPROVED', createdAt: new Date(), updatedAt: new Date() }];
    // resolveActive (own partner: id/groupId) + the in-tx fresh-partner payable re-check
    // (isActive/deletedAt/kyc) share this single mock — return a shape satisfying both.
    mockPrisma.channelPartner.findFirst.mockResolvedValue({
      id: 'cp1', groupId: null, isActive: true, deletedAt: null, kycSubmissions: approvedKyc,
    });
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
      id: 'o1', status: 'PENDING', partnerId: 'cp1', orderNumber: 'RDM-1',
      rewardId: 'ry', totalPointsCost: 100, quantity: 1, redemptionMode: 'PHYSICAL_GIFT',
      conversionRateCenti: 100, metadata: { sellingValuePaiseSnapshot: 50000 },
      reward: { name: 'TV', stockQuantity: null, sellingValuePaise: 50000 },
      partner: {
        id: 'cp1', userId: 'user1', isActive: true, deletedAt: null, phone: '9', ownerName: 'O',
        bankAccountNumber: null, ifscCode: null, upiId: null, kycSubmissions: approvedKyc,
      },
    });
    mockPrisma.otpCode.findFirst.mockResolvedValue({
      id: 'otp1', code: '123456', attempts: 0, maxAttempts: 3, expiresAt: new Date(Date.now() + 60000),
    });
    // The in-tx re-load (moderationStatus:'APPROVED' + vendorVisibilityFilter) resolves null
    // — the item was rejected / its vendor suspended after redeem, before this confirm.
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);

    await expect(
      rewards.confirmRedeem(member, { orderId: 'o1', otp: '123456' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The re-check ran with the confirm-time availability filter and blocked the debit.
    const reWhere = mockPrisma.rewardCatalog.findFirst.mock.calls[0][0].where;
    expect(reWhere).toMatchObject({
      id: 'ry', status: 'ACTIVE', deletedAt: null, clientId: 'deoleo', moderationStatus: 'APPROVED',
    });
    expect(reWhere.OR).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceType: 'PLATFORM' })]),
    );
    expect(mockWallet.debitRedeem).not.toHaveBeenCalled();
  });
});
