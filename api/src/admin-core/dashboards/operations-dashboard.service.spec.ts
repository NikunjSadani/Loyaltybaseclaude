// Unit tests for OperationsDashboardService.
// Run: npx jest src/admin-core/dashboards/operations-dashboard.service.spec.ts
//
// Covers the load-bearing math/branches:
//  • payout success/failure rate + division-by-zero guard
//  • latency mean grouped by payoutMode
//  • ticket OPEN grouping + MTTR + SLA-compliance /0 → 100 + age buckets
//  • visibility DISABLED → null  vs  ENABLED → funnel counts/rates
//  • settlement latency (manual redemptionOrder join)

import { Test, TestingModule } from '@nestjs/testing';
import { OperationsDashboardService } from './operations-dashboard.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantService } from '../../tenant/tenant.service';
import { TenantSettingsService } from '../../tenant/tenant-settings.service';
import { PayoutsService } from '../../payouts/payouts.service';
import { JwtPayload } from '../../common/decorators/current-user.decorator';

const HOUR = 1000 * 60 * 60;
const base = new Date('2026-06-27T00:00:00.000Z');
const plusH = (h: number) => new Date(base.getTime() + h * HOUR);

const mockPrisma = {
  payoutTransaction: {
    groupBy: jest.fn(),
    aggregate: jest.fn(),
    findMany: jest.fn(),
  },
  ticket: {
    groupBy: jest.fn(),
    findMany: jest.fn(),
  },
  visibilityCapture: {
    groupBy: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
  },
  visibilityImageHash: { findMany: jest.fn() },
  visibilityFormVersion: { findMany: jest.fn() },
  visibilityForm: { findUnique: jest.fn() },
  client: { findUnique: jest.fn() },
  kycSubmission: { findMany: jest.fn() },
  outlet: { count: jest.fn() },
  redemptionOrder: { findMany: jest.fn() },
};

const mockTenant = {
  resolveClient: jest.fn().mockResolvedValue({
    slug: 'deoleo',
    name: 'Deoleo',
    branding: { displayName: 'Deoleo' },
  }),
  resolveVisibilityCaptureMode: jest.fn().mockResolvedValue('AMOUNT_UPLOAD'),
};
const mockTenantSettings = {
  getVisibilityEnabledUncached: jest.fn().mockResolvedValue(false),
  getEffectiveSettings: jest.fn(),
};
const mockPayouts = {};

