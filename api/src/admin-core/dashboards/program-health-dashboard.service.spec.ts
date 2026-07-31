// Unit tests for ProgramHealthDashboardService — the admin Program Health dashboard.
// Run: npx jest src/admin-core/dashboards/program-health-dashboard.service.spec.ts
//
// Covers, with a mocked PrismaService:
//  - activation funnel counts (registered / kycApproved / firstEarn / firstRedeem)
//  - participation active rate + the /0 guard (no addressable outlets)
//  - points-economy period breakage formula (EXPIRE÷EARN) + its /0 guard
//  - target rollup: Σ over addressable outlets, primary selection, pct (null on target≤0)
//  - redemption mode grouping honouring the completed-status filter
//  - tenant scoping is present on the outlet + ledger + wallet queries

import { Test, TestingModule } from '@nestjs/testing';
import { ProgramHealthDashboardService } from './program-health-dashboard.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantService } from '../../tenant/tenant.service';
import { TenantSettingsService } from '../../tenant/tenant-settings.service';
import { JwtPayload } from '../../common/decorators/current-user.decorator';

// A fixed "now" so month-window math is deterministic. June 2026.
const FIXED_NOW = new Date(2026, 5, 15, 12, 0, 0); // 2026-06-15
const PERIOD = '2026-06';

const mockPrisma = {
  outlet: { findMany: jest.fn() },
  pointsLedger: { findMany: jest.fn(), aggregate: jest.fn() },
  wallet: { aggregate: jest.fn() },
  kpiDef: { findMany: jest.fn() },
  outletTarget: { findMany: jest.fn() },
  outletSalesRecord: { findMany: jest.fn() },
  redemptionOrder: { findMany: jest.fn(), groupBy: jest.fn() },
};

const mockTenant = { resolveClient: jest.fn() };
const mockTenantSettings = { getConversionRate: jest.fn() };

