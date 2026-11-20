/**
 * Unit tests for visibility-report.service.ts (Stream B).
 *
 * Covers: coverage/miss math (approved numerator over the addressable in-scope
 * denominator), GIFSY-only gate on the gifsy report, CLIENT_ADMIN read-only tenant
 * report. Prisma / Tenant / TenantSettings mocked.
 *
 * Run: npx jest src/visibility/visibility-report.service.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { VisibilityReportService } from './visibility-report.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  outlet: { count: jest.fn() },
  visibilityCapture: { groupBy: jest.fn(), count: jest.fn() },
};

const mockTenant = { resolveVisibilityEnabled: jest.fn() };
const mockSettings = { getEffectiveSettings: jest.fn() };

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 't1', phone: '9', name: 'Admin' };
const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '9', name: 'CA' };

const config = {
  outletScope: ['SSS'],
  frequencyPerMonth: 1,
  allowedSalesLevels: ['SO'],
  geoFence: { enabled: true, radiusMeters: 50 },
};

describe('VisibilityReportService', () => {
  let service: VisibilityReportService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
    mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: config });
    mockPrisma.outlet.count.mockResolvedValue(10);
    mockPrisma.visibilityCapture.groupBy.mockResolvedValue([
      { status: 'APPROVED', _count: { _all: 6 } },
      { status: 'SUBMITTED', _count: { _all: 2 } },
      { status: 'REJECTED', _count: { _all: 1 } },
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisibilityReportService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockSettings },
      ],
    }).compile();
    service = module.get(VisibilityReportService);
  });

  it('computes coverage/miss: approved over addressable in-scope denominator', async () => {
    const res = await service.gifsyReport(gifsy, '2026-07-P1');
    expect(res.summary).toMatchObject({
      denominator: 10,
      captured: 6,
      pending: 2,
      rejected: 1,
      missed: 1, // 10 - (6+2+1)
      coveragePct: 60,
    });
    expect(res.windowKey).toBe('2026-07-P1');
  });

  it('intersects the status buckets with the addressable∩scope outlet set (M2)', async () => {
    await service.gifsyReport(gifsy, '2026-07-P1');
    const where = mockPrisma.visibilityCapture.groupBy.mock.calls[0][0].where;
    expect(where).toMatchObject({ clientId: 't1', windowKey: '2026-07-P1' });
    // The numerator MUST be constrained to the same addressable in-scope outlets as the denominator.
    expect(where.outlet).toMatchObject({
      clientId: 't1',
      deletedAt: null,
      deactivatedAt: null,
      outletType: { code: { in: ['SSS'] } },
    });
    expect(where.outlet.OR).toEqual([{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }]);
  });

  it('coveragePct never exceeds 100 even if approved captures are reported (M2 invariant)', async () => {
    // Denominator smaller than approved would be impossible now that the numerator is
    // outlet-intersected; assert the guard holds if the DB ever returned such a shape.
    mockPrisma.outlet.count.mockResolvedValue(5);
    mockPrisma.visibilityCapture.groupBy.mockResolvedValue([{ status: 'APPROVED', _count: { _all: 5 } }]);
    const res = await service.gifsyReport(gifsy, '2026-07-P1');
    expect(res.summary.coveragePct).toBe(100);
    expect(res.summary.missed).toBe(0);
    expect(res.summary.coveragePct).toBeLessThanOrEqual(100);
  });

  it('denominator is 0 (no query) when the outlet scope is empty', async () => {
    mockSettings.getEffectiveSettings.mockResolvedValue({
      visibilityConfig: { ...config, outletScope: [] },
    });
    const res = await service.gifsyReport(gifsy, '2026-07-P1');
    expect(res.summary.denominator).toBe(0);
    expect(res.summary.coveragePct).toBe(0);
    expect(mockPrisma.outlet.count).not.toHaveBeenCalled();
  });

  it('addressable where mirrors program-health (no isActive filter; kycIntent OR-wrapped)', async () => {
    await service.gifsyReport(gifsy, '2026-07-P1');
    const where = mockPrisma.outlet.count.mock.calls[0][0].where;
    expect(where).toMatchObject({
      clientId: 't1',
      deletedAt: null,
      deactivatedAt: null,
      outletType: { code: { in: ['SSS'] } },
    });
    expect(where.OR).toEqual([{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }]);
    expect(where.isActive).toBeUndefined();
  });

  // ── Gates ──────────────────────────────────────────────────────────────────
  it('gifsyReport 403s a non-GIFSY caller', async () => {
    await expect(service.gifsyReport(clientAdmin, '2026-07-P1')).rejects.toThrow(ForbiddenException);
  });

  it('tenantReport works for CLIENT_ADMIN (same shape)', async () => {
    const res = await service.tenantReport(clientAdmin, '2026-07-P1');
    expect(res.summary.captured).toBe(6);
  });

  it('403s when visibilityEnabled is OFF', async () => {
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
    await expect(service.tenantReport(clientAdmin, '2026-07-P1')).rejects.toThrow(ForbiddenException);
  });

  // The xlsx captures export is the `visibility-captures` export kind (exports/kinds/batch1/visibility-captures.spec.ts).

  // ── APPLIES-TO (D9/D12): numerator and denominator narrow TOGETHER ─────────────────────────
  it('APPLIES-TO: the program narrowing lands on BOTH the denominator and the numerator outlet filter', async () => {
    mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...config, programs: ['RLP'], subPrograms: [] } });
    await service.gifsyReport(gifsy, '2026-07-P1');
    const denWhere = mockPrisma.outlet.count.mock.calls[0][0].where;
    const numWhere = mockPrisma.visibilityCapture.groupBy.mock.calls[0][0].where.outlet;
    expect(numWhere).toEqual(denWhere); // the invariant: same outlet universe on both sides
    expect(denWhere.AND[1]).toEqual({ AND: [{ OR: [{ programName: { equals: 'RLP', mode: 'insensitive' } }] }] });
    expect(denWhere.AND[0].outletType).toEqual({ code: { in: ['SSS'] } });
  });

  it('APPLIES-TO: empty programs/subPrograms → the exact pre-scope where on both sides', async () => {
    mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...config, programs: [], subPrograms: [] } });
    await service.gifsyReport(gifsy, '2026-07-P1');
    const denWhere = mockPrisma.outlet.count.mock.calls[0][0].where;
    expect(denWhere).toEqual({
      clientId: 't1', deletedAt: null, deactivatedAt: null,
      OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
      outletType: { code: { in: ['SSS'] } },
    });
    expect(mockPrisma.visibilityCapture.groupBy.mock.calls[0][0].where.outlet).toEqual(denWhere);
  });

  it('APPLIES-TO: report carries programs / subPrograms ONLY when non-empty (unscoped response unchanged)', async () => {
    mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...config, programs: [], subPrograms: [] } });
    const plain = await service.tenantReport(clientAdmin, '2026-07-P1');
    expect(Object.keys(plain).sort()).toEqual(['frequencyPerMonth', 'outletScope', 'summary', 'windowClosed', 'windowKey']);

    mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...config, programs: ['RLP'], subPrograms: [] } });
    const scoped = await service.tenantReport(clientAdmin, '2026-07-P1');
    expect(scoped).toMatchObject({ outletScope: ['SSS'], programs: ['RLP'] });
    expect(scoped).not.toHaveProperty('subPrograms');

    mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...config, subPrograms: ['Urban'] } });
    const sub = await service.tenantReport(clientAdmin, '2026-07-P1');
    expect(sub).toMatchObject({ subPrograms: ['Urban'] });
    expect(sub).not.toHaveProperty('programs');
  });

  describe('assertExportScope (report export 400s before any file)', () => {
    const now = new Date('2026-11-20T06:00:00Z');
    it('a window the monthly frequency does not have (P2) with no captures → 400', async () => {
      mockPrisma.visibilityCapture.count.mockResolvedValue(0);
      await expect(service.assertExportScope('t1', { windowKey: '2026-11-P2' }, now)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('the same window is allowed when captures exist for it (an older frequency)', async () => {
      mockPrisma.visibilityCapture.count.mockResolvedValue(3);
      await expect(service.assertExportScope('t1', { windowKey: '2026-11-P2' }, now)).resolves.toBeUndefined();
    });
    it('a future month / future window → 400; this month and past months are fine', async () => {
      mockPrisma.visibilityCapture.count.mockResolvedValue(0);
      await expect(service.assertExportScope('t1', { month: '2026-12' }, now)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.assertExportScope('t1', { windowKey: '2027-01-P1' }, now)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.assertExportScope('t1', { month: '2026-11' }, now)).resolves.toBeUndefined();
      await expect(service.assertExportScope('t1', { windowKey: '2026-10-P1' }, now)).resolves.toBeUndefined();
    });
  });
});
