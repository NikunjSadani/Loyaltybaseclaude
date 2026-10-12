// Employee Rewards Wave 5 — unit tests for the TEAM MANAGER ROLLUP read rail
// (RewardsService.employeeTeamRollup). READ-ONLY (no points move). Covers:
//  - A 3-level tree (manager → 2 sub-managers + 1 leaf → leaves): the manager's rollup aggregates
//    each direct member's WHOLE subtree (not just self); a sub-manager member shows their subtree sum.
//  - achievedPct uses the member's current-period EmployeeTarget; trend is up/down/flat vs last month.
//  - Drill-down into a sub-manager's team (managerId within the caller's subtree).
//  - A managerId OUTSIDE the caller's subtree is rejected (403) — a manager may only drill their own
//    downline (models cross-subtree / cross-tenant isolation at the authorization boundary).
//  - A leaf caller → isManager:false + empty members + zeroed rollup + the caller's OWN 6-month series.
//  - Tenant/caller gating: a TRADE tenant (400) / a non-employee caller (403) never reach a team.
//  - Tenant scoping: the edge list + targets are queried with the caller's clientId; wallets only for
//    accountIds inside the resolved subtree.
//
// Date-RELATIVE: all ledger dates are computed from `new Date()` (never a hardcoded month/date).
//
// Run: npx jest src/rewards/rewards.employee-team.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RewardsService } from './rewards.service';
import { WalletService } from '../wallet/wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { istMonthKey } from '../common/ist-date';

const EMPLOYEE_CLIENT = { loyaltyType: 'EMPLOYEE_REWARDS', features: null };
const TRADE_CLIENT = { loyaltyType: 'TRADE_LOYALTY', features: null };

const user: JwtPayload = { sub: 'u-emp', role: 'ASM', clientId: 'acme', phone: '98300', name: 'Mgr' };

// The caller's own SalesUser, as resolveEmployeeReadContext selects it.
const callerSU = (id: string, accountId: string | null, employeeCode: string) => ({
  id,
  accountId,
  region: 'WEST',
  employeeCode,
  hierarchyLevel: { code: 'ASM' },
});

// A tenant SalesUser row as employeeTeamRollup's findMany selects it.
const node = (
  id: string,
  reportingToId: string | null,
  employeeCode: string,
  accountId: string | null,
  isActive = true,
) => ({
  id,
  reportingToId,
  isActive,
  region: 'WEST',
  employeeCode,
  accountId,
  hierarchyLevel: { name: 'Area Sales Manager' },
  user: { name: `User ${employeeCode}` },
});

// The 3-level tree:  M → {S1, S2, S3};  S1 → {L1a, L1b};  S2 → {L2a};  S3 = leaf.
const TREE = [
  node('su-M', null, 'M', 'acc-M'),
  node('su-S1', 'su-M', 'S1', 'acc-S1'),
  node('su-S2', 'su-M', 'S2', 'acc-S2'),
  node('su-S3', 'su-M', 'S3', 'acc-S3'),
  node('su-L1a', 'su-S1', 'L1a', 'acc-L1a'),
  node('su-L1b', 'su-S1', 'L1b', 'acc-L1b'),
  node('su-L2a', 'su-S2', 'L2a', 'acc-L2a'),
];

const WALLETS = [
  { id: 'w-M', accountId: 'acc-M', redeemablePoints: 0 },
  { id: 'w-S1', accountId: 'acc-S1', redeemablePoints: 100 },
  { id: 'w-S2', accountId: 'acc-S2', redeemablePoints: 50 },
  { id: 'w-S3', accountId: 'acc-S3', redeemablePoints: 10 },
  { id: 'w-L1a', accountId: 'acc-L1a', redeemablePoints: 200 },
  { id: 'w-L1b', accountId: 'acc-L1b', redeemablePoints: 300 },
  { id: 'w-L2a', accountId: 'acc-L2a', redeemablePoints: 400 },
];

// Date-relative ledger. thisMonth/prevMonth are mid-month 12:00 UTC (inside the IST month too).
const now = new Date();
const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12, 0, 0));
const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12, 0, 0));

