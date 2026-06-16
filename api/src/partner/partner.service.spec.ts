// Unit tests for PartnerService — mirrors the S4 tickets/wallet templates.
// Covers tenant + caller scoping on each ported partner self-service read:
// banners (ProgramSetting), payouts (ChannelPartner → PayoutTransaction), and
// targets (SchemeTarget). The invoices route was skipped (in-memory mock).
// Run: npx jest src/partner/partner.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { PartnerService } from './partner.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  programSetting: { findFirst: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
  payoutTransaction: { findMany: jest.fn() },
  schemeTarget: { findMany: jest.fn() },
};

const partner: JwtPayload = { sub: 'user1', role: 'RETAILER', clientId: 'deoleo', phone: '', name: '' };

describe('PartnerService', () => {
  let service: PartnerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [PartnerService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(PartnerService);
  });

  describe('getBanners', () => {
    it('reads the banner_config setting scoped to the caller tenant', async () => {
      mockPrisma.programSetting.findFirst.mockResolvedValue(null);
      const res = await service.getBanners(partner);
      expect(mockPrisma.programSetting.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'deoleo', settingKey: 'banner_config' },
      });
      // Consistent empty shape across populated/empty branches.
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

  describe('getPayouts', () => {
    it('returns an empty list when the caller has no channel partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      const res = await service.getPayouts(partner);
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user1', clientId: 'deoleo' },
        select: { id: true },
      });
      expect(res).toEqual({ payouts: [] });
    });

    it('maps payout transactions scoped to the caller partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1',
          status: 'COMPLETED',
          netAmountPaise: 12345,
          providerRefId: 'UTR123',
          completedAt: new Date('2026-05-10T00:00:00.000Z'),
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          batch: { batchCode: 'B1', notes: 'Q1 Incentive', createdAt: new Date('2026-05-02T00:00:00.000Z') },
        },
      ]);
      const res = await service.getPayouts(partner);
      expect(mockPrisma.payoutTransaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { partnerId: 'cp1' }, take: 100 }),
      );
      expect(res.payouts[0]).toMatchObject({
        id: 't1',
        period: '2026-05',
        kpiLabel: 'Q1 Incentive',
        payoutAmountInr: 123,
        utr: 'UTR123',
        status: 'PAID',
        narration: 'Q1 Incentive',
      });
    });
  });

  describe('getTargets', () => {
    it('scopes to the caller user + tenant with no period filter', async () => {
      mockPrisma.schemeTarget.findMany.mockResolvedValue([]);
      const res = await service.getTargets(partner, {});
      expect(mockPrisma.schemeTarget.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user1',
            status: 'ACTIVE',
            scheme: { clientId: 'deoleo' },
          },
          take: 20,
        }),
      );
      expect(res).toEqual({ targets: [] });
    });

    it('applies a period overlap filter to the scheme when period is given', async () => {
      mockPrisma.schemeTarget.findMany.mockResolvedValue([]);
      await service.getTargets(partner, { period: '2026-05' });
      const arg = mockPrisma.schemeTarget.findMany.mock.calls[0][0];
      expect(arg.where.scheme.clientId).toBe('deoleo');
      expect(arg.where.scheme.AND).toBeDefined();
    });

    it('computes capped percentage and maps incentiveEarnable', async () => {
      mockPrisma.schemeTarget.findMany.mockResolvedValue([
        {
          id: 'st1',
          schemeId: 's1',
          targetValue: 100,
          achievedValue: 250,
          projectedIncentive: 500,
          status: 'ACTIVE',
          scheme: { id: 's1', name: 'Scheme One', startDate: new Date(), endDate: new Date() },
        },
        {
          id: 'st2',
          schemeId: 's2',
          targetValue: 0,
          achievedValue: 10,
          projectedIncentive: null,
          status: 'ACTIVE',
          scheme: { id: 's2', name: 'Scheme Two', startDate: new Date(), endDate: new Date() },
        },
      ]);
      const res = await service.getTargets(partner, {});
      expect(res.targets[0]).toMatchObject({ percentage: 100, incentiveEarnable: 500, schemeName: 'Scheme One' });
      expect(res.targets[1]).toMatchObject({ percentage: 0, incentiveEarnable: 0 });
    });
  });
});
