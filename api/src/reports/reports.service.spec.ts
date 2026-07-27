// Unit tests for ReportsService — ported reports domain.
// Covers tenant/clientId scoping on each source query + a builder's row-mapping
// (the visibility, tds, and engagement row shapes) and the json/xlsx switch.
// Run: npx jest src/reports/reports.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ReportFormat } from './dto/reports.dto';

const mockPrisma = {
  visibilityCapture: { findMany: jest.fn() },
  scheme: { findMany: jest.fn() },
  tdsRecord: { findMany: jest.fn() },
  payoutTransaction: { findMany: jest.fn() },
  user: { count: jest.fn(), findMany: jest.fn() },
  userActivityDay: { findMany: jest.fn() },
  kycSubmission: { findMany: jest.fn() },
};

// visibilityStatus is master-gated; default ON so the existing scoping tests run.
const mockTenant = {
  resolveVisibilityEnabled: jest.fn().mockResolvedValue(true),
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };

describe('ReportsService', () => {
  let service: ReportsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  describe('visibilityStatus', () => {
    it('scopes the query to the caller clientId', async () => {
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
      await service.visibilityStatus(gifsy, {});
      const where = mockPrisma.visibilityCapture.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ clientId: 'deoleo' });
    });

    it('403s a tenant MIS user when visibility is OFF — no capture read', async () => {
      mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
      const mis: JwtPayload = { sub: 'm1', role: 'MIS_USER', clientId: 'deoleo', phone: '', name: '' };
      await expect(service.visibilityStatus(mis, {})).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.visibilityCapture.findMany).not.toHaveBeenCalled();
    });

    it('maps a capture row into the report shape', async () => {
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([
        {
          id: 'v1',
          outletCode: 'OUT-1',
          outletName: 'Acme Store',
          windowKey: '2026-01',
          status: 'APPROVED',
          captureLat: { toString: () => '12.34' },
          captureLng: { toString: () => '56.78' },
          geoFenceOk: true,
          createdAt: new Date('2026-01-15T10:00:00.000Z'),
          outlet: { name: 'Acme Store', city: 'Pune' },
          submittedBy: { employeeCode: 'E-1', user: { name: 'Rep One' } },
        },
      ]);
      const res = await service.visibilityStatus(gifsy, {});
      expect(res).toEqual({
        kind: 'json',
        data: {
          recordCount: 1,
          data: [
            {
              'S.No': 1,
              'Capture ID': 'v1',
              'Outlet Code': 'OUT-1',
              'Outlet Name': 'Acme Store',
              City: 'Pune',
              Window: '2026-01',
              Status: 'APPROVED',
              'Captured By': 'Rep One',
              Latitude: '12.34',
              Longitude: '56.78',
              'Geo-fence': 'ok',
              'Submitted On': '2026-01-15',
            },
          ],
        },
      });
    });

    it('returns an xlsx buffer when format=xlsx', async () => {
      mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
      const res = await service.visibilityStatus(gifsy, { format: ReportFormat.XLSX });
      expect(res.kind).toBe('xlsx');
      if (res.kind === 'xlsx') {
        expect(res.filename).toBe('visibility-status.xlsx');
        expect(Buffer.isBuffer(res.buffer)).toBe(true);
      }
    });
  });

  describe('schemePerformance', () => {
    it('scopes to clientId, excludes soft-deleted, and applies date bounds', async () => {
      mockPrisma.scheme.findMany.mockResolvedValue([]);
      await service.schemePerformance(gifsy, { dateFrom: '2026-01-01', dateTo: '2026-03-31' });
      const where = mockPrisma.scheme.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe('deoleo');
      expect(where.deletedAt).toBeNull();
      expect(where.startDate).toEqual({ gte: new Date('2026-01-01') });
      expect(where.endDate).toEqual({ lte: new Date('2026-03-31') });
    });
  });

  describe('tds', () => {
    it('scopes via payoutTransaction.batch.clientId and aggregates by PAN', async () => {
      mockPrisma.tdsRecord.findMany.mockResolvedValue([
        { panNumber: 'ABCDE1234F', partnerId: 'pa1', tdsPaise: 1000, tdsRate: 0.1, assessmentYear: '2025-26', quarterPeriod: 'Q1', createdAt: new Date('2026-02-01T00:00:00.000Z') },
        { panNumber: 'ABCDE1234F', partnerId: 'pa1', tdsPaise: 500, tdsRate: 0.1, assessmentYear: '2025-26', quarterPeriod: 'Q1', createdAt: new Date('2026-02-02T00:00:00.000Z') },
      ]);
      const res = await service.tds(gifsy, {});
      const where = mockPrisma.tdsRecord.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ payoutTransaction: { batch: { clientId: 'deoleo' } } });
      if (res.kind === 'json') {
        const data = res.data as { panSummary: unknown[] };
        expect(data.panSummary).toEqual([
          { PAN: 'ABCDE1234F', 'Transaction Count': 2, 'Total TDS (₹)': '15.00' },
        ]);
      }
    });

    it('adds an assessmentYear filter when fy is supplied', async () => {
      mockPrisma.tdsRecord.findMany.mockResolvedValue([]);
      await service.tds(gifsy, { fy: '2024-25' });
      const where = mockPrisma.tdsRecord.findMany.mock.calls[0][0].where;
      expect(where.assessmentYear).toBe('2024-25');
    });
  });

  describe('payoutLiability', () => {
    it('filters PENDING transactions scoped by batch.clientId and sums liability', async () => {
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        { amountPaise: 10000, payoutMode: 'UPI', status: 'PENDING', createdAt: new Date('2026-01-10T00:00:00.000Z'), partner: { businessName: 'Acme' }, batch: { batchCode: 'B1' } },
      ]);
      const res = await service.payoutLiability(gifsy, {});
      const where = mockPrisma.payoutTransaction.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ status: 'PENDING', batch: { clientId: 'deoleo' } });
      if (res.kind === 'json') {
        expect((res.data as { totalLiability: number }).totalLiability).toBe(100);
      }
    });
  });

  describe('sessionReport', () => {
    /** Current IST month as 'YYYY-MM' (fixed UTC+5:30), computed the same way as the service. */
    const currentIstYm = (): string => {
      const d = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };

    it('scopes the user query to the caller clientId and excludes soft-deleted', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      // No tenant users → activity query must be skipped entirely.
      await service.sessionReport(gifsy, {});
      const where = mockPrisma.user.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ clientId: 'deoleo', deletedAt: null });
      expect(mockPrisma.userActivityDay.findMany).not.toHaveBeenCalled();
    });

    it('produces a 13-month window oldest→newest with the current IST month last', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      const res = await service.sessionReport(gifsy, {});
      expect(res.kind).toBe('json');
      if (res.kind === 'json') {
        const data = res.data as { months: { ym: string; label: string }[]; timezone: string };
        expect(data.timezone).toBe('Asia/Kolkata');
        expect(data.months).toHaveLength(13);
        // Strictly increasing 'YYYY-MM' ⇒ oldest→newest ordering.
        const yms = data.months.map((m) => m.ym);
        const sorted = [...yms].sort();
        expect(yms).toEqual(sorted);
        // Last bucket = current IST month; label uses the hardcoded 3-letter month.
        expect(yms[yms.length - 1]).toBe(currentIstYm());
        expect(data.months[12].label).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
      }
    });

    it('scopes activity by tenant userIds (not clientId) and counts active days per month', async () => {
      const cur = currentIstYm();
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'u1', name: 'Alice', phone: '900', role: 'XSR', lastLoginAt: new Date('2026-06-20T08:30:00.000Z') },
      ]);
      // Two days in the current month + one day in the prior month.
      const [y, m] = cur.split('-').map(Number);
      const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
      mockPrisma.userActivityDay.findMany.mockResolvedValue([
        { userId: 'u1', activityDate: new Date(`${cur}-01T00:00:00.000Z`) },
        { userId: 'u1', activityDate: new Date(`${cur}-02T00:00:00.000Z`) },
        { userId: 'u1', activityDate: new Date(`${prev}-15T00:00:00.000Z`) },
      ]);
      const res = await service.sessionReport(gifsy, {});
      // Activity scoped by userId IN, NOT by clientId.
      const actWhere = mockPrisma.userActivityDay.findMany.mock.calls[0][0].where;
      expect(actWhere.userId).toEqual({ in: ['u1'] });
      expect(actWhere.clientId).toBeUndefined();
      expect(actWhere.activityDate.gte).toBeInstanceOf(Date);
      if (res.kind === 'json') {
        const data = res.data as { rows: { activeDays: Record<string, number> }[] };
        expect(data.rows[0].activeDays[cur]).toBe(2);
        expect(data.rows[0].activeDays[prev]).toBe(1);
      }
    });

    it('shows an empty activeDays map for a user with no activity, and surfaces lastLoginAt', async () => {
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'u2', name: 'Bob', phone: '901', role: 'SO', lastLoginAt: new Date('2026-06-21T10:15:00.000Z') },
      ]);
      mockPrisma.userActivityDay.findMany.mockResolvedValue([]);
      const res = await service.sessionReport(gifsy, {});
      if (res.kind === 'json') {
        const data = res.data as { rows: { lastLoginAt: string | null; activeDays: Record<string, number> }[] };
        expect(data.rows[0].activeDays).toEqual({});
        expect(data.rows[0].lastLoginAt).toBe('2026-06-21T10:15:00.000Z');
      }
    });

    it('null lastLoginAt surfaces as null in JSON', async () => {
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'u3', name: 'Cara', phone: '902', role: 'ISR', lastLoginAt: null },
      ]);
      mockPrisma.userActivityDay.findMany.mockResolvedValue([]);
      const res = await service.sessionReport(gifsy, {});
      if (res.kind === 'json') {
        const data = res.data as { rows: { lastLoginAt: string | null }[] };
        expect(data.rows[0].lastLoginAt).toBeNull();
      }
    });

    it('returns an xlsx buffer with one month column per bucket when format=xlsx', async () => {
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'u4', name: 'Dan', phone: '903', role: 'XSR', lastLoginAt: null },
      ]);
      mockPrisma.userActivityDay.findMany.mockResolvedValue([]);
      const res = await service.sessionReport(gifsy, { format: ReportFormat.XLSX });
      expect(res.kind).toBe('xlsx');
      if (res.kind === 'xlsx') {
        expect(res.filename).toBe('session-report.xlsx');
        expect(Buffer.isBuffer(res.buffer)).toBe(true);
      }
    });
  });

  describe('kycStatus', () => {
    it('scopes via the user relation clientId', async () => {
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      await service.kycStatus(gifsy, {});
      const where = mockPrisma.kycSubmission.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ user: { clientId: 'deoleo' } });
    });
  });
});
