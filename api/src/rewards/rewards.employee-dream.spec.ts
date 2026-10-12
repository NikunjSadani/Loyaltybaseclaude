// Employee Rewards Wave 4 — unit tests for the DREAM REWARD rails (display + a preference write; NO
// points move). Covers:
//  - PUT set-dream VALIDATES the selectable-dream gate (dreamEligible + role/region visibility +
//    tenant scope) before persisting: a non-eligible / not-visible / cross-tenant id is rejected
//    (BadRequestException) and NOT written.
//  - PUT set-dream success persists the id and returns the resolved shape; rewardId null CLEARS it.
//  - GET self-heals: a stored dream that no longer qualifies reads as cleared — no error, no mutation.
//  - The forecast / earn-rate math: a known ledger → expected monthlyEarnRate + forecastDate; the
//    1-month-old divisor; zero history → rate 0 + forecastDate null; reached → forecastDate null +
//    reached true.
//  - Tenant/caller gating: a TRADE tenant / non-employee caller is rejected; no account on PUT → 400.
//
// Date-RELATIVE: all ledger dates are computed from `new Date()` (never a hardcoded future date).
//
// Run: npx jest src/rewards/rewards.employee-dream.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RewardsService } from './rewards.service';
import { WalletService } from '../wallet/wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const EMPLOYEE_CLIENT = { loyaltyType: 'EMPLOYEE_REWARDS', features: null };
const TRADE_CLIENT = { loyaltyType: 'TRADE_LOYALTY', features: null };

const employee: JwtPayload = { sub: 'u-emp', role: 'FIELD_EXEC', clientId: 'acme', phone: '98300', name: 'Asha' };

const SU = (over: Partial<{ accountId: string | null; region: string | null; code: string | null }> = {}) => ({
  id: 'su-emp',
  accountId: over.accountId === undefined ? 'acc-emp' : over.accountId,
  region: over.region === undefined ? 'WEST' : over.region,
  employeeCode: 'EMP001',
  hierarchyLevel: over.code === null ? null : { code: over.code ?? 'FIELD_EXEC' },
});

// The start (UTC) of the complete calendar month `n` months before the current (partial) month.
// n=1 ⇒ last complete month; n=3 ⇒ 3 complete months ago. Mid-month 12:00 UTC avoids TZ edges.
const midCompleteMonthsAgo = (n: number): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 15, 12, 0, 0));
};

