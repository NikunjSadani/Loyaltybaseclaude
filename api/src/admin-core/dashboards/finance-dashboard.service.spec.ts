// Unit tests for FinanceDashboardService — GET /v1/admin/dashboard/finance.
// Covers: points→₹ liability conversion at the tenant rate, period-only breakage
// formula (+ /0 guard), TDS paise→₹ mapping from mocked summaries (194R tenant +
// 194C platform-wide), fund paise→₹ mapping from a mocked fund summary, and that
// every query is tenant-scoped by user.clientId.
//
// Run: npx jest src/admin-core/dashboards/finance-dashboard.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { FinanceDashboardService } from './finance-dashboard.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantService } from '../../tenant/tenant.service';
import { TenantSettingsService } from '../../tenant/tenant-settings.service';
import { PayoutsService } from '../../payouts/payouts.service';
import { TdsService } from '../../tds/tds.service';
import { JwtPayload } from '../../common/decorators/current-user.decorator';

const mockPrisma = {
  wallet: { aggregate: jest.fn() },
  pointsLedger: { aggregate: jest.fn() },
};

const mockTenant = { resolveClient: jest.fn() };
const mockTenantSettings = { getConversionRate: jest.fn() };
const mockPayouts = { getFundSummary: jest.fn() };
const mockTds = { summary194R: jest.fn(), summary194C: jest.fn() };

const admin: JwtPayload = {
  sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '',
};
// A tenant admin (never platform-wide) and an ASSUMED GIFSY operator (pinned to the
// assumed tenant) — both must be denied the platform-wide 194C cross-tenant total.
const clientAdmin: JwtPayload = {
  sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '',
};
const assumedGifsy: JwtPayload = {
  sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 'deoleo', phone: '', name: '', assumed: true,
};

/** Wire happy-path defaults; each test overrides what it asserts on. */
function primeDefaults() {
  mockTenant.resolveClient.mockResolvedValue({ slug: 'deoleo' });
  // 10 points = ₹1 → rate 10 pts/₹.
  mockTenantSettings.getConversionRate.mockResolvedValue(10);
  mockPrisma.wallet.aggregate.mockResolvedValue({
    _sum: { redeemablePoints: 50_000, lockedPoints: 12_000 },
  });
  // EXPIRE then EARN (Promise.all order in the service).
  mockPrisma.pointsLedger.aggregate
    .mockResolvedValueOnce({ _sum: { points: 2_000 } })   // EXPIRE
    .mockResolvedValueOnce({ _sum: { points: 40_000 } }); // EARN
  mockTds.summary194R.mockResolvedValue({
    fyLabel: '2025-26', clientId: 'deoleo',
    totalBasePaise: 100_000_00n,
    totalLiabilityPaise: 10_000_00n,   // ₹10,000
    totalDepositedPaise: 4_000_00n,    // ₹4,000
    totalOutstandingPaise: 6_000_00n,  // ₹6,000
    rowCount: 3,
  });
  mockTds.summary194C.mockResolvedValue({
    fyLabel: '2025-26',
    totalBasePaise: 500_000_00n,
    totalLiabilityPaise: 25_000_00n,         // ₹25,000
    totalLiabilityNoThresholdPaise: 30_000_00n,
    totalDepositedPaise: 5_000_00n,          // ₹5,000
    totalOutstandingPaise: 20_000_00n,       // ₹20,000
    rowCount: 7,
  });
  mockPayouts.getFundSummary.mockResolvedValue({
    totalReceived: 100_000,
    totalUtilised: 70_000,
    closingBalance: 30_000,
    pendingLiability: 8_000,
    available: 22_000,
  });
}

