// Unit tests for FinanceDashboardService — GET /v1/admin/dashboard/finance.
// Covers: points→₹ liability conversion at the tenant rate, period-only breakage
// formula (+ /0 guard), TDS paise→₹ mapping from mocked summaries (194R tenant +
// 194C platform-wide), the client fund block from the fund reconciliation loader + engine, and that
// every query is tenant-scoped by user.clientId.
//
// Run: npx jest src/admin-core/dashboards/finance-dashboard.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { FinanceDashboardService } from './finance-dashboard.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantService } from '../../tenant/tenant.service';
import { TenantSettingsService } from '../../tenant/tenant-settings.service';
import { loadFundInputs } from '../../fund/fund-sources.loader';

jest.mock('../../fund/fund-sources.loader', () => ({ loadFundInputs: jest.fn() }));
const mockLoadFund = loadFundInputs as jest.MockedFunction<typeof loadFundInputs>;
import { TdsService } from '../../tds/tds.service';
import { JwtPayload } from '../../common/decorators/current-user.decorator';
import { GifsyRoleService } from '../../common/rbac/gifsy-role.service';

const mockPrisma = {
  wallet: { aggregate: jest.fn() },
  pointsLedger: { aggregate: jest.fn() },
  fundSettings: { findUnique: jest.fn() },
};

