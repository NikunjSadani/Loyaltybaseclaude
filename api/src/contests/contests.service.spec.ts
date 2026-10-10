// Unit tests for ContestsService (Employee Rewards Phase C — Contests).
// Covers: the EMPLOYEE-earner tenant gate (a trade tenant is rejected); the edit guard
// (no edit after ACTIVE/CREDITED); the credit-bonus once-only guard (a second credit throws,
// no double-credit); winner resolution + eligibility intersection; an inactive/unresolved
// winner skipped-with-reason; that the credit routes through creditEarnForAccount (NOT a
// credit batch, NOT a debit); F2 coexistence (a CONTEST_BONUS credit never touches the
// EMPLOYEE_UPLOAD credit-batch rail); and the rep-contests eligibility-filtered read.
// Run: npx jest src/contests/contests.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ContestsService } from './contests.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

// Stub the account dual-write helpers (their own unit tests cover the tx internals). The
// service still resolves an accountId + mints the wallet through these before crediting.
jest.mock('../common/reward-account.helper', () => ({
  ensureEmployeeAccount: jest.fn().mockResolvedValue('acc-emp-1'),
  ensureEmployeeWallet: jest.fn().mockResolvedValue('wallet-emp-1'),
}));

const employeeUser: JwtPayload = {
  sub: 'user-admin-1',
  clientId: 'tenant-emp',
  role: 'CLIENT_ADMIN',
} as unknown as JwtPayload;

// ─── Mock tx (the $transaction callback client) ─────────────────────────────────
const mockTx = {
  salesUser: { findMany: jest.fn() },
  contest: { updateMany: jest.fn() },
  contestBonusCredit: { create: jest.fn().mockResolvedValue({ id: 'cbc1' }) },
  // A credit batch is NEVER created by the contest rail — spied so we can assert it stays untouched.
  creditBatch: { create: jest.fn(), updateMany: jest.fn(), findFirst: jest.fn() },
  $executeRaw: jest.fn().mockResolvedValue(0),
};

const mockPrisma = {
  client: { findUnique: jest.fn() },
  salesUser: { findFirst: jest.fn() },
  contest: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
  contestBonusCredit: { create: jest.fn() },
  $transaction: jest.fn(
    async (cb: (tx: typeof mockTx) => unknown, _opts?: { timeout?: number; maxWait?: number }) =>
      cb(mockTx),
  ),
};

const mockWallet = {
  creditEarnForAccount: jest.fn().mockResolvedValue({ transactionId: 'wt1', newRedeemable: 100, ledgerId: 'l1' }),
  // Present so a test can assert the contest rail NEVER debits.
  debitRedeemForAccount: jest.fn(),
};