const user: JwtPayload = {
  sub: 'admin1',
  role: 'GIFSY_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

/** Build an addressable-outlet row in the shape the service selects. */
function outlet(opts: {
  id: string;
  partnerId?: string | null;
  createdAt?: Date;
  approved?: boolean;
  approvedAt?: Date | null;
  earn?: boolean;
  redeemed?: boolean;
}) {
  const {
    id,
    partnerId = `p_${id}`,
    createdAt = new Date(2026, 5, 1),
    approved = false,
    approvedAt = null,
    earn = false,
    redeemed = false,
  } = opts;
  return {
    id,
    createdAt,
    partnerId,
    partner: partnerId
      ? {
          id: partnerId,
          kycSubmissions: approved ? [{ status: 'APPROVED', approvedAt }] : [{ status: 'DRAFT', approvedAt: null }],
          wallets: [{ pointsLedger: earn ? [{ id: 'l1' }] : [] }],
          redemptionOrders: redeemed ? [{ id: 'r1' }] : [],
        }
      : null,
  };
}

function aggSum(field: string, value: number | null) {
  return { _sum: { [field]: value } };
}

describe('ProgramHealthDashboardService', () => {
  let service: ProgramHealthDashboardService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(FIXED_NOW);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProgramHealthDashboardService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
      ],
    }).compile();
    service = module.get(ProgramHealthDashboardService);

    // Sensible empty defaults; individual tests override what they assert on.
    mockTenant.resolveClient.mockResolvedValue({ slug: 'Deoleo' });
    mockTenantSettings.getConversionRate.mockResolvedValue(10); // 10 points = ₹1

    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.pointsLedger.findMany.mockResolvedValue([]);
    mockPrisma.pointsLedger.aggregate.mockResolvedValue(aggSum('points', 0));
    mockPrisma.wallet.aggregate.mockResolvedValue(aggSum('redeemablePoints', 0));
    mockPrisma.kpiDef.findMany.mockResolvedValue([]);
    mockPrisma.outletTarget.findMany.mockResolvedValue([]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.groupBy.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('computes the activation funnel counts from addressable outlets', async () => {
    mockPrisma.outlet.findMany.mockImplementation((args: { select?: unknown }) => {
      // The rich select (with partner) is the universe pull; the bare {outletCode} select
      // is the target-rollup roster pull. Return the rich rows only for the former.
      const sel = (args as { select?: Record<string, unknown> }).select ?? {};
      if ('partner' in sel) {
        return Promise.resolve([
          outlet({ id: 'a', approved: true, approvedAt: new Date(2026, 5, 6), earn: true, redeemed: true }), // 5 days
          outlet({ id: 'b', approved: true, approvedAt: new Date(2026, 5, 4), earn: true }), // 3 days
          outlet({ id: 'c', approved: false, earn: false }),
        ]);
      }
      return Promise.resolve([{ outletCode: 'a' }, { outletCode: 'b' }, { outletCode: 'c' }]);
    });

    const res = await service.programHealth(user, PERIOD);

    expect(res.activation.registered).toBe(3);
    expect(res.activation.kycApproved).toBe(2);
    expect(res.activation.firstEarn).toBe(2);
    expect(res.activation.firstRedeem).toBe(1);
    // median of [5, 3] days = 4
    expect(res.activation.medianTimeToActivateDays).toBe(4);
  });

  it('participation active rate uses period EARN earners over addressable, guarding /0', async () => {
    // 4 addressable outlets, partners p_a..p_d.
    mockPrisma.outlet.findMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
      if (args.select && 'partner' in args.select) {
        return Promise.resolve([
          outlet({ id: 'a' }),
          outlet({ id: 'b' }),
          outlet({ id: 'c' }),
          outlet({ id: 'd' }),
        ]);
      }
      return Promise.resolve([]);
    });
    // 2 distinct partners earned in June; one earned in May (out of period); one duplicate.
    mockPrisma.pointsLedger.findMany.mockResolvedValue([
      { createdAt: new Date(2026, 5, 3), wallet: { partnerId: 'p_a' } },
      { createdAt: new Date(2026, 5, 9), wallet: { partnerId: 'p_a' } }, // dup → still 1 distinct
      { createdAt: new Date(2026, 5, 10), wallet: { partnerId: 'p_b' } },
      { createdAt: new Date(2026, 4, 20), wallet: { partnerId: 'p_c' } }, // May → not in June bucket
    ]);

    const res = await service.programHealth(user, PERIOD);

    expect(res.participation.addressable).toBe(4);
    expect(res.participation.activeEarnersThisMonth).toBe(2); // p_a, p_b
    expect(res.participation.activeRatePct).toBe(50); // 2/4
    expect(res.participation.trend).toHaveLength(6);

    // /0 guard: no addressable outlets → rate 0, not NaN.
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.pointsLedger.findMany.mockResolvedValue([]);
    const empty = await service.programHealth(user, PERIOD);
    expect(empty.participation.activeRatePct).toBe(0);
  });

  it('points-economy breakage = period EXPIRE ÷ EARN, with a /0 guard', async () => {
    // aggregate() is called 5×: EARN, REDEEM, EXPIRE, wallet-liability, expiring-30d.
    mockPrisma.pointsLedger.aggregate
      .mockResolvedValueOnce(aggSum('points', 1000)) // issued (EARN)
      .mockResolvedValueOnce(aggSum('points', -400)) // redeemed (REDEEM, negative)
      .mockResolvedValueOnce(aggSum('points', -50)) // expired (EXPIRE, negative)
      .mockResolvedValueOnce(aggSum('points', 120)); // expiring-30d (EARN)
    mockPrisma.wallet.aggregate.mockResolvedValue(aggSum('redeemablePoints', 5000));

    const res = await service.programHealth(user, PERIOD);

    expect(res.pointsEconomy.issued).toBe(1000);
    expect(res.pointsEconomy.redeemed).toBe(400); // abs
    expect(res.pointsEconomy.breakagePct).toBe(5); // 50/1000
    expect(res.pointsEconomy.outstandingLiabilityPoints).toBe(5000);
    expect(res.pointsEconomy.outstandingLiabilityRupees).toBe(500); // 5000 / rate 10
    expect(res.pointsEconomy.expiringIn30dPoints).toBe(120);

    // /0 guard: zero EARN in the period → breakage 0 (not NaN/Infinity).
    jest.clearAllMocks();
    mockTenant.resolveClient.mockResolvedValue({ slug: 'Deoleo' });
    mockTenantSettings.getConversionRate.mockResolvedValue(10);
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.pointsLedger.findMany.mockResolvedValue([]);
    mockPrisma.kpiDef.findMany.mockResolvedValue([]);
    mockPrisma.outletTarget.findMany.mockResolvedValue([]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.groupBy.mockResolvedValue([]);
    mockPrisma.wallet.aggregate.mockResolvedValue(aggSum('redeemablePoints', 0));
    mockPrisma.pointsLedger.aggregate
      .mockResolvedValueOnce(aggSum('points', 0)) // issued
      .mockResolvedValueOnce(aggSum('points', 0)) // redeemed
      .mockResolvedValueOnce(aggSum('points', -10)) // expired but no earn
      .mockResolvedValueOnce(aggSum('points', 0)); // expiring
    const guarded = await service.programHealth(user, PERIOD);
    expect(guarded.pointsEconomy.breakagePct).toBe(0);
  });

  it('rolls up targets over addressable outlets, selects primary, and nulls pct on target≤0', async () => {
    mockPrisma.outlet.findMany.mockImplementation((args: { select?: Record<string, unknown> }) => {
      if (args.select && 'partner' in args.select) {
        return Promise.resolve([outlet({ id: 'a' }), outlet({ id: 'b' })]);
      }
      // addressable roster (outletCodes) — note 'ZZZ' is NOT addressable.
      return Promise.resolve([{ outletCode: 'O1' }, { outletCode: 'O2' }]);
    });
    mockPrisma.kpiDef.findMany.mockResolvedValue([
      { code: 'VOL', label: 'Volume', unit: 'cases', isPrimary: true },
      { code: 'NEW', label: 'New Outlets', unit: '', isPrimary: false },
    ]);
    mockPrisma.outletTarget.findMany.mockResolvedValue([
      { outletCode: 'O1', targetValues: { VOL: 100, NEW: 0 } },
      { outletCode: 'O2', targetValues: { VOL: 100 } },
      { outletCode: 'ZZZ', targetValues: { VOL: 999 } }, // non-addressable → ignored
    ]);
    mockPrisma.outletSalesRecord.findMany.mockResolvedValue([
      { outletCode: 'O1', kpiValues: { VOL: 60, NEW: 5 } },
      { outletCode: 'O2', kpiValues: { VOL: 90 } },
      { outletCode: 'ZZZ', kpiValues: { VOL: 999 } }, // ignored
    ]);

    const res = await service.programHealth(user, PERIOD);

    const vol = res.targetAchievement.kpis.find((k) => k.kpiCode === 'VOL')!;
    expect(vol.target).toBe(200); // 100+100 (ZZZ excluded)
    expect(vol.achieved).toBe(150); // 60+90
    expect(vol.pct).toBe(75); // 150/200
    expect(vol.kpiName).toBe('Volume');
    expect(vol.unit).toBe('cases');

    const newK = res.targetAchievement.kpis.find((k) => k.kpiCode === 'NEW')!;
    expect(newK.target).toBe(0); // 0 + (absent)
    expect(newK.pct).toBeNull(); // target ≤ 0 → null

    expect(res.targetAchievement.primary?.kpiCode).toBe('VOL');
  });

  it('groups completed redemptions by mode, excluding pending/failed/cancelled/returned', async () => {
    // The service's findMany WHERE already excludes the non-completed statuses, so the mock
    // returns only completed orders — we assert the grouping + value math.
    mockPrisma.redemptionOrder.findMany.mockImplementation((args: { where?: Record<string, unknown> }) => {
      // Assert the completed-status filter is on the query.
      const status = (args.where as { status?: { notIn?: string[] } } | undefined)?.status;
      expect(status?.notIn).toEqual(
        expect.arrayContaining(['PENDING', 'FAILED', 'CANCELLED', 'RETURNED']),
      );
      return Promise.resolve([
        { redemptionMode: 'UPI', pointsDeducted: 1000, valuePaise: BigInt(10000) }, // ₹100
        { redemptionMode: 'UPI', pointsDeducted: 500, valuePaise: null }, // fallback 500/10 = ₹50
        { redemptionMode: 'GIFT_CARD', pointsDeducted: 200, valuePaise: BigInt(2000) }, // ₹20
      ]);
    });
    mockPrisma.redemptionOrder.groupBy.mockResolvedValue([
      { status: 'DELIVERED', _count: { _all: 2 } },
      { status: 'PENDING', _count: { _all: 3 } },
    ]);

    const res = await service.programHealth(user, PERIOD);

    const upi = res.redemptions.byMode.find((m) => m.mode === 'UPI')!;
    expect(upi.count).toBe(2);
    expect(upi.points).toBe(1500);
    expect(upi.valueRupees).toBe(150); // 100 + 50 (fallback via conversionRate)

    const gc = res.redemptions.byMode.find((m) => m.mode === 'GIFT_CARD')!;
    expect(gc.valueRupees).toBe(20);

    // modes with zero completed orders are dropped
    expect(res.redemptions.byMode.find((m) => m.mode === 'BANK_TRANSFER')).toBeUndefined();

    // fulfilment is the full status distribution (PENDING visible here)
    expect(res.redemptions.fulfilment).toEqual(
      expect.arrayContaining([
        { status: 'DELIVERED', count: 2 },
        { status: 'PENDING', count: 3 },
      ]),
    );
  });

  it('tenant-scopes the outlet, ledger, and wallet queries by clientId', async () => {
    await service.programHealth(user, PERIOD);

    // Outlet universe: clientId + addressable filter, never isActive:true.
    const outletWhere = mockPrisma.outlet.findMany.mock.calls[0][0].where;
    expect(outletWhere.clientId).toBe('deoleo');
    expect(outletWhere.deletedAt).toBeNull();
    expect(outletWhere.deactivatedAt).toBeNull();
    expect('isActive' in outletWhere).toBe(false);
    // kycIntent `not` is wrapped in OR so NULL-intent outlets survive (trap 2).
    expect(outletWhere.OR).toEqual([
      { kycIntent: null },
      { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } },
    ]);

    // PointsLedger joins to the tenant via wallet→partner→user.clientId.
    const ledgerWhere = mockPrisma.pointsLedger.findMany.mock.calls[0][0].where;
    expect(ledgerWhere.wallet.partner.user.clientId).toBe('deoleo');

    // Wallet liability is scoped to the tenant's partners.
    const walletWhere = mockPrisma.wallet.aggregate.mock.calls[0][0].where;
    expect(walletWhere.partner.user.clientId).toBe('deoleo');
  });
});
