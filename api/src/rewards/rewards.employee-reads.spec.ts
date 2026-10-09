// Employee Rewards Workstream 2 (Wave 2) — unit tests for the ACCOUNT-FIRST employee READ rails.
//
// Covers (per the WS2 Wave-2 brief):
//  - WalletService.employeeWalletSummary / employeeTransactions resolve by accountId (NOT partnerId).
//  - RewardsService.employeeListOrders / employeeGetOrder / employeeTrackOrder scope by accountId.
//  - RewardsService.employeeListCatalog: affordability from the ACCOUNT wallet + the role/region
//    VISIBILITY filter in the WHERE.
//  - A non-employee TENANT (trade) is rejected (fail-safe); a non-employee CALLER (no SalesUser) is
//    rejected; an employee with NO account yet gets an empty (not crashing) result.
//  - Cross-account isolation: another account's order 404s (the accountId pin is the authorization).
//  - The trade reads (getWallet / listTransactions / listOrders / listCatalog) are NOT called.
//
// Run: npx jest src/rewards/rewards.employee-reads.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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

// A SalesUser row as resolveEmployeeReadContext selects it.
const SU = (over: Partial<{ id: string; accountId: string | null; region: string | null; employeeCode: string; code: string | null }> = {}) => ({
  id: over.id ?? 'su-emp',
  accountId: over.accountId === undefined ? 'acc-emp' : over.accountId,
  region: over.region === undefined ? 'WEST' : over.region,
  employeeCode: over.employeeCode ?? 'EMP001',
  hierarchyLevel: over.code === null ? null : { code: over.code ?? 'FIELD_EXEC' },
});

// ─────────────────────────────────────────────────────────────────────────────
// WalletService — employee wallet summary + passbook (account-keyed).
// ─────────────────────────────────────────────────────────────────────────────
describe('WalletService — Employee Rewards WS2 (account-first wallet reads)', () => {
  let service: WalletService;

  const mockPrisma = {
    client: { findUnique: jest.fn() },
    salesUser: { findFirst: jest.fn() },
    wallet: { findFirst: jest.fn() },
    walletTransaction: { findMany: jest.fn(), count: jest.fn() },
    creditBatch: { findMany: jest.fn() },
  };
  const mockTenantSettings = { getConversionRate: jest.fn(async () => 2) };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.findUnique.mockResolvedValue(EMPLOYEE_CLIENT);
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU());
    mockPrisma.wallet.findFirst.mockResolvedValue({
      id: 'w-emp',
      accountId: 'acc-emp',
      partnerId: null,
      earnedPoints: 500,
      lockedPoints: 0,
      redeemablePoints: 300,
      redeemedPoints: 200,
      expiredPoints: 0,
      lifetimeEarned: 500,
      lifetimeRedeemed: 200,
      lifetimeExpired: 0,
    });
    mockPrisma.walletTransaction.findMany.mockResolvedValue([]);
    mockPrisma.walletTransaction.count.mockResolvedValue(0);
    mockPrisma.creditBatch.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
      ],
    }).compile();
    service = module.get(WalletService);
  });

  it('summary resolves the wallet by accountId (NOT partnerId) and carries the tenant rate', async () => {
    const res = await service.employeeWalletSummary(employee);
    expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { accountId: 'acc-emp' } });
    // Never resolved via a partner.
    const partnerCalls = mockPrisma.wallet.findFirst.mock.calls.filter(
      (c) => (c[0] as { where?: { partnerId?: unknown } })?.where?.partnerId !== undefined,
    );
    expect(partnerCalls).toHaveLength(0);
    expect(res).toMatchObject({ redeemablePoints: 300, earnedPoints: 500, conversionRate: 2, currency: 'POINTS' });
  });

  it('REJECTS a TRADE tenant (fail-safe earner gate) — no wallet read', async () => {
    mockPrisma.client.findUnique.mockResolvedValue(TRADE_CLIENT);
    await expect(service.employeeWalletSummary(employee)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
  });

  it('REJECTS a caller with no SalesUser (non-employee)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(null);
    await expect(service.employeeWalletSummary(employee)).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
  });

  it('employee with NO account yet → ZEROED summary (not a crash, no wallet read)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU({ accountId: null }));
    const res = await service.employeeWalletSummary(employee);
    expect(res).toMatchObject({ redeemablePoints: 0, earnedPoints: 0, conversionRate: 2 });
    expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
  });

  it('passbook resolves transactions by the ACCOUNT wallet id (NOT partnerId)', async () => {
    mockPrisma.walletTransaction.findMany.mockResolvedValueOnce([
      { id: 't1', transactionType: 'CREDIT_POINTS_EARNED', description: 'Gift', points: 100, createdAt: new Date(), balanceType: 'REDEEMABLE', balanceAfter: 300, referenceType: null, referenceId: null },
    ]).mockResolvedValueOnce([]); // the 2nd findMany is the CREDIT_BATCH field-name query
    mockPrisma.walletTransaction.count.mockResolvedValue(1);

    const res = await service.employeeTransactions(employee, {} as never);
    expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { accountId: 'acc-emp' } });
    expect(mockPrisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletId: 'w-emp' } }),
    );
    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0]).toMatchObject({ id: 't1', fieldName: null, narration: 'Gift' });
  });

  it('passbook for an employee with NO account yet → empty page (not a crash)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU({ accountId: null }));
    const res = await service.employeeTransactions(employee, { page: 1, limit: 20 } as never);
    expect(res).toEqual({ transactions: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } });
    expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RewardsService — employee orders + catalogue (account-keyed).
