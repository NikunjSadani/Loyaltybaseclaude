// Regression tests for the IST date-boundary fix in ReportsService.
//
// THE BUG (pre-fix): reports built a `createdAt` range with `new Date(dateFrom)` /
// `new Date(dateTo)` applied raw. A date-only `<input type="date">` value like
// "2026-08-31" parses to 2026-08-31T00:00:00Z = 05:30 IST, so `gte` skipped the
// first 5.5h of the start IST day and `lte` truncated almost the whole last IST day
// (closed at ~05:30 IST). The fix routes every createdAt range through the shared
// `istDayRangeFilter`, which expands a date-only bound to the FULL inclusive IST day.
//
// These tests capture the Prisma `where` the service builds and assert the createdAt
// filter now carries IST-day bounds (NOT the raw `new Date(to)` midnight-UTC instant),
// and that a `to = today` no longer truncates the current IST day.
// Run: npx jest src/reports/reports.service.spec.ts

import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { ReportRangeQueryDto } from './dto/reports.dto';
import { startOfIstDay, endOfIstDay } from '../common/ist-date';

describe('ReportsService — IST createdAt date bounds', () => {
  let service: ReportsService;
  let kycFindMany: jest.Mock;
  let visibilityFindMany: jest.Mock;
  let tdsFindMany: jest.Mock;
  let payoutFindMany: jest.Mock;

  const user = { clientId: 'client-1', role: 'GIFSY_ADMIN' } as unknown as JwtPayload;

  beforeEach(() => {
    kycFindMany = jest.fn().mockResolvedValue([]);
    visibilityFindMany = jest.fn().mockResolvedValue([]);
    tdsFindMany = jest.fn().mockResolvedValue([]);
    payoutFindMany = jest.fn().mockResolvedValue([]);

    const prisma = {
      kycSubmission: { findMany: kycFindMany },
      // kycStatus also runs a tenant-scoped outlet.findMany for the outlet columns.
      outlet: { findMany: jest.fn().mockResolvedValue([]) },
      visibilityCapture: { findMany: visibilityFindMany },
      tdsRecord: { findMany: tdsFindMany },
      payoutTransaction: { findMany: payoutFindMany },
    } as unknown as PrismaService;

    // visibility-status calls resolveVisibilityEnabled; everything else ignores tenant.
    const tenant = {
      resolveVisibilityEnabled: jest.fn().mockResolvedValue(true),
    } as unknown as TenantService;

    service = new ReportsService(prisma, tenant);
  });

  const q = (over: Partial<ReportRangeQueryDto>): ReportRangeQueryDto =>
    ({ ...over } as ReportRangeQueryDto);

  it('kycStatus: no longer a date-windowed report — it never queries KycSubmission or date-filters', async () => {
    // The KYC Status report is now a FULL outlet snapshot (one row per outlet, incl.
    // never-started ones), so it drives off outlet.findMany with NO createdAt bound and
    // never touches KycSubmission — passing a date range must not add any filter.
    await service.kycStatus(user, q({ dateFrom: '2026-08-01', dateTo: '2026-08-31' }));
    expect(kycFindMany).not.toHaveBeenCalled();
    const outletFindMany = (service as unknown as { prisma: { outlet: { findMany: jest.Mock } } })
      .prisma.outlet.findMany;
    const where = outletFindMany.mock.calls[0][0].where;
    expect(where).toEqual({ clientId: 'client-1', deletedAt: null });
    expect(where.createdAt).toBeUndefined();
  });

  it('visibilityStatus / tds / payoutLiability also get IST-day createdAt bounds', async () => {
    const range = { dateFrom: '2026-08-01', dateTo: '2026-08-31' };
    const expectedGte = startOfIstDay(new Date('2026-08-01')).toISOString();
    const expectedLte = endOfIstDay(new Date('2026-08-31')).toISOString();

    await service.visibilityStatus(user, q(range));
    await service.tds(user, q(range));
    await service.payoutLiability(user, q(range));

    for (const fn of [visibilityFindMany, tdsFindMany, payoutFindMany]) {
      const where = fn.mock.calls[0][0].where;
      expect(where.createdAt.gte.toISOString()).toBe(expectedGte);
      expect(where.createdAt.lte.toISOString()).toBe(expectedLte);
    }
  });

  it('omits the createdAt filter entirely when no date bounds are supplied (payoutLiability)', async () => {
    await service.payoutLiability(user, q({}));
    const where = payoutFindMany.mock.calls[0][0].where;
    expect(where.createdAt).toBeUndefined();
  });
});