const LEDGER = [
  // S1 subtree: earn THIS 500 (L1a 200 + L1b 300), redeem THIS 50, earn PREV 100 → trend UP.
  { walletId: 'w-L1a', transactionType: 'EARN', points: 200, createdAt: thisMonth },
  { walletId: 'w-L1a', transactionType: 'EARN', points: 100, createdAt: prevMonth },
  { walletId: 'w-L1b', transactionType: 'EARN', points: 300, createdAt: thisMonth },
  { walletId: 'w-L1b', transactionType: 'REDEEM', points: 50, createdAt: thisMonth },
  // S2 subtree: earn THIS 100, earn PREV 400 → trend DOWN.
  { walletId: 'w-L2a', transactionType: 'EARN', points: 100, createdAt: thisMonth },
  { walletId: 'w-L2a', transactionType: 'EARN', points: 400, createdAt: prevMonth },
  // S3 leaf: earn THIS 20 == earn PREV 20 → trend FLAT.
  { walletId: 'w-S3', transactionType: 'EARN', points: 20, createdAt: thisMonth },
  { walletId: 'w-S3', transactionType: 'EARN', points: 20, createdAt: prevMonth },
];

// Current-period targets. The member row's target is the TEAM target = SUM over that member's
// subtree, so S1's target = S1 (1000) + L1a (500) = 1500 and achievedPct = 500/1500 = 33% — this
// pins the team-target semantics (a personal-target-only impl would wrongly show 500/1000 = 50%).
// S2 → 200% (100/50, on-track); S3 → NONE (null).
const TARGETS = [
  { employeeCode: 'S1', targetPoints: 1000 },
  { employeeCode: 'L1a', targetPoints: 500 },
  { employeeCode: 'S2', targetPoints: 50 },
];

