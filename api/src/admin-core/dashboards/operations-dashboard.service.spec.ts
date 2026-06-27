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
  visibilitySubmission: {
    groupBy: jest.fn(),
    count: jest.fn(),
    findMany: jest.fn(),
  },
  outlet: { count: jest.fn() },
  redemptionOrder: { findMany: jest.fn() },
};

const mockTenant = {
  resolveClient: jest.fn().mockResolvedValue({
    slug: 'deoleo',
    name: 'Deoleo',
    branding: { displayName: 'Deoleo' },
  }),
};
const mockTenantSettings = {
  getVisibilityEnabledUncached: jest.fn().mockResolvedValue(false),
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

  // visibility (disabled by default)
  mockTenantSettings.getVisibilityEnabledUncached.mockResolvedValue(false);
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
    // when disabled we must NOT query submissions
    expect(mockPrisma.visibilitySubmission.groupBy).not.toHaveBeenCalled();
  });

  it('returns the visibility funnel when enabled', async () => {
    mockTenantSettings.getVisibilityEnabledUncached.mockResolvedValue(true);
    mockPrisma.visibilitySubmission.groupBy.mockResolvedValue([
      { status: 'DRAFT', _count: { _all: 5 } },
      { status: 'SUBMITTED', _count: { _all: 4 } },
      { status: 'APPROVED', _count: { _all: 6 } },
      { status: 'REJECTED', _count: { _all: 3 } },
      { status: 'FLAGGED', _count: { _all: 1 } },
    ]);
    mockPrisma.visibilitySubmission.count.mockResolvedValue(2); // fraud flagged
    mockPrisma.visibilitySubmission.findMany.mockResolvedValue([
      { outletId: 'o1' },
      { outletId: 'o2' },
    ]);
    mockPrisma.outlet.count.mockResolvedValue(10);

    const res = await service.operations(user);
    expect(res.visibility).not.toBeNull();
    const v = res.visibility!;
    expect(v.enabled).toBe(true);
    // submitted = SUBMITTED+APPROVED+REJECTED+FLAGGED (+UNDER_REVIEW) = 4+6+3+1 = 14
    expect(v.submitted).toBe(14);
    expect(v.approved).toBe(6);
    expect(v.rejected).toBe(3);
    expect(v.flagged).toBe(1);
    // approvalRate = 6 / (6+3+1) = 60%
    expect(v.approvalRatePct).toBe(60);
    // total = 19; fraud 2 → 10.5%
    expect(v.fraudFlagPct).toBeCloseTo(10.5, 1);
    // participation = 2 distinct / 10 addressable = 20%
    expect(v.participationPct).toBe(20);
  });

  it('computes settlement latency from the manual redemption-order join', async () => {
    const res = await service.operations(user);
    // ro1 6h, ro2 12h → avg 9h, n=2
    expect(res.settlement.avgLatencyHours).toBe(9);
    expect(res.settlement.sampleSize).toBe(2);
  });
});
