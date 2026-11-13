// Unit tests for PartnerService.
// Covers tenant + caller scoping on each ported partner self-service read:
//   banners (ProgramSetting), payouts (ChannelPartner → PayoutTransaction),
//   targets (OutletTarget + OutletSalesRecord — P4.5 rewire; SchemeTarget removed).
// The invoices route was skipped (in-memory mock).
// Run: npx jest src/partner/partner.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { PartnerService } from './partner.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { StorageService } from '../storage/storage.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

// ─── Mock Prisma ───────────────────────────────────────────────────────────────

const mockPrisma = {
  programSetting:    { findFirst: jest.fn() },
  // findMany added for Wave 3 resolveOperableContexts (login-less same-group sibling lookup).
  // update added for capturePayoutDetails (capture-bank-at-redemption write).
  channelPartner:    { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  payoutTransaction: { findMany: jest.fn(), findFirst: jest.fn() },
  creditPayoutEntry: { findFirst: jest.fn(), findMany: jest.fn() },
  wallet:            { findFirst: jest.fn() },
  pointsLedger:      { findFirst: jest.fn() },
  // outlet.findFirst + outletTypeClientConfig added for the per-outlet-type Loyalty gate
  // (isLoyaltyEnabledForPartner). Defaulted in beforeEach so existing tests default loyalty ON.
  outlet:            { findMany: jest.fn(), findFirst: jest.fn() },
  outletTypeClientConfig: { findUnique: jest.fn() },
  outletTarget:      { findFirst: jest.fn(), findMany: jest.fn() },
  outletSalesRecord: { findMany: jest.fn() },
  kpiDef:            { findMany: jest.fn() },
  salesUserAssignment: { findMany: jest.fn() },
  // capturePayoutDetails runs its partner row-lock (SELECT … FOR UPDATE via $queryRaw), uniqueness
  // check + write inside an interactive tx; the tx client reuses the same mocks (shared so call ORDER
  // across the row lock and the advisory identity locks ($executeRaw) is observable).
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn({ ...mockPrisma })),
};

// The ROW-LOCKED partner payout row the capture's SELECT … FOR UPDATE returns (primed by primePartner,
// overridable per test to simulate a concurrent commit between the unlocked gate read and the lock).
let lockedPartnerRow: Record<string, unknown> | null = null;

// TenantSettingsService.getEffectiveSettings — capture reads salesApp.upiEnabled + uniquenessPolicy.
const mockTenantSettings = {
  getEffectiveSettings: jest.fn(),
};
// StorageService — partner cheque upload (uploadPayoutDocument).
const mockStorage = {
  generateKey: jest.fn((folder: string, name: string) => `${folder}/${name}`),
  uploadFile: jest.fn(async () => 'https://storage.example/obj'),
};

// TenantService.resolveClient feeds the DB-backed feature blob into /partner/me
// (§A-DOMAIN "P5"). Default to a representative Deoleo-shaped blob.
const TENANT_FEATURES = {
  walletModule: true,
  visibilityInvoiceModule: true,
  partnerApp: { showLeaderboard: false, showWallet: true },
};
const mockTenant = {
  resolveClient: jest.fn(),
};