const user: JwtPayload = {
  sub: 'admin1',
  role: 'GIFSY_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

/** Default happy-path stubs; individual tests override what they assert on. */
function primeDefaults() {
  // payouts
  mockPrisma.payoutTransaction.groupBy.mockResolvedValue([
    { status: 'SUCCESS', _count: { _all: 8 } },
    { status: 'FAILED', _count: { _all: 1 } },
    { status: 'REVERSED', _count: { _all: 1 } },
    { status: 'PENDING', _count: { _all: 5 } },
    { status: 'INITIATED', _count: { _all: 3 } },
    { status: 'PROCESSING', _count: { _all: 2 } },
    { status: 'HOLD', _count: { _all: 1 } },
  ]);
  mockPrisma.payoutTransaction.aggregate.mockResolvedValue({
    _sum: { netAmountPaise: 1_000_00n }, // ₹1,000 across pending bucket
  });
  // Two distinct payoutTransaction.findMany calls run concurrently (buildPayouts latency +
  // buildSettlement); their dispatch order is timing-dependent, so route by query shape
  // rather than call order. Settlement filters on redemptionOrderId; latency does not.
  mockPrisma.payoutTransaction.findMany.mockImplementation((args: { where?: { redemptionOrderId?: unknown } }) => {
    if (args?.where && 'redemptionOrderId' in args.where) {
      // settlement: two terminal txns referencing redemption orders
      return Promise.resolve([
        { completedAt: plusH(6), redemptionOrderId: 'ro1' },
        { completedAt: plusH(12), redemptionOrderId: 'ro2' },
      ]);
    }
    // latency txns: UPI 2h & 4h (avg 3); BANK_TRANSFER 10h (avg 10)
    return Promise.resolve([
      { payoutMode: 'UPI', createdAt: base, completedAt: plusH(2) },
      { payoutMode: 'UPI', createdAt: base, completedAt: plusH(4) },
      { payoutMode: 'BANK_TRANSFER', createdAt: base, completedAt: plusH(10) },
    ]);
  });
  mockPrisma.redemptionOrder.findMany.mockResolvedValue([
    { id: 'ro1', createdAt: base }, // 6h
    { id: 'ro2', createdAt: base }, // 12h → avg 9h
  ]);

  // tickets
  mockPrisma.ticket.groupBy.mockImplementation(({ by }: { by: string[] }) => {
    if (by[0] === 'status') {
      return Promise.resolve([
        { status: 'OPEN', _count: { _all: 4 } },
        { status: 'IN_PROGRESS', _count: { _all: 2 } },
        { status: 'PENDING_USER', _count: { _all: 1 } },
        { status: 'ESCALATED', _count: { _all: 1 } },
        { status: 'RESOLVED', _count: { _all: 3 } },
        { status: 'CLOSED', _count: { _all: 2 } },
      ]);
    }
    if (by[0] === 'priority') {
      return Promise.resolve([
        { priority: 'HIGH', _count: { _all: 3 } },
        { priority: 'LOW', _count: { _all: 5 } },
      ]);
    }
    return Promise.resolve([
      { category: 'PAYOUT', _count: { _all: 6 } },
      { category: 'KYC', _count: { _all: 2 } },
    ]);
  });
  // ticket.findMany is called 4x in order: resolved(MTTR), firstResponse, terminal(SLA), open(age)
  mockPrisma.ticket.findMany
    .mockResolvedValueOnce([
      { createdAt: base, resolvedAt: plusH(4) },
      { createdAt: base, resolvedAt: plusH(8) }, // MTTR avg = 6h
    ])
    .mockResolvedValueOnce([]) // firstResponseAt never populated → null
    .mockResolvedValueOnce([
      // SLA computed on-read: breached when resolution-time > priority target
      // (CRITICAL 4h · HIGH 24h · MEDIUM 48h · LOW 72h).
      { priority: 'HIGH', createdAt: base, resolvedAt: plusH(10) }, // 10 ≤ 24 → compliant
      { priority: 'MEDIUM', createdAt: base, resolvedAt: plusH(30) }, // 30 ≤ 48 → compliant
      { priority: 'LOW', createdAt: base, resolvedAt: plusH(100) }, // 100 > 72 → breached
      { priority: 'MEDIUM', createdAt: base, closedAt: plusH(12) }, // 12 ≤ 48 → compliant (via closedAt)
    ]) // 3/4 compliant = 75%
    .mockResolvedValueOnce([
      { createdAt: plusH(0) }, // assert with now far in future → all >7d-ish; we override per test
    ]);

  // visibility (disabled by default; AMOUNT_UPLOAD = the Deoleo-style legacy funnel)
  mockTenantSettings.getVisibilityEnabledUncached.mockResolvedValue(false);
  mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('AMOUNT_UPLOAD');
}

describe('OperationsDashboardService', () => {
  let service: OperationsDashboardService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperationsDashboardService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: PayoutsService, useValue: mockPayouts },
      ],
    }).compile();
    service = module.get(OperationsDashboardService);
    primeDefaults();
  });

  it('computes payout success/failure rates and pending value', async () => {
    const res = await service.operations(user);
    // total = 8+1+1+5+3+2+1(HOLD) = 21; success 8 → 38.1%; failed (1+1)=2 → 9.5%
    expect(res.payouts.total).toBe(21);
    expect(res.payouts.success).toBe(8);
    expect(res.payouts.failed).toBe(2);
    expect(res.payouts.pending).toBe(10); // 5+3+2
    expect(res.payouts.successRatePct).toBeCloseTo(38.1, 1);
    expect(res.payouts.failureRatePct).toBeCloseTo(9.5, 1);
    expect(res.payouts.pendingValueRupees).toBe(1000);
  });

  it('guards payout rates against division by zero (no txns)', async () => {
    mockPrisma.payoutTransaction.groupBy.mockResolvedValue([]);
    mockPrisma.payoutTransaction.aggregate.mockResolvedValue({ _sum: { netAmountPaise: null } });
    mockPrisma.payoutTransaction.findMany.mockReset().mockResolvedValue([]);
    const res = await service.operations(user);
    expect(res.payouts.total).toBe(0);
    expect(res.payouts.successRatePct).toBe(0);
    expect(res.payouts.failureRatePct).toBe(0);
    expect(res.payouts.pendingValueRupees).toBe(0);
    expect(res.payouts.latencyByMode).toEqual([]);
  });

  it('computes mean payout latency grouped by mode', async () => {
    const res = await service.operations(user);
    const upi = res.payouts.latencyByMode.find((m) => m.mode === 'UPI');
    const bank = res.payouts.latencyByMode.find((m) => m.mode === 'BANK_TRANSFER');
    expect(upi).toEqual({ mode: 'UPI', avgHours: 3, sampleSize: 2 });
    expect(bank).toEqual({ mode: 'BANK_TRANSFER', avgHours: 10, sampleSize: 1 });
  });

  it('groups OPEN tickets, computes MTTR, and returns null first-response when unpopulated', async () => {
    const res = await service.operations(user);
    // OPEN set = OPEN+IN_PROGRESS+PENDING_USER+ESCALATED = 4+2+1+1 = 8
    expect(res.tickets.open).toBe(8);
    expect(res.tickets.mttrHours).toBe(6);
    expect(res.tickets.firstResponseHours).toBeNull(); // never populated
    expect(res.tickets.byCategory).toContainEqual({ category: 'PAYOUT', count: 6 });
  });

  it('computes SLA compliance and guards /0 → 100 when no terminal tickets', async () => {
    // default: 3/4 compliant = 75%
    let res = await service.operations(user);
    expect(res.tickets.slaCompliancePct).toBe(75);
    expect(res.tickets.sampleSize).toBe(4);

    // empty terminal set → 100
    jest.clearAllMocks();
    primeDefaults();
    mockPrisma.ticket.findMany
      .mockReset()
      .mockResolvedValueOnce([]) // MTTR
      .mockResolvedValueOnce([]) // first response
      .mockResolvedValueOnce([]) // terminal (SLA) → empty
      .mockResolvedValueOnce([]); // open ages
    res = await service.operations(user);
    expect(res.tickets.slaCompliancePct).toBe(100);
    expect(res.tickets.sampleSize).toBe(0);
    expect(res.tickets.mttrHours).toBeNull();
  });

  it('returns visibility:null when the tenant has visibility disabled', async () => {
    const res = await service.operations(user);
    expect(res.visibility).toBeNull();
    // when disabled we must NOT query captures
    expect(mockPrisma.visibilityCapture.groupBy).not.toHaveBeenCalled();
  });

  it('AMOUNT_UPLOAD tenant: the unchanged all-time funnel when enabled', async () => {
    mockTenantSettings.getVisibilityEnabledUncached.mockResolvedValue(true);
    mockPrisma.visibilityCapture.groupBy.mockResolvedValue([
      { status: 'SUBMITTED', _count: { _all: 4 } },
      { status: 'APPROVED', _count: { _all: 6 } },
      { status: 'REJECTED', _count: { _all: 3 } },
    ]);
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([
      { outletId: 'o1' },
      { outletId: 'o2' },
    ]);
    mockPrisma.outlet.count.mockResolvedValue(10);

    const res = await service.operations(user);
    expect(res.visibility).not.toBeNull();
    const v = res.visibility!;
    expect(v.enabled).toBe(true);
    // submitted = SUBMITTED+APPROVED+REJECTED = 4+6+3 = 13
    expect(v.submitted).toBe(13);
    expect(v.approved).toBe(6);
    expect(v.rejected).toBe(3);
    // no separate FLAGGED capture state
    expect(v.flagged).toBe(0);
    // approvalRate = 6 / (6+3+0) = 66.67%
    expect(v.approvalRatePct).toBeCloseTo(66.67, 1);
    // fraud is surfaced per-capture, never aggregated here → always 0
    expect(v.fraudFlagPct).toBe(0);
    // participation = 2 distinct / 10 addressable = 20%
    expect(v.participationPct).toBe(20);
    // no month filter on the legacy path
    expect(mockPrisma.visibilityCapture.groupBy.mock.calls[0][0].where).toEqual({ clientId: 'deoleo' });
  });

  describe('PHOTO_APPROVAL tenant: month-wise funnel with real fraud flags', () => {
    const schema = { captureGpsOnSubmit: false, fields: [{ id: 'w1', type: 'CAMERA', label: 'Window 1', geoFenceRequired: true }] };
    const outlet = { latitude: 19.0, longitude: 72.8, partnerId: null };
    const near = { lat: 19.0001, lng: 72.8, accuracy: 10 };
    const far = { lat: 19.05, lng: 72.8, accuracy: 10 };
    const cap = (id: string, status: string, geo = near, geoFenceOk: boolean | null = true) => ({
      id, outletId: `o-${id}`, outletCode: id, outletName: id, windowKey: '2026-10-P1', status, formVersion: 1,
      formValues: { w1: { key: `${id}.jpg`, geo } }, geoFenceOk, outlet,
    });

    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-11-20T06:30:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
      mockTenantSettings.getVisibilityEnabledUncached.mockResolvedValue(true);
      mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('PHOTO_APPROVAL');
      mockTenantSettings.getEffectiveSettings.mockResolvedValue({
        visibilityConfig: { outletScope: ['SSS'], frequencyPerMonth: 1, programs: [], subPrograms: [], geoFence: { enabled: true, radiusMeters: 200 } },
      });
      // Month groupBy (status × window) vs the all-months waiting queue (by window only).
      mockPrisma.visibilityCapture.groupBy.mockImplementation((args: any) =>
        Promise.resolve(
          args.by.includes('status')
            ? [
                { status: 'SUBMITTED', windowKey: '2026-10-P1', _count: { _all: 1 } },
                { status: 'APPROVED', windowKey: '2026-10-P1', _count: { _all: 2 } },
                { status: 'CHANGES_REQUESTED', windowKey: '2026-10-P1', _count: { _all: 1 } },
              ]
            : [
                { windowKey: '2026-09-P1', _count: { _all: 2 } },
                { windowKey: '2026-10-P1', _count: { _all: 1 } },
              ],
        ),
      );
      // Portal went live long before the months under test (no imported month by default).
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue({ windowKey: '2026-01-P1' });
      const captures = [cap('a', 'APPROVED'), cap('b', 'APPROVED'), cap('c', 'SUBMITTED', far, null), cap('d', 'CHANGES_REQUESTED')];
      mockPrisma.visibilityCapture.findMany.mockImplementation((args: any) =>
        Promise.resolve(args.distinct ? [{ outletId: 'o-a' }, { outletId: 'o-b' }, { outletId: 'o-c' }, { outletId: 'o-d' }] : captures),
      );
      mockPrisma.visibilityImageHash.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.captureId
            ? [{ captureId: 'b', hash: 'h1' }]
            : [
                { hash: 'h1', captureId: 'b', capture: { outletCode: 'b', windowKey: '2026-10-P1' } },
                { hash: 'h1', captureId: 'old', capture: { outletCode: 'X9', windowKey: '2026-07-P1' } },
              ],
        ),
      );
      mockPrisma.visibilityFormVersion.findMany.mockResolvedValue([{ version: 1, formSchema: schema }]);
      mockPrisma.client.findUnique.mockResolvedValue({ features: { outletMasterGeo: true } });
      mockPrisma.kycSubmission.findMany.mockResolvedValue([]);
      mockPrisma.outlet.count.mockResolvedValue(8);
    });
    afterEach(() => jest.useRealTimers());

    it('counts the picked month, splits waiting / closed-window re-take, approval rate over decided captures, real flags', async () => {
      const res = await service.operations(user, '2026-10');
      const v = res.visibility as any;
      expect(v).toMatchObject({
        mode: 'PHOTO_APPROVAL', month: '2026-10', submitted: 4, approved: 2, waiting: 1,
        // October has closed → the re-take request can no longer be redone: final, not waiting on reps.
        needsRetake: 0, rejected: 0, closedNotApproved: 1, waitingOnReps: 0,
        // Gifsy's whole queue: 1 from October + 2 from earlier months.
        waitingAllMonths: 3, waitingEarlierMonths: 2,
        // 2 ÷ (2 + 1 not approved — window closed)
        approvalRatePct: 66.7,
        flagDetailsAvailable: true, importedMonth: false,
        // b = duplicate of an older capture; c = photo outside the fence
        flagged: 2, duplicate: 1, outsideFence: 1, fraudFlagPct: 50,
        participatingOutlets: 4, inScopeOutlets: 8, participationPct: 50,
      });
      const where = mockPrisma.visibilityCapture.groupBy.mock.calls[0][0].where;
      expect(where.windowKey).toEqual({ startsWith: '2026-10-P' });
      expect(where.outlet).toMatchObject({ isActive: true });
      expect(mockPrisma.outlet.count.mock.calls[0][0].where).toMatchObject({ isActive: true, outletType: { code: { in: ['SSS'] } } });
    });

    it('default month = current IST month; malformed month → 400', async () => {
      const res = await service.visibilityFunnel(user, undefined);
      expect((res.visibility as any).month).toBe('2026-11');
      await expect(service.visibilityFunnel(user, 'nope')).rejects.toThrow('Invalid month');
    });

    it('no decided captures → approval rate null, not a fake 0 / 100', async () => {
      mockPrisma.visibilityCapture.groupBy.mockResolvedValue([{ status: 'SUBMITTED', windowKey: '2026-10-P1', _count: { _all: 3 } }]);
      const res = await service.operations(user, '2026-10');
      expect((res.visibility as any).approvalRatePct).toBeNull();
    });

    it('imported month (before portal go-live): participation is not tracked (null + note), never ÷ today\'s outlets', async () => {
      mockPrisma.visibilityCapture.findFirst.mockResolvedValue({ windowKey: '2026-11-P1' });
      const v = (await service.operations(user, '2026-10')).visibility as any;
      expect(v).toMatchObject({ importedMonth: true, participationPct: null });
      expect(v.importedMonthNote).toMatch(/Not tracked for imported months/);
    });

    it('client roles: counts only — the funnel says no flag details, and the flags list (outlet codes) 403s', async () => {
      const clientAdmin: JwtPayload = { ...user, sub: 'ca1', role: 'CLIENT_ADMIN' };
      const v = (await service.operations(clientAdmin, '2026-10')).visibility as any;
      expect(v).toMatchObject({ flagged: 2, duplicate: 1, outsideFence: 1, flagDetailsAvailable: false });
      await expect(service.visibilityFlags(clientAdmin, '2026-10')).rejects.toThrow('available to Gifsy only');
    });

    it('one fraud scan per tenant-month is reused by the funnel and every flag-list page', async () => {
      await service.operations(user, '2026-10');
      await service.visibilityFlags(user, '2026-10', 1, 1);
      await service.visibilityFlags(user, '2026-10', 2, 1);
      // The capture scan (no `distinct`) ran once; the participation query (distinct) is separate.
      const scans = mockPrisma.visibilityCapture.findMany.mock.calls.filter((c: any[]) => !c[0].distinct);
      expect(scans).toHaveLength(1);
    });

    it('flags list: the reason per capture, paged', async () => {
      const res = await service.visibilityFlags(user, '2026-10', 1, 1);
      expect(res).toMatchObject({ month: '2026-10', submitted: 4, flagged: 2, pagination: { page: 1, pageSize: 1, total: 2, pages: 2 } });
      expect(res.rows[0]).toMatchObject({ outletCode: 'b', reasons: ['DUPLICATE_PHOTO'], duplicateOf: [{ outletCode: 'X9', windowKey: '2026-07-P1' }] });
      const p2 = await service.visibilityFlags(user, '2026-10', 2, 1);
      expect(p2.rows[0]).toMatchObject({ outletCode: 'c', reasons: ['OUTSIDE_FENCE'], outsidePhotos: ['Window 1'], status: 'WAITING' });
    });

    it('flags list 400s for an AMOUNT_UPLOAD tenant', async () => {
      mockTenant.resolveVisibilityCaptureMode.mockResolvedValue('AMOUNT_UPLOAD');
      await expect(service.visibilityFlags(user, '2026-10')).rejects.toThrow('not enabled');
    });
  });

  it('computes settlement latency from the manual redemption-order join', async () => {
    const res = await service.operations(user);
    // ro1 6h, ro2 12h → avg 9h, n=2
    expect(res.settlement.avgLatencyHours).toBe(9);
    expect(res.settlement.sampleSize).toBe(2);
  });
});
