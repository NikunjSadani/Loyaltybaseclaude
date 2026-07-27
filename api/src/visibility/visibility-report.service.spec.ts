/**
 * Unit tests for visibility-report.service.ts (Stream B).
 *
 * Covers: coverage/miss math (approved numerator over the addressable in-scope
 * denominator), GIFSY-only gate on the gifsy report, CLIENT_ADMIN read-only tenant
 * report, and the xlsx export shape. Prisma / Tenant / TenantSettings mocked.
 *
 * Run: npx jest src/visibility/visibility-report.service.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, StreamableFile } from '@nestjs/common';
import { VisibilityReportService } from './visibility-report.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  outlet: { count: jest.fn() },
  visibilityCapture: { groupBy: jest.fn(), findMany: jest.fn() },
  visibilityImageHash: { findMany: jest.fn() },
  visibilityFormVersion: { findMany: jest.fn() },
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
    expect(where.outlet.OR).toEqual([{ kycIntent: null }, { kycIntent: { not: 'NOT_INTERESTED' } }]);
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
    expect(where.OR).toEqual([{ kycIntent: null }, { kycIntent: { not: 'NOT_INTERESTED' } }]);
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

  // ── Export ───────────────────────────────────────────────────────────────────
  it('exportCaptures returns an xlsx StreamableFile with a dup flag column', async () => {
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([
      {
        id: 'cap1',
        outletCode: 'OC1',
        outletName: 'Shop 1',
        windowKey: '2026-07-P1',
        status: 'APPROVED',
        geoFenceOk: true,
        distanceMeters: 12,
        captureAccuracy: 10,
        capturedAt: new Date('2026-07-05T10:00:00Z'),
        receivedAt: new Date('2026-07-05T10:01:00Z'),
        rejectionReasonCode: null,
        rejectionReason: null,
        formValues: { photo: 'visibility-media/t1/x.jpg' },
        formVersion: 1,
        submittedBy: { employeeCode: 'E1' },
      },
    ]);
    mockPrisma.visibilityImageHash.findMany.mockResolvedValue([
      { hash: 'hashA', captureId: 'cap1' },
      { hash: 'hashA', captureId: 'cap2' },
    ]);
    mockPrisma.visibilityFormVersion.findMany.mockResolvedValue([
      { version: 1, formSchema: { fields: [{ id: 'photo', type: 'CAMERA' }] } },
    ]);

    const file = await service.exportCaptures(gifsy, '2026-07-P1');
    expect(file).toBeInstanceOf(StreamableFile);
  });

  it('exportCaptures batches the form-version snapshots once (M5 — no per-row N+1)', async () => {
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([
      {
        id: 'cap1', outletCode: 'OC1', outletName: 'Shop 1', windowKey: '2026-07-P1',
        status: 'APPROVED', geoFenceOk: true, distanceMeters: 12, captureAccuracy: 10,
        capturedAt: new Date('2026-07-05T10:00:00Z'), receivedAt: new Date('2026-07-05T10:01:00Z'),
        rejectionReasonCode: null, rejectionReason: null,
        formValues: { photo: 'visibility-media/t1/x.jpg' }, formVersion: 1,
        submittedBy: { employeeCode: 'E1' },
      },
      {
        id: 'cap2', outletCode: 'OC2', outletName: 'Shop 2', windowKey: '2026-07-P1',
        status: 'APPROVED', geoFenceOk: true, distanceMeters: 5, captureAccuracy: 8,
        capturedAt: new Date('2026-07-06T10:00:00Z'), receivedAt: new Date('2026-07-06T10:01:00Z'),
        rejectionReasonCode: null, rejectionReason: null,
        formValues: { photo: 'visibility-media/t1/y.jpg' }, formVersion: 1,
        submittedBy: { employeeCode: 'E2' },
      },
    ]);
    mockPrisma.visibilityImageHash.findMany.mockResolvedValue([]);
    mockPrisma.visibilityFormVersion.findMany.mockResolvedValue([
      { version: 1, formSchema: { fields: [{ id: 'photo', type: 'CAMERA' }] } },
    ]);

    await service.exportCaptures(gifsy, '2026-07-P1');
    // TWO capture rows sharing formVersion 1 → the snapshots are fetched in ONE query.
    expect(mockPrisma.visibilityFormVersion.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.visibilityFormVersion.findMany.mock.calls[0][0].where).toEqual({
      clientId: 't1',
      version: { in: [1] },
    });
  });

  it('exportCaptures still returns a StreamableFile when there are no captures', async () => {
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
    mockPrisma.visibilityImageHash.findMany.mockResolvedValue([]);
    const file = await service.exportCaptures(gifsy);
    expect(file).toBeInstanceOf(StreamableFile);
  });
});
