// Unit tests for GifsyService — mirrors the tickets.service.spec.ts template.
// Covers the GIFSY_ADMIN-only guard, the registry projection, default-flag
// fallback, and the "only supplied fields" upsert semantics ported from the
// Next routes.
// Run: npx jest src/gifsy/gifsy.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
import { GifsyService } from './gifsy.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  client: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  outletType: { findMany: jest.fn(), findFirst: jest.fn() },
  outletTypeClientConfig: { findMany: jest.fn(), upsert: jest.fn() },
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };

describe('GifsyService', () => {
  let service: GifsyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [GifsyService, { provide: PrismaService, useValue: mockPrisma }],
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
});
