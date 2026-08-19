// Unit tests for CreditsService — ported from platform/src/app/api/admin/credits/*.
// Covers tenant scoping, batch confirm → payout-entry creation, the maker-checker
// reversal flow, payout-file generation, and the UTR upload parse/apply branches.
// Run: npx jest src/credits/credits.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as XLSX from 'xlsx';
import { CreditsService } from './credits.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { InvoicesService } from '../invoices/invoices.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  CreateBatchDto,
  CreateReversalDto,
  FieldAction,
  ListBatchesQueryDto,
  ListReversalsQueryDto,
  PayoutGroupType,
  ReversalAction,
} from './dto/credits.dto';
import { CreditAwardType } from '@prisma/client';
import { PAYOUT_FILE_HEADERS } from './credits.helpers';

// ─── Mock wallet service ──────────────────────────────────────────────────────

// Employee Rewards Phase 1 — the account dual-write helper has its own unit tests
// (reward-account.helper.spec.ts); stub it here so these tests aren't coupled to its
// internal channelPartner/rewardAccount tx calls. The service still writes accountId.
jest.mock('../common/reward-account.helper', () => ({
  ensureOutletAccount: jest.fn().mockResolvedValue('acc-x'),
}));

const mockWalletService = {
  creditEarn: jest.fn().mockResolvedValue({ transactionId: 'wt1', newRedeemable: 50, ledgerId: 'l1' }),
  clawbackAward: jest.fn().mockResolvedValue({ transactionId: 'wt2', newRedeemable: 0, ledgerId: 'l2', shortfall: 0 }),
};

// ─── Mock Prisma TX ───────────────────────────────────────────────────────────

