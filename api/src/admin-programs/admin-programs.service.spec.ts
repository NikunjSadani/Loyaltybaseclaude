// Unit tests for the admin-programs services (one module, multiple sub-domains).
// Covers tenant/clientId scoping + a few key branches ported from the Next routes.
// Run: npx jest src/admin-programs/admin-programs.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

import { ChannelPartnersService } from './channel-partners.service';
import { VisibilityService } from './visibility.service';
import { BannersService } from './banners.service';
import { BannerConfigService } from './banner-config.service';
import { ReportsService } from './reports.service';
import { KycService } from '../kyc/kyc.service';
import { TargetsService } from '../targets/targets.service';

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' };
const partner: JwtPayload = { sub: 'p1', role: 'WHOLESALER', clientId: 'deoleo', phone: '', name: '' };

const mockPrisma = {
  channelPartner: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  outletVisibilityRecord: { findMany: jest.fn(), count: jest.fn() },
  programSetting: { findFirst: jest.fn(), upsert: jest.fn() },
  bannerManagement: { findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  scheme: { findFirst: jest.fn() },
  schemeEnrollment: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  ticket: { findMany: jest.fn() },
  kpiDef: { findMany: jest.fn() },
  auditLog: { create: jest.fn() },
};

// TargetsService mock — ReportsService.targetVsSales delegates the target↔actual
// join to getPace. Default: no data (each month → empty outlets).
const mockTargets = {
  getPace: jest.fn().mockResolvedValue({ month: '', outlets: [] }),
};

// TenantService mock — used by VisibilityService (bulkUpload mode gate).
// Default: resolves to 'AMOUNT_UPLOAD' so the existing bulkUpload tests that probe
// file-validation errors are not short-circuited by the mode gate.
const mockTenant = {
  resolveVisibilityCaptureMode: jest.fn().mockResolvedValue('AMOUNT_UPLOAD'),
  // Master visibility switch — default ON so the existing bulkUpload/listRecords tests
  // are not blocked by the master gate (the OFF→403 case is tested separately).
  resolveVisibilityEnabled: jest.fn().mockResolvedValue(true),
};

async function build<T>(token: new (...args: never[]) => T): Promise<T> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      token as never,
      { provide: PrismaService, useValue: mockPrisma },
      { provide: TenantService, useValue: mockTenant },
      // ReportsService.outletMaster mints doc-view links via KycService.
      { provide: KycService, useValue: { signDocViewToken: jest.fn(() => 'tok') } },
      // ReportsService.targetVsSales delegates the join to TargetsService.getPace.
      { provide: TargetsService, useValue: mockTargets },
    ],
  }).compile();
  return module.get(token);
}

beforeEach(() => {
  jest.clearAllMocks();
  // Re-apply the default mock after clearAllMocks resets implementations.
  mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('AMOUNT_UPLOAD');
  mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
  mockTargets.getPace.mockResolvedValue({ month: '', outlets: [] });
});

describe('ChannelPartnersService', () => {
  it('scopes list by clientId and isActive (drops World-A class/tier filters)', async () => {
    const service = await build(ChannelPartnersService);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);
    mockPrisma.channelPartner.count.mockResolvedValue(0);

    await service.list(gifsy, { search: 'kumar' });

    const where = mockPrisma.channelPartner.findMany.mock.calls[0][0].where;
    expect(where.clientId).toBe('deoleo');
    expect(where.isActive).toBe(true);
    expect(where).not.toHaveProperty('partnerClass');
    expect(where).not.toHaveProperty('tier');
    expect(where.OR).toEqual([
      { businessName: { contains: 'kumar', mode: 'insensitive' } },
      { phone: { contains: 'kumar' } },
      { panNumber: { contains: 'kumar', mode: 'insensitive' } },
    ]);
  });

  it('throws NotFound when updating a partner outside the tenant', async () => {
    const service = await build(ChannelPartnersService);
    mockPrisma.channelPartner.findFirst.mockResolvedValue(null);
    await expect(service.update(gifsy, 'cp1', { isActive: false })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates only isActive (currentTierConfigId is dropped) and writes an audit log', async () => {
    const service = await build(ChannelPartnersService);
    mockPrisma.channelPartner.findFirst.mockResolvedValue({ id: 'cp1' });
    mockPrisma.channelPartner.update.mockResolvedValue({ id: 'cp1', isActive: false });

    await service.update(gifsy, 'cp1', { isActive: false });

    const data = mockPrisma.channelPartner.update.mock.calls[0][0].data;
    expect(data.isActive).toBe(false);
    expect(data).not.toHaveProperty('currentTierConfigId');
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
  });
});

