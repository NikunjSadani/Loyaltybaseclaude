// Employee Rewards Phase C — unit tests for the EMPLOYEE points credit path on CreditsService.
// Covers: the EMPLOYEE-earner tenant gate (trade tenant rejected), createEmployeeBatch provenance +
// idempotency, confirmEmployeeBatch per-row resolve → ensureEmployeeAccount + ensureEmployeeWallet +
// creditEarnForAccount, unresolved-employee skip, the guarded double-confirm claim, and Deoleo-safety
// (a trade batch cannot be confirmed through the employee path; the trade confirm still uses creditEarn).
// Run: npx jest src/credits/credits.employee-batch.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { CreditsService } from './credits.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { InvoicesService } from '../invoices/invoices.service';
import { TdsStatutoryConfigService } from '../tds/tds-statutory.config.service';
import { DEFAULT_RESOLVED_TDS_STATUTORY } from '../tds/tds.helpers';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { CreateEmployeeBatchDto, UploadRowStatus } from './dto/credits.dto';
import { CreditAwardType } from '@prisma/client';

// Account helpers are stubbed (they have their own unit tests) so these specs assert the
// ORCHESTRATION (which helper is called with what), not the helpers' internal tx calls.
jest.mock('../common/reward-account.helper', () => ({
  ensureOutletAccount: jest.fn().mockResolvedValue('acc-outlet'),
  ensureEmployeeAccount: jest.fn().mockResolvedValue('acc-emp'),
  ensureEmployeeWallet: jest.fn().mockResolvedValue('w-emp'),
}));
import {
  ensureEmployeeAccount,
  ensureEmployeeWallet,
} from '../common/reward-account.helper';

const mockStatutory = { getForFy: jest.fn().mockResolvedValue(DEFAULT_RESOLVED_TDS_STATUTORY) };

const mockWalletService = {
  creditEarn: jest.fn().mockResolvedValue({ transactionId: 'wt1', newRedeemable: 50, ledgerId: 'l1' }),
  creditEarnForAccount: jest.fn().mockResolvedValue({ transactionId: 'wtE', newRedeemable: 50, ledgerId: 'lE' }),
  clawbackAward: jest.fn().mockResolvedValue({ transactionId: 'wt2', newRedeemable: 0, ledgerId: 'l2', shortfall: 0 }),
};

const mockTx = {
  creditBatch: {
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(),
  },
  salesUser: { findFirst: jest.fn() },
  outlet: { findFirst: jest.fn() },
  wallet: { upsert: jest.fn().mockResolvedValue({ id: 'w1' }), findFirst: jest.fn() },
  // Employee Rewards Phase C — the DISPLAY-only target upsert (no money).
  employeeTarget: { upsert: jest.fn().mockResolvedValue({ id: 'et1' }) },
  $executeRaw: jest.fn().mockResolvedValue(0),
};

