// Unit tests for GifsyService — mirrors the tickets.service.spec.ts template.
// Covers the GIFSY_ADMIN-only guard, the registry projection, default-flag
// fallback, and the "only supplied fields" upsert semantics ported from the
// Next routes.
// Run: npx jest src/gifsy/gifsy.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { GifsyService } from './gifsy.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { AdminCoreService } from '../admin-core/admin-core.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  client: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  outletType: { findMany: jest.fn(), findFirst: jest.fn() },
  outletTypeClientConfig: { findMany: jest.fn(), upsert: jest.fn() },
  clientDomain: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    deleteMany: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockStorage = {
  generateKey: jest.fn(),
  uploadFile: jest.fn(),
};

// The tenant-targeted wallet-settings path DELEGATES to these real services; the
// specs assert on the delegation (args) rather than re-implementing their bodies.
const mockAdminCore = {
  upsertSetting: jest.fn(),
  setPointsExpiry: jest.fn(),
  getPointsExpiry: jest.fn(),
};

const mockTenantSettings = {
  getEffectiveSettings: jest.fn(),
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };

// Valid magic-byte prefixes for the upload tests.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const PDF_BYTES = Buffer.from('%PDF-1.7\n');

describe('GifsyService', () => {
  let service: GifsyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // $transaction runs the callback with the mock client as the tx handle so
    // tx.client.* / tx.clientDomain.* resolve against the same sub-mocks.
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockPrisma) => unknown) =>
      cb(mockPrisma),
    );
    // Default: no custom domains (getClientDetail + non-domain paths never crash).
    mockPrisma.clientDomain.findMany.mockResolvedValue([]);
    mockPrisma.clientDomain.findFirst.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GifsyService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: StorageService, useValue: mockStorage },
        { provide: AdminCoreService, useValue: mockAdminCore },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
      ],
    }).compile();
    service = module.get(GifsyService);
  });

  describe('listClients', () => {
    it('throws Forbidden for non-GIFSY callers', async () => {
      await expect(service.listClients(partner)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('projects every tenant from the canonical Client table (no World-A partnerClassCount)', async () => {
      mockPrisma.client.findMany.mockResolvedValue([
        {
          id: 'deoleo',
          internalName: 'Deoleo India',
          status: 'ACTIVE',
          onboardedAt: new Date('2025-01-01'),
          branding: { displayName: 'Deoleo', primaryColor: '#000', supportEmail: 'help@deoleo.in', productBrands: ['Figaro'] },
          features: { visibilityInvoiceModule: true, kycApprovalFlow: true, walletModule: true, salesTeamApp: true, referralModule: false },
        },
      ]);
      const { clients } = await service.listClients(gifsy);
      expect(clients).toHaveLength(1);
      const deoleo = clients.find((c) => c.slug === 'deoleo')!;
      expect(deoleo.internalName).toBe('Deoleo India');
      expect(deoleo.displayName).toBe('Deoleo');
      expect((deoleo as Record<string, unknown>).partnerClassCount).toBeUndefined();
      expect(deoleo.features).toEqual({
        visibilityInvoiceModule: true,
        kycApprovalFlow: true,
        walletModule: true,
        salesTeamApp: true,
        referralModule: false,
      });
    });
  });

  describe('createClient', () => {
    it('F2: rejects the reserved platform slug "gifsy" (would enable GIFSY_ADMIN minting)', async () => {
      await expect(
        service.createClient(gifsy, { slug: 'gifsy', internalName: 'Rogue' } as never),
      ).rejects.toBeInstanceOf(ConflictException);
      // Rejected before any DB write.
      expect(mockPrisma.client.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.client.create).not.toHaveBeenCalled();
    });

    it('F2: rejects reserved slugs case-insensitively (e.g. "API")', async () => {
      await expect(
        service.createClient(gifsy, { slug: 'API', internalName: 'X' } as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updateClient', () => {
    it('throws NotFound when the slug has no client row', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(null);
      await expect(
        service.updateClient(gifsy, 'nope', { primaryColor: '#fff' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('merges branding, preserving logoUrl + productBrands on a partial PATCH', async () => {
      mockPrisma.client.findFirst.mockResolvedValue({
        id: 'deoleo',
        internalName: 'Deoleo India',
        status: 'ACTIVE',
        onboardedAt: new Date('2025-01-01'),
        branding: { displayName: 'Deoleo', primaryColor: '#000', logoUrl: 'https://cdn/logo.png', productBrands: ['Figaro'] },
        features: {},
      });
      mockPrisma.client.update.mockImplementation(async ({ data }) => ({
        id: 'deoleo',
        internalName: 'Deoleo India',
        status: 'ACTIVE',
        onboardedAt: new Date('2025-01-01'),
        branding: data.branding,
        features: {},
      }));

      const res = await service.updateClient(gifsy, 'deoleo', { primaryColor: '#16a34a' });

      const written = mockPrisma.client.update.mock.calls[0][0].data.branding;
      // Only primaryColor changed; logoUrl + productBrands + displayName survive.
      expect(written).toEqual({
        displayName: 'Deoleo',
        primaryColor: '#16a34a',
        logoUrl: 'https://cdn/logo.png',
        productBrands: ['Figaro'],
      });
      // Projection mirrors createClient/listClients.
      expect(res.slug).toBe('deoleo');
      expect(res.primaryColor).toBe('#16a34a');
      expect(res.logoUrl).toBe('https://cdn/logo.png');
      expect(res.productBrands).toEqual(['Figaro']);
    });

    it('projects supportPhone + invoicePrefix from the merged branding (edit form can reflect them)', async () => {
      mockPrisma.client.findFirst.mockResolvedValue({
        id: 'deoleo',
        internalName: 'Deoleo India',
        status: 'ACTIVE',
        onboardedAt: new Date('2025-01-01'),
        branding: {
          displayName: 'Deoleo',
          supportEmail: 'help@deoleo.in',
          supportPhone: '9900000000',
          invoicePrefix: 'DEO',
        },
        features: {},
      });
      mockPrisma.client.update.mockImplementation(async ({ data }) => ({
        id: 'deoleo',
        internalName: 'Deoleo India',
        status: 'ACTIVE',
        onboardedAt: new Date('2025-01-01'),
        branding: data.branding,
        features: {},
      }));

      const res = await service.updateClient(gifsy, 'deoleo', { supportPhone: '9900000001' });

      // Both flat fields are surfaced so the Gifsy console edit form reflects them after save.
      expect(res.supportPhone).toBe('9900000001');
      expect(res.invoicePrefix).toBe('DEO');
      expect(res.supportEmail).toBe('help@deoleo.in');
    });

    it('writes status top-level without touching the branding blob', async () => {
      mockPrisma.client.findFirst.mockResolvedValue({
        id: 'deoleo',
        internalName: 'Deoleo India',
        status: 'ONBOARDING',
        onboardedAt: new Date('2025-01-01'),
        branding: { displayName: 'Deoleo' },
        features: {},
      });
      mockPrisma.client.update.mockResolvedValue({
        id: 'deoleo',
        internalName: 'Deoleo India',
        status: 'ACTIVE',
        onboardedAt: new Date('2025-01-01'),
        branding: { displayName: 'Deoleo' },
        features: {},
      });

      const res = await service.updateClient(gifsy, 'deoleo', { status: 'ACTIVE' });

      const data = mockPrisma.client.update.mock.calls[0][0].data;
      expect(data.status).toBe('ACTIVE');
      expect(data.branding).toBeUndefined(); // no branding field supplied → blob untouched
      expect(res.status).toBe('ACTIVE');
    });

    it('merges features without dropping existing keys', async () => {
      mockPrisma.client.findFirst.mockResolvedValue({
        id: 'deoleo',
        internalName: 'Deoleo India',
        status: 'ACTIVE',
        onboardedAt: new Date('2025-01-01'),
        branding: {},
        features: { walletModule: true, kycApprovalFlow: true },
      });
      mockPrisma.client.update.mockImplementation(async ({ data }) => ({
        id: 'deoleo',
        internalName: 'Deoleo India',
        status: 'ACTIVE',
        onboardedAt: new Date('2025-01-01'),
        branding: {},
        features: data.features,
      }));

      await service.updateClient(gifsy, 'deoleo', { features: { salesTeamApp: true } });

      const written = mockPrisma.client.update.mock.calls[0][0].data.features;
      // New key added; existing keys preserved.
      expect(written).toEqual({ walletModule: true, kycApprovalFlow: true, salesTeamApp: true });
    });

    it('F1: deep-merges the nested features.partnerApp so a partial PATCH keeps sibling flags', async () => {
      mockPrisma.client.findFirst.mockResolvedValue({
        id: 'deoleo',
        internalName: 'Deoleo India',
        status: 'ACTIVE',
        onboardedAt: new Date('2025-01-01'),
        branding: {},
        features: { walletModule: true, partnerApp: { showSchemes: true, showInvoices: true, showWallet: true } },
      });
      mockPrisma.client.update.mockImplementation(async ({ data }) => ({
        id: 'deoleo',
        internalName: 'Deoleo India',
        status: 'ACTIVE',
        onboardedAt: new Date('2025-01-01'),
        branding: {},
        features: data.features,
      }));

      await service.updateClient(gifsy, 'deoleo', {
        features: { partnerApp: { showSchemes: false } } as never,
      });

      const written = mockPrisma.client.update.mock.calls[0][0].data.features;
      // Only showSchemes flips; the sibling partnerApp flags + walletModule survive.
      expect(written).toEqual({
        walletModule: true,
        partnerApp: { showSchemes: false, showInvoices: true, showWallet: true },
      });
    });
  });

  describe('getOverview', () => {
    it('throws Forbidden for non-GIFSY callers', async () => {
      await expect(service.getOverview(partner)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('tallies status counts and projects module-on counts across all tenants', async () => {
      mockPrisma.client.findMany.mockResolvedValue([
        {
          id: 'deoleo',
          internalName: 'Deoleo India',
          status: 'ACTIVE',
          onboardedAt: new Date('2025-01-01'),
          branding: { displayName: 'Deoleo', primaryColor: '#16a34a' },
          features: { visibilityInvoiceModule: true, kycApprovalFlow: true, walletModule: true, salesTeamApp: false, referralModule: false },
        },
        {
          id: 'clientb',
          internalName: 'Client B',
          status: 'ONBOARDING',
          onboardedAt: new Date('2026-06-01'),
          branding: {},
          features: {},
        },
        {
          id: 'old',
          internalName: 'Old Co',
          status: 'INACTIVE',
          onboardedAt: new Date('2024-01-01'),
          branding: {},
          features: {},
        },
      ]);

      const result = await service.getOverview(gifsy);

      expect(result.totalClients).toBe(3);
      expect(result.active).toBe(1);
      expect(result.onboarding).toBe(1);
      expect(result.inactive).toBe(1);
      expect(result.clients).toHaveLength(3);

      const deoleo = result.clients.find((c) => c.slug === 'deoleo')!;
      expect(deoleo.displayName).toBe('Deoleo');
      expect(deoleo.primaryColor).toBe('#16a34a');
      expect(deoleo.enabledFeatureCount).toBe(3); // visibility + kyc + wallet
      expect(deoleo.moduleCount).toBe(5);

      // Empty-blob tenant falls back to internalName + grey + zero modules.
      const clientb = result.clients.find((c) => c.slug === 'clientb')!;
      expect(clientb.displayName).toBe('Client B');
      expect(clientb.primaryColor).toBe('#6b7280');
      expect(clientb.enabledFeatureCount).toBe(0);
    });
  });

  describe('getClientDetail', () => {
    it('throws Forbidden for non-GIFSY callers', async () => {
      await expect(service.getClientDetail(partner, 'deoleo')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFound when the slug has no client row', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      await expect(service.getClientDetail(gifsy, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('projects the JSON config blocks into a full ClientConfig-shaped detail', async () => {
      mockPrisma.client.findUnique.mockResolvedValue({
        id: 'deoleo',
        internalName: 'Deoleo India Pvt. Ltd.',
        status: 'ACTIVE',
        onboardedAt: new Date('2025-01-01'),
        branding: { displayName: 'Deoleo India', primaryColor: '#16a34a', supportEmail: 'help@deoleo.in', productBrands: ['Figaro'] },
        features: { visibilityInvoiceModule: true, walletModule: true, partnerApp: { showWallet: true, showLeaderboard: false } },
        approvalHierarchy: { levels: [{ roleKey: 'L1' }], requireGifsyFinalApproval: true },
        notifications: { whatsappSenderId: '91X', smsSenderId: 'DEOLEO', templateIds: { otpVerification: 'deoleo_otp' } },
        invoicing: { sellerGstin: '19AABCT1234A1ZX', invoicePrefix: 'TGSL-VIS' },
        wallet: { defaultHoldingPeriodDays: 30, minRedemptionAmount: 500, redemptionModes: ['UPI', 'NEFT'] },
      });

      const detail = await service.getClientDetail(gifsy, 'deoleo');

      expect(detail.slug).toBe('deoleo');
      expect(detail.branding.displayName).toBe('Deoleo India');
      expect(detail.branding.productBrands).toEqual(['Figaro']);
      expect(detail.features.visibilityInvoiceModule).toBe(true);
      expect(detail.features.referralModule).toBe(false); // missing flag → false
      expect(detail.features.partnerApp.showWallet).toBe(true);
      expect(detail.features.partnerApp.showSchemes).toBe(true); // default-on
      expect(detail.approvalHierarchy.levels).toHaveLength(1);
      expect(detail.notifications.templateIds.otpVerification).toBe('deoleo_otp');
      expect(detail.notifications.templateIds.kycApproved).toBe(''); // missing → empty
      // msg91AuthKey is never present on the detail payload.
      expect((detail.notifications as Record<string, unknown>).msg91AuthKey).toBeUndefined();
      expect(detail.invoicing.sellerLegalName).toBe('Tech Gifsy Solutions Limited');
      expect(detail.wallet.redemptionModes).toEqual(['UPI', 'NEFT']);
      expect(detail.wallet.pointsExpiryDays).toBeNull();
    });

    it('returns a complete shape even when every config blob is empty', async () => {
      mockPrisma.client.findUnique.mockResolvedValue({
        id: 'fresh',
        internalName: 'Fresh Co',
        status: 'ONBOARDING',
        onboardedAt: new Date('2026-06-01'),
        branding: {},
        features: {},
        approvalHierarchy: {},
        notifications: {},
        invoicing: {},
        wallet: {},
      });

      const detail = await service.getClientDetail(gifsy, 'fresh');
      expect(detail.branding.displayName).toBe('Fresh Co'); // falls back to internalName
      expect(detail.branding.primaryColor).toBe('#6b7280');
      expect(detail.partnerClasses).toEqual([]);
      expect(detail.approvalHierarchy.levels).toEqual([]);
      expect(detail.wallet.pointsToRupeeRatio).toBe(1);
    });
  });

  describe('getOutletTypeConfigs', () => {
    it('throws Forbidden for non-GIFSY callers', async () => {
      await expect(service.getOutletTypeConfigs(partner, 'deoleo')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns all-default flags when no config row exists', async () => {
      mockPrisma.outletType.findMany.mockResolvedValue([{ id: 'ot1', code: 'RETAILER', name: 'Retailer' }]);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([]);
      const result = await service.getOutletTypeConfigs(gifsy, 'deoleo');
      expect(result).toEqual([
        {
          clientId: 'deoleo',
          outletTypeCode: 'RETAILER',
          outletTypeName: 'Retailer',
          isEnabled: true,
          displayName: null,
          loyaltyEnabled: true,
          schemesEnabled: true,
          visibilityEnabled: true,
          payoutsEnabled: true,
          leaderboardEnabled: true,
          targetsEnabled: true,
          kycRequired: true,
        },
      ]);
    });

    it('overlays the stored row when present', async () => {
      mockPrisma.outletType.findMany.mockResolvedValue([{ id: 'ot1', code: 'RETAILER', name: 'Retailer' }]);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletTypeId: 'ot1', isEnabled: false, displayName: 'Shops', loyaltyEnabled: false },
      ]);
      const [cfg] = await service.getOutletTypeConfigs(gifsy, 'deoleo');
      expect(cfg.isEnabled).toBe(false);
      expect(cfg.displayName).toBe('Shops');
      expect(cfg.loyaltyEnabled).toBe(false);
      expect(cfg.schemesEnabled).toBe(true); // not in row → default
    });
  });

  describe('updateOutletTypeConfig', () => {
    it('throws Forbidden for non-GIFSY callers', async () => {
      await expect(
        service.updateOutletTypeConfig(partner, 'deoleo', 'RETAILER', {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFound when the outlet type code is unknown', async () => {
      mockPrisma.outletType.findFirst.mockResolvedValue(null);
      await expect(
        service.updateOutletTypeConfig(gifsy, 'deoleo', 'NOPE', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('upserts only the fields supplied in the body', async () => {
      mockPrisma.outletType.findFirst.mockResolvedValue({ id: 'ot1', code: 'RETAILER', name: 'Retailer' });
      mockPrisma.outletTypeClientConfig.upsert.mockResolvedValue({
        clientId: 'deoleo',
        isEnabled: true,
        displayName: null,
        loyaltyEnabled: false,
        schemesEnabled: true,
        visibilityEnabled: true,
        payoutsEnabled: true,
        leaderboardEnabled: true,
        targetsEnabled: true,
        kycRequired: true,
      });

      await service.updateOutletTypeConfig(gifsy, 'deoleo', 'RETAILER', { loyaltyEnabled: false });

      const call = mockPrisma.outletTypeClientConfig.upsert.mock.calls[0][0];
      // Only loyaltyEnabled is in the update set.
      expect(call.update).toEqual({ loyaltyEnabled: false });
      // create overlays the supplied field onto the all-true defaults.
      expect(call.create).toEqual({
        clientId: 'deoleo',
        outletTypeId: 'ot1',
        isEnabled: true,
        displayName: null,
        loyaltyEnabled: false,
        schemesEnabled: true,
        visibilityEnabled: true,
        payoutsEnabled: true,
        leaderboardEnabled: true,
        targetsEnabled: true,
        kycRequired: true,
      });
      expect(call.where).toEqual({
        clientId_outletTypeId: { clientId: 'deoleo', outletTypeId: 'ot1' },
      });
    });
  });

  // ── §A-DOMAIN: tenant domains + branding assets + templateIds ──────────────

  const baseClient = (over: Record<string, unknown> = {}) => ({
    id: 'deoleo',
    internalName: 'Deoleo India',
    status: 'ACTIVE',
    onboardedAt: new Date('2025-01-01'),
    branding: {},
    features: {},
    notifications: {},
    ...over,
  });

  describe('updateClient — domains (validate + reconcile)', () => {
    it('rejects a non-.gifsy.in hostname (BadRequest) before touching domain rows', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(baseClient());
      mockPrisma.client.update.mockResolvedValue(baseClient());
      await expect(
        service.updateClient(gifsy, 'deoleo', { domains: ['shop.example.com'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.clientDomain.create).not.toHaveBeenCalled();
    });

    it('rejects a reserved first label like api.gifsy.in (BadRequest)', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(baseClient());
      mockPrisma.client.update.mockResolvedValue(baseClient());
      await expect(
        service.updateClient(gifsy, 'deoleo', { domains: ['api.gifsy.in'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a hostname already owned by another tenant (Conflict), probing case-insensitively + excluding self', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(baseClient());
      mockPrisma.client.update.mockResolvedValue(baseClient());
      mockPrisma.clientDomain.findFirst.mockResolvedValue({ id: 'other-row' });
      await expect(
        service.updateClient(gifsy, 'deoleo', { domains: ['taken.gifsy.in'] }),
      ).rejects.toBeInstanceOf(ConflictException);
      const where = mockPrisma.clientDomain.findFirst.mock.calls[0][0].where;
      expect(where.clientId).toEqual({ not: 'deoleo' });
      expect(where.domain).toEqual({ equals: 'taken.gifsy.in', mode: 'insensitive' });
    });

    it('reconciles the set — deletes removed, creates added, and promotes a new primary when the old primary was removed', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(baseClient());
      mockPrisma.client.update.mockResolvedValue(baseClient());
      mockPrisma.clientDomain.findFirst.mockResolvedValue(null);
      mockPrisma.clientDomain.findMany
        .mockResolvedValueOnce([
          { id: 'd1', clientId: 'deoleo', domain: 'old.gifsy.in', isPrimary: true },
          { id: 'd2', clientId: 'deoleo', domain: 'keep.gifsy.in', isPrimary: false },
        ])
        .mockResolvedValueOnce([
          { id: 'd2', clientId: 'deoleo', domain: 'keep.gifsy.in', isPrimary: false },
          { id: 'd3', clientId: 'deoleo', domain: 'new.gifsy.in', isPrimary: false },
        ]);

      await service.updateClient(gifsy, 'deoleo', {
        domains: ['keep.gifsy.in', 'new.gifsy.in'],
      });

      // old.gifsy.in removed…
      expect(mockPrisma.clientDomain.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['d1'] } },
      });
      // …new.gifsy.in created (keep already existed → not re-created), plus the canonical
      // deoleo.gifsy.in is always re-injected on update so a PATCH can never de-route a tenant…
      const created = mockPrisma.clientDomain.create.mock.calls.map(
        (c) => (c[0] as { data: { domain: string } }).data.domain,
      );
      expect(created).toEqual(['new.gifsy.in', 'deoleo.gifsy.in']);
      // …and since the primary was on the deleted row, the first supplied (branded) domain is promoted.
      expect(mockPrisma.clientDomain.update).toHaveBeenCalledWith({
        where: { id: 'd2' },
        data: { isPrimary: true },
      });
    });

    it('keeps an existing primary untouched when it is still in the set (exactly-one invariant)', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(baseClient());
      mockPrisma.client.update.mockResolvedValue(baseClient());
      mockPrisma.clientDomain.findFirst.mockResolvedValue(null);
      const rows = [
        { id: 'd1', clientId: 'deoleo', domain: 'deoleo.gifsy.in', isPrimary: true },
        { id: 'd2', clientId: 'deoleo', domain: 'shop.gifsy.in', isPrimary: false },
      ];
      mockPrisma.clientDomain.findMany
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce(rows);

      await service.updateClient(gifsy, 'deoleo', {
        domains: ['deoleo.gifsy.in', 'shop.gifsy.in'],
      });

      // Nothing added/removed and the primary is already correct → no create/delete/re-flag.
      expect(mockPrisma.clientDomain.create).not.toHaveBeenCalled();
      expect(mockPrisma.clientDomain.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.clientDomain.update).not.toHaveBeenCalled();
    });

    it('re-injects the canonical on an empty-domains PATCH — a tenant is never left unroutable', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(baseClient());
      mockPrisma.client.update.mockResolvedValue(baseClient());
      mockPrisma.clientDomain.findFirst.mockResolvedValue(null);
      mockPrisma.clientDomain.findMany
        .mockResolvedValueOnce([
          { id: 'b1', clientId: 'deoleo', domain: 'branded.gifsy.in', isPrimary: true },
          { id: 'c1', clientId: 'deoleo', domain: 'deoleo.gifsy.in', isPrimary: false },
        ])
        .mockResolvedValueOnce([
          { id: 'c1', clientId: 'deoleo', domain: 'deoleo.gifsy.in', isPrimary: false },
        ]);

      await service.updateClient(gifsy, 'deoleo', { domains: [] });

      // The branded domain is removed, but the canonical deoleo.gifsy.in survives (never
      // re-created because it already existed) → the tenant keeps ≥1 domain + a primary.
      expect(mockPrisma.clientDomain.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['b1'] } },
      });
      expect(mockPrisma.clientDomain.create).not.toHaveBeenCalled();
      expect(mockPrisma.clientDomain.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { isPrimary: true },
      });
    });
  });

  describe('createClient — canonical domain seeding', () => {
    const created = {
      id: 'acme',
      internalName: 'Acme',
      status: 'ONBOARDING',
      onboardedAt: new Date('2026-07-01'),
      branding: {},
      features: {},
    };

    it('always seeds <slug>.gifsy.in and marks it primary', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      mockPrisma.client.create.mockResolvedValue(created);
      mockPrisma.outletType.findMany.mockResolvedValue([]);
      mockPrisma.clientDomain.findFirst.mockResolvedValue(null);
      mockPrisma.clientDomain.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'c1', clientId: 'acme', domain: 'acme.gifsy.in', isPrimary: false },
        ]);

      await service.createClient(gifsy, { slug: 'acme', internalName: 'Acme' } as never);

      expect(mockPrisma.clientDomain.create).toHaveBeenCalledWith({
        data: { clientId: 'acme', domain: 'acme.gifsy.in', isPrimary: false },
      });
      expect(mockPrisma.clientDomain.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { isPrimary: true },
      });
    });

    it('does not double-create the canonical when the caller also lists it (normalised + deduped)', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      mockPrisma.client.create.mockResolvedValue(created);
      mockPrisma.outletType.findMany.mockResolvedValue([]);
      mockPrisma.clientDomain.findFirst.mockResolvedValue(null);
      mockPrisma.clientDomain.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'c1', clientId: 'acme', domain: 'acme.gifsy.in', isPrimary: false },
        ]);

      await service.createClient(gifsy, {
        slug: 'acme',
        internalName: 'Acme',
        domains: ['ACME.gifsy.in'],
      } as never);

      const created2 = mockPrisma.clientDomain.create.mock.calls.map(
        (c) => (c[0] as { data: { domain: string } }).data.domain,
      );
      expect(created2).toEqual(['acme.gifsy.in']);
    });

    it('marks an explicitly-supplied branded domain primary over the canonical', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      mockPrisma.client.create.mockResolvedValue(created);
      mockPrisma.outletType.findMany.mockResolvedValue([]);
      mockPrisma.clientDomain.findFirst.mockResolvedValue(null);
      mockPrisma.clientDomain.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'c1', clientId: 'acme', domain: 'acme.gifsy.in', isPrimary: false },
          { id: 'c2', clientId: 'acme', domain: 'shop.gifsy.in', isPrimary: false },
        ]);

      await service.createClient(gifsy, {
        slug: 'acme',
        internalName: 'Acme',
        domains: ['shop.gifsy.in'],
      } as never);

      // The branded shop.gifsy.in (supplied) wins primary — not the appended canonical.
      expect(mockPrisma.clientDomain.update).toHaveBeenCalledWith({
        where: { id: 'c2' },
        data: { isPrimary: true },
      });
    });

    it('rejects a slug that collides with a reserved DOMAIN label (e.g. "status") cleanly, up front', async () => {
      await expect(
        service.createClient(gifsy, { slug: 'status', internalName: 'X' } as never),
      ).rejects.toBeInstanceOf(ConflictException);
      // Rejected before any DB work — no client row / domain write attempted.
      expect(mockPrisma.client.create).not.toHaveBeenCalled();
      expect(mockPrisma.clientDomain.create).not.toHaveBeenCalled();
    });
  });

  describe('getClientDetail — domains projection', () => {
    it('returns custom domains ordered primary-first', async () => {
      mockPrisma.client.findUnique.mockResolvedValue({
        id: 'deoleo',
        internalName: 'Deoleo',
        status: 'ACTIVE',
        onboardedAt: new Date('2025-01-01'),
        branding: {},
        features: {},
        approvalHierarchy: {},
        notifications: {},
        invoicing: {},
        wallet: {},
      });
      mockPrisma.clientDomain.findMany.mockResolvedValueOnce([
        { domain: 'deoleo.gifsy.in' },
        { domain: 'shop.gifsy.in' },
      ]);

      const detail = await service.getClientDetail(gifsy, 'deoleo');

      expect(detail.domains).toEqual(['deoleo.gifsy.in', 'shop.gifsy.in']);
      expect(mockPrisma.clientDomain.findMany).toHaveBeenCalledWith({
        where: { clientId: 'deoleo' },
        orderBy: [{ isPrimary: 'desc' }, { domain: 'asc' }],
      });
    });
  });

  describe('updateClient — branding asset URLs + notifications.templateIds', () => {
    it('persists wordmark/favicon URLs while preserving the existing logoUrl', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(
        baseClient({ branding: { displayName: 'Deoleo', logoUrl: 'https://cdn/logo.png' } }),
      );
      mockPrisma.client.update.mockImplementation(async ({ data }: { data: { branding: unknown } }) => ({
        ...baseClient(),
        branding: data.branding,
      }));

      await service.updateClient(gifsy, 'deoleo', {
        wordmarkWhiteUrl: 'https://cdn/ww.png',
        wordmarkColorUrl: 'https://cdn/wc.png',
        faviconUrl: 'https://cdn/fav.png',
      });

      const written = mockPrisma.client.update.mock.calls[0][0].data.branding;
      expect(written).toEqual({
        displayName: 'Deoleo',
        logoUrl: 'https://cdn/logo.png',
        wordmarkWhiteUrl: 'https://cdn/ww.png',
        wordmarkColorUrl: 'https://cdn/wc.png',
        faviconUrl: 'https://cdn/fav.png',
      });
    });

    it('deep-merges notifications.templateIds without dropping sibling / msg91 keys', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(
        baseClient({
          notifications: {
            whatsappSenderId: '91X',
            smsSenderId: 'DEO',
            msg91AuthKey: 'secret',
            templateIds: { otpVerification: 'otp_x' },
          },
        }),
      );
      mockPrisma.client.update.mockImplementation(async ({ data }: { data: { notifications: unknown } }) => ({
        ...baseClient(),
        notifications: data.notifications,
      }));

      await service.updateClient(gifsy, 'deoleo', {
        notifications: { templateIds: { kycApproved: 'new_tpl' } },
      });

      const written = mockPrisma.client.update.mock.calls[0][0].data.notifications;
      expect(written).toEqual({
        whatsappSenderId: '91X',
        smsSenderId: 'DEO',
        msg91AuthKey: 'secret', // never dropped
        templateIds: { otpVerification: 'otp_x', kycApproved: 'new_tpl' }, // merged
      });
    });
  });

  describe('uploadBrandingAsset', () => {
    const pngFile = {
      buffer: PNG_BYTES,
      size: PNG_BYTES.length,
      originalname: 'logo.png',
    } as Express.Multer.File;

    it('throws Forbidden for non-GIFSY callers', async () => {
      await expect(
        service.uploadBrandingAsset(partner, 'deoleo', pngFile, 'logo'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s (and never uploads) when the client does not exist', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(null);
      await expect(
        service.uploadBrandingAsset(gifsy, 'nope', pngFile, 'logo'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });

    it('writes the uploaded URL into the correct branding field with the SNIFFED mime', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(baseClient({ branding: { displayName: 'Deoleo' } }));
      mockPrisma.client.update.mockImplementation(async ({ data }: { data: { branding: unknown } }) => ({
        ...baseClient(),
        branding: data.branding,
      }));
      mockStorage.generateKey.mockReturnValue('branding/deoleo/2026-07/uuid-logo.png');
      mockStorage.uploadFile.mockResolvedValue(
        'https://storage.googleapis.com/b/branding/deoleo/2026-07/uuid-logo.png',
      );

      const res = await service.uploadBrandingAsset(gifsy, 'deoleo', pngFile, 'logo');

      expect(res.url).toBe('https://storage.googleapis.com/b/branding/deoleo/2026-07/uuid-logo.png');
      expect(mockStorage.generateKey).toHaveBeenCalledWith('branding/deoleo', 'logo.png');
      // Trusted (sniffed) mime, not the client's claim.
      expect(mockStorage.uploadFile).toHaveBeenCalledWith(
        PNG_BYTES,
        'branding/deoleo/2026-07/uuid-logo.png',
        'image/png',
      );
      const written = mockPrisma.client.update.mock.calls[0][0].data.branding;
      expect(written.logoUrl).toBe(res.url);
      expect(written.displayName).toBe('Deoleo'); // branding merge preserved
    });

    it('maps kind=favicon → faviconUrl', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(baseClient());
      mockPrisma.client.update.mockImplementation(async ({ data }: { data: { branding: unknown } }) => ({
        ...baseClient(),
        branding: data.branding,
      }));
      mockStorage.generateKey.mockReturnValue('branding/deoleo/k.png');
      mockStorage.uploadFile.mockResolvedValue('https://cdn/fav.png');

      await service.uploadBrandingAsset(
        gifsy,
        'deoleo',
        { buffer: PNG_BYTES, size: PNG_BYTES.length, originalname: 'f.png' } as Express.Multer.File,
        'favicon',
      );

      const written = mockPrisma.client.update.mock.calls[0][0].data.branding;
      expect(written.faviconUrl).toBe('https://cdn/fav.png');
    });

    it('rejects a non-image (PDF) even with a valid magic signature', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(baseClient());
      const pdf = {
        buffer: PDF_BYTES,
        size: PDF_BYTES.length,
        originalname: 'x.pdf',
      } as Express.Multer.File;
      await expect(
        service.uploadBrandingAsset(gifsy, 'deoleo', pdf, 'logo'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects a file over the 5 MB cap (before uploading)', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(baseClient());
      const big = {
        buffer: PNG_BYTES,
        size: 6 * 1024 * 1024,
        originalname: 'logo.png',
      } as Express.Multer.File;
      await expect(
        service.uploadBrandingAsset(gifsy, 'deoleo', big, 'logo'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockStorage.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects a missing file', async () => {
      mockPrisma.client.findFirst.mockResolvedValue(baseClient());
      await expect(
        service.uploadBrandingAsset(gifsy, 'deoleo', undefined as never, 'logo'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── Wallet settings (GIFSY-operator, tenant-TARGETED money-path write) ──────
  describe('getWalletSettings', () => {
    it('throws Forbidden for non-GIFSY callers', async () => {
      await expect(service.getWalletSettings(partner, 'deoleo')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws NotFound when the target tenant does not exist', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      await expect(service.getWalletSettings(gifsy, 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('reads the TARGET tenant slug (not the caller clientId) from the real stores', async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ id: 'acme' });
      mockTenantSettings.getEffectiveSettings.mockResolvedValue({
        conversionRate: 2,
        minBankTransferAmount: 300,
        minVoucherFreeAmount: 150,
      });
      mockAdminCore.getPointsExpiry.mockResolvedValue({ pointsExpiryDays: 365 });

      // Caller is assumed into 'deoleo' but the path targets 'acme'.
      const res = await service.getWalletSettings(gifsy, 'acme');

      expect(mockTenantSettings.getEffectiveSettings).toHaveBeenCalledWith('acme');
      // getPointsExpiry is called with a payload re-pointed at the TARGET tenant.
      expect(mockAdminCore.getPointsExpiry.mock.calls[0][0]).toMatchObject({ clientId: 'acme' });
      expect(res).toEqual({
        slug: 'acme',
        conversionRate: 2,
        pointsExpiryDays: 365,
        minBankTransferAmount: 300,
        minVoucherFreeAmount: 150,
      });
    });
  });

  describe('updateWalletSettings', () => {
    const validDto = {
      conversionRate: 1.5,
      pointsExpiryDays: 180,
      minBankTransferAmount: 250,
      minVoucherFreeAmount: 250,
    };

    beforeEach(() => {
      mockPrisma.client.findUnique.mockResolvedValue({ id: 'acme' });
      mockTenantSettings.getEffectiveSettings.mockResolvedValue({
        conversionRate: 1.5,
        minBankTransferAmount: 250,
        minVoucherFreeAmount: 250,
      });
      mockAdminCore.getPointsExpiry.mockResolvedValue({ pointsExpiryDays: 180 });
      mockAdminCore.upsertSetting.mockResolvedValue({});
      mockAdminCore.setPointsExpiry.mockResolvedValue({ pointsExpiryDays: 180 });
    });

    it('throws Forbidden for non-GIFSY callers (before any write)', async () => {
      await expect(
        service.updateWalletSettings(partner, 'acme', validDto),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockAdminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('throws NotFound for an unknown target tenant (before any write)', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      await expect(
        service.updateWalletSettings(gifsy, 'nope', validDto),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockAdminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('MONEY GUARD: rejects a zero conversion rate (divide-by-zero) with no write', async () => {
      await expect(
        service.updateWalletSettings(gifsy, 'acme', { ...validDto, conversionRate: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockAdminCore.upsertSetting).not.toHaveBeenCalled();
      expect(mockAdminCore.setPointsExpiry).not.toHaveBeenCalled();
    });

    it('MONEY GUARD: rejects a negative conversion rate with no write', async () => {
      await expect(
        service.updateWalletSettings(gifsy, 'acme', { ...validDto, conversionRate: -1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockAdminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('MONEY GUARD: rejects a sub-MIN_RATE rate the read layer would silently drop', async () => {
      await expect(
        service.updateWalletSettings(gifsy, 'acme', { ...validDto, conversionRate: 0.001 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockAdminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('rejects a negative redemption floor with no write', async () => {
      await expect(
        service.updateWalletSettings(gifsy, 'acme', { ...validDto, minBankTransferAmount: -5 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockAdminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('MONEY GUARD: rejects a zero/negative/non-integer pointsExpiryDays with no write (0 ≠ never)', async () => {
      for (const bad of [0, -1, 3.5]) {
        await expect(
          service.updateWalletSettings(gifsy, 'acme', { ...validDto, pointsExpiryDays: bad }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(mockAdminCore.setPointsExpiry).not.toHaveBeenCalled();
      expect(mockAdminCore.upsertSetting).not.toHaveBeenCalled();
    });

    it('DELEGATES to the REAL settings writes, re-pointed at the TARGET tenant, and snaps the rate', async () => {
      // 1.567 must snap to the centi grid the money path enforces (Math.round(rate*100)/100) → 1.57.
      await service.updateWalletSettings(gifsy, 'acme', { ...validDto, conversionRate: 1.567 });

      // Every upsertSetting call carries a payload targeting 'acme' (not the caller's 'deoleo').
      for (const call of mockAdminCore.upsertSetting.mock.calls) {
        expect(call[0]).toMatchObject({ clientId: 'acme' });
      }
      const byKey = Object.fromEntries(
        mockAdminCore.upsertSetting.mock.calls.map((c) => [c[1].key, c[1].value]),
      );
      expect(byKey.conversionRate).toBe(1.57); // snapped to 2 dp
      expect(byKey.minBankTransferAmount).toBe(250);
      expect(byKey.minVoucherFreeAmount).toBe(250);
      // Points expiry delegated to the real PointExpiryConfig write, also target-scoped.
      expect(mockAdminCore.setPointsExpiry.mock.calls[0][0]).toMatchObject({ clientId: 'acme' });
      expect(mockAdminCore.setPointsExpiry.mock.calls[0][1]).toEqual({ pointsExpiryDays: 180 });
    });

    it('passes pointsExpiryDays=null (never expire) straight through to the real write', async () => {
      await service.updateWalletSettings(gifsy, 'acme', { ...validDto, pointsExpiryDays: null });
      expect(mockAdminCore.setPointsExpiry.mock.calls[0][1]).toEqual({ pointsExpiryDays: null });
    });

    it('returns the freshly-read authoritative values after the writes', async () => {
      const res = await service.updateWalletSettings(gifsy, 'acme', validDto);
      expect(res).toEqual({
        slug: 'acme',
        conversionRate: 1.5,
        pointsExpiryDays: 180,
        minBankTransferAmount: 250,
        minVoucherFreeAmount: 250,
      });
    });
  });
});