const partner: JwtPayload = {
  sub: 'user1',
  role: 'RETAILER',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

// A login WITH a real phone — Wave 3 outlet-switching requires a valid 10-digit phone (the operable
// set is same-group + same-phone), so switch/forbidden fixtures use this one.
const switcher: JwtPayload = {
  sub: 'user1',
  role: 'RETAILER',
  clientId: 'deoleo',
  phone: '9800000001',
  name: '',
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('PartnerService', () => {
  let service: PartnerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // getTargets now also fetches KpiDef labels (for the name-override fallback);
    // default to an empty KPI set so existing target tests are unaffected.
    mockPrisma.kpiDef.findMany.mockResolvedValue([]);
    mockTenant.resolveClient.mockResolvedValue({ features: TENANT_FEATURES });
    // Per-outlet-type Loyalty gate defaults: no primary outlet resolved + no config row →
    // isLoyaltyEnabledForPartner returns true (schema default). Loyalty-off cases override.
    mockPrisma.outlet.findFirst.mockResolvedValue(null);
    mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue(null);
    // Capture defaults: UPI enabled, bank+UPI uniqueness ON (Bajaj-shaped), clean uniqueness check.
    mockTenantSettings.getEffectiveSettings.mockResolvedValue({
      salesApp: { upiEnabled: true },
      uniquenessPolicy: { gst: true, phone: true, bank: true, upi: true },
    });
    mockPrisma.channelPartner.findMany.mockResolvedValue([]); // no uniqueness clash by default
    lockedPartnerRow = null;
    mockPrisma.$queryRaw.mockImplementation(async () => (lockedPartnerRow ? [lockedPartnerRow] : []));
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ ...mockPrisma }));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: StorageService, useValue: mockStorage },
      ],
    }).compile();
    service = module.get(PartnerService);
  });

  // ─── getMe (identity + presence-based points/payout signals) ──────────────────

  describe('getMe', () => {
    it('returns null identity + false activity flags when the caller has no channel partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      const res = await service.getMe(partner);
      expect(res).toEqual({
        businessName: null,
        outletName: null,
        ownerName: null,
        partnerCode: null,
        phone: null,
        email: null,
        entityType: null,
        outletType: null,
        hasPointsActivity: false,
        hasPayoutActivity: false,
        // New per-outlet-type Loyalty gate: defaults true for a partner-less login (schema default).
        loyaltyEnabled: true,
        features: TENANT_FEATURES,
        // Wave 3 picker payload: no active partner + empty operable set + no group overview for a partner-less login.
        activePartnerId: null,
        activeSelectorInvalid: false,
        operableOutlets: [],
        groupOverviewAvailable: false,
        groupParent: null,
        // Delivery-address pre-fill: nothing to pre-fill without an active partner/outlet.
        deliveryDefaults: null,
      });
      // No activity queries when there is no partner to resolve.
      expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
    });

    // ── Wave 3 login picker ──────────────────────────────────────────────────────
    it('includes the login-picker payload: operableOutlets (own-first) + groupOverviewAvailable + groupParent', async () => {
      // own login in group g1, one login-less same-phone sibling, and a parent carrying the login's phone.
      mockPrisma.channelPartner.findFirst.mockImplementation((args: any) => {
        const w = args.where;
        if (w.isParent === true) return Promise.resolve({ id: 'parent1', businessName: 'Parent Co', ownerName: 'Owner P' });
        if (w.userId) return Promise.resolve({
          id: 'cp1', partnerCode: 'P1', businessName: 'My Shop', ownerName: 'Me',
          phone: '9800000001', email: null, entityType: 'FIRM', groupId: 'g1', isParent: false,
          outlets: [{ id: 'o1', outletCode: 'OC1', name: 'My Shop', isPrimary: true, createdAt: new Date() }],
        });
        // display-load by id (the active/own partner)
        return Promise.resolve({
          id: 'cp1', partnerCode: 'P1', businessName: 'My Shop', ownerName: 'Me',
          phone: '9800000001', email: null, entityType: 'FIRM',
        });
      });
      mockPrisma.channelPartner.findMany.mockResolvedValue([
        { id: 'sib1', businessName: 'Sibling Shop', ownerName: 'Me',
          outlets: [{ id: 'o2', outletCode: 'OC2', name: 'Sibling Shop', isPrimary: true, createdAt: new Date() }] },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.creditPayoutEntry.findFirst.mockResolvedValue(null);
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue(null);

      const res = await service.getMe(switcher);

      expect(res.businessName).toBe('My Shop');       // display = active (own) outlet, no selector
      expect(res.operableOutlets).toHaveLength(2);
      expect(res.operableOutlets[0]).toMatchObject({ partnerId: 'cp1', isOwnLogin: true });   // own-first
      expect(res.operableOutlets[1]).toMatchObject({ partnerId: 'sib1', outletCode: 'OC2', isOwnLogin: false });
      expect(res.groupOverviewAvailable).toBe(true);
      expect(res.groupParent).toMatchObject({ parentId: 'parent1' });
    });

    it('reflects the SWITCHED sibling identity when a valid x-active-partner-id selector is supplied', async () => {
      mockPrisma.channelPartner.findFirst.mockImplementation((args: any) => {
        const w = args.where;
        if (w.isParent === true) return Promise.resolve(null);                 // no parent overview
        if (w.userId) return Promise.resolve({ id: 'cp1', groupId: 'g1', isParent: false,
          businessName: 'My Shop', ownerName: 'Me', outlets: [] });            // own (auth + operable own)
        // where.id → the sibling authorization lookup AND the display-load both resolve the sibling.
        return Promise.resolve({ id: 'sib1', partnerCode: 'P2', businessName: 'Sibling Shop',
          ownerName: 'Me', phone: '9800000001', email: null, entityType: 'FIRM' });
      });
      mockPrisma.channelPartner.findMany.mockResolvedValue([]);
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.creditPayoutEntry.findFirst.mockResolvedValue(null);
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue(null);

      const res = await service.getMe(switcher, 'sib1');
      expect(res.businessName).toBe('Sibling Shop');   // display reflects the switched-to outlet
      expect(res.activeSelectorInvalid).toBe(false);   // a valid selector is not flagged invalid
    });

    // AUDIT FIX (HIGH): getMe drives the WHOLE partner shell — an invalid/forbidden selector (a stale
    // or foreign cookie, e.g. on a shared device) must DEGRADE to the login's own identity, NOT 403
    // the entire portal. Only the money/read endpoints stay fail-closed. The FE clears the stale
    // cookie when it sees activeSelectorInvalid:true.
    it('degrades to OWN identity + activeSelectorInvalid:true for a forbidden selector (never 403s the shell)', async () => {
      mockPrisma.channelPartner.findFirst.mockImplementation((args: any) => {
        const w = args.where;
        if (w.isParent === true) return Promise.resolve(null);                 // no parent overview
        if (w.userId) return Promise.resolve({ id: 'cp1', groupId: null, isParent: false,
          businessName: 'My Shop', ownerName: 'Me', outlets: [] });            // own (operable + auth); ungrouped
        // display-load by the OWN id (degrade target)
        return Promise.resolve({ id: 'cp1', partnerCode: 'P1', businessName: 'My Shop',
          ownerName: 'Me', phone: '9800000001', email: null, entityType: 'FIRM' });
      });
      mockPrisma.channelPartner.findMany.mockResolvedValue([]);
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.creditPayoutEntry.findFirst.mockResolvedValue(null);
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue(null);

      const res = await service.getMe(switcher, 'evil'); // forged/foreign selector — must NOT throw
      expect(res.businessName).toBe('My Shop');          // degraded to own identity
      expect(res.activePartnerId).toBe('cp1');           // fell back to own partner
      expect(res.activeSelectorInvalid).toBe(true);
    });

    it('returns the DB-backed tenant feature blob (resolveClient) on /partner/me', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      const res = await service.getMe(partner);
      expect(mockTenant.resolveClient).toHaveBeenCalledWith('deoleo');
      expect(res.features).toEqual(TENANT_FEATURES);
    });

    it('features falls back to {} when tenant resolution throws (never 500s /me)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      mockTenant.resolveClient.mockRejectedValueOnce(new Error('inactive client'));
      const res = await service.getMe(partner);
      expect(res.features).toEqual({});
    });

    it('resolves the PRIMARY outlet type (order by isPrimary desc, createdAt asc — not isPrimary:true)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', businessName: 'Firm', ownerName: 'Owner', partnerCode: 'P1' });
      mockPrisma.outlet.findMany.mockResolvedValue([
        { id: 'o1', name: 'Primary Outlet', outletType: { code: 'WHOLESALER' } },
        { id: 'o2', name: 'Second Outlet', outletType: { code: 'SSS' } },
      ]);
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.creditPayoutEntry.findFirst.mockResolvedValue(null);
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue(null);

      const res = await service.getMe(partner);

      expect(mockPrisma.outlet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clientId: 'deoleo', partnerId: 'cp1', deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        }),
      );
      expect(res.outletType).toBe('WHOLESALER');
      // FIX 2: the active outlet's MASTER name (Outlet.name) comes from the SAME primary-outlet row.
      expect(res.outletName).toBe('Primary Outlet');
      expect(res.businessName).toBe('Firm');
    });

    it('outletName is null when the partner has no outlet (FE falls back to businessName)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', businessName: 'Firm', ownerName: 'Owner', partnerCode: 'P1' });
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.creditPayoutEntry.findFirst.mockResolvedValue(null);
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue(null);

      const res = await service.getMe(partner);
      expect(res.outletName).toBeNull();
      expect(res.businessName).toBe('Firm');
    });

    // ── Delivery-address pre-fill (PLATFORM-WIDE, owner D3 = outlet address only) ──────────
    describe('deliveryDefaults (redeem address pre-fill)', () => {
      beforeEach(() => {
        mockPrisma.wallet.findFirst.mockResolvedValue(null);
        mockPrisma.creditPayoutEntry.findFirst.mockResolvedValue(null);
        mockPrisma.payoutTransaction.findFirst.mockResolvedValue(null);
      });

      it('returns the PRIMARY outlet address on file, read from the same tenant-scoped outlet query', async () => {
        mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1', businessName: 'Firm' });
        mockPrisma.outlet.findMany.mockResolvedValue([
          { name: 'Primary', outletCode: 'OC1', outletType: { code: 'WHOLESALER' },
            addressLine1: '12 MG Road', addressLine2: null, city: 'Pune', state: 'Maharashtra', pincode: '411001' },
          { name: 'Second', outletCode: 'OC2', outletType: null,
            addressLine1: 'Other St', addressLine2: null, city: 'Nashik', state: 'Maharashtra', pincode: '422001' },
        ]);

        const res = await service.getMe(partner);

        expect(res.deliveryDefaults).toEqual({ line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' });
        expect(mockPrisma.outlet.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { clientId: 'deoleo', partnerId: 'cp1', deletedAt: null },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            select: expect.objectContaining({
              addressLine1: true, addressLine2: true, city: true, state: true, pincode: true,
            }),
          }),
        );
        // Outlet address ONLY (owner D3) — no extra outlet query.
        expect(mockPrisma.outlet.findMany).toHaveBeenCalledTimes(1);
      });

      it('pre-fills only the parts on file (Bajaj outlet with no street/pincode keeps city/state)', async () => {
        mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
        mockPrisma.outlet.findMany.mockResolvedValue([
          { name: 'Shop', outletCode: 'OC1', outletType: null,
            addressLine1: null, addressLine2: null, city: 'Pune', state: 'Maharashtra', pincode: null },
        ]);
        const res = await service.getMe(partner);
        expect(res.deliveryDefaults).toEqual({ line1: null, city: 'Pune', state: 'Maharashtra', pincode: null });
      });

      it('is null when the partner has no outlet (nothing throws)', async () => {
        mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
        mockPrisma.outlet.findMany.mockResolvedValue([]);
        const res = await service.getMe(partner);
        expect(res.deliveryDefaults).toBeNull();
      });

      it('uses the SWITCHED sibling outlet address (keyed on the authorized active partner), never the login own', async () => {
        mockPrisma.channelPartner.findFirst.mockImplementation((args: any) => {
          const w = args.where;
          if (w.isParent === true) return Promise.resolve(null);
          if (w.userId) return Promise.resolve({ id: 'cp1', groupId: 'g1', isParent: false,
            businessName: 'My Shop', ownerName: 'Me', outlets: [] });
          return Promise.resolve({ id: 'sib1', partnerCode: 'P2', businessName: 'Sibling Shop',
            ownerName: 'Me', phone: '9800000001', email: null, entityType: 'FIRM' });
        });
        mockPrisma.channelPartner.findMany.mockResolvedValue([]);
        mockPrisma.outlet.findMany.mockImplementation((args: any) =>
          Promise.resolve(args.where.partnerId === 'sib1'
            ? [{ name: 'Sibling Shop', outletCode: 'OC2', outletType: null,
                addressLine1: '7 Station Rd', addressLine2: null, city: 'Nashik', state: 'Maharashtra', pincode: '422001' }]
            : [{ name: 'My Shop', outletCode: 'OC1', outletType: null,
                addressLine1: '12 MG Road', addressLine2: null, city: 'Pune', state: 'Maharashtra', pincode: '411001' }]),
        );

        const res = await service.getMe(switcher, 'sib1');

        expect(res.deliveryDefaults).toEqual({ line1: '7 Station Rd', city: 'Nashik', state: 'Maharashtra', pincode: '422001' });
        expect(mockPrisma.outlet.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { clientId: 'deoleo', partnerId: 'sib1', deletedAt: null } }),
        );
      });

      it('falls back to the login OWN outlet address when the selector is forbidden (degraded identity)', async () => {
        mockPrisma.channelPartner.findFirst.mockImplementation((args: any) => {
          const w = args.where;
          if (w.isParent === true) return Promise.resolve(null);
          if (w.userId) return Promise.resolve({ id: 'cp1', groupId: null, isParent: false,
            businessName: 'My Shop', ownerName: 'Me', outlets: [] });
          return Promise.resolve({ id: 'cp1', partnerCode: 'P1', businessName: 'My Shop',
            ownerName: 'Me', phone: '9800000001', email: null, entityType: 'FIRM' });
        });
        mockPrisma.channelPartner.findMany.mockResolvedValue([]);
        mockPrisma.outlet.findMany.mockImplementation((args: any) =>
          Promise.resolve(args.where.partnerId === 'cp1'
            ? [{ name: 'My Shop', outletCode: 'OC1', outletType: null,
                addressLine1: '12 MG Road', addressLine2: null, city: 'Pune', state: 'Maharashtra', pincode: '411001' }]
            : [{ name: 'Evil', outletCode: 'X', outletType: null,
                addressLine1: 'Foreign St', addressLine2: null, city: 'X', state: 'X', pincode: '110001' }]),
        );

        const res = await service.getMe(switcher, 'evil');

        expect(res.deliveryDefaults).toEqual({ line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' });
        expect(mockPrisma.outlet.findMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ partnerId: 'evil' }) }),
        );
      });
    });

    it('hasPointsActivity is true when the wallet has redeemablePoints > 0 (no ledger lookup needed)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletType: { code: 'WHOLESALER' } }]);
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 500, lifetimeEarned: 500 });
      mockPrisma.creditPayoutEntry.findFirst.mockResolvedValue(null);
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue(null);

      const res = await service.getMe(partner);
      expect(res.hasPointsActivity).toBe(true);
      expect(mockPrisma.pointsLedger.findFirst).not.toHaveBeenCalled();
    });

    it('hasPointsActivity is true via a PointsLedger row even when balances are zero', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletType: { code: 'WHOLESALER' } }]);
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 0, lifetimeEarned: 0 });
      mockPrisma.pointsLedger.findFirst.mockResolvedValue({ id: 'l1' });
      mockPrisma.creditPayoutEntry.findFirst.mockResolvedValue(null);
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue(null);

      const res = await service.getMe(partner);
      expect(mockPrisma.pointsLedger.findFirst).toHaveBeenCalledWith({
        where: { walletId: 'w1' },
        select: { id: true },
      });
      expect(res.hasPointsActivity).toBe(true);
    });

    it('a PAYOUT-only partner: hasPayoutActivity true via a credit payout entry, hasPointsActivity false', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      // CreditPayoutEntry.outletId stores the outlet CODE, so the probe must key on outletCode.
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001', outletType: { code: 'SSS' } }]);
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.creditPayoutEntry.findFirst.mockResolvedValue({ id: 'e1' });
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue(null);

      const res = await service.getMe(partner);
      expect(mockPrisma.creditPayoutEntry.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'deoleo', outletId: { in: ['O001'] }, status: { in: ['PENDING', 'PROCESSING', 'PAID'] } },
        select: { id: true },
      });
      expect(res.hasPointsActivity).toBe(false);
      expect(res.hasPayoutActivity).toBe(true);
    });

    it('a BOTH-active partner sees both flags true (points wallet + payout transaction)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletType: { code: 'WHOLESALER' } }]);
      mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w1', redeemablePoints: 0, lifetimeEarned: 1200 });
      mockPrisma.creditPayoutEntry.findFirst.mockResolvedValue(null);
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue({ id: 'pt1' });

      const res = await service.getMe(partner);
      expect(res.hasPointsActivity).toBe(true);
      expect(res.hasPayoutActivity).toBe(true);
    });

    it('does not query credit payout entries when the partner has no outlets', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue(null);

      const res = await service.getMe(partner);
      expect(mockPrisma.creditPayoutEntry.findFirst).not.toHaveBeenCalled();
      expect(res.outletType).toBeNull();
      expect(res.hasPayoutActivity).toBe(false);
    });

    // ── Per-outlet-type Loyalty gate (OutletTypeClientConfig.loyaltyEnabled) ──────────────
    it('loyaltyEnabled defaults to TRUE when there is no OutletTypeClientConfig row (never hide on missing config)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletType: { code: 'WHOLESALER' } }]);
      // The primary outlet resolves to a type, but there is NO config row for (clientId, type).
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletTypeId: 'ot1' });
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue(null);
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.creditPayoutEntry.findFirst.mockResolvedValue(null);
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue(null);

      const res = await service.getMe(partner);
      expect(mockPrisma.outletTypeClientConfig.findUnique).toHaveBeenCalledWith({
        where: { clientId_outletTypeId: { clientId: 'deoleo', outletTypeId: 'ot1' } },
        select: { loyaltyEnabled: true },
      });
      expect(res.loyaltyEnabled).toBe(true);
    });

    it('loyaltyEnabled is FALSE when the primary outlet type config has loyaltyEnabled: false', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1', outletType: { code: 'WHOLESALER' } }]);
      mockPrisma.outlet.findFirst.mockResolvedValue({ outletTypeId: 'ot1' });
      mockPrisma.outletTypeClientConfig.findUnique.mockResolvedValue({ loyaltyEnabled: false });
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.creditPayoutEntry.findFirst.mockResolvedValue(null);
      mockPrisma.payoutTransaction.findFirst.mockResolvedValue(null);

      const res = await service.getMe(partner);
      expect(res.loyaltyEnabled).toBe(false);
    });
  });

  // ─── getBanners ──────────────────────────────────────────────────────────────

  describe('getBanners', () => {
    it('reads the banner_config setting scoped to the caller tenant', async () => {
      mockPrisma.programSetting.findFirst.mockResolvedValue(null);
      const res = await service.getBanners(partner);
      expect(mockPrisma.programSetting.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'deoleo', settingKey: 'banner_config' },
      });
      expect(res).toEqual({ banners: [], popups: [] });
    });

    it('returns the stored banners and popups when present', async () => {
      mockPrisma.programSetting.findFirst.mockResolvedValue({
        settingValue: { banners: [{ id: 'b1' }], popups: [{ id: 'p1' }] },
      });
      const res = await service.getBanners(partner);
      expect(res).toEqual({ banners: [{ id: 'b1' }], popups: [{ id: 'p1' }] });
    });
  });

  // ─── getPayouts ───────────────────────────────────────────────────────────────

  describe('getPayouts', () => {
    it('returns an empty list when the caller has no channel partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      const res = await service.getPayouts(partner);
      // Wave 3: the caller's partner is now resolved via the access-boundary helper (own by default).
      // The own-lookup pins isParent:false (a login never resolves to a login-less parent — audit LOW-2).
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user1', clientId: 'deoleo', deletedAt: null, isParent: false },
        select: { id: true, groupId: true },
      });
      expect(res).toEqual({ payouts: [] });
    });

    it('routes to the SWITCHED sibling statement when a valid selector is supplied', async () => {
      // own login → group g1; the selector names an operable login-less same-phone sibling.
      mockPrisma.channelPartner.findFirst.mockImplementation((args: any) =>
        args.where.userId
          ? Promise.resolve({ id: 'cp1', groupId: 'g1' })   // own (resolveActivePartnerId)
          : Promise.resolve({ id: 'sib1' }),                 // the sibling authorization lookup
      );
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([]);

      await service.getPayouts(switcher, 'sib1');

      // buildPayoutStatement scopes the redemption rail to the SIBLING partner id, not the login's own.
      expect(mockPrisma.payoutTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { partnerId: 'sib1', status: { notIn: ['FAILED', 'REVERSED'] } } }),
      );
    });

    it('maps payout transactions scoped to the caller partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1',
          status: 'SUCCESS', // the real completed value in the PayoutStatus enum
          netAmountPaise: 12345,
          providerRefId: 'UTR123',
          completedAt: new Date('2026-05-10T00:00:00.000Z'),
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          batch: {
            batchCode: 'B1',
            notes: 'Q1 Incentive',
            createdAt: new Date('2026-05-02T00:00:00.000Z'),
          },
        },
      ]);
      const res = await service.getPayouts(partner);
      // FAILED/REVERSED are excluded at the query; the statement is the FULL history (no take cap).
      expect(mockPrisma.payoutTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { partnerId: 'cp1', status: { notIn: ['FAILED', 'REVERSED'] } },
        }),
      );
      expect(mockPrisma.payoutTransaction.findMany.mock.calls[0][0].take).toBeUndefined();
      // With no outlets, credit payouts are not queried at all.
      expect(mockPrisma.creditPayoutEntry.findMany).not.toHaveBeenCalled();
      expect(res.payouts[0]).toMatchObject({
        id: 't1',
        period: '2026-05',
        kpiLabel: 'Q1 Incentive',
        payoutAmountPaise: 12345,
        utr: 'UTR123',
        status: 'PAID',
        narration: 'Q1 Incentive',
      });
    });

    it('unions credit payout entries (pending + paid) with redemption payouts, newest-first', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      // Outlets return CODES (that is what CreditPayoutEntry.outletId holds).
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }, { outletCode: 'O002' }]);
      // One redemption cash-out completed as 'SUCCESS' (the real enum value; paid 2026-05-10)…
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1',
          status: 'SUCCESS',
          netAmountPaise: 5000,
          providerRefId: 'UTR-RED',
          completedAt: new Date('2026-05-10T00:00:00.000Z'),
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          batch: { batchCode: 'B1', notes: 'Redemption', createdAt: new Date('2026-05-02T00:00:00.000Z') },
        },
      ]);
      // …one PAID credit payout (paid 2026-06-20) and one still-PENDING (added 2026-07-02).
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        {
          id: 'ce-paid',
          period: '2026-06',
          fieldName: 'Monthly Scheme',
          amountPaise: 80000n,
          narration: 'June payout',
          status: 'PAID',
          utr: 'UTR-CE',
          paidAt: new Date('2026-06-20T00:00:00.000Z'),
          createdAt: new Date('2026-06-05T00:00:00.000Z'),
        },
        {
          id: 'ce-pending',
          period: '2026-06',
          fieldName: 'Monthly Scheme',
          amountPaise: 40000n,
          narration: 'June payout',
          status: 'PENDING',
          utr: null,
          paidAt: null,
          createdAt: new Date('2026-07-02T00:00:00.000Z'),
        },
      ]);

      const res = await service.getPayouts(partner);

      // Credit payouts are scoped by the partner's outlet CODES + the surfaced status set.
      expect(mockPrisma.creditPayoutEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            clientId: 'deoleo',
            outletId: { in: ['O001', 'O002'] },
            status: { in: ['PENDING', 'PROCESSING', 'PAID'] },
          }),
        }),
      );
      expect(mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0].take).toBeUndefined();

      // All three surface; sorted by effective date desc: pending-added-Jul-2, redemption-May-10… wait
      // effective date = paidAt ?? createdAt → ce-pending(Jul-2) > ce-paid(Jun-20) > t1(May-10).
      expect(res.payouts.map((p) => p.id)).toEqual(['ce-pending', 'ce-paid', 't1']);

      const pending = res.payouts.find((p) => p.id === 'ce-pending')!;
      expect(pending).toMatchObject({
        period: '2026-06',
        kpiLabel: 'Monthly Scheme',
        payoutAmountPaise: 40000,
        status: 'PENDING',
        narration: 'June payout',
      });
      expect(pending.utr).toBeUndefined();
      expect(pending.paidAt).toBeUndefined();
      expect(pending.uploadedAt).toBe(new Date('2026-07-02T00:00:00.000Z').toISOString());

      const paid = res.payouts.find((p) => p.id === 'ce-paid')!;
      expect(paid).toMatchObject({ status: 'PAID', utr: 'UTR-CE', payoutAmountPaise: 80000 });
      expect(paid.paidAt).toBe(new Date('2026-06-20T00:00:00.000Z').toISOString());

      // No leaked internal sort key on the wire.
      expect((res.payouts[0] as unknown as Record<string, unknown>)._sortAt).toBeUndefined();
    });

    it('fix/list-caps: returns EVERY row past the old 100-cap, newest-first, and the rows sum to the full total', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      // 130 PAID credit entries (₹1.00 × i) + 5 redemption payouts (₹10.00 each) = 135 rows.
      // Dates are relative to "now" (never a hardcoded future date).
      const base = Date.now();
      const credits = Array.from({ length: 130 }, (_, i) => ({
        id: `ce${i}`,
        period: '2026-01',
        fieldName: 'Monthly Scheme',
        amountPaise: BigInt(100 * (i + 1)),
        narration: '',
        status: 'PAID',
        utr: `UTR${i}`,
        paidAt: new Date(base - i * 3_600_000),
        createdAt: new Date(base - i * 3_600_000 - 1000),
      }));
      const txns = Array.from({ length: 5 }, (_, i) => ({
        id: `t${i}`,
        status: 'SUCCESS',
        netAmountPaise: 1000n,
        providerRefId: null,
        completedAt: new Date(base - (200 + i) * 3_600_000), // older than every credit row
        createdAt: new Date(base - (200 + i) * 3_600_000),
        batch: null,
      }));
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue(credits);
      mockPrisma.payoutTransaction.findMany.mockResolvedValue(txns);

      const res = await service.getPayouts(partner);

      expect(res.payouts).toHaveLength(135);
      // Sort unchanged: newest-first on the effective date → credits ce0..ce129, then t0..t4
      // (the 5 oldest — exactly the rows the old cap dropped).
      expect(res.payouts.map((p) => p.id)).toEqual([
        ...credits.map((c) => c.id),
        ...txns.map((t) => t.id),
      ]);
      // Totals = every row: Σ credits 100×(1..130) = 8,51,500 paise + 5 × 1000 = 8,56,500 paise.
      const sum = res.payouts.reduce((s, p) => s + p.payoutAmountPaise, 0);
      expect(sum).toBe(100 * (130 * 131) / 2 + 5 * 1000);
    });
  });

  // ─── getTargets (P4.5 rewire — OutletTarget + OutletSalesRecord) ─────────────

  describe('getTargets', () => {
    it('returns empty outlets when the caller has no channel partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      const res = await service.getTargets(partner, {});
      // Wave 3: resolved through the access-boundary helper (own by default; select adds groupId).
      // The own-lookup pins isParent:false (a login never resolves to a login-less parent — audit LOW-2).
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user1', clientId: 'deoleo', deletedAt: null, isParent: false },
          select: { id: true, groupId: true },
        }),
      );
      expect(res).toEqual({ period: null, outlets: [] });
    });

    it('returns empty outlets when the partner has no active outlets', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      const res = await service.getTargets(partner, {});
      expect(res).toEqual({ period: null, outlets: [] });
    });

    it('uses the supplied period when provided, scoped to clientId + partner outlet codes', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

      const res = await service.getTargets(partner, { period: '2026-05' });

      // Should NOT call outletTarget.findFirst (most-recent month lookup) because
      // period was supplied.
      expect(mockPrisma.outletTarget.findFirst).not.toHaveBeenCalled();

      // Both sides fetched with tenant + month + outletCode scope
      expect(mockPrisma.outletTarget.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            clientId: 'deoleo',
            month: '2026-05',
            outletCode: { in: ['O001'] },
          },
        }),
      );
      expect(mockPrisma.outletSalesRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            clientId: 'deoleo',
            month: '2026-05',
            outletCode: { in: ['O001'] },
          },
        }),
      );

      expect(res).toEqual({ period: '2026-05', outlets: [] });
    });

    it('falls back to the most-recent month when no period is supplied', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      mockPrisma.outletTarget.findFirst.mockResolvedValue({ month: '2026-04' });
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

      const res = await service.getTargets(partner, {});

      expect(mockPrisma.outletTarget.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clientId: 'deoleo', outletCode: { in: ['O001'] } },
          orderBy: { month: 'desc' },
        }),
      );
      expect(res.period).toBe('2026-04');
    });

    it('returns null period + empty outlets when no target data exists at all', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      mockPrisma.outletTarget.findFirst.mockResolvedValue(null);

      const res = await service.getTargets(partner, {});
      expect(res).toEqual({ period: null, outlets: [] });
    });

    it('joins target + achievement and computes pace per KPI', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: { MONTH_TGT: 100, FOCUS_PACK_1: 50 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          kpiValues: { MONTH_TGT: 80, FOCUS_PACK_1: 0 },
        },
      ]);

      const res = await service.getTargets(partner, { period: '2026-05' });

      expect(res.period).toBe('2026-05');
      expect(res.outlets).toHaveLength(1);

      const outlet = res.outlets[0];
      expect(outlet.outletCode).toBe('O001');
      expect(outlet.outletName).toBe('Outlet One');

      const monthTgt = outlet.kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(monthTgt).toBeDefined();
      expect(monthTgt.target).toBe(100);
      expect(monthTgt.achieved).toBe(80);
      // pace = 80 / 100 = 0.8
      expect(monthTgt.pace).toBeCloseTo(0.8);

      const focusPack = outlet.kpis.find((k: { code: string }) => k.code === 'FOCUS_PACK_1')!;
      expect(focusPack).toBeDefined();
      expect(focusPack.target).toBe(50);
      expect(focusPack.achieved).toBe(0);
      // pace = 0 / 50 = 0  (0 achieved, non-zero target → pace = 0, not null)
      expect(focusPack.pace).toBe(0);
    });

    it('ROOT-FIX Phase 1: outletType resolves from the AUTHORITATIVE Outlet.outletType.code, NOT the stale target snapshot', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      // The Outlet is authoritatively WHOLESALER now (reclassified since the last upload)…
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O001', outletType: { code: 'WHOLESALER' } },
      ]);
      // …and the denormalized target snapshot is gone — type must resolve from the Outlet join.
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: { MONTH_TGT: 100 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

      const res = await service.getTargets(partner, { period: '2026-05' });

      // The outlet query must pull the authoritative type relation.
      expect(mockPrisma.outlet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ outletType: { select: { code: true } } }),
        }),
      );
      // Response reflects the CURRENT Outlet type, not the frozen "SSS" snapshot.
      expect(res.outlets[0].outletType).toBe('WHOLESALER');
    });

    it('outletType falls back to "" when the outlet is genuinely absent from the roster map', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      // Roster query returns an outlet with a missing type relation (defensive absence).
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { outletCode: 'O001', outletName: 'Outlet One', targetValues: { MONTH_TGT: 100 } },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

      const res = await service.getTargets(partner, { period: '2026-05' });

      expect(res.outlets[0].outletType).toBe('');
    });

    it('returns isPrimary + unit per KPI (so the dashboard hero can pick THE primary KPI + label it)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([
        { code: 'MONTH_TGT', label: 'Month Target', unit: 'cases', isPrimary: true },
        { code: 'FOCUS_PACK_1', label: 'Focus Pack - 1', unit: 'units', isPrimary: false },
      ]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: { MONTH_TGT: 800, FOCUS_PACK_1: 50 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { outletCode: 'O001', kpiValues: { MONTH_TGT: 200 } },
      ]);

      const res = await service.getTargets(partner, { period: '2026-05' });
      const kpis = res.outlets[0].kpis;

      const month = kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(month.isPrimary).toBe(true);
      expect(month.unit).toBe('cases');
      expect(month.target).toBe(800);
      expect(month.achieved).toBe(200);

      const focus = kpis.find((k: { code: string }) => k.code === 'FOCUS_PACK_1')!;
      expect(focus.isPrimary).toBe(false);
      expect(focus.unit).toBe('units');
    });

    it('surfaces the per-outlet __names override as kpi.name AND never as a phantom KPI', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([
        { code: 'MONTH_TGT', label: 'Month Target' },
        { code: 'FOCUS_PACK_1', label: 'Focus Pack - 1' },
      ]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          // __names is the reserved override-name key — must NOT become a KPI row.
          targetValues: {
            MONTH_TGT: 100,
            FOCUS_PACK_1: 50,
            __names: { FOCUS_PACK_1: 'Diwali Combo' },
          },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

      const res = await service.getTargets(partner, { period: '2026-05' });
      const kpis = res.outlets[0].kpis;

      // No phantom "__names" KPI row.
      expect(kpis.find((k: { code: string }) => k.code === '__names')).toBeUndefined();

      // FOCUS_PACK_1 shows the custom override name; MONTH_TGT falls back to label.
      const focus = kpis.find((k: { code: string }) => k.code === 'FOCUS_PACK_1')!;
      expect(focus.name).toBe('Diwali Combo');
      const month = kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(month.name).toBe('Month Target');
    });

    it('CRITICAL: pace is null when target is 0 (divide-by-zero guard)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: { MONTH_TGT: 0 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          kpiValues: { MONTH_TGT: 50 },
        },
      ]);

      const res = await service.getTargets(partner, { period: '2026-05' });
      const kpi = res.outlets[0].kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(kpi.pace).toBeNull();
    });

    it('CRITICAL: pace is null when target key is absent', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      // Target row has NO MONTH_TGT key
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: {},
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          kpiValues: { MONTH_TGT: 50 },
        },
      ]);

      const res = await service.getTargets(partner, { period: '2026-05' });
      const kpi = res.outlets[0].kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(kpi.target).toBeNull();
      expect(kpi.pace).toBeNull();
    });

    it('handles outlet with only achievement (no target) — pace null for all KPIs', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);  // no target
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          kpiValues: { MONTH_TGT: 75 },
        },
      ]);

      const res = await service.getTargets(partner, { period: '2026-05' });
      expect(res.outlets).toHaveLength(1);
      const kpi = res.outlets[0].kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(kpi.target).toBeNull();
      expect(kpi.achieved).toBe(75);
      expect(kpi.pace).toBeNull();
    });

    it('handles outlet with only target (no achievement) — achieved null, pace null', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          targetValues: { MONTH_TGT: 100 },
        },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);  // no achievement

      const res = await service.getTargets(partner, { period: '2026-05' });
      const kpi = res.outlets[0].kpis.find((k: { code: string }) => k.code === 'MONTH_TGT')!;
      expect(kpi.target).toBe(100);
      expect(kpi.achieved).toBeNull();
      expect(kpi.pace).toBeNull();
    });

    it('does NOT read schemeTarget — the model is no longer queried', async () => {
      // Verify that no schemeTarget mock is on the mockPrisma object being used.
      // The service must not access prisma.schemeTarget at all.
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      await service.getTargets(partner, {});
      // If schemeTarget were called, mockPrisma.schemeTarget would be undefined
      // and the call would throw. Reaching here confirms it is not called.
      expect((mockPrisma as Record<string, unknown>)['schemeTarget']).toBeUndefined();
    });
  });

  // ─── getSalesTeam (real assigned reps + their manager) ──────────────────────────

  describe('getSalesTeam', () => {
    const rep = (id: string, name: string, phone: string, role: string, level: number, mgr?: any) => ({
      salesUser: {
        id, employeeCode: `E-${id}`,
        user: { name, phone },
        hierarchyLevel: { name: role, level },
        reportingTo: mgr ?? null,
      },
    });

    it('returns an empty team when the caller has no channel partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      const res = await service.getSalesTeam(partner);
      expect(res).toEqual({ team: [] });
      expect(mockPrisma.salesUserAssignment.findMany).not.toHaveBeenCalled();
    });

    it('scopes the assignment query to active mappings on the partner OR its outlets, active sales users only', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1' }, { id: 'o2' }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]);

      await service.getSalesTeam(partner);

      expect(mockPrisma.salesUserAssignment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            unassignedAt: null,
            salesUser: { isActive: true, deletedAt: null, clientId: 'deoleo' },
            OR: [{ partnerId: 'cp1' }, { outletId: { in: ['o1', 'o2'] } }],
          }),
        }),
      );
    });

    it('maps the assigned rep + their manager, rep first (tier), manager second', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1' }]);
      const manager = {
        id: 'm1', clientId: 'deoleo', employeeCode: 'E-m1', isActive: true, deletedAt: null,
        user: { name: 'Rita Manager', phone: '9000000002' },
        hierarchyLevel: { name: 'Sales Officer', level: 4 },
      };
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        rep('r1', 'Anita Rep', '9000000001', 'ISR', 5, manager),
      ]);

      const res = await service.getSalesTeam(partner);
      expect(res.team).toEqual([
        { name: 'Anita Rep', role: 'ISR', phone: '9000000001', employeeCode: 'E-r1', level: 5 },
        { name: 'Rita Manager', role: 'Sales Officer', phone: '9000000002', employeeCode: 'E-m1', level: 4 },
      ]);
    });

    it('dedupes a rep assigned to multiple outlets into one entry', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1' }, { id: 'o2' }]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        rep('r1', 'Anita Rep', '9000000001', 'ISR', 5),
        rep('r1', 'Anita Rep', '9000000001', 'ISR', 5),
      ]);
      const res = await service.getSalesTeam(partner);
      expect(res.team).toHaveLength(1);
      expect(res.team[0].employeeCode).toBe('E-r1');
    });

    it('excludes an inactive/deleted reporting manager', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1' }]);
      const deletedMgr = {
        id: 'm1', employeeCode: 'E-m1', isActive: false, deletedAt: new Date(),
        user: { name: 'Gone Manager', phone: '9' }, hierarchyLevel: { name: 'SO', level: 4 },
      };
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        rep('r1', 'Anita Rep', '9000000001', 'ISR', 5, deletedMgr),
      ]);
      const res = await service.getSalesTeam(partner);
      expect(res.team).toHaveLength(1);
      expect(res.team[0].name).toBe('Anita Rep');
    });

    it('keeps a user who is BOTH a direct rep and another rep\'s manager at the direct (rep) tier', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ id: 'o1' }]);
      const shared = {
        id: 'so1', clientId: 'deoleo', employeeCode: 'E-so1', isActive: true, deletedAt: null,
        user: { name: 'Sam Officer', phone: '9000000009' },
        hierarchyLevel: { name: 'Sales Officer', level: 4 },
      };
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        rep('r1', 'Anita Rep', '9000000001', 'ISR', 5, shared), // shared is r1's manager (tier 1)
        rep('so1', 'Sam Officer', '9000000009', 'Sales Officer', 4), // shared is ALSO directly assigned (tier 0)
      ]);
      const res = await service.getSalesTeam(partner);
      // Sam appears once; because directly assigned (tier 0) he sorts before the ISR? No —
      // tier 0 reps sort by level asc (4 before 5), so Sam (level 4) comes first.
      expect(res.team.map((m) => m.employeeCode)).toEqual(['E-so1', 'E-r1']);
      expect(res.team.filter((m) => m.employeeCode === 'E-so1')).toHaveLength(1);
    });
  });

  // ─── getTargetTrend (dashboard chart — real primary KPI per month) ────────────
  describe('getTargetTrend', () => {
    afterEach(() => jest.useRealTimers());

    it('sums the PRIMARY KPI per month across outlets; honest null where a side has no data', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00Z'));
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O1' }, { outletCode: 'O2' }]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([
        { code: 'LINES', label: 'Lines', unit: 'lines', isPrimary: false },
        { code: 'VOL', label: 'Monthly Volume', unit: 'Litre', isPrimary: true },
      ]);
      // Targets: May + Jun (two outlets each); achievements: Jun only.
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { month: '2026-05', targetValues: { VOL: 40, LINES: 5 } },
        { month: '2026-05', targetValues: { VOL: 60 } },
        { month: '2026-06', targetValues: { VOL: 50 } },
        { month: '2026-06', targetValues: { VOL: 50 } },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
        { month: '2026-06', kpiValues: { VOL: 30, LINES: 9 } },
        { month: '2026-06', kpiValues: { VOL: 40 } },
      ]);

      const res = await service.getTargetTrend(partner, 6);

      expect(res.kpiCode).toBe('VOL');
      expect(res.kpiName).toBe('Monthly Volume');
      expect(res.unit).toBe('Litre');
      expect(res.trend.map((t) => t.month)).toEqual([
        '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
      ]);
      const may = res.trend.find((t) => t.month === '2026-05')!;
      const jun = res.trend.find((t) => t.month === '2026-06')!;
      const jan = res.trend.find((t) => t.month === '2026-01')!;
      expect(may).toEqual({ month: '2026-05', target: 100, achieved: null }); // 40+60, no achievement
      expect(jun).toEqual({ month: '2026-06', target: 100, achieved: 70 });   // 50+50, 30+40 — LINES ignored
      expect(jan).toEqual({ month: '2026-01', target: null, achieved: null }); // honest gap
    });

    it('trends the EXPLICIT kpi when the caller passes one (chart ↔ hero convergence); ignores an unknown code', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00Z'));
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O1' }]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([
        { code: 'LINES', label: 'Lines', unit: 'lines', isPrimary: true },  // flagged primary
        { code: 'VOL', label: 'Monthly Volume', unit: 'Litre', isPrimary: false },
      ]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { month: '2026-06', targetValues: { VOL: 80, LINES: 5 } },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

      // Caller asks for VOL even though LINES is the flagged primary → VOL wins.
      const explicit = await service.getTargetTrend(partner, 6, 'VOL');
      expect(explicit.kpiCode).toBe('VOL');
      expect(explicit.unit).toBe('Litre');
      expect(explicit.trend.find((t) => t.month === '2026-06')!.target).toBe(80);

      // Unknown code → falls back to the flagged primary (LINES).
      const fallback = await service.getTargetTrend(partner, 6, 'NOPE');
      expect(fallback.kpiCode).toBe('LINES');
    });

    it('returns an empty trend when the caller has no partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      const res = await service.getTargetTrend(partner, 6);
      expect(res).toEqual({ kpiCode: null, kpiName: null, unit: null, trend: [] });
    });

    it('scopes outlet + target queries to the caller tenant', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00Z'));
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O1' }]);
      mockPrisma.kpiDef.findMany.mockResolvedValue([{ code: 'VOL', label: 'V', unit: 'Litre', isPrimary: true }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);

      await service.getTargetTrend(partner, 6);

      expect(mockPrisma.outlet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ clientId: 'deoleo' }) }),
      );
      expect(mockPrisma.outletTarget.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ clientId: 'deoleo' }) }),
      );
    });
  });

  // ─── capturePayoutDetails (capture-bank-at-redemption) ────────────────────────
  describe('capturePayoutDetails', () => {
    const FLAG_ON = { features: { captureBankAtRedemption: true } };
    // resolveActivePartner → own partner; the capture then re-reads the partner + its outlet.
    const primePartner = (
      outlet: { requiredPaymentType?: string; parentId?: string | null } | null,
      current: {
        upiId?: string | null;
        upiCaptureMethod?: string | null;
        bankAccountNumber?: string | null;
        ifscCode?: string | null;
        paymentDetailsStatus?: string;
      } = {},
    ) => {
      // 1st findFirst: resolveActivePartnerId's own-partner lookup (Wave 3). 2nd: capture's partner+outlet read.
      mockPrisma.channelPartner.findFirst
        .mockResolvedValueOnce({ id: 'cp1', userId: 'user1' })
        .mockResolvedValueOnce({
          id: 'cp1',
          outlets: outlet ? [outlet] : [],
          ...current,
        });
      // The row-locked read returns the SAME values by default (no concurrent commit).
      lockedPartnerRow = {
        upiId: current.upiId ?? null,
        bankAccountNumber: current.bankAccountNumber ?? null,
        ifscCode: current.ifscCode ?? null,
        paymentDetailsStatus: current.paymentDetailsStatus ?? null,
      };
    };

    it('is forbidden when the tenant feature flag is OFF', async () => {
      mockTenant.resolveClient.mockResolvedValue({ features: {} });
      mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({ id: 'cp1', userId: 'user1' });
      await expect(
        service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'shop@upi' }),
      ).rejects.toThrow(/not enabled/i);
      expect(mockPrisma.channelPartner.updateMany).not.toHaveBeenCalled();
    });

    it('writes a UPI capture as UNVERIFIED and clears the bank rail', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner({ requiredPaymentType: 'ANY', parentId: null });
      const res = await service.capturePayoutDetails(switcher, {
        paymentMode: 'upi',
        upiId: '  Shop@UPI  ',
      });
      expect(res).toEqual({
        ok: true,
        paymentMode: 'upi',
        paymentDetailsStatus: 'UNVERIFIED',
      });
      const data = mockPrisma.channelPartner.updateMany.mock.calls[0][0].data;
      expect(data).toMatchObject({
        paymentMode: 'upi',
        upiId: 'shop@upi', // trimmed + lowercased (UPI VPAs are case-insensitive)
        bankName: null,
        bankAccountNumber: null,
        payoutChequeFileKey: null,
        paymentDetailsStatus: 'UNVERIFIED',
      });
    });

    it('requires a cancelled cheque for a bank capture', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner({ requiredPaymentType: 'ANY', parentId: null });
      await expect(
        service.capturePayoutDetails(switcher, {
          paymentMode: 'bank',
          bankName: 'HDFC',
          accountNumber: '50100',
          ifscCode: 'hdfc0001',
        }),
      ).rejects.toThrow(/cancelled cheque is required/i);
      expect(mockPrisma.channelPartner.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a cheque key from another tenant', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner({ requiredPaymentType: 'ANY', parentId: null });
      await expect(
        service.capturePayoutDetails(switcher, {
          paymentMode: 'bank',
          bankName: 'HDFC',
          accountNumber: '50100',
          ifscCode: 'HDFC0001',
          chequeFileKey: 'kyc/otherclient/cheque.jpg',
        }),
      ).rejects.toThrow(/invalid cheque reference/i);
    });

    it('persists a bank capture (cheque + upper-cased IFSC) as UNVERIFIED and clears UPI', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner({ requiredPaymentType: 'BANK', parentId: null });
      await service.capturePayoutDetails(switcher, {
        paymentMode: 'bank',
        bankName: ' HDFC ',
        accountHolderName: 'Shop Owner',
        accountNumber: ' 50100123 ',
        ifscCode: 'hdfc0001',
        chequeFileKey: 'kyc/deoleo/cheque.jpg',
      });
      const data = mockPrisma.channelPartner.updateMany.mock.calls[0][0].data;
      expect(data).toMatchObject({
        paymentMode: 'bank',
        bankName: 'HDFC',
        bankAccountNumber: '50100123',
        ifscCode: 'HDFC0001',
        upiId: null,
        payoutChequeFileKey: 'kyc/deoleo/cheque.jpg',
        paymentDetailsStatus: 'UNVERIFIED',
      });
    });

    it('rejects UPI when the outlet mandate is BANK-only', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner({ requiredPaymentType: 'BANK', parentId: null });
      await expect(
        service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'shop@upi' }),
      ).rejects.toThrow(/requires payout by bank/i);
    });

    it('surfaces a uniqueness collision as a 400', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner({ requiredPaymentType: 'ANY', parentId: null });
      // A different partner already owns this UPI (outside any group) → clash.
      mockPrisma.channelPartner.findMany.mockResolvedValue([
        { id: 'other', isParent: false, outlets: [{ parentId: null }] },
      ]);
      await expect(
        service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'shop@upi' }),
      ).rejects.toThrow(/already registered to another outlet/i);
      expect(mockPrisma.channelPartner.updateMany).not.toHaveBeenCalled();
    });

    // AUDIT FIX (HIGH): a direct POST must not overwrite a beneficiary already on file.
    it('rejects capture when a VERIFIED beneficiary is already on file', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner(
        { requiredPaymentType: 'ANY', parentId: null },
        { upiId: 'existing@upi', paymentDetailsStatus: 'VERIFIED' },
      );
      await expect(
        service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'new@upi' }),
      ).rejects.toThrow(/already on file/i);
      expect(mockPrisma.channelPartner.updateMany).not.toHaveBeenCalled();
    });

    it('FIX A: after a re-KYC approval wrote + VERIFIED the bank rail of a NEEDS_RECAPTURE partner, capture is rejected', async () => {
      // Post-approval state: the live NEEDS_RECAPTURE partner with the approval's write merged over it
      // (kyc.service.spec "NEEDS_RECAPTURE partner + approved BANK re-KYC → VERIFIED"). Pre-fix the status
      // stayed NEEDS_RECAPTURE and this capture (see the next test) would overwrite the approved details.
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner(
        { requiredPaymentType: 'ANY', parentId: null },
        { bankAccountNumber: '50100123', ifscCode: 'HDFC0001', paymentDetailsStatus: 'VERIFIED' },
      );
      await expect(
        service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'new@upi' }),
      ).rejects.toThrow(/already on file/i);
      expect(mockPrisma.channelPartner.updateMany).not.toHaveBeenCalled();
    });

    it('allows re-capture when the status is NEEDS_RECAPTURE (failed payout)', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner(
        { requiredPaymentType: 'ANY', parentId: null },
        { bankAccountNumber: 'OLD123', ifscCode: 'OLD0001', paymentDetailsStatus: 'NEEDS_RECAPTURE' },
      );
      const res = await service.capturePayoutDetails(switcher, {
        paymentMode: 'upi',
        upiId: 'new@upi',
      });
      expect(res.paymentDetailsStatus).toBe('UNVERIFIED');
      expect(mockPrisma.channelPartner.updateMany).toHaveBeenCalled();
    });

    it('F3: the write is CONDITIONED on the status + routing values the gate read', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner(
        { requiredPaymentType: 'ANY', parentId: null },
        { bankAccountNumber: 'OLD123', ifscCode: 'OLD0001', paymentDetailsStatus: 'NEEDS_RECAPTURE' },
      );
      await service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'new@upi' });
      expect(mockPrisma.channelPartner.updateMany.mock.calls[0][0].where).toEqual({
        id: 'cp1',
        clientId: switcher.clientId,
        paymentDetailsStatus: 'NEEDS_RECAPTURE',
        upiId: null,
        bankAccountNumber: 'OLD123',
        ifscCode: 'OLD0001',
      });
    });

    it('F3: a re-KYC approval that VERIFIED the partner between the gate read and the write WINS → 409, approved details intact', async () => {
      // The gate read saw NEEDS_RECAPTURE (re-capture allowed); a concurrent approval then committed
      // reviewer-approved bank details + VERIFIED, so the conditioned write matches 0 rows.
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner(
        { requiredPaymentType: 'ANY', parentId: null },
        { bankAccountNumber: 'OLD123', ifscCode: 'OLD0001', paymentDetailsStatus: 'NEEDS_RECAPTURE' },
      );
      // Simulated DB row AFTER the approval committed.
      const row = { id: 'cp1', paymentDetailsStatus: 'VERIFIED', upiId: null, bankAccountNumber: '50100123', ifscCode: 'HDFC0001' };
      mockPrisma.channelPartner.updateMany.mockImplementationOnce(async (args: { where: Record<string, unknown> }) => {
        const matches = Object.entries(args.where).every(([k, v]) => k === 'clientId' || (row as Record<string, unknown>)[k] === v);
        return { count: matches ? 1 : 0 };
      });
      await expect(
        service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'new@upi' }),
      ).rejects.toThrow(/payout details changed/i);
      expect(row).toMatchObject({ paymentDetailsStatus: 'VERIFIED', bankAccountNumber: '50100123', ifscCode: 'HDFC0001' });
    });

    // ── DEADLOCK FIX: lock order = partner row FIRST, identity advisory locks SECOND (same as the
    //    re-KYC approval, kyc.service applyBridgeOutcome). ──
    it('LOCK ORDER: the partner row is locked (SELECT … FOR UPDATE) BEFORE any identity advisory lock and the write', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner({ requiredPaymentType: 'ANY', parentId: null });
      await service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'shop@upi' });
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [strings, id] = mockPrisma.$queryRaw.mock.calls[0];
      expect((strings as string[]).join('?')).toMatch(/FROM channel_partners WHERE id = \? FOR UPDATE/);
      expect(id).toBe('cp1');
      expect(mockPrisma.$executeRaw).toHaveBeenCalled(); // the UPI identity advisory lock
      const rowLockAt = mockPrisma.$queryRaw.mock.invocationCallOrder[0];
      for (const at of mockPrisma.$executeRaw.mock.invocationCallOrder) expect(rowLockAt).toBeLessThan(at);
      expect(rowLockAt).toBeLessThan(mockPrisma.channelPartner.updateMany.mock.invocationCallOrder[0]);
    });

    it('re-runs the overwrite gate on the ROW-LOCKED partner: an approval VERIFIED a rail after the unlocked read → 400, no identity lock, nothing written', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      // Unlocked read: NEEDS_RECAPTURE (re-capture allowed). Locked row: a concurrent approval committed.
      primePartner(
        { requiredPaymentType: 'ANY', parentId: null },
        { bankAccountNumber: 'OLD123', ifscCode: 'OLD0001', paymentDetailsStatus: 'NEEDS_RECAPTURE' },
      );
      lockedPartnerRow = { upiId: null, bankAccountNumber: '50100123', ifscCode: 'HDFC0001', paymentDetailsStatus: 'VERIFIED' };
      await expect(
        service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'new@upi' }),
      ).rejects.toThrow(/already on file/i);
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
      expect(mockPrisma.channelPartner.updateMany).not.toHaveBeenCalled();
    });

    it('a lock-conflict abort (Prisma P2034) → clean 409, never a raw 500', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner({ requiredPaymentType: 'ANY', parentId: null });
      mockPrisma.$transaction.mockRejectedValueOnce(
        Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), { code: 'P2034' }),
      );
      const err = await service
        .capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'shop@upi' })
        .catch((e: unknown) => e);
      expect((err as { getStatus?: () => number }).getStatus?.()).toBe(409);
      expect((err as Error).message).toMatch(/payout details changed/i);
    });

    it('a Postgres deadlock (40P01) raised by the row lock → clean 409', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner({ requiredPaymentType: 'ANY', parentId: null });
      mockPrisma.$queryRaw.mockRejectedValueOnce(
        Object.assign(new Error('Raw query failed. Code: `40P01`. Message: `deadlock detected`'), {
          code: 'P2010',
          meta: { code: '40P01', message: 'deadlock detected' },
        }),
      );
      const err = await service
        .capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'shop@upi' })
        .catch((e: unknown) => e);
      expect((err as { getStatus?: () => number }).getStatus?.()).toBe(409);
      expect(mockPrisma.channelPartner.updateMany).not.toHaveBeenCalled();
    });

    it('a non-conflict DB error is NOT masked as 409', async () => {
      mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
      primePartner({ requiredPaymentType: 'ANY', parentId: null });
      mockPrisma.$queryRaw.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { code: 'P1017' }));
      await expect(
        service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'shop@upi' }),
      ).rejects.toThrow('connection reset');
    });

    // ── VPA safeguards: confirm-entry for a MANUALLY typed UPI + capture-method provenance ──
    describe('VPA safeguards (upiCaptureMethod / upiIdConfirm)', () => {
      // Manual UPI entry is a per-tenant opt-in (salesApp.upiManualEntry) — ON for this block.
      beforeEach(() => {
        mockTenantSettings.getEffectiveSettings.mockResolvedValue({
          salesApp: { upiEnabled: true, upiManualEntry: true },
          uniquenessPolicy: { gst: true, phone: true, bank: true, upi: true },
        });
      });

      it('F7: rejects a MANUAL UPI capture when the tenant has manual entry OFF (400, nothing written)', async () => {
        mockTenantSettings.getEffectiveSettings.mockResolvedValue({
          salesApp: { upiEnabled: true, upiManualEntry: false },
          uniquenessPolicy: { gst: true, phone: true, bank: true, upi: true },
        });
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null });
        await expect(
          service.capturePayoutDetails(switcher, {
            paymentMode: 'upi',
            upiId: 'shop@upi',
            upiIdConfirm: 'shop@upi',
            upiCaptureMethod: 'MANUAL',
          }),
        ).rejects.toThrow('Manual UPI entry is not enabled');
        expect(mockPrisma.channelPartner.updateMany).not.toHaveBeenCalled();
      });

      it('F7: a QR UPI capture is unaffected when manual entry is OFF', async () => {
        mockTenantSettings.getEffectiveSettings.mockResolvedValue({
          salesApp: { upiEnabled: true, upiManualEntry: false },
          uniquenessPolicy: { gst: true, phone: true, bank: true, upi: true },
        });
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null });
        await service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'shop@upi', upiCaptureMethod: 'QR' });
        expect(mockPrisma.channelPartner.updateMany.mock.calls[0][0].data).toMatchObject({ upiCaptureMethod: 'QR' });
      });

      it('F6: a UPI capture still nulls the redemption cheque key (self-serve behaviour unchanged)', async () => {
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null });
        await service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'shop@upi', upiCaptureMethod: 'QR' });
        expect(mockPrisma.channelPartner.updateMany.mock.calls[0][0].data).toMatchObject({
          payoutChequeFileKey: null, bankName: null, bankAccountHolder: null, bankAccountNumber: null, ifscCode: null,
        });
      });
      it('rejects a MANUAL UPI capture with NO confirmation (400, nothing written)', async () => {
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null });
        await expect(
          service.capturePayoutDetails(switcher, {
            paymentMode: 'upi',
            upiId: 'shop@upi',
            upiCaptureMethod: 'MANUAL',
          }),
        ).rejects.toThrow('UPI IDs do not match');
        expect(mockPrisma.channelPartner.updateMany).not.toHaveBeenCalled();
      });

      it('rejects a MANUAL UPI capture whose confirmation differs (400, nothing written)', async () => {
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null });
        await expect(
          service.capturePayoutDetails(switcher, {
            paymentMode: 'upi',
            upiId: 'shop@upi',
            upiIdConfirm: 'shop@ybl',
            upiCaptureMethod: 'MANUAL',
          }),
        ).rejects.toThrow('UPI IDs do not match');
        expect(mockPrisma.channelPartner.updateMany).not.toHaveBeenCalled();
      });

      it('accepts a MANUAL UPI whose confirmation matches case/space-insensitively + records MANUAL', async () => {
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null });
        await service.capturePayoutDetails(switcher, {
          paymentMode: 'upi',
          upiId: 'Shop@UPI',
          upiIdConfirm: '  shop@upi ',
          upiCaptureMethod: 'MANUAL',
        });
        const data = mockPrisma.channelPartner.updateMany.mock.calls[0][0].data;
        expect(data).toMatchObject({ upiId: 'shop@upi', upiCaptureMethod: 'MANUAL', bankAccountNumber: null });
      });

      it('accepts a QR UPI capture WITHOUT a confirmation + records QR', async () => {
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null });
        await service.capturePayoutDetails(switcher, {
          paymentMode: 'upi',
          upiId: 'shop@upi',
          upiCaptureMethod: 'QR',
        });
        const data = mockPrisma.channelPartner.updateMany.mock.calls[0][0].data;
        expect(data).toMatchObject({ upiId: 'shop@upi', upiCaptureMethod: 'QR' });
      });

      it('a UPI capture with no method records upiCaptureMethod NULL (unknown)', async () => {
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null });
        await service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'shop@upi' });
        const data = mockPrisma.channelPartner.updateMany.mock.calls[0][0].data;
        expect(data.upiCaptureMethod).toBeNull();
      });

      it('a bank capture nulls upiCaptureMethod alongside upiId', async () => {
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'BANK', parentId: null });
        await service.capturePayoutDetails(switcher, {
          paymentMode: 'bank',
          bankName: 'HDFC',
          accountNumber: '50100123',
          ifscCode: 'HDFC0001',
          chequeFileKey: 'kyc/deoleo/cheque.jpg',
        });
        const data = mockPrisma.channelPartner.updateMany.mock.calls[0][0].data;
        expect(data).toMatchObject({ upiId: null, upiCaptureMethod: null });
      });

      // ── R6 / R7: manual-entry gate only for a genuinely NEW typed UPI; prior method preserved ──
      const manualOff = {
        salesApp: { upiEnabled: true, upiManualEntry: false },
        uniquenessPolicy: { gst: true, phone: true, bank: true, upi: true },
      };
      const NEEDS_RECAPTURE_UPI = { upiId: 'shop@upi', upiCaptureMethod: 'QR', paymentDetailsStatus: 'NEEDS_RECAPTURE' };

      it('R6: re-entering the STORED UPI as MANUAL with manual entry OFF → accepted, stored method kept', async () => {
        mockTenantSettings.getEffectiveSettings.mockResolvedValue(manualOff);
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null }, NEEDS_RECAPTURE_UPI);
        await service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'Shop@UPI', upiCaptureMethod: 'MANUAL' });
        expect(mockPrisma.channelPartner.updateMany.mock.calls[0][0].data).toMatchObject({
          upiId: 'shop@upi', upiCaptureMethod: 'QR',
        });
      });

      it('R6: a NEW typed UPI with manual entry OFF → 400 after an UNCACHED settings re-read', async () => {
        mockTenantSettings.getEffectiveSettings.mockResolvedValue(manualOff);
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null }, NEEDS_RECAPTURE_UPI);
        await expect(
          service.capturePayoutDetails(switcher, {
            paymentMode: 'upi', upiId: 'other@upi', upiIdConfirm: 'other@upi', upiCaptureMethod: 'MANUAL',
          }),
        ).rejects.toThrow('Manual UPI entry is not enabled');
        expect(mockTenantSettings.getEffectiveSettings).toHaveBeenCalledWith(expect.any(String), { fresh: true });
        expect(mockPrisma.channelPartner.updateMany).not.toHaveBeenCalled();
      });

      it('R6: stale cache says OFF but the fresh read says ON → accepted as MANUAL', async () => {
        mockTenantSettings.getEffectiveSettings.mockImplementation(async (_c: string, opts?: { fresh?: boolean }) => ({
          salesApp: { upiEnabled: true, upiManualEntry: !!opts?.fresh },
          uniquenessPolicy: { gst: true, phone: true, bank: true, upi: true },
        }));
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null });
        await service.capturePayoutDetails(switcher, {
          paymentMode: 'upi', upiId: 'new@upi', upiIdConfirm: 'new@upi', upiCaptureMethod: 'MANUAL',
        });
        expect(mockPrisma.channelPartner.updateMany.mock.calls[0][0].data).toMatchObject({ upiCaptureMethod: 'MANUAL' });
      });

      it('R7: re-entering the stored UPI with NO method (old cached FE) keeps the stored method, not null', async () => {
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null }, NEEDS_RECAPTURE_UPI);
        await service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'shop@upi' });
        expect(mockPrisma.channelPartner.updateMany.mock.calls[0][0].data.upiCaptureMethod).toBe('QR');
      });

      it('M1: stale cache (UPI uniqueness OFF) but the fresh read ON → a duplicate UPI is rejected', async () => {
        mockTenantSettings.getEffectiveSettings.mockImplementation(async (_c: string, opts?: { fresh?: boolean }) => ({
          salesApp: { upiEnabled: true, upiManualEntry: true },
          uniquenessPolicy: { gst: true, phone: true, bank: false, upi: !!opts?.fresh },
        }));
        mockPrisma.channelPartner.findMany.mockImplementation(async (args: { where?: Record<string, unknown> }) =>
          args?.where && 'upiId' in args.where ? [{ id: 'cp-other', isParent: false, outlets: [{ parentId: null }] }] : [],
        );
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null });
        await expect(
          service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'dup@upi', upiCaptureMethod: 'QR' }),
        ).rejects.toThrow(/already registered/);
        expect(mockTenantSettings.getEffectiveSettings).toHaveBeenCalledWith(expect.any(String), { fresh: true });
        expect(mockPrisma.channelPartner.updateMany).not.toHaveBeenCalled();
      });

      it('M1: a bank capture keeps the cached settings read (no uncached read)', async () => {
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: null });
        await service.capturePayoutDetails(switcher, {
          paymentMode: 'bank', bankName: 'HDFC', accountNumber: '50100', ifscCode: 'HDFC0001',
          chequeFileKey: 'kyc/deoleo/cheque.jpg',
        } as never);
        for (const call of mockTenantSettings.getEffectiveSettings.mock.calls) expect(call[1]).toBeUndefined();
      });

      it('L3: no method sent + UPI equal to the GROUP prefill → the group method (QR) is kept', async () => {
        mockTenant.resolveClient.mockResolvedValue(FLAG_ON);
        primePartner({ requiredPaymentType: 'ANY', parentId: 'parent-1' });
        // 3rd findFirst: resolveGroupIdentity's approved-parent read
        mockPrisma.channelPartner.findFirst.mockResolvedValueOnce({
          onboardedAt: new Date(), businessName: 'P', ownerName: 'P', gstNumber: null, panNumber: null,
          bankName: null, bankAccountNumber: null, bankAccountHolder: null, ifscCode: null,
          upiId: 'group@upi', upiCaptureMethod: 'QR', paymentDetailsStatus: 'VERIFIED',
        });
        await service.capturePayoutDetails(switcher, { paymentMode: 'upi', upiId: 'Group@UPI' });
        expect(mockPrisma.channelPartner.updateMany.mock.calls[0][0].data).toMatchObject({ upiId: 'group@upi', upiCaptureMethod: 'QR' });
      });
    });
  });

  // AUDIT FIX (id-F4): the cheque upload route is feature-gated too (no storage abuse off-flag).
  describe('uploadPayoutDocument', () => {
    it('is forbidden when the feature flag is OFF', async () => {
      mockTenant.resolveClient.mockResolvedValue({ features: {} });
      await expect(
        service.uploadPayoutDocument(switcher, {
          buffer: Buffer.from('x'),
          size: 1,
          originalname: 'cheque.jpg',
        } as Express.Multer.File),
      ).rejects.toThrow(/not enabled/i);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });
  });

  // ─── APPLIES-TO D6: partner outlet cards are single-outlet views ─────────────────────────────
  describe('getTargets / getTargetTrend — APPLIES-TO KPI scope', () => {
    const u = { outletType: null, outletTypes: [], programs: [], subPrograms: [] };
    function prime(kpis: unknown[]) {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', programName: 'RLP', programCategory: null, outletType: { code: 'SSS' } },
        { outletCode: 'O2', programName: 'BSC', programCategory: 'Rural', outletType: { code: 'SSS' } },
      ]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        { outletCode: 'O1', outletName: 'One', targetValues: { PRI: 100, B: 10 } },
        { outletCode: 'O2', outletName: 'Two', targetValues: { PRI: 100, B: 10 } },
      ]);
      mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
      mockPrisma.kpiDef.findMany.mockResolvedValue(kpis);
    }

    it('hides an out-of-scope KPI on that outlet and falls back the primary to its first in-scope KPI', async () => {
      prime([
        { code: 'PRI', label: 'Pri', unit: '', isPrimary: true, order: 1, ...u, programs: ['rlp'] },
        { code: 'B', label: 'B', unit: '', isPrimary: false, order: 2, ...u },
      ]);
      const res: any = await service.getTargets(partner, { period: '2026-05' });
      const o1 = res.outlets.find((o: any) => o.outletCode === 'O1');
      const o2 = res.outlets.find((o: any) => o.outletCode === 'O2');
      expect(o1.kpis.map((k: any) => [k.code, k.isPrimary])).toEqual([['PRI', true], ['B', false]]);
      expect(o2.kpis.map((k: any) => [k.code, k.isPrimary])).toEqual([['B', true]]);
    });

    it('UNSCOPED tenant → identical rows/flags on every outlet (Deoleo byte-identical)', async () => {
      prime([
        { code: 'PRI', label: 'Pri', unit: '', isPrimary: true, order: 1, ...u },
        { code: 'B', label: 'B', unit: '', isPrimary: false, order: 2, ...u },
      ]);
      const res: any = await service.getTargets(partner, { period: '2026-05' });
      for (const o of res.outlets) expect(o.kpis.map((k: any) => [k.code, k.isPrimary])).toEqual([['PRI', true], ['B', false]]);
    });

    it('trend: a tenant primary that applies to none of the partner outlets falls back to an in-scope KPI', async () => {
      prime([
        { code: 'A_PRI', label: 'Pri', unit: '', isPrimary: true, order: 1, ...u, programs: ['GOLD'] },
        { code: 'B', label: 'B', unit: 'cases', isPrimary: false, order: 2, ...u },
      ]);
      const res = await service.getTargetTrend(partner, 3);
      expect(res.kpiCode).toBe('B');
      prime([
        { code: 'A_PRI', label: 'Pri', unit: '', isPrimary: true, order: 1, ...u },
        { code: 'B', label: 'B', unit: 'cases', isPrimary: false, order: 2, ...u },
      ]);
      expect((await service.getTargetTrend(partner, 3)).kpiCode).toBe('A_PRI'); // unscoped unchanged
    });

    it('primary fallback never picks a DISABLED KPI (audit #7)', async () => {
      prime([
        { code: 'PRI', label: 'Pri', unit: '', isPrimary: true, order: 1, enabled: true, ...u, programs: ['rlp'] },
        { code: 'DIS', label: 'Dis', unit: '', isPrimary: false, order: 0, enabled: false, ...u },
        { code: 'B', label: 'B', unit: '', isPrimary: false, order: 2, enabled: true, ...u },
      ]);
      const res: any = await service.getTargets(partner, { period: '2026-05' });
      const o2 = res.outlets.find((o: any) => o.outletCode === 'O2');
      expect(o2.kpis.map((k: any) => [k.code, k.isPrimary])).toEqual([['B', true]]);
    });

    it('trend sums a legacy single-type KPI only over the outlets it applies to; unscoped → every outlet', async () => {
      prime([{ code: 'S', label: 'S', unit: '', isPrimary: true, order: 1, ...u, outletType: 'SSS' }]);
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', programName: null, programCategory: null, outletType: { code: 'SSS' } },
        { outletCode: 'O2', programName: null, programCategory: null, outletType: { code: 'WHOLESALER' } },
      ]);
      await service.getTargetTrend(partner, 3);
      expect(mockPrisma.outletTarget.findMany.mock.calls.at(-1)![0].where.outletCode).toEqual({ in: ['O1'] });
      expect(mockPrisma.outletSalesRecord.findMany.mock.calls.at(-1)![0].where.outletCode).toEqual({ in: ['O1'] });
      mockPrisma.kpiDef.findMany.mockResolvedValue([{ code: 'S', label: 'S', unit: '', isPrimary: true, order: 1, ...u }]);
      await service.getTargetTrend(partner, 3);
      expect(mockPrisma.outletTarget.findMany.mock.calls.at(-1)![0].where.outletCode).toEqual({ in: ['O1', 'O2'] });
    });
  });
});