describe('ContestsService', () => {
  let service: ContestsService;

  const asEmployeeTenant = () =>
    mockPrisma.client.findUnique.mockResolvedValue({ loyaltyType: 'EMPLOYEE_REWARDS', features: null });
  const asTradeTenant = () =>
    mockPrisma.client.findUnique.mockResolvedValue({ loyaltyType: 'TRADE_LOYALTY', features: null });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Re-establish defaults cleared above.
    mockTx.contestBonusCredit.create.mockResolvedValue({ id: 'cbc1' });
    mockTx.contest.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.contest.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.contest.count.mockResolvedValue(0);
    mockWallet.creditEarnForAccount.mockResolvedValue({ transactionId: 'wt1', newRedeemable: 100, ledgerId: 'l1' });
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx));
    asEmployeeTenant();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContestsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWallet },
        // Money audit A, Finding 1 — the contest credit now enforces the tenant points safety cap.
        { provide: TenantSettingsService, useValue: { getEffectiveSettings: jest.fn().mockResolvedValue({ creditsPayouts: { safetyCapPoints: 1_000_000 } }) } },
      ],
    }).compile();
    service = module.get(ContestsService);
  });

  // ── EMPLOYEE-earner gate ───────────────────────────────────────────────────
  describe('EMPLOYEE-earner tenant gate', () => {
    it('rejects a trade tenant on create (fail-safe)', async () => {
      asTradeTenant();
      await expect(
        service.createContest(employeeUser, {
          name: 'Q4 Sprint',
          startDate: '2026-11-01T00:00:00.000Z',
          endDate: '2026-11-30T00:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.contest.create).not.toHaveBeenCalled();
    });

    it('rejects a trade tenant on credit-bonus (fail-safe, before any read of the contest)', async () => {
      asTradeTenant();
      await expect(service.creditBonus(employeeUser, 'c1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.creditEarnForAccount).not.toHaveBeenCalled();
    });

    it('allows an employee tenant to create a DRAFT contest', async () => {
      mockPrisma.contest.create.mockResolvedValue({ id: 'c1', status: 'DRAFT' });
      const out = await service.createContest(employeeUser, {
        name: '  Q4 Sprint  ',
        startDate: '2026-11-01T00:00:00.000Z',
        endDate: '2026-11-30T00:00:00.000Z',
        eligibleRoleCodes: ['ASM', 'ASM', ' SO '], // de-duped + trimmed
        bonusPoints: 500,
      });
      expect(out).toEqual({ id: 'c1', status: 'DRAFT' });
      const data = mockPrisma.contest.create.mock.calls[0][0].data;
      expect(data.name).toBe('Q4 Sprint');
      expect(data.eligibleRoleCodes).toEqual(['ASM', 'SO']);
      expect(data.bonusPoints).toBe(500);
      expect(data.status).toBe('DRAFT');
    });

    it('rejects a create whose endDate is not after startDate', async () => {
      await expect(
        service.createContest(employeeUser, {
          name: 'Bad',
          startDate: '2026-11-30T00:00:00.000Z',
          endDate: '2026-11-01T00:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── Edit guard ──────────────────────────────────────────────────────────────
  describe('updateContest guard', () => {
    it('allows editing a DRAFT contest', async () => {
      mockPrisma.contest.findFirst
        .mockResolvedValueOnce({
          id: 'c1',
          clientId: 'tenant-emp',
          status: 'DRAFT',
          startDate: new Date('2026-11-01T00:00:00.000Z'),
          endDate: new Date('2026-11-30T00:00:00.000Z'),
        })
        .mockResolvedValueOnce({ id: 'c1', status: 'DRAFT', name: 'Renamed' });
      await service.updateContest(employeeUser, 'c1', { name: 'Renamed' });
      expect(mockPrisma.contest.updateMany).toHaveBeenCalled();
    });

    it('refuses to edit an ACTIVE contest', async () => {
      mockPrisma.contest.findFirst.mockResolvedValueOnce({
        id: 'c1',
        clientId: 'tenant-emp',
        status: 'ACTIVE',
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        endDate: new Date('2026-11-30T00:00:00.000Z'),
      });
      await expect(service.updateContest(employeeUser, 'c1', { name: 'X' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockPrisma.contest.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to edit a CREDITED contest', async () => {
      mockPrisma.contest.findFirst.mockResolvedValueOnce({
        id: 'c1',
        clientId: 'tenant-emp',
        status: 'CREDITED',
        startDate: new Date('2026-11-01T00:00:00.000Z'),
        endDate: new Date('2026-11-30T00:00:00.000Z'),
      });
      await expect(service.updateContest(employeeUser, 'c1', { name: 'X' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  // ── Credit-bonus: happy path, routing, eligibility, skip, once-only, F2 coexistence ──
  describe('creditBonus', () => {
    const activeContest = {
      id: 'c1',
      clientId: 'tenant-emp',
      name: 'Q4 Sprint',
      status: 'ACTIVE',
      bonusPoints: 500,
      bonusCreditedAt: null,
      eligibleRoleCodes: ['ASM'],
      eligibleRegions: ['WEST'],
    };

    it('credits the whole eligible set via creditEarnForAccount (NOT a batch, NOT a debit)', async () => {
      mockPrisma.contest.findFirst.mockResolvedValue(activeContest);
      mockTx.salesUser.findMany.mockResolvedValue([
        { id: 'su1', employeeCode: 'E1' },
        { id: 'su2', employeeCode: 'E2' },
      ]);

      const out = await service.creditBonus(employeeUser, 'c1', {});

      expect(out.creditedCount).toBe(2);
      expect(out.pointsCreditedTotal).toBe(1000);
      expect(out.skipped).toEqual([]);
      expect(out.credited).toBe(true);

      // Routed through the AUDITED account-first EARN primitive with the CONTEST reference stamp.
      expect(mockWallet.creditEarnForAccount).toHaveBeenCalledTimes(2);
      expect(mockWallet.creditEarnForAccount).toHaveBeenCalledWith(
        'acc-emp-1',
        'tenant-emp',
        500,
        expect.objectContaining({
          referenceType: 'CONTEST',
          referenceId: 'c1',
          sourceType: 'CONTEST_BONUS',
        }),
        mockTx,
      );
      // NEVER the trade debit, NEVER a credit batch (F2 EMPLOYEE_UPLOAD rail untouched).
      expect(mockWallet.debitRedeemForAccount).not.toHaveBeenCalled();
      expect(mockTx.creditBatch.create).not.toHaveBeenCalled();
      expect(mockTx.creditBatch.updateMany).not.toHaveBeenCalled();
      expect(mockTx.creditBatch.findFirst).not.toHaveBeenCalled();
      // One audit-trail child row per credited winner.
      expect(mockTx.contestBonusCredit.create).toHaveBeenCalledTimes(2);
    });

    it('intersects an explicit winner list with eligibility (role + region + code filter)', async () => {
      mockPrisma.contest.findFirst.mockResolvedValue(activeContest);
      mockTx.salesUser.findMany.mockResolvedValue([{ id: 'su1', employeeCode: 'E1' }]);

      await service.creditBonus(employeeUser, 'c1', { winnerEmployeeCodes: ['E1', 'E9'] });

      const where = mockTx.salesUser.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        clientId: 'tenant-emp',
        deletedAt: null,
        isActive: true,
        hierarchyLevel: { code: { in: ['ASM'] } },
        region: { in: ['WEST'] },
        employeeCode: { in: ['E1', 'E9'] },
      });
    });

    it('skips an explicit winner who is not in the eligible/active set, with a reason', async () => {
      mockPrisma.contest.findFirst.mockResolvedValue(activeContest);
      // Only E1 resolves; E2 is inactive/ineligible/unknown → skipped.
      mockTx.salesUser.findMany.mockResolvedValue([{ id: 'su1', employeeCode: 'E1' }]);

      const out = await service.creditBonus(employeeUser, 'c1', { winnerEmployeeCodes: ['E1', 'E2'] });

      expect(out.creditedCount).toBe(1);
      expect(out.skipped).toEqual([{ employeeCode: 'E2', reason: 'NOT_ELIGIBLE_OR_INACTIVE' }]);
      expect(mockWallet.creditEarnForAccount).toHaveBeenCalledTimes(1);
    });

    it('does NOT claim the contest or credit anyone when no eligible winner resolves (re-runnable)', async () => {
      mockPrisma.contest.findFirst.mockResolvedValue(activeContest);
      mockTx.salesUser.findMany.mockResolvedValue([]);

      const out = await service.creditBonus(employeeUser, 'c1', {});

      expect(out.creditedCount).toBe(0);
      expect(out.credited).toBe(false);
      expect(mockTx.contest.updateMany).not.toHaveBeenCalled(); // no status claim → still creditable
      expect(mockWallet.creditEarnForAccount).not.toHaveBeenCalled();
    });

    it('is once-only: a racing second credit sees the guarded claim fail and credits NOBODY', async () => {
      mockPrisma.contest.findFirst.mockResolvedValue(activeContest);
      mockTx.salesUser.findMany.mockResolvedValue([{ id: 'su1', employeeCode: 'E1' }]);
      // The guarded status claim matches 0 rows (another credit already flipped it to CREDITED).
      mockTx.contest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.creditBonus(employeeUser, 'c1', {})).rejects.toBeInstanceOf(ConflictException);
      // No wallet write happened — the claim failed BEFORE any credit (no double-credit).
      expect(mockWallet.creditEarnForAccount).not.toHaveBeenCalled();
      expect(mockTx.contestBonusCredit.create).not.toHaveBeenCalled();
    });

    it('rejects crediting an already-CREDITED contest up-front', async () => {
      mockPrisma.contest.findFirst.mockResolvedValue({
        ...activeContest,
        status: 'CREDITED',
        bonusCreditedAt: new Date(),
      });
      await expect(service.creditBonus(employeeUser, 'c1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.creditEarnForAccount).not.toHaveBeenCalled();
    });

    it('rejects crediting a DRAFT contest (must be ACTIVE or ENDED)', async () => {
      mockPrisma.contest.findFirst.mockResolvedValue({ ...activeContest, status: 'DRAFT' });
      await expect(service.creditBonus(employeeUser, 'c1', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects crediting when bonusPoints is 0', async () => {
      mockPrisma.contest.findFirst.mockResolvedValue({ ...activeContest, bonusPoints: 0 });
      await expect(service.creditBonus(employeeUser, 'c1', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('💰 audit A #1: rejects a bonus exceeding the tenant points safety cap — never claims/credits', async () => {
      mockPrisma.contest.findFirst.mockResolvedValue({ ...activeContest, bonusPoints: 1_000_001 }); // cap = 1,000,000
      await expect(service.creditBonus(employeeUser, 'c1', {})).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWallet.creditEarnForAccount).not.toHaveBeenCalled();
      expect(mockTx.contest.updateMany).not.toHaveBeenCalled(); // not even the once-only claim ran
    });

    it('credits an ENDED contest (ENDED is creditable)', async () => {
      mockPrisma.contest.findFirst.mockResolvedValue({ ...activeContest, status: 'ENDED' });
      mockTx.salesUser.findMany.mockResolvedValue([{ id: 'su1', employeeCode: 'E1' }]);
      const out = await service.creditBonus(employeeUser, 'c1', {});
      expect(out.creditedCount).toBe(1);
      expect(mockWallet.creditEarnForAccount).toHaveBeenCalledTimes(1);
    });
  });

  // ── Rep read: eligibility filter ──────────────────────────────────────────────
  describe('employeeContests (rep read)', () => {
    it('filters ACTIVE/SCHEDULED contests by the employee role/region (empty = all)', async () => {
      // resolveEmployeeReadContext: client is employee-earner + the caller resolves to their own SalesUser.
      mockPrisma.salesUser.findFirst.mockResolvedValue({
        id: 'su1',
        accountId: 'acc-emp-1',
        region: 'WEST',
        employeeCode: 'E1',
        hierarchyLevel: { code: 'ASM' },
      });
      mockPrisma.contest.findMany.mockResolvedValue([{ id: 'c1', name: 'Q4 Sprint' }]);

      const out = await service.employeeContests(employeeUser);
      expect(out.contests).toEqual([{ id: 'c1', name: 'Q4 Sprint' }]);

      const where = mockPrisma.contest.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe('tenant-emp');
      expect(where.status).toEqual({ in: ['ACTIVE', 'SCHEDULED'] });
      // Role gate: empty-list OR has(ASM).
      expect(where.AND[0]).toEqual({
        OR: [{ eligibleRoleCodes: { isEmpty: true } }, { eligibleRoleCodes: { has: 'ASM' } }],
      });
      // Region gate: empty-list OR has(WEST).
      expect(where.AND[1]).toEqual({
        OR: [{ eligibleRegions: { isEmpty: true } }, { eligibleRegions: { has: 'WEST' } }],
      });
    });

    it('rejects a trade tenant on the rep read (via resolveEmployeeReadContext)', async () => {
      asTradeTenant();
      await expect(service.employeeContests(employeeUser)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
