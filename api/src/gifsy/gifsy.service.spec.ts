// Unit tests for GifsyService — mirrors the tickets.service.spec.ts template.
// Covers the GIFSY_ADMIN-only guard, the registry projection, default-flag
// fallback, and the "only supplied fields" upsert semantics ported from the
// Next routes.
// Run: npx jest src/gifsy/gifsy.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GifsyService } from './gifsy.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  client: { findMany: jest.fn() },
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
