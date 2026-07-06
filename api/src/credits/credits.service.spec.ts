// Unit tests for CreditsService — ported from platform/src/app/api/admin/credits/*.
// Covers tenant scoping, batch confirm → payout-entry creation, the maker-checker
// reversal flow, payout-file generation, and the UTR upload parse/apply branches.
// Run: npx jest src/credits/credits.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
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
  },
  creditPayoutEntry: { createMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  creditPayoutDownload: { create: jest.fn(), update: jest.fn() },
  creditReversal: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
  outlet: { findFirst: jest.fn() },
  wallet: { findFirst: jest.fn(), upsert: jest.fn().mockResolvedValue({ id: 'w1' }) },
};

const mockPrisma = {
  creditBatch: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
  creditField: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  creditPayoutEntry: { findMany: jest.fn() },
  creditPayoutDownload: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  creditReversal: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  // Post-commit PUSH loop resolves each credited partner's userId to enqueue a WALLET_POINTS_EARNED push.
  // (Also resolves ownerName+phone for the deoleo_points_credit WhatsApp.)
  channelPartner: { findFirst: jest.fn() },
  // Post-commit points-credit WhatsApp reads the partner's redeemable balance AFTER the credit.
  wallet: { findFirst: jest.fn() },
  outlet: { findMany: jest.fn() },
  outletTypeClientConfig: { findMany: jest.fn() },
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

    // Default: partner resolves for the post-commit PUSH + WhatsApp; wallet balance read.
    mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'partnerUser1', ownerName: 'Ravi Traders', phone: '9900000041' });
    mockPrisma.wallet.findFirst.mockResolvedValue({ redeemablePoints: 500 });
    mockMsg91.sendWhatsappTemplate.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: Msg91Service, useValue: mockMsg91 },
        { provide: WalletService, useValue: mockWalletService },
        { provide: TenantSettingsService, useValue: mockTenantSettings },
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
      mockPrisma.creditBatch.count.mockResolvedValue(2);
      mockPrisma.creditBatch.create.mockResolvedValue({ id: 'b1' });
      const dto: CreateBatchDto = {
        period: '2026-05',
        totalOutlets: 1,
        totalPoints: 0,
        totalPayoutPaise: 10000,  // ₹100 in paise
        rows: [],
      };
      await service.createBatch(admin, dto);
      const data = mockPrisma.creditBatch.create.mock.calls[0][0].data;
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
        create: { partnerId: 'p1' },
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
        create: { partnerId: 'p1' },
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
      expect(mockTx.creditPayoutEntry.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
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
        mockPrisma.creditBatch.create.mockResolvedValue({ id: 'b1' });
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
        expect(mockPrisma.creditBatch.create).toHaveBeenCalledTimes(1);
      });

      it('ignores non-OK rows when checking caps', async () => {
        mockCreditsPayouts.safetyCapPoints = 50000;
        mockPrisma.creditBatch.create.mockResolvedValue({ id: 'b1' });
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
        mockPrisma.creditBatch.create.mockResolvedValue({ id: 'b1' });
        // Today = 28 June (== cutoff, still open); batch period = May.
        pinDate('2026-06-28T08:00:00.000Z');
        const dto = batchDto('2026-05', CreditAwardType.POINTS, 100);
        await expect(service.createBatch(admin, dto)).resolves.toBeDefined();
        expect(mockPrisma.creditBatch.create).toHaveBeenCalledTimes(1);
      });

      it('does NOT gate a CURRENT-month batch even after the cutoff day', async () => {
        mockCreditsPayouts.monthCutoffDay = 5;
        mockPrisma.creditBatch.create.mockResolvedValue({ id: 'b1' });
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
});
