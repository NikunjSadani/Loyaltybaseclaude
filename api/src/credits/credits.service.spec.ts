// Unit tests for CreditsService — ported from platform/src/app/api/admin/credits/*.
// Covers tenant scoping, batch confirm → payout-entry creation, the maker-checker
// reversal flow, payout-file generation, and the UTR upload parse/apply branches.
// Run: npx jest src/credits/credits.service.spec.ts

import * as heldApply from '../wallet/held-opening-balances/held-balance-apply';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as XLSX from 'xlsx';
import { CreditsService, POINTS_REVERSAL_ENGINE_MARKER_ENTITY } from './credits.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Msg91Service } from '../notifications/msg91.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { InvoicesService } from '../invoices/invoices.service';
import { TdsStatutoryConfigService } from '../tds/tds-statutory.config.service';
import { DEFAULT_RESOLVED_TDS_STATUTORY, financialYear } from '../tds/tds.helpers';

// Statutory resolver mock → the built-in code defaults, so the withholding math is identical
// to the pre-refactor hardcoded values these specs assert against.
const mockStatutory = { getForFy: jest.fn().mockResolvedValue(DEFAULT_RESOLVED_TDS_STATUTORY) };
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
import { RAISED_UNDER_OLD_ENGINE_MESSAGE, ReversalAttentionException, walletNotSequencedMessage } from '../wallet/reversal-policy';

// ─── Mock wallet service ──────────────────────────────────────────────────────

// Employee Rewards Phase 1 — the account dual-write helper has its own unit tests
// (reward-account.helper.spec.ts); stub it here so these tests aren't coupled to its
// internal channelPartner/rewardAccount tx calls. The service still writes accountId.
jest.mock('../common/reward-account.helper', () => ({
  ensureOutletAccount: jest.fn().mockResolvedValue('acc-x'),
}));

const mockWalletService = {
  creditEarn: jest.fn().mockResolvedValue({ transactionId: 'wt1', newRedeemable: 50, ledgerId: 'l1' }),
  // One engine (2026-11-21): the POINTS reversal cap = the credit positions of (batch, outlet, field). Default: one
  // position per stored POINTS row (all credited, nothing reversed yet). The safety gate lives inside it (wallet spec).
  v2PointsReversalCap: jest.fn(
    async (tx: { creditBatch: { findFirst: (a?: unknown) => Promise<{ rows?: any[] } | null> } }, a: { outletCode: string; fieldId: string }) => {
      const batch = await tx.creditBatch.findFirst();
      const positions = (batch?.rows ?? [])
        .filter((r) => r.outletId === a.outletCode && r.fieldId === a.fieldId && r.awardType === 'POINTS' && r.status === 'OK' && r.amount > 0)
        .map((r) => ({ amount: r.amount as number }));
      return { cap: positions.reduce((s, p) => s + p.amount, 0), positions, unallocatedApproved: 0 };
    },
  ),
  // Upload deductions: no deduction line by default (every credit reversal path below).
  findUploadDeductions: jest.fn().mockResolvedValue([]),
  uploadDeductionReadiness: jest.fn().mockResolvedValue([]),
  debitUploadDeduction: jest.fn(),
  undoUploadDeduction: jest.fn(),
  reverseCreditBatchPoints: jest.fn(async (_tx: unknown, a: { points: number }) => ({
    shortfall: 0, recovered: a.points, debtRestored: 0, owed: 0, alreadyExpired: 0, debtExposed: 0, balanceBelowZero: 0, walletIds: ['w1'],
  })),
};

// ─── Mock Prisma TX ───────────────────────────────────────────────────────────

const mockTx = {
  creditBatch: {
    update: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn(),
    // Wave 2: the sourced (direct-credit) create path reads findMany + supersedes via deleteMany in-tx.
    findMany: jest.fn().mockResolvedValue([]),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    // createBatch now generates the code + creates UNDER a per-(clientId, period) advisory lock in a tx.
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(),
  },
  creditPayoutEntry: { createMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
  // downloadCode is now generated INSIDE the download tx (tx.creditPayoutDownload.count) under PDLOCK.
  // uploadUtr writes the download status via a CONDITIONAL updateMany (status: { not: next }).
  creditPayoutDownload: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), count: jest.fn().mockResolvedValue(0) },
  creditReversal: {
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findFirst: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    // Over-reversal cap: live reversals for (batch, outlet, field) + reversal create in-tx.
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
  },
  // Row locks (SELECT … FOR UPDATE) — batch row for the reversal cap.
  $queryRaw: jest.fn().mockResolvedValue([]),
  // FIX-8: the visibility TDS plan now reads INSIDE the download $transaction (tx), so the
  // cross-tenant PAN aggregation runs behind the per-PAN advisory lock (tx.$executeRaw).
  outlet: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  channelPartner: { findMany: jest.fn().mockResolvedValue([]) },
  wallet: { findFirst: jest.fn(), upsert: jest.fn().mockResolvedValue({ id: 'w1' }) },
  // Visibility-payout TDS read + write targets (atomic with the download / confirm).
  tdsDeductionEntry: { createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  tdsRecoveryEntry: { createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  // Policy round B: no TDS credits on these fixtures → every path behaves exactly as before.
  tdsCredit: { findMany: jest.fn().mockResolvedValue([]) },
  tdsCreditApplication: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() },
  autoInvoice: { updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  // 194R whole-year true-up: the SHARED base read (tds-194r.shared collect194RBases) runs on the tx.
  creditField: { findMany: jest.fn().mockResolvedValue([]) },
  redemptionOrder: { findMany: jest.fn().mockResolvedValue([]) },
  tdsOffPlatformEntry: { findMany: jest.fn().mockResolvedValue([]) },
  // FIX-8 advisory lock — pg_advisory_xact_lock(hashtextextended(...)).
  $executeRaw: jest.fn().mockResolvedValue(0),
  // WP5: engine PAYOUT allocations (approve/reject + download race check read them; every PAYOUT create reserves).
  payoutReversalAllocation: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn().mockResolvedValue({ count: 1 }) },
  // findFirst: the audit-A1 one-engine marker of a POINTS reversal (default: present = raised under the one engine)
  auditLog: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue({ id: 'marker' }) },
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
  outletType: { findMany: jest.fn() },
  outletTypeClientConfig: { findMany: jest.fn() },
  // Visibility-payout TDS reads (cross-tenant PAN aggregation + carry-forward + one-per-PAN/FY).
  tdsDeductionEntry: { findMany: jest.fn() },
  autoInvoice: { findMany: jest.fn() },
  // D9: the imported-payouts countFrom read (only for a download carrying 194R entries).
  programSetting: { findUnique: jest.fn().mockResolvedValue(null) },
  // WP5: listReversals attaches engine PAYOUT allocations — none on a LEGACY tenant.
  payoutReversalAllocation: { findMany: jest.fn().mockResolvedValue([]) },
  // HELD OPENING BALANCES pre-confirm step: no PENDING rows on these fixtures → dormant (one count).
  heldOpeningBalance: { count: jest.fn().mockResolvedValue(0) },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown, _opts?: { timeout?: number; maxWait?: number }) => cb(mockTx)),
};

const mockNotifications = {
  enqueue: jest.fn().mockResolvedValue({ id: 'n1' }),
  writeInApp: jest.fn().mockResolvedValue({ id: 'n1' }),
  notifyUser: jest.fn().mockResolvedValue(undefined),
  notifyUserWithChannels: jest.fn().mockResolvedValue(undefined),
};

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
  // (No reversal-engine mode reader: the mode is retired — one engine for every tenant.)
  // Policy round A Q5: POINTS reversal approvals pause switch (absent row → not paused).
  getPointsReversalPauseUncached: jest.fn(async () => ({ paused: false, since: null, by: null, reason: null })),
  // Upload deductions switch (UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md) — OFF unless a test turns it on.
  getCreditUploadNegativeDeductionsUncached: jest.fn(async () => false),
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

