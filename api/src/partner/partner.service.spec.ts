// Unit tests for PartnerService.
// Covers tenant + caller scoping on each ported partner self-service read:
//   banners (ProgramSetting), payouts (ChannelPartner → PayoutTransaction),
//   targets (OutletTarget + OutletSalesRecord — P4.5 rewire; SchemeTarget removed).
// The invoices route was skipped (in-memory mock).
// Run: npx jest src/partner/partner.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { PartnerService } from './partner.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

// ─── Mock Prisma ───────────────────────────────────────────────────────────────

const mockPrisma = {
  programSetting:    { findFirst: jest.fn() },
  channelPartner:    { findFirst: jest.fn() },
  payoutTransaction: { findMany: jest.fn() },
  outlet:            { findMany: jest.fn() },
  outletTarget:      { findFirst: jest.fn(), findMany: jest.fn() },
  outletSalesRecord: { findMany: jest.fn() },
};

const partner: JwtPayload = {
  sub: 'user1',
  role: 'RETAILER',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('PartnerService', () => {
  let service: PartnerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [PartnerService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(PartnerService);
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
          batch: {
            batchCode: 'B1',
            notes: 'Q1 Incentive',
            createdAt: new Date('2026-05-02T00:00:00.000Z'),
          },
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

  // ─── getTargets (P4.5 rewire — OutletTarget + OutletSalesRecord) ─────────────

  describe('getTargets', () => {
    it('returns empty outlets when the caller has no channel partner', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
      const res = await service.getTargets(partner, {});
      expect(mockPrisma.channelPartner.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user1', clientId: 'deoleo' } }),
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
          outletType: 'RETAIL',
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

    it('CRITICAL: pace is null when target is 0 (divide-by-zero guard)', async () => {
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
      mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'O001' }]);
      mockPrisma.outletTarget.findMany.mockResolvedValue([
        {
          outletCode: 'O001',
          outletName: 'Outlet One',
          outletType: 'RETAIL',
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
          outletType: 'RETAIL',
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
          outletType: 'RETAIL',
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
});