describe('RewardsService — Employee Rewards Wave 4 (Dream Reward)', () => {
  let service: RewardsService;

  const mockPrisma = {
    client: { findUnique: jest.fn() },
    salesUser: { findFirst: jest.fn() },
    wallet: { findFirst: jest.fn() },
    rewardAccount: { findUnique: jest.fn(), update: jest.fn() },
    rewardCatalog: { findFirst: jest.fn() },
    pointsLedger: { findMany: jest.fn(), findFirst: jest.fn() },
  };
  const mockWallet = { employeeWalletSummary: jest.fn(), employeeTransactions: jest.fn() };
  const mockTenantSettings = { getConversionRate: jest.fn(async () => 2), getEffectiveSettings: jest.fn() };
  const mockNotifications = { notifyUserWithChannels: jest.fn() };
  const mockMsg91 = { sendOtp: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.findUnique.mockResolvedValue(EMPLOYEE_CLIENT);
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU());
    mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w-emp', redeemablePoints: 2000 });
    mockPrisma.rewardAccount.findUnique.mockResolvedValue({ dreamRewardId: null });
    mockPrisma.rewardAccount.update.mockResolvedValue({});
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null);
    mockPrisma.pointsLedger.findMany.mockResolvedValue([]);
    mockPrisma.pointsLedger.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RewardsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWallet },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: Msg91Service, useValue: mockMsg91 },
      ],
    }).compile();
    service = module.get(RewardsService);
  });

  // ─── PUT set-dream — validation gate ────────────────────────────────────────────
  it('set-dream applies the selectable-dream gate (dreamEligible + visibility + tenant) in the WHERE', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU({ code: 'ASM', region: 'WEST' }));
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null); // simulate the gate excluding it
    await expect(service.setEmployeeDreamReward(employee, { rewardId: 'r-bad' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const where = (mockPrisma.rewardCatalog.findFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      id: 'r-bad',
      status: 'ACTIVE',
      deletedAt: null,
      clientId: 'acme', // cross-tenant id can never match — scoped to the caller's tenant
      moderationStatus: 'APPROVED',
      dreamEligible: true, // a non-dream-eligible item is excluded by the gate
      pointsCost: { gt: 0 }, // audit L2-1: a pointsCost:0 item can never be a dream (0% ring vs "reached")
    });
    // Role/region visibility gate (same rule as employeeListCatalog).
    expect(where.AND).toEqual([
      { OR: [{ visibleRoleCodes: { isEmpty: true } }, { visibleRoleCodes: { has: 'ASM' } }] },
      { OR: [{ visibleRegions: { isEmpty: true } }, { visibleRegions: { has: 'WEST' } }] },
    ]);
    expect(where.OR).toBeDefined(); // vendor-visibility cascade still present
    // REJECTED → never persisted.
    expect(mockPrisma.rewardAccount.update).not.toHaveBeenCalled();
  });

  it('set-dream REJECTS and does not persist when the item is not visible / not eligible (findFirst null)', async () => {
    await expect(service.setEmployeeDreamReward(employee, { rewardId: 'r-x' })).rejects.toThrow(
      "That reward can't be set as your Dream Reward.",
    );
    expect(mockPrisma.rewardAccount.update).not.toHaveBeenCalled();
  });

  it('set-dream REJECTS (400) when the employee has no provisioned account', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU({ accountId: null }));
    await expect(service.setEmployeeDreamReward(employee, { rewardId: 'r1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockPrisma.rewardCatalog.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.rewardAccount.update).not.toHaveBeenCalled();
  });

  it('set-dream SUCCESS persists the validated id and returns the resolved shape', async () => {
    mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w-emp', redeemablePoints: 2000 });
    mockPrisma.rewardAccount.findUnique.mockResolvedValue({ dreamRewardId: 'r1' });
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue({
      id: 'r1', name: 'Bike', imageUrls: ['http://img/bike-1.png', 'http://img/bike-2.png'], pointsCost: 5000,
    });

    const res = await service.setEmployeeDreamReward(employee, { rewardId: 'r1' });

    expect(mockPrisma.rewardAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-emp' },
      data: { dreamRewardId: 'r1' },
    });
    expect(res.dreamReward).toEqual({ id: 'r1', name: 'Bike', imageUrl: 'http://img/bike-1.png', pointsCost: 5000 });
    expect(res.pointsRequired).toBe(5000);
    expect(res.redeemablePoints).toBe(2000);
    expect(res.pointsRemaining).toBe(3000);
    expect(res.reached).toBe(false);
  });

  it('set-dream with rewardId null CLEARS the dream (no validation read) and returns null dream', async () => {
    const res = await service.setEmployeeDreamReward(employee, { rewardId: null });
    expect(mockPrisma.rewardCatalog.findFirst).not.toHaveBeenCalled(); // no validation when clearing
    expect(mockPrisma.rewardAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-emp' },
      data: { dreamRewardId: null },
    });
    expect(res.dreamReward).toBeNull();
    expect(res.pointsRequired).toBe(0);
    expect(res.pointsRemaining).toBe(0);
    expect(res.forecastDate).toBeNull();
    expect(res.reached).toBe(false);
  });

  // ─── GET self-heal ───────────────────────────────────────────────────────────────
  it('GET self-heals a stored dream that no longer qualifies — null dream, no error, no mutation', async () => {
    mockPrisma.rewardAccount.findUnique.mockResolvedValue({ dreamRewardId: 'r-stale' });
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue(null); // no longer selectable
    const res = await service.employeeDreamReward(employee);
    expect(res.dreamReward).toBeNull();
    expect(res.pointsRequired).toBe(0);
    expect(res.pointsRemaining).toBe(0);
    expect(res.reached).toBe(false);
    expect(res.forecastDate).toBeNull();
    expect(mockPrisma.rewardAccount.update).not.toHaveBeenCalled(); // self-heal does NOT mutate
  });

  it('GET with no dream set → null dream, zeroed required/remaining', async () => {
    mockPrisma.rewardAccount.findUnique.mockResolvedValue({ dreamRewardId: null });
    const res = await service.employeeDreamReward(employee);
    expect(res.dreamReward).toBeNull();
    expect(mockPrisma.rewardCatalog.findFirst).not.toHaveBeenCalled();
  });

  it('GET exposes imageUrl null when the dream item has no images', async () => {
    mockPrisma.rewardAccount.findUnique.mockResolvedValue({ dreamRewardId: 'r1' });
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'r1', name: 'Watch', imageUrls: null, pointsCost: 1000 });
    const res = await service.employeeDreamReward(employee);
    expect(res.dreamReward).toEqual({ id: 'r1', name: 'Watch', imageUrl: null, pointsCost: 1000 });
  });

  // ─── Forecast / earn-rate math ────────────────────────────────────────────────────
  it('earn-rate: 3 complete months of EARN (first earn 3mo ago) → rate = round(sum/3) + a forecastDate', async () => {
    mockPrisma.rewardAccount.findUnique.mockResolvedValue({ dreamRewardId: 'r1' });
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'r1', name: 'Bike', imageUrls: [], pointsCost: 5000 });
    mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w-emp', redeemablePoints: 2000 });
    // 900 + 900 + 900 over 3 complete months ⇒ sum 2700.
    mockPrisma.pointsLedger.findMany.mockResolvedValue([{ points: 900 }, { points: 900 }, { points: 900 }]);
    // First-ever EARN was 3 complete months ago ⇒ all 3 complete months count ⇒ divisor 3.
    mockPrisma.pointsLedger.findFirst.mockResolvedValue({ createdAt: midCompleteMonthsAgo(3) });

    const res = await service.employeeDreamReward(employee);

    expect(res.monthlyEarnRate).toBe(900); // round(2700 / 3)
    expect(res.pointsRemaining).toBe(3000); // 5000 - 2000
    // days = ceil(3000 / 900 * 30) = ceil(100) = 100.
    expect(res.forecastDate).not.toBeNull();
    const diffDays = Math.round((new Date(res.forecastDate as string).getTime() - Date.now()) / 86_400_000);
    expect(diffDays).toBe(100);
    expect(res.reached).toBe(false);
  });

  it('earn-rate divisor: a 1-month-old employee (first earn last month) divides by 1, not 3', async () => {
    mockPrisma.rewardAccount.findUnique.mockResolvedValue({ dreamRewardId: 'r1' });
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'r1', name: 'Bike', imageUrls: [], pointsCost: 5000 });
    mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w-emp', redeemablePoints: 2000 });
    mockPrisma.pointsLedger.findMany.mockResolvedValue([{ points: 1200 }]); // one complete month of earn
    mockPrisma.pointsLedger.findFirst.mockResolvedValue({ createdAt: midCompleteMonthsAgo(1) }); // first earn last month

    const res = await service.employeeDreamReward(employee);
    expect(res.monthlyEarnRate).toBe(1200); // round(1200 / 1), NOT 400
  });

  it('earn-rate: NO complete-month EARN history → rate 0 and forecastDate null', async () => {
    mockPrisma.rewardAccount.findUnique.mockResolvedValue({ dreamRewardId: 'r1' });
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'r1', name: 'Bike', imageUrls: [], pointsCost: 5000 });
    mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w-emp', redeemablePoints: 2000 });
    mockPrisma.pointsLedger.findMany.mockResolvedValue([]); // no complete-month earn

    const res = await service.employeeDreamReward(employee);
    expect(res.monthlyEarnRate).toBe(0);
    expect(res.pointsRemaining).toBe(3000);
    expect(res.forecastDate).toBeNull(); // rate <= 0
    expect(mockPrisma.pointsLedger.findFirst).not.toHaveBeenCalled(); // short-circuits on empty window
  });

  it('reached: redeemable >= cost → pointsRemaining 0, reached true, forecastDate null (even with a positive rate)', async () => {
    mockPrisma.rewardAccount.findUnique.mockResolvedValue({ dreamRewardId: 'r1' });
    mockPrisma.rewardCatalog.findFirst.mockResolvedValue({ id: 'r1', name: 'Bike', imageUrls: [], pointsCost: 1000 });
    mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w-emp', redeemablePoints: 4000 }); // already affords it
    mockPrisma.pointsLedger.findMany.mockResolvedValue([{ points: 900 }, { points: 900 }, { points: 900 }]);
    mockPrisma.pointsLedger.findFirst.mockResolvedValue({ createdAt: midCompleteMonthsAgo(3) });

    const res = await service.employeeDreamReward(employee);
    expect(res.pointsRemaining).toBe(0);
    expect(res.reached).toBe(true);
    expect(res.forecastDate).toBeNull(); // pointsRemaining <= 0
  });

  // ─── Tenant / caller gating ─────────────────────────────────────────────────────
  it('GET REJECTS a TRADE tenant (fail-safe earner gate) — never reads a dream', async () => {
    mockPrisma.client.findUnique.mockResolvedValue(TRADE_CLIENT);
    await expect(service.employeeDreamReward(employee)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.rewardAccount.findUnique).not.toHaveBeenCalled();
  });

  it('PUT REJECTS a TRADE tenant (fail-safe earner gate) — never persists', async () => {
    mockPrisma.client.findUnique.mockResolvedValue(TRADE_CLIENT);
    await expect(service.setEmployeeDreamReward(employee, { rewardId: 'r1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockPrisma.rewardAccount.update).not.toHaveBeenCalled();
  });

  it('GET REJECTS a non-employee caller (no SalesUser)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(null);
    await expect(service.employeeDreamReward(employee)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