const mockPrisma = {
  client: { findUnique: jest.fn() },
  creditBatch: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
  salesUser: { findFirst: jest.fn() },
  channelPartner: { findFirst: jest.fn() },
  wallet: { findFirst: jest.fn() },
  creditField: { findMany: jest.fn().mockResolvedValue([]) },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const mockNotifications = {
  enqueue: jest.fn().mockResolvedValue({ id: 'n1' }),
  notifyUserWithChannels: jest.fn().mockResolvedValue(undefined),
};
const mockMsg91 = { sendWhatsappTemplate: jest.fn().mockResolvedValue(undefined) };

let mockCreditsPayouts: {
  monthCutoffDay: number;
  safetyCapPoints: number;
  safetyCapInr: number;
  fourEyesEnabled: boolean;
  notifyEmails: string[];
};
const mockTenantSettings = {
  getEffectiveSettings: jest.fn(async () => ({ creditsPayouts: mockCreditsPayouts })),
  resolveTdsPolicy: jest.fn(async () => ({ section: 'SEC_194C', methodology: 'GROSS_UP' })),
};
const mockInvoicesService = {
  generateForBatch: jest.fn(async () => ({ generated: 0, linked: 0, skipped: [] })),
};

const admin: JwtPayload = { sub: 'admin1', role: 'CLIENT_ADMIN', clientId: 'acme', phone: '', name: '' };
const EMPLOYEE_CLIENT = { loyaltyType: 'EMPLOYEE_REWARDS', features: null };
const TRADE_CLIENT = { loyaltyType: 'TRADE_LOYALTY', features: null };

describe('CreditsService — Employee Rewards Phase C (employee points credit)', () => {
  let service: CreditsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCreditsPayouts = {
      monthCutoffDay: 31, // window always open for any prior month (date-independent)
      safetyCapPoints: 1_000_000,
      safetyCapInr: 10_000_000,
      fourEyesEnabled: false,
      notifyEmails: [],
    };
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx));
    mockTx.creditBatch.updateMany.mockResolvedValue({ count: 1 });
    // Args-aware: a `where:{ id:'<string>' }` lookup is the post-claim re-read of THIS batch (return it);
    // any OTHER lookup (the F2 period-uniqueness probe `id:{not}` / createEmployeeBatch's activeConfirmed
    // probe) returns null by default = "no other/active batch for this period".
    mockTx.creditBatch.findFirst.mockImplementation((args: { where?: { id?: unknown } }) => {
      const w = args?.where ?? {};
      if (typeof w.id === 'string') {
        return Promise.resolve({ id: w.id, status: 'CONFIRMED', sourceKind: 'EMPLOYEE_UPLOAD' });
      }
      return Promise.resolve(null);
    });
    mockTx.creditBatch.deleteMany.mockResolvedValue({ count: 0 });
    mockTx.creditBatch.count.mockResolvedValue(0);
    mockTx.$executeRaw.mockResolvedValue(0);
    mockTx.salesUser.findFirst.mockResolvedValue(null);
    mockTx.employeeTarget.upsert.mockResolvedValue({ id: 'et1' });
    (ensureEmployeeAccount as jest.Mock).mockResolvedValue('acc-emp');
    (ensureEmployeeWallet as jest.Mock).mockResolvedValue('w-emp');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: Msg91Service, useValue: mockMsg91 },
        { provide: WalletService, useValue: mockWalletService },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: InvoicesService, useValue: mockInvoicesService },
        { provide: TdsStatutoryConfigService, useValue: mockStatutory },
      ],
    }).compile();
    service = module.get(CreditsService);
  });

  // ─── Tenant gate (Deoleo-safety) ─────────────────────────────────────────────
  describe('EMPLOYEE-earner gate', () => {
    const dto: CreateEmployeeBatchDto = {
      period: '2026-05', totalEmployees: 1, totalPoints: 50, rows: [],
    };

    it('createEmployeeBatch REJECTS a TRADE tenant (fail-safe earner gate)', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(TRADE_CLIENT);
      await expect(service.createEmployeeBatch(admin, dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockTx.creditBatch.create).not.toHaveBeenCalled();
    });

    it('createEmployeeBatch REJECTS an unknown/absent loyaltyType (fail-safe → TRADE)', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      await expect(service.createEmployeeBatch(admin, dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirmEmployeeBatch REJECTS a TRADE tenant', async () => {
      mockPrisma.client.findUnique.mockResolvedValue(TRADE_CLIENT);
      await expect(service.confirmEmployeeBatch(admin, 'b1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWalletService.creditEarnForAccount).not.toHaveBeenCalled();
    });
  });

  // ─── createEmployeeBatch ─────────────────────────────────────────────────────
  describe('createEmployeeBatch', () => {
    beforeEach(() => mockPrisma.client.findUnique.mockResolvedValue(EMPLOYEE_CLIENT));

    it('creates a PENDING_CONFIRM batch tagged EMPLOYEE_UPLOAD, points-only (totalPayoutPaise 0)', async () => {
      mockTx.creditBatch.count.mockResolvedValue(0);
      mockTx.creditBatch.create.mockResolvedValue({ id: 'bNew', sourceKind: 'EMPLOYEE_UPLOAD' });
      const dto: CreateEmployeeBatchDto = {
        period: '2026-05',
        totalEmployees: 2,
        totalPoints: 150,
        rows: [
          { rowNum: 1, outletId: 'EMP001', outletName: 'A', employeeCode: 'EMP001', fieldId: 'f1', fieldName: 'Q2 bonus', amount: 100, narration: '', awardType: CreditAwardType.POINTS, status: UploadRowStatus.OK, errors: [] },
        ],
      };
      await service.createEmployeeBatch(admin, dto);
      expect(mockTx.$executeRaw).toHaveBeenCalled(); // per-(clientId, period) advisory lock
      const data = mockTx.creditBatch.create.mock.calls[0][0].data;
      expect(data.clientId).toBe('acme');
      expect(data.batchCode).toBe('CB-2026-05-001');
      expect(data.sourceKind).toBe('EMPLOYEE_UPLOAD');
      expect(data.totalPayoutPaise).toBe(0n); // points-only — never a payout
      expect(data.totalOutlets).toBe(2); // employee count on the generic counter
      expect(data.totalPoints).toBe(150);
    });

    it('is idempotent: returns the existing batch when the identical sourceKey run already exists', async () => {
      mockTx.creditBatch.findFirst.mockResolvedValueOnce({ id: 'existing', sourceKey: 'run_k1', status: 'PENDING_CONFIRM' });
      const dto: CreateEmployeeBatchDto = {
        period: '2026-05', totalEmployees: 1, totalPoints: 50, rows: [], sourceKey: 'run_k1',
      };
      const res = await service.createEmployeeBatch(admin, dto);
      expect(res.id).toBe('existing');
      expect(mockTx.creditBatch.create).not.toHaveBeenCalled(); // no second batch → no double-credit
    });

    it('rejects a POINTS row that exceeds the safety cap', async () => {
      mockCreditsPayouts.safetyCapPoints = 100;
      const dto: CreateEmployeeBatchDto = {
        period: '2026-05',
        totalEmployees: 1,
        totalPoints: 500,
        rows: [
          { rowNum: 1, outletId: 'EMP001', outletName: 'A', employeeCode: 'EMP001', fieldId: 'f1', fieldName: 'F', amount: 500, narration: '', awardType: CreditAwardType.POINTS, status: UploadRowStatus.OK, errors: [] },
        ],
      };
      await expect(service.createEmployeeBatch(admin, dto)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── confirmEmployeeBatch ────────────────────────────────────────────────────
  describe('confirmEmployeeBatch', () => {
    beforeEach(() => mockPrisma.client.findUnique.mockResolvedValue(EMPLOYEE_CLIENT));

    const batchWith = (rows: unknown[]) => ({
      id: 'b1',
      clientId: 'acme',
      status: 'PENDING_CONFIRM',
      sourceKind: 'EMPLOYEE_UPLOAD',
      period: '2026-05',
      uploadedBy: 'admin1',
      totalOutlets: 1,
      totalPoints: 100,
      totalPayoutPaise: 0n,
      rows,
    });

    it('credits each resolved employee: employeeCode → account → wallet → creditEarnForAccount', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue(batchWith([
        { outletId: 'EMP001', outletName: 'A', employeeCode: 'EMP001', fieldId: 'f1', fieldName: 'Q2', amount: 50, narration: 'bonus', awardType: 'POINTS', status: 'OK' },
      ]));
      mockTx.salesUser.findFirst.mockResolvedValue({ id: 'su1', isActive: true });

      const res = await service.confirmEmployeeBatch(admin, 'b1');

      expect(res.pointsCredited).toBe(1);
      expect(res.pointsCreditedTotal).toBe(50);
      expect(res.skipped).toEqual([]);
      // Resolved tenant-scoped + non-deleted.
      expect(mockTx.salesUser.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'acme', employeeCode: 'EMP001', deletedAt: null },
        select: { id: true, isActive: true },
      });
      expect(ensureEmployeeAccount).toHaveBeenCalledWith(mockTx, 'su1');
      expect(ensureEmployeeWallet).toHaveBeenCalledWith(mockTx, 'acc-emp');
      expect(mockWalletService.creditEarnForAccount).toHaveBeenCalledWith(
        'acc-emp',
        'acme',
        50,
        {
          referenceType: 'CREDIT_BATCH',
          referenceId: 'b1',
          sourceType: 'EMPLOYEE_UPLOAD',
          sourceId: 'EMP001',
          description: 'bonus',
        },
        mockTx,
      );
      // The trade credit primitive is NEVER used by the employee path.
      expect(mockWalletService.creditEarn).not.toHaveBeenCalled();
    });

    it('falls back to outletId when a row carries no explicit employeeCode', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue(batchWith([
        { outletId: 'EMP999', outletName: 'A', fieldId: 'f1', fieldName: 'Q2', amount: 20, narration: '', awardType: 'POINTS', status: 'OK' },
      ]));
      mockTx.salesUser.findFirst.mockResolvedValue({ id: 'su9', isActive: true });
      await service.confirmEmployeeBatch(admin, 'b1');
      expect(mockTx.salesUser.findFirst).toHaveBeenCalledWith({
        where: { clientId: 'acme', employeeCode: 'EMP999', deletedAt: null },
        select: { id: true, isActive: true },
      });
    });

    it('SKIPS an unresolved employeeCode with a reason and credits nothing for it', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue(batchWith([
        { outletId: 'GHOST', outletName: 'X', employeeCode: 'GHOST', fieldId: 'f1', fieldName: 'Q2', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
      ]));
      mockTx.salesUser.findFirst.mockResolvedValue(null); // not found

      const res = await service.confirmEmployeeBatch(admin, 'b1');

      expect(res.pointsCredited).toBe(0);
      expect(res.skipped).toEqual([
        { employeeCode: 'GHOST', fieldName: 'Q2', points: 50, reason: 'EMPLOYEE_NOT_FOUND' },
      ]);
      expect(ensureEmployeeAccount).not.toHaveBeenCalled();
      expect(mockWalletService.creditEarnForAccount).not.toHaveBeenCalled();
    });

    it('💰 FE audit #1: SKIPS an INACTIVE (deactivated, not deleted) employee with EMPLOYEE_INACTIVE — never credits', async () => {
      // Determinism: an inactive employee must never be credited regardless of the FE roster pre-flight.
      mockPrisma.creditBatch.findFirst.mockResolvedValue(batchWith([
        { outletId: 'EMP001', outletName: 'A', employeeCode: 'EMP001', fieldId: 'f1', fieldName: 'Q2', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
      ]));
      mockTx.salesUser.findFirst.mockResolvedValue({ id: 'su1', isActive: false }); // exists but deactivated

      const res = await service.confirmEmployeeBatch(admin, 'b1');

      expect(res.pointsCredited).toBe(0);
      expect(res.skipped).toEqual([
        { employeeCode: 'EMP001', fieldName: 'Q2', points: 50, reason: 'EMPLOYEE_INACTIVE' },
      ]);
      expect(ensureEmployeeAccount).not.toHaveBeenCalled();
      expect(mockWalletService.creditEarnForAccount).not.toHaveBeenCalled();
    });

    it('throws on a double-confirm (guarded claim count===0) and credits nothing', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue(batchWith([
        { outletId: 'EMP001', outletName: 'A', employeeCode: 'EMP001', fieldId: 'f1', fieldName: 'Q2', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
      ]));
      mockTx.salesUser.findFirst.mockResolvedValue({ id: 'su1', isActive: true });
      mockTx.creditBatch.updateMany.mockResolvedValue({ count: 0 }); // already flipped by a racer

      await expect(service.confirmEmployeeBatch(admin, 'b1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWalletService.creditEarnForAccount).not.toHaveBeenCalled();
    });

    it('rejects a non-PENDING_CONFIRM batch', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ ...batchWith([]), status: 'CONFIRMED' });
      await expect(service.confirmEmployeeBatch(admin, 'b1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('🔒 Deoleo-safety: REFUSES to confirm a TRADE batch through the employee path (sourceKind guard)', async () => {
      // A trade batch (sourceKind null) must go through the untouched trade confirmBatch so its
      // payout/TDS/invoice side-effects fire — never through the points-only employee path.
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ ...batchWith([]), sourceKind: null });
      await expect(service.confirmEmployeeBatch(admin, 'b1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWalletService.creditEarnForAccount).not.toHaveBeenCalled();
    });

    it('💰 F2: REFUSES when another CONFIRMED employee batch already credited this period (no double-credit) and credits nothing', async () => {
      // Always-on period-uniqueness for the employee rail: even a MANUAL (no-sourceKey) second batch
      // must not credit a period that another employee batch already confirmed — the employee credit
      // is account-owned and irreversible, so a second confirm would be an un-clawbackable double-credit.
      mockPrisma.creditBatch.findFirst.mockResolvedValue(batchWith([
        { outletId: 'EMP001', outletName: 'A', employeeCode: 'EMP001', fieldId: 'f1', fieldName: 'Q2', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
      ]));
      mockTx.salesUser.findFirst.mockResolvedValue({ id: 'su1', isActive: true });
      // The period-uniqueness probe (`where.id.not`) finds ANOTHER confirmed EMPLOYEE_UPLOAD batch.
      mockTx.creditBatch.findFirst.mockImplementation((args: { where?: { id?: { not?: unknown } | unknown } }) => {
        const idClause = args?.where?.id as { not?: unknown } | string | undefined;
        if (idClause && typeof idClause === 'object' && 'not' in idClause) {
          return Promise.resolve({ batchCode: 'CB-2026-05-001', status: 'CONFIRMED' });
        }
        return Promise.resolve({ id: 'b1', status: 'CONFIRMED', sourceKind: 'EMPLOYEE_UPLOAD' });
      });

      await expect(service.confirmEmployeeBatch(admin, 'b1')).rejects.toThrow(/already credited/i);
      // Throwing inside the tx rolls back the status claim → NOTHING credited.
      expect(mockWalletService.creditEarnForAccount).not.toHaveBeenCalled();
    });

    it('💰 F5: surfaces a non-POINTS (PAYOUT) row as skipped UNSUPPORTED_AWARD_TYPE (never a silent drop)', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue(batchWith([
        { outletId: 'EMP001', outletName: 'A', employeeCode: 'EMP001', fieldId: 'f1', fieldName: 'Q2', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
        { outletId: 'EMP002', outletName: 'B', employeeCode: 'EMP002', fieldId: 'f2', fieldName: 'Cash', amount: 999, narration: '', awardType: 'PAYOUT', status: 'OK' },
      ]));
      mockTx.salesUser.findFirst.mockResolvedValue({ id: 'su1', isActive: true });

      const res = await service.confirmEmployeeBatch(admin, 'b1');

      expect(res.pointsCredited).toBe(1); // only the POINTS row is credited
      expect(res.skipped).toContainEqual({ employeeCode: 'EMP002', fieldName: 'Cash', points: 999, reason: 'UNSUPPORTED_AWARD_TYPE' });
      // The PAYOUT row never reaches the credit primitive.
      expect(mockWalletService.creditEarnForAccount).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Phase C: DISPLAY-only EmployeeTarget upsert (ADDITIVE; NO money) ─────────
  describe('🎯 Phase C — EmployeeTarget upsert (display-only; never touches the credit math)', () => {
    beforeEach(() => mockPrisma.client.findUnique.mockResolvedValue(EMPLOYEE_CLIENT));

    const batchWith = (rows: unknown[]) => ({
      id: 'b1', clientId: 'acme', status: 'PENDING_CONFIRM', sourceKind: 'EMPLOYEE_UPLOAD',
      period: '2026-05', uploadedBy: 'admin1', totalOutlets: 1, totalPoints: 100, totalPayoutPaise: 0n, rows,
    });

    it('a points+target row CREDITS the points AND upserts the target (credit unchanged)', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue(batchWith([
        { outletId: 'EMP001', outletName: 'A', employeeCode: 'EMP001', fieldId: 'f1', fieldName: 'Q2', amount: 50, narration: 'bonus', awardType: 'POINTS', status: 'OK', targetPoints: 400 },
      ]));
      mockTx.salesUser.findFirst.mockResolvedValue({ id: 'su1', isActive: true });

      const res = await service.confirmEmployeeBatch(admin, 'b1');

      // Credit behavior is byte-identical to the no-target case: still exactly one credit of 50.
      expect(res.pointsCredited).toBe(1);
      expect(res.pointsCreditedTotal).toBe(50);
      expect(mockWalletService.creditEarnForAccount).toHaveBeenCalledTimes(1);
      expect(mockWalletService.creditEarnForAccount).toHaveBeenCalledWith(
        'acc-emp', 'acme', 50,
        { referenceType: 'CREDIT_BATCH', referenceId: 'b1', sourceType: 'EMPLOYEE_UPLOAD', sourceId: 'EMP001', description: 'bonus' },
        mockTx,
      );
      // AND the target is upserted on the (clientId, employeeCode, period) key.
      expect(mockTx.employeeTarget.upsert).toHaveBeenCalledTimes(1);
      expect(mockTx.employeeTarget.upsert).toHaveBeenCalledWith({
        where: { clientId_employeeCode_period: { clientId: 'acme', employeeCode: 'EMP001', period: '2026-05' } },
        create: { clientId: 'acme', employeeCode: 'EMP001', period: '2026-05', targetPoints: 400 },
        update: { targetPoints: 400 },
      });
    });

    it('a TARGET-ONLY row (0/blank points) upserts the target and CREDITS NOTHING', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue(batchWith([
        { outletId: 'EMP002', outletName: 'B', employeeCode: 'EMP002', fieldId: 'f1', fieldName: 'Q2', amount: 0, narration: '', awardType: 'POINTS', status: 'OK', targetPoints: 250 },
      ]));
      mockTx.salesUser.findFirst.mockResolvedValue({ id: 'su2', isActive: true });

      const res = await service.confirmEmployeeBatch(admin, 'b1');

      // Zero-amount row is skipped by the credit loop (amount > 0 filter) → nothing credited.
      expect(res.pointsCredited).toBe(0);
      expect(res.pointsCreditedTotal).toBe(0);
      expect(mockWalletService.creditEarnForAccount).not.toHaveBeenCalled();
      // But the target IS stored.
      expect(mockTx.employeeTarget.upsert).toHaveBeenCalledTimes(1);
      expect(mockTx.employeeTarget.upsert).toHaveBeenCalledWith({
        where: { clientId_employeeCode_period: { clientId: 'acme', employeeCode: 'EMP002', period: '2026-05' } },
        create: { clientId: 'acme', employeeCode: 'EMP002', period: '2026-05', targetPoints: 250 },
        update: { targetPoints: 250 },
      });
    });

    it('a row WITHOUT targetPoints upserts NO target (credit path untouched)', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue(batchWith([
        { outletId: 'EMP003', outletName: 'C', employeeCode: 'EMP003', fieldId: 'f1', fieldName: 'Q2', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
      ]));
      mockTx.salesUser.findFirst.mockResolvedValue({ id: 'su3', isActive: true });

      const res = await service.confirmEmployeeBatch(admin, 'b1');

      expect(res.pointsCredited).toBe(1);
      expect(res.pointsCreditedTotal).toBe(50);
      expect(mockTx.employeeTarget.upsert).not.toHaveBeenCalled();
    });

    it('does NOT upsert a target for a row whose employee does not resolve (ghost code)', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue(batchWith([
        { outletId: 'GHOST', outletName: 'X', employeeCode: 'GHOST', fieldId: 'f1', fieldName: 'Q2', amount: 0, narration: '', awardType: 'POINTS', status: 'OK', targetPoints: 300 },
      ]));
      mockTx.salesUser.findFirst.mockResolvedValue(null); // does not resolve

      await service.confirmEmployeeBatch(admin, 'b1');

      expect(mockTx.employeeTarget.upsert).not.toHaveBeenCalled();
    });
  });

  // ─── F1: trade confirmBatch is locked AGAINST an employee batch ───────────────
  describe('💰 F1 confirmBatch (trade path) rejects an EMPLOYEE_UPLOAD batch', () => {
    it('REFUSES to confirm an EMPLOYEE_UPLOAD batch through the trade endpoint (symmetric sourceKind guard)', async () => {
      // Without this guard an employee batch confirmed here would strand (every row skips
      // OUTLET_NOT_FOUND) yet flip CONFIRMED, blocking the correct employee re-run.
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'bE', clientId: 'acme', status: 'PENDING_CONFIRM', sourceKind: 'EMPLOYEE_UPLOAD', period: '2026-05', rows: [],
      });
      await expect(service.confirmBatch(admin, 'bE')).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWalletService.creditEarn).not.toHaveBeenCalled();
      expect(mockWalletService.creditEarnForAccount).not.toHaveBeenCalled();
    });
  });

  // ─── F3: employee-batch reversal is refused (no silent zero-clawback) ─────────
  describe('💰 F3 createReversal rejects an EMPLOYEE_UPLOAD batch', () => {
    it('REFUSES reversal of an employee batch rather than silently clawing back zero', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'bE', clientId: 'acme', status: 'CONFIRMED', sourceKind: 'EMPLOYEE_UPLOAD', period: '2026-05',
      });
      await expect(
        service.createReversal(admin, 'bE', {
          outletId: 'EMP001', outletName: 'A', fieldId: 'f1', fieldName: 'Q2',
          awardType: CreditAwardType.POINTS, originalPaise: 50, requestedPaise: 50,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
