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
import { deriveKycStage } from '../common/kyc-rekyc.helper';

const mockPrisma = {
  visibilityCapture: { findMany: jest.fn() },
  scheme: { findMany: jest.fn() },
  tdsRecord: { findMany: jest.fn() },
  payoutTransaction: { findMany: jest.fn() },
  user: { count: jest.fn(), findMany: jest.fn() },
  userActivityDay: { findMany: jest.fn() },
  kycSubmission: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
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
    // kycStatus always runs a tenant-scoped outlet.findMany for the outlet columns;
    // default to no outlets so tests that don't care about enrichment still work.
    mockPrisma.outlet.findMany.mockResolvedValue([]);
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

  describe('kycStatus (outlet-driven full snapshot)', () => {
    // Build a tenant outlet row in the shape the outlet-driven report selects. `sub` (when
    // given) becomes the owner partner's single latest submission.
    const outletRow = (
      over: Partial<{
        zone: string | null;
        outletCode: string | null;
        name: string | null;
        programName: string | null;
        deactivatedAt: Date | null;
        kycIntent: string | null;
        partner: unknown;
      }> = {},
      sub?: {
        status: string;
        submittedAt: Date | null;
        createdAt: Date;
        id?: string;
        rejectionReason?: string | null;
        reviewerNotes?: string | null;
        reviewedAt?: Date | null;
        statusHistory?: {
          createdAt: Date;
          changedByUserId: string | null;
          fromStatus: string | null;
        }[];
      },
    ) => ({
      zone: 'West',
      outletCode: 'OUT-1',
      name: 'Acme Store',
      programName: 'Gold',
      deactivatedAt: null,
      kycIntent: null,
      partner: {
        ownerName: 'Owner One',
        phone: '900',
        businessName: 'Acme',
        panNumber: 'ABCDE1234F',
        kycSubmissions: sub ? [sub] : [],
      },
      ...over,
    });

    const rowsOf = (res: Awaited<ReturnType<ReportsService['kycStatus']>>) => {
      if (res.kind !== 'json') throw new Error('expected json');
      return (res.data as { data: Record<string, unknown>[] }).data;
    };

    it('drives off outlet.findMany, tenant-scoped + non-deleted (no kycSubmission query)', async () => {
      await service.kycStatus(gifsy, {});
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ clientId: 'deoleo', deletedAt: null });
      // The report no longer queries KycSubmission directly (a foreign-tenant outlet can
      // never appear because the outlet query itself is tenant-scoped above).
      expect(mockPrisma.kycSubmission.findMany).not.toHaveBeenCalled();
    });

    it('a never-submitted outlet appears with status "Not Started" and blank Last Submitted On', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([outletRow()]);
      const rows = rowsOf(await service.kycStatus(gifsy, {}));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        'S.No': 1,
        'Outlet ID': 'OUT-1',
        'Outlet Name': 'Acme Store',
        Zone: 'West',
        'Program Name': 'Gold',
        'Business Name': 'Acme',
        'Owner/User Name': 'Owner One',
        Mobile: '900',
        PAN: 'ABCDE1234F',
        Status: 'Not Started',
        'Last Submitted On': '',
        // The 5 rejection-detail columns are blank for any non-rejected row.
        'Rejected Stage': '',
        'Rejected By': '',
        'Rejection Reason': '',
        'Reviewer Notes': '',
        'Rejected On': '',
      });
    });

    it('an approved outlet shows Approved with Last Submitted On set', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        outletRow({}, {
          status: 'APPROVED',
          submittedAt: new Date('2026-02-01T00:00:00.000Z'),
          createdAt: new Date('2026-01-20T00:00:00.000Z'),
        }),
      ]);
      const rows = rowsOf(await service.kycStatus(gifsy, {}));
      expect(rows[0].Status).toBe('Approved');
      expect(rows[0]['Last Submitted On']).toBe('2026-02-01');
    });

    it('falls back to the submission createdAt for Last Submitted On when submittedAt is null (DRAFT)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        outletRow({}, {
          status: 'DRAFT',
          submittedAt: null,
          createdAt: new Date('2026-03-05T00:00:00.000Z'),
        }),
      ]);
      const rows = rowsOf(await service.kycStatus(gifsy, {}));
      expect(rows[0].Status).toBe('In Progress');
      expect(rows[0]['Last Submitted On']).toBe('2026-03-05');
    });

    it('a NOT_INTERESTED outlet shows its state (overlay wins over any submission)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        outletRow({ kycIntent: 'NOT_INTERESTED' }),
      ]);
      const rows = rowsOf(await service.kycStatus(gifsy, {}));
      expect(rows[0].Status).toBe('Not Interested');
    });

    it('a deactivated outlet shows Deactivated even with an APPROVED submission', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        outletRow({ deactivatedAt: new Date('2026-02-10T00:00:00.000Z') }, {
          status: 'APPROVED',
          submittedAt: new Date('2026-02-01T00:00:00.000Z'),
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
        }),
      ]);
      const rows = rowsOf(await service.kycStatus(gifsy, {}));
      expect(rows[0].Status).toBe('Deactivated');
    });

    it('emits exactly one row per outlet with sequential S.No', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        outletRow({ outletCode: 'OUT-1' }),
        outletRow({ outletCode: 'OUT-2' }, {
          status: 'PENDING_GIFSY',
          submittedAt: new Date('2026-02-02T00:00:00.000Z'),
          createdAt: new Date('2026-02-02T00:00:00.000Z'),
        }),
        outletRow({ outletCode: 'OUT-3', kycIntent: 'PARKED' }),
      ]);
      const rows = rowsOf(await service.kycStatus(gifsy, {}));
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r['S.No'])).toEqual([1, 2, 3]);
      expect(rows.map((r) => r['Outlet ID'])).toEqual(['OUT-1', 'OUT-2', 'OUT-3']);
      expect(rows.map((r) => r.Status)).toEqual(['Not Started', 'Pending Gifsy', 'Parked']);
    });

    it('ignores dateFrom/dateTo — the row set is identical with or without a date range', async () => {
      const fixture = [
        outletRow({ outletCode: 'OUT-1' }),
        outletRow({ outletCode: 'OUT-2' }, {
          status: 'APPROVED',
          submittedAt: new Date('2020-01-01T00:00:00.000Z'),
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
        }),
      ];
      mockPrisma.outlet.findMany.mockResolvedValue(fixture);
      const noRange = rowsOf(await service.kycStatus(gifsy, {}));
      mockPrisma.outlet.findMany.mockResolvedValue(fixture);
      const withRange = rowsOf(
        await service.kycStatus(gifsy, { dateFrom: '2026-02-01', dateTo: '2026-02-28' }),
      );
      expect(withRange).toEqual(noRange);
      // The outlet query where-clause never carries a createdAt/date bound.
      const where = mockPrisma.outlet.findMany.mock.calls.at(-1)![0].where;
      expect(where).toEqual({ clientId: 'deoleo', deletedAt: null });
    });

    it('empty tenant → valid xlsx buffer, no throw', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      const res = await service.kycStatus(gifsy, { format: ReportFormat.XLSX });
      expect(res.kind).toBe('xlsx');
      if (res.kind === 'xlsx') {
        expect(res.filename).toBe('kyc-status.xlsx');
        expect(Buffer.isBuffer(res.buffer)).toBe(true);
        expect(res.buffer.length).toBeGreaterThan(0);
      }
    });

    // Parity: the report's Status for an in-pipeline outlet (no lifecycle overlay) is
    // EXACTLY the shared canonical derivation deriveKycStage(latest status).
    it.each([
      ['SUBMITTED', 'Submitted (field approval)'],
      ['PENDING_ASM_APPROVAL', 'Submitted (field approval)'],
      ['PENDING_GIFSY', 'Pending Gifsy'],
      ['APPROVED', 'Approved'],
      ['REJECTED', 'Rejected'],
      ['RE_UPLOAD_REQUIRED', 'Re-upload'],
      ['DRAFT', 'In Progress'],
    ])('report Status for latest=%s equals deriveKycStage → %s', async (status, expected) => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        outletRow({}, {
          status,
          submittedAt: new Date('2026-02-01T00:00:00.000Z'),
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
        }),
      ]);
      const rows = rowsOf(await service.kycStatus(gifsy, {}));
      expect(rows[0].Status).toBe(expected);
      expect(rows[0].Status).toBe(deriveKycStage(status as never));
    });

    describe('rejection-detail columns (populated only for currently-Rejected rows)', () => {
      it('a Gifsy-stage rejection fills all 5 columns (stage=Gifsy, By=name + Gifsy Admin)', async () => {
        mockPrisma.outlet.findMany.mockResolvedValue([
          outletRow({}, {
            status: 'REJECTED',
            submittedAt: new Date('2026-02-01T00:00:00.000Z'),
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
            id: 'sub-1',
            rejectionReason: 'PAN mismatch; Bank proof unclear',
            reviewerNotes: 'Ask partner to re-upload PAN card',
            reviewedAt: new Date('2026-02-05T09:00:00.000Z'),
            statusHistory: [
              {
                createdAt: new Date('2026-02-05T09:00:00.000Z'),
                changedByUserId: 'U-gifsy',
                fromStatus: 'PENDING_GIFSY',
              },
            ],
          }),
        ]);
        mockPrisma.user.findMany.mockResolvedValue([
          { id: 'U-gifsy', name: 'Gifsy Admin', role: 'GIFSY_ADMIN' },
        ]);

        const rows = rowsOf(await service.kycStatus(gifsy, {}));
        expect(rows[0].Status).toBe('Rejected');
        expect(rows[0]['Rejected Stage']).toBe('Gifsy');
        expect(rows[0]['Rejected By']).toBe('Gifsy Admin (Gifsy Admin)');
        expect(rows[0]['Rejection Reason']).toBe('PAN mismatch; Bank proof unclear');
        expect(rows[0]['Reviewer Notes']).toBe('Ask partner to re-upload PAN card');
        expect(rows[0]['Rejected On']).toBe('2026-02-05');
      });

      it('a Field-stage rejection classifies as Field and labels the sales role (ASM)', async () => {
        mockPrisma.outlet.findMany.mockResolvedValue([
          outletRow({}, {
            status: 'REJECTED',
            submittedAt: new Date('2026-03-01T00:00:00.000Z'),
            createdAt: new Date('2026-03-01T00:00:00.000Z'),
            id: 'sub-2',
            rejectionReason: 'Address proof missing',
            reviewerNotes: null,
            reviewedAt: new Date('2026-03-03T00:00:00.000Z'),
            statusHistory: [
              {
                createdAt: new Date('2026-03-03T11:30:00.000Z'),
                changedByUserId: 'U-asm',
                fromStatus: 'PENDING_ASM_APPROVAL',
              },
            ],
          }),
        ]);
        mockPrisma.user.findMany.mockResolvedValue([
          { id: 'U-asm', name: 'Ramesh Kumar', role: 'SALES_ASM' },
        ]);

        const rows = rowsOf(await service.kycStatus(gifsy, {}));
        expect(rows[0]['Rejected Stage']).toBe('Field');
        expect(rows[0]['Rejected By']).toBe('Ramesh Kumar (ASM)');
        expect(rows[0]['Rejection Reason']).toBe('Address proof missing');
        expect(rows[0]['Reviewer Notes']).toBe('');
        expect(rows[0]['Rejected On']).toBe('2026-03-03');
      });

      it('a non-rejected (Approved) outlet leaves all 5 rejection columns blank', async () => {
        mockPrisma.outlet.findMany.mockResolvedValue([
          outletRow({}, {
            status: 'APPROVED',
            submittedAt: new Date('2026-02-01T00:00:00.000Z'),
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
            id: 'sub-3',
            // Even if stray rejection fields/history exist, a non-Rejected status blanks them.
            rejectionReason: 'should not surface',
            reviewerNotes: 'should not surface',
            reviewedAt: new Date('2026-02-05T00:00:00.000Z'),
            statusHistory: [
              { createdAt: new Date('2026-02-05T00:00:00.000Z'), changedByUserId: 'U-x', fromStatus: 'PENDING_GIFSY' },
            ],
          }),
        ]);
        mockPrisma.user.findMany.mockResolvedValue([{ id: 'U-x', name: 'X', role: 'GIFSY_ADMIN' }]);

        const rows = rowsOf(await service.kycStatus(gifsy, {}));
        expect(rows[0].Status).toBe('Approved');
        expect(rows[0]['Rejected Stage']).toBe('');
        expect(rows[0]['Rejected By']).toBe('');
        expect(rows[0]['Rejection Reason']).toBe('');
        expect(rows[0]['Reviewer Notes']).toBe('');
        expect(rows[0]['Rejected On']).toBe('');
      });

      it('resolves all rejecters in a SINGLE user.findMany (no N+1) across many rejected rows', async () => {
        mockPrisma.outlet.findMany.mockResolvedValue([
          outletRow({ outletCode: 'OUT-1' }, {
            status: 'REJECTED', submittedAt: new Date('2026-02-01T00:00:00.000Z'), createdAt: new Date('2026-02-01T00:00:00.000Z'),
            id: 's1', rejectionReason: 'r1', reviewerNotes: null, reviewedAt: new Date('2026-02-02T00:00:00.000Z'),
            statusHistory: [{ createdAt: new Date('2026-02-02T00:00:00.000Z'), changedByUserId: 'U-a', fromStatus: 'PENDING_GIFSY' }],
          }),
          outletRow({ outletCode: 'OUT-2' }, {
            status: 'REJECTED', submittedAt: new Date('2026-02-01T00:00:00.000Z'), createdAt: new Date('2026-02-01T00:00:00.000Z'),
            id: 's2', rejectionReason: 'r2', reviewerNotes: null, reviewedAt: new Date('2026-02-02T00:00:00.000Z'),
            statusHistory: [{ createdAt: new Date('2026-02-02T00:00:00.000Z'), changedByUserId: 'U-b', fromStatus: 'PENDING_ASM_APPROVAL' }],
          }),
        ]);
        mockPrisma.user.findMany.mockResolvedValue([
          { id: 'U-a', name: 'Alice', role: 'GIFSY_ADMIN' },
          { id: 'U-b', name: 'Bob', role: 'SALES_ASM' },
        ]);

        const rows = rowsOf(await service.kycStatus(gifsy, {}));
        expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
        // The one lookup is scoped to exactly the distinct actor ids.
        const where = mockPrisma.user.findMany.mock.calls[0][0].where;
        expect(where.id.in.sort()).toEqual(['U-a', 'U-b']);
        expect(rows[0]['Rejected By']).toBe('Alice (Gifsy Admin)');
        expect(rows[1]['Rejected By']).toBe('Bob (ASM)');
      });

      it('a Deactivated outlet whose latest submission is REJECTED shows Deactivated with all 5 rejection columns blank (lifecycle overlay wins → no rejection-detail leak)', async () => {
        mockPrisma.outlet.findMany.mockResolvedValue([
          outletRow({ deactivatedAt: new Date('2026-02-10T00:00:00.000Z') }, {
            status: 'REJECTED',
            submittedAt: new Date('2026-02-01T00:00:00.000Z'),
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
            id: 'sub-deact',
            rejectionReason: 'must not surface on a deactivated row',
            reviewerNotes: 'must not surface',
            reviewedAt: new Date('2026-02-05T00:00:00.000Z'),
            statusHistory: [
              { createdAt: new Date('2026-02-05T00:00:00.000Z'), changedByUserId: 'U-g', fromStatus: 'PENDING_GIFSY' },
            ],
          }),
        ]);
        mockPrisma.user.findMany.mockResolvedValue([{ id: 'U-g', name: 'G', role: 'GIFSY_ADMIN' }]);

        const rows = rowsOf(await service.kycStatus(gifsy, {}));
        expect(rows[0].Status).toBe('Deactivated');
        expect(rows[0]['Rejected Stage']).toBe('');
        expect(rows[0]['Rejected By']).toBe('');
        expect(rows[0]['Rejection Reason']).toBe('');
        expect(rows[0]['Reviewer Notes']).toBe('');
        expect(rows[0]['Rejected On']).toBe('');
      });

      it('a Rejected row with no rejection history / unresolved actor degrades cleanly (By + Stage blank, Reason/Notes/Date still from the submission)', async () => {
        mockPrisma.outlet.findMany.mockResolvedValue([
          outletRow({}, {
            status: 'REJECTED',
            submittedAt: new Date('2026-04-01T00:00:00.000Z'),
            createdAt: new Date('2026-04-01T00:00:00.000Z'),
            id: 'sub-old',
            rejectionReason: 'Legacy rejection (pre-history)',
            reviewerNotes: 'Fix and resubmit',
            reviewedAt: new Date('2026-04-03T00:00:00.000Z'),
            statusHistory: [], // older data: no recorded REJECTED transition
          }),
        ]);
        mockPrisma.user.findMany.mockResolvedValue([]);

        const rows = rowsOf(await service.kycStatus(gifsy, {}));
        expect(rows[0].Status).toBe('Rejected');
        expect(rows[0]['Rejected By']).toBe('');
        expect(rows[0]['Rejected Stage']).toBe('');
        expect(rows[0]['Rejection Reason']).toBe('Legacy rejection (pre-history)');
        expect(rows[0]['Reviewer Notes']).toBe('Fix and resubmit');
        expect(rows[0]['Rejected On']).toBe('2026-04-03'); // falls back to reviewedAt when no history row
      });
    });
  });
});
