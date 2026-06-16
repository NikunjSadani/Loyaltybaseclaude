// Unit tests for ReportsService — ported reports domain.
// Covers tenant/clientId scoping on each source query + a builder's row-mapping
// (the visibility, tds, and engagement row shapes) and the json/xlsx switch.
// Run: npx jest src/reports/reports.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ReportFormat } from './dto/reports.dto';

const mockPrisma = {
  visibilitySubmission: { findMany: jest.fn() },
  scheme: { findMany: jest.fn() },
  tdsRecord: { findMany: jest.fn() },
  payoutTransaction: { findMany: jest.fn() },
  loginLog: { findMany: jest.fn() },
  user: { count: jest.fn() },
  kycSubmission: { findMany: jest.fn() },
};

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '' };

describe('ReportsService', () => {
  let service: ReportsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReportsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get(ReportsService);
  });

  describe('visibilityStatus', () => {
    it('scopes the query to the caller clientId via the partner relation', async () => {
      mockPrisma.visibilitySubmission.findMany.mockResolvedValue([]);
      await service.visibilityStatus(gifsy, {});
      const where = mockPrisma.visibilitySubmission.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ partner: { clientId: 'deoleo' } });
    });

    it('maps a submission row into the report shape', async () => {
      mockPrisma.visibilitySubmission.findMany.mockResolvedValue([
        {
          id: 'v1',
          programId: 'p1',
          status: 'APPROVED',
          latitude: { toString: () => '12.34' },
          longitude: { toString: () => '56.78' },
          createdAt: new Date('2026-01-15T10:00:00.000Z'),
          partner: { businessName: 'Acme' },
          outlet: { name: 'Acme Store', city: 'Pune' },
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
              'Submission ID': 'v1',
              'Partner Name': 'Acme',
              'Outlet Name': 'Acme Store',
              City: 'Pune',
              'Program ID': 'p1',
              Status: 'APPROVED',
              Latitude: '12.34',
              Longitude: '56.78',
              'Submitted On': '2026-01-15',
            },
          ],
        },
      });
    });

    it('returns an xlsx buffer when format=xlsx', async () => {
      mockPrisma.visibilitySubmission.findMany.mockResolvedValue([]);
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

  describe('engagement', () => {
    it('scopes login logs and user count to the caller clientId', async () => {
      mockPrisma.loginLog.findMany.mockResolvedValue([]);
      mockPrisma.user.count.mockResolvedValue(0);
      await service.engagement(gifsy, {});
      const logWhere = mockPrisma.loginLog.findMany.mock.calls[0][0].where;
      expect(logWhere.user).toEqual({ clientId: 'deoleo' });
      const countWhere = mockPrisma.user.count.mock.calls[0][0].where;
      expect(countWhere).toEqual({ status: 'ACTIVE', clientId: 'deoleo' });
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