describe('VisibilityService', () => {
  it('blocks partner roles from reading records', async () => {
    const service = await build(VisibilityService);
    await expect(service.listRecords(partner, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('scopes records by clientId and clamps the limit to 100', async () => {
    const service = await build(VisibilityService);
    mockPrisma.outletVisibilityRecord.findMany.mockResolvedValue([]);
    mockPrisma.outletVisibilityRecord.count.mockResolvedValue(0);

    await service.listRecords(gifsy, { limit: 500, page: 1 });

    const args = mockPrisma.outletVisibilityRecord.findMany.mock.calls[0][0];
    expect(args.where.clientId).toBe('deoleo');
    expect(args.take).toBe(100);
  });

  it('rejects a bulk-upload with a non-xlsx extension', async () => {
    const service = await build(VisibilityService);
    const file = { originalname: 'data.csv', buffer: Buffer.from('') } as Express.Multer.File;
    await expect(service.bulkUpload(gifsy, file)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a bulk-upload with no file', async () => {
    const service = await build(VisibilityService);
    await expect(service.bulkUpload(gifsy, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('master visibility gate', () => {
    it('403s a tenant admin bulk-upload when visibility is OFF — before parsing the file', async () => {
      mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
      const service = await build(VisibilityService);
      const file = { originalname: 'data.xlsx', buffer: Buffer.from('') } as Express.Multer.File;
      await expect(service.bulkUpload(clientAdmin, file)).rejects.toThrow(
        'Visibility is not enabled for this tenant.',
      );
    });

    it('403s a tenant admin listRecords when visibility is OFF', async () => {
      mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
      const service = await build(VisibilityService);
      await expect(service.listRecords(clientAdmin, {})).rejects.toThrow(
        'Visibility is not enabled for this tenant.',
      );
    });

    it('EXEMPTS the GIFSY operator even when the flag is OFF', async () => {
      mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
      const service = await build(VisibilityService);
      mockPrisma.outletVisibilityRecord.findMany.mockResolvedValue([]);
      mockPrisma.outletVisibilityRecord.count.mockResolvedValue(0);
      // Passes the gate (exempt) and proceeds to the real query.
      await expect(service.listRecords(gifsy, {})).resolves.toBeDefined();
    });
  });
});

describe('BannersService', () => {
  it('restricts non-GIFSY list to ACTIVE, non-expired banners', async () => {
    const service = await build(BannersService);
    mockPrisma.bannerManagement.findMany.mockResolvedValue([]);

    await service.list(clientAdmin);

    const where = mockPrisma.bannerManagement.findMany.mock.calls[0][0].where;
    expect(where.clientId).toBe('deoleo');
    expect(where.status).toBe('ACTIVE');
    expect(where.OR).toBeDefined();
  });

  it('does NOT filter status for GIFSY admins', async () => {
    const service = await build(BannersService);
    mockPrisma.bannerManagement.findMany.mockResolvedValue([]);

    await service.list(gifsy);

    const where = mockPrisma.bannerManagement.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ clientId: 'deoleo' });
  });

  it('soft-deletes within the tenant or throws NotFound', async () => {
    const service = await build(BannersService);
    mockPrisma.bannerManagement.findFirst.mockResolvedValue(null);
    await expect(service.remove(gifsy, 'b1')).rejects.toBeInstanceOf(NotFoundException);

    mockPrisma.bannerManagement.findFirst.mockResolvedValue({ id: 'b1' });
    mockPrisma.bannerManagement.update.mockResolvedValue({});
    await service.remove(gifsy, 'b1');
    const data = mockPrisma.bannerManagement.update.mock.calls[0][0].data;
    expect(data.deletedAt).toBeInstanceOf(Date);
  });
});

describe('BannerConfigService', () => {
  it('blocks partner roles from reading config', async () => {
    const service = await build(BannerConfigService);
    await expect(service.get(partner)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ReportsService', () => {
  it('points-ledger: rejects missing from/to', async () => {
    const service = await build(ReportsService);
    await expect(service.pointsLedger(gifsy, { from: '', to: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('points-ledger: scopes outlets by partner.clientId', async () => {
    const service = await build(ReportsService);
    mockPrisma.outlet.findMany.mockResolvedValue([]);

    const res = await service.pointsLedger(gifsy, { from: '2026-01', to: '2026-03' });

    const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
    expect(where.partner.clientId).toBe('deoleo');
    expect(where.deletedAt).toBeNull();
    expect(res).toHaveProperty('months');
    expect(res).toHaveProperty('rows');
  });

  it('ticket-aging: rejects an invalid status value', async () => {
    const service = await build(ReportsService);
    await expect(
      service.ticketAging(gifsy, { status: 'BOGUS' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ticket-aging: scopes tickets by clientId and applies the default open set', async () => {
    const service = await build(ReportsService);
    mockPrisma.ticket.findMany.mockResolvedValue([]);

    const res = await service.ticketAging(gifsy, {});

    const where = mockPrisma.ticket.findMany.mock.calls[0][0].where;
    expect(where.clientId).toBe('deoleo');
    expect(where.deletedAt).toBeNull();
    expect(where.status.in).toEqual(['OPEN', 'IN_PROGRESS', 'PENDING_USER', 'ESCALATED']);
    expect(res).toHaveProperty('summary');
  });
});

describe('ReportsService — target-vs-sales', () => {
  const KPIS = [
    { code: 'MONTH_TGT', label: 'Month Target', unit: 'cases' },
    { code: 'FOCUS_PACK_1', label: 'Focus Pack - 1', unit: 'cases' },
  ];

  it('rejects a span exceeding 15 months (inclusive)', async () => {
    const service = await build(ReportsService);
    mockPrisma.kpiDef.findMany.mockResolvedValue(KPIS);
    // 2025-01 .. 2026-04 = 16 months
    await expect(
      service.targetVsSales(gifsy, { fromMonth: '2025-01', toMonth: '2026-04' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // getPace must never be hit once the range is rejected.
    expect(mockTargets.getPace).not.toHaveBeenCalled();
  });

  it('accepts exactly 15 months', async () => {
    const service = await build(ReportsService);
    mockPrisma.kpiDef.findMany.mockResolvedValue(KPIS);
    // 2025-01 .. 2026-03 = 15 months
    const res = (await service.targetVsSales(gifsy, {
      fromMonth: '2025-01',
      toMonth: '2026-03',
    })) as { months: string[] };
    expect(res.months).toHaveLength(15);
    expect(mockTargets.getPace).toHaveBeenCalledTimes(15);
  });

  it('rejects fromMonth after toMonth', async () => {
    const service = await build(ReportsService);
    mockPrisma.kpiDef.findMany.mockResolvedValue(KPIS);
    await expect(
      service.targetVsSales(gifsy, { fromMonth: '2026-05', toMonth: '2026-03' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('scopes to the caller clientId — getPace is called with the caller (no clientId param exists)', async () => {
    const service = await build(ReportsService);
    mockPrisma.kpiDef.findMany.mockResolvedValue(KPIS);

    await service.targetVsSales(clientAdmin, { fromMonth: '2026-01', toMonth: '2026-02' });

    // KpiDef query tenant-scoped.
    expect(mockPrisma.kpiDef.findMany.mock.calls[0][0].where.clientId).toBe('deoleo');
    expect(mockPrisma.kpiDef.findMany.mock.calls[0][0].where.enabled).toBe(true);
    // Every getPace call carries the caller's JwtPayload (whose clientId getPace filters on).
    for (const call of mockTargets.getPace.mock.calls) {
      expect(call[0]).toBe(clientAdmin);
    }
  });

  it('foreign-tenant data never appears (only getPace-returned outlets are emitted)', async () => {
    const service = await build(ReportsService);
    mockPrisma.kpiDef.findMany.mockResolvedValue(KPIS);
    // getPace (tenant-scoped) returns only OUT-1 for the caller's tenant.
    mockTargets.getPace.mockResolvedValue({
      month: '2026-01',
      outlets: [
        {
          outletCode: 'OUT-1',
          outletName: 'Alpha',
          outletType: 'RETAIL',
          month: '2026-01',
          kpis: [{ code: 'MONTH_TGT', target: 100, achieved: 80, pace: 0.8 }],
        },
      ],
    });

    const res = (await service.targetVsSales(clientAdmin, {
      fromMonth: '2026-01',
      toMonth: '2026-01',
    })) as { rows: Record<string, unknown>[] };

    const codes = new Set(res.rows.map((r) => r['Outlet Code']));
    expect(codes).toEqual(new Set(['OUT-1'])); // no foreign outlet leaks in
  });

  it('blank (not 0) for a missing KPI/actual; a stored 0 stays 0; pace math is achieved÷target×100', async () => {
    const service = await build(ReportsService);
    mockPrisma.kpiDef.findMany.mockResolvedValue(KPIS);
    mockTargets.getPace.mockResolvedValue({
      month: '2026-01',
      outlets: [
        {
          outletCode: 'OUT-1',
          outletName: 'Alpha',
          outletType: 'RETAIL',
          month: '2026-01',
          kpis: [
            // MONTH_TGT: real 0 achieved, real target → achieved cell 0, pace 0.
            { code: 'MONTH_TGT', target: 200, achieved: 0, pace: 0 },
            // FOCUS_PACK_1 absent → all three cells blank.
          ],
        },
      ],
    });

    const res = (await service.targetVsSales(clientAdmin, {
      fromMonth: '2026-01',
      toMonth: '2026-01',
    })) as { rows: Record<string, unknown>[] };
    const row = res.rows[0];

    expect(row['Month Target Target']).toBe(200);
    expect(row['Month Target Achieved']).toBe(0); // real 0, NOT blank
    expect(row['Month Target Pace %']).toBe(0);
    // Absent KPI → blank across the board.
    expect(row['Focus Pack - 1 Target']).toBe('');
    expect(row['Focus Pack - 1 Achieved']).toBe('');
    expect(row['Focus Pack - 1 Pace %']).toBe('');
  });

  it('emits one row per (outlet × month) across the range, blank where a month has no data', async () => {
    const service = await build(ReportsService);
    mockPrisma.kpiDef.findMany.mockResolvedValue([KPIS[0]]);
    // OUT-1 has data only in 2026-02; the range is Jan..Mar.
    mockTargets.getPace.mockImplementation(async (_user: unknown, q: { month: string }) => {
      if (q.month === '2026-02') {
        return {
          month: '2026-02',
          outlets: [
            {
              outletCode: 'OUT-1',
              outletName: 'Alpha',
              outletType: 'RETAIL',
              month: '2026-02',
              kpis: [{ code: 'MONTH_TGT', target: 100, achieved: 50, pace: 0.5 }],
            },
          ],
        };
      }
      return { month: q.month, outlets: [] };
    });

    const res = (await service.targetVsSales(clientAdmin, {
      fromMonth: '2026-01',
      toMonth: '2026-03',
    })) as { rows: Record<string, unknown>[] };

    // 1 qualifying outlet × 3 months = 3 rows, ordered by month.
    expect(res.rows.map((r) => r['Month'])).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(res.rows[0]['Month Target Target']).toBe(''); // Jan blank
    expect(res.rows[1]['Month Target Achieved']).toBe(50); // Feb has data
    expect(res.rows[1]['Month Target Pace %']).toBe(50);
    expect(res.rows[2]['Month Target Achieved']).toBe(''); // Mar blank
  });
});