const mockTenant = { resolveClient: jest.fn() };
const mockTenantSettings = { getConversionRate: jest.fn() };
const mockTds = { report194R: jest.fn(), summary194C: jest.fn() };
const mockRoles = { getPermissions: jest.fn() };

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
  mockTds.report194R.mockResolvedValue({ importedPayoutsCountedFrom: null, importedPayoutsNote: null, rows: [], summary: {
    fyLabel: '2025-26', clientId: 'deoleo',
    totalBasePaise: 100_000_00n,
    totalLiabilityPaise: 10_000_00n,   // ₹10,000
    totalDepositedPaise: 4_000_00n,    // ₹4,000
    totalOutstandingPaise: 6_000_00n,  // ₹6,000
    rowCount: 3,
  } });
  mockTds.summary194C.mockResolvedValue({
    fyLabel: '2025-26',
    totalBasePaise: 500_000_00n,
    totalLiabilityPaise: 25_000_00n,         // ₹25,000
    totalLiabilityNoThresholdPaise: 30_000_00n,
    totalDepositedPaise: 5_000_00n,          // ₹5,000
    totalOutstandingPaise: 20_000_00n,       // ₹20,000
    rowCount: 7,
  });
  // Fund: opening ₹1,00,000 + receipt ₹50,000; one paid cash payout ₹10,000 (+10% fee) and one committed ₹5,000.
  const at = new Date(Date.now() - 86_400_000);
  mockLoadFund.mockResolvedValue({
    entries: [
      { id: 'o', kind: 'OPENING_BALANCE', amountPaise: 100_000_00n, date: new Date(at.getTime() - 86_400_000), ref: 'o', note: null },
      { id: 'r', kind: 'RECEIPT', amountPaise: 50_000_00n, date: at, ref: 'r', note: null },
    ],
    rates: [{ kind: 'AGENCY_FEE', feeType: 'PERCENT', rateBps: 1000, effectiveFrom: new Date(0), createdAt: new Date(0) }],
    items: [
      { key: 'a', type: 'CASH_REDEMPTION', ref: 'a', description: 'a', source: { kind: 'payoutTransaction', id: 'a' }, facePaise: 10_000_00n, status: 'PAID', committedAt: at, paidAt: at },
      { key: 'b', type: 'CASH_REDEMPTION', ref: 'b', description: 'b', source: { kind: 'payoutTransaction', id: 'b' }, facePaise: 5_000_00n, status: 'COMMITTED', committedAt: at },
    ],
    extraReceivables: [],
    rateChanges: [],
    entryRows: [],
    rateRows: [],
  } as never);
  mockPrisma.fundSettings.findUnique.mockResolvedValue({ lowBalanceThresholdPaise: 200_000_00n });
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
        { provide: TdsService, useValue: mockTds },
        { provide: GifsyRoleService, useValue: mockRoles },
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
    // period label is the current IST calendar month as "Month YYYY" (monthYearIST)
    expect(out.breakage.period).toMatch(/^[A-Z][a-z]+ \d{4}$/);
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
    expect(mockTds.report194R).toHaveBeenCalledWith('deoleo', expect.any(String));
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
    expect(mockTds.report194R).toHaveBeenCalledWith('deoleo', expect.any(String));
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

  it('194R tile carries the imported-payouts note ONLY when it applies to the FY', async () => {
    const base = (await mockTds.report194R()) as Record<string, unknown>;
    mockTds.report194R.mockResolvedValueOnce({
      ...base,
      importedPayoutsCountedFrom: '2026-04-01',
      importedPayoutsNote: 'Includes imported (vendor) payouts paid on/after 1 Apr 2026',
    });
    const on = await service.finance(admin);
    expect((on.tds.sec194R as Record<string, unknown>).importedPayoutsNote).toBe(
      'Includes imported (vendor) payouts paid on/after 1 Apr 2026',
    );
    // OFF / not in this FY → no key at all (the C1 tests above assert the exact 3-field tile).
  });

  it('fund block = the fund reconciliation engine for the caller’s (assumed) tenant, in ₹', async () => {
    const out = await service.finance(assumedGifsy);
    expect(out.fund).toEqual({
      receivedRupees: 150_000, // opening + receipts
      adjustmentsRupees: 0,
      committedRupees: 5_500, // ₹5,000 + 10% fee
      paidRupees: 11_000, // ₹10,000 + 10% fee
      returnedRupees: 0,
      balanceRupees: 133_500,
      lowBalance: true, // below the ₹2,00,000 threshold
      thresholdRupees: 200_000,
      hasSettings: true,
      noClientContext: false,
    });
    expect(mockLoadFund).toHaveBeenCalledWith(mockPrisma, 'deoleo');
    expect(mockPrisma.fundSettings.findUnique).toHaveBeenCalledWith({ where: { clientId: 'deoleo' } });
  });

  it('fund block for a CLIENT_ADMIN reads only its own tenant', async () => {
    await service.finance(clientAdmin);
    expect(mockLoadFund).toHaveBeenCalledWith(mockPrisma, 'deoleo');
  });

  it('fund block for an un-assumed Gifsy owner (no client context) is all zero — never another tenant’s numbers', async () => {
    const out = await service.finance(admin);
    expect(out.fund).toMatchObject({ balanceRupees: 0, receivedRupees: 0, hasSettings: false, lowBalance: false, noClientContext: true });
    expect(mockLoadFund).not.toHaveBeenCalled();
  });

  it('honours the fy override and echoes the resolved tenant slug', async () => {
    const out = await service.finance(admin, '2024-25');
    expect(out.scope.fy).toBe('2024-25');
    expect(out.tds.fy).toBe('2024-25');
    expect(out.scope.tenant).toBe('deoleo');
    expect(mockTds.report194R).toHaveBeenCalledWith('deoleo', '2024-25');
  });

  it('owner D1/D2: liability = Σ POSITIVE balances only; "points owed" = Σ |negative balances| + wallet count, separate', async () => {
    mockPrisma.wallet.aggregate.mockReset();
    mockPrisma.wallet.aggregate
      .mockResolvedValueOnce({ _sum: { lockedPoints: 0 } }) // all wallets: locked
      .mockResolvedValueOnce({ _sum: { redeemablePoints: 50_000 } }) // positive wallets only
      .mockResolvedValueOnce({ _sum: { redeemablePoints: -2_986 }, _count: { _all: 1 } }); // negative wallets
    const out = await service.finance(admin);
    expect(mockPrisma.wallet.aggregate.mock.calls[1][0].where).toEqual({ partner: { clientId: 'deoleo' }, redeemablePoints: { gt: 0 } });
    expect(mockPrisma.wallet.aggregate.mock.calls[2][0].where).toEqual({ partner: { clientId: 'deoleo' }, redeemablePoints: { lt: 0 } });
    expect(out.liability).toMatchObject({ redeemablePoints: 50_000, owedPoints: 2_986, owedWallets: 1, redeemableRupees: 5_000 });
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

  it('B1: MIS_USER never gets the fund block (null — the card is hidden) and nothing is loaded', async () => {
    const out = await service.finance({ sub: 'm', role: 'MIS_USER', clientId: 'deoleo', phone: '', name: '' });
    expect(out.fund).toBeNull();
    expect(mockLoadFund).not.toHaveBeenCalled();
  });

  it('B1: GIFSY_STAFF gets the fund block only when its role holds payouts:read', async () => {
    const staff: JwtPayload = { sub: 's', role: 'GIFSY_STAFF', clientId: 'deoleo', phone: '', name: '', assumed: true, gifsyRoleId: 'r1' };
    mockRoles.getPermissions.mockResolvedValueOnce(new Set(['reports:read']));
    expect((await service.finance(staff)).fund).toBeNull();
  });

  it('B1: GIFSY_STAFF holding payouts:read gets the fund block', async () => {
    const staff: JwtPayload = { sub: 's', role: 'GIFSY_STAFF', clientId: 'deoleo', phone: '', name: '', assumed: true, gifsyRoleId: 'r1' };
    mockRoles.getPermissions.mockResolvedValueOnce(new Set(['payouts:read']));
    expect((await service.finance(staff)).fund).toMatchObject({ balanceRupees: 133_500 });
  });
});