describe('RewardsService — Employee Rewards Wave 5 (team manager rollup)', () => {
  let service: RewardsService;

  const mockPrisma = {
    client: { findUnique: jest.fn() },
    salesUser: { findFirst: jest.fn(), findMany: jest.fn() },
    wallet: { findMany: jest.fn() },
    pointsLedger: { findMany: jest.fn() },
    employeeTarget: { findMany: jest.fn() },
  };
  const mockWallet = { employeeWalletSummary: jest.fn(), employeeTransactions: jest.fn() };
  const mockTenantSettings = { getConversionRate: jest.fn(async () => 2) };
  const mockNotifications = { notifyUserWithChannels: jest.fn() };
  const mockMsg91 = { sendOtp: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.findUnique.mockResolvedValue(EMPLOYEE_CLIENT);
    mockPrisma.salesUser.findFirst.mockResolvedValue(callerSU('su-M', 'acc-M', 'M'));
    mockPrisma.salesUser.findMany.mockResolvedValue(TREE);
    mockPrisma.wallet.findMany.mockResolvedValue(WALLETS);
    mockPrisma.pointsLedger.findMany.mockResolvedValue(LEDGER);
    mockPrisma.employeeTarget.findMany.mockResolvedValue(TARGETS);

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

  it('manager rollup aggregates each direct member over their WHOLE subtree + totals/avg/on-track', async () => {
    const res = await service.employeeTeamRollup(user);

    expect(res.root).toEqual({
      salesUserId: 'su-M',
      name: 'User M',
      employeeCode: 'M',
      roleName: 'Area Sales Manager',
    });
    expect(res.isManager).toBe(true);
    expect(res.members).toHaveLength(3);

    const bySid = Object.fromEntries(res.members.map((m) => [m.salesUserId, m]));

    // S1 — sub-manager: pointsBalance is the SUBTREE sum (100 + 200 + 300), NOT just self.
    expect(bySid['su-S1']).toMatchObject({
      pointsBalance: 600,
      teamSize: 3,
      directReportCount: 2,
      isManager: true,
      earnedThisMonth: 500,
      redeemedThisMonth: 50,
      targetPoints: 1500, // TEAM target: S1 (1000) + L1a (500)
      achievedPct: 33, // 500 / 1500 (team earn ÷ team target)
      trend: 'up', // 500 this vs 100 prev
      region: 'WEST',
      roleName: 'Area Sales Manager',
    });

    // S2 — sub-manager: subtree sum (50 + 400); on-track (200%); trend down (100 vs 400).
    expect(bySid['su-S2']).toMatchObject({
      pointsBalance: 450,
      teamSize: 2,
      directReportCount: 1,
      isManager: true,
      earnedThisMonth: 100,
      achievedPct: 200, // 100 / 50
      trend: 'down',
    });

    // S3 — leaf direct member: just self; no target → achievedPct null; flat trend.
    expect(bySid['su-S3']).toMatchObject({
      pointsBalance: 10,
      teamSize: 1,
      directReportCount: 0,
      isManager: false,
      earnedThisMonth: 20,
      targetPoints: null,
      achievedPct: null,
      trend: 'flat',
    });

    // Rollup over the direct members (disjoint subtrees sum correctly).
    expect(res.rollup).toEqual({
      memberCount: 3,
      earnedThisMonth: 620, // 500 + 100 + 20
      redeemedThisMonth: 50,
      avgAchievementPct: 117, // round(mean(33, 200)); S3 (null) ignored
      onTrackCount: 1, // only S2 >= 100
    });

    // 6-month series over the whole subtree EXCLUDING the root manager.
    expect(res.monthly).toHaveLength(6);
    const current = res.monthly[5];
    const previous = res.monthly[4];
    expect(current.monthKey).toBe(istMonthKey(thisMonth));
    expect(current.earned).toBe(620); // 200 + 300 + 100 + 20
    expect(current.redeemed).toBe(50);
    expect(previous.earned).toBe(520); // 100 (L1a) + 400 (L2a) + 20 (S3)
  });

  it('drills into a sub-manager within the caller subtree (managerId = su-S1)', async () => {
    const res = await service.employeeTeamRollup(user, 'su-S1');
    expect(res.root?.salesUserId).toBe('su-S1');
    expect(res.isManager).toBe(true);
    expect(res.members.map((m) => m.salesUserId).sort()).toEqual(['su-L1a', 'su-L1b']);
    // Each drilled member is a leaf → just self.
    const l1a = res.members.find((m) => m.salesUserId === 'su-L1a')!;
    expect(l1a).toMatchObject({ pointsBalance: 200, teamSize: 1, isManager: false, trend: 'up' });
    expect(res.rollup.earnedThisMonth).toBe(500); // 200 + 300
    // monthly = S1 subtree excl S1 = {L1a, L1b}.
    expect(res.monthly[5].earned).toBe(500);
  });

  it('REJECTS a managerId outside the caller subtree (a sibling sub-manager)', async () => {
    // Caller is S1; S2 is a sibling (NOT in S1's downline) → forbidden to drill into it.
    mockPrisma.salesUser.findFirst.mockResolvedValue(callerSU('su-S1', 'acc-S1', 'S1'));
    await expect(service.employeeTeamRollup(user, 'su-S2')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Also a wholly foreign / non-existent id (e.g. another tenant's) is rejected.
    await expect(service.employeeTeamRollup(user, 'su-FOREIGN')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a LEAF caller → isManager:false, empty members, zeroed rollup, OWN 6-month series', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(callerSU('su-L1a', 'acc-L1a', 'L1a'));
    const res = await service.employeeTeamRollup(user);
    expect(res.root?.salesUserId).toBe('su-L1a');
    expect(res.isManager).toBe(false);
    expect(res.members).toEqual([]);
    expect(res.rollup).toEqual({
      memberCount: 0,
      earnedThisMonth: 0,
      redeemedThisMonth: 0,
      avgAchievementPct: 0,
      onTrackCount: 0,
    });
    // monthly = the caller's OWN wallet series (w-L1a: this 200, prev 100).
    expect(res.monthly[5].earned).toBe(200);
    expect(res.monthly[4].earned).toBe(100);
  });

  it('REJECTS a TRADE tenant (400) before any hierarchy read', async () => {
    mockPrisma.client.findUnique.mockResolvedValue(TRADE_CLIENT);
    await expect(service.employeeTeamRollup(user)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.salesUser.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.findMany).not.toHaveBeenCalled();
  });

  it('REJECTS a non-employee caller with no SalesUser (403)', async () => {
    mockPrisma.salesUser.findFirst.mockResolvedValue(null);
    await expect(service.employeeTeamRollup(user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.salesUser.findMany).not.toHaveBeenCalled();
  });

  it('tenant-scopes the hierarchy + target reads and only reads in-subtree wallets', async () => {
    await service.employeeTeamRollup(user);

    expect(mockPrisma.salesUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: 'acme', deletedAt: null } }),
    );
    // Targets queried with the caller's clientId + the current period + the WHOLE subtree codes
    // (team target = sum over each member's subtree needs every descendant's target, not just the
    // direct members').
    const targetArgs = mockPrisma.employeeTarget.findMany.mock.calls[0][0] as {
      where: { clientId: string; period: string; employeeCode: { in: string[] } };
    };
    expect(targetArgs.where.clientId).toBe('acme');
    expect(targetArgs.where.period).toBe(istMonthKey(new Date()));
    expect(targetArgs.where.employeeCode.in.sort()).toEqual(
      ['L1a', 'L1b', 'L2a', 'M', 'S1', 'S2', 'S3'],
    );
    // Wallets read ONLY for accountIds inside the resolved (root M) subtree — never the whole tenant.
    const walletArgs = mockPrisma.wallet.findMany.mock.calls[0][0] as {
      where: { accountId: { in: string[] } };
    };
    expect(walletArgs.where.accountId.in.sort()).toEqual(
      ['acc-L1a', 'acc-L1b', 'acc-L2a', 'acc-M', 'acc-S1', 'acc-S2', 'acc-S3'].sort(),
    );
  });
});