/** Every advisory-lock key taken via tx.$executeRaw (A-M3: one statement over a key ARRAY). */
function lockKeysTaken(): string[] {
  return mockTx.$executeRaw.mock.calls
    .filter((c: unknown[]) => String((c[0] as string[]).join('?')).includes('pg_advisory_xact_lock'))
    .flatMap((c: unknown[]) => {
    const v = c[1];
    return Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? [v] : [];
    });
}

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
    // Stored rows give the reversal cap something to check against: O1/f1 credited generously
    // for both award types, so the legacy reversal tests are unaffected by the cap.
    mockTx.creditBatch.findFirst.mockResolvedValue({
      id: 'b1',
      status: 'CONFIRMED',
      rows: [
        { outletId: 'O1', fieldId: 'f1', awardType: 'PAYOUT', status: 'OK', amount: 100_000_000 },
        { outletId: 'O1', fieldId: 'f1', awardType: 'POINTS', status: 'OK', amount: 1_000_000 },
      ],
    });
    mockTx.creditReversal.findMany.mockResolvedValue([]);
    mockTx.auditLog.findFirst.mockResolvedValue({ id: 'marker' });
    mockTx.$queryRaw.mockResolvedValue([]);
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
    // The confirm's acknowledgement check (computed inside the tx, audit #5) resolves the batch's POINTS outlets: by
    // default every asked-for code is a linked outlet (nothing to acknowledge); other outlet reads get [] as before.
    mockTx.outlet.findMany.mockImplementation(async (a?: { where?: { outletCode?: { in?: string[] } } }) =>
      (a?.where?.outletCode?.in ?? []).map((outletCode) => ({ outletCode, partnerId: 'p1' })),
    );
    mockTx.channelPartner.findMany.mockResolvedValue([]);
    mockTx.tdsDeductionEntry.findMany.mockResolvedValue([]);
    mockTx.tdsRecoveryEntry.findMany.mockResolvedValue([]);
    mockTx.autoInvoice.findMany.mockResolvedValue([]);
    mockTx.creditField.findMany.mockResolvedValue([]);
    mockTx.redemptionOrder.findMany.mockResolvedValue([]);
    mockTx.tdsOffPlatformEntry.findMany.mockResolvedValue([]);
    mockPrisma.programSetting.findUnique.mockResolvedValue(null);
    mockTx.$executeRaw.mockResolvedValue(0);

    // Default: outlet lookups (uploadUtr resolves per-outlet bank accounts for the same-account
    // shared-UTR rule before the tx; createPayoutDownload/uploadUtr tests override per case).
    // Confirm's acknowledgement check (owner rule 2026-11-25) resolves the batch's POINTS outlets: by default every
    // asked-for code is a linked outlet (nothing to acknowledge); other outlet reads get [] as before.
    mockPrisma.outlet.findMany.mockImplementation(async (a?: { where?: { outletCode?: { in?: string[] } } }) =>
      (a?.where?.outletCode?.in ?? []).map((outletCode) => ({ outletCode, partnerId: 'p1' })),
    );
    // Default: no per-tenant outlet-type displayName (eligibleOutlets loads this) → empty map →
    // eligibleOutlets `type` falls back to outletType.code (Deoleo parity). Overridden per case.
    mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([]);
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
        { provide: TdsStatutoryConfigService, useValue: mockStatutory },
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

  // The award editor's outlet-type list MUST mirror GifsyService.getOutletTypeConfigs'
  // DEFAULT-ON semantics: an active outlet type is enabled unless a SAVED client config
  // row disables it. Regression guard for the "console shows enabled, editor shows none" bug.
  describe('listOutletTypes', () => {
    const RETAIL = { id: 'ot-retail', code: 'RETAIL', name: 'Retail', isActive: true };
    const WHOLESALE = { id: 'ot-wholesale', code: 'WHOLESALE', name: 'Wholesale', isActive: true };

    it('INCLUDES an active outlet type with NO config row (default-on)', async () => {
      mockPrisma.outletType.findMany.mockResolvedValue([RETAIL]);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([]); // no saved rows
      const res = await service.listOutletTypes(admin);
      expect(res).toEqual([{ code: 'RETAIL', label: 'Retail' }]);
    });

    it('INCLUDES an active type with a saved isEnabled=true row, using displayName when set', async () => {
      mockPrisma.outletType.findMany.mockResolvedValue([RETAIL]);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletTypeId: 'ot-retail', isEnabled: true, displayName: 'Retail Stores' },
      ]);
      const res = await service.listOutletTypes(admin);
      expect(res).toEqual([{ code: 'RETAIL', label: 'Retail Stores' }]);
    });

    it('falls back to the outlet type name when the saved row has a null displayName', async () => {
      mockPrisma.outletType.findMany.mockResolvedValue([RETAIL]);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletTypeId: 'ot-retail', isEnabled: true, displayName: null },
      ]);
      const res = await service.listOutletTypes(admin);
      expect(res).toEqual([{ code: 'RETAIL', label: 'Retail' }]);
    });

    it('EXCLUDES an active type whose saved row sets isEnabled=false', async () => {
      mockPrisma.outletType.findMany.mockResolvedValue([RETAIL, WHOLESALE]);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletTypeId: 'ot-wholesale', isEnabled: false, displayName: null },
      ]);
      const res = await service.listOutletTypes(admin);
      // RETAIL default-on (no row) stays; WHOLESALE explicitly disabled drops.
      expect(res).toEqual([{ code: 'RETAIL', label: 'Retail' }]);
    });

    it('EXCLUDES an inactive outlet type even when a saved enabled row exists', async () => {
      // Inactive types are filtered by the outletType.findMany({ isActive: true }) query itself,
      // so a stale config row for an inactive type can never resurface it.
      mockPrisma.outletType.findMany.mockResolvedValue([RETAIL]); // WHOLESALE inactive → not returned
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletTypeId: 'ot-wholesale', isEnabled: true, displayName: 'Wholesale' },
      ]);
      const res = await service.listOutletTypes(admin);
      expect(res).toEqual([{ code: 'RETAIL', label: 'Retail' }]);
      // Assert the isActive filter is what enforces this.
      expect(mockPrisma.outletType.findMany.mock.calls[0][0]).toEqual({
        where: { isActive: true },
      });
    });

    it('is tenant-scoped: the config lookup is filtered by the caller clientId', async () => {
      mockPrisma.outletType.findMany.mockResolvedValue([RETAIL]);
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([]);
      await service.listOutletTypes(admin);
      expect(mockPrisma.outletTypeClientConfig.findMany.mock.calls[0][0]).toEqual({
        where: { clientId: 'deoleo' },
      });
    });

    it('sorts the returned types by code', async () => {
      mockPrisma.outletType.findMany.mockResolvedValue([WHOLESALE, RETAIL]); // unsorted input
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([]);
      const res = await service.listOutletTypes(admin);
      expect(res.map((r) => r.code)).toEqual(['RETAIL', 'WHOLESALE']);
    });
  });

  describe('createBatch — upload deductions (negative POINTS, tenant switch)', () => {
    const row = (o: Partial<Record<string, unknown>>) => ({
      rowNum: 3, outletId: 'O1', outletName: 'Outlet 1', fieldId: 'f1', fieldName: 'Target', amount: 100,
      narration: '', awardType: 'POINTS', status: 'OK', errors: [], ...o,
    });
    const dto = (rows: unknown[]): CreateBatchDto =>
      ({ period: '2026-05', totalOutlets: 1, totalPoints: 0, totalPayoutPaise: 0, rows }) as unknown as CreateBatchDto;
    beforeEach(() => {
      mockTx.creditBatch.count.mockResolvedValue(0);
      mockTx.creditBatch.create.mockResolvedValue({ id: 'b-new' });
      mockCreditsPayouts.safetyCapPoints = 500;
    });
    afterEach(() => mockTenantSettings.getCreditUploadNegativeDeductionsUncached.mockResolvedValue(false));

    it('a batch without negative values never reads the switch (byte-identical for every tenant)', async () => {
      await service.createBatch(admin, dto([row({})]));
      expect(mockTenantSettings.getCreditUploadNegativeDeductionsUncached).not.toHaveBeenCalled();
    });

    it('D1 (every tenant) — switch OFF (Deoleo): a negative POINTS row is refused; a negative typed amount keeps the old 400', async () => {
      await expect(service.createBatch(admin, dto([row({ amount: -50 })]))).rejects.toThrow(
        'Deductions are switched off for this client — remove the negative rows or ask Gifsy. Row for Outlet 1 (O1) / field "Target" has -50 points.',
      );
      await expect(service.createBatch(admin, dto([row({ amount: 5, originalAmount: -5 })]))).rejects.toThrow(
        'originalAmount must not be less than 0',
      );
      expect(mockTx.creditBatch.create).not.toHaveBeenCalled();
    });

    it.each([
      ['an OK PAYOUT row below zero', { awardType: 'PAYOUT', amount: -10000 }, /^Payout amounts can't be negative — use Reverse on Payout Status\. Row for Outlet 1 \(O1\)/],
      ['an OK row of amount 0 (POINTS)', { amount: 0 }, /is marked OK but its amount is 0/],
      ['an OK row of amount 0 (PAYOUT)', { awardType: 'PAYOUT', amount: 0 }, /is marked OK but its amount is 0/],
    ])('D1 (every tenant, switch OFF): %s is refused at create', async (_n, o, msg) => {
      await expect(service.createBatch(admin, dto([row(o)]))).rejects.toThrow(msg);
      expect(mockTx.creditBatch.create).not.toHaveBeenCalled();
      expect(mockTenantSettings.getCreditUploadNegativeDeductionsUncached).not.toHaveBeenCalled();
    });

    it('switch ON: a deduction within the cap (magnitude) is accepted, with its negative typed amount', async () => {
      mockTenantSettings.getCreditUploadNegativeDeductionsUncached.mockResolvedValue(true);
      await service.createBatch(admin, dto([row({ amount: -200, originalAmount: -199.5 })]));
      expect(mockTx.creditBatch.create).toHaveBeenCalled();
    });

    it('switch ON: the magnitude counts against the points cap', async () => {
      mockTenantSettings.getCreditUploadNegativeDeductionsUncached.mockResolvedValue(true);
      await expect(service.createBatch(admin, dto([row({ amount: -501 })]))).rejects.toThrow(
        'Row for Outlet 1 (O1) / field "Target" deducts 501 points, exceeding the safety cap of 500 points.',
      );
      expect(mockTx.creditBatch.create).not.toHaveBeenCalled();
    });

    it('switch ON: a negative PAYOUT row is refused — deduct via Reversals', async () => {
      mockTenantSettings.getCreditUploadNegativeDeductionsUncached.mockResolvedValue(true);
      await expect(service.createBatch(admin, dto([row({ awardType: 'PAYOUT', amount: -10000 })]))).rejects.toThrow(
        /^Payout amounts can't be negative — use Reverse on Payout Status\./,
      );
    });

    it('switch ON: one (outlet, field) cannot be both a credit and a deduction', async () => {
      mockTenantSettings.getCreditUploadNegativeDeductionsUncached.mockResolvedValue(true);
      await expect(service.createBatch(admin, dto([row({ amount: 100 }), row({ amount: -40 })]))).rejects.toThrow(
        /both a credit and a deduction/,
      );
      // a different field of the same outlet is fine
      await service.createBatch(admin, dto([row({ amount: 100 }), row({ fieldId: 'f2', amount: -40 })]));
      expect(mockTx.creditBatch.create).toHaveBeenCalledTimes(1);
    });

    it('upload preview (every tenant): outlets for a switch-OFF tenant, no repeat lookup; says whether deductions are on', async () => {
      const outlets = [{ outletCode: 'O1', found: true, linked: true, walletId: 'w1', partnerId: 'p1', balance: 100, heldOpeningBalance: null, ready: true, reason: null, code: null }];
      mockWalletService.uploadDeductionReadiness.mockResolvedValueOnce(outlets);
      await expect(service.uploadPreview(admin, { outletCodes: ['O1'], period: '2026-05', lines: [] })).resolves.toEqual({
        deductionsEnabled: false, ackCategories: ['SKIPPED', 'ROUNDED', 'NOT_APPLIED', 'BELOW_ZERO', 'REPEAT_DEDUCTION'], outlets, priorDeductions: [],
      });
      expect(mockWalletService.uploadDeductionReadiness).toHaveBeenCalledWith('deoleo', ['O1']);
    });

    it('switch ON: a negative typed amount on a positive row is refused', async () => {
      mockTenantSettings.getCreditUploadNegativeDeductionsUncached.mockResolvedValue(true);
      await expect(service.createBatch(admin, dto([row({ fieldId: 'f2', amount: -5 }), row({ amount: 5, originalAmount: -5 })]))).rejects.toThrow(
        /originalAmount must not be less than 0/,
      );
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

    // ── Wave 2 (Option A, 2026-10-03): programmatic (direct-credit) source path — idempotency only ──
    // Cross-batch/cross-path overlap is NOT blocked here (platform-consistent: multiple batches per period
    // are allowed, as for manual uploads; overlap is warned by commitCompute + gated by the confirm step).
    const srcDto: CreateBatchDto = {
      period: '2026-05', totalOutlets: 1, totalPoints: 200, totalPayoutPaise: 0, rows: [],
    };

    it('source: returns the existing batch unchanged when the identical run already has one (idempotent)', async () => {
      mockTx.creditBatch.findFirst.mockResolvedValueOnce({ id: 'existing', batchCode: 'CB-2026-05-001', status: 'PENDING_CONFIRM', sourceKey: 'pe_k1' });
      const res = await service.createBatch(admin, srcDto, { kind: 'POINTS_ENGINE', key: 'pe_k1' });
      expect(res.id).toBe('existing');
      expect(mockTx.creditBatch.create).not.toHaveBeenCalled();   // no second batch for the SAME run → no double-credit
    });

    it('source: a DIFFERENT run creates a new batch even when a CONFIRMED engine batch already exists for the period (Option A — not blocked)', async () => {
      // Only the sameRun (sourceKey) lookup runs now; a non-matching key → create. (A confirmed prior batch
      // for the period is NOT queried/blocked; overlap is operator-governed + warned, like manual uploads.)
      mockTx.creditBatch.findFirst.mockResolvedValueOnce(null); // no same-key batch
      mockTx.creditBatch.create.mockResolvedValue({ id: 'new2', sourceKey: 'pe_k2' });
      const res = await service.createBatch(admin, srcDto, { kind: 'POINTS_ENGINE', key: 'pe_k2' });
      const data = mockTx.creditBatch.create.mock.calls[0][0].data;
      expect(data.sourceKind).toBe('POINTS_ENGINE');
      expect(data.sourceKey).toBe('pe_k2');
      expect(res.id).toBe('new2');
      expect(mockTx.creditBatch.deleteMany).not.toHaveBeenCalled(); // no supersede-delete anymore
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
          // Identifies the EXACT credit for a later per-(batch, outlet, field) reversal.
          metadata: { fieldId: 'f1', outletCode: 'O1' },
          // No reversalEngineMode: the engine mode is retired (one engine for every tenant).
        },
        mockTx,   // same tx — atomicity guaranteed
      );
      // B9 for EVERY tenant (Deoleo included): the target wallets are row-locked up front in ascending id order…
      const sqlOf = (c: unknown[]) => (c[0] as string[]).join('?');
      const raws = mockTx.$queryRaw.mock.calls.map(sqlOf);
      expect(raws.some((s) => s.includes('FOR UPDATE OF w') && s.includes('ORDER BY w."id"'))).toBe(true);
      // …and no reversal-engine advisory lock / mode read is taken any more.
      expect(raws.some((s) => s.includes('pg_advisory_xact_lock_shared'))).toBe(false);
      // The points-credit fan-out carries the WALLET_POINTS_EARNED event + the /partner/wallet
      // deep-link (IN_APP + PUSH are written inside notifyUserWithChannels).
      expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: 'POINTS_CREDITED',
          event: 'WALLET_POINTS_EARNED',
          url: '/partner/wallet',
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
      mockTx.outlet.findMany.mockImplementation(async () => [{ outletCode: 'O1', partnerId: null }]);

      // owner rule (no silent failure): the row that won't be applied must be acknowledged first
      await expect(service.confirmBatch(admin, 'b1')).rejects.toThrow(/reload the page and tick: rows that will not be applied/);
      // the tick binds to the exact row (U1 round 3)
      await expect(service.confirmBatch(admin, 'b1', { acknowledged: ['NOT_APPLIED'] })).rejects.toThrow(/reload the page and tick/);
      const res = await service.confirmBatch(admin, 'b1', { acknowledged: ['NOT_APPLIED'], ackItems: { NOT_APPLIED: ['O1|f1'] } });

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

    it('HELD OPENING BALANCES: the pre-step runs BEFORE the confirm transaction; a not-posted held balance REFUSES the confirm (nothing credited)', async () => {
      const batch = {
        id: 'b1', status: 'PENDING_CONFIRM', period: '2026-05', uploadedBy: 'admin1', totalOutlets: 1, totalPoints: 50,
        totalPayoutPaise: BigInt(0),
        rows: [{ outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'Sales', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' }],
      };
      mockPrisma.creditBatch.findFirst.mockResolvedValue(batch);
      mockTx.outlet.findFirst.mockResolvedValue({ partnerId: 'p1' });
      const order: string[] = [];
      const realTx = mockPrisma.$transaction.getMockImplementation()!;
      mockPrisma.$transaction.mockImplementation(async (cb: any, o?: any) => {
        order.push('confirm-tx');
        return realTx(cb, o);
      });
      const spy = jest.spyOn(heldApply, 'prepareHeldBeforeCredit');
      try {
        // (1) the held balance did not post → 409, nothing credited, no confirm transaction at all
        spy.mockImplementationOnce(async (db, a) => {
          order.push('held-pre-step');
          expect(db).toBe(mockPrisma);
          expect(a).toEqual(expect.objectContaining({ clientId: admin.clientId, outletCodes: ['O1'] }));
          return { outcomes: [], blocking: [{ outletCode: 'O1', reason: 'held opening balance not posted yet' }] };
        });
        await expect(service.confirmBatch(admin, 'b1')).rejects.toThrow(/Held opening balance must post first — 1 outlet\(s\).*O1 \(held opening balance not posted yet\).*Nothing was credited/);
        expect(order).toEqual(['held-pre-step']);
        expect(mockWalletService.creditEarn).not.toHaveBeenCalled();
        // (2) the check itself errored → also refused (never credit blind)
        spy.mockImplementationOnce(async () => { throw new Error('db down'); });
        await expect(service.confirmBatch(admin, 'b1')).rejects.toThrow(/Held opening balance must post first — the check could not run \(db down\)/);
        expect(mockWalletService.creditEarn).not.toHaveBeenCalled();
        // (3) posted (or nothing held) → the confirm runs; soft-deleted outlets never receive credits
        order.length = 0;
        spy.mockImplementationOnce(async () => { order.push('held-pre-step'); return { outcomes: [], blocking: [] }; });
        const res = await service.confirmBatch(admin, 'b1');
        expect(res.pointsCredited).toBe(1);
        expect(order[0]).toBe('held-pre-step');
        expect(order).toContain('confirm-tx');
        expect(mockTx.outlet.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ deletedAt: null }) }));
      } finally {
        spy.mockRestore();
        mockPrisma.$transaction.mockImplementation(realTx);
      }
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

        // Config-driven POINTS_CREDITED fan-out to the owner; the mapped vars reproduce the
        // deoleo_points_credit body order [ownerName, points, redeemableBalance, month, date].
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
        const call = mockNotifications.notifyUserWithChannels.mock.calls[0][0];
        expect(call.eventKey).toBe('POINTS_CREDITED');
        expect(call.recipientPhone).toBe('9900000041');
        expect(call.vars).toMatchObject({
          ownerName: 'Ravi Traders',
          pointsCredited: 50,
          redeemableBalance: 500,
          monthYear: 'July 2026',
          dateCredited: '06 Jul 2026',
        });
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
      mockNotifications.notifyUserWithChannels.mockRejectedValueOnce(new Error('MSG91 down'));

      const res = await service.confirmBatch(admin, 'b1');
      expect(res.pointsCredited).toBe(1);
    });

    it('routes the points-credit fan-out with a null recipient phone when the partner has no phone (resolver then skips paid)', async () => {
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
      // The fan-out is still invoked, but with a null recipient phone → the resolver skips paid channels.
      const call = mockNotifications.notifyUserWithChannels.mock.calls[0][0];
      expect(call.eventKey).toBe('POINTS_CREDITED');
      expect(call.recipientPhone).toBeNull();
    });

    it('a mid-batch partner LOOKUP failure isolates to that partner — the rest are still notified', async () => {
      // Two credited partners; the per-partner channelPartner.findFirst THROWS for the first.
      // Without the per-iteration try/catch that throw would abort the whole loop and starve the
      // second partner of its notification. It must skip only the failing partner.
      mockPrisma.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'PENDING_CONFIRM',
        period: '2026-07',
        uploadedBy: 'admin1',
        totalOutlets: 2,
        totalPoints: 100,
        totalPayoutPaise: BigInt(0),
        rows: [
          { outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'Sales', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
          { outletId: 'O2', outletName: 'B', fieldId: 'f1', fieldName: 'Sales', amount: 50, narration: '', awardType: 'POINTS', status: 'OK' },
        ],
      });
      // Each row resolves to a DISTINCT partner so creditedByPartner has two entries.
      mockTx.outlet.findFirst
        .mockResolvedValueOnce({ partnerId: 'p1' })
        .mockResolvedValueOnce({ partnerId: 'p2' });
      // First partner lookup throws; second succeeds.
      mockPrisma.channelPartner.findFirst
        .mockRejectedValueOnce(new Error('lookup boom'))
        .mockResolvedValueOnce({ userId: 'u2', ownerName: 'Second Trader', phone: '9900000002' });

      const res = await service.confirmBatch(admin, 'b1');

      // Batch still fully confirmed (notifications are post-commit + best-effort).
      expect(res.pointsCredited).toBe(2);
      // Exactly ONE partner (the survivor) was notified — the failing partner was skipped, not fatal.
      expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
      expect(mockNotifications.notifyUserWithChannels.mock.calls[0][0].vars.ownerName).toBe('Second Trader');
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
      mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r-existing' });
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.PAYOUT, originalPaise: 10000, requestedPaise: 5000,
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockTx.creditReversal.create).not.toHaveBeenCalled();
    });

    it('creates the reversal scoped to tenant + requester; originalPaise is SERVER-derived from the stored batch rows', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockTx.creditBatch.findFirst.mockResolvedValue({
        id: 'b1',
        rows: [
          { outletId: 'O1', fieldId: 'f1', awardType: 'PAYOUT', status: 'OK', amount: 10000 },
          { outletId: 'O1', fieldId: 'f2', awardType: 'PAYOUT', status: 'OK', amount: 99999 }, // other field
          { outletId: 'O2', fieldId: 'f1', awardType: 'PAYOUT', status: 'OK', amount: 99999 }, // other outlet
          { outletId: 'O1', fieldId: 'f1', awardType: 'PAYOUT', status: 'ERROR', amount: 99999 }, // not credited
        ],
      });
      mockTx.creditReversal.findFirst.mockResolvedValue(null);
      mockTx.creditReversal.create.mockResolvedValue({ id: 'r1' });
      // Every PAYOUT reversal names its whole entries: the ₹50 request selects the one ₹50 payout entry of this batch.
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'pe1', status: 'PENDING', amountPaise: 5000n, period: '2026-05', createdAt: new Date('2026-06-01'), tdsDeductedPaise: 0n, tdsSection: null, outletId: 'O1', fieldId: 'f1' },
      ]);
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.PAYOUT, originalPaise: 10000, requestedPaise: 5000, payoutEntryIds: ['pe1'],
      };
      await service.createReversal(admin, 'b1', dto);
      // …and reserves it for this reversal.
      expect(mockTx.payoutReversalAllocation.createMany).toHaveBeenCalledWith({
        data: [{ creditReversalId: 'r1', payoutEntryId: 'pe1', amountPaise: 5000n, state: 'RESERVED' }],
      });
      // The batch row is locked before the cap is evaluated.
      expect(mockTx.$queryRaw).toHaveBeenCalled();
      const data = mockTx.creditReversal.create.mock.calls[0][0].data;
      expect(data.clientId).toBe('deoleo');
      expect(data.requestedBy).toBe('admin1');
      expect(data.period).toBe('2026-05');
      // BigInt writes
      expect(data.originalPaise).toBe(BigInt(10000));
      expect(data.requestedPaise).toBe(BigInt(5000));
    });

    it('ignores an inflated client originalPaise — cap is the stored credited amount', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockTx.creditBatch.findFirst.mockResolvedValue({
        id: 'b1', rows: [{ outletId: 'O1', fieldId: 'f1', awardType: 'POINTS', status: 'OK', amount: 300 }],
      });
      mockTx.creditReversal.findFirst.mockResolvedValue(null);
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.POINTS, originalPaise: 5000, requestedPaise: 400, // only 300 was credited
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(mockTx.creditReversal.create).not.toHaveBeenCalled();
    });

    it('refuses a SECOND reversal of an already-approved credit (double clawback)', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockTx.creditBatch.findFirst.mockResolvedValue({
        id: 'b1', rows: [{ outletId: 'O1', fieldId: 'f1', awardType: 'POINTS', status: 'OK', amount: 300 }],
      });
      mockTx.creditReversal.findFirst.mockResolvedValue(null); // no PENDING one…
      // …but the credit position already carries the 300 approved earlier (ρ = amount → nothing reversible).
      mockWalletService.v2PointsReversalCap.mockResolvedValueOnce({ cap: 0, positions: [{ amount: 300 }], unallocatedApproved: 0 });
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.POINTS, originalPaise: 300, requestedPaise: 300,
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toThrow(/exceeds the amount still reversible/);
      expect(mockTx.creditReversal.create).not.toHaveBeenCalled();
    });

    it('allows a second PARTIAL reversal while Σ stays within the credited amount', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockTx.creditBatch.findFirst.mockResolvedValue({
        id: 'b1', rows: [{ outletId: 'O1', fieldId: 'f1', awardType: 'POINTS', status: 'OK', amount: 300 }],
      });
      mockTx.creditReversal.findFirst.mockResolvedValue(null);
      // 100 of the 300 was approved earlier (ρ = 100) → 200 still reversible.
      mockWalletService.v2PointsReversalCap.mockResolvedValueOnce({ cap: 200, positions: [{ amount: 300 }], unallocatedApproved: 0 });
      mockTx.creditReversal.create.mockResolvedValue({ id: 'r2' });
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.POINTS, originalPaise: 300, requestedPaise: 200,
      };
      await service.createReversal(admin, 'b1', dto);
      expect(mockTx.creditReversal.create).toHaveBeenCalledTimes(1);
      // originalPaise = Σ position amount (what wallets actually received)
      expect(mockTx.creditReversal.create.mock.calls[0][0].data.originalPaise).toBe(300n);
      // The pending-sum query covers PENDING POINTS reversals of this exact key.
      expect(mockTx.creditReversal.findMany.mock.calls[0][0].where).toMatchObject({
        batchId: 'b1', outletId: 'O1', fieldId: 'f1', awardType: 'POINTS', status: 'PENDING_GIFSY',
      });
    });

    it('POINTS cap = the credit positions: a row nobody received (no position) can never be reversed', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockTx.creditReversal.findFirst.mockResolvedValue(null);
      mockWalletService.v2PointsReversalCap.mockRejectedValueOnce(
        new BadRequestException('Cannot reverse: no wallet received a credit from batch b1 for outlet O1 / field f1 — settle it off-platform'),
      );
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.POINTS, originalPaise: 300, requestedPaise: 100,
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toThrow(/no wallet received a credit/);
      expect(mockWalletService.v2PointsReversalCap).toHaveBeenCalledWith(
        mockTx,
        { batchId: 'b1', outletCode: 'O1', fieldId: 'f1' },
      );
      expect(mockTx.creditReversal.create).not.toHaveBeenCalled();
    });

    it('SAFETY GATE: a receiving wallet with un-sequenced history → 409 WALLET_NOT_SEQUENCED, nothing created, refusal audited (CREATE)', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockTx.creditReversal.findFirst.mockResolvedValue(null);
      const msg = walletNotSequencedMessage('O1', 'Bajaj Consumer Care Ltd');
      mockWalletService.v2PointsReversalCap.mockRejectedValueOnce(
        new ReversalAttentionException('WALLET_NOT_SEQUENCED', msg, {
          batchId: 'b1', outletCode: 'O1', fieldId: 'f1', walletId: 'w9', clientId: 'bajaj', clientName: 'Bajaj Consumer Care Ltd',
        }),
      );
      (mockPrisma as any).auditLog = { create: jest.fn().mockResolvedValue({}) };
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.POINTS, originalPaise: 300, requestedPaise: 100,
      };
      const err = await service.createReversal(admin, 'b1', dto).catch((e) => e);
      expect(err).toBeInstanceOf(ReversalAttentionException);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.code).toBe('WALLET_NOT_SEQUENCED');
      expect(err.message).toBe(msg);
      // B1: the client's display name + the exact next step (dry run, then APPLY) + where the steps are
      expect(err.message).toMatch(/outlet O1 \(Bajaj Consumer Care Ltd\)/);
      expect(err.message).toMatch(/dry run, then APPLY/);
      expect(err.message).toMatch(/BAJAJ-PROD-FOLLOWUPS-RUNBOOK §C/);
      expect(mockTx.creditReversal.create).not.toHaveBeenCalled();
      // …and no one-engine marker (nothing was created)
      expect(mockTx.auditLog.create).not.toHaveBeenCalled();
      // the refusal is audited AFTER the rolled-back tx, on the service's own client
      expect((mockPrisma as any).auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'REJECT',
          entityType: 'REVERSAL_ENGINE_REFUSAL',
          entityId: 'b1',
          // the wallet's tenant (from the refusal detail) — in real use always the requester's own tenant
          metadata: expect.objectContaining({ phase: 'CREATE', code: 'WALLET_NOT_SEQUENCED', walletId: 'w9', clientId: 'bajaj', clientName: 'Bajaj Consumer Care Ltd' }),
        }),
      });
      delete (mockPrisma as any).auditLog;
    });

    it('POINTS create never reads a reversal-engine setting (the mode is retired)', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockTx.creditReversal.findFirst.mockResolvedValue(null);
      mockTx.creditReversal.create.mockResolvedValue({ id: 'r3' });
      (mockTenantSettings as any).getReversalEngineModeUncached = jest.fn(() => {
        throw new Error('the retired engine mode must never be read');
      });
      try {
        await service.createReversal(admin, 'b1', {
          outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
          awardType: CreditAwardType.POINTS, originalPaise: 300, requestedPaise: 100,
        });
        expect((mockTenantSettings as any).getReversalEngineModeUncached).not.toHaveBeenCalled();
        expect(mockTx.creditReversal.create).toHaveBeenCalledTimes(1);
      } finally {
        delete (mockTenantSettings as any).getReversalEngineModeUncached;
      }
    });

    it('POINTS cap message uses pts', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockTx.creditBatch.findFirst.mockResolvedValue({
        id: 'b1', rows: [{ outletId: 'O1', fieldId: 'f1', awardType: 'POINTS', status: 'OK', amount: 300 }],
      });
      mockTx.creditReversal.findFirst.mockResolvedValue(null);
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.POINTS, originalPaise: 500, requestedPaise: 400, // client-inflated original
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toThrow(
        'credited 300 pts, already reversed 0 pts, pending 0 pts, requested 400 pts',
      );
    });

    it('translates a DB P2002 (pending-reversal unique index) into a clean 400', async () => {
      // The fast-path pre-check passes (no existing pending), but a concurrent
      // request already inserted one — the partial-unique index
      // `credit_reversals_pending_unique` rejects with P2002.
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockTx.creditReversal.findFirst.mockResolvedValue(null);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
      mockTx.creditReversal.create.mockRejectedValue(p2002);
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'pe1', status: 'PENDING', amountPaise: 5000n, period: '2026-05', createdAt: new Date('2026-06-01'), tdsDeductedPaise: 0n, tdsSection: null, outletId: 'O1', fieldId: 'f1' },
      ]);
      const dto: CreateReversalDto = {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.PAYOUT, originalPaise: 10000, requestedPaise: 5000, payoutEntryIds: ['pe1'],
      };
      await expect(service.createReversal(admin, 'b1', dto)).rejects.toThrow(/pending reversal already exists/);
    });
  });

  describe('patchReversal (checker approve/reject)', () => {
    // A POINTS approve re-reads THIS reversal row under its lock (SELECT status … FOR UPDATE) — still pending.
    const stillPending = () =>
      mockTx.$queryRaw.mockImplementation(async (s: unknown) => {
        // a tagged template (strings array) or a Prisma.sql object
        const text = Array.isArray(s) ? s.join('?') : String((s as { sql?: string })?.sql ?? '');
        return text.includes('FROM credit_reversals') ? [{ status: 'PENDING_GIFSY' }] : [];
      });

    it('rejects a reversal that is not PENDING_GIFSY', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'APPROVED', requestedPaise: BigInt(10000), awardType: 'POINTS', outletId: 'O1', fieldId: 'f1' });
      await expect(
        service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marks PARTIAL when approved amount is below requested (POINTS)', async () => {
      // requestedPaise stored as BigInt in Prisma (whole points for POINTS reversals)
      mockPrisma.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'PENDING_GIFSY', requestedPaise: BigInt(100), awardType: 'POINTS', outletId: 'O1', fieldId: 'f1', batchId: 'b1' });
      // tx.creditReversal.findFirst returns the updated row
      mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'PARTIAL' });

      stillPending();
      const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 40 });
      expect(res).toMatchObject({ id: 'r1', status: 'PARTIAL' });

      const updateManyCall = mockTx.creditReversal.updateMany.mock.calls[0][0];
      expect(updateManyCall.data.status).toBe('PARTIAL');
      // approvedPaise written as BigInt
      expect(updateManyCall.data.approvedPaise).toBe(BigInt(40));
      expect(mockWalletService.reverseCreditBatchPoints).toHaveBeenCalledWith(mockTx, expect.objectContaining({ points: 40 }));
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
      expect(mockWalletService.reverseCreditBatchPoints).not.toHaveBeenCalled();
    });

    it('a POINTS approval goes to the position engine (reverseCreditBatchPoints) — the one engine for every tenant', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r1',
        status: 'PENDING_GIFSY',
        requestedPaise: BigInt(50),
        awardType: 'POINTS',
        outletId: 'O1',
        fieldId: 'f1',
        fieldName: 'Volume',
        period: '2026-05',
        batchId: 'b1',
      });
      mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'APPROVED' });
      stillPending();

      await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 50 });

      // cap + safety gate first, under the batch + reversal row locks, before the flip
      expect(mockWalletService.v2PointsReversalCap).toHaveBeenCalledWith(mockTx, { batchId: 'b1', outletCode: 'O1', fieldId: 'f1' });
      expect(mockWalletService.reverseCreditBatchPoints).toHaveBeenCalledTimes(1);
      expect(mockWalletService.reverseCreditBatchPoints).toHaveBeenCalledWith(
        mockTx, // same tx — atomic with status flip
        expect.objectContaining({
          batchId: 'b1', outletCode: 'O1', fieldId: 'f1', clientId: 'deoleo', creditReversalId: 'r1', points: 50,
          passbookLabel: 'Volume · 2026-05',
        }),
      );
      // no mode / legacy target is passed any more
      const arg = mockWalletService.reverseCreditBatchPoints.mock.calls[0][1] as Record<string, unknown>;
      expect(arg).not.toHaveProperty('mode');
      expect(arg).not.toHaveProperty('legacyTarget');
    });

    it('approve re-validates the cap server-side: refuses when the positions hold less than the approval (no claim, no reversal)', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r2', status: 'PENDING_GIFSY', requestedPaise: BigInt(300), awardType: 'POINTS',
        outletId: 'O1', fieldId: 'f1', batchId: 'b1',
      });
      stillPending();
      // another reversal of the same credit already took the full 300 (ρ = amount)
      mockWalletService.v2PointsReversalCap.mockResolvedValueOnce({ cap: 0, positions: [{ amount: 300 }], unallocatedApproved: 0 });

      await expect(
        service.patchReversal(gifsy, 'r2', { action: ReversalAction.approve }),
      ).rejects.toThrow(/Approval exceeds the amount still reversible/);
      expect(mockTx.creditReversal.updateMany).not.toHaveBeenCalled();
      expect(mockWalletService.reverseCreditBatchPoints).not.toHaveBeenCalled();
    });

    it('reject is never blocked by the cap', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r2', status: 'PENDING_GIFSY', requestedPaise: BigInt(300), awardType: 'POINTS',
        outletId: 'O1', fieldId: 'f1', batchId: 'b1',
      });
      mockTx.creditBatch.findFirst.mockResolvedValue({ id: 'b1', rows: [] });
      mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r2', status: 'REJECTED' });
      await expect(service.patchReversal(gifsy, 'r2', { action: ReversalAction.reject })).resolves.toMatchObject({ status: 'REJECTED' });
      expect(mockWalletService.v2PointsReversalCap).not.toHaveBeenCalled();
    });

    it('does NOT touch the wallet for a PAYOUT reversal approval', async () => {
      // PAYOUT reversals never call the points engine — they iterate CreditPayoutEntry rows and mark them
      // REVERSED (or record a receivable). This one has no allocation rows (raised before 2026-11-21) → interim path.
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r1',
        status: 'PENDING_GIFSY',
        requestedPaise: BigInt(10000),
        awardType: 'PAYOUT',
        outletId: 'O1',
        fieldId: 'f1',
      });
      mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r1', status: 'APPROVED' });
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'pe1', status: 'PENDING', amountPaise: BigInt(10000) },
      ]);

      await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 10000 });

      expect(mockWalletService.reverseCreditBatchPoints).not.toHaveBeenCalled();
      expect(mockWalletService.v2PointsReversalCap).not.toHaveBeenCalled();
      expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenCalledWith({
        where: { id: 'pe1', status: 'PENDING' },
        data: { status: 'REVERSED', downloadId: null },
      });
      expect(mockTx.creditPayoutEntry.update).not.toHaveBeenCalled();
    });

    it('does NOT reverse points when action is reject (POINTS type)', async () => {
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

      expect(mockWalletService.reverseCreditBatchPoints).not.toHaveBeenCalled();
    });

    it('REFUSES a POINTS approval when no wallet received the credit (was: silent no-op)', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r1', status: 'PENDING_GIFSY', requestedPaise: BigInt(50), awardType: 'POINTS',
        outletId: 'O1', fieldId: 'f1', batchId: 'b1',
      });
      stillPending();
      mockWalletService.v2PointsReversalCap.mockRejectedValueOnce(
        new BadRequestException('Cannot reverse: no wallet received a credit from batch b1 for outlet O1 / field f1 — settle it off-platform'),
      );
      await expect(
        service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 50 }),
      ).rejects.toThrow(/no wallet received a credit/);
      expect(mockTx.creditReversal.updateMany).not.toHaveBeenCalled();
      expect(mockWalletService.reverseCreditBatchPoints).not.toHaveBeenCalled();
    });

    it('SAFETY GATE approve: a receiving wallet with un-sequenced history → 409 WALLET_NOT_SEQUENCED BEFORE the flip; refusal audited (APPROVE)', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r1', status: 'PENDING_GIFSY', requestedPaise: BigInt(500), awardType: 'POINTS',
        outletId: 'O1', fieldId: 'f1', batchId: 'b1',
      });
      stillPending();
      const msg = walletNotSequencedMessage('O1', 'Deoleo India');
      mockWalletService.v2PointsReversalCap.mockRejectedValueOnce(
        new ReversalAttentionException('WALLET_NOT_SEQUENCED', msg, { batchId: 'b1', outletCode: 'O1', fieldId: 'f1', walletId: 'w7', clientId: 'deoleo', clientName: 'Deoleo India' }),
      );
      (mockPrisma as any).auditLog = { create: jest.fn().mockResolvedValue({}) };
      try {
        const err = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve }).catch((e) => e);
        expect(err).toBeInstanceOf(ReversalAttentionException);
        expect(err.code).toBe('WALLET_NOT_SEQUENCED');
        expect(err.message).toMatch(/^Can't reverse: the wallet of outlet O1 \(Deoleo India\)/);
        // nothing was flipped, nothing reached the wallet
        expect(mockTx.creditReversal.updateMany).not.toHaveBeenCalled();
        expect(mockWalletService.reverseCreditBatchPoints).not.toHaveBeenCalled();
        expect((mockPrisma as any).auditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            entityType: 'REVERSAL_ENGINE_REFUSAL',
            entityId: 'r1',
            metadata: expect.objectContaining({ phase: 'APPROVE', code: 'WALLET_NOT_SEQUENCED', walletId: 'w7' }),
          }),
        });
      } finally {
        delete (mockPrisma as any).auditLog;
      }
    });

    it('audit A1: a POINTS reversal raised under the OLD engine (no one-engine marker) → RAISED_UNDER_OLD_ENGINE before the cap / flip; audited (APPROVE)', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r-old', status: 'PENDING_GIFSY', requestedPaise: BigInt(500), awardType: 'POINTS',
        outletId: 'O1', fieldId: 'f1', batchId: 'b1', requestedAt: new Date(Date.now() - 86_400_000),
      });
      stillPending();
      mockTx.auditLog.findFirst.mockResolvedValueOnce(null); // no marker
      (mockPrisma as any).auditLog = { create: jest.fn().mockResolvedValue({}) };
      try {
        const err = await service.patchReversal(gifsy, 'r-old', { action: ReversalAction.approve }).catch((e) => e);
        expect(err).toBeInstanceOf(ReversalAttentionException);
        expect(err.code).toBe('RAISED_UNDER_OLD_ENGINE');
        expect(err.message).toBe(RAISED_UNDER_OLD_ENGINE_MESSAGE);
        expect(mockTx.auditLog.findFirst).toHaveBeenCalledWith({
          where: { entityType: POINTS_REVERSAL_ENGINE_MARKER_ENTITY, entityId: 'r-old' },
          select: { id: true },
        });
        expect(mockWalletService.v2PointsReversalCap).not.toHaveBeenCalled();
        expect(mockTx.creditReversal.updateMany).not.toHaveBeenCalled();
        expect(mockWalletService.reverseCreditBatchPoints).not.toHaveBeenCalled();
        expect((mockPrisma as any).auditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            entityType: 'REVERSAL_ENGINE_REFUSAL', entityId: 'r-old',
            metadata: expect.objectContaining({ phase: 'APPROVE', code: 'RAISED_UNDER_OLD_ENGINE' }),
          }),
        });
      } finally {
        delete (mockPrisma as any).auditLog;
      }
    });

    it('audit A1: reject of an old-engine POINTS reversal still works (no marker needed)', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r-old', status: 'PENDING_GIFSY', requestedPaise: BigInt(500), awardType: 'POINTS', outletId: 'O1', fieldId: 'f1', batchId: 'b1',
      });
      mockTx.auditLog.findFirst.mockResolvedValue(null);
      mockTx.creditReversal.findFirst.mockResolvedValue({ id: 'r-old', status: 'REJECTED' });
      await expect(service.patchReversal(gifsy, 'r-old', { action: ReversalAction.reject })).resolves.toMatchObject({ status: 'REJECTED' });
      expect(mockTx.auditLog.findFirst).not.toHaveBeenCalled();
    });

    it('audit A1: a POINTS create writes the one-engine marker in the SAME transaction', async () => {
      mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
      mockTx.creditReversal.findFirst.mockResolvedValue(null);
      mockTx.creditReversal.create.mockResolvedValue({ id: 'r-new' });
      await service.createReversal(admin, 'b1', {
        outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
        awardType: CreditAwardType.POINTS, originalPaise: 300, requestedPaise: 100,
      } as CreateReversalDto);
      expect(mockTx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'CREATE', entityType: POINTS_REVERSAL_ENGINE_MARKER_ENTITY, entityId: 'r-new',
          metadata: expect.objectContaining({ clientId: 'deoleo', batchId: 'b1', outletId: 'O1', fieldId: 'f1' }),
        }),
      });
    });

    it('POINTS approve never reads a reversal-engine setting (the mode is retired)', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue({
        id: 'r1', status: 'PENDING_GIFSY', requestedPaise: BigInt(50), awardType: 'POINTS',
        outletId: 'O1', fieldId: 'f1', batchId: 'b1', fieldName: 'Volume', period: '2026-05',
      });
      stillPending();
      (mockTenantSettings as any).getReversalEngineModeUncached = jest.fn(() => {
        throw new Error('the retired engine mode must never be read');
      });
      try {
        await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve });
        expect((mockTenantSettings as any).getReversalEngineModeUncached).not.toHaveBeenCalled();
        expect(mockWalletService.reverseCreditBatchPoints).toHaveBeenCalledTimes(1);
      } finally {
        delete (mockTenantSettings as any).getReversalEngineModeUncached;
      }
    });

    // ── GLM-1: PAYOUT reversal — this batch only, up to the approved amount ──────────
    const payoutRev = (approved: number) => ({
      id: 'r1', status: 'PENDING_GIFSY', requestedPaise: BigInt(approved),
      awardType: 'PAYOUT', outletId: 'O1', fieldId: 'f1', batchId: 'b1',
    });

    it('GLM-1: reverses THIS batch\'s PENDING + FAILED entries, records PAID as receivable (oldest first)', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(30000));
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'pe-pending', status: 'PENDING', amountPaise: 10000n, tdsDeductedPaise: 0n },
        { id: 'pe-failed', status: 'FAILED', amountPaise: 10000n, tdsDeductedPaise: 0n },
        { id: 'pe-paid', status: 'PAID', amountPaise: 10000n, tdsDeductedPaise: 0n },
      ]);
      const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 30000 });

      // Scoped to the reversal's batch (never another batch's top-up), oldest first.
      expect(mockTx.creditPayoutEntry.findMany.mock.calls[0][0]).toMatchObject({
        where: { clientId: 'deoleo', batchId: 'b1', outletId: 'O1', fieldId: 'f1' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenCalledWith({
        where: { id: 'pe-pending', status: 'PENDING' }, data: { status: 'REVERSED', downloadId: null },
      });
      expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenCalledWith({
        where: { id: 'pe-failed', status: 'FAILED' }, data: { status: 'REVERSED', downloadId: null },
      });
      const touched = mockTx.creditPayoutEntry.updateMany.mock.calls.map((c: any[]) => c[0].where.id);
      expect(touched).not.toContain('pe-paid');
      expect(mockWalletService.reverseCreditBatchPoints).not.toHaveBeenCalled();
      expect(res.clawbackShortfall).toBe(10000);
      expect(mockTx.creditReversal.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { shortfallPaise: BigInt(10000) } });
    });

    it('GLM-1b: a PAYOUT reversal cannot be approved for a different amount (approve in full or reject)', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(20000));
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'pe-old', status: 'PENDING', amountPaise: 10000n, tdsDeductedPaise: 0n },
        { id: 'pe-new', status: 'PENDING', amountPaise: 10000n, tdsDeductedPaise: 0n },
      ]);
      await expect(
        service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 10000 }),
      ).rejects.toThrow('A payout reversal is approved in full or rejected — approve ₹200.00 or reject it');
      expect(mockTx.creditReversal.updateMany).not.toHaveBeenCalled();
      expect(mockTx.creditPayoutEntry.updateMany).not.toHaveBeenCalled();
    });

    it('GLM-1c: approving with the exact requested amount (or no amount) is accepted and records the consumed entries', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(20000));
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'pe-old', status: 'PENDING', amountPaise: 10000n, tdsDeductedPaise: 0n },
        { id: 'pe-new', status: 'PENDING', amountPaise: 10000n, tdsDeductedPaise: 0n },
      ]);
      await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve });
      const claim = mockTx.creditReversal.updateMany.mock.calls[0][0];
      expect(claim.data).toMatchObject({ status: 'APPROVED', approvedPaise: 20000n, consumedPayoutEntryIds: ['pe-old', 'pe-new'] });
      const touched = mockTx.creditPayoutEntry.updateMany.mock.calls.map((c: any[]) => c[0].where.id);
      expect(touched).toEqual(['pe-old', 'pe-new']);
    });

    // ── Whole-entry rule: an entry is consumed by at most ONE reversal ─────────────
    describe('payout entries are never consumed twice (interim rule Q9)', () => {
      const T0 = new Date('2026-05-02T00:00:00.000Z');
      const paid = { id: 'pe-paid', status: 'PAID', amountPaise: 30000n, tdsDeductedPaise: 0n, createdAt: T0 };
      const pending = { id: 'pe-pend', status: 'PENDING', amountPaise: 30000n, tdsDeductedPaise: 0n, createdAt: new Date(T0.getTime() + 1) };
      // creditReversal.findMany serves two queries: the consumed-entries lookup (APPROVED/PARTIAL
      // PAYOUT reversals of this outlet+field) and reversedSoFar (the Σ cap).
      const priorApprovals = (rows: any[]) =>
        mockTx.creditReversal.findMany.mockImplementation(async (arg: any) => {
          const st: string[] = arg?.where?.status?.in ?? [];
          if (!st.includes('PENDING_GIFSY')) return rows; // consumed-entries lookup
          return rows.map((r) => ({ status: 'APPROVED', requestedPaise: r.approvedPaise, approvedPaise: r.approvedPaise }));
        });
      afterEach(() => {
        mockTx.creditReversal.findMany.mockReset();
        mockTx.creditReversal.findMany.mockResolvedValue([]);
      });

      it('first ₹300 reversal of [₹300 PAID, ₹300 PENDING] cancels the unpaid entry (no receivable)', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(30000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([paid, pending]);
        priorApprovals([]);
        const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve });
        expect(mockTx.creditReversal.updateMany.mock.calls[0][0].data.consumedPayoutEntryIds).toEqual(['pe-pend']);
        expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenCalledWith({
          where: { id: 'pe-pend', status: 'PENDING' }, data: { status: 'REVERSED', downloadId: null },
        });
        expect(res.clawbackShortfall).toBe(0);
      });

      it('second ₹300 reversal after the PAID entry was consumed (receivable) → consumes the PENDING one, never the PAID again', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(30000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([paid, pending]); // PAID stays PAID after its receivable
        priorApprovals([{ consumedPayoutEntryIds: ['pe-paid'], approvedAt: new Date(T0.getTime() + 5), approvedPaise: 30000n }]);
        const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve });
        expect(mockTx.creditReversal.updateMany.mock.calls[0][0].data.consumedPayoutEntryIds).toEqual(['pe-pend']);
        expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenCalledWith({
          where: { id: 'pe-pend', status: 'PENDING' }, data: { status: 'REVERSED', downloadId: null },
        });
        expect(res.clawbackShortfall).toBe(0); // no second receivable for the PAID entry
      });

      it('second ₹300 reversal after the PENDING one was consumed → the PAID entry becomes the (only) receivable', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(30000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([paid]); // pe-pend is REVERSED now → not listed
        priorApprovals([{ consumedPayoutEntryIds: ['pe-pend'], approvedAt: new Date(T0.getTime() + 5), approvedPaise: 30000n }]);
        const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve });
        expect(mockTx.creditReversal.updateMany.mock.calls[0][0].data.consumedPayoutEntryIds).toEqual(['pe-paid']);
        expect(res.clawbackShortfall).toBe(30000);
      });

      it('a third reversal when every entry is consumed is refused at approval (nothing claimed)', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(30000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([paid]);
        priorApprovals([{ consumedPayoutEntryIds: ['pe-paid'], approvedAt: new Date(T0.getTime() + 5), approvedPaise: 30000n }]);
        await expect(service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve })).rejects.toThrow(/No payout entries left to reverse/);
        expect(mockTx.creditReversal.updateMany).not.toHaveBeenCalled();
      });

      it('legacy approval (before consumedPayoutEntryIds existed) consumed every PAID entry created by its approvedAt', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(30000));
        const laterPaid = { ...paid, id: 'pe-paid-later', createdAt: new Date(T0.getTime() + 10) };
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([paid, laterPaid]);
        priorApprovals([{ consumedPayoutEntryIds: null, approvedAt: new Date(T0.getTime() + 5), approvedPaise: 30000n }]);
        const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve });
        expect(mockTx.creditReversal.updateMany.mock.calls[0][0].data.consumedPayoutEntryIds).toEqual(['pe-paid-later']);
        expect(res.clawbackShortfall).toBe(30000);
      });

      it('entry choice: PAID 500 + PENDING 300 + PENDING 200, reverse ₹500 → cancels the two PENDING (no receivable)', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(50000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { id: 'pe-paid500', status: 'PAID', amountPaise: 50000n, tdsDeductedPaise: 0n, createdAt: T0 },
          { id: 'pe-pend300', status: 'PENDING', amountPaise: 30000n, tdsDeductedPaise: 0n, createdAt: T0 },
          { id: 'pe-pend200', status: 'PENDING', amountPaise: 20000n, tdsDeductedPaise: 0n, createdAt: T0 },
        ]);
        priorApprovals([]);
        const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve });
        expect(mockTx.creditReversal.updateMany.mock.calls[0][0].data.consumedPayoutEntryIds).toEqual(['pe-pend300', 'pe-pend200']);
        expect(res.clawbackShortfall).toBe(0);
      });

      it('entry choice: PROCESSING 500 + PENDING 300 + PENDING 200, reverse ₹500 → cancels the PENDING pair (not refused)', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(50000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { id: 'pe-proc500', status: 'PROCESSING', amountPaise: 50000n, tdsDeductedPaise: 0n, createdAt: T0 },
          { id: 'pe-pend300', status: 'PENDING', amountPaise: 30000n, tdsDeductedPaise: 0n, createdAt: T0 },
          { id: 'pe-pend200', status: 'PENDING', amountPaise: 20000n, tdsDeductedPaise: 0n, createdAt: T0 },
        ]);
        priorApprovals([]);
        await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve });
        expect(mockTx.creditReversal.updateMany.mock.calls[0][0].data.consumedPayoutEntryIds).toEqual(['pe-pend300', 'pe-pend200']);
        const touched = mockTx.creditPayoutEntry.updateMany.mock.calls.map((c: any[]) => c[0].where.id);
        expect(touched).toEqual(['pe-pend300', 'pe-pend200']);
      });

      describe('create: the request names whole open entries and must equal their sum (every tenant)', () => {
        const create = (requestedPaise: number, payoutEntryIds: string[]) =>
          service.createReversal(admin, 'b1', {
            outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F',
            awardType: CreditAwardType.PAYOUT, originalPaise: 80000, requestedPaise, payoutEntryIds,
          });
        beforeEach(() => {
          mockPrisma.creditBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'CONFIRMED', period: '2026-05' });
          mockTx.creditReversal.findFirst.mockResolvedValue(null);
          mockTx.creditReversal.create.mockResolvedValue({ id: 'r-new' });
          mockTx.creditPayoutEntry.findMany.mockResolvedValue([
            { id: 'pe-300', status: 'PENDING', amountPaise: 30000n, createdAt: T0, tdsSection: null, tdsDeductedPaise: 0n, outletId: 'O1', fieldId: 'f1', period: '2026-05' },
            { id: 'pe-500', status: 'PAID', amountPaise: 50000n, createdAt: T0, tdsSection: null, tdsDeductedPaise: 0n, outletId: 'O1', fieldId: 'f1', period: '2026-05' },
          ]);
          priorApprovals([]);
        });

        it('[₹300, ₹500] select the ₹500 entry → accepted and reserved', async () => {
          await create(50000, ['pe-500']);
          expect(mockTx.creditReversal.create).toHaveBeenCalledTimes(1);
          expect(mockTx.payoutReversalAllocation.createMany).toHaveBeenCalledTimes(1);
        });

        it('[₹300, ₹500] select both (₹800) → accepted', async () => {
          await create(80000, ['pe-300', 'pe-500']);
          expect(mockTx.creditReversal.create).toHaveBeenCalledTimes(1);
        });

        it('[₹300, ₹500] ₹400 against the ₹300 entry → 400 naming both amounts, nothing created', async () => {
          await expect(create(40000, ['pe-300'])).rejects.toThrow(
            'The requested amount (₹400.00) must equal the selected payout entries (₹300.00)',
          );
          expect(mockTx.creditReversal.create).not.toHaveBeenCalled();
        });

        it('an entry already consumed by an approved reversal can not be selected again', async () => {
          priorApprovals([{ consumedPayoutEntryIds: ['pe-500'], approvedAt: new Date(T0.getTime() + 5), approvedPaise: 50000n }]);
          await expect(create(50000, ['pe-500'])).rejects.toThrow(/cannot be reversed: it is already taken by an approved reversal/);
          expect(mockTx.creditReversal.create).not.toHaveBeenCalled();
        });

        it('an amount-only request (no entries named) is refused in plain words, nothing created', async () => {
          await expect(create(50000, undefined as unknown as string[])).rejects.toThrow(/^Select the payout entries to reverse/);
          expect(mockTx.creditReversal.create).not.toHaveBeenCalled();
        });
      });
    });

    it('GLM-1d: an entry already with the bank (PROCESSING) → the approval is refused, nothing reversed or offset', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(2_000_000));
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'pe1', status: 'PROCESSING', outletId: 'O1', amountPaise: 2_000_000n, tdsDeductedPaise: 40_000n, tdsSection: 'SEC_194C', period: '2026-05' },
      ]);
      await expect(
        service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 2_000_000 }),
      ).rejects.toThrow(/already sent to the bank.*record the UTR or the failure first/);
      expect(mockTx.creditPayoutEntry.updateMany).not.toHaveBeenCalled();
      expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
    });

    it('GLM-1e: error messages show ₹ for PAYOUT caps (not raw paise)', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(30000));
      mockTx.creditBatch.findFirst.mockResolvedValue({
        id: 'b1', rows: [{ outletId: 'O1', fieldId: 'f1', awardType: 'PAYOUT', status: 'OK', amount: 20000 }],
      });
      await expect(
        service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 30000 }),
      ).rejects.toThrow('credited ₹200.00, already reversed ₹0.00, approving ₹300.00');
    });

    it('reversedSoFar filters by awardType (points and paise never mix)', async () => {
      mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(10000));
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([{ id: 'pe1', status: 'PENDING', amountPaise: 10000n, tdsDeductedPaise: 0n }]);
      await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 10000 });
      expect(mockTx.creditReversal.findMany.mock.calls[0][0].where).toMatchObject({ awardType: 'PAYOUT' });
    });

    // ── Withheld TDS on reversal: only for PENDING/FAILED (never PROCESSING — see GLM-1d) ──
    describe('withheld-TDS offset on reversal (mirrors the uploadUtr FAILED path)', () => {
      const failedWithStamp = {
        id: 'pe1', status: 'FAILED', outletId: 'O1', amountPaise: 2_000_000n,
        tdsDeductedPaise: 40_000n, tdsSection: 'SEC_194C', period: '2026-05',
      };

      it('₹400 stamp still on an unpaid entry: REVERSED with the stamp cleared AND a −₹400 TdsDeductionEntry under the ORIGINAL PAN', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(2_000_000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([failedWithStamp]);
        mockTx.tdsDeductionEntry.findMany.mockResolvedValue([{ panNumber: 'ABCDE1234F', tdsDeductedThisPaise: 40_000n }]);

        const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 2_000_000 });

        expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenCalledWith({
          where: { id: 'pe1', status: 'FAILED', tdsDeductedPaise: 40_000n },
          data: { status: 'REVERSED', downloadId: null, tdsDeductedPaise: 0n },
        });
        expect(mockTx.tdsDeductionEntry.createMany).toHaveBeenCalledTimes(1);
        const [row] = mockTx.tdsDeductionEntry.createMany.mock.calls[0][0].data;
        expect(row).toMatchObject({
          clientId: 'deoleo', panNumber: 'ABCDE1234F', section: 'SEC_194C',
          creditPayoutEntryId: 'pe1', outletCode: 'O1', tdsDeductedThisPaise: -40_000n,
        });
        expect(res.clawbackShortfall).toBe(0);
        expect(res.payoutClawbackNote).toContain('withheld TDS ₹400.00 offset');
      });

      it('FULLY withheld (TDS-WITHHELD) PAID entry: NO receivable — the withholding is reversed (offset in its original FY, under the 194R lock) and the entry REVERSED', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(500_000));
        mockTx.creditBatch.findFirst.mockResolvedValue({ id: 'b1', rows: [{ outletId: 'O1', fieldId: 'f1', awardType: 'PAYOUT', status: 'OK', amount: 500_000 }] });
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { id: 'pe1', status: 'PAID', outletId: 'O1', amountPaise: 500_000n, tdsDeductedPaise: 500_000n, tdsSection: 'SEC_194R', period: '2026-05', utr: 'TDS-WITHHELD-PD-2026-05-001' },
        ]);
        mockTx.tdsDeductionEntry.findMany.mockResolvedValue([{ panNumber: 'ABCDE1234F', fyLabel: '2026-27', tdsDeductedThisPaise: 500_000n }]);

        const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 500_000 });

        expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenCalledWith({
          where: { id: 'pe1', status: 'PAID', tdsDeductedPaise: 500_000n },
          data: { status: 'REVERSED', tdsDeductedPaise: 0n },
        });
        const [row] = mockTx.tdsDeductionEntry.createMany.mock.calls[0][0].data;
        expect(row).toMatchObject({ panNumber: 'ABCDE1234F', section: 'SEC_194R', fyLabel: '2026-27', tdsDeductedThisPaise: -500_000n });
        expect(res.clawbackShortfall).toBe(0);
        expect(res.payoutClawbackNote).toContain('fully withheld as TDS');
        expect(lockKeysTaken()).toContain('R194|deoleo|2026-27');
      });

      it('PARTLY withheld PAID entry: the receivable is only the NET amount actually released (₹25,000 − ₹2,500 = ₹22,500)', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(2_500_000));
        mockTx.creditBatch.findFirst.mockResolvedValue({ id: 'b1', rows: [{ outletId: 'O1', fieldId: 'f1', awardType: 'PAYOUT', status: 'OK', amount: 2_500_000 }] });
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { id: 'pe1', status: 'PAID', outletId: 'O1', amountPaise: 2_500_000n, tdsDeductedPaise: 250_000n, tdsSection: 'SEC_194R', period: '2026-05', utr: 'UTR1' },
        ]);

        const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 2_500_000 });

        expect(res.clawbackShortfall).toBe(2_250_000);
        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
      });

      it('idempotent: withholding ALREADY offset in the ledger (net 0) → no second offset', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(2_000_000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([failedWithStamp]);
        mockTx.tdsDeductionEntry.findMany.mockResolvedValue([
          { panNumber: null, tdsDeductedThisPaise: -40_000n },
          { panNumber: 'ABCDE1234F', tdsDeductedThisPaise: 40_000n },
        ]);
        await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 2_000_000 });
        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
      });

      it('race: a bank-file download took the PENDING entry meanwhile (guarded flip count 0 → PROCESSING) → approval refused', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(10000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([{ id: 'pe1', status: 'PENDING', amountPaise: 10000n, tdsDeductedPaise: 0n }]);
        mockTx.creditPayoutEntry.updateMany.mockResolvedValue({ count: 0 });
        mockTx.creditPayoutEntry.findFirst.mockResolvedValue({ status: 'PROCESSING', amountPaise: 10000n, tdsDeductedPaise: 400n });
        await expect(
          service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 10000 }),
        ).rejects.toThrow(/already sent to the bank/);
        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
      });

      it('race: a 194R entry was PAID meanwhile → recorded as a receivable, not REVERSED, no offset', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(2_000_000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([{ ...failedWithStamp, tdsSection: 'SEC_194R' }]);
        mockTx.creditPayoutEntry.updateMany.mockResolvedValue({ count: 0 });
        mockTx.creditPayoutEntry.findFirst.mockResolvedValue({ status: 'PAID', amountPaise: 2_000_000n, tdsDeductedPaise: 40_000n });
        const res = await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 2_000_000 });
        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
        // Receivable = the NET actually released (₹20,000 − ₹400 TDS withheld), not the gross.
        expect(res.clawbackShortfall).toBe(1_960_000);
      });

      it('final item 5 (Deoleo path, locking only): PDLOCK|client|period BEFORE the selection and row locks; the TDS keys come from the re-read under the row lock', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue({ ...payoutRev(2_000_000), period: '2026-05' });
        const pendingNoStamp = { ...failedWithStamp, status: 'PENDING', tdsDeductedPaise: 0n, tdsSection: 'SEC_194R' };
        mockTx.creditPayoutEntry.findMany
          .mockResolvedValueOnce([pendingNoStamp]) // the selection read (before the row lock): nothing withheld yet
          .mockResolvedValueOnce([{ id: 'pe1', status: 'PENDING', tdsDeductedPaise: 40_000n }]); // the re-read under the lock
        mockTx.tdsDeductionEntry.findMany.mockResolvedValue([
          { creditPayoutEntryId: 'pe1', panNumber: 'PAN1', section: 'SEC_194R', fyLabel: '2026-27', tdsDeductedThisPaise: 40_000n },
        ]);
        await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 2_000_000 });
        const keys = lockKeysTaken();
        expect(keys).toContain('PDLOCK|deoleo|2026-05');
        expect(keys).toContain('R194|deoleo|2026-27'); // only the re-read showed the withholding
        // order: PDLOCK advisory → entry row lock → R194 advisory
        const seq: string[] = [];
        const ex = mockTx.$executeRaw.mock.invocationCallOrder;
        const qr = mockTx.$queryRaw.mock.invocationCallOrder;
        mockTx.$executeRaw.mock.calls.forEach((c: unknown[], i: number) => {
          const v = c[1];
          const ks = Array.isArray(v) ? (v as string[]) : [];
          if (ks.some((k) => k.startsWith('PDLOCK|'))) seq.push(`${ex[i]}:PDLOCK`);
          if (ks.some((k) => k.startsWith('R194|'))) seq.push(`${ex[i]}:R194`);
        });
        mockTx.$queryRaw.mock.calls.forEach((c: unknown[], i: number) => {
          if ((c[0] as string[]).join('?').includes('FROM credit_payout_entries') && (c[0] as string[]).join('?').includes('FOR UPDATE')) seq.push(`${qr[i]}:ROWS`);
        });
        const ordered = seq.sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0])).map((s) => s.split(':')[1]);
        expect(ordered).toEqual(['PDLOCK', 'ROWS', 'R194']);
        // identical outputs: the entry is reversed and its (re-read) withholding offset once
        expect(mockTx.tdsDeductionEntry.createMany).toHaveBeenCalledTimes(1);
      });

      it('re-audit A3: a 194C entry PAID meanwhile (the retry re-read) is refused with the owner D1 message — nothing written', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(2_000_000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([failedWithStamp]); // SEC_194C, FAILED at selection
        mockTx.creditPayoutEntry.updateMany.mockResolvedValue({ count: 0 });
        mockTx.creditPayoutEntry.findFirst.mockResolvedValue({ status: 'PAID', amountPaise: 2_000_000n, tdsDeductedPaise: 40_000n });
        await expect(service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 2_000_000 })).rejects.toThrow(
          /^194C payouts can't be reversed once paid .*Reject this reversal request; settle with the retailer off-platform\.$/,
        );
        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
        // the chosen entries were row-locked (ascending id) after the advisory locks — the download takes no batch lock
        const lockSql = mockTx.$queryRaw.mock.calls.map((c: unknown[]) => (c[0] as string[]).join('?')).find((q: string) => q.includes('FROM credit_payout_entries'));
        expect(lockSql).toMatch(/ORDER BY id FOR UPDATE/);
      });

      it('race: FAILED→(re-read) still FAILED with the stamp cleared by a concurrent UTR apply → reversed once, NO offset', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(2_000_000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([failedWithStamp]);
        mockTx.creditPayoutEntry.updateMany
          .mockResolvedValueOnce({ count: 0 }) // stamp no longer 40_000
          .mockResolvedValueOnce({ count: 1 });
        mockTx.creditPayoutEntry.findFirst.mockResolvedValue({ status: 'FAILED', amountPaise: 2_000_000n, tdsDeductedPaise: 0n });
        await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 2_000_000 });
        expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenLastCalledWith({
          where: { id: 'pe1', status: 'FAILED' }, data: { status: 'REVERSED', downloadId: null },
        });
        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
      });

      it('Deoleo parity: an unpaid entry with NO withholding → guarded REVERSED only, no ledger read/write', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue(payoutRev(2_000_000));
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([{ ...failedWithStamp, status: 'PENDING', tdsDeductedPaise: 0n }]);
        await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 2_000_000 });
        expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenCalledWith({
          where: { id: 'pe1', status: 'PENDING' }, data: { status: 'REVERSED', downloadId: null },
        });
        expect(mockTx.tdsDeductionEntry.findMany).not.toHaveBeenCalled();
        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
      });
    });
  });

  describe('eligibleOutlets', () => {
    it('filters to active outlets of active partners in the tenant (no displayName → code)', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', name: 'A', phone: '900', outletType: { id: 'ot_gt', code: 'GT' } },
      ]);
      const res = await service.eligibleOutlets(admin);
      const where = mockPrisma.outlet.findMany.mock.calls[0][0].where;
      expect(where.partner).toEqual({ clientId: 'deoleo', isActive: true });
      // No per-tenant displayName (default []) → BOTH `type` (match key) and `typeLabel`
      // (display) fall back to the outletType.code (Deoleo parity).
      expect(res[0]).toEqual({ id: 'O1', name: 'A', type: 'GT', typeLabel: 'GT', phone: '900' });
    });

    it('a renamed outlet type keeps `type` = code (award-match key) and puts the displayName in `typeLabel`', async () => {
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', name: 'A', phone: '900', outletType: { id: 'ot_gt', code: 'GT' } },
      ]);
      // Tenant renamed OutletType ot_gt → "General Trade".
      mockPrisma.outletTypeClientConfig.findMany.mockResolvedValue([
        { outletTypeId: 'ot_gt', displayName: 'General Trade' },
      ]);
      const res = await service.eligibleOutlets(admin);
      // `type` MUST stay the code — the upload parser resolves `field.outletTypeAwards[outlet.type]`
      // and that map is keyed by code. Returning the displayName here (the old bug) made every award
      // lookup miss → NA for any tenant with a display name. The friendly label goes in `typeLabel`.
      expect(res[0].type).toBe('GT');
      expect(res[0].typeLabel).toBe('General Trade');
      expect(mockPrisma.outletTypeClientConfig.findMany.mock.calls[0][0].where).toMatchObject({ clientId: 'deoleo' });
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

  // NOTE: listOutletTypes is fully covered by the describe block above (default-on
  // semantics mirroring GifsyService.getOutletTypeConfigs). The prior test here
  // asserted the OLD saved-enabled-row-only query and was removed with the fix.

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
      // Entries marked PROCESSING with the new download id; any stale failure capture is cleared
      // (reason, date, AND the failed-attempt UTR) so a re-banked entry starts fully clean.
      const updateArg = mockTx.creditPayoutEntry.updateMany.mock.calls[0][0];
      expect(updateArg.data).toEqual({ downloadId: 'd1', status: 'PROCESSING', failureReason: null, attemptedAt: null, utr: null });
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
      // Re-banking CLEARS any stale failure capture so the re-attempt starts clean (a later PAID
      // shows no leftover reason/date; a re-FAIL overwrites fresh).
      expect(updateArg.data).toMatchObject({ status: 'PROCESSING', failureReason: null, attemptedAt: null, utr: null });
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
      // The preview precedes an irreversible apply: the OK row the operator is about to mark PAID is shown.
      expect(res.parseResult).toMatchObject({
        rows: [expect.objectContaining({ outletId: 'O1', utr: 'UTR123456', status: 'OK', success: true })],
        rowCount: 1,
        rowsTruncated: false,
        problemRows: [],
        problemRowCount: 0,
        problemRowsTruncated: false,
      });
    });

    it('UTR preview shows EVERY row (OK with UTR + payment date, SKIP already-paid, ERROR with reason) in file order', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1',
        downloadCode,
        period: '2026-05',
        downloadedBy: 'g1',
        entries: [
          { id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: BigInt(10000) },
          { id: 'e2', outletId: 'O2', status: 'PROCESSING', utr: null, amountPaise: BigInt(10000) },
          { id: 'e3', outletId: 'O3', status: 'PAID', utr: 'UTROLD999', amountPaise: BigInt(10000) },
        ],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
      const file = buildUtrFile([
        [downloadCode, 'O1', 'UTR123456', 'Success', ''],
        [downloadCode, 'O2', '', 'Success', ''], // missing UTR → ERROR
        [downloadCode, 'O3', 'UTROLD999', 'Success', ''], // already PAID → SKIP
      ]);
      const res = (await service.uploadUtr(gifsy, 'd1', file, false)) as {
        parseResult: { rows: Array<{ outletId: string; status: string; utr: string; errors: string[] }>; rowCount: number; rowsTruncated: boolean };
      };
      expect(res.parseResult.rows.map((r) => [r.outletId, r.status])).toEqual([['O1', 'OK'], ['O2', 'ERROR'], ['O3', 'SKIP']]);
      expect(res.parseResult.rows[0].utr).toBe('UTR123456');
      expect(res.parseResult.rows[1].errors.length).toBeGreaterThan(0);
      expect(res.parseResult).toMatchObject({ rowCount: 3, rowsTruncated: false });
    });

    it('the preview also carries the ERROR-row summary, with the true count', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1',
        downloadCode,
        period: '2026-05',
        downloadedBy: 'g1',
        entries: [
          { id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: BigInt(10000) },
          { id: 'e2', outletId: 'O2', status: 'PROCESSING', utr: null, amountPaise: BigInt(10000) },
        ],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);

      const file = buildUtrFile([
        [downloadCode, 'O1', 'UTR123456', 'Success', ''],
        [downloadCode, 'O2', '', 'Success', ''], // missing UTR → ERROR
      ]);
      const res = (await service.uploadUtr(gifsy, 'd1', file, false)) as {
        parseResult: { problemRows: Array<{ outletId: string; status: string }>; problemRowCount: number; summary: { errors: number } };
      };
      expect(res.parseResult.problemRows.map((r) => r.outletId)).toEqual(['O2']);
      expect(res.parseResult.problemRows[0].status).toBe('ERROR');
      expect(res.parseResult.problemRowCount).toBe(res.parseResult.summary.errors);
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
      // FIX-C: entries re-read inside the tx (pre-flip), then re-read AFTER the flips for the status.
      mockTx.creditPayoutEntry.findMany
        .mockResolvedValueOnce([
          { id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: BigInt(10000), tdsDeductedPaise: 0n, tdsSection: null, period: '2026-05' },
        ])
        .mockResolvedValueOnce([{ id: 'e1', status: 'PAID' }]);
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
        where: { id: { in: ['e1'] }, status: 'PROCESSING' },
        data: { status: 'PAID', utr: 'UTR123456', paidAt: expect.any(Date) },
      });
      expect(mockTx.creditPayoutDownload.updateMany.mock.calls[0][0]).toEqual({
        where: { id: 'd1', clientId: 'deoleo', status: { not: 'PAID' } },
        data: { status: 'PAID' },
      });
      // The config-driven PAYOUT_CREDITED fan-out fires once (paid-channel-only); the old dead
      // WHATSAPP enqueue is gone — the notify() queue never drained non-PUSH.
      expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
    });

    it('owner 2026-11-25 "TDS invoice only on success": the 194C TDS hook runs for exactly the rows this apply PAID — never a FAILED one', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1', downloadCode, period: '2026-05', downloadedBy: 'g1',
        entries: [
          { id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: 11000000n },
          { id: 'e2', outletId: 'O2', status: 'PROCESSING', utr: null, amountPaise: 5000000n },
        ],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
      const row = (id: string, outletId: string, amountPaise: bigint) => ({
        id, outletId, status: 'PROCESSING', amountPaise, tdsDeductedPaise: 0n, tdsSection: 'SEC_194C', period: '2026-05',
        paidAt: null, fieldId: 'f-vis', tdsMethodology: 'GROSS_UP', payeePan: 'PAN1',
      });
      mockTx.creditPayoutEntry.findMany.mockResolvedValueOnce([row('e1', 'O1', 11000000n), row('e2', 'O2', 5000000n)]);
      mockPrisma.outlet.findMany.mockResolvedValue([]);
      const hook = jest.spyOn(service, 'recordGrossUpOnPaid').mockResolvedValue({ invoices: 1, recoveryRows: 1 });

      const file = buildUtrFile([
        [downloadCode, 'O1', 'UTR123456', 'Success', ''],
        [downloadCode, 'O2', 'REF9', 'Failed', 'Account closed'],
      ]);
      const res = (await service.uploadUtr(gifsy, 'd1', file, true)) as { tdsRaisedOnPaid?: unknown };

      expect(hook).toHaveBeenCalledTimes(1);
      const arg = hook.mock.calls[0][1];
      expect(arg).toMatchObject({ clientId: 'deoleo', period: '2026-05', downloadId: 'd1' });
      expect(arg.paidEntries.map((e) => e.id)).toEqual(['e1']); // the FAILED e2 raises nothing
      expect(arg.paidEntries[0]).toMatchObject({ tdsSection: 'SEC_194C', tdsMethodology: 'GROSS_UP', payeePan: 'PAN1' });
      expect(res.tdsRaisedOnPaid).toEqual({ invoices: 1, recoveryRows: 1 });
      hook.mockRestore();
    });

    it('an apply that only marks rows FAILED never runs the 194C TDS hook', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1', downloadCode, period: '2026-05', downloadedBy: 'g1',
        entries: [{ id: 'e2', outletId: 'O2', status: 'PROCESSING', utr: null, amountPaise: 5000000n }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
      mockTx.creditPayoutEntry.findMany.mockResolvedValueOnce([
        { id: 'e2', outletId: 'O2', status: 'PROCESSING', amountPaise: 5000000n, tdsDeductedPaise: 0n, tdsSection: 'SEC_194C', period: '2026-05', paidAt: null, fieldId: 'f-vis', tdsMethodology: 'GROSS_UP', payeePan: 'PAN1' },
      ]);
      const hook = jest.spyOn(service, 'recordGrossUpOnPaid');
      await service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O2', 'REF9', 'Failed', 'Account closed']]), true);
      expect(hook).not.toHaveBeenCalled();
      expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
      expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
      hook.mockRestore();
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

        // PAYOUT_CREDITED fan-out to the owner (paid-channel-only); the mapped vars reproduce the
        // deoleo_payout_credit body order [ownerName, points, utr, date-of-payment, month].
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
        const call = mockNotifications.notifyUserWithChannels.mock.calls[0][0];
        expect(call.eventKey).toBe('PAYOUT_CREDITED');
        expect(call.recipientPhone).toBe('9900000041');
        expect(call.includeFreeChannels).toBe(false);
        expect(call.vars).toMatchObject({
          ownerName: 'Ravi Traders',
          points: 150,
          utr: 'UTR123456',
          paymentDate: '06 Jul 2026',
          month: 'May 2026',
        });
        // The old dead WHATSAPP enqueue must be gone (queue never drained non-PUSH).
        const whatsappEnqueues = mockNotifications.enqueue.mock.calls
          .map((c) => c[0])
          .filter((p: { channel?: string }) => p.channel === 'WHATSAPP');
        expect(whatsappEnqueues).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    });

    // Owner rule 2026-11-15: the "payout credited" message states the amount ACTUALLY CREDITED TO
    // THE BANK = Σ(amountPaise − tdsDeductedPaise) of the entries this apply flipped to PAID.
    describe('payout-credited amount = bank-credited (net of DEDUCT TDS)', () => {
      const applyWith = async (
        fresh: Array<{ id: string; amountPaise: bigint; tdsDeductedPaise: bigint }>,
      ) => {
        mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
          id: 'd1',
          downloadCode,
          period: '2026-05',
          downloadedBy: 'g1',
          entries: fresh.map((e) => ({ id: e.id, outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: e.amountPaise })),
        });
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue(
          fresh.map((e) => ({
            id: e.id,
            outletId: 'O1',
            status: 'PROCESSING',
            amountPaise: e.amountPaise,
            tdsDeductedPaise: e.tdsDeductedPaise,
            tdsSection: e.tdsDeductedPaise > 0n ? 'SEC_194C' : null,
            period: '2026-05',
          })),
        );
        mockPrisma.outlet.findMany.mockResolvedValue([
          { outletCode: 'O1', name: 'A', partnerId: 'p1', partner: { ownerName: 'Ravi Traders', phone: '9900000041' } },
        ]);
        await service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O1', 'UTR123456', 'Success', '']]), true);
      };

      it('DEDUCT: states the NET bank credit, not the gross (₹10,000 − ₹200 TDS → 9800)', async () => {
        await applyWith([{ id: 'e1', amountPaise: 1_000_000n, tdsDeductedPaise: 20_000n }]);
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
        const call = mockNotifications.notifyUserWithChannels.mock.calls[0][0];
        expect(call.vars.points).toBe(9800);
        expect(call.body).toBe('Your payout of 9800 points has been credited.');
      });

      it('GROSS-UP / no TDS withheld: unchanged — states the gross (₹10,000 → 10000)', async () => {
        await applyWith([{ id: 'e1', amountPaise: 1_000_000n, tdsDeductedPaise: 0n }]);
        expect(mockNotifications.notifyUserWithChannels.mock.calls[0][0].vars.points).toBe(10000);
      });

      it('multi-entry outlet: sums every flipped entry net of its own withholding (one message)', async () => {
        // (₹5,000 − ₹100) + (₹3,000 − ₹0) + (₹2,000.50 − ₹40) = ₹9,860.50 → rounds to 9861
        await applyWith([
          { id: 'e1', amountPaise: 500_000n, tdsDeductedPaise: 10_000n },
          { id: 'e2', amountPaise: 300_000n, tdsDeductedPaise: 0n },
          { id: 'e3', amountPaise: 200_050n, tdsDeductedPaise: 4_000n },
        ]);
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
        expect(mockNotifications.notifyUserWithChannels.mock.calls[0][0].vars.points).toBe(9861);
      });

      it('mirrors the bank line: the OUTLET total (Σ amount − Σ tds) is floored once, never per entry', async () => {
        // e1 corrupt (tds > amount): (100 − 500) + (1,000 − 0) = ₹600 — exactly what the bank line pays.
        await applyWith([
          { id: 'e1', amountPaise: 10_000n, tdsDeductedPaise: 50_000n },
          { id: 'e2', amountPaise: 100_000n, tdsDeductedPaise: 0n },
        ]);
        expect(mockNotifications.notifyUserWithChannels.mock.calls[0][0].vars.points).toBe(600);
      });

      it('never negative: an outlet whose total withholding exceeds its total sends no message', async () => {
        await applyWith([{ id: 'e1', amountPaise: 10_000n, tdsDeductedPaise: 50_000n }]);
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
      });

      it('a line fully absorbed by withholding sends NO "₹0 credited" message', async () => {
        await applyWith([{ id: 'e1', amountPaise: 20_000n, tdsDeductedPaise: 20_000n }]);
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
      });
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

    it('the dup-UTR guard is scoped to PAID entries so a FAILED attempt’s UTR never blocks a later payment', async () => {
      // The payout download being applied: one PROCESSING entry for O1 (no UTR yet).
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1', downloadCode, period: '2026-05', downloadedBy: 'g1',
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: BigInt(10000) }],
      });
      // FIX-C: the in-tx fresh read.
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([
        { id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: BigInt(10000), tdsDeductedPaise: 0n, tdsSection: null, period: '2026-05' },
      ]);
      // Simulate the DB for the dup-UTR guard query: a FAILED entry on a DIFFERENT outlet (O2)
      // carries the reference 'UTR123456' (its failed-attempt UTR). The guard must only see PAID
      // entries — so a PAID-scoped query excludes the FAILED one (returns []); an (old, buggy)
      // unscoped query would surface it. This mock HONOURS the where.status so the test proves the
      // scope, not just asserts the argument.
      mockPrisma.creditPayoutEntry.findMany.mockImplementation(async (arg: { where?: { status?: string } }) =>
        arg?.where?.status === 'PAID' ? [] : [{ utr: 'UTR123456', outletId: 'O2' }],
      );
      // Bank account for O1 (the only outletCode needed — usedUtrs is empty under the PAID scope).
      mockPrisma.outlet.findMany.mockResolvedValue([
        { outletCode: 'O1', name: 'A', partnerId: 'p1', partner: { ownerName: 'Ravi', phone: '', bankAccountNumber: 'ACC1' } },
      ]);

      // O1 is paid with a UTR that MATCHES the FAILED O2 reference. Under the PAID scope this is NOT
      // a duplicate (the FAILED reference never moved money), so the payment must apply.
      const file = buildUtrFile([[downloadCode, 'O1', 'UTR123456', 'Success', '']]);
      const res = (await service.uploadUtr(gifsy, 'd1', file, true)) as { applied: boolean; paidCount: number };

      // (1) The dup-detection findMany (select { utr, outletId }) is scoped to status:'PAID'.
      const dedupCall = mockPrisma.creditPayoutEntry.findMany.mock.calls.find(
        ([a]) => a?.select?.utr === true && a?.select?.outletId === true,
      )![0];
      expect(dedupCall.where).toMatchObject({ clientId: 'deoleo', status: 'PAID', utr: { not: null } });

      // (2) Behavioural: the SUCCESS row was NOT rejected as a duplicate — it applied as PAID.
      expect(res.applied).toBe(true);
      expect(res.paidCount).toBe(1);
      const flip = mockTx.creditPayoutEntry.updateMany.mock.calls.find(([a]) => a.where.id?.in?.includes('e1'))![0];
      expect(flip.data.status).toBe('PAID');
      expect(flip.data.utr).toBe('UTR123456');
    });

    // ── Re-apply idempotency (retry after a proxy timeout / concurrent double-apply) ────────────
    // A small STATEFUL fake of the DB: entries + the download row. Guarded flips and the
    // conditional download-status write mutate it exactly as Postgres would, so a second apply
    // sees what the first one committed.
    describe('re-apply idempotency (notifications + download status follow ACTUAL flips)', () => {
      type Ent = {
        id: string; outletId: string; status: string; utr: string | null; amountPaise: bigint;
        tdsDeductedPaise: bigint; tdsSection: string | null; period: string; paidAt?: Date | null;
      };
      let entries: Ent[];
      let dl: { status: string };

      const snapshot = () => ({
        id: 'd1', downloadCode, period: '2026-05', downloadedBy: 'g1', status: dl.status,
        entries: entries.map((e) => ({ ...e })),
      });

      function setupDb(initial: Ent[], downloadStatus = 'OPEN') {
        entries = initial.map((e) => ({ ...e }));
        dl = { status: downloadStatus };
        mockPrisma.creditPayoutDownload.findFirst.mockImplementation(async () => snapshot());
        // used-UTR dedup query (PAID entries carrying a UTR)
        mockPrisma.creditPayoutEntry.findMany.mockImplementation(async () =>
          entries.filter((e) => e.status === 'PAID' && e.utr).map((e) => ({ utr: e.utr, outletId: e.outletId })),
        );
        mockPrisma.outlet.findMany.mockResolvedValue(
          entries.map((e) => ({
            outletCode: e.outletId, name: e.outletId, partnerId: `p-${e.outletId}`,
            partner: { ownerName: `Owner ${e.outletId}`, phone: `99000000${e.outletId.slice(1).padStart(2, '0')}`, bankAccountNumber: `ACC-${e.outletId}` },
          })),
        );
        mockTx.creditPayoutEntry.findMany.mockImplementation(async () => entries.map((e) => ({ ...e })));
        mockTx.creditPayoutEntry.updateMany.mockImplementation(
          async (arg: { where: { id: { in: string[] }; status: string }; data: Record<string, unknown> }) => {
            let count = 0;
            for (const e of entries) {
              if (arg.where.id.in.includes(e.id) && e.status === arg.where.status) {
                Object.assign(e, arg.data);
                count++;
              }
            }
            return { count };
          },
        );
        mockTx.creditPayoutDownload.updateMany.mockImplementation(
          async (arg: { where: { status: { not: string } }; data: { status: string } }) => {
            if (dl.status === arg.where.status.not) return { count: 0 };
            dl.status = arg.data.status;
            return { count: 1 };
          },
        );
        mockTx.tdsDeductionEntry.findMany.mockResolvedValue([{ creditPayoutEntryId: 'e2', panNumber: 'PAN2' }]);
      }

      const ent = (id: string, outletId: string, over: Partial<Ent> = {}): Ent => ({
        id, outletId, status: 'PROCESSING', utr: null, amountPaise: 10000n,
        tdsDeductedPaise: 0n, tdsSection: null, period: '2026-05', ...over,
      });
      const notifiedPhones = () =>
        mockNotifications.notifyUserWithChannels.mock.calls.map((c) => c[0].recipientPhone as string);

      // O1 paid, O2 bank-FAILED (carried a DEDUCT withholding → reversed on FAILED).
      const mixedFile = () => buildUtrFile([
        [downloadCode, 'O1', 'UTR11112222', 'Success', ''],
        [downloadCode, 'O2', '', 'Failed', 'Account closed'],
      ]);

      it('first apply notifies exactly once per flipped PAID entry; re-applying the SAME file is a no-op', async () => {
        setupDb([ent('e1', 'O1'), ent('e2', 'O2', { tdsDeductedPaise: 50000n, tdsSection: 'SEC_194C' })]);

        const first = await service.uploadUtr(gifsy, 'd1', mixedFile(), true);
        expect(first).toMatchObject({ applied: true, noop: false, paidCount: 1, failedCount: 1, skippedCount: 0 });
        expect(notifiedPhones()).toEqual(['9900000001']); // only the PAID outlet, once
        expect(dl.status).toBe('PAID'); // every entry settled (PAID + FAILED)
        expect(mockTx.tdsDeductionEntry.createMany).toHaveBeenCalledTimes(1); // FAILED reversal once
        expect(mockTx.autoInvoice.updateMany).toHaveBeenCalledTimes(1);

        // Retry of the identical file (the admin re-clicks after a proxy timeout). O1 parses as SKIP,
        // O2 (FAILED) parses OK but its guarded flip matches nothing.
        const again = await service.uploadUtr(gifsy, 'd1', mixedFile(), true);
        expect(again).toMatchObject({
          applied: true, noop: true, paidCount: 0, failedCount: 0, skippedCount: 2,
          message: 'Already applied — nothing to change',
        });
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1); // no duplicate message
        expect(dl.status).toBe('PAID'); // NOT flipped to PARTIALLY_PAID by the FAILED/SKIP rows
        expect(mockTx.creditPayoutDownload.updateMany.mock.calls.at(-1)![0].where.status).toEqual({ not: 'PAID' });
        expect(mockTx.tdsDeductionEntry.createMany).toHaveBeenCalledTimes(1); // reversal NOT repeated
        expect(mockTx.autoInvoice.updateMany).toHaveBeenCalledTimes(1); // no re-lock attempt
        expect(entries.map((e) => e.status)).toEqual(['PAID', 'FAILED']);
      });

      it('an all-already-applied file applies as a no-op (no entry writes, no notifications) and previews as noop', async () => {
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' }), ent('e2', 'O2', { status: 'PAID', utr: 'UTR33334444' })], 'PAID');
        const file = () => buildUtrFile([
          [downloadCode, 'O1', 'UTR11112222', 'Success', ''],
          [downloadCode, 'O2', 'UTR33334444', 'Success', ''],
        ]);

        const preview = (await service.uploadUtr(gifsy, 'd1', file(), false)) as {
          parseResult: { canProceed: boolean; noop: boolean; summary: { ok: number; skipped: number; errors: number } };
        };
        expect(preview.parseResult).toMatchObject({ canProceed: true, noop: true, summary: { ok: 0, skipped: 2, errors: 0 } });

        const res = await service.uploadUtr(gifsy, 'd1', file(), true);
        expect(res).toEqual({
          applied: true, noop: true, paidCount: 0, failedCount: 0, skippedCount: 2, notApplied: [],
          notices: [
            { outletId: 'O1', rowNum: 3, notice: 'Already paid — no change.' },
            { outletId: 'O2', rowNum: 4, notice: 'Already paid — no change.' },
          ],
          message: 'Already applied — nothing to change',
        });
        // Only the locked, conditional status recompute runs — already PAID → nothing written.
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
        expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1); // the same UTR advisory lock
        expect(mockTx.creditPayoutEntry.updateMany).not.toHaveBeenCalled();
        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
        expect(mockTx.autoInvoice.updateMany).not.toHaveBeenCalled();
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
        expect(dl.status).toBe('PAID');
      });

      it('a no-op re-upload repairs a download stuck at PARTIALLY_PAID (old rule) when every entry is settled', async () => {
        // Stuck by the old parse-row rule: entries all settled, download still PARTIALLY_PAID.
        setupDb(
          [ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' }), ent('e2', 'O2', { status: 'FAILED' })],
          'PARTIALLY_PAID',
        );
        const res = await service.uploadUtr(gifsy, 'd1', buildUtrFile([
          [downloadCode, 'O1', 'UTR11112222', 'Success', ''],
          [downloadCode, 'O2', '', 'Failed', 'Account closed'],
        ]), true);
        expect(res).toMatchObject({ noop: true, paidCount: 0, failedCount: 0, skippedCount: 2 });
        expect(dl.status).toBe('PAID');
        expect(mockTx.creditPayoutEntry.updateMany).not.toHaveBeenCalled();
        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
        expect(mockTx.autoInvoice.updateMany).not.toHaveBeenCalled();
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
        expect(entries.map((e) => e.status)).toEqual(['PAID', 'FAILED']);
      });

      it('a Success row for an already-FAILED entry is an ERROR (never a silent skip / false "already applied")', async () => {
        setupDb([ent('e1', 'O1', { status: 'FAILED' })], 'PAID');
        const file = () => buildUtrFile([[downloadCode, 'O1', 'UTR11112222', 'Success', '']]);

        const preview = (await service.uploadUtr(gifsy, 'd1', file(), false)) as {
          parseResult: { canProceed: boolean; noop: boolean; rows: Array<{ status: string; errors: string[] }> };
        };
        expect(preview.parseResult.canProceed).toBe(false);
        expect(preview.parseResult.noop).toBe(false);
        expect(preview.parseResult.rows[0].status).toBe('ERROR');
        expect(preview.parseResult.rows[0].errors.join(' ')).toMatch(/marked FAILED and will be re-banked in the next payout file/);

        await expect(service.uploadUtr(gifsy, 'd1', file(), true)).rejects.toBeInstanceOf(BadRequestException);
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
        expect(entries[0].status).toBe('FAILED');
      });

      it('a REVERSED entry is an ERROR row', async () => {
        setupDb([ent('e2', 'O2', { status: 'REVERSED' })]);
        const preview = (await service.uploadUtr(gifsy, 'd1', buildUtrFile([
          [downloadCode, 'O2', 'UTR33334444', 'Success', ''],
        ]), false)) as { parseResult: { canProceed: boolean; rows: Array<{ status: string; errors: string[] }> } };
        expect(preview.parseResult.canProceed).toBe(false);
        expect(preview.parseResult.rows[0].status).toBe('ERROR');
        expect(preview.parseResult.rows[0].errors.join(' ')).toMatch(/has been reversed/);
      });

      it('a Failed row on an all-PAID outlet is a NON-blocking notice (reversal hint), never a write', async () => {
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' })], 'PAID');
        const file = () => buildUtrFile([[downloadCode, 'O1', '', 'Failed', 'bounced']]);
        const preview = (await service.uploadUtr(gifsy, 'd1', file(), false)) as {
          parseResult: { canProceed: boolean; noop: boolean; rows: Array<{ status: string; notice?: string }> };
        };
        expect(preview.parseResult).toMatchObject({ canProceed: true, noop: true });
        expect(preview.parseResult.rows[0]).toMatchObject({
          status: 'SKIP',
          notice: "Already marked PAID — no change. If the bank returned this payment, don't raise a reversal — contact Gifsy ops to correct it.",
        });
        const res = await service.uploadUtr(gifsy, 'd1', file(), true);
        // NOT "Already applied" — the row disagrees with the record, so it is flagged for review.
        expect(res).toMatchObject({ noop: true, paidCount: 0, failedCount: 0, skippedCount: 1, message: 'Nothing changed — 1 row has a notice to review.' });
        expect(mockTx.creditPayoutEntry.updateMany).not.toHaveBeenCalled();
        expect(entries[0].status).toBe('PAID');
      });

      it('a Success row on an all-PAID outlet with a DIFFERENT UTR is a SKIP naming both UTRs', async () => {
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' })], 'PAID');
        const res = await service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O1', 'UTR99998888', 'Success', '']]), true);
        expect(res).toMatchObject({
          noop: true,
          notices: [{ outletId: 'O1', notice: 'Already paid with UTR UTR11112222 — no change (file has UTR99998888).' }],
          message: 'Nothing changed — 1 row has a notice to review.',
        });
        expect(entries[0]).toMatchObject({ status: 'PAID', utr: 'UTR11112222' });
      });

      it('partly-settled outlet: a row CONTRADICTING the settled sibling is an ERROR (both directions)', async () => {
        // FAILED + PROCESSING with a Success row → would pay the rest while the failed part is re-banked.
        setupDb([ent('e1', 'O1', { status: 'FAILED' }), ent('e2', 'O1')]);
        const a = (await service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O1', 'UTR11112222', 'Success', '']]), false)) as {
          parseResult: { canProceed: boolean; rows: Array<{ status: string; errors: string[] }> };
        };
        expect(a.parseResult.canProceed).toBe(false);
        expect(a.parseResult.rows[0].errors.join(' ')).toMatch(/already partly marked FAILED/);
        await expect(
          service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O1', 'UTR11112222', 'Success', '']]), true),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(entries.map((e) => e.status)).toEqual(['FAILED', 'PROCESSING']);

        // PAID + PROCESSING with a Failed row → one bank line both paid and failed.
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' }), ent('e2', 'O1')]);
        const b = (await service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O1', '', 'Failed', 'bounced']]), false)) as {
          parseResult: { canProceed: boolean; rows: Array<{ status: string; errors: string[] }> };
        };
        expect(b.parseResult.canProceed).toBe(false);
        expect(b.parseResult.rows[0].errors.join(' ')).toMatch(/already partly marked PAID/);
        await expect(
          service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O1', '', 'Failed', 'bounced']]), true),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(entries.map((e) => e.status)).toEqual(['PAID', 'PROCESSING']);
        expect(mockTx.creditPayoutEntry.updateMany).not.toHaveBeenCalled();
      });

      it('partly-settled outlet: a CONSISTENT Failed row heals FAILED + PROCESSING (rest → FAILED)', async () => {
        setupDb([ent('e1', 'O1', { status: 'FAILED' }), ent('e2', 'O1')], 'PARTIALLY_PAID');
        const res = await service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O1', '', 'Failed', 'bounced']]), true);
        expect(res).toMatchObject({ failedCount: 1, paidCount: 0, noop: false });
        expect(entries.map((e) => e.status)).toEqual(['FAILED', 'FAILED']);
        expect(dl.status).toBe('PAID');
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
      });

      it('partly-settled outlet: a consistent Success row with a DIFFERENT UTR heals PAID + PROCESSING, with a notice', async () => {
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222', amountPaise: 40000n }), ent('e2', 'O1', { amountPaise: 60000n })], 'PARTIALLY_PAID');
        const res = await service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O1', 'UTR99998888', 'Success', '']]), true);
        expect(res).toMatchObject({
          paidCount: 1, noop: false,
          notices: [{ outletId: 'O1', notice: "Part of this outlet's payout was already paid with UTR UTR11112222; the rest will be recorded with UTR99998888." }],
        });
        expect(entries.map((e) => [e.status, e.utr])).toEqual([['PAID', 'UTR11112222'], ['PAID', 'UTR99998888']]);
        // The outlet was already told it was credited when the sibling flipped → no second message.
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
        expect(dl.status).toBe('PAID');
      });

      it('a duplicate row for the same outlet (Failed then Success) is an ERROR and blocks the apply', async () => {
        setupDb([ent('e1', 'O1'), ent('e2', 'O2')]);
        const file = () => buildUtrFile([
          [downloadCode, 'O1', 'UTR11112222', 'Success', ''],
          [downloadCode, 'O2', '', 'Failed', 'bounced'],
          [downloadCode, 'O2', 'UTR33334444', 'Success', ''],
        ]);
        const preview = (await service.uploadUtr(gifsy, 'd1', file(), false)) as {
          parseResult: { canProceed: boolean; rows: Array<{ outletId: string; status: string; errors: string[] }> };
        };
        expect(preview.parseResult.canProceed).toBe(false);
        expect(preview.parseResult.rows.map((r) => r.status)).toEqual(['OK', 'OK', 'ERROR']);
        expect(preview.parseResult.rows[2].errors[0]).toMatch(/appears more than once/);

        await expect(service.uploadUtr(gifsy, 'd1', file(), true)).rejects.toBeInstanceOf(BadRequestException);
        expect(mockTx.creditPayoutEntry.updateMany).not.toHaveBeenCalled();
        expect(entries.map((e) => e.status)).toEqual(['PROCESSING', 'PROCESSING']);
      });

      it('real parse errors are still rejected even when the other rows are already applied', async () => {
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' }), ent('e2', 'O2')]);
        const file = buildUtrFile([
          [downloadCode, 'O1', 'UTR11112222', 'Success', ''], // SKIP
          [downloadCode, 'O2', 'X1', 'Success', ''], // bad UTR → ERROR
        ]);
        await expect(service.uploadUtr(gifsy, 'd1', file, true)).rejects.toBeInstanceOf(BadRequestException);
        const unknown = buildUtrFile([
          [downloadCode, 'O1', 'UTR11112222', 'Success', ''], // SKIP
          [downloadCode, 'O9', 'UTR55556666', 'Success', ''], // outlet not in batch → ERROR
        ]);
        await expect(service.uploadUtr(gifsy, 'd1', unknown, true)).rejects.toBeInstanceOf(BadRequestException);
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
      });

      it('a mixed file (some already applied, some new) notifies ONLY the newly flipped entries', async () => {
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' }), ent('e2', 'O2'), ent('e3', 'O3')], 'PARTIALLY_PAID');
        const file = buildUtrFile([
          [downloadCode, 'O1', 'UTR11112222', 'Success', ''], // already applied → SKIP
          [downloadCode, 'O2', 'UTR33334444', 'Success', ''], // new PAID
          [downloadCode, 'O3', 'UTR55556666', 'Success', ''], // new PAID
        ]);
        const res = await service.uploadUtr(gifsy, 'd1', file, true);
        expect(res).toMatchObject({ noop: false, paidCount: 2, failedCount: 0, skippedCount: 1 });
        expect(res).not.toHaveProperty('message');
        expect(notifiedPhones().sort()).toEqual(['9900000002', '9900000003']);
        expect(dl.status).toBe('PAID');
        expect(mockTx.autoInvoice.updateMany.mock.calls[0][0].where.outletCode.in).toEqual(['O2', 'O3']);
      });

      it('concurrent double-apply (second call parsed a stale pre-commit snapshot) sends ONE notification set total', async () => {
        setupDb([ent('e1', 'O1'), ent('e2', 'O2', { tdsDeductedPaise: 50000n, tdsSection: 'SEC_194C' })]);
        const stale = snapshot(); // both callers read the download while every entry was PROCESSING

        await service.uploadUtr(gifsy, 'd1', mixedFile(), true); // first commits
        // Second caller: its pre-tx read happened BEFORE the first commit (rows parse OK, not SKIP),
        // then it waited on the advisory lock; inside the tx it sees the committed state.
        mockPrisma.creditPayoutDownload.findFirst.mockResolvedValueOnce(stale);
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValueOnce([]);
        const second = await service.uploadUtr(gifsy, 'd1', mixedFile(), true);

        // The stale-parsed OK rows flipped nothing → listed as notApplied (NOT "Already applied").
        expect(second).toMatchObject({ noop: true, paidCount: 0, failedCount: 0, skippedCount: 0 });
        expect((second as { notApplied: Array<{ outletId: string }> }).notApplied.map((n) => n.outletId)).toEqual(['O1', 'O2']);
        expect((second as { message: string }).message).toMatch(/^Nothing changed — 2 rows were not applied/);
        expect(notifiedPhones()).toEqual(['9900000001']);
        expect(mockTx.tdsDeductionEntry.createMany).toHaveBeenCalledTimes(1);
        expect(dl.status).toBe('PAID');
        expect(mockTx.autoInvoice.updateMany).toHaveBeenCalledTimes(1);
      });

      it('multi-entry outlet (₹600 + ₹400): one Success row flips BOTH, ONE notification of ₹1,000, download PAID; re-apply no-op', async () => {
        setupDb([ent('e1', 'O1', { amountPaise: 60000n }), ent('e2', 'O1', { amountPaise: 40000n })]);
        const file = () => buildUtrFile([[downloadCode, 'O1', 'UTR11112222', 'Success', '']]);

        const res = await service.uploadUtr(gifsy, 'd1', file(), true);
        expect(res).toMatchObject({ noop: false, paidCount: 1, failedCount: 0, skippedCount: 0, notApplied: [] });
        expect(entries.map((e) => e.status)).toEqual(['PAID', 'PAID']);
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
        expect(mockNotifications.notifyUserWithChannels.mock.calls[0][0].vars.points).toBe(1000);
        expect(dl.status).toBe('PAID');

        const again = await service.uploadUtr(gifsy, 'd1', file(), true);
        expect(again).toMatchObject({ noop: true, paidCount: 0, skippedCount: 1, message: 'Already applied — nothing to change' });
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(1);
      });

      it('multi-entry outlet: a Failed row flips BOTH entries and reverses EACH entry\'s withholding once', async () => {
        setupDb([
          ent('e1', 'O1', { amountPaise: 60000n, tdsDeductedPaise: 600n, tdsSection: 'SEC_194C' }),
          ent('e2', 'O1', { amountPaise: 40000n, tdsDeductedPaise: 400n, tdsSection: 'SEC_194C' }),
        ]);
        mockTx.tdsDeductionEntry.findMany.mockResolvedValue([
          { creditPayoutEntryId: 'e1', panNumber: 'PAN1' },
          { creditPayoutEntryId: 'e2', panNumber: 'PAN1' },
        ]);
        const file = () => buildUtrFile([[downloadCode, 'O1', '', 'Failed', 'Account closed']]);

        const res = await service.uploadUtr(gifsy, 'd1', file(), true);
        expect(res).toMatchObject({ paidCount: 0, failedCount: 1, noop: false });
        expect(entries.map((e) => [e.status, e.tdsDeductedPaise])).toEqual([['FAILED', 0n], ['FAILED', 0n]]);
        const rev = mockTx.tdsDeductionEntry.createMany.mock.calls[0][0].data as Array<{ creditPayoutEntryId: string; tdsDeductedThisPaise: bigint }>;
        expect(rev.map((r) => [r.creditPayoutEntryId, r.tdsDeductedThisPaise])).toEqual([['e1', -600n], ['e2', -400n]]);
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
        expect(dl.status).toBe('PAID'); // all settled

        // Re-apply: the outlet's group is all FAILED + a Failed row → genuine SKIP notice, no-op.
        const preview = (await service.uploadUtr(gifsy, 'd1', file(), false)) as {
          parseResult: { noop: boolean; rows: Array<{ status: string; notice?: string }> };
        };
        expect(preview.parseResult.noop).toBe(true);
        expect(preview.parseResult.rows[0]).toMatchObject({ status: 'SKIP', notice: 'Already marked failed — no change.' });
        await service.uploadUtr(gifsy, 'd1', file(), true);
        expect(mockTx.tdsDeductionEntry.createMany).toHaveBeenCalledTimes(1); // no second reversal
      });

      it('heals a multi-entry outlet left half-flipped by the old last-entry-wins bug (PAID + PROCESSING)', async () => {
        const siblingPaidAt = new Date('2026-06-02T06:30:00.000Z');
        setupDb([ent('e1', 'O1', { amountPaise: 60000n }), ent('e2', 'O1', { status: 'PAID', utr: 'UTR11112222', amountPaise: 40000n, paidAt: siblingPaidAt })], 'PARTIALLY_PAID');
        // Group is still PENDING (e1 awaiting) → the row is OK, the re-apply exemption covers the UTR.
        const res = await service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O1', 'UTR11112222', 'Success', '']]), true);
        expect(res).toMatchObject({ paidCount: 1, noop: false });
        expect(entries.map((e) => e.status)).toEqual(['PAID', 'PAID']);
        // Blank Payment Date → the healed entry takes the PAID sibling's paidAt (the line's real date).
        expect(entries[0].paidAt).toEqual(siblingPaidAt);
        // No second "credited" message for a heal (the sibling's flip already notified the outlet).
        expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
        // The SERVICE invoice is still locked for the healed outlet (idempotent lockedAt:null guard).
        expect(mockTx.autoInvoice.updateMany.mock.calls[0][0].where.outletCode.in).toEqual(['O1']);
        expect(dl.status).toBe('PAID');
      });

      it('one guarded updateMany per outlet (bank line), not one round-trip per entry', async () => {
        setupDb([ent('e1', 'O1'), ent('e2', 'O1'), ent('e3', 'O1'), ent('e4', 'O2')]);
        await service.uploadUtr(gifsy, 'd1', buildUtrFile([
          [downloadCode, 'O1', 'UTR11112222', 'Success', ''],
          [downloadCode, 'O2', 'UTR33334444', 'Success', ''],
        ]), true);
        const flips = mockTx.creditPayoutEntry.updateMany.mock.calls.map((c) => c[0].where);
        expect(flips).toEqual([
          { id: { in: ['e1', 'e2', 'e3'] }, status: 'PROCESSING' },
          { id: { in: ['e4'] }, status: 'PROCESSING' },
        ]);
        expect(mockNotifications.notifyUserWithChannels).toHaveBeenCalledTimes(2);
      });

      // Former outlets: in this download's bankSnapshots but no longer holding an entry here. Their
      // fate is classified from the DB (entries for the outlet + period), never assumed.
      function withFormer(
        snapshotIds: string[],
        formerEntries: Array<{ outletId: string; status: string; downloadId: string | null }>,
      ) {
        mockPrisma.creditPayoutDownload.findFirst.mockImplementation(async () => ({
          ...snapshot(),
          bankSnapshots: snapshotIds.map((outletId) => ({ outletId })),
        }));
        const dedup = mockPrisma.creditPayoutEntry.findMany.getMockImplementation()!;
        mockPrisma.creditPayoutEntry.findMany.mockImplementation(
          async (arg: { where: { outletId?: { in: string[] }; period?: string } }) =>
            arg?.where?.outletId
              ? formerEntries.filter((e) => arg.where.outletId!.in.includes(e.outletId))
              : dedup(arg),
        );
      }
      const formerFile = (outcome: 'Success' | 'Failed') =>
        buildUtrFile([
          [downloadCode, 'O1', 'UTR11112222', 'Success', ''],
          [downloadCode, 'O2', outcome === 'Success' ? 'UTR55556666' : '', outcome, ''],
        ]);
      const previewRow = async (outcome: 'Success' | 'Failed') =>
        ((await service.uploadUtr(gifsy, 'd1', formerFile(outcome), false)) as {
          parseResult: { canProceed: boolean; rows: Array<{ outletId: string; status: string; errors: string[]; notice?: string }> };
        }).parseResult;

      it('former outlet classification query is tenant + outlet + period scoped', async () => {
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' })], 'PAID');
        withFormer(['O1', 'O2'], [{ outletId: 'O2', status: 'PROCESSING', downloadId: 'd2' }]);
        await previewRow('Failed');
        const q = mockPrisma.creditPayoutEntry.findMany.mock.calls.find(([a]) => a?.where?.outletId)![0];
        expect(q.where).toEqual({ clientId: 'deoleo', outletId: { in: ['O2'] }, period: '2026-05' });
      });

      it('re-banked outlet: Failed row → non-blocking "Re-banked" notice; Success row → blocking ERROR', async () => {
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' })], 'PAID');
        withFormer(['O1', 'O2'], [{ outletId: 'O2', status: 'PROCESSING', downloadId: 'd2' }]);

        const res = await service.uploadUtr(gifsy, 'd1', formerFile('Failed'), true);
        expect(res).toMatchObject({
          noop: true, skippedCount: 2,
          notices: [
            { outletId: 'O1', notice: 'Already paid — no change.' },
            { outletId: 'O2', notice: 'Re-banked in a later payout file — no change.' },
          ],
          message: 'Nothing changed — 1 row has a notice to review.',
        });
        expect(mockTx.creditPayoutEntry.updateMany).not.toHaveBeenCalled();

        const p = await previewRow('Success');
        expect(p.canProceed).toBe(false);
        expect(p.rows[1]).toMatchObject({
          status: 'ERROR',
          errors: ['This payout was re-banked in a later file and may be paid again — remove this row and contact Gifsy ops.'],
        });
        await expect(service.uploadUtr(gifsy, 'd1', formerFile('Success'), true)).rejects.toBeInstanceOf(BadRequestException);
      });

      it('reversed outlet: Failed row → non-blocking "Reversed" notice; Success row → blocking ERROR', async () => {
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' })], 'PAID');
        withFormer(['O1', 'O2'], [{ outletId: 'O2', status: 'REVERSED', downloadId: null }]);

        const f = await previewRow('Failed');
        expect(f.canProceed).toBe(true);
        expect(f.rows[1]).toMatchObject({ status: 'SKIP', notice: 'Reversed — no change.' });

        const p = await previewRow('Success');
        expect(p.canProceed).toBe(false);
        expect(p.rows[1].status).toBe('ERROR');
        expect(p.rows[1].errors[0]).toMatch(/was reversed — it can't be marked paid/);
      });

      it('outlet HELD at download (PENDING, no download) → blocking ERROR for ANY row, never a silent skip', async () => {
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' })], 'PAID');
        withFormer(['O1', 'O2'], [{ outletId: 'O2', status: 'PENDING', downloadId: null }]);
        const heldMsg =
          'This outlet was held at download (e.g. KYC) — it was not in this bank file. Remove this row; if it was paid by hand, contact Gifsy ops before it is released.';
        for (const outcome of ['Success', 'Failed'] as const) {
          const p = await previewRow(outcome);
          expect(p.canProceed).toBe(false);
          expect(p.rows[1]).toMatchObject({ status: 'ERROR', errors: [heldMsg] });
          await expect(service.uploadUtr(gifsy, 'd1', formerFile(outcome), true)).rejects.toBeInstanceOf(BadRequestException);
        }
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      it('a former outlet with no classifiable entry, or an outlet in neither list, stays a "not found" ERROR', async () => {
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' })], 'PAID');
        withFormer(['O1', 'O2'], []); // O2 in the snapshot but no entry for this period
        const p = await previewRow('Failed');
        expect(p.rows[1].status).toBe('ERROR');
        expect(p.rows[1].errors.join(' ')).toMatch(/not found in batch/);

        await expect(service.uploadUtr(gifsy, 'd1', buildUtrFile([
          [downloadCode, 'O1', 'UTR11112222', 'Success', ''],
          [downloadCode, 'O9', 'UTR55556666', 'Success', ''],
        ]), true)).rejects.toBeInstanceOf(BadRequestException);
      });

      it('every outlet moved out of the download → still parses (notices), not "No payout entries found"', async () => {
        setupDb([], 'PAID');
        withFormer(['O2'], [{ outletId: 'O2', status: 'FAILED', downloadId: 'd2' }]);
        const res = await service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O2', '', 'Failed', 'bounced']]), true);
        expect(res).toMatchObject({ noop: true, skippedCount: 1, paidCount: 0 });
      });

      it('a settled outlet that is partly PAID and partly FAILED is an ERROR row (MIXED)', async () => {
        setupDb([ent('e1', 'O1', { status: 'PAID', utr: 'UTR11112222' }), ent('e2', 'O1', { status: 'FAILED' })]);
        const preview = (await service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O1', 'UTR11112222', 'Success', '']]), false)) as {
          parseResult: { canProceed: boolean; rows: Array<{ status: string; errors: string[] }> };
        };
        expect(preview.parseResult.canProceed).toBe(false);
        expect(preview.parseResult.rows[0].status).toBe('ERROR');
        expect(preview.parseResult.rows[0].errors.join(' ')).toMatch(/partly PAID and partly FAILED/);
      });

      it('download status follows LIVE entry statuses: partial file → PARTIALLY_PAID, rest → PAID', async () => {
        setupDb([ent('e1', 'O1'), ent('e2', 'O2')]);
        await service.uploadUtr(gifsy, 'd1', buildUtrFile([[downloadCode, 'O1', 'UTR11112222', 'Success', '']]), true);
        expect(dl.status).toBe('PARTIALLY_PAID'); // e2 still PROCESSING

        // Second file carries BOTH rows (O1 now SKIP) — O1 must not keep it partial.
        const res = await service.uploadUtr(gifsy, 'd1', buildUtrFile([
          [downloadCode, 'O1', 'UTR11112222', 'Success', ''],
          [downloadCode, 'O2', 'UTR33334444', 'Success', ''],
        ]), true);
        expect(res).toMatchObject({ paidCount: 1, skippedCount: 1, noop: false });
        expect(dl.status).toBe('PAID');
        expect(notifiedPhones()).toEqual(['9900000001', '9900000002']); // each outlet exactly once
      });
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

    // ── Whole-unit amounts (owner rule 2026-11-12: points + ₹ credited in whole units) ──

    describe('whole-unit amounts', () => {
      beforeEach(() => {
        mockCreditsPayouts.safetyCapPoints = 50000;
        mockCreditsPayouts.safetyCapInr = 100000;
        mockTx.creditBatch.create.mockResolvedValue({ id: 'b1' });
        pinDate('2026-06-10T08:00:00.000Z');
      });

      it('rejects a PAYOUT row that is not whole rupees (₹199.50 = 19950 paise)', async () => {
        const dto = batchDto('2026-06', CreditAwardType.PAYOUT, 19950);
        await expect(service.createBatch(admin, dto)).rejects.toThrow(/Payout amounts must be whole rupees/);
        expect(mockTx.creditBatch.create).not.toHaveBeenCalled();
      });

      it('accepts a whole-rupee PAYOUT row (₹200 = 20000 paise)', async () => {
        await expect(service.createBatch(admin, batchDto('2026-06', CreditAwardType.PAYOUT, 20000))).resolves.toBeDefined();
      });

      it('rejects a fractional POINTS row on the service path (engine/direct callers bypass the DTO pipe)', async () => {
        const dto = batchDto('2026-06', CreditAwardType.POINTS, 199.5);
        await expect(service.createBatch(admin, dto)).rejects.toThrow(/Points must be whole numbers/);
      });

      it('ignores non-OK rows', async () => {
        const dto = batchDto('2026-06', CreditAwardType.PAYOUT, 19950);
        (dto.rows[0] as unknown as { status: string }).status = 'ERROR';
        await expect(service.createBatch(admin, dto)).resolves.toBeDefined();
      });

      it('confirmBatch refuses a legacy PENDING batch holding fractional-rupee paise (before any write)', async () => {
        mockPrisma.creditBatch.findFirst.mockResolvedValue({
          id: 'b1', status: 'PENDING_CONFIRM', period: '2026-06', uploadedBy: 'admin1',
          totalOutlets: 1, totalPoints: 0, totalPayoutPaise: BigInt(19950),
          rows: [{ outletId: 'O1', outletName: 'A', fieldId: 'f1', fieldName: 'F', amount: 19950, narration: '', awardType: 'PAYOUT', status: 'OK' }],
        });
        await expect(service.confirmBatch(admin, 'b1')).rejects.toThrow(/Payout amounts must be whole rupees/);
        expect(mockTx.creditPayoutEntry.createMany).not.toHaveBeenCalled();
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
    /**
     * Owner 2026-11-25 ("TDS invoice only on success"): the bank file raises NO 194C gross-up / no-PAN TDS; it is raised
     * when the payouts become PAID. Runs the PAID hook for the entries the LAST download put in its file (the payee =
     * the PAN snapshot taken then), against the same plan-read mocks the test set up.
     */
    async function payNow(period: string, clientId = 'deoleo') {
      const events = (await mockPrisma.creditPayoutEntry.findMany.mock.results.at(-1)?.value) ?? [];
      const outlets = (await mockPrisma.outlet.findMany.mock.results.at(-1)?.value) ?? [];
      const created = await mockTx.creditPayoutDownload.create.mock.results.at(-1)?.value;
      const panOf = new Map<string, string | null>(outlets.map((o: any) => [o.outletCode, o.partner?.panNumber ?? null]));
      const paidEntries = events.map((e: any) => ({
        id: e.id,
        outletId: e.outletId,
        fieldId: e.fieldId,
        amountPaise: e.amountPaise,
        tdsSection: e.tdsSection,
        tdsMethodology: e.tdsMethodology,
        payeePan: panOf.get(e.outletId)?.trim() ? panOf.get(e.outletId)! : `__NO_PAN__:${e.outletId}`,
      }));
      // Queue the hook's own two reads ONLY when it will make them (194C gross-up or no-PAN rows) — a queued value it
      // never reads would leak into the next test.
      const raises = paidEntries.some((e: any) => e.tdsSection === 'SEC_194C' && e.tdsMethodology);
      if (raises) {
        mockTx.creditField.findMany.mockResolvedValueOnce([...new Set(events.map((e: any) => e.fieldId))].map((id) => ({ id })));
        mockTx.outlet.findMany.mockResolvedValueOnce(outlets);
      }
      return service.recordGrossUpOnPaid(mockTx as never, { clientId, period, downloadId: created?.id ?? 'd1', paidEntries });
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

    // ── GROSS-UP: nothing at the bank file; raised when PAID (owner 2026-11-25) ───────────
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
      // Nothing is invoiced at the bank file any more.
      expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
      expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
      await payNow('2026-05');

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
        // Fund reconciliation (2026-11-24): the row stores the bank run that wrote it.
        downloadId: 'd1',
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
      // seq=2 (D8: highest existing 001 + 1), different period → not idempotent-skip
      mockTx.autoInvoice.findMany.mockResolvedValue([{ period: '2026-05', invoiceNumber: 'TGSL-TDS-PAN1-202627-001' }]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(1);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd2', downloadCode: 'PD-2026-06-001' });

      await service.createPayoutDownload(gifsy, { period: '2026-06', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });
      await payNow('2026-06');

      // The period-2 body is the DELTA (111100), NOT the cumulative dueNow (222200); seq=2, not anchor.
      expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({ bodyPaise: 111100n, seq: 2, isAnchor: false, period: '2026-06' }),
      );
      // Across the FY: period-1 body (111100) + period-2 body (111100) = 222200 = grossUp(₹2.2L).
    });

    it('FIX-1 (on PAID): a re-run / second result that changes nothing does NOT double-raise — the delta is the guard', async () => {
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([visEntry(11000000n, 'GROSS_UP')]);
      mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL')]);
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);
      mockTx.outlet.findMany.mockResolvedValue([{ outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' }]);
      mockTx.channelPartner.findMany.mockResolvedValue([{ id: 'p1', panNumber: 'PAN1' }]);
      // This month's top-up for the PAN was already raised for this base (recovered in full).
      mockTx.autoInvoice.findMany.mockResolvedValue([{ id: 'tdsA', period: '2026-05', invoiceNumber: 'TGSL-TDS-PAN1-202627-001' }]);
      mockTx.tdsRecoveryEntry.findMany.mockResolvedValue([{ panNumber: 'PAN1', section: 'SEC_194C', clientId: 'deoleo', tenantSharePaise: 111100n, tdsInvoiceId: 'tdsA' }]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-2026-05-004' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });
      const res = await payNow('2026-05');

      expect(res).toEqual({ invoices: 0, recoveryRows: 0 });
      expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
      expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
    });

    it('on PAID: a second bank result in the SAME month that pays more base raises its increment (no month-skip)', async () => {
      // Earlier result this month: ₹1,10,000 paid, 111100 recovered. Now another ₹1,10,000 paid (same PAN, same month).
      mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([{ ...visEntry(11000000n, 'GROSS_UP'), id: 'e2' }]);
      mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL')]);
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([{ clientId: 'deoleo', outletId: 'O1', amountPaise: 11000000n, tdsSection: 'SEC_194C', tdsMethodology: 'GROSS_UP' }]);
      mockTx.outlet.findMany.mockResolvedValue([{ outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' }]);
      mockTx.channelPartner.findMany.mockResolvedValue([{ id: 'p1', panNumber: 'PAN1' }]);
      mockTx.autoInvoice.findMany.mockResolvedValue([{ id: 'tdsA', period: '2026-05', invoiceNumber: 'TGSL-TDS-PAN1-202627-001' }]);
      mockTx.tdsRecoveryEntry.findMany.mockResolvedValue([{ panNumber: 'PAN1', section: 'SEC_194C', clientId: 'deoleo', tenantSharePaise: 111100n, tdsInvoiceId: 'tdsA' }]);
      mockPrisma.creditPayoutDownload.count.mockResolvedValue(1);
      mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd2', downloadCode: 'PD-2026-05-005' });

      await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });
      await payNow('2026-05');

      expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledTimes(1);
      expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(mockTx, expect.objectContaining({ bodyPaise: 111100n, seq: 2, period: '2026-05' }));
      // The lock that serialises it is the PAID-only key (the bank file never takes it).
      expect(mockTx.$executeRaw.mock.calls.some((c: unknown[]) => JSON.stringify(c).includes('GUPAID|PAN1|2026-27'))).toBe(true);
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
      await payNow('2026-05');

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
      // Every pro-rata row (this client's AND the other client's) names the run that wrote it.
      expect((recovery as Array<{ downloadId?: string }>).every((r) => r.downloadId === 'd1')).toBe(true);
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
      await payNow('2026-05', 'X');
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
      await payNow('2026-06', 'Y');

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

    // ── 194R is PER CLIENT (owner 2026-11-18); 194C stays cross-tenant by PAN (D7) ──
    describe('194R per-client scoping (owner 2026-11-18)', () => {
      /** This download's entry (tenant = the caller, 'deoleo') under the given section/method. */
      function secEntry(amountPaise: bigint, section: string, methodology: string) {
        return { id: 'e1', outletId: 'O1', outletName: 'A', amountPaise, fieldId: 'f-vis', tdsSection: section, tdsMethodology: methodology, batch: { batchCode: 'CB-1' } };
      }
      /** PAN1 is held by p1 (deoleo outlet O1) and p2 (tenant 'other' outlet OX). */
      function wirePan1BothTenants() {
        mockTx.outlet.findMany.mockResolvedValue([
          { outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' },
          { outletCode: 'OX', clientId: 'other', partnerId: 'p2' },
        ]);
        mockTx.channelPartner.findMany.mockResolvedValue([
          { id: 'p1', panNumber: 'PAN1' },
          { id: 'p2', panNumber: 'PAN1' },
        ]);
      }
      async function download(period = '2026-05') {
        mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
        mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: `PD-${period}-001` });
        await service.createPayoutDownload(gifsy, { period, groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });
        // Owner 2026-11-25: 194C gross-up / no-PAN TDS is raised when the file's payouts are PAID — never at the file.
        expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
        expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
        await payNow(period);
      }
      beforeEach(() => {
        mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
        mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL')]);
      });

      it.each(['GROSS_UP', 'DEDUCT'])(
        '194R %s: ₹15k under tenant A + ₹15k under tenant B (same PAN, same FY) → neither crosses ₹20k → no TDS',
        async (methodology) => {
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(1500000n, 'SEC_194R', methodology)]);
          // Tenant 'other' already paid PAN1 ₹15k under 194R this FY (committed).
          mockTx.creditPayoutEntry.findMany.mockResolvedValue([
            { clientId: 'other', outletId: 'OX', amountPaise: 1500000n, tdsSection: 'SEC_194R', tdsMethodology: methodology },
          ]);
          wirePan1BothTenants();

          await download();

          expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
          expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
          expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
          expect(mockTx.creditPayoutEntry.update).not.toHaveBeenCalled();
          // Paid in full.
          expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(1500000));
        },
      );

      it('194C (unchanged): the same ₹15k + ₹15k cross-tenant aggregate (₹30k) is below the ₹1L/₹30k-single 194C thresholds → no TDS', async () => {
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(1500000n, 'SEC_194C', 'GROSS_UP')]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { clientId: 'other', outletId: 'OX', amountPaise: 1500000n, tdsSection: 'SEC_194C', tdsMethodology: 'GROSS_UP' },
        ]);
        wirePan1BothTenants();

        await download();

        expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
        expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
      });

      it('194C (unchanged): cross-tenant aggregation still crosses — other ₹90k + this ₹15k = ₹1.05L → invoice + D10 pro-rata over BOTH tenants', async () => {
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(1500000n, 'SEC_194C', 'GROSS_UP')]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { clientId: 'other', outletId: 'OX', amountPaise: 9000000n, tdsSection: 'SEC_194C', tdsMethodology: 'GROSS_UP' },
        ]);
        wirePan1BothTenants();

        await download();

        // grossUp(₹1,05,000, 1/99) = 106060.6 → ₹1,061 = 106100 paise.
        expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(
          mockTx, expect.objectContaining({ bodyPaise: 106100n, panNumber: 'PAN1' }),
        );
        const recovery = mockTx.tdsRecoveryEntry.createMany.mock.calls[0][0].data as Array<{ clientId: string; tenantSharePaise: bigint }>;
        expect(recovery.map((r) => r.clientId).sort()).toEqual(['deoleo', 'other']);
        expect(recovery.reduce((s, r) => s + r.tenantSharePaise, 0n)).toBe(106100n);
      });

      it('audit fix 2026-11-26: a DEDUCT payout PAID by this client that crosses the PAN’s combined base raises the gross-up due on ANOTHER client’s gross-up base', async () => {
        // other: ₹90k GROSS_UP already PAID (alone below ₹1L). deoleo now pays ₹20k DEDUCT (withheld at its own bank
        // file) → combined ₹1.1L crosses → the GROSS_UP due on other's ₹90k = grossUp(₹90k, 1/99) = ₹909 → all to other.
        mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL')]);
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(2000000n, 'SEC_194C', 'DEDUCT')]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { clientId: 'other', outletId: 'OX', amountPaise: 9000000n, tdsSection: 'SEC_194C', tdsMethodology: 'GROSS_UP' },
        ]);
        wirePan1BothTenants();
        mockTx.tdsRecoveryEntry.findMany.mockResolvedValue([]);
        mockTx.autoInvoice.findMany.mockResolvedValue([]);

        await download(); // the bank file withholds deoleo's DEDUCT TDS; then the payout is PAID (payNow)

        expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(
          mockTx, expect.objectContaining({ panNumber: 'PAN1', bodyPaise: 90900n, outletCode: 'O1' }),
        );
        const recovery = mockTx.tdsRecoveryEntry.createMany.mock.calls[0][0].data as Array<{ clientId: string; tenantSharePaise: bigint; raisedOn: string }>;
        expect(recovery).toEqual([expect.objectContaining({ clientId: 'other', tenantSharePaise: 90900n, raisedOn: 'PAID' })]);
      });

      it('D7: a 194R GROSS_UP client crossing on ITS OWN aggregate raises NO TDS invoice and NO recovery row (report-only)', async () => {
        // deoleo: prior ₹15k + this ₹10k = ₹25k > ₹20k → crosses on its own.
        // other: prior ₹50k 194R + already recovered ₹5,556 + a 194R TDS invoice THIS period (seq 001).
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(1000000n, 'SEC_194R', 'GROSS_UP')]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { clientId: 'deoleo', outletId: 'O1', amountPaise: 1500000n, tdsSection: 'SEC_194R', tdsMethodology: 'GROSS_UP' },
          { clientId: 'other', outletId: 'OX', amountPaise: 5000000n, tdsSection: 'SEC_194R', tdsMethodology: 'GROSS_UP' },
        ]);
        wirePan1BothTenants();
        mockTx.tdsRecoveryEntry.findMany.mockImplementation(async (arg: { where?: { tdsInvoiceId?: unknown } }) =>
          arg?.where?.tdsInvoiceId
            ? [{ tdsInvoiceId: 'inv-other-1', section: 'SEC_194R' }]
            : [{ panNumber: 'PAN1', section: 'SEC_194R', clientId: 'other', tenantSharePaise: 555600n }],
        );
        mockTx.autoInvoice.findMany.mockResolvedValue([{ id: 'inv-other-1', clientId: 'other', period: '2026-05' }]);

        await download();

        // D7 (owner 2026-11-18): INVOICING IS 194C-ONLY. A 194R GROSS_UP crossing (₹25k > ₹20k for
        // this client) raises NO TDS invoice and NO TdsRecoveryEntry — the 194R report shows the
        // liability instead. The retailer is still paid in full (nothing withheld under GROSS_UP).
        expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
        expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
        expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(1000000));
      });

      it('D7: a 194R GROSS_UP payout far above the threshold (₹5L) still raises no invoice and no recovery row', async () => {
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(50000000n, 'SEC_194R', 'GROSS_UP')]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);
        wirePan1BothTenants();

        await download();

        expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
        expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
        // No invoice lookup is even needed for a 194R group.
        expect(mockTx.autoInvoice.findMany).not.toHaveBeenCalled();
      });

      it('194C DEDUCT (unchanged): the carry-forward still reads the CROSS-TENANT ledger', async () => {
        // OTHERS 2%. other ₹90k + this ₹20k = ₹1.1L → due ₹2,200; other already withheld ₹1,000 (cross-tenant).
        mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('OTHERS')]);
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(2000000n, 'SEC_194C', 'DEDUCT')]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { clientId: 'other', outletId: 'OX', amountPaise: 9000000n, tdsSection: 'SEC_194C', tdsMethodology: 'DEDUCT' },
        ]);
        wirePan1BothTenants();
        mockTx.tdsDeductionEntry.findMany.mockResolvedValue([
          { clientId: 'other', panNumber: 'PAN1', section: 'SEC_194C', tdsDeductedThisPaise: 100000n },
        ]);

        await download();

        const ledger = mockTx.tdsDeductionEntry.createMany.mock.calls[0][0].data[0];
        expect(ledger.tdsDueCumulativePaise).toBe(220000n);
        expect(ledger.tdsDeductedPriorPaise).toBe(100000n);
        expect(ledger.tdsDeductedThisPaise).toBe(120000n);
      });

      it('mixed sections: this tenant on 194R (GROSS_UP, crosses), tenant B on 194C (same PAN) → no 194R invoice/recovery (D7); B’s 194C data untouched', async () => {
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(2500000n, 'SEC_194R', 'GROSS_UP')]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { clientId: 'other', outletId: 'OX', amountPaise: 9000000n, tdsSection: 'SEC_194C', tdsMethodology: 'GROSS_UP' },
        ]);
        wirePan1BothTenants();
        mockTx.autoInvoice.findMany.mockResolvedValue([{ id: 'inv-other-c', clientId: 'other', period: '2026-05', invoiceNumber: 'TGSL-TDS-PAN1-202627-001' }]);

        await download();

        expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
        expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
      });

      it('mixed sections: this tenant on 194C, tenant B on 194R (same PAN) → 194C on its own cross-tenant rules; B’s 194R base/invoice ignored', async () => {
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(11000000n, 'SEC_194C', 'GROSS_UP')]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { clientId: 'other', outletId: 'OX', amountPaise: 5000000n, tdsSection: 'SEC_194R', tdsMethodology: 'GROSS_UP' },
        ]);
        wirePan1BothTenants();
        mockTx.tdsRecoveryEntry.findMany.mockImplementation(async (arg: { where?: { tdsInvoiceId?: unknown } }) =>
          arg?.where?.tdsInvoiceId
            ? [{ tdsInvoiceId: 'inv-other-r', section: 'SEC_194R' }]
            : [{ panNumber: 'PAN1', section: 'SEC_194R', clientId: 'other', tenantSharePaise: 555600n }],
        );
        mockTx.autoInvoice.findMany.mockResolvedValue([{ id: 'inv-other-r', clientId: 'other', period: '2026-05', invoiceNumber: 'TGSL-TDS-PAN1-202627-001' }]);

        await download();

        // 194C: ₹1.1L (B's 194R ₹50k is a different section) → grossUp 1/99 = 111100, 100% deoleo.
        expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(
          mockTx, expect.objectContaining({ clientId: 'deoleo', bodyPaise: 111100n, seq: 2 }),
        );
        const recovery = mockTx.tdsRecoveryEntry.createMany.mock.calls[0][0].data as Array<{ clientId: string; section: string; tenantSharePaise: bigint }>;
        expect(recovery).toEqual([expect.objectContaining({ clientId: 'deoleo', section: 'SEC_194C', tenantSharePaise: 111100n })]);
      });

      it.each(['GROSS_UP', 'DEDUCT'])('D7: no-PAN 194R (%s) above the threshold → paid full, NO recovery row (the 194R report carries it)', async (methodology) => {
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(2500000n, 'SEC_194R', methodology)]);
        const noPanOutlet = bankOutlet('INDIVIDUAL');
        (noPanOutlet.partner as { panNumber: string | null }).panNumber = null;
        mockPrisma.outlet.findMany.mockResolvedValue([noPanOutlet]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);

        await download();

        expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
        expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
        expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(2500000));
      });

      it('no-PAN 194C (FIX-9, unchanged): still records the per-(client, outlet) recovery, tenant-scoped reads', async () => {
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(4000000n, 'SEC_194C', 'GROSS_UP')]);
        const noPanOutlet = bankOutlet('INDIVIDUAL');
        (noPanOutlet.partner as { panNumber: string | null }).panNumber = null;
        mockPrisma.outlet.findMany.mockResolvedValue([noPanOutlet]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);

        await download();

        expect(mockTx.creditPayoutEntry.findMany.mock.calls[0][0].where.clientId).toBe('deoleo');
        expect(mockTx.tdsRecoveryEntry.findMany.mock.calls[0][0].where.clientId).toBe('deoleo');
        const rec = mockTx.tdsRecoveryEntry.createMany.mock.calls[0][0].data[0];
        expect(rec).toMatchObject({ clientId: 'deoleo', panNumber: '__NO_PAN__:O1', section: 'SEC_194C', tenantSharePaise: 1000000n });
        // Fund reconciliation (2026-11-24): the no-PAN writer stores the bank run too.
        const run = (await mockTx.creditPayoutDownload.create.mock.results.at(-1)!.value) as { id: string };
        expect(rec.downloadId).toBe(run.id);
      });

      it('(b) a download mixing 194R + 194C GROSS_UP entries for one PAN raises ONLY the 194C invoice (D7), as the anchor', async () => {
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
          { ...secEntry(2500000n, 'SEC_194R', 'GROSS_UP'), id: 'e1' },
          { ...secEntry(11000000n, 'SEC_194C', 'GROSS_UP'), id: 'e2' },
        ]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);
        wirePan1BothTenants();
        mockTx.autoInvoice.findMany.mockResolvedValue([]); // nothing raised yet for PAN1 this FY

        await download();

        expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledTimes(1);
        expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(
          mockTx, expect.objectContaining({ bodyPaise: 111100n, seq: 1, isAnchor: true }),
        );
        const recovery = mockTx.tdsRecoveryEntry.createMany.mock.calls[0][0].data as Array<{ section: string }>;
        expect(recovery.every((r) => r.section === 'SEC_194C')).toBe(true);
      });

      describe('D8: 194C TDS invoice number = highest EXISTING seq + 1 (never a count)', () => {
        beforeEach(() => {
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(11000000n, 'SEC_194C', 'GROSS_UP')]);
          mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);
          wirePan1BothTenants();
        });
        const inv = (n: string, period: string) => ({ id: `inv-${n}`, clientId: 'deoleo', period, invoiceNumber: `TGSL-TDS-PAN1-202627-${n}` });

        it('001 + 002 exist → next is 003', async () => {
          mockTx.autoInvoice.findMany.mockResolvedValue([inv('001', '2026-04'), inv('002', '2026-04')]);
          await download();
          expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(mockTx, expect.objectContaining({ seq: 3, isAnchor: false }));
        });

        it('a DELETED middle invoice (001, 003 remain) → next is 004, not 003 (a count would collide with 003)', async () => {
          mockTx.autoInvoice.findMany.mockResolvedValue([inv('003', '2026-04'), inv('001', '2026-04')]);
          await download();
          expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(mockTx, expect.objectContaining({ seq: 4, isAnchor: false }));
        });

        it('a deleted FIRST invoice (only 002 remains) → next is 003 and it is NOT re-anchored as 001', async () => {
          mockTx.autoInvoice.findMany.mockResolvedValue([inv('002', '2026-04')]);
          await download();
          expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(mockTx, expect.objectContaining({ seq: 3, isAnchor: false }));
        });

        it('numbers sort numerically, not as text (009 + 010 → 011)', async () => {
          mockTx.autoInvoice.findMany.mockResolvedValue([inv('010', '2026-04'), inv('009', '2026-04')]);
          await download();
          expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(mockTx, expect.objectContaining({ seq: 11 }));
        });

        it('the lookup reads invoiceNumber so the seq is parsed from the real numbers', async () => {
          mockTx.autoInvoice.findMany.mockResolvedValue([]);
          await download();
          const arg = mockTx.autoInvoice.findMany.mock.calls[0][0];
          expect(arg.select).toEqual(expect.objectContaining({ invoiceNumber: true }));
          expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(mockTx, expect.objectContaining({ seq: 1, isAnchor: true }));
        });
      });

      it('(c) 194C: a same-period LEGACY TDS invoice with no recovery rows (section unknown) from another tenant still BLOCKS', async () => {
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);
        wirePan1BothTenants();
        mockTx.tdsRecoveryEntry.findMany.mockResolvedValue([]); // no recovery rows anywhere → section unresolvable
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(11000000n, 'SEC_194C', 'GROSS_UP')]);
        mockTx.autoInvoice.findMany.mockResolvedValue([{ id: 'inv-legacy', clientId: 'other', period: '2026-05', invoiceNumber: 'TGSL-TDS-PAN1-202627-001' }]);
        await download();
        expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
      });

      it('(d) LEGACY 194R recovery rows / invoices (written before D7) are ignored: no new 194R invoice, and they never count toward 194C', async () => {
        // A 194C crossing for the same PAN: 194R legacy recovery (₹5,000) must not reduce the 194C top-up.
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(11000000n, 'SEC_194C', 'GROSS_UP')]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);
        wirePan1BothTenants();
        mockTx.tdsRecoveryEntry.findMany.mockImplementation(async (arg: { where?: { tdsInvoiceId?: unknown } }) =>
          arg?.where?.tdsInvoiceId
            ? [{ tdsInvoiceId: 'inv-old-r', section: 'SEC_194R' }]
            : [
                { panNumber: 'PAN1', section: 'SEC_194R', clientId: 'deoleo', tenantSharePaise: 100000n },
                { panNumber: 'PAN1', section: 'SEC_194R', clientId: 'other', tenantSharePaise: 400000n },
              ],
        );
        mockTx.autoInvoice.findMany.mockResolvedValue([{ id: 'inv-old-r', clientId: 'other', period: '2026-05', invoiceNumber: 'TGSL-TDS-PAN1-202627-001' }]);

        await download();

        expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledTimes(1);
        expect(mockInvoicesService.createTdsInvoice).toHaveBeenCalledWith(
          mockTx, expect.objectContaining({ clientId: 'deoleo', bodyPaise: 111100n }),
        );
        const recovery = mockTx.tdsRecoveryEntry.createMany.mock.calls[0][0].data;
        expect(recovery).toEqual([expect.objectContaining({ clientId: 'deoleo', section: 'SEC_194C', tenantSharePaise: 111100n })]);
      });

      it('194C on PAID: a same-period 194C TDS invoice raised by ANOTHER tenant that already recovered this base → no re-raise (the delta is 0)', async () => {
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([secEntry(11000000n, 'SEC_194C', 'GROSS_UP')]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);
        wirePan1BothTenants();
        mockTx.tdsRecoveryEntry.findMany.mockImplementation(async (arg: { where?: { tdsInvoiceId?: unknown } }) =>
          arg?.where?.tdsInvoiceId
            ? [{ tdsInvoiceId: 'inv-other-c', section: 'SEC_194C' }]
            : [{ panNumber: 'PAN1', section: 'SEC_194C', clientId: 'deoleo', tenantSharePaise: 111100n }],
        );
        mockTx.autoInvoice.findMany.mockResolvedValue([{ id: 'inv-other-c', clientId: 'other', period: '2026-05' }]);

        await download();

        expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
      });
    });

    // ── 194R WHOLE-YEAR TRUE-UP at download (owner 2026-11-18: D2/D3/D6/D9 + Q1/Q3/Q6) ──────────
    describe('194R whole-year true-up (shared definition with the 194R report)', () => {
      // D3: a 194R run counts in the RUN DATE's FY — computed from "now", never hardcoded.
      const runFy = financialYear(new Date()).fyLabel;
      const policy = (methodology: 'DEDUCT' | 'GROSS_UP') =>
        mockTenantSettings.resolveTdsPolicy.mockResolvedValue({ section: 'SEC_194R', methodology });
      /** This run's visibility entry (frozen 194R; the FROZEN method is irrelevant — D6 uses the current one). */
      const run = (amountPaise: bigint, frozen: 'DEDUCT' | 'GROSS_UP' = 'DEDUCT', id = 'e1') => ({
        id, outletId: 'O1', outletName: 'A', amountPaise, fieldId: 'f-vis', tdsSection: 'SEC_194R', tdsMethodology: frozen, batch: { batchCode: 'CB-1' },
      });
      /** A committed prior payout row as the shared read returns it. */
      const prior = (id: string, amountPaise: bigint, o: { clientId?: string; outletId?: string; fieldId?: string; status?: string } = {}) => ({
        id, clientId: o.clientId ?? 'deoleo', outletId: o.outletId ?? 'O1', amountPaise, fieldId: o.fieldId ?? 'f-vis', tdsSection: 'SEC_194R', status: o.status ?? 'PAID',
      });
      /** Route the shared read's three payout queries (PAID / imported / PROCESSING) to row sets. */
      const priorRows = (r: { paid?: unknown[]; processing?: unknown[]; imported?: unknown[] }) =>
        mockTx.creditPayoutEntry.findMany.mockImplementation(
          async (a: { where?: { status?: string | { in?: string[] }; batch?: { sourceKind?: string }; downloadId?: null } }) => {
            const w = a?.where ?? {};
            // Owner FY rule: PAID + PROCESSING payouts that went through a bank file — one read, by file date.
            if (typeof w.status === 'object' && w.status?.in) return [...(r.paid ?? []), ...(r.processing ?? [])];
            if (w.status === 'PAID' && w.batch?.sourceKind === 'VENDOR_IMPORT') return r.imported ?? [];
            return []; // PAID without a bank file (none in these fixtures)
          },
        );
      function wire() {
        mockTx.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
        mockTx.outlet.findMany.mockResolvedValue([
          { outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' },
          { outletCode: 'OX', clientId: 'other', partnerId: 'p2' },
        ]);
        mockTx.channelPartner.findMany.mockResolvedValue([
          { id: 'p1', panNumber: 'PAN1' },
          { id: 'p2', panNumber: 'PAN1' },
        ]);
        // A-L1: the engine's 194R partner scope is ONE exact match on the normalised PAN (raw SQL).
        mockTx.$queryRaw.mockResolvedValue([{ id: 'p1', panNumber: 'PAN1' }]);
      }
      async function download() {
        mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
        mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-001' });
        return service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.SEPARATE, fieldId: 'f-vis', fieldName: 'Visibility' });
      }
      const ledgerRow = () => mockTx.tdsDeductionEntry.createMany.mock.calls[0]?.[0]?.data?.[0];
      beforeEach(() => {
        mockPrisma.creditField.findMany.mockResolvedValue([{ id: 'f-vis' }]);
        mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL')]);
        wire();
      });

      it('WORKED EXAMPLE (Q1/D6): DEDUCT client, PAN — visibility ₹15,000 now + a gift ₹8,000 → ₹1,500 withheld (the ₹889 gift TDS is client-borne, not withheld)', async () => {
        policy('DEDUCT');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(1500000n)]);
        priorRows({});
        mockTx.redemptionOrder.findMany.mockResolvedValue([
          { valuePaise: 800000n, redemptionMode: 'PHYSICAL_GIFT', partner: { id: 'p1', panNumber: 'PAN1' } },
        ]);

        await download();

        // ₹23,000 total > ₹20,000 → TDS on the whole year; only the visibility part is withheld: 10% × ₹15,000.
        expect(ledgerRow()).toMatchObject({
          clientId: 'deoleo', panNumber: 'PAN1', section: 'SEC_194R', fyLabel: runFy,
          cumulativeBasePaise: 1500000n, tdsDueCumulativePaise: 150000n,
          tdsDeductedPriorPaise: 0n, tdsDeductedThisPaise: 150000n, carryForwardPaise: 0n,
        });
        expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(1500000 - 150000));
        // D7: no 194R invoice / recovery ever.
        expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
        expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
      });

      it('D2: the threshold counts EVERY benefit — incentive ₹18,000 + cash redemption ₹1,000 + off-platform ₹500 + this visibility ₹5,000 → crosses; only 10% × ₹5,000 is withheld', async () => {
        policy('DEDUCT');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(500000n)]);
        priorRows({ paid: [prior('inc1', 1800000n, { fieldId: 'f-incentive' })] });
        mockTx.redemptionOrder.findMany.mockResolvedValue([
          { valuePaise: 100000n, redemptionMode: 'UPI', partner: { id: 'p1', panNumber: 'PAN1' } },
        ]);
        mockTx.tdsOffPlatformEntry.findMany.mockResolvedValue([{ panNumber: 'PAN1', amountPaise: 50000n, outletCode: null }]);

        await download();

        expect(ledgerRow()).toMatchObject({ cumulativeBasePaise: 500000n, tdsDueCumulativePaise: 50000n, tdsDeductedThisPaise: 50000n });
      });

      it('D2: below ₹20,000 for THIS client (₹15,000 here; ₹15,000 under another client is never added) → nothing withheld', async () => {
        policy('DEDUCT');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(1500000n)]);
        priorRows({ paid: [prior('x1', 1500000n, { clientId: 'other', outletId: 'OX' })] });

        await download();

        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
        expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(1500000));
      });

      it('D6: the CURRENT method wins — entries frozen DEDUCT on a client now on GROSS_UP → nothing withheld, nothing written', async () => {
        policy('GROSS_UP');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(5000000n, 'DEDUCT')]);
        priorRows({});

        await download();

        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
        expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
        expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(5000000));
      });

      it('D6 METHOD SWITCH mid-year: ₹1,00,000 paid earlier on GROSS_UP (nothing withheld), client now DEDUCT, this run ₹5,000 → whole year recomputed: due ₹10,500, ₹5,000 withheld, ₹5,500 carried forward', async () => {
        policy('DEDUCT');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(500000n, 'GROSS_UP')]);
        priorRows({ paid: [prior('v1', 10000000n)] });

        await download();

        expect(ledgerRow()).toMatchObject({
          cumulativeBasePaise: 10500000n, tdsDueCumulativePaise: 1050000n,
          tdsDeductedPriorPaise: 0n, tdsDeductedThisPaise: 500000n, carryForwardPaise: 550000n,
        });
        expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(0));
      });

      it('Q3: withhold = whole-year due − already deducted (net of reversals) for THIS client; another client’s withholding never counts', async () => {
        policy('DEDUCT');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(1000000n)]);
        priorRows({ paid: [prior('v1', 1500000n)] });
        mockTx.tdsDeductionEntry.findMany.mockResolvedValue([
          { clientId: 'deoleo', panNumber: 'PAN1', tdsDeductedThisPaise: 150000n },
          { clientId: 'deoleo', panNumber: 'PAN1', tdsDeductedThisPaise: -50000n }, // a FAILED-payout reversal
          { clientId: 'other', panNumber: 'PAN1', tdsDeductedThisPaise: 999900n },
        ]);

        await download();

        // due = 10% × ₹25,000 = ₹2,500; already deducted (net) ₹1,000 → withhold ₹1,500.
        expect(ledgerRow()).toMatchObject({ tdsDueCumulativePaise: 250000n, tdsDeductedPriorPaise: 100000n, tdsDeductedThisPaise: 150000n });
        // The ledger read is scoped to this client / 194R / the run FY.
        const where = mockTx.tdsDeductionEntry.findMany.mock.calls.map((c: [{ where: Record<string, unknown> }]) => c[0].where)
          .find((w: Record<string, unknown>) => w.section === 'SEC_194R');
        expect(where).toMatchObject({ clientId: 'deoleo', section: 'SEC_194R', fyLabel: runFy });
      });

      it('D3: a PROCESSING payout (in a bank file, no UTR yet) counts as committed; FAILED / PENDING are never read', async () => {
        policy('DEDUCT');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(1000000n)]);
        priorRows({ processing: [prior('p-1', 1500000n, { status: 'PROCESSING' })] });

        await download();

        // ₹15,000 in a bank file + ₹10,000 now = ₹25,000 → due ₹2,500 (nothing withheld yet) → all from this run.
        expect(ledgerRow()).toMatchObject({ cumulativeBasePaise: 2500000n, tdsDueCumulativePaise: 250000n, tdsDeductedThisPaise: 250000n });
        const statuses = mockTx.creditPayoutEntry.findMany.mock.calls
          .map((c: [{ where?: { status?: unknown } }]) => c[0]?.where?.status)
          .flatMap((x: unknown) => (typeof x === 'string' ? [x] : ((x as { in?: string[] })?.in ?? [])));
        expect(statuses).toEqual(expect.arrayContaining(['PAID', 'PROCESSING']));
        expect(statuses).not.toContain('FAILED');
        expect(statuses).not.toContain('PENDING');
      });

      describe('D9: imported vendor payouts count from the client’s countFrom date (engine)', () => {
        it('countFrom set → the imported incentive payouts are read and push the retailer over ₹20,000', async () => {
          policy('DEDUCT');
          mockPrisma.programSetting.findUnique.mockResolvedValue({ settingValue: { countFrom: `${runFy.slice(0, 4)}-04-01` } });
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(500000n)]);
          priorRows({ imported: [prior('imp1', 1800000n, { fieldId: 'historical-incentive-payout' })] });

          await download();

          expect(ledgerRow()).toMatchObject({ cumulativeBasePaise: 500000n, tdsDeductedThisPaise: 50000n });
          const imp = mockTx.creditPayoutEntry.findMany.mock.calls
            .map((c: [{ where?: { batch?: { sourceKind?: string }; paidAt?: { gte: Date } } }]) => c[0]?.where)
            .find((w: { batch?: { sourceKind?: string } } | undefined) => w?.batch?.sourceKind === 'VENDOR_IMPORT');
          expect(imp).toBeDefined();
        });

        it('countFrom OFF → the imported payouts are not read; ₹18,000 imported does not count → nothing withheld', async () => {
          policy('DEDUCT');
          mockPrisma.programSetting.findUnique.mockResolvedValue(null);
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(500000n)]);
          priorRows({ imported: [prior('imp1', 1800000n, { fieldId: 'historical-incentive-payout' })] });

          await download();

          expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
          const imp = mockTx.creditPayoutEntry.findMany.mock.calls
            .map((c: [{ where?: { batch?: { sourceKind?: string } } }]) => c[0]?.where)
            .find((w: { batch?: { sourceKind?: string } } | undefined) => w?.batch?.sourceKind === 'VENDOR_IMPORT');
          expect(imp).toBeUndefined();
        });

        it('a malformed countFrom setting fails the download CLOSED before any write', async () => {
          policy('DEDUCT');
          mockPrisma.programSetting.findUnique.mockResolvedValue({ settingValue: 'garbage' });
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(500000n)]);
          await expect(download()).rejects.toThrow(/imported-payouts TDS setting/);
          expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        });
      });

      it('locks per (client, PAN, run FY) for 194R in addition to the per-PAN lock', async () => {
        policy('DEDUCT');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(500000n)]);
        priorRows({});
        await download();
        // A 194R entry takes the ONE per-(client, FY) key INSTEAD of the per-PAN key (all 194R state is per client).
        expect(lockKeysTaken().sort()).toEqual([`PDLOCK|deoleo|2026-05`, `R194|deoleo|${runFy}`].sort());
      });

      it('lock count: 3 outlets of 2 retailers (194R) → ONE per-(client, FY) key + 1 download key, one statement', async () => {
        policy('DEDUCT');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
          { ...run(100000n), id: 'a1', outletId: 'O1' },
          { ...run(100000n), id: 'a2', outletId: 'O2' },
          { ...run(100000n), id: 'a3', outletId: 'O3' },
        ]);
        const o = (code: string, pid: string, pan: string) => ({
          ...bankOutlet('INDIVIDUAL'), outletCode: code, partner: { ...bankOutlet('INDIVIDUAL').partner, id: pid, panNumber: pan },
        });
        mockPrisma.outlet.findMany.mockResolvedValue([o('O1', 'p1', 'PAN1'), o('O2', 'p1', 'PAN1'), o('O3', 'p3', 'PAN3')]);
        priorRows({});
        await download();
        expect(mockTx.$executeRaw.mock.calls.filter((c: unknown[]) => (c[0] as string[]).join('?').includes('pg_advisory_xact_lock'))).toHaveLength(1);
        expect(lockKeysTaken().sort()).toEqual(['PDLOCK|deoleo|2026-05', `R194|deoleo|${runFy}`]);
      });

      it('A-L race: a UTR upload that FAILS a withheld 194R payout takes the SAME retailer lock before writing the offset', async () => {
        mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
          id: 'd1', downloadCode: 'PD-2026-05-001', period: '2026-05', downloadedBy: 'g1',
          entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: 2500000n, tdsDeductedPaise: 250000n, tdsSection: 'SEC_194R', period: '2026-05' }],
        });
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: 2500000n, tdsDeductedPaise: 250000n, tdsSection: 'SEC_194R', period: '2026-05' },
        ]);
        mockTx.tdsDeductionEntry.findMany.mockResolvedValue([{ creditPayoutEntryId: 'e1', panNumber: 'PAN1', fyLabel: runFy }]);
        const aoa = [['title'], ['Batch ID', 'Outlet ID', 'UTR', 'Success/Failure', 'Remarks'], ['PD-2026-05-001', 'O1', '', 'Failure', 'bounced']];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Payout');
        const file = { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File;

        await service.uploadUtr(gifsy, 'd1', file, true);

        expect(lockKeysTaken()).toContain(`R194|deoleo|${runFy}`);
        // The retailer lock is taken BEFORE any entry flip / ledger write.
        const lockOrder = mockTx.$executeRaw.mock.invocationCallOrder[mockTx.$executeRaw.mock.calls.findIndex((c: unknown[]) => Array.isArray(c[1]))];
        expect(lockOrder).toBeLessThan(mockTx.creditPayoutEntry.updateMany.mock.invocationCallOrder[0]);
        expect(lockOrder).toBeLessThan(mockTx.tdsDeductionEntry.createMany.mock.invocationCallOrder[0]);
      });

      it('A-L race: approving a reversal of a withheld 194R payout takes the SAME retailer lock before flipping it', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue({
          id: 'r1', status: 'PENDING_GIFSY', requestedPaise: 2500000n, awardType: 'PAYOUT', outletId: 'O1', fieldId: 'f1', batchId: 'b1',
        });
        mockTx.creditBatch.findFirst.mockResolvedValue({ id: 'b1', rows: [{ outletId: 'O1', fieldId: 'f1', awardType: 'PAYOUT', status: 'OK', amount: 2500000 }] });
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { id: 'pe1', status: 'FAILED', outletId: 'O1', amountPaise: 2500000n, tdsDeductedPaise: 250000n, tdsSection: 'SEC_194R', period: '2026-05' },
        ]);
        mockTx.tdsDeductionEntry.findMany.mockResolvedValue([{ creditPayoutEntryId: 'pe1', panNumber: 'PAN1', fyLabel: runFy, tdsDeductedThisPaise: 250000n }]);

        await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 2500000 });

        expect(lockKeysTaken()).toContain(`R194|deoleo|${runFy}`);
        const lockOrder = mockTx.$executeRaw.mock.invocationCallOrder[mockTx.$executeRaw.mock.calls.findIndex((c: unknown[]) => Array.isArray(c[1]))];
        expect(lockOrder).toBeLessThan(mockTx.creditPayoutEntry.updateMany.mock.invocationCallOrder[0]);
      });

      it('KYC-held payouts are listed loudly in the result (heldNote), never silent', async () => {
        policy('GROSS_UP');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(500000n), { ...run(300000n), id: 'e2', outletId: 'O2', outletName: 'B' }]);
        const held = { ...bankOutlet('INDIVIDUAL'), outletCode: 'O2', name: 'B', partner: { ...bankOutlet('INDIVIDUAL').partner, id: 'p2', kycSubmissions: [] } };
        mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL'), held]);
        priorRows({});

        const res = await download();

        expect(res.heldEntries.map((h) => h.outletId)).toEqual(['O2']);
        expect(res.heldNote).toMatch(/^1 payout held — KYC not approved/);
        expect(res.heldNote).toContain('O2');
      });

      describe('A-H2: a payout FULLY withheld as TDS never becomes a ₹0 bank line', () => {
        it('the outlet is left out of the bank file, its entries settle PAID with ref TDS-WITHHELD-<code> at the download time, listed loudly, no message', async () => {
          policy('DEDUCT');
          // Method switch case: ₹1,00,000 earlier on GROSS_UP → due ₹10,500 ≥ this ₹5,000 → all withheld.
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(500000n)]);
          priorRows({ paid: [prior('v1', 10000000n)] });

          const res = await download();

          // Settled without the bank (guarded on the PROCESSING claim of THIS download).
          expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ['e1'] }, status: 'PROCESSING', downloadId: 'd1' },
            data: expect.objectContaining({ status: 'PAID', utr: 'TDS-WITHHELD-PD-2026-05-001', paidAt: expect.any(Date) }),
          });
          // A-L3: EVERY outlet was fully withheld → no bank file at all (clear message instead).
          expect(res.buffer).toBeNull();
          expect(res.noBankFileMessage).toMatch(/No bank file — every payout in this run was fully withheld as TDS/);
          // A-M4/B-M2: the self-billed SERVICE invoice is locked at settle time (same as a UTR PAID).
          expect(mockTx.autoInvoice.updateMany).toHaveBeenCalledWith({
            // voidedAt null: a VOID invoice (its payouts cancelled) is history, never locked as paid.
            where: { clientId: 'deoleo', outletCode: { in: ['O1'] }, period: '2026-05', invoiceKind: 'SERVICE', lockedAt: null, voidedAt: null },
            data: { lockedAt: expect.any(Date) },
          });
          // Listed loudly in the result.
          expect(res.fullyWithheld).toEqual([
            expect.objectContaining({ outletId: 'O1', amountPaise: 500000, tdsWithheldPaise: 500000, entryIds: ['e1'] }),
          ]);
          expect(res.fullyWithheldNote).toBe('1 payout fully withheld as TDS — not sent to the bank (outlet O1).');
          // Every outlet was withheld → the download is already settled.
          expect(mockTx.creditPayoutDownload.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { status: 'PAID' } });
          // No "credited ₹0" message is ever sent; the retailer gets a clear in-app/push note instead.
          expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
          expect(mockNotifications.notifyUser).toHaveBeenCalledWith(
            expect.objectContaining({
              userId: 'partnerUser1',
              body: expect.stringMatching(/₹5,000\.00 of this payout was taken as TDS — ₹0 paid to you/),
            }),
          );
        });

        it('A-M1: the download row is written with downloadedAt = the run time, the SAME instant the ledger FY comes from', async () => {
          policy('DEDUCT');
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(1500000n)]);
          mockTx.redemptionOrder.findMany.mockResolvedValue([
            { valuePaise: 800000n, redemptionMode: 'PHYSICAL_GIFT', partner: { id: 'p1', panNumber: 'PAN1' } },
          ]);
          priorRows({});
          await download();
          const at = mockTx.creditPayoutDownload.create.mock.calls[0][0].data.downloadedAt as Date;
          expect(at).toBeInstanceOf(Date);
          expect(financialYear(at).fyLabel).toBe(ledgerRow().fyLabel);
        });

        it('B-H1: the response note is BOUNDED (count + first 20 codes + "+K more") even with 500 fully withheld outlets', async () => {
          policy('DEDUCT');
          const n = 500;
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue(
            Array.from({ length: n }, (_, i) => ({ ...run(500000n), id: `e${i}`, outletId: `OUT${String(i).padStart(4, '0')}` })),
          );
          mockPrisma.outlet.findMany.mockResolvedValue(
            Array.from({ length: n }, (_, i) => ({ ...bankOutlet('INDIVIDUAL'), outletCode: `OUT${String(i).padStart(4, '0')}` })),
          );
          priorRows({ paid: [prior('v1', 3000000000n)] }); // ₹3 crore earlier on GROSS_UP → 10% due ≥ this run → all withheld
          const res = await download();
          expect(res.fullyWithheld).toHaveLength(n); // the FULL list stays in the JSON result
          expect(res.fullyWithheldNote!.length).toBeLessThan(1000);
          expect(res.fullyWithheldNote).toMatch(/^500 payouts fully withheld as TDS/);
          expect(res.fullyWithheldNote).toContain('+480 more');
        });

        it('A-L5/B-L4: ONE notice per owner per download (outlets aggregated); 194R says the CLIENT deposits it, against the PAN', async () => {
          policy('DEDUCT');
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(500000n), { ...run(300000n), id: 'e2', outletId: 'O2', outletName: 'B' }]);
          mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL'), { ...bankOutlet('INDIVIDUAL'), outletCode: 'O2', name: 'B' }]);
          mockTx.outlet.findMany.mockResolvedValue([
            { outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' },
            { outletCode: 'O2', clientId: 'deoleo', partnerId: 'p1' },
          ]);
          priorRows({ paid: [prior('v1', 10000000n)] }); // ₹1,00,000 earlier → ₹10,800 due ≥ this ₹8,000 → all withheld
          mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'partnerUser1' });

          const res = await download();

          expect(res.fullyWithheld.map((f) => f.outletId).sort()).toEqual(['O1', 'O2']);
          expect(mockNotifications.notifyUser).toHaveBeenCalledTimes(1);
          const body = mockNotifications.notifyUser.mock.calls[0][0].body as string;
          expect(body).toContain('₹8,000.00');
          expect(body).toMatch(/2 outlets/);
          expect(body).toMatch(/The client deposits it/);
          expect(body).toMatch(/against your PAN/);
        });

        it('A-L5: a NO-PAN owner is never told it is "deposited against your PAN"', async () => {
          policy('DEDUCT');
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(500000n)]);
          const noPan = bankOutlet('INDIVIDUAL');
          mockPrisma.outlet.findMany.mockResolvedValue([{ ...noPan, partner: { ...noPan.partner, panNumber: null } }]);
          mockTx.channelPartner.findMany.mockResolvedValue([{ id: 'p1', panNumber: null }]);
          mockTx.$queryRaw.mockResolvedValue([]);
          priorRows({ paid: [prior('v1', 10000000n)] });
          mockPrisma.channelPartner.findFirst.mockResolvedValue({ userId: 'partnerUser1' });

          const res = await download();

          expect(res.fullyWithheld.map((f) => f.outletId)).toEqual(['O1']);
          expect(mockNotifications.notifyUser).toHaveBeenCalledTimes(1);
          const body = mockNotifications.notifyUser.mock.calls[0][0].body as string;
          expect(body).not.toMatch(/against your PAN/);
          expect(body).toMatch(/no PAN/i);
          expect(body).toMatch(/The client deposits it/);
        });

        it('a partly withheld outlet stays in the bank file at its net amount; nothing is settled without the bank', async () => {
          policy('DEDUCT');
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(1500000n)]);
          mockTx.redemptionOrder.findMany.mockResolvedValue([
            { valuePaise: 800000n, redemptionMode: 'PHYSICAL_GIFT', partner: { id: 'p1', panNumber: 'PAN1' } },
          ]);
          priorRows({});

          const res = await download();

          expect(res.fullyWithheld).toEqual([]);
          expect(res.fullyWithheldNote).toBeNull();
          const settleCalls = mockTx.creditPayoutEntry.updateMany.mock.calls.filter(
            (c: [{ data?: { status?: string } }]) => c[0]?.data?.status === 'PAID',
          );
          expect(settleCalls).toHaveLength(0);
          expect(mockTx.creditPayoutDownload.update).not.toHaveBeenCalled();
        });
      });

      it('A-M2: a STANDARD incentive download (194R entries, no engine) takes the per-(client, FY) 194R lock', async () => {
        mockPrisma.creditField.findMany.mockResolvedValue([]); // no visibility fields → STANDARD
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([{ ...run(500000n), fieldId: 'f-inc', tdsSection: 'SEC_194R' }]);
        priorRows({});
        mockPrisma.creditPayoutDownload.count.mockResolvedValue(0);
        mockTx.creditPayoutDownload.create.mockResolvedValue({ id: 'd1', downloadCode: 'PD-001' });
        await service.createPayoutDownload(gifsy, { period: '2026-05', groupType: PayoutGroupType.STANDARD });
        expect(lockKeysTaken()).toContain(`R194|deoleo|${runFy}`);
      });

      it('A-M2: a UTR upload that fails ANY 194R payout (nothing withheld) takes the 194R lock of its bank-file FY', async () => {
        mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
          id: 'd1', downloadCode: 'PD-2026-05-001', period: '2026-05', downloadedBy: 'g1', downloadedAt: new Date(),
          entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: 900000n, tdsDeductedPaise: 0n, tdsSection: 'SEC_194R', period: '2026-05' }],
        });
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: 900000n, tdsDeductedPaise: 0n, tdsSection: 'SEC_194R', period: '2026-05' },
        ]);
        const aoa = [['title'], ['Batch ID', 'Outlet ID', 'UTR', 'Success/Failure', 'Remarks'], ['PD-2026-05-001', 'O1', '', 'Failure', 'bounced']];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Payout');
        const file = { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File;
        await service.uploadUtr(gifsy, 'd1', file, true);
        expect(lockKeysTaken()).toContain(`R194|deoleo|${runFy}`);
      });

      it('A-L4: reversing a fully withheld 194R entry takes the R194 client+FY lock of its original ledger row', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue({
          id: 'r1', status: 'PENDING_GIFSY', requestedPaise: 500000n, awardType: 'PAYOUT', outletId: 'O1', fieldId: 'f1', batchId: 'b1',
        });
        mockTx.creditBatch.findFirst.mockResolvedValue({ id: 'b1', rows: [{ outletId: 'O1', fieldId: 'f1', awardType: 'PAYOUT', status: 'OK', amount: 500000 }] });
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { id: 'pe1', status: 'PAID', outletId: 'O1', amountPaise: 500000n, tdsDeductedPaise: 500000n, tdsSection: 'SEC_194R', period: '2026-05' },
        ]);
        mockTx.tdsDeductionEntry.findMany.mockResolvedValue([{ creditPayoutEntryId: 'pe1', panNumber: 'PAN1', section: 'SEC_194R', fyLabel: '2026-27', tdsDeductedThisPaise: 500000n }]);
        await service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 500000 });
        expect(lockKeysTaken()).toContain('R194|deoleo|2026-27');
      });

      it('owner D1 (2026-11-19, every tenant): a PAID 194C entry can not be reversed — refused before any lock or write', async () => {
        mockPrisma.creditReversal.findFirst.mockResolvedValue({
          id: 'r1', status: 'PENDING_GIFSY', requestedPaise: 500000n, awardType: 'PAYOUT', outletId: 'O1', fieldId: 'f1', batchId: 'b1',
        });
        mockTx.creditBatch.findFirst.mockResolvedValue({ id: 'b1', rows: [{ outletId: 'O1', fieldId: 'f1', awardType: 'PAYOUT', status: 'OK', amount: 500000 }] });
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { id: 'pe1', status: 'PAID', outletId: 'O1', amountPaise: 500000n, tdsDeductedPaise: 500000n, tdsSection: 'SEC_194C', period: '2026-05' },
        ]);
        await expect(service.patchReversal(gifsy, 'r1', { action: ReversalAction.approve, approvedPaise: 500000 })).rejects.toThrow(
          /^194C payouts can't be reversed once paid/,
        );
        expect(mockTx.creditPayoutEntry.updateMany).not.toHaveBeenCalled();
        expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
      });

      it('A-L1: the partner scope is ONE exact match on the normalised PAN (PAN_NORMALISE_SQL) for this client (no per-PAN ILIKE OR)', async () => {
        policy('DEDUCT');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(1500000n)]);
        priorRows({});
        await download();
        const call = mockTx.$queryRaw.mock.calls.find((c: unknown[]) => (c[0] as { strings?: string[] })?.strings?.join('?').includes('channel_partners'));
        expect(call).toBeDefined();
        const q = call![0] as { strings: string[]; values: unknown[] };
        const sql = q.strings.join('?');
        // A-M2: the ONE normaliser (whitespace class removed, upper-cased) — same as normalisePan.
        expect(sql).toMatch(/upper\(regexp_replace\("panNumber", '\[ /);
        expect(sql).toContain(') = ANY(');
        expect(q.values).toEqual(['deoleo', ['PAN1']]);
        const ilike = mockTx.channelPartner.findMany.mock.calls.some((c: [{ where?: { OR?: Array<{ panNumber?: { contains?: string } }> } }]) =>
          (c[0]?.where?.OR ?? []).some((x) => !!x.panNumber?.contains),
        );
        expect(ilike).toBe(false);
      });

      it('L3: a stored "__NO_PAN__" sentinel on the partner is treated as NO PAN (owner key, 20%)', async () => {
        policy('DEDUCT');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(3000000n)]);
        const o = bankOutlet('INDIVIDUAL');
        (o.partner as { panNumber: string | null }).panNumber = '__NO_PAN__';
        mockPrisma.outlet.findMany.mockResolvedValue([o]);
        priorRows({});
        await download();
        expect(ledgerRow()).toMatchObject({ panNumber: '__NO_PAN__:p1', tdsDeductedThisPaise: 600000n });
      });

      it("owner rule 2026-11-18: the bank file SNAPSHOTS each payout's payee (PAN or no-PAN owner key) in the download tx", async () => {
        policy('GROSS_UP');
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(500000n), { ...run(300000n), id: 'e2', outletId: 'O2', outletName: 'B' }]);
        const noPan = { ...bankOutlet('INDIVIDUAL'), outletCode: 'O2', name: 'B', partner: { ...bankOutlet('INDIVIDUAL').partner, id: 'p2', panNumber: null } };
        mockPrisma.outlet.findMany.mockResolvedValue([bankOutlet('INDIVIDUAL'), noPan]);
        priorRows({});
        await download();
        const call = mockTx.$executeRaw.mock.calls.find((c: unknown[]) => String((c[0] as string[]).join('?')).includes('UPDATE "credit_payout_entries"'));
        expect(call).toBeDefined();
        const [ids, pans, pids] = call!.slice(1) as [string[], string[], Array<string | null>];
        const byId = Object.fromEntries(ids.map((id, i) => [id, [pans[i], pids[i]]]));
        expect(byId).toEqual({ e1: ['PAN1', 'p1'], e2: ['__NO_PAN__:p2', 'p2'] });
      });

      it('194C-only download (e.g. Deoleo): no 194R reads at all — no policy read, no countFrom read, no shared base read', async () => {
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([{ ...run(5000000n), tdsSection: 'SEC_194C' }]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([]);
        mockTx.outlet.findMany.mockResolvedValue([{ outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' }]);
        mockTx.channelPartner.findMany.mockResolvedValue([{ id: 'p1', panNumber: 'PAN1' }]);

        await download();

        expect(mockTenantSettings.resolveTdsPolicy).not.toHaveBeenCalled();
        expect(mockPrisma.programSetting.findUnique).not.toHaveBeenCalled();
        expect(mockTx.creditField.findMany).not.toHaveBeenCalled();
        expect(mockTx.redemptionOrder.findMany).not.toHaveBeenCalled();
      });

      it('FAILED 194R payout: the compensating negative row carries the tenant AND the FY the withholding was booked in', async () => {
        mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
          id: 'd1', downloadCode: 'PD-2026-05-001', period: '2026-05', downloadedBy: 'g1',
          entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: 2500000n, tdsDeductedPaise: 250000n, tdsSection: 'SEC_194R', period: '2026-05' }],
        });
        mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
        mockTx.creditPayoutEntry.findMany.mockResolvedValue([
          { id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: 2500000n, tdsDeductedPaise: 250000n, tdsSection: 'SEC_194R', period: '2026-05' },
        ]);
        // The withholding was booked in the run FY (D3), which can differ from the payout period's FY.
        mockTx.tdsDeductionEntry.findMany.mockResolvedValue([{ creditPayoutEntryId: 'e1', panNumber: 'PAN1', fyLabel: '2027-28' }]);
        const aoa = [['title'], ['Batch ID', 'Outlet ID', 'UTR', 'Success/Failure', 'Remarks'], ['PD-2026-05-001', 'O1', '', 'Failure', 'bounced']];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Payout');
        const file = { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File;

        await service.uploadUtr(gifsy, 'd1', file, true);

        expect(ledgerRow()).toMatchObject({ clientId: 'deoleo', panNumber: 'PAN1', section: 'SEC_194R', fyLabel: '2027-28', tdsDeductedThisPaise: -250000n });
      });

      describe('no-PAN retailer on DEDUCT (owner 2026-11-18): visibility IS withheld at 20%, keyed per owner', () => {
        const noPanOutlet = () => {
          const o = bankOutlet('INDIVIDUAL');
          (o.partner as { panNumber: string | null }).panNumber = null;
          return o;
        };
        beforeEach(() => {
          mockTx.channelPartner.findMany.mockResolvedValue([{ id: 'p1', panNumber: null }]);
          mockTx.outlet.findMany.mockResolvedValue([{ outletCode: 'O1', clientId: 'deoleo', partnerId: 'p1' }]);
        });

        it('₹30,000 → ₹6,000 withheld, ₹24,000 released; ledger keyed by the owner (`__NO_PAN__:<partnerId>`); no recovery row', async () => {
          policy('DEDUCT');
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(3000000n)]);
          mockPrisma.outlet.findMany.mockResolvedValue([noPanOutlet()]);
          priorRows({});

          await download();

          expect(ledgerRow()).toMatchObject({
            clientId: 'deoleo', panNumber: '__NO_PAN__:p1', section: 'SEC_194R', fyLabel: runFy,
            tdsDueCumulativePaise: 600000n, tdsDeductedThisPaise: 600000n, carryForwardPaise: 0n,
          });
          expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(2400000));
          expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
          expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
        });

        it('nets per owner key: ₹2,000 already withheld for this owner → ₹4,000 now (another owner’s rows ignored)', async () => {
          policy('DEDUCT');
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(3000000n)]);
          mockPrisma.outlet.findMany.mockResolvedValue([noPanOutlet()]);
          priorRows({});
          mockTx.tdsDeductionEntry.findMany.mockResolvedValue([
            { clientId: 'deoleo', panNumber: '__NO_PAN__:p1', tdsDeductedThisPaise: 200000n },
            { clientId: 'other', panNumber: '__NO_PAN__:p1', tdsDeductedThisPaise: 999900n },
          ]);

          await download();

          expect(ledgerRow()).toMatchObject({ tdsDeductedPriorPaise: 200000n, tdsDeductedThisPaise: 400000n });
          const where = mockTx.tdsDeductionEntry.findMany.mock.calls.map((c: [{ where: Record<string, unknown> }]) => c[0].where)
            .find((w: Record<string, unknown>) => w.section === 'SEC_194R');
          // Owner rule 2026-11-18: netted by the ledger row's OWN key (PAN / no-PAN owner key at withholding).
          expect(where).toMatchObject({ clientId: 'deoleo', panNumber: { in: ['__NO_PAN__:p1'] } });
        });

        it('GROSS_UP client: a no-PAN retailer is still paid in full (client-borne on the report)', async () => {
          policy('GROSS_UP');
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(3000000n)]);
          mockPrisma.outlet.findMany.mockResolvedValue([noPanOutlet()]);
          priorRows({});

          await download();

          expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
          expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(3000000));
        });

        it('takes the per-owner 194R lock', async () => {
          policy('DEDUCT');
          mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([run(3000000n)]);
          mockPrisma.outlet.findMany.mockResolvedValue([noPanOutlet()]);
          priorRows({});
          await download();
          expect(lockKeysTaken()).toContain(`R194|deoleo|${runFy}`);
          expect(lockKeysTaken().some((k) => k.startsWith('NOPAN|'))).toBe(false);
        });
      });
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
      // withheld nothing → tdsDeductedPaise cleared. The bank reason ("bounced" from the file's
      // Remarks cell) is captured into failureReason; no payment date / UTR in this file → both null.
      expect(mockTx.creditPayoutEntry.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['e1'] }, status: 'PROCESSING' },
        data: {
          status: 'FAILED', utr: null, paidAt: null, tdsDeductedPaise: 0n,
          failureReason: 'bounced', attemptedAt: null,
        },
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

    it('policy round B: a FAILED payout gives back the TDS credit it used (released once, called out in the result)', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1', downloadCode: 'PD-2026-05-001', period: '2026-05', downloadedBy: 'g1',
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: 5000000n }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([{
        id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: 5000000n,
        tdsDeductedPaise: 0n, tdsSection: 'SEC_194C', period: '2026-05', // the credit covered the whole TDS
      }]);
      // B6: the UTR upload first reads the credit's key (select tdsCredit) to lock it, then releases the application.
      mockTx.tdsCreditApplication.findMany
        .mockResolvedValueOnce([{ tdsCredit: { section: 'SEC_194R', panNumber: 'PAN1', fyLabel: '2026-27' } }])
        .mockResolvedValueOnce([{ id: 'a1', tdsCreditId: 'c1', payoutEntryId: 'e1', amountPaise: 40000n, clientId: 'deoleo' }]);
      mockTx.tdsCreditApplication.updateMany.mockResolvedValueOnce({ count: 1 });
      mockTx.$executeRaw.mockResolvedValue(1);
      const aoa = [['title'], ['Batch ID', 'Outlet ID', 'UTR', 'Success/Failure', 'Remarks'], ['PD-2026-05-001', 'O1', '', 'Failure', 'bounced']];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payout');
      const file = { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File;

      const res = (await service.uploadUtr(gifsy, 'd1', file, true)) as Record<string, any>;

      expect(mockTx.tdsCreditApplication.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { payoutEntryId: { in: ['e1'] }, releasedAt: null } }),
      );
      expect(mockTx.tdsCreditApplication.updateMany).toHaveBeenCalledWith({
        where: { id: 'a1', releasedAt: null },
        data: { releasedAt: expect.any(Date), releaseReason: 'PAYOUT_FAILED' },
      });
      expect(lockKeysTaken()).toContain('R194|deoleo|2026-27'); // B6 — although e1 carries no withholding
      expect(res.tdsCreditReleased).toEqual([
        { entryId: 'e1', amountPaise: 40000, note: expect.stringMatching(/^₹400.00 TDS credit returned to the PAN.s credit balance — this payout failed/) },
      ]);
    });

    // ── Non-success capture: failureReason + attemptedAt + uploaded UTR ──────────────────────────
    it('a FAILED payout captures failureReason, attemptedAt and the uploaded UTR from the row', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1', downloadCode: 'PD-2026-05-001', period: '2026-05', downloadedBy: 'g1',
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: 5000000n }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]); // used-UTR dedup query
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([{
        id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: 5000000n,
        tdsDeductedPaise: 0n, tdsSection: null, period: '2026-05',
      }]);

      // A failed row CAN carry a UTR + a Payment Date (the bank reference + attempt date).
      const aoa = [
        ['title'],
        ['Batch ID', 'Outlet ID', 'UTR', 'Success/Failure', 'Remarks', 'Payment Date'],
        ['PD-2026-05-001', 'O1', 'utr99887766', 'Failed', 'Account Closed', '2026-05-20'],
      ];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payout');
      const file = { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File;

      await service.uploadUtr(gifsy, 'd1', file, true);

      const data = mockTx.creditPayoutEntry.updateMany.mock.calls.at(-1)![0].data;
      expect(data.status).toBe('FAILED');
      expect(data.paidAt).toBeNull(); // MUST stay null so it never leaks into the default/PAID view
      expect(data.failureReason).toBe('Account Closed'); // raw bank reason from the Remarks cell
      expect(data.utr).toBe('UTR99887766'); // uploaded reference kept + upper-cased
      expect(data.attemptedAt).toBeInstanceOf(Date); // the uploaded failure/attempt date
      expect(data.tdsDeductedPaise).toBe(0n);
      // narration is NEVER touched by the capture now (operator remark preserved as-is).
      expect(data).not.toHaveProperty('narration');
    });

    it('a FAILED payout with a blank Remarks cell stores failureReason null (no reason to record)', async () => {
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValue({
        id: 'd1', downloadCode: 'PD-2026-05-001', period: '2026-05', downloadedBy: 'g1',
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: 5000000n }],
      });
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
      mockTx.creditPayoutEntry.findMany.mockResolvedValue([{
        id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: 5000000n,
        tdsDeductedPaise: 0n, tdsSection: null, period: '2026-05',
      }]);

      const aoa = [['title'], ['Batch ID', 'Outlet ID', 'UTR', 'Success/Failure', 'Remarks'], ['PD-2026-05-001', 'O1', '', 'Failed', '']];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Payout');
      const file = { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File;

      await service.uploadUtr(gifsy, 'd1', file, true);

      const data = mockTx.creditPayoutEntry.updateMany.mock.calls.at(-1)![0].data;
      expect(data).toMatchObject({ status: 'FAILED', paidAt: null, utr: null, failureReason: null, attemptedAt: null });
    });

    // ── Re-upload idempotency: the SAME FAILED file applied twice does NOT change state ───────────
    // The protection is the FIX-C guarded flip (where:{ status:'PROCESSING' }): once FAILED the entry
    // is no longer PROCESSING, so the second apply matches 0 rows. And because failureReason is
    // OVERWRITTEN (not appended), even a hypothetical re-apply would be value-stable — no accretion.
    it('does NOT mutate a FAILED entry (reason/reversal) when the SAME file is applied twice', async () => {
      const store = {
        id: 'e1', outletId: 'O1', status: 'PROCESSING', amountPaise: 5000000n,
        tdsDeductedPaise: 50000n, tdsSection: 'SEC_194C', period: '2026-05',
        failureReason: null as string | null, attemptedAt: null as Date | null, utr: null as string | null,
      };
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]); // used-UTR dedup (both applies)
      mockTx.creditPayoutEntry.findMany.mockImplementation(async () => [{ ...store }]);
      mockTx.creditPayoutEntry.updateMany.mockImplementation(async (arg: { where: { id: { in: string[] }; status: string }; data: Record<string, unknown> }) => {
        if (arg.where.id.in.includes(store.id) && store.status === arg.where.status) {
          Object.assign(store, arg.data);
          return { count: 1 };
        }
        return { count: 0 };
      });
      mockTx.tdsDeductionEntry.findMany.mockResolvedValue([{ creditPayoutEntryId: 'e1', panNumber: 'PAN1' }]);

      const buildFailFile = () => {
        const aoa = [['title'], ['Batch ID', 'Outlet ID', 'UTR', 'Success/Failure', 'Remarks'], ['PD-2026-05-001', 'O1', '', 'Failed', 'Account Closed']];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Payout');
        return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File;
      };

      // First apply: PROCESSING → FAILED, reason captured, withholding reversed once.
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValueOnce({
        id: 'd1', downloadCode: 'PD-2026-05-001', period: '2026-05', downloadedBy: 'g1',
        entries: [{ id: 'e1', outletId: 'O1', status: 'PROCESSING', utr: null, amountPaise: 5000000n }],
      });
      await service.uploadUtr(gifsy, 'd1', buildFailFile(), true);
      expect(store.status).toBe('FAILED');
      expect(store.failureReason).toBe('Account Closed');
      expect(mockTx.tdsDeductionEntry.createMany).toHaveBeenCalledTimes(1);

      // Second apply of the SAME file: entry is now FAILED (NOT PROCESSING) → guarded flip = 0 rows.
      mockPrisma.creditPayoutDownload.findFirst.mockResolvedValueOnce({
        id: 'd1', downloadCode: 'PD-2026-05-001', period: '2026-05', downloadedBy: 'g1',
        entries: [{ id: 'e1', outletId: 'O1', status: 'FAILED', utr: null, amountPaise: 5000000n }],
      });
      await service.uploadUtr(gifsy, 'd1', buildFailFile(), true);

      const lastFlip = mockTx.creditPayoutEntry.updateMany.mock.calls.at(-1)![0];
      expect(lastFlip.where).toEqual({ id: { in: ['e1'] }, status: 'PROCESSING' }); // guard unchanged
      expect(store.failureReason).toBe('Account Closed'); // unchanged (single value, no accretion)
      expect(store.status).toBe('FAILED');
      expect(mockTx.tdsDeductionEntry.createMany).toHaveBeenCalledTimes(1); // no second reversal
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

      // The in-tx read (under the lock) said PROCESSING but the guarded flip moved nothing → the
      // state changed under us → the WHOLE apply rolls back (Conflict) — never a partial apply.
      await expect(service.uploadUtr(gifsy, 'd1', file, true)).rejects.toBeInstanceOf(ConflictException);

      // The advisory lock was taken and the flip attempted, but count=0 → NO compensating reversal.
      expect(mockTx.$executeRaw).toHaveBeenCalled();
      expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
      expect(mockNotifications.notifyUserWithChannels).not.toHaveBeenCalled();
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

      // A-M3: ALL advisory locks in ONE round-trip — a single statement over the sorted key array (the other
      // $executeRaw in the tx is the payee snapshot UPDATE).
      const lockCalls = mockTx.$executeRaw.mock.calls.filter((c: unknown[]) => (c[0] as string[]).join('?').includes('pg_advisory_xact_lock'));
      expect(lockCalls).toHaveLength(1);
      expect(lockCalls[0][1]).toEqual(['PAN|PAN1|2026-27', 'PDLOCK|deoleo|2026-05']);
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

      // No deduction, no per-PAN TDS invoice — paid in full; nothing recorded at the bank file (owner 2026-11-25).
      expect(mockTx.tdsRecoveryEntry.createMany).not.toHaveBeenCalled();
      await payNow('2026-05');
      expect(mockInvoicesService.createTdsInvoice).not.toHaveBeenCalled();
      expect(mockTx.tdsDeductionEntry.createMany).not.toHaveBeenCalled();
      expect(mockTx.creditPayoutDownload.create.mock.calls[0][0].data.totalAmountPaise).toBe(BigInt(4000000));
      // Recovery row (on PAID): __NO_PAN__:<outlet> encoded sentinel, 20% grossed-up on ₹40,000 = 1000000, no invoice.
      const rec = mockTx.tdsRecoveryEntry.createMany.mock.calls[0][0].data[0];
      expect(rec.raisedOn).toBe('PAID');
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
      await payNow('2026-05'); // the re-banked payout is now PAID

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