// ─────────────────────────────────────────────────────────────────────────────
describe('RewardsService — Employee Rewards WS2 (account-first order + catalogue reads)', () => {
  let service: RewardsService;

  const mockPrisma = {
    client: { findUnique: jest.fn() },
    salesUser: { findFirst: jest.fn() },
    wallet: { findFirst: jest.fn() },
    redemptionOrder: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
    rewardCatalog: { findMany: jest.fn(), count: jest.fn() },
    employeeTarget: { findUnique: jest.fn() },
  };
  const mockWallet = {
    getWallet: jest.fn(),
    listTransactions: jest.fn(),
    employeeWalletSummary: jest.fn(),
    employeeTransactions: jest.fn(),
  };
  const mockTenantSettings = {
    getConversionRate: jest.fn(async () => 2),
    getEffectiveSettings: jest.fn(),
  };
  const mockNotifications = { notifyUserWithChannels: jest.fn() };
  const mockMsg91 = { sendOtp: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.findUnique.mockResolvedValue(EMPLOYEE_CLIENT);
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU());
    mockPrisma.wallet.findFirst.mockResolvedValue({ id: 'w-emp', accountId: 'acc-emp', redeemablePoints: 300 });
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([]);
    mockPrisma.redemptionOrder.count.mockResolvedValue(0);
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null);
    mockPrisma.rewardCatalog.findMany.mockResolvedValue([]);
    mockPrisma.rewardCatalog.count.mockResolvedValue(0);
    mockPrisma.employeeTarget.findUnique.mockResolvedValue(null);

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

  // ─── Orders list ─────────────────────────────────────────────────────────────
  it('employeeListOrders scopes by accountId (NOT partner) + never calls the trade listOrders', async () => {
    const tradeSpy = jest.spyOn(service, 'listOrders');
    mockPrisma.redemptionOrder.findMany.mockResolvedValue([
      { id: 'o1', orderNumber: 'A-1', status: 'CONFIRMED', redemptionMode: 'PHYSICAL_GIFT', totalPointsCost: 50, quantity: 1, updatedAt: new Date(), createdAt: new Date(), reward: null, partner: null },
    ]);
    mockPrisma.redemptionOrder.count.mockResolvedValue(1);

    const res = await service.employeeListOrders(employee, {} as never);

    const whereArg = (mockPrisma.redemptionOrder.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(whereArg).toEqual({ accountId: 'acc-emp' });
    expect(whereArg.partnerId).toBeUndefined();
    expect(whereArg.partner).toBeUndefined();
    expect(res.orders).toHaveLength(1);
    expect(tradeSpy).not.toHaveBeenCalled();
    expect(mockWallet.getWallet).not.toHaveBeenCalled();
  });

  it('employeeListOrders applies a status filter alongside the accountId scope', async () => {
    await service.employeeListOrders(employee, { status: 'DELIVERED' } as never);
    const whereArg = (mockPrisma.redemptionOrder.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(whereArg).toEqual({ accountId: 'acc-emp', status: 'DELIVERED' });
  });

  it('employeeListOrders for an employee with NO account yet → empty (no DB query)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU({ accountId: null }));
    const res = await service.employeeListOrders(employee, { page: 1, limit: 20 } as never);
    expect(res).toEqual({ orders: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } });
    expect(mockPrisma.redemptionOrder.findMany).not.toHaveBeenCalled();
  });

  it('REJECTS a TRADE tenant on the order list (fail-safe earner gate)', async () => {
    mockPrisma.client.findUnique.mockResolvedValue(TRADE_CLIENT);
    await expect(service.employeeListOrders(employee, {} as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.redemptionOrder.findMany).not.toHaveBeenCalled();
  });

  // ─── Order detail — cross-account isolation ────────────────────────────────────
  it('employeeGetOrder pins the query to the OWN accountId (cross-account isolation)', async () => {
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue({ id: 'o1', partnerId: null, orderNumber: 'A-1' });
    await service.employeeGetOrder(employee, 'o1');
    const call = mockPrisma.redemptionOrder.findFirst.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where).toEqual({ id: 'o1', accountId: 'acc-emp' });
  });

  it("employeeGetOrder 404s an order that is not the employee's own (another account)", async () => {
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue(null); // the where pins accountId → no match
    await expect(service.employeeGetOrder(employee, 'o-foreign')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('employeeGetOrder 404s when the employee has no account yet', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU({ accountId: null }));
    await expect(service.employeeGetOrder(employee, 'o1')).rejects.toBeInstanceOf(NotFoundException);
    expect(mockPrisma.redemptionOrder.findFirst).not.toHaveBeenCalled();
  });

  // ─── Order track ───────────────────────────────────────────────────────────────
  it('employeeTrackOrder scopes by accountId and returns the member-safe tracking payload', async () => {
    mockPrisma.redemptionOrder.findFirst.mockResolvedValue({
      id: 'o1', orderNumber: 'A-1', status: 'DISPATCHED', reward: { id: 'r1', name: 'Mug', imageUrls: [] },
      quantity: 1, logisticsPartner: 'BlueDart', trackingNumber: 'TN1', trackingUrl: 'https://t', dispatchedAt: new Date(), deliveredAt: null, cancelledAt: null,
      statusHistory: [{ fromStatus: null, toStatus: 'CONFIRMED', createdAt: new Date() }],
    });
    const res = await service.employeeTrackOrder(employee, 'o1');
    const call = mockPrisma.redemptionOrder.findFirst.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where).toEqual({ id: 'o1', accountId: 'acc-emp' });
    expect(res.tracking).toMatchObject({ orderId: 'o1', status: 'DISPATCHED', logisticsPartner: 'BlueDart' });
    expect(res.tracking.timeline).toHaveLength(1);
  });

  // ─── Catalogue: affordability (account balance) + visibility filter ─────────────
  it('employeeListCatalog uses the ACCOUNT wallet balance for affordability + never calls the trade listCatalog', async () => {
    const tradeSpy = jest.spyOn(service, 'listCatalog');
    mockPrisma.rewardCatalog.findMany.mockResolvedValue([
      { id: 'r1', name: 'Cheap', pointsCost: 100, category: { name: 'Gifts' }, sourceType: 'PLATFORM' },
      { id: 'r2', name: 'Dear', pointsCost: 400, category: null, sourceType: 'PLATFORM' },
    ]);
    mockPrisma.rewardCatalog.count.mockResolvedValue(2);

    const res = await service.employeeListCatalog(employee, {} as never);

    expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({ where: { accountId: 'acc-emp' } });
    expect(res.userBalance).toBe(300);
    expect(res.items.find((i) => i.id === 'r1')?.isAffordable).toBe(true); // 300 >= 100
    expect(res.items.find((i) => i.id === 'r2')?.isAffordable).toBe(false); // 300 < 400
    expect(tradeSpy).not.toHaveBeenCalled();
  });

  it('employeeListCatalog applies the role/region VISIBILITY filter in the WHERE', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU({ code: 'ASM', region: 'WEST' }));
    await service.employeeListCatalog(employee, {} as never);
    const whereArg = (mockPrisma.rewardCatalog.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(whereArg.AND).toEqual([
      { OR: [{ visibleRoleCodes: { isEmpty: true } }, { visibleRoleCodes: { has: 'ASM' } }] },
      { OR: [{ visibleRegions: { isEmpty: true } }, { visibleRegions: { has: 'WEST' } }] },
    ]);
    // Vendor-visibility cascade (OR) is still present (byte-identical gate shared with the trade read).
    expect(whereArg.OR).toBeDefined();
    expect(whereArg.moderationStatus).toBe('APPROVED');
    expect(whereArg.clientId).toBe('acme');
  });

  it('employeeListCatalog with a NULL role/region only matches EMPTY (unrestricted) visibility lists', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU({ code: null, region: null }));
    await service.employeeListCatalog(employee, {} as never);
    const whereArg = (mockPrisma.rewardCatalog.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(whereArg.AND).toEqual([
      { OR: [{ visibleRoleCodes: { isEmpty: true } }] },
      { OR: [{ visibleRegions: { isEmpty: true } }] },
    ]);
  });

  it('employeeListCatalog for an employee with NO account yet → userBalance 0 (nothing affordable), no wallet read', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(SU({ accountId: null }));
    mockPrisma.rewardCatalog.findMany.mockResolvedValue([{ id: 'r1', name: 'X', pointsCost: 10, category: null, sourceType: 'PLATFORM' }]);
    mockPrisma.rewardCatalog.count.mockResolvedValue(1);
    const res = await service.employeeListCatalog(employee, {} as never);
    expect(res.userBalance).toBe(0);
    expect(res.items[0].isAffordable).toBe(false);
    expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
  });

  it('REJECTS a non-employee caller (no SalesUser) on the catalogue read', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(null);
    await expect(service.employeeListCatalog(employee, {} as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ─── Phase C: employee DISPLAY target read ──────────────────────────────────────
  it('employeeTarget resolves the OWN employee and returns the period target', async () => {
    mockPrisma.employeeTarget.findUnique.mockResolvedValue({ targetPoints: 500 });
    const res = await service.employeeTarget(employee, { period: '2026-05' });
    expect(res).toEqual({ period: '2026-05', targetPoints: 500 });
    // Looked up on the OWN resolved employeeCode (SU() → 'EMP001') + the requested period.
    expect(mockPrisma.employeeTarget.findUnique).toHaveBeenCalledWith({
      where: { clientId_employeeCode_period: { clientId: 'acme', employeeCode: 'EMP001', period: '2026-05' } },
      select: { targetPoints: true },
    });
  });

  it('employeeTarget returns null when the employee has no target for the period', async () => {
    mockPrisma.employeeTarget.findUnique.mockResolvedValue(null);
    const res = await service.employeeTarget(employee, { period: '2026-05' });
    expect(res).toEqual({ period: '2026-05', targetPoints: null });
  });

  it('employeeTarget defaults to the current IST month when no period is given', async () => {
    mockPrisma.employeeTarget.findUnique.mockResolvedValue(null);
    const res = await service.employeeTarget(employee, {});
    // Current IST month key, computed the same way the service does (shift-then-read-UTC).
    const shifted = new Date(Date.now() + (5 * 60 + 30) * 60_000);
    const expected = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(res.period).toBe(expected);
    expect(res.targetPoints).toBeNull();
    const call = mockPrisma.employeeTarget.findUnique.mock.calls[0][0] as { where: { clientId_employeeCode_period: { period: string } } };
    expect(call.where.clientId_employeeCode_period.period).toBe(expected);
  });

  it('employeeTarget REJECTS a TRADE tenant (fail-safe earner gate) — no target read', async () => {
    mockPrisma.client.findUnique.mockResolvedValue(TRADE_CLIENT);
    await expect(service.employeeTarget(employee, { period: '2026-05' })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.employeeTarget.findUnique).not.toHaveBeenCalled();
  });

  it('employeeTarget REJECTS a non-employee caller (no SalesUser)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(null);
    await expect(service.employeeTarget(employee, { period: '2026-05' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.employeeTarget.findUnique).not.toHaveBeenCalled();
  });
});