describe('FinanceDashboardService', () => {
  let service: FinanceDashboardService;

  beforeEach(async () => {
    jest.clearAllMocks();
    primeDefaults();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FinanceDashboardService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: PayoutsService, useValue: mockPayouts },
        { provide: TdsService, useValue: mockTds },
      ],
    }).compile();
    service = module.get(FinanceDashboardService);
  });

  it('converts points liability to ₹ at the tenant conversion rate (value = points ÷ rate)', async () => {
    const out = await service.finance(admin);
    expect(out.liability.redeemablePoints).toBe(50_000);
    expect(out.liability.lockedPoints).toBe(12_000);
    expect(out.liability.conversionRate).toBe(10);
    // 50,000 ÷ 10 = ₹5,000 ; 12,000 ÷ 10 = ₹1,200
    expect(out.liability.redeemableRupees).toBe(5_000);
    expect(out.liability.lockedRupees).toBe(1_200);
  });

  it('computes period-only breakage % = expired ÷ issued × 100', async () => {
    const out = await service.finance(admin);
    expect(out.breakage.expiredPoints).toBe(2_000);
    expect(out.breakage.issuedPoints).toBe(40_000);
    // 2,000 / 40,000 × 100 = 5%
    expect(out.breakage.breakagePct).toBe(5);
    // expired ₹ = 2,000 ÷ 10 = ₹200
    expect(out.breakage.expiredRupees).toBe(200);
    // period label is the current calendar month YYYY-MM
    expect(out.breakage.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('guards divide-by-zero breakage when nothing was issued in the period', async () => {
    mockPrisma.pointsLedger.aggregate.mockReset();
    mockPrisma.pointsLedger.aggregate
      .mockResolvedValueOnce({ _sum: { points: 500 } })  // EXPIRE
      .mockResolvedValueOnce({ _sum: { points: null } }); // EARN (none)
    const out = await service.finance(admin);
    expect(out.breakage.issuedPoints).toBe(0);
    expect(out.breakage.breakagePct).toBe(0); // guarded, not Infinity/NaN
  });

  it('maps TDS 194R (tenant) and 194C (platform) paise summaries to ₹', async () => {
    const out = await service.finance(admin);
    expect(out.tds.sec194R).toEqual({
      liabilityRupees: 10_000,
      depositedRupees: 4_000,
      outstandingRupees: 6_000,
    });
    expect(out.tds.sec194C).toEqual({
      liabilityRupees: 25_000,
      depositedRupees: 5_000,
      outstandingRupees: 20_000,
    });
    // 194R is called tenant-scoped; 194C is platform-wide (no clientId arg).
    expect(mockTds.summary194R).toHaveBeenCalledWith('deoleo', expect.any(String));
    expect(mockTds.summary194C).toHaveBeenCalledWith(expect.any(String));
  });

  // ── C1: the platform-wide 194C total is GIFSY-home-only (no cross-tenant leak) ──
  it('C1: OMITS the platform 194C figure for a CLIENT_ADMIN (zeroed block, summary194C not queried)', async () => {
    const out = await service.finance(clientAdmin);
    expect(out.tds.sec194C).toEqual({
      liabilityRupees: 0, depositedRupees: 0, outstandingRupees: 0,
    });
    // 194R (tenant) is still surfaced; only the cross-tenant 194C is withheld.
    expect(out.tds.sec194R).toEqual({
      liabilityRupees: 10_000, depositedRupees: 4_000, outstandingRupees: 6_000,
    });
    expect(mockTds.summary194C).not.toHaveBeenCalled();
    expect(mockTds.summary194R).toHaveBeenCalledWith('deoleo', expect.any(String));
  });

  it('C1: OMITS the platform 194C figure for an ASSUMED GIFSY operator (assumed:true)', async () => {
    const out = await service.finance(assumedGifsy);
    expect(out.tds.sec194C).toEqual({
      liabilityRupees: 0, depositedRupees: 0, outstandingRupees: 0,
    });
    expect(mockTds.summary194C).not.toHaveBeenCalled();
  });

  it('C1: RETAINS the platform 194C figure for an un-assumed GIFSY operator', async () => {
    const out = await service.finance(admin);
    expect(out.tds.sec194C).toEqual({
      liabilityRupees: 25_000, depositedRupees: 5_000, outstandingRupees: 20_000,
    });
    expect(mockTds.summary194C).toHaveBeenCalledWith(expect.any(String));
  });

  it('maps the fund reconciliation summary (already ₹) through', async () => {
    const out = await service.finance(admin);
    expect(out.fund).toEqual({
      totalReceivedRupees: 100_000,
      totalUtilisedRupees: 70_000,
      closingBalanceRupees: 30_000,
      pendingLiabilityRupees: 8_000,
      availableRupees: 22_000,
    });
    expect(mockPayouts.getFundSummary).toHaveBeenCalledWith(admin);
  });

  it('honours the fy override and echoes the resolved tenant slug', async () => {
    const out = await service.finance(admin, '2024-25');
    expect(out.scope.fy).toBe('2024-25');
    expect(out.tds.fy).toBe('2024-25');
    expect(out.scope.tenant).toBe('deoleo');
    expect(mockTds.summary194R).toHaveBeenCalledWith('deoleo', '2024-25');
  });

  it('scopes every wallet/ledger query by the caller tenant (partner.clientId)', async () => {
    await service.finance(admin);
    expect(mockPrisma.wallet.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { partner: { clientId: 'deoleo' } } }),
    );
    // both ledger aggregates carry the tenant filter via wallet.partner.clientId
    for (const call of mockPrisma.pointsLedger.aggregate.mock.calls) {
      expect(call[0].where.wallet).toEqual({ partner: { clientId: 'deoleo' } });
    }
  });
});