const mockTx = {
  creditBatch: {
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn(),
    // createBatch now generates the code + creates UNDER a per-(clientId, period) advisory lock in a tx.
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(),
  },
  creditPayoutEntry: { createMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  // downloadCode is now generated INSIDE the download tx (tx.creditPayoutDownload.count) under PDLOCK.
  creditPayoutDownload: { create: jest.fn(), update: jest.fn(), count: jest.fn().mockResolvedValue(0) },
  creditReversal: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
  // FIX-8: the visibility TDS plan now reads INSIDE the download $transaction (tx), so the
  // cross-tenant PAN aggregation runs behind the per-PAN advisory lock (tx.$executeRaw).
  outlet: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  channelPartner: { findMany: jest.fn().mockResolvedValue([]) },
  wallet: { findFirst: jest.fn(), upsert: jest.fn().mockResolvedValue({ id: 'w1' }) },
  // Visibility-payout TDS read + write targets (atomic with the download / confirm).
  tdsDeductionEntry: { createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  tdsRecoveryEntry: { createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  autoInvoice: { updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  // FIX-8 advisory lock — pg_advisory_xact_lock(hashtextextended(...)).
  $executeRaw: jest.fn().mockResolvedValue(0),
};

const mockPrisma = {
  creditBatch: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
  creditField: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  creditPayoutEntry: { findMany: jest.fn() },
  creditPayoutDownload: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  creditReversal: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  // Post-commit PUSH loop resolves each credited partner's userId to enqueue a WALLET_POINTS_EARNED push.
  // (Also resolves ownerName+phone for the deoleo_points_credit WhatsApp.) findMany = TDS PAN resolution.
  channelPartner: { findFirst: jest.fn(), findMany: jest.fn() },
  // Post-commit points-credit WhatsApp reads the partner's redeemable balance AFTER the credit.
  wallet: { findFirst: jest.fn() },
  outlet: { findMany: jest.fn() },
  outletTypeClientConfig: { findMany: jest.fn() },
  // Visibility-payout TDS reads (cross-tenant PAN aggregation + carry-forward + one-per-PAN/FY).
  tdsDeductionEntry: { findMany: jest.fn() },
  autoInvoice: { findMany: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown, _opts?: { timeout?: number; maxWait?: number }) => cb(mockTx)),
};

const mockNotifications = { enqueue: jest.fn().mockResolvedValue({ id: 'n1' }) };

// Direct MSG91 WhatsApp sends (deoleo_points_credit / deoleo_payout_credit).
const mockMsg91 = {
  sendWhatsappTemplate: jest.fn().mockResolvedValue(undefined),
};

// ─── Mock TenantSettingsService (Stream MONEY-CREDITS) ──────────────────────────
// The credit/payout caps + month-cutoff are read from here. `mockCreditsPayouts` is
// mutable so individual tests can override; the default is intentionally LENIENT
// (cutoff 31 → window always open for any prior month; high caps) so the legacy
// createBatch/confirmBatch tests pass regardless of today's wall-clock date.
let mockCreditsPayouts: {
  monthCutoffDay: number;
  safetyCapPoints: number;
  safetyCapInr: number;
  fourEyesEnabled: boolean;
  notifyEmails: string[];
};
const mockTenantSettings = {
  getEffectiveSettings: jest.fn(async () => ({ creditsPayouts: mockCreditsPayouts })),
  // Per-tenant TDS policy resolved once at confirm + frozen onto each entry (W0-B).
  resolveTdsPolicy: jest.fn(async () => ({ section: 'SEC_194C', methodology: 'GROSS_UP' })),
};

// Stream B: SERVICE invoice-at-confirm + gross-up TDS invoice-at-download are delegated here.
const mockInvoicesService = {
  generateForBatch: jest.fn(async () => ({ generated: 0, linked: 0, skipped: [] })),
  createTdsInvoice: jest.fn(async () => ({ invoiceId: 'tds1', gstPaise: 0n, gstApplicable: false })),
};

const admin: JwtPayload = {
  sub: 'admin1',
  role: 'CLIENT_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
};
const gifsy: JwtPayload = {
  sub: 'g1',
  role: 'GIFSY_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

describe('CreditsService', () => {
  let service: CreditsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Lenient default settings (window always open, high caps) so legacy tests are
    // unaffected by the new server-side enforcement; settings-specific tests override.
    mockCreditsPayouts = {
      monthCutoffDay: 31,
      safetyCapPoints: 1_000_000,
      safetyCapInr: 10_000_000,
      fourEyesEnabled: false,
      notifyEmails: [],
    };
    // Restore default resolved values that tests may override.
    mockTx.creditBatch.updateMany.mockResolvedValue({ count: 1 });
    mockTx.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED' });
    mockTx.creditReversal.updateMany.mockResolvedValue({ count: 1 });
    mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'APPROVED' });
    mockTx.creditReversal.update.mockResolvedValue({});
    mockTx.outlet.findFirst.mockResolvedValue(null);
    mockTx.wallet.findFirst.mockResolvedValue(null);
    // Default: no matching payout entries for PAYOUT-reversal path (tests override per case).
    mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);
    // FIX-7: the guarded PROCESSING claim reads claimed.count — echo the where.id.in length so the
    // happy path claims exactly what it selected (a race test overrides this to a smaller count).
    // FIX-C: uploadUtr flips a SINGLE entry per call (where.id is a string) — return count 1 so the
    // guarded flip is treated as transitioned (a concurrent-race test overrides this to 0).
    mockTx.creditPayoutEntry.updateMany.mockImplementation(
      async (arg: { where?: { id?: { in?: string[] } | string } }) => {
        const id = arg?.where?.id;
        if (id && typeof id === 'object' && Array.isArray(id.in)) return { count: id.in.length };
        if (typeof id === 'string') return { count: 1 };
        return { count: 0 };
      },
    );
    // FIX-8: tx-scoped plan reads default to empty (TDS-engine tests override per case).
    mockTx.outlet.findMany.mockResolvedValue([]);
    mockTx.channelPartner.findMany.mockResolvedValue([]);
    mockTx.tdsDeductionEntry.findMany.mockResolvedValue([]);
    mockTx.tdsRecoveryEntry.findMany.mockResolvedValue([]);
    mockTx.autoInvoice.findMany.mockResolvedValue([]);
    mockTx.$executeRaw.mockResolvedValue(0);

    // Default: partner resolves for the post-commit PUSH + WhatsApp; wallet balance read.
    mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'partnerUser1', ownerName: 'Ravi Traders', phone: '9900000041' });
    mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 500 });
    mockMsg91.sendWhatsappTemplate.mockResolvedValue(undefined);

    // Visibility-payout TDS defaults: no visibility fields / no PAN history / no prior TDS —
    // so the legacy confirm + payout-download tests run the engine as a no-op.
    mockPrisma.creditField.findMany.mockResolvedValue([]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);
    mockPrisma.tdsDeductionEntry.findMany.mockResolvedValue([]);
    mockPrisma.autoInvoice.findMany.mockResolvedValue([]);
    mockTenantSettings.resolveTdsPolicy.mockResolvedValue({ section: 'SEC_194C', methodology: 'GROSS_UP' });
    mockInvoicesService.generateForBatch.mockResolvedValue({ generated: 0, linked: 0, skipped: [] });
    mockInvoicesService.createTdsInvoice.mockResolvedValue({ invoiceId: 'tds1', gstPaise: 0n, gstApplicable: false });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: Msg91Service, useValue: mockMsg91 },
        { provide: WalletService, useValue: mockWalletService },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
        { provide: InvoicesService, useValue: mockInvoicesService },
      ],
    }).compile();
    service = module.get(CreditsService);
  });

  describe('listBatches', () => {
    it('scopes the query to the caller tenant, newest first, with default pagination', async () => {
      mockPrisma.creditBatch.findMany.mockResolvedValue([]);
      mockPrisma.creditBatch.count.mockResolvedValue(0);
      await service.listBatches(admin, {});
      const arg = mockPrisma.creditBatch.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ clientId: 'deoleo' });
      expect(arg.orderBy).toEqual({ uploadedAt: 'desc' });
      // Default page=1 / limit=50 → skip 0, take 50.
      expect(arg.skip).toBe(0);
      expect(arg.take).toBe(50);
    });

    it('applies the period filter SERVER-SIDE in the where (still tenant-scoped)', async () => {
      mockPrisma.creditBatch.findMany.mockResolvedValue([]);
      mockPrisma.creditBatch.count.mockResolvedValue(0);
      await service.listBatches(admin, { period: '2026-05' });
      const arg = mockPrisma.creditBatch.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ clientId: 'deoleo', period: '2026-05' });
      // The count uses the SAME where (so pages reflect the filtered set).
      expect(mockPrisma.creditBatch.count.mock.calls[0][0].where).toEqual({
        clientId: 'deoleo',
        period: '2026-05',
      });
    });

    it('computes skip/take from page & limit and returns the pagination envelope', async () => {
      mockPrisma.creditBatch.findMany.mockResolvedValue([{ id: 'b1' }]);
      mockPrisma.creditBatch.count.mockResolvedValue(7);
      const res = await service.listBatches(admin, { page: 3, limit: 2 });
      const arg = mockPrisma.creditBatch.findMany.mock.calls[0][0];
      // page 3, limit 2 → skip (3-1)*2 = 4, take 2.
      expect(arg.skip).toBe(4);
      expect(arg.take).toBe(2);
      expect(res).toEqual({
        batches: [{ id: 'b1' }],
        pagination: { page: 3, limit: 2, total: 7, pages: 4 }, // ceil(7/2)=4
      });
    });

    // The @Max(100) cap on `limit` is enforced by class-validator on the query DTO
    // (a ?limit=99999999 is rejected at the ValidationPipe before the service runs,
    // so the service can never fetch a whole tenant). Assert the DTO constraints so
    // the cap + defaults are locked in.
    it('ListBatchesQueryDto rejects limit > 100 and defaults page=1/limit=50', async () => {
      const dflt = plainToInstance(ListBatchesQueryDto, {});
      expect(dflt.page).toBe(1);
      expect(dflt.limit).toBe(50);
      expect(await validate(dflt)).toHaveLength(0);

      const over = plainToInstance(ListBatchesQueryDto, { limit: 99999999 });
      const errors = await validate(over);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('limit');
      expect(errors[0].constraints).toHaveProperty('max');

      // A valid limit at the cap passes.
      expect(await validate(plainToInstance(ListBatchesQueryDto, { limit: 100 }))).toHaveLength(0);
    });
  });

  describe('createBatch', () => {
    it('generates a CB code from the per-client count and persists rows', async () => {
      // Code gen + create now run inside a per-(clientId, period) advisory-locked tx.
      mockTx.creditBatch.count.mockResolvedValue(2);
      mockTx.creditBatch.create.mockResolvedValue({ id: 'b1' });
      const dto: CreateBatchDto = {
        period: '2026-05',
        totalOutlets: 1,
        totalPoints: 0,
        totalPayoutPaise: 10000,  // ₹100 in paise
        rows: [],
      };
      await service.createBatch(admin, dto);
      expect(mockTx.$executeRaw).toHaveBeenCalled(); // per-(clientId, period) advisory lock acquired
      const data = mockTx.creditBatch.create.mock.calls[0][0].data;
      expect(data.clientId).toBe('deoleo');
      expect(data.batchCode).toBe('CB-2026-05-003');
      expect(data.uploadedBy).toBe('admin1');
      // totalPayoutPaise stored as BigInt
      expect(data.totalPayoutPaise).toBe(BigInt(10000));
    });
  });

  describe('getBatch', () => {
    it('throws NotFound when outside the tenant', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue(null);
      await expect(service.getBatch(admin, 'b1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('confirmBatch', () => {
    it('rejects a batch that is not PENDING_CONFIRM', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED' });
      await expect(service.confirmBatch(admin, 'b1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirms and creates payout entries only for PAYOUT+OK rows (legacy path)', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'PENDING_CONFIRM',
        period: '2026-05',
        uploadedBy: 'admin1',
        totalOutlets: 2,
        totalPoints: 0,
        // totalPayoutPaise stored as BigInt in Prisma
        totalPayoutPaise: BigInt(30000),  // ₹300 in paise
        rows: [
          // amounts are paise: 10000 = ₹100, 20000 = ₹200
          { outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F', amount: 10000, narration: '', awardType: 'PAYOUT', status: 'OK' },
          { outletId: 'O2', outletName: 'B', fieldId: 'f1', fieldName: 'F', amount: 20000, narration: '', awardType: 'PAYOUT', status: 'ERROR' },
        ],
      });
      // tx.outlet.findFirst returns null → no POINTS rows anyway; wallet not queried.
      const res = await service.confirmBatch(admin, 'b1');
      expect(res.payoutEntriesCreated).toBe(1);
      const createManyArg = mockTx.creditPayoutEntry.createMany.mock.calls[0][0].data;
      expect(createManyArg).toHaveLength(1);
      expect(createManyArg[0].outletId).toBe('O1');
      expect(createManyArg[0].clientId).toBe('deoleo');
      // amountPaise written as BigInt
      expect(createManyArg[0].amountPaise).toBe(BigInt(10000));
      expect(mockNotifications.enqueue).toHaveBeenCalled();
    });

    it('calls creditEarn for each POINTS+OK row when outlet+wallet exist', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'PENDING_CONFIRM',
        period: '2026-05',
        uploadedBy: 'admin1',
        totalOutlets: 2,
        totalPoints: 100,
        totalPayoutPaise: BigInt(0),
        rows: [
          // 50 points for O1 (POINTS/OK)
          { outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'Sales', amount: 50, narration: 'May bonus', awardType: 'POINTS', status: 'OK' },
          // ERROR row — must be skipped
          { outletId: 'O2', outletName: 'B', fieldId: 'f1', fieldName: 'Sales', amount: 30, narration: '', awardType: 'POINTS', status: 'ERROR' },
        ],
      });
      // O1 resolves to partner p1.
      mockTx.outlet.findFirst.mockResolvedValue({ partnerId: 'p1' });
      // Post-commit push loop resolves p1 → its userId so the WALLET_POINTS_EARNED push fires.
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'partnerUser1' });

      const res = await service.confirmBatch(admin, 'b1');

      expect(res.pointsCredited).toBe(1);
      expect(res.pointsCreditedTotal).toBe(50);
      expect(res.skipped).toEqual([]);
      // Wallet is get-or-created (race-safe upsert) before crediting.
      expect(mockTx.wallet.upsert).toHaveBeenCalledWith({
        where: { partnerId: 'p1' },
        create: { partnerId: 'p1', accountId: 'acc-x' },
        update: {},
      });
      expect(mockWalletService.creditEarn).toHaveBeenCalledTimes(1);
      expect(mockWalletService.creditEarn).toHaveBeenCalledWith(
        'p1',
        'deoleo',
        50,
        {
          referenceType: 'CREDIT_BATCH',
          referenceId: 'b1',
          sourceType: 'CREDIT_FIELD',
          sourceId: 'f1',
          description: 'May bonus',
        },
        mockTx,   // same tx — atomicity guaranteed
      );
      // The WALLET_POINTS_EARNED PUSH deep-links to a real authenticated route
      // (a urless push falls back to '/' → /auth/login → the signed-in user is bounced out).
      expect(mockNotifications.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'PUSH',
          variables: expect.objectContaining({ event: 'WALLET_POINTS_EARNED', url: '/partner/wallet' }),
        }),
      );
    });

    it('skips a POINTS row whose outlet is not linked to a partner, with a reason', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'PENDING_CONFIRM',
        period: '2026-05',
        uploadedBy: 'admin1',
        totalOutlets: 1,
        totalPoints: 50,
        totalPayoutPaise: BigInt(0),
        rows: [
          { outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'Sales', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
        ],
      });
      // Outlet resolves but has no partnerId → cannot own a wallet.
      mockTx.outlet.findFirst.mockResolvedValue({ partnerId: null });

      const res = await service.confirmBatch(admin, 'b1');

      expect(res.pointsCredited).toBe(0);
      expect(res.skipped).toEqual([
        { outletId: 'O1', fieldName: 'Sales', points: 50, reason: 'OUTLET_NOT_LINKED_TO_PARTNER' },
      ]);
      expect(mockTx.wallet.upsert).not.toHaveBeenCalled();
      expect(mockWalletService.creditEarn).not.toHaveBeenCalled();
    });

    it('skips a POINTS row whose outlet is not found, with a reason', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'PENDING_CONFIRM',
        period: '2026-05',
        uploadedBy: 'admin1',
        totalOutlets: 1,
        totalPoints: 50,
        totalPayoutPaise: BigInt(0),
        rows: [
          { outletId: 'O_UNKNOWN', outletName: 'X', fieldId: 'f1', fieldName: 'Sales', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
        ],
      });
      // Outlet not found → null.
      mockTx.outlet.findFirst.mockResolvedValue(null);

      const res = await service.confirmBatch(admin, 'b1');

      expect(res.skipped).toEqual([
        { outletId: 'O_UNKNOWN', fieldName: 'Sales', points: 50, reason: 'OUTLET_NOT_FOUND' },
      ]);
      expect(mockWalletService.creditEarn).not.toHaveBeenCalled();
    });

    it('🔴 get-or-creates the wallet and CREDITS when the partner has none yet (pre-KYC accrual)', async () => {
      // Regression for the credit-upload bug: points to a not-yet-KYC-approved
      // partner were silently skipped because the wallet only existed post-approval.
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'PENDING_CONFIRM',
        period: '2026-05',
        uploadedBy: 'admin1',
        totalOutlets: 1,
        totalPoints: 50,
        totalPayoutPaise: BigInt(0),
        rows: [
          { outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'Sales', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
        ],
      });
      mockTx.outlet.findFirst.mockResolvedValue({ partnerId: 'p1' });
      // upsert default mock returns a wallet; nothing is "missing" any more.

      const res = await service.confirmBatch(admin, 'b1');

      expect(res.pointsCredited).toBe(1);
      expect(res.pointsCreditedTotal).toBe(50);
      expect(res.skipped).toEqual([]);
      expect(mockTx.wallet.upsert).toHaveBeenCalledWith({
        where: { partnerId: 'p1' },
        create: { partnerId: 'p1', accountId: 'acc-x' },
        update: {},
      });
      expect(mockWalletService.creditEarn).toHaveBeenCalledTimes(1);
    });

    it('throws BadRequestException on a double-confirm (guarded claim returns count=0)', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'PENDING_CONFIRM',
        period: '2026-05',
        uploadedBy: 'admin1',
        totalOutlets: 0,
        totalPoints: 0,
        totalPayoutPaise: BigInt(0),
        rows: [],
      });
      // Simulate a race: the guarded updateMany sees the row already flipped.
      mockTx.creditBatch.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.confirmBatch(admin, 'b1')).rejects.toBeInstanceOf(BadRequestException);
      // creditEarn must never have been called.
      expect(mockWalletService.creditEarn).not.toHaveBeenCalled();
    });

    it('uses guarded updateMany (not a plain update) for the status flip', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'PENDING_CONFIRM',
        period: '2026-05',
        uploadedBy: 'admin1',
        totalOutlets: 0,
        totalPoints: 0,
        totalPayoutPaise: BigInt(0),
        rows: [],
      });

      await service.confirmBatch(admin, 'b1');

      // The guarded claim must use updateMany with the PENDING_CONFIRM where clause.
      expect(mockTx.creditBatch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'b1', status: 'PENDING_CONFIRM' }),
        }),
      );
      // The old un-guarded tx.creditBatch.update must NOT be called.
      expect(mockTx.creditBatch.update).not.toHaveBeenCalled();
    });

    it('raises the interactive-tx timeout so a full-tenant batch survives (no 5s expiry)', async () => {
      // At Deoleo scale the awaited-write loop over uploaded rows exceeds the default
      // 5000ms interactive-transaction budget → "expired transaction" 500. The bulk
      // money mutation must pass a larger timeout while staying ONE atomic tx.
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'PENDING_CONFIRM',
        period: '2026-05',
        uploadedBy: 'admin1',
        totalOutlets: 0,
        totalPoints: 0,
        totalPayoutPaise: BigInt(0),
        rows: [],
      });

      await service.confirmBatch(admin, 'b1');

      // The bulk $transaction receives an options 2nd arg with the raised timeout.
      const opts = mockPrisma.$transaction.mock.calls[0][1];
      expect(opts).toMatchObject({ timeout: 180000, maxWait: 20000 });
    });

    it('sends the deoleo_points_credit WhatsApp POST-COMMIT with the right ordered bodyValues', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-07-06T10:00:00.000Z'));
      try {
        mockPrisma.creditBatch.findFirst.mockResolvedValue({
          id: 'b1',
          status: 'PENDING_CONFIRM',
          period: '2026-07',
          uploadedBy: 'admin1',
          totalOutlets: 1,
          totalPoints: 50,
          totalPayoutPaise: BigInt(0),
          rows: [
            { outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'Sales', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
          ],
        });
        mockTx.outlet.findFirst.mockResolvedValue({ partnerId: 'p1' });
        // Owner resolved for the WhatsApp; wallet redeemable balance AFTER the credit.
        mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'u1', ownerName: 'Ravi Traders', phone: '9900000041' });
        mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 500 });

        await service.confirmBatch(admin, 'b1');

        // DIRECT send with the deoleo_points_credit template + ordered bodyValues:
        //   [ownerName, points, redeemableBalance, "July 2026" (period), "06 Jul 2026" (today)].
        expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledWith(
          '9900000041',
          'deoleo_points_credit',
          ['Ravi Traders', '50', '500', 'July 2026', '06 Jul 2026'],
        );
        // Balance is read scoped to the credited partner.
        expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({ where: { partnerId: 'p1' } }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('a points-credit WhatsApp failure does NOT fail the confirmed batch (fire-and-forget)', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'PENDING_CONFIRM',
        period: '2026-07',
        uploadedBy: 'admin1',
        totalOutlets: 1,
        totalPoints: 50,
        totalPayoutPaise: BigInt(0),
        rows: [
          { outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'Sales', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
        ],
      });
      mockTx.outlet.findFirst.mockResolvedValue({ partnerId: 'p1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'u1', ownerName: 'Ravi', phone: '9900000041' });
      mockMsg91.sendWhatsappTemplate.mockRejectedValue(new Error('MSG91 down'));

      const res = await service.confirmBatch(admin, 'b1');
      expect(res.pointsCredited).toBe(1);
    });

    it('no-ops the points-credit WhatsApp when the partner has no phone', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'PENDING_CONFIRM',
        period: '2026-07',
        uploadedBy: 'admin1',
        totalOutlets: 1,
        totalPoints: 50,
        totalPayoutPaise: BigInt(0),
        rows: [
          { outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'Sales', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
        ],
      });
      mockTx.outlet.findFirst.mockResolvedValue({ partnerId: 'p1' });
      mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'u1', ownerName: 'Ravi', phone: null });

      await service.confirmBatch(admin, 'b1');
      expect(mockMsg91.sendWhatsappTemplate).not.toHaveBeenCalled();
    });
  });

  describe('createReversal (maker-checker request)', () => {
    it('rejects when requested amount exceeds original', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      const dto: CreateReversalDto = {
        outletId: 'O1',
        outletName: 'A',
        fieldId: 'f1',
        fieldName: 'F',
        awardType: CreditAwardType.PAYOUT,
        originalPaise: 10000,   // ₹100 in paise
        requestedPaise: 20000,  // ₹200 in paise — exceeds original → BadRequest
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects reversing an unconfirmed batch', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'PENDING_CONFIRM', period: '2026-05' });
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.PAYOUT, originalPaise: 10000, requestedPaise: 5000,
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('blocks a duplicate pending reversal for the same outlet+field', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockPrisma.creditReversal.findFirst.mockResolvedValue({ id: 'r-existing' });
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.PAYOUT, originalPaise: 10000, requestedPaise: 5000,
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates the reversal scoped to tenant + requester', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockPrisma.creditReversal.findFirst.mockResolvedValue(null);
      mockPrisma.creditReversal.create.mockResolvedValue({ id: 'r1' });
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.PAYOUT, originalPaise: 10000, requestedPaise: 5000,
      };
      await service.createReversal(admin, 'b1', dto);
      const data = mockPrisma.creditReversal.create.mock.calls[0][0].data;
      expect(data.clientId).toBe('deoleo');
      expect(data.requestedBy).toBe('admin1');
      expect(data.period).toBe('2026-05');
      // BigInt writes
      expect(data.originalPaise).toBe(BigInt(10000));
      expect(data.requestedPaise).toBe(BigInt(5000));
    });

    it('translates a DB P2002 (pending-reversal unique index) into a clean 400', async () => {
      // The fast-path pre-check passes (no existing pending), but a concurrent
      // request already inserted one — the partial-unique index
      // `credit_reversals_pending_unique` rejects with P2002.
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockPrisma.creditReversal.findFirst.mockResolvedValue(null);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
      mockPrisma.creditReversal.create.mockRejectedValue(p2002);
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.PAYOUT, originalPaise: 10000, requestedPaise: 5000,
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('patchReversal (checker approve/reject)', () => {
    it('rejects a reversal that is not PENDING_GIFSY', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'APPROVED', requestedPaise: BigInt(10000), awardType: 'POINTS', outletId: 'O1', fieldId: 'f1' });
      await expect(
        service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marks PARTIAL when approved amount is below requested', async () => {
      // requestedPaise stored as BigInt in Prisma
      mockPrisma.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'PENDING_GIFSY', requestedPaise: BigInt(10000), awardType: 'PAYOUT', outletId: 'O1', fieldId: 'f1' });
      // tx.creditReversal.findFirst returns the updated row
      mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'PARTIAL' });
      // PAYOUT reversal calls tx.creditPayoutEntry.findMany for the GLM-1 multi-entry path.
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'pe1', status: 'PENDING', amountPaise: BigInt(4000) },
      ]);

      const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 4000 });
      expect(res).toMatchObject({ id: 'r1', status: 'PARTIAL' });

      const updateManyCall = mockTx.creditReversal.updateMany.mock.calls[0][0];
      expect(updateManyCall.data.status).toBe('PARTIAL');
      // approvedPaise written as BigInt
      expect(updateManyCall.data.approvedPaise).toBe(BigInt(4000));
    });

    it('rejects when approved amount exceeds requested', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'PENDING_GIFSY', requestedPaise: BigInt(10000), awardType: 'PAYOUT', outletId: 'O1', fieldId: 'f1' });
      await expect(
        service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 20000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException on a double-execute (guarded claim returns count=0)', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'PENDING_GIFSY', requestedPaise: BigInt(5000), awardType: 'PAYOUT', outletId: 'O1', fieldId: 'f1' });
      mockTx.creditReversal.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 5000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockWalletService.clawbackAward).not.toHaveBeenCalled();
    });

    it('calls clawbackAward for POINTS reversal approval', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r1',
        status: 'PENDING_GIFSY',
        requestedPaise: BigInt(50),
        awardType: 'POINTS',
        outletId: 'O1',
        fieldId: 'f1',
      });
      mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'APPROVED' });
      // Outlet + wallet exist.
      mockTx.outlet.findFirst.mockResolvedValue({ partnerId: 'p1' });
      mockTx.wallet.findFirst.mockResolvedValue({ id: 'w1' });

      await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 50 });

      expect(mockWalletService.clawbackAward).toHaveBeenCalledTimes(1);
      expect(mockWalletService.clawbackAward).toHaveBeenCalledWith(
        'p1',
        50,
        expect.objectContaining({
          referenceType: 'CREDIT_REVERSAL',
          referenceId: 'r1',
          sourceType: 'CREDIT_FIELD',
          sourceId: 'f1',
        }),
        mockTx,   // same tx — atomic with status flip
      );
    });

    it('does NOT call clawbackAward for PAYOUT reversal approval', async () => {
      // PAYOUT reversals do NOT call walletService.clawbackAward — instead they
      // iterate CreditPayoutEntry rows and mark them REVERSED (or record a receivable).
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r1',
        status: 'PENDING_GIFSY',
        requestedPaise: BigInt(10000),
        awardType: 'PAYOUT',
        outletId: 'O1',
        fieldId: 'f1',
      });
      mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'APPROVED' });
      // PAYOUT reversal now calls tx.creditPayoutEntry.findMany (GLM-1 multi-entry path)
      // and then tx.creditPayoutEntry.update for each PENDING/PROCESSING/FAILED entry.
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'pe1', status: 'PENDING', amountPaise: BigInt(10000) },
      ]);

      await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 10000 });

      // The new PAYOUT-reversal path marks entries REVERSED via creditPayoutEntry.update —
      // it does NOT call walletService.clawbackAward (that is POINTS-only).
      expect(mockWalletService.clawbackAward).not.toHaveBeenCalled();
      // Verify the entry was marked REVERSED with downloadId=null.
      expect(mockTx.creditPayoutEntry.update).toHaveBeenCalledWith({
        where: { id: 'pe1' },
        data: { status: 'REVERSED', downloadId: null },
      });
    });

    it('does NOT call clawbackAward when action is reject (POINTS type)', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r1',
        status: 'PENDING_GIFSY',
        requestedPaise: BigInt(50),
        awardType: 'POINTS',
        outletId: 'O1',
        fieldId: 'f1',
      });
      mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'REJECTED' });

      await service.patchReversal(gifsy, 'r1', { action: ReversalAction.reject });

      expect(mockWalletService.clawbackAward).not.toHaveBeenCalled();
    });

    it('skips clawback silently when partner has no wallet on POINTS reversal', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r1',
        status: 'PENDING_GIFSY',
        requestedPaise: BigInt(50),
        awardType: 'POINTS',
        outletId: 'O1',
        fieldId: 'f1',
      });
      mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'APPROVED' });
      // Outlet found but no wallet.
      mockTx.outlet.findFirst.mockResolvedValue({ partnerId: 'p1' });
      mockTx.wallet.findFirst.mockResolvedValue(null);

      // Should not throw — reversal lands cleanly.
      await expect(
        service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 50 }),
      ).resolves.not.toThrow();
      expect(mockWalletService.clawbackAward).not.toHaveBeenCalled();
    });

    // ── GLM-1: multi-entry PAYOUT reversal (new behavior) ────────────────────

    it('GLM-1: PAYOUT reversal marks ALL matching PENDING/PROCESSING/FAILED entries REVERSED and sums PAID receivable', async () => {
      // Three entries for the same outlet+field:
      //   pe-pending  → status PENDING  → should be REVERSED
      //   pe-proc     → status PROCESSING → should be REVERSED
      //   pe-paid     → status PAID     → cash already left; contributes to receivable
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r1', status: 'PENDING_GIFSY', requestedPaise: BigInt(30000),
        awardType: 'PAYOUT', outletId: 'O1', fieldId: 'f1',
      });
      mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'APPROVED' });
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'pe-pending',  status: 'PENDING',    amountPaise: BigInt(10000) },
        { id: 'pe-proc',     status: 'PROCESSING', amountPaise: BigInt(10000) },
        { id: 'pe-paid',     status: 'PAID',       amountPaise: BigInt(10000) },
      ]);

      const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 30000 });

      // PENDING and PROCESSING entries must be marked REVERSED + downloadId=null.
      expect(mockTx.creditPayoutEntry.update).toHaveBeenCalledWith({
        where: { id: 'pe-pending' },
        data: { status: 'REVERSED', downloadId: null },
      });
      expect(mockTx.creditPayoutEntry.update).toHaveBeenCalledWith({
        where: { id: 'pe-proc' },
        data: { status: 'REVERSED', downloadId: null },
      });
      // PAID entry is NOT mutated; instead its amount is reported as receivable.
      const updateCalls = mockTx.creditPayoutEntry.update.mock.calls.map(
        (c: unknown[]) => (c[0] as { where: { id: string } }).where.id,
      );
      expect(updateCalls).not.toContain('pe-paid');

      // walletService.clawbackAward must NOT be called for PAYOUT reversals.
      expect(mockWalletService.clawbackAward).not.toHaveBeenCalled();

      // clawbackShortfall in the result equals the PAID entry amount (₹100 = 10000 paise).
      expect(res.clawbackShortfall).toBe(10000);
      // The shortfall is persisted on the reversal record.
      expect(mockTx.creditReversal.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: { shortfallPaise: BigInt(10000) },
      });
    });
  });

  describe('eligibleOutlets', () => {
    it('filters to active outlets of active partners in the tenant', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', name: 'A', phone: '900', outletType: { code: 'GT' } },
      ]);
      const res = await service.eligibleOutlets(admin);
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.partner).toEqual({ clientId: 'deoleo', isActive: true });
      expect(res[0]).toEqual({ id: 'O1', name: 'A', type: 'GT', phone: '900' });
    });
  });

  describe('createField', () => {
    it('rejects a duplicate field name for the tenant', async () => {
      mockPrisma.creditField.findFirst.mockResolvedValue({ id: 'f1' });
      await expect(
        service.createField(admin, { name: 'Vol', isSeparatePayout: false, outletTypeAwards: {} }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('assigns the next order value', async () => {
      mockPrisma.creditField.findFirst
        .mockResolvedValueOnce(null) // duplicate check
        .mockResolvedValueOnce({ order: 4 }); // max order
      mockPrisma.creditField.create.mockResolvedValue({ id: 'f2' });
      await service.createField(admin, { name: 'New', isSeparatePayout: true, outletTypeAwards: {} });
      expect(mockPrisma.creditField.create.mock.calls[0][0].data.order).toBe(5);
    });
  });

  describe('listOutletTypes', () => {
    it('returns the tenant ENABLED+active outlet types as {code,label}, sorted, displayName preferred', async () => {
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { displayName: null, outletType: { code: 'WHOLESALER', name: 'Wholesaler' } },
        { displayName: 'Super Stockist', outletType: { code: 'SSS', name: 'SSS' } },
      ]);
      const res = await service.listOutletTypes(admin);
      // sorted by code: SSS before WHOLESALER; displayName preferred when present
      expect(res).toEqual([
        { code: 'SSS', label: 'Super Stockist' },
        { code: 'WHOLESALER', label: 'Wholesaler' },
      ]);
      // tenant-scoped + enabled/active filter
      const where = mockPrisma.outletTypeClientConfig.findMany.mock.calls[0][0].where;
      expect(where.clientId).toBe(admin.clientId);
      expect(where.isEnabled).toBe(true);
      expect(where.outletType).toEqual({ isActive: true });
    });
  });

  describe('patchField', () => {
    it('maps the deactivate action to isActive=false', async () => {
      mockPrisma.creditField.findFirst.mockResolvedValue({ id: 'f1' });
      mockPrisma.creditField.update.mockResolvedValue({ id: 'f1' });
      await service.patchField(admin, 'f1', { action: FieldAction.deactivate });
      expect(mockPrisma.creditField.update.mock.calls[0][0].data.isActive).toBe(false);
    });

    it('persists a valid outletTypeAwards map', async () => {
      mockPrisma.creditField.findFirst.mockResolvedValue({ id: 'f1' });
      mockPrisma.creditField.update.mockResolvedValue({ id: 'f1' });
      const map = { WHOLESALER: 'POINTS', SSS: 'PAYOUT', SUB_STOCKIST: 'NA' };
      await service.patchField(admin, 'f1', { outletTypeAwards: map });
      expect(mockPrisma.creditField.update.mock.calls[0][0].data.outletTypeAwards).toEqual(map);
      // action not supplied → isActive must NOT be touched
      expect(mockPrisma.creditField.update.mock.calls[0][0].data.isActive).toBeUndefined();
    });

    it('rejects an invalid award value (cannot misroute money)', async () => {
      mockPrisma.creditField.findFirst.mockResolvedValue({ id: 'f1' });
      await expect(
        service.patchField(admin, 'f1', { outletTypeAwards: { WHOLESALER: 'CASH' } }),
      ).rejects.toThrow(/POINTS, PAYOUT, or NA/);
      expect(mockPrisma.creditField.update).not.toHaveBeenCalled();
    });

    it('rejects an empty body (no action and no award map)', async () => {
      mockPrisma.creditField.findFirst.mockResolvedValue({ id: 'f1' });
      await expect(service.patchField(admin, 'f1', {})).rejects.toThrow(/Nothing to update/);
      expect(mockPrisma.creditField.update).not.toHaveBeenCalled();
    });

    it('404s when the field does not belong to the tenant', async () => {
      mockPrisma.creditField.findFirst.mockResolvedValue(null);
      await expect(
        service.patchField(admin, 'nope', { outletTypeAwards: { WHOLESALER: 'POINTS' } }),
      ).rejects.toThrow('Field not found');
    });
  });

  describe('createPayoutDownload', () => {
    it('throws when no PENDING entries exist for the period', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
      await expect(
        service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.STANDARD }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('groups entries by outlet, marks them PROCESSING, and returns an xlsx buffer', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        // amountPaise as BigInt: 10000 = ₹100, 5000 = ₹50
        { id: 'e1', outletId: 'O1', outletName: 'A', amountPaise: BigInt(10000), batch: { batchCode: 'CB-1' } },
        { id: 'e2', outletId: 'O1', outletName: 'A', amountPaise: BigInt(5000),  batch: { batchCode: 'CB-1' } },
      ]);
      // GLB-1(a): partner must have isActive:true, deletedAt:null, and an APPROVED KYC submission
      // with the 4 required fields {id, status, createdAt, updatedAt} so the eligibility gate passes.
      mockPrisma.outlet.findMany.mockResolvedValue([
        {
          outletCode: 'O1', name: 'A', phone: '900', isActive: true,
          partner: {
            bankName: 'HDFC', bankAccountNumber: '123', ifscCode: 'IFSC', upiId: '',
            isActive: true, deletedAt: null,
            kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
          },
        },
      ]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-001' });

      const res = await service.createPayoutDownload(gifsy, {
        period: '2026-05',
        groupType: PayoutGroupType.STANDARD,
      });

      expect(res.downloadCode).toBe('PD-2026-05-001');
      expect(res.downloadId).toBe('d1');
      // Entries marked PROCESSING with the new download id.
      const updateArg = mockTx.creditPayoutEntry.updateMany.mock.calls[0][0];
      expect(updateArg.data).toEqual({ downloadId: 'd1', status: 'PROCESSING' });
      expect(updateArg.where.id.in).toEqual(['e1', 'e2']);

      // totalAmountPaise stored as BigInt: 10000 + 5000 = 15000 paise
      const createArg = mockTx.creditPayoutDownload.create.mock.calls[0][0].data;
      expect(createArg.totalAmountPaise).toBe(BigInt(15000));

      // The buffer is a real xlsx with the official headers and a single summed row.
      const wb = XLSX.read(res.buffer, { type: 'buffer' });
      const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets[wb.SheetNames[0]], {
        header: 1,
        defval: '',
      }) as (string | number)[][];
      expect(aoa[1]).toEqual(PAYOUT_FILE_HEADERS);
      // Outlet O1 → 10000 + 5000 = 15000 paise → ₹150 in the "Payout Amount" column (index 10).
      // The Excel file shows rupees for human readability.
      expect(aoa[2][1]).toBe('O1');
      expect(aoa[2][10]).toBe(150);
    });

    // ── Task 6.3 — #7 separate-UTR verification ────────────────────────────────

    it('STANDARD download excludes entries whose field has isSeparatePayout=true', async () => {
      // f-sep is a separate-payout field; e1 (f-std) should appear, e2 (f-sep) should not.
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-sep' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'e1', outletId: 'O1', outletName: 'A', amountPaise: BigInt(10000), fieldId: 'f-std', batch: { batchCode: 'CB-1' } },
      ]);
      // GLB-1(a): partner must be eligible (APPROVED KYC, active, non-deleted).
      mockPrisma.outlet.findMany.mockResolvedValue([
        {
          outletCode: 'O1', name: 'A', phone: '', isActive: true,
          partner: {
            bankName: '', bankAccountNumber: '', ifscCode: '', upiId: '',
            isActive: true, deletedAt: null,
            kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
          },
        },
      ]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd2', downloadCode: 'PD-2026-05-002' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.STANDARD });

      // The query passed to creditPayoutEntry.findMany must exclude f-sep.
      const where = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0].where;
      // NOT clause must reference the separate field id.
      expect(where.NOT).toBeDefined();
      expect(where.NOT.fieldId.in).toContain('f-sep');
    });

    it('SEPARATE download for a given fieldId includes ONLY that field', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-sep' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'e2', outletId: 'O2', outletName: 'B', amountPaise: BigInt(5000), fieldId: 'f-sep', batch: { batchCode: 'CB-1' } },
      ]);
      // GLB-1(a): partner must be eligible (APPROVED KYC, active, non-deleted).
      mockPrisma.outlet.findMany.mockResolvedValue([
        {
          outletCode: 'O2', name: 'B', phone: '', isActive: true,
          partner: {
            bankName: '', bankAccountNumber: '', ifscCode: '', upiId: '',
            isActive: true, deletedAt: null,
            kycSubmissions: [{ id: 'ks2', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
          },
        },
      ]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd3', downloadCode: 'PD-2026-05-003' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-sep', fieldName: 'Volume' });

      // The query must scope to exactly that fieldId.
      const where = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0].where;
      expect(where.fieldId).toBe('f-sep');
      // No NOT exclusion for SEPARATE downloads.
      expect(where.NOT).toBeUndefined();
    });

    // ── GLM-2: FAILED re-bankable / REVERSED excluded ─────────────────────────

    it('GLM-2: a FAILED entry IS re-selected (re-bankable) by createPayoutDownload', async () => {
      // A FAILED entry (bank-rejected, never paid) must appear in the query — the
      // status filter is `{ in: ['PENDING', 'FAILED'] }`, so FAILED is included.
      mockPrisma.creditField.findMany.mockResolvedValue([]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'e-fail', outletId: 'O1', outletName: 'A', amountPaise: BigInt(7000), batch: { batchCode: 'CB-1' } },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([
        {
          outletCode: 'O1', name: 'A', phone: '', isActive: true,
          partner: {
            bankName: '', bankAccountNumber: '', ifscCode: '', upiId: '',
            isActive: true, deletedAt: null,
            kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
          },
        },
      ]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd4', downloadCode: 'PD-2026-05-004' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.STANDARD });

      // The query must include FAILED entries via the `status: { in: [...] }` filter.
      const where = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0].where;
      expect(where.status).toEqual({ in: ['PENDING', 'FAILED'] });
      // The FAILED entry was included and therefore marked PROCESSING.
      const updateArg = mockTx.creditPayoutEntry.updateMany.mock.calls[0][0];
      expect(updateArg.where.id.in).toContain('e-fail');
    });

    it('GLM-2: a REVERSED entry is NOT re-selected (excluded by status filter)', async () => {
      // REVERSED entries must never re-enter the bank file. The status filter
      // `{ in: ['PENDING', 'FAILED'] }` does NOT include REVERSED. We verify via the
      // query shape — the service throws BadRequest if findMany returns nothing.
      mockPrisma.creditField.findMany.mockResolvedValue([]);
      // Simulate the DB returning 0 rows (as if the only entry is REVERSED, excluded).
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);

      await expect(
        service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.STANDARD }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Confirm REVERSED is not in the status filter.
      const where = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0].where;
      expect(where.status).toEqual({ in: ['PENDING', 'FAILED'] });
      const statuses = where.status.in as string[];
      expect(statuses).not.toContain('REVERSED');
    });

    // ── GLB-1(a): non-APPROVED KYC partner goes to heldEntries ───────────────

    it('GLB-1(a): a non-APPROVED-KYC partner entry goes to heldEntries and is NOT marked PROCESSING', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([]);
      // Entry for O-held whose partner has PENDING_RSM_APPROVAL KYC.
      // Entry for O-ok whose partner has APPROVED KYC → payable.
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'e-held', outletId: 'O-held', outletName: 'Held', amountPaise: BigInt(5000), batch: { batchCode: 'CB-1' } },
        { id: 'e-ok',   outletId: 'O-ok',   outletName: 'OK',   amountPaise: BigInt(3000), batch: { batchCode: 'CB-1' } },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([
        {
          outletCode: 'O-held', name: 'Held', phone: '', isActive: true,
          partner: {
            bankName: '', bankAccountNumber: '', ifscCode: '', upiId: '',
            isActive: true, deletedAt: null,
            kycSubmissions: [{ id: 'ks-h', status: 'PENDING_RSM_APPROVAL', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
          },
        },
        {
          outletCode: 'O-ok', name: 'OK', phone: '', isActive: true,
          partner: {
            bankName: '', bankAccountNumber: '', ifscCode: '', upiId: '',
            isActive: true, deletedAt: null,
            kycSubmissions: [{ id: 'ks-ok', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
          },
        },
      ]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd5', downloadCode: 'PD-2026-05-005' });

      const res = await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.STANDARD });

      // The non-approved partner's entry must appear in heldEntries.
      expect(res.heldEntries).toHaveLength(1);
      expect(res.heldEntries[0].outletId).toBe('O-held');
      expect(res.heldEntries[0].reason).toMatch(/KYC_NOT_APPROVED/);

      // Only the APPROVED partner's entry is marked PROCESSING.
      const updateArg = mockTx.creditPayoutEntry.updateMany.mock.calls[0][0];
      expect(updateArg.where.id.in).toEqual(['e-ok']);
      expect(updateArg.where.id.in).not.toContain('e-held');
    });
  });

  describe('uploadUtr', () => {
    const downloadCode = 'PD-2026-05-001';

    // Build an in-memory payout xlsx the parser understands (title row, headers, data).
    function buildUtrFile(rows: (string | number)[][]): Express.Multer.File {
      const aoa = [['title'], ['Batch ID', 'Outlet ID', 'UTR', 'Success/Failure', 'Remarks'], ...rows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payout');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      return { buffer } as Express.Multer.File;
    }

    it('throws NotFound when the download is outside the tenant', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue(null);
      await expect(
        service.uploadUtr(gifsy, 'd1', buildUtrFile([]), false),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('previews the parse result without applying when apply=false', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1',
        downloadCode,
        period: '2026-05',
        downloadedBy: 'g1',
        // amountPaise as BigInt: 10000 = ₹100
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: BigInt(10000) }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);

      const file = buildUtrFile([[downloadCode, 'O1', 'UTR123456', 'Success', '']]);
      const res = (await service.uploadUtr(gifsy, 'd1', file, false)) as {
        parseResult: { canProceed: boolean; summary: { paidCount: number } };
        downloadCode: string;
      };
      expect(res.downloadCode).toBe(downloadCode);
      expect(res.parseResult.canProceed).toBe(true);
      expect(res.parseResult.summary.paidCount).toBe(1);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('applies PAID, sets the download to PAID, and sends the payout WhatsApp (Flow A)', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1',
        downloadCode,
        period: '2026-05',
        downloadedBy: 'g1',
        // amountPaise as BigInt
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: BigInt(10000) }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
      // FIX-C: entries re-read inside the tx.
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: BigInt(10000), tdsDeductedPaise: 0n, tdsSection: null, period: '2026-05' },
      ]);
      // FIX C: the recipient is now the KYC-verified partner phone, not outlet.phone.
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', name: 'A', partnerId: 'p1', partner: { ownerName: 'Ravi Traders', phone: '9900000041' } },
      ]);

      const file = buildUtrFile([[downloadCode, 'O1', 'UTR123456', 'Success', '']]);
      const res = (await service.uploadUtr(gifsy, 'd1', file, true)) as {
        applied: boolean;
        paidCount: number;
      };
      expect(res.applied).toBe(true);
      expect(res.paidCount).toBe(1);
      // FIX-C: the flip is a GUARDED updateMany (status:'PROCESSING'), not an unconditional update.
      expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenCalledWith({
        where: { id: 'e1', status: 'PROCESSING' },
        data: { status: 'PAID', utr: 'UTR123456', paidAt: expect.any(Date) },
      });
      expect(mockTx.creditPayoutDownload.update.mock.calls[0][0].data.status).toBe('PAID');
      // The DIRECT payout WhatsApp fires (deoleo_payout_credit); the old dead WHATSAPP
      // enqueue is gone — the notify() queue never drained non-PUSH.
      expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledTimes(1);
    });

    it('sends the deoleo_payout_credit WhatsApp with the right ordered bodyValues (Flow A)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-07-06T10:00:00.000Z'));
      try {
        mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
          id: 'd1',
          downloadCode,
          period: '2026-05',
          downloadedBy: 'g1',
          // ₹150 = 15000 paise → Deoleo 1pt=₹1 → 150 points paid.
          entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: BigInt(15000) }],
        });
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
        // FIX-C: entries re-read inside the tx.
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: BigInt(15000), tdsDeductedPaise: 0n, tdsSection: null, period: '2026-05' },
        ]);
        // FIX C: recipient = partner.phone (the KYC contact mobile), not outlet.phone.
        mockPrisma.outlet.findMany.mockResolvedValue([
          { outletCode: 'O1', name: 'A', partnerId: 'p1', partner: { ownerName: 'Ravi Traders', phone: '9900000041' } },
        ]);

        const file = buildUtrFile([[downloadCode, 'O1', 'UTR123456', 'Success', '']]);
        await service.uploadUtr(gifsy, 'd1', file, true);

        // bodyValues order: [ownerName, points, utr, date-of-payment (today), month (download.period)].
        expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledWith(
          '9900000041',
          'deoleo_payout_credit',
          ['Ravi Traders', '150', 'UTR123456', '06 Jul 2026', 'May 2026'],
        );
        // The old dead WHATSAPP enqueue must be gone (queue never drained non-PUSH).
        const whatsappEnqueues = mockNotifications.enqueue.mock.calls
          .map((c) => c[0])
          .filter((p: { channel?: string }) => p.channel === 'WHATSAPP');
        expect(whatsappEnqueues).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('refuses to apply when the parse result has errors', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1',
        downloadCode,
        period: '2026-05',
        downloadedBy: 'g1',
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: BigInt(10000) }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);

      // Bad UTR (too short) → ERROR → canProceed=false.
      const file = buildUtrFile([[downloadCode, 'O1', 'X1', 'Success', '']]);
      await expect(service.uploadUtr(gifsy, 'd1', file, true)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('listReversals', () => {
    it('scopes by tenant and applies status/period filters with default pagination', async () => {
      mockPrisma.creditReversal.findMany.mockResolvedValue([]);
      mockPrisma.creditReversal.count.mockResolvedValue(0);
      await service.listReversals(gifsy, { status: 'PENDING_GIFSY', period: '2026-05' });
      const arg = mockPrisma.creditReversal.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({ clientId: 'deoleo', status: 'PENDING_GIFSY', period: '2026-05' });
      expect(arg.orderBy).toEqual({ requestedAt: 'desc' });
      // Default page=1 / limit=50 → skip 0, take 50.
      expect(arg.skip).toBe(0);
      expect(arg.take).toBe(50);
      // The count uses the SAME where so pages reflect the filtered set.
      expect(mockPrisma.creditReversal.count.mock.calls[0][0].where).toEqual({
        clientId: 'deoleo',
        status: 'PENDING_GIFSY',
        period: '2026-05',
      });
    });

    it('computes skip/take from page & limit and returns the pagination envelope', async () => {
      mockPrisma.creditReversal.findMany.mockResolvedValue([{ id: 'r1' }]);
      mockPrisma.creditReversal.count.mockResolvedValue(5);
      const res = await service.listReversals(gifsy, { page: 2, limit: 2 });
      const arg = mockPrisma.creditReversal.findMany.mock.calls[0][0];
      // page 2, limit 2 → skip (2-1)*2 = 2, take 2.
      expect(arg.skip).toBe(2);
      expect(arg.take).toBe(2);
      // No status/period → where is tenant-only.
      expect(arg.where).toEqual({ clientId: 'deoleo' });
      expect(res).toEqual({
        reversals: [{ id: 'r1' }],
        pagination: { page: 2, limit: 2, total: 5, pages: 3 }, // ceil(5/2)=3
      });
    });

    it('ListReversalsQueryDto rejects limit > 100 and defaults page=1/limit=50', async () => {
      const dflt = plainToInstance(ListReversalsQueryDto, {});
      expect(dflt.page).toBe(1);
      expect(dflt.limit).toBe(50);
      expect(await validate(dflt)).toHaveLength(0);

      const over = plainToInstance(ListReversalsQueryDto, { limit: 99999999 });
      const errors = await validate(over);
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe('limit');
      expect(errors[0].constraints).toHaveProperty('max');

      expect(await validate(plainToInstance(ListReversalsQueryDto, { limit: 100 }))).toHaveLength(0);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Stream MONEY-CREDITS — backend enforcement of the per-tenant settings
  // (safety caps + month-cutoff window + notifyEmails routing). These were
  // previously frontend-only and bypassable via a direct API call.
  // ════════════════════════════════════════════════════════════════════════════

  describe('settings enforcement', () => {
    // Pin the wall clock so the month-cutoff window is deterministic.
    function pinDate(iso: string) {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(iso));
    }
    afterEach(() => jest.useRealTimers());

    /** A CreateBatchDto with a single OK row. `amount` is paise for PAYOUT, points for POINTS. */
    function batchDto(period: string, awardType: CreditAwardType, amount: number): CreateBatchDto {
      return {
        period,
        totalOutlets: 1,
        totalPoints: awardType === CreditAwardType.POINTS ? amount : 0,
        totalPayoutPaise: awardType === CreditAwardType.PAYOUT ? amount : 0,
        rows: [
          {
            rowNum: 1,
            outletId: 'OUT-001',
            outletName: 'Test Outlet',
            fieldId: 'field-1',
            fieldName: 'Sales Bonus',
            amount,
            narration: '',
            awardType,
            status: 'OK',
          } as unknown as CreateBatchDto['rows'][number],
        ],
      };
    }

    // ── Safety caps (createBatch) ────────────────────────────────────────────────

    describe('safety caps', () => {
      it('rejects a POINTS row exceeding safetyCapPoints', async () => {
        mockCreditsPayouts.safetyCapPoints = 50000;
        pinDate('2026-06-10T08:00:00.000Z'); // current-month period → cutoff irrelevant
        const dto = batchDto('2026-06', CreditAwardType.POINTS, 50001);
        await expect(service.createBatch(admin, dto)).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.createBatch(admin, dto)).rejects.toThrow(/safety cap of 50000 points/);
        expect(mockPrisma.creditBatch.create).not.toHaveBeenCalled();
      });

      it('rejects a PAYOUT row whose rupee value exceeds safetyCapInr', async () => {
        mockCreditsPayouts.safetyCapInr = 100000;
        pinDate('2026-06-10T08:00:00.000Z');
        // 100001 rupees = 10000100 paise → over the ₹100000 cap.
        const dto = batchDto('2026-06', CreditAwardType.PAYOUT, 10000100);
        await expect(service.createBatch(admin, dto)).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.createBatch(admin, dto)).rejects.toThrow(/safety cap of ₹100000/);
        expect(mockPrisma.creditBatch.create).not.toHaveBeenCalled();
      });

      it('allows rows within both caps', async () => {
        mockCreditsPayouts.safetyCapPoints = 50000;
        mockCreditsPayouts.safetyCapInr = 100000;
        mockTx.creditBatch.create.mockResolvedValue({ id: 'b1' });
        pinDate('2026-06-10T08:00:00.000Z');
        const dto = batchDto('2026-06', CreditAwardType.POINTS, 50000); // exactly at the cap
        dto.rows.push({
          rowNum: 2,
          outletId: 'OUT-002',
          outletName: 'Outlet Two',
          fieldId: 'field-2',
          fieldName: 'Payout Field',
          amount: 10000000, // ₹100000 in paise — exactly at the ₹100000 cap
          narration: '',
          awardType: CreditAwardType.PAYOUT,
          status: 'OK',
        } as unknown as CreateBatchDto['rows'][number]);
        await expect(service.createBatch(admin, dto)).resolves.toBeDefined();
        expect(mockTx.creditBatch.create).toHaveBeenCalledTimes(1);
      });

      it('ignores non-OK rows when checking caps', async () => {
        mockCreditsPayouts.safetyCapPoints = 50000;
        mockTx.creditBatch.create.mockResolvedValue({ id: 'b1' });
        pinDate('2026-06-10T08:00:00.000Z');
        const dto = batchDto('2026-06', CreditAwardType.POINTS, 999999); // over cap…
        (dto.rows[0] as unknown as { status: string }).status = 'ERROR'; // …but not OK
        await expect(service.createBatch(admin, dto)).resolves.toBeDefined();
      });
    });

    // ── Month cutoff (createBatch) ────────────────────────────────────────────────

    describe('month cutoff window', () => {
      it('rejects a PRIOR-month batch created AFTER the cutoff day', async () => {
        mockCreditsPayouts.monthCutoffDay = 28;
        // Today = 29 June (> cutoff 28); batch period = May (prior month).
        pinDate('2026-06-29T08:00:00.000Z');
        const dto = batchDto('2026-05', CreditAwardType.POINTS, 100);
        await expect(service.createBatch(admin, dto)).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.createBatch(admin, dto)).rejects.toThrow(
          /window for prior-month period 2026-05 closed/,
        );
        expect(mockPrisma.creditBatch.create).not.toHaveBeenCalled();
      });

      it('allows a PRIOR-month batch created ON/BEFORE the cutoff day', async () => {
        mockCreditsPayouts.monthCutoffDay = 28;
        mockTx.creditBatch.create.mockResolvedValue({ id: 'b1' });
        // Today = 28 June (== cutoff, still open); batch period = May.
        pinDate('2026-06-28T08:00:00.000Z');
        const dto = batchDto('2026-05', CreditAwardType.POINTS, 100);
        await expect(service.createBatch(admin, dto)).resolves.toBeDefined();
        expect(mockTx.creditBatch.create).toHaveBeenCalledTimes(1);
      });

      it('does NOT gate a CURRENT-month batch even after the cutoff day', async () => {
        mockCreditsPayouts.monthCutoffDay = 5;
        mockTx.creditBatch.create.mockResolvedValue({ id: 'b1' });
        // Today = 29 June (past cutoff 5) but the batch period IS the current month.
        pinDate('2026-06-29T08:00:00.000Z');
        const dto = batchDto('2026-06', CreditAwardType.POINTS, 100);
        await expect(service.createBatch(admin, dto)).resolves.toBeDefined();
      });

      it('also enforces the cutoff on confirmBatch for a prior-month batch', async () => {
        mockCreditsPayouts.monthCutoffDay = 28;
        pinDate('2026-06-29T08:00:00.000Z'); // past cutoff
        mockPrisma.creditBatch.findFirst.mockResolvedValue({
          id: 'b1',
          status: 'PENDING_CONFIRM',
          period: '2026-05', // prior month
          uploadedBy: 'admin1',
          totalOutlets: 0,
          totalPoints: 0,
          totalPayoutPaise: BigInt(0),
          rows: [],
        });
        await expect(service.confirmBatch(admin, 'b1')).rejects.toBeInstanceOf(BadRequestException);
        // The status flip must NOT have happened.
        expect(mockTx.creditBatch.updateMany).not.toHaveBeenCalled();
      });
    });

    // ── notifyEmails routing (confirmBatch) ──────────────────────────────────────

    describe('confirmBatch notification routing', () => {
      beforeEach(() => {
        // Current-month period + open window so the cutoff never blocks confirm.
        pinDate('2026-06-10T08:00:00.000Z');
        mockPrisma.creditBatch.findFirst.mockResolvedValue({
          id: 'b1',
          clientId: 'deoleo',
          status: 'PENDING_CONFIRM',
          period: '2026-06',
          uploadedBy: 'admin1',
          totalOutlets: 1,
          totalPoints: 100,
          totalPayoutPaise: BigInt(0),
          rows: [],
        });
      });

      it('routes to the configured notifyEmails when non-empty (one enqueue per address)', async () => {
        mockCreditsPayouts.notifyEmails = ['finance@acme.com', 'ops@acme.com'];
        await service.confirmBatch(admin, 'b1');
        const emailCalls = mockNotifications.enqueue.mock.calls
          .map((c) => c[0])
          .filter((p: { channel: string }) => p.channel === 'EMAIL');
        expect(emailCalls.map((p: { recipientEmail: string }) => p.recipientEmail).sort()).toEqual(
          ['finance@acme.com', 'ops@acme.com'].sort(),
        );
        // The legacy fallback must NOT be used when a list is configured.
        expect(emailCalls.map((p: { recipientEmail: string }) => p.recipientEmail)).not.toContain(
          'ops@gifsy.in',
        );
      });

      it('falls back to ops@gifsy.in when notifyEmails is empty', async () => {
        mockCreditsPayouts.notifyEmails = [];
        await service.confirmBatch(admin, 'b1');
        const emailCalls = mockNotifications.enqueue.mock.calls
          .map((c) => c[0])
          .filter((p: { channel: string }) => p.channel === 'EMAIL');
        expect(emailCalls).toHaveLength(1);
        expect(emailCalls[0].recipientEmail).toBe('ops@gifsy.in');
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // Stream B — Visibility-led payouts: stamp+invoice at confirm, DEDUCT/GROSS-UP at
  // download, lock at UTR. Money is BigInt paise; every write is idempotent.
  // ════════════════════════════════════════════════════════════════════════════

  describe('visibility-payout TDS (Stream B)', () => {
    // ── Stamp + invoice at CONFIRM ──────────────────────────────────────────────
    describe.each([
      ['SEC_194C', 'DEDUCT'],
      ['SEC_194C', 'GROSS_UP'],
      ['SEC_194R', 'DEDUCT'],
      ['SEC_194R', 'GROSS_UP'],
    ])('confirm freezes the TDS treatment (%s / %s)', (section, methodology) => {
      it('stamps tdsSection (VISIBILITY→section, INCENTIVE→194R) + tdsMethodology by value', async () => {
        mockTenantSettings.resolveTdsPolicy.mockResolvedValue({ section, methodology });
        mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
        mockPrisma.creditBatch.findFirst.mockResolvedValue({
          id: 'b1', status: 'PENDING_CONFIRM', period: '2026-05', uploadedBy: 'admin1',
          totalOutlets: 2, totalPoints: 0, totalPayoutPaise: BigInt(0),
          rows: [
            { outletId: 'O1', outletName: 'A', fieldId: 'f-vis', fieldName: 'Visibility', amount: 10000, narration: '', awardType: 'PAYOUT', status: 'OK' },
            { outletId: 'O2', outletName: 'B', fieldId: 'f-inc', fieldName: 'Incentive', amount: 20000, narration: '', awardType: 'PAYOUT', status: 'OK' },
          ],
        });

        await service.confirmBatch(admin, 'b1');

        const data = mockTx.creditPayoutEntry.createMany.mock.calls[0][0].data as Array<{
          fieldId: string; tdsSection: string; tdsMethodology: string;
        }>;
        const vis = data.find((d) => d.fieldId === 'f-vis')!;
        const inc = data.find((d) => d.fieldId === 'f-inc')!;
        expect(vis.tdsSection).toBe(section);
        expect(inc.tdsSection).toBe('SEC_194R'); // INCENTIVE is always a benefit-in-kind
        expect(vis.tdsMethodology).toBe(methodology);
        expect(inc.tdsMethodology).toBe(methodology);
        // Invoice-at-confirm delegated for the visibility field(s) only.
        expect(mockInvoicesService.generateForBatch).toHaveBeenCalledWith(
          mockTx,
          expect.objectContaining({ clientId: 'deoleo', period: '2026-05', batchId: 'b1', visibilityFieldIds: ['f-vis'] }),
        );
      });
    });

    it('confirm does NOT invoice when the tenant has no visibility fields', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([]);
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1', status: 'PENDING_CONFIRM', period: '2026-05', uploadedBy: 'admin1',
        totalOutlets: 1, totalPoints: 0, totalPayoutPaise: BigInt(0),
        rows: [
          { outletId: 'O1', outletName: 'A', fieldId: 'f-inc', fieldName: 'Incentive', amount: 10000, narration: '', awardType: 'PAYOUT', status: 'OK' },
        ],
      });
      await service.confirmBatch(admin, 'b1');
      expect(mockInvoicesService.generateForBatch).not.toHaveBeenCalled();
    });

    it('a malformed tdsPolicy fails the confirm CLOSED before any write (resolveTdsPolicy throws)', async () => {
      mockTenantSettings.resolveTdsPolicy.mockRejectedValue(new BadRequestException('bad policy'));
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1', status: 'PENDING_CONFIRM', period: '2026-05', uploadedBy: 'admin1',
        totalOutlets: 1, totalPoints: 0, totalPayoutPaise: BigInt(0), rows: [],
      });
      await expect(service.confirmBatch(admin, 'b1')).rejects.toBeInstanceOf(BadRequestException);
      // The atomic money tx never ran.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    // ── DEDUCT at download ──────────────────────────────────────────────────────
    /** A KYC-approved, active outlet with the given tax profile. */
    function bankOutlet(entityType: string, gstRegistrationType = 'UNREGISTERED', gstNumber: string | null = null) {
      return {
        outletCode: 'O1', name: 'A', state: 'West Bengal', phone: '', isActive: true,
        partner: {
          id: 'p1', bankName: 'HDFC', bankAccountNumber: '1', ifscCode: 'I', upiId: '',
          isActive: true, deletedAt: null,
          panNumber: 'PAN1', entityType, gstNumber, gstRegistrationType,
          businessName: 'A Ent', ownerName: 'A Owner', phone: '9',
          kycSubmissions: [{ id: 'ks1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }],
        },
      };
    }
    function visEntry(amountPaise: bigint, methodology: string) {
      return { id: 'e1', outletId: 'O1', outletName: 'A', amountPaise, fieldId: 'f-vis', tdsSection: 'SEC_194C', tdsMethodology: methodology, batch: { batchCode: 'CB-1' } };
    }

    it('DEDUCT: withholds TDS, reduces the bank line to NET, writes the ledger + entry', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      // ₹50,000 single payment (> ₹30k single threshold) → crosses; 1% (INDIVIDUAL) = ₹500.
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([visEntry(5000000n, 'DEDUCT')]); // MAIN query
      mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL')]); // MAIN bank/KYC query
      // FIX-8: plan reads run inside the tx.
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([]); // prior committed (none)
      mockTx.outlet.findMany.mockResolvedValue([{ outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' }]); // prior-outlet resolution
      mockTx.channelPartner.findMany.mockResolvedValue([{ id: 'p1', panNumber: 'PAN1' }]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-001' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });

      // Ledger row: TDS due = ₹500 = 50000 paise; nothing carried; net bank line = ₹49,500.
      const ledger = mockTx.tdsDeductionEntry.createMany.mock.calls[0][0].data[0];
      expect(ledger.panNumber).toBe('PAN1');
      expect(ledger.section).toBe('SEC_194C');
      expect(ledger.eventBasePaise).toBe(5000000n);
      expect(ledger.cumulativeBasePaise).toBe(5000000n);
      expect(ledger.tdsDeductedThisPaise).toBe(50000n);
      expect(ledger.tdsDeductedPriorPaise).toBe(0n);
      expect(ledger.carryForwardPaise).toBe(0n);
      // Per-entry withheld amount stamped.
      expect(mockTx.creditPayoutEntry.update).toHaveBeenCalledWith({
        where: { id: 'e1' }, data: { tdsDeductedPaise: 50000n },
      });
      // The download total is NET of the withholding (5,000,000 − 50,000).
      expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(4950000));
      // GROSS-UP artefacts never created for a DEDUCT tenant.
      expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
    });

    it('DEDUCT: carries the un-withheld remainder forward when the catch-up exceeds the payout', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      // OTHERS → 2%. Prior FY base ₹99,000 (below ₹1L, no single > ₹30k), this payout ₹2,000
      // crosses ₹1L → due 2% of ₹1,01,000 = ₹2,020; only ₹2,000 fits → ₹20 carried forward.
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([visEntry(200000n, 'DEDUCT')]); // MAIN query
      mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('OTHERS')]); // MAIN bank/KYC
      // FIX-8: plan reads inside the tx — prior committed ₹99,000 for this PAN.
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([{ clientId: 'deoleo', outletId: 'O1', amountPaise: 9900000n, tdsSection: 'SEC_194C', tdsMethodology: 'DEDUCT' }]);
      mockTx.outlet.findMany.mockResolvedValue([{ outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' }]);
      mockTx.channelPartner.findMany.mockResolvedValue([{ id: 'p1', panNumber: 'PAN1' }]);
      // priorDeducted mocked to 0 to isolate the carry-forward arithmetic.
      mockTx.tdsDeductionEntry.findMany.mockResolvedValue([]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-002' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });

      const ledger = mockTx.tdsDeductionEntry.createMany.mock.calls[0][0].data[0];
      expect(ledger.cumulativeBasePaise).toBe(10100000n); // ₹1,01,000
      expect(ledger.tdsDueCumulativePaise).toBe(202000n); // ₹2,020
      expect(ledger.tdsDeductedThisPaise).toBe(200000n); // only ₹2,000 fits
      expect(ledger.carryForwardPaise).toBe(2000n); // ₹20 carried forward
      // Entire ₹2,000 payout withheld → net line is ₹0.
      expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(0));
    });

    // ── GROSS-UP at download ────────────────────────────────────────────────────
    it('GROSS-UP: pays full, raises the ANCHOR (seq=1) top-up invoice + delta recovery at first crossing', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      // ₹1,10,000 crosses ₹1L; 1% grossed-up TDS = ₹1,111 = 111100 paise.
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([visEntry(11000000n, 'GROSS_UP')]); // MAIN query
      mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL')]); // MAIN bank/KYC
      // FIX-8 plan reads (tx): no prior committed, no prior recovery, no prior TDS invoice.
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);
      mockTx.outlet.findMany.mockResolvedValue([{ outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' }]);
      mockTx.channelPartner.findMany.mockResolvedValue([{ id: 'p1', panNumber: 'PAN1' }]);
      mockTx.tdsRecoveryEntry.findMany.mockResolvedValue([]); // alreadyInvoiced = 0
      mockTx.autoInvoice.findMany.mockResolvedValue([]); // no prior top-up → seq=1 anchor
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-003' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });

      expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(
        mockTx,
        // FIX-1: DELTA body = grossUp(cumulative) − alreadyInvoiced(0) = 111100; seq=1 anchor.
        expect.objectContaining({ clientId: 'deoleo', panNumber: 'PAN1', fyLabel: '2026-27', bodyPaise: 111100n, seq: 1, isAnchor: true }),
      );
      const recovery = mockTx.tdsRecoveryEntry.createMany.mock.calls[0][0].data;
      expect(recovery).toHaveLength(1);
      expect(recovery[0]).toMatchObject({
        clientId: 'deoleo', tenantSharePaise: 111100n, panTdsTotalPaise: 111100n,
        tenantBasePaise: 11000000n, panBasePaise: 11000000n, tdsInvoiceId: 'tds1', section: 'SEC_194C',
      });
      // Retailer paid FULL (no deduction) — the bank total is the gross amount.
      expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
      expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(11000000));
    });

    it('FIX-1: monthly-incremental — period-2 top-up raises only the DELTA; the two bodies sum to grossUp(full base)', async () => {
      // Period 2 pays another ₹1,10,000 (cumulative ₹2,20,000). Period-1 already invoiced 111100
      // (recovery ledger). dueNow = grossUp(₹2.2L, 1/99) = 222200; delta = 222200 − 111100 = 111100.
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([visEntry(11000000n, 'GROSS_UP')]); // this event
      mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL')]);
      // Prior committed ₹1,10,000 (period 1), same PAN.
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([{ clientId: 'deoleo', outletId: 'O1', amountPaise: 11000000n, tdsSection: 'SEC_194C', tdsMethodology: 'GROSS_UP' }]);
      mockTx.outlet.findMany.mockResolvedValue([{ outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' }]);
      mockTx.channelPartner.findMany.mockResolvedValue([{ id: 'p1', panNumber: 'PAN1' }]);
      // Period-1 already recovered 111100; a period-1 anchor TDS invoice exists (different period).
      mockTx.tdsRecoveryEntry.findMany.mockResolvedValue([{ panNumber: 'PAN1', section: 'SEC_194C', clientId: 'deoleo', tenantSharePaise: 111100n }]);
      mockTx.autoInvoice.findMany.mockResolvedValue([{ period: '2026-05' }]); // seq=2, different period → not idempotent-skip
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(1);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd2', downloadCode: 'PD-2026-06-001' });

      await service.createPayoutDownload(gifsy, { period: '2026-06', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });

      // The period-2 body is the DELTA (111100), NOT the cumulative dueNow (222200); seq=2, not anchor.
      expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({ bodyPaise: 111100n, seq: 2, isAnchor: false, period: '2026-06' }),
      );
      // Across the FY: period-1 body (111100) + period-2 body (111100) = 222200 = grossUp(₹2.2L).
    });

    it('FIX-1: idempotent per (PAN, FY, period) — a same-period re-run does NOT double-raise', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([visEntry(11000000n, 'GROSS_UP')]);
      mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL')]);
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);
      mockTx.outlet.findMany.mockResolvedValue([{ outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' }]);
      mockTx.channelPartner.findMany.mockResolvedValue([{ id: 'p1', panNumber: 'PAN1' }]);
      // A top-up for THIS PAN/FY/period already exists → skip (no double-raise).
      mockTx.autoInvoice.findMany.mockResolvedValue([{ period: '2026-05' }]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-004' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });

      expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
      expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
    });

    it('FIX-A (D10): recovery is split PRO-RATA by each tenant’s share of the FY AGGREGATE base', async () => {
      // deoleo pays ₹40k now; tenant "other" already paid ₹70k this FY → aggregate ₹1.1L crosses.
      // D10: the grossed-up TDS is recovered PRO-RATA by base share (NOT all to the triggering
      // tenant). ₹1,111 (111100 paise) split by 40k:70k → deoleo 40400 / other 70700.
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([visEntry(4000000n, 'GROSS_UP')]); // MAIN
      mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL')]);
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([{ clientId: 'other', outletId: 'OX', amountPaise: 7000000n, tdsSection: 'SEC_194C', tdsMethodology: 'GROSS_UP' }]);
      mockTx.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' },
        { outletCode: 'OX', clientId: 'other', partnerId: 'p2' },
      ]);
      mockTx.channelPartner.findMany.mockResolvedValue([
        { id: 'p1', panNumber: 'PAN1' },
        { id: 'p2', panNumber: 'PAN1' },
      ]);
      mockTx.tdsRecoveryEntry.findMany.mockResolvedValue([]);
      mockTx.autoInvoice.findMany.mockResolvedValue([]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-005' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });

      // Body = 1% grossed-up on ₹1.1L cumulative = 111100 paise; panBase = the FY aggregate.
      expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(
        mockTx, expect.objectContaining({ bodyPaise: 111100n, panNumber: 'PAN1' }),
      );
      const recovery = mockTx.tdsRecoveryEntry.createMany.mock.calls[0][0].data as Array<{
        clientId: string; tenantSharePaise: bigint; tenantBasePaise: bigint; panBasePaise: bigint;
      }>;
      // Pro-rata by FY aggregate: two rows, summing to the body.
      expect(recovery).toHaveLength(2);
      const byTenant = Object.fromEntries(recovery.map((r) => [r.clientId, r.tenantSharePaise]));
      expect(byTenant['deoleo']).toBe(40400n);
      expect(byTenant['other']).toBe(70700n);
      expect(recovery.reduce((s, r) => s + r.tenantSharePaise, 0n)).toBe(111100n);
      // panBase is the cross-tenant FY aggregate (₹1.1L), not just this event's base.
      expect(recovery[0].panBasePaise).toBe(11000000n);
    });

    it('FIX-A (D10): cumulative recovery is pro-rata by FY aggregate REGARDLESS of payment order', async () => {
      // Malign order: X pays ₹25k in P1 (sub-threshold → NO recovery), then Y pays ₹80k in P2
      // (aggregate ₹1,05,000 crosses ₹1L). OTHERS entity → 2/98. TDS = ₹2,143 (214300 paise).
      // D10 (pro-rata by FY aggregate): X 25k/105k → 51024, Y 80k/105k → 163276 (sum 214300).
      // The bug was Y ₹2,143 / X ₹0 (whole delta to the triggering tenant).
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);

      // ── P1: tenant X pays ₹25,000 (sub-threshold) → no invoice, no recovery. ──
      const xOutlet = bankOutlet('OTHERS');
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([visEntry(2500000n, 'GROSS_UP')]);
      mockPrisma.outlet.findMany.mockResolvedValue([xOutlet]);
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([]); // no prior committed
      mockTx.outlet.findMany.mockResolvedValue([{ outletCode: 'O1', clientId: 'X', partnerId: 'p1' }]);
      mockTx.channelPartner.findMany.mockResolvedValue([{ id: 'p1', panNumber: 'PAN1' }]);
      mockTx.tdsRecoveryEntry.findMany.mockResolvedValue([]);
      mockTx.autoInvoice.findMany.mockResolvedValue([]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-020' });

      await service.createPayoutDownload({ ...gifsy, clientId: 'X' }, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });
      // Sub-threshold → nothing raised.
      expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
      expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();

      // ── P2: tenant Y pays ₹80,000 → aggregate crosses; recovery split pro-rata X/Y. ──
      // (No clearAllMocks: P1 raised neither an invoice nor a recovery row, so the P2 calls below
      // are still index 0 in each mock's history.)
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([{ id: 'e2', outletId: 'O2', outletName: 'B', amountPaise: 8000000n, fieldId: 'f-vis', tdsSection: 'SEC_194C', tdsMethodology: 'GROSS_UP', batch: { batchCode: 'CB-2' } }]);
      const yOutlet = { ...bankOutlet('OTHERS'), outletCode: 'O2', name: 'B', partner: { ...bankOutlet('OTHERS').partner, id: 'p2' } };
      mockPrisma.outlet.findMany.mockResolvedValue([yOutlet]);
      // X's ₹25k is now PRIOR committed (PROCESSING) under tenant X, same PAN.
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([{ clientId: 'X', outletId: 'O1', amountPaise: 2500000n, tdsSection: 'SEC_194C', tdsMethodology: 'GROSS_UP' }]);
      mockTx.outlet.findMany.mockResolvedValue([
        { outletCode: 'O2', clientId: 'Y', partnerId: 'p2' },
        { outletCode: 'O1', clientId: 'X', partnerId: 'p1' },
      ]);
      mockTx.channelPartner.findMany.mockResolvedValue([
        { id: 'p2', panNumber: 'PAN1' },
        { id: 'p1', panNumber: 'PAN1' },
      ]);
      mockTx.tdsRecoveryEntry.findMany.mockResolvedValue([]); // no recovery yet (P1 was sub-threshold)
      mockTx.autoInvoice.findMany.mockResolvedValue([]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(1);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd2', downloadCode: 'PD-2026-06-020' });

      await service.createPayoutDownload({ ...gifsy, clientId: 'Y' }, { period: '2026-06', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });

      expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(
        mockTx, expect.objectContaining({ bodyPaise: 214300n, panNumber: 'PAN1' }),
      );
      const recovery = mockTx.tdsRecoveryEntry.createMany.mock.calls[0][0].data as Array<{
        clientId: string; tenantSharePaise: bigint;
      }>;
      const byTenant = Object.fromEntries(recovery.map((r) => [r.clientId, r.tenantSharePaise]));
      // D10 final cumulative: X ₹510 (51024p), Y ₹1,633 (163276p) — NOT Y ₹2,143 / X ₹0.
      expect(byTenant['X']).toBe(51024n);
      expect(byTenant['Y']).toBe(163276n);
      expect(recovery.reduce((s, r) => s + r.tenantSharePaise, 0n)).toBe(214300n);
    });

    // ── Lock at UTR ─────────────────────────────────────────────────────────────
    it('UTR apply locks the linked SERVICE invoice (lockedAt) for the paid outlets', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1', downloadCode: 'PD-2026-05-001', period: '2026-05', downloadedBy: 'g1',
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: BigInt(10000) }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]); // used-UTR dedup query
      // FIX-C: entries re-read inside the tx.
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: BigInt(10000), tdsDeductedPaise: 0n, tdsSection: null, period: '2026-05' },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', name: 'A', partnerId: 'p1', partner: { ownerName: 'Ravi', phone: '9900000041' } },
      ]);

      const aoa = [['title'], ['Batch ID', 'Outlet ID', 'UTR', 'Success/Failure', 'Remarks'], ['PD-2026-05-001', 'O1', 'UTR999999', 'Success', '']];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payout');
      const file = { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File;

      await service.uploadUtr(gifsy, 'd1', file, true);

      const lockCall = mockTx.autoInvoice.updateMany.mock.calls[0][0];
      expect(lockCall.where).toMatchObject({
        clientId: 'deoleo', period: '2026-05', invoiceKind: 'SERVICE', lockedAt: null,
      });
      expect(lockCall.where.outletCode.in).toEqual(['O1']);
      expect(lockCall.data.lockedAt).toBeInstanceOf(Date);
    });

    // ── FIX-3: FAILED payout reverses its DEDUCT withholding ─────────────────────
    it('FIX-3: a FAILED payout reverses its DEDUCT withholding (entry reset to 0 + negative ledger row)', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1', downloadCode: 'PD-2026-05-001', period: '2026-05', downloadedBy: 'g1',
        entries: [{
          id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: 5000000n,
          tdsDeductedPaise: 50000n, tdsSection: 'SEC_194C', period: '2026-05',
        }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]); // used-UTR dedup query
      // FIX-C: entries are re-read INSIDE the tx (fresh status + tdsDeductedPaise).
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([{
        id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: 5000000n,
        tdsDeductedPaise: 50000n, tdsSection: 'SEC_194C', period: '2026-05',
      }]);
      // FIX-C: the reversal resolves PAN from the ORIGINAL TdsDeductionEntry (by creditPayoutEntryId),
      // NOT a fresh partner lookup — so a mid-flight re-KYC reverses against the deducted PAN.
      mockTx.tdsDeductionEntry.findMany.mockResolvedValue([{ creditPayoutEntryId: 'e1', panNumber: 'PAN1' }]);

      const aoa = [['title'], ['Batch ID', 'Outlet ID', 'UTR', 'Success/Failure', 'Remarks'], ['PD-2026-05-001', 'O1', '', 'Failure', 'bounced']];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payout');
      const file = { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File;

      await service.uploadUtr(gifsy, 'd1', file, true);

      // FIX-C: the entry flips via a GUARDED updateMany (status:'PROCESSING'); a failed payout
      // withheld nothing → tdsDeductedPaise cleared.
      expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenCalledWith({
        where: { id: 'e1', status: 'PROCESSING' },
        data: { status: 'FAILED', utr: null, paidAt: null, tdsDeductedPaise: 0n },
      });
      // Compensating NEGATIVE ledger row (PAN from the original deduction) so the next event's
      // priorDeducted drops the un-withheld ₹500; linked back to the entry via creditPayoutEntryId.
      const rev = mockTx.tdsDeductionEntry.createMany.mock.calls[0][0].data[0];
      expect(rev.panNumber).toBe('PAN1');
      expect(rev.section).toBe('SEC_194C');
      expect(rev.fyLabel).toBe('2026-27'); // FY of period 2026-05
      expect(rev.creditPayoutEntryId).toBe('e1');
      expect(rev.tdsDeductedThisPaise).toBe(-50000n);
    });

    // ── FIX-C: concurrent apply — the guarded PROCESSING flip prevents a double reversal ─────────
    it('FIX-C: a concurrent apply that already transitioned the entry writes NO second reversal', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1', downloadCode: 'PD-2026-05-001', period: '2026-05', downloadedBy: 'g1',
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: 5000000n, tdsDeductedPaise: 50000n, tdsSection: 'SEC_194C', period: '2026-05' }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]); // used-UTR dedup
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([{
        id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: 5000000n,
        tdsDeductedPaise: 50000n, tdsSection: 'SEC_194C', period: '2026-05',
      }]);
      mockTx.tdsDeductionEntry.findMany.mockResolvedValue([{ creditPayoutEntryId: 'e1', panNumber: 'PAN1' }]);
      // Simulate a concurrent apply having ALREADY flipped e1 out of PROCESSING → guarded claim = 0.
      mockTx.creditPayoutEntry.updateMany.mockResolvedValue({ count: 0 });

      const aoa = [['title'], ['Batch ID', 'Outlet ID', 'UTR', 'Success/Failure', 'Remarks'], ['PD-2026-05-001', 'O1', '', 'Failure', 'bounced']];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payout');
      const file = { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File;

      await service.uploadUtr(gifsy, 'd1', file, true);

      // The advisory lock was taken and the flip attempted, but count=0 → NO compensating reversal.
      expect(mockTx.$executeRaw).toHaveBeenCalled();
      expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
    });

    // ── FIX-7: guarded PROCESSING claim ──────────────────────────────────────────
    it('FIX-7: aborts (ConflictException) when the guarded PROCESSING claim comes up short', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'e1', outletId: 'O1', outletName: 'A', amountPaise: BigInt(10000), batch: { batchCode: 'CB-1' } },
        { id: 'e2', outletId: 'O2', outletName: 'B', amountPaise: BigInt(5000), batch: { batchCode: 'CB-1' } },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([
        {
          outletCode: 'O1', name: 'A', phone: '', isActive: true,
          partner: { bankName: '', bankAccountNumber: '', ifscCode: '', upiId: '', isActive: true, deletedAt: null, kycSubmissions: [{ id: 'k1', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }] },
        },
        {
          outletCode: 'O2', name: 'B', phone: '', isActive: true,
          partner: { bankName: '', bankAccountNumber: '', ifscCode: '', upiId: '', isActive: true, deletedAt: null, kycSubmissions: [{ id: 'k2', status: 'APPROVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }] },
        },
      ]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-009' });
      // A concurrent download already claimed one of the two entries → only 1 flipped (expected 2).
      mockTx.creditPayoutEntry.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.STANDARD }),
      ).rejects.toBeInstanceOf(ConflictException);
      // The guarded claim carries the PENDING/FAILED status predicate.
      const claim = mockTx.creditPayoutEntry.updateMany.mock.calls[0][0];
      expect(claim.where.status).toEqual({ in: ['PENDING', 'FAILED'] });
    });

    // ── FIX-8: per-PAN advisory lock before the cumulative read ───────────────────
    it('FIX-8: takes a per-PAN advisory lock (sorted key) before building the plan', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([visEntry(5000000n, 'DEDUCT')]);
      mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL')]);
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);
      mockTx.outlet.findMany.mockResolvedValue([{ outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' }]);
      mockTx.channelPartner.findMany.mockResolvedValue([{ id: 'p1', panNumber: 'PAN1' }]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-011' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });

      // The advisory lock is acquired via tx.$executeRaw with the PAN|<PAN>|<FY> key.
      expect(mockTx.$executeRaw).toHaveBeenCalled();
      expect(mockTx.$executeRaw.mock.calls[0][1]).toBe('PAN|PAN1|2026-27');
    });

    // ── FIX-9: no-PAN visibility recovery (paid full, tenant recovery, no invoice) ──
    it('FIX-9: a no-PAN visibility payout is paid FULL but accrues a 20% tenant recovery once it crosses', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      // ₹40,000 single (> ₹30k single threshold) with NO PAN → paid full; 20% grossed-up recovery.
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([visEntry(4000000n, 'GROSS_UP')]);
      const noPanOutlet = bankOutlet('INDIVIDUAL');
      (noPanOutlet.partner as { panNumber: string | null }).panNumber = null; // no PAN on file
      mockPrisma.outlet.findMany.mockResolvedValue([noPanOutlet]);
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([]); // no prior no-PAN base
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-010' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });

      // No deduction, no per-PAN TDS invoice — paid in full.
      expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
      expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
      expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(4000000));
      // Recovery row: __NO_PAN__:<outlet> encoded sentinel, 20% grossed-up on ₹40,000 = 1000000, no invoice.
      const rec = mockTx.tdsRecoveryEntry.createMany.mock.calls[0][0].data[0];
      expect(rec.panNumber).toBe('__NO_PAN__:O1');
      expect(rec.clientId).toBe('deoleo');
      expect(rec.section).toBe('SEC_194C');
      expect(rec.tenantSharePaise).toBe(1000000n);
      expect(rec.tdsInvoiceId).toBeNull();
    });

    // ── FIX-B: no-PAN recovery telescopes off the ledger (FAIL→re-bank = single recovery) ─────────
    it('FIX-B: a no-PAN FAIL→re-bank of the same base yields a ZERO recovery delta (no double 20%)', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      // Re-bank of the SAME ₹40,000 no-PAN base: the failed entry re-enters as this event, but the
      // first attempt's recovery (₹10,000 = 1000000p) is already recorded in the ledger.
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([visEntry(4000000n, 'GROSS_UP')]);
      const noPanOutlet = bankOutlet('INDIVIDUAL');
      (noPanOutlet.partner as { panNumber: string | null }).panNumber = null;
      mockPrisma.outlet.findMany.mockResolvedValue([noPanOutlet]);
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([]); // failed base excluded from prior
      // The first attempt already recorded 1000000p recovery for THIS outlet/FY (telescope source).
      mockTx.tdsRecoveryEntry.findMany.mockResolvedValue([
        { panNumber: '__NO_PAN__:O1', section: 'SEC_194C', tenantSharePaise: 1000000n },
      ]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(1);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd2', downloadCode: 'PD-2026-05-012' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });

      // grossUp20(₹40k) − alreadyRecovered(₹10k) = 0 → NO new recovery row (total stays ₹10,000).
      expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
    });

    // ── FIX-D: MIXED cross-tenant PAN (DEDUCT + GROSS_UP) partitions the base by methodology ──────
    it('FIX-D: a MIXED PAN withholds DEDUCT only on the DEDUCT base (threshold on the combined base)', async () => {
      // Prior GROSS_UP base ₹80,000 (tenant "other") + this event DEDUCT ₹40,000 (deoleo), same PAN.
      // Combined ₹1,20,000 crosses ₹1L. FIX-D: DEDUCT withholding is on the DEDUCT base (₹40,000)
      // ONLY, NOT the combined base — 2% (OTHERS) × ₹40,000 = ₹800 (80000 paise), not 2% × ₹1.2L.
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([visEntry(4000000n, 'DEDUCT')]);
      mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('OTHERS')]);
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { clientId: 'other', outletId: 'OX', amountPaise: 8000000n, tdsSection: 'SEC_194C', tdsMethodology: 'GROSS_UP' },
      ]);
      mockTx.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' },
        { outletCode: 'OX', clientId: 'other', partnerId: 'p2' },
      ]);
      mockTx.channelPartner.findMany.mockResolvedValue([
        { id: 'p1', panNumber: 'PAN1' },
        { id: 'p2', panNumber: 'PAN1' },
      ]);
      mockTx.tdsDeductionEntry.findMany.mockResolvedValue([]); // no prior withholding
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(1);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-013' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });

      const ledger = mockTx.tdsDeductionEntry.createMany.mock.calls[0][0].data[0];
      // Cumulative base for the DEDUCT ledger = the DEDUCT portion only (₹40,000), threshold met.
      expect(ledger.cumulativeBasePaise).toBe(4000000n);
      expect(ledger.tdsDueCumulativePaise).toBe(80000n); // 2% × ₹40,000 = ₹800 (NOT 2% × ₹1.2L)
      expect(ledger.tdsDeductedThisPaise).toBe(80000n);
      expect(ledger.carryForwardPaise).toBe(0n);
      // Net bank line = ₹40,000 − ₹800 = ₹39,200. The GROSS_UP portion is not this download's concern.
      expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(3920000));
    });
  });
});
