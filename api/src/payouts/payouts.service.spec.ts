// Unit tests for PayoutsService — ported from platform/src/app/api/payouts/*.
// Covers tenant scoping, the fund-receipt + ledger transaction, the batch
// process pipeline (validation/TDS/fund-check/disbursement), and the
// reconciliation export. Run: npx jest src/payouts/payouts.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { PayoutsService } from './payouts.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockTx = {
  fundReceipt: { create: jest.fn() },
  fundLedger: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  // update: processBatch disbursement; updateMany: the UTR upload's compare-and-set terminal claim.
  payoutTransaction: { update: jest.fn(), updateMany: jest.fn() },
  payoutBatch: { update: jest.fn() },
  redemptionOrder: {
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  // Shared order-status transition writes the status-history row inside the same tx.
  redemptionStatusHistory: { create: jest.fn() },
  // capture-bank-at-redemption: the PAID/FAILED verify-stamp updates the partner's
  // paymentDetailsStatus inside the disbursement tx (guarded on UNVERIFIED). findFirst reads the
  // partner's CURRENT upiId for the case-insensitive UPI snapshot match on PAID.
  channelPartner: { updateMany: jest.fn(), findFirst: jest.fn() },
};

const mockPrisma = {
  payoutTransaction: {
    findMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  payoutBatch: {
    findMany: jest.fn(),
    count: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  fundReceipt: { aggregate: jest.fn() },
  fundLedger: { findFirst: jest.fn() },
  // processBatch reads the tenant's features (allowPayoutWithoutPan). Default (undefined) = flag OFF.
  client: { findUnique: jest.fn() },
  tdsRecord: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  // Flow-B payout WhatsApp batch-reads the partner owner (ownerName+phone) + the
  // redemption order (pointsDeducted) POST-COMMIT — not inside the tx.
  channelPartner: { findMany: jest.fn() },
  redemptionOrder: { findMany: jest.fn() },
  // D5 delivery-receipt table for the post-commit payout WhatsApp (best-effort, gated).
  messageDeliveryReceipt: { create: jest.fn(), updateMany: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown, _opts?: { timeout?: number; maxWait?: number }) => cb(mockTx)),
};

const mockWallet = {
  reverse: jest.fn(),
};

const mockMsg91 = {
  sendWhatsappTemplate: jest.fn().mockResolvedValue(undefined),
};

const gifsy: JwtPayload = {
  sub: 'admin1',
  role: 'GIFSY_ADMIN',
  clientId: 'deoleo',
  phone: '',
  name: '',
};

describe('PayoutsService', () => {
  let service: PayoutsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: the guarded atomic claim in processBatch succeeds (count 1).
    // Individual tests override to exercise the 0-count bad-state path.
    mockPrisma.payoutBatch.updateMany.mockResolvedValue({ count: 1 });
    // processBatch's PENDING→INITIATED compare-and-set wins by default.
    mockTx.payoutTransaction.updateMany.mockResolvedValue({ count: 1 });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWallet },
        { provide: Msg91Service, useValue: mockMsg91 },
      ],
    }).compile();
    service = module.get(PayoutsService);
  });

  describe('listTransactions', () => {
    it('tenant-scopes via the batch relation and applies filters', async () => {
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([]);
      mockPrisma.payoutTransaction.count.mockResolvedValue(0);
      await service.listTransactions(gifsy, {
        status: 'PENDING' as never,
        mode: 'UPI' as never,
        partnerId: 'p1',
      });
      const where = mockPrisma.payoutTransaction.findMany.mock.calls[0][0].where;
      expect(where).toEqual({
        batch: { clientId: 'deoleo' },
        status: 'PENDING',
        payoutMode: 'UPI',
        partnerId: 'p1',
      });
    });

    it('builds a createdAt range when dates are supplied', async () => {
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([]);
      mockPrisma.payoutTransaction.count.mockResolvedValue(0);
      // Bounds are now strings (IsDateString). A FULL-ISO datetime is passed through
      // as-is; DATE-ONLY values expand to inclusive IST-day bounds — that expansion is
      // covered in payouts.service.ist-dates.spec.ts.
      const from = '2026-01-01T00:00:00.000Z';
      const to = '2026-02-01T00:00:00.000Z';
      await service.listTransactions(gifsy, { dateFrom: from, dateTo: to });
      const where = mockPrisma.payoutTransaction.findMany.mock.calls[0][0].where;
      expect(where.createdAt).toEqual({ gte: new Date(from), lte: new Date(to) });
    });

    it('filters to one batch via batchId, still tenant-scoped through the batch relation', async () => {
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([]);
      mockPrisma.payoutTransaction.count.mockResolvedValue(0);
      await service.listTransactions(gifsy, { batchId: 'b1' });
      const where = mockPrisma.payoutTransaction.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ batch: { clientId: 'deoleo' }, batchId: 'b1' });
    });

    it('ignores batchId when unbatched is set (unbatched pins batchId null)', async () => {
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([]);
      mockPrisma.payoutTransaction.count.mockResolvedValue(0);
      await service.listTransactions(gifsy, { unbatched: true, batchId: 'b1' });
      const where = mockPrisma.payoutTransaction.findMany.mock.calls[0][0].where;
      expect(where.batchId).toBeNull();
    });

    it('scopes unbatched by partner.clientId (not the null batch relation)', async () => {
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([]);
      mockPrisma.payoutTransaction.count.mockResolvedValue(0);
      await service.listTransactions(gifsy, { unbatched: true });
      const where = mockPrisma.payoutTransaction.findMany.mock.calls[0][0].where;
      // A `batch: { clientId }` relation filter can't match a null batch, so the
      // tenant scope must ride the partner relation instead.
      expect(where).toEqual({
        batchId: null,
        status: 'PENDING',
        partner: { clientId: 'deoleo' },
      });
      expect(where.batch).toBeUndefined();
    });
  });

  describe('getFundSummary', () => {
    it('aggregates received/utilised and derives available balance', async () => {
      mockPrisma.fundLedger.findFirst.mockResolvedValue({ balancePaise: 100000 });
      mockPrisma.fundReceipt.aggregate.mockResolvedValue({ _sum: { amountPaise: 150000 } });
      mockPrisma.payoutTransaction.groupBy.mockResolvedValue([
        { payoutMode: 'UPI', _sum: { amountPaise: 40000 } },
      ]);
      mockPrisma.payoutTransaction.aggregate.mockResolvedValue({ _sum: { amountPaise: 10000 } });

      const res = await service.getFundSummary(gifsy);
      expect(res.totalReceivedPaise).toBe(150000);
      expect(res.totalUtilisedPaise).toBe(40000);
      expect(res.closingBalancePaise).toBe(100000); // latest ledger balance wins
      expect(res.pendingLiabilityPaise).toBe(10000);
      expect(res.availablePaise).toBe(90000); // 100000 - 10000
    });
  });

  describe('receiveFund', () => {
    it('creates a receipt + ledger entry and returns the new balance', async () => {
      mockPrisma.fundLedger.findFirst.mockResolvedValue({ balancePaise: 50000 });
      mockTx.fundReceipt.create.mockResolvedValue({ id: 'r1' });
      mockTx.fundLedger.create.mockResolvedValue({ id: 'l1' });

      const res = await service.receiveFund(gifsy, {
        amount: 100,
        paymentDate: new Date('2026-06-01'),
        referenceNumber: 'REF1',
      });

      expect(mockTx.fundReceipt.create).toHaveBeenCalled();
      const ledgerData = mockTx.fundLedger.create.mock.calls[0][0].data;
      expect(ledgerData.balancePaise).toBe(60000n); // 50000 + 10000 (BigInt paise)
      expect(mockTx.auditLog.create).toHaveBeenCalled();
      expect(res).toEqual({
        receiptId: 'r1',
        amount: 100,
        newBalance: 600,
        referenceNumber: 'REF1',
      });
    });
  });

  describe('createBatch', () => {
    it('creates a DRAFT batch scoped to the caller tenant', async () => {
      mockPrisma.payoutBatch.create.mockResolvedValue({ id: 'b1' });
      const res = await service.createBatch(gifsy, { payoutMode: 'UPI' as never });
      const data = mockPrisma.payoutBatch.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        payoutMode: 'UPI',
        status: 'DRAFT',
        createdByUserId: 'admin1',
        clientId: 'deoleo',
      });
      expect(res).toEqual({ batch: { id: 'b1' } });
    });
  });

  describe('getBatch', () => {
    it('throws NotFound when the batch is outside the tenant', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue(null);
      await expect(service.getBatch(gifsy, 'b1', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns the batch + paginated transactions', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([{ id: 't1' }]);
      mockPrisma.payoutTransaction.count.mockResolvedValue(1);
      const res = await service.getBatch(gifsy, 'b1', {});
      expect(res.batch).toEqual({ id: 'b1' });
      expect(res.transactions).toEqual([{ id: 't1' }]);
      expect(res.pagination).toEqual({ page: 1, limit: 50, total: 1, pages: 1 });
    });
  });

  describe('processBatch', () => {
    it('throws NotFound for a missing batch', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue(null);
      await expect(service.processBatch(gifsy, 'b1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a non-processable batch via the 0-count guarded claim', async () => {
      // Batch exists in-tenant, but the atomic claim matches nothing (already
      // PROCESSING/COMPLETED) → BadRequest, not a read-then-write race.
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'COMPLETED' });
      mockPrisma.payoutBatch.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.processBatch(gifsy, 'b1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // The claim must carry the status-in guard.
      const claimWhere = mockPrisma.payoutBatch.updateMany.mock.calls[0][0].where;
      expect(claimWhere.status).toEqual({ in: ['DRAFT', 'SUBMITTED', 'FAILED'] });
      expect(claimWhere).toMatchObject({ id: 'b1', clientId: 'deoleo' });
      // No work should run on a failed claim.
      expect(mockPrisma.payoutTransaction.findMany).not.toHaveBeenCalled();
    });

    it('flags valid transactions to INITIATED and SUBMITs with NO fund gate', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      // One eligible tx (amountPaise 3,000,000 = ₹30,000). Partner must be
      // KYC-APPROVED, active, non-deleted, and have mode-required beneficiary fields.
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1',
          partnerId: 'p1',
          amountPaise: 3000000,
          payoutMode: 'UPI',
          upiId: 'partner@upi',
          bankAccountNumber: null,
          ifscCode: null,
          partner: {
            panNumber: 'ABCDE1234F',
            isActive: true,
            deletedAt: null,
            kycSubmissions: [{ status: 'APPROVED' }],
          },
        },
      ]);

      const res = await service.processBatch(gifsy, 'b1');

      // Payouts do NOT withhold TDS — the TDS engine owns that.
      expect(mockPrisma.tdsRecord.create).not.toHaveBeenCalled();
      expect(res.steps).not.toHaveProperty('tdsComputation');
      // The fund gate is gone — there is no in-portal fund / gateway.
      expect(res.steps).not.toHaveProperty('fundCheck');
      // No fund ledger should be consulted during processing.
      expect(mockPrisma.fundLedger.findFirst).not.toHaveBeenCalled();
      expect(res.steps.disbursement.flagged).toBe(1);
      expect(res.status).toBe('SUBMITTED');
      // The disbursement + finalisation run inside the $transaction.
      // Guarded compare-and-set: only a still-PENDING row moves to INITIATED.
      expect(mockTx.payoutTransaction.updateMany).toHaveBeenCalledWith({
        where: { id: 't1', status: 'PENDING' },
        data: { status: 'INITIATED' },
      });
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    });

    it('SUBMITs even when no on-portal funds exist (offline transfer — no fund gate)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 500000,
          payoutMode: 'UPI', upiId: 'partner@upi', bankAccountNumber: null, ifscCode: null,
          partner: {
            panNumber: 'ABCDE1234F', isActive: true, deletedAt: null,
            kycSubmissions: [{ status: 'APPROVED' }],
          },
        },
      ]);

      const res = await service.processBatch(gifsy, 'b1');
      // Previously this FAILED on an insufficient-fund gate; now it always SUBMITs.
      expect(res.steps.disbursement.flagged).toBe(1);
      expect(res.status).toBe('SUBMITTED');
    });

    it('flags PAN-less transactions as validation warnings and excludes them', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'UPI', upiId: 'partner@upi', bankAccountNumber: null, ifscCode: null,
          partner: {
            panNumber: null, isActive: true, deletedAt: null,
            kycSubmissions: [{ status: 'APPROVED' }],
          },
        },
      ]);

      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.validation.status).toBe('PASSED_WITH_WARNINGS');
      expect(res.steps.disbursement.flagged).toBe(0); // invalid tx excluded
      // Even with zero valid transactions, the batch finalises SUBMITTED (no gate).
      expect(res.status).toBe('SUBMITTED');
    });

    // ── allowPayoutWithoutPan (per-tenant behaviour flag, default OFF) ──────────

    const noPanTx = (over: Record<string, unknown> = {}) => ({
      id: 't-nopan', partnerId: 'p-nopan', amountPaise: 150000,
      payoutMode: 'UPI', upiId: 'nopan@upi', bankAccountNumber: null, ifscCode: null,
      partner: {
        panNumber: null, isActive: true, deletedAt: null,
        kycSubmissions: [{ status: 'APPROVED' }],
      },
      ...over,
    });

    it('allowPayoutWithoutPan ABSENT: no-PAN tx is excluded with the exact legacy error (regression)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.client.findUnique.mockResolvedValue({ features: { soDeclarationKyc: true } });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([noPanTx()]);

      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.validation.errors).toEqual(['No PAN for partner p-nopan']);
      expect(res.steps.validation.status).toBe('PASSED_WITH_WARNINGS');
      expect(res.steps.disbursement.flagged).toBe(0);
      expect(mockTx.payoutTransaction.updateMany).not.toHaveBeenCalled();
      // The flag is read for THIS batch's tenant only.
      expect(mockPrisma.client.findUnique).toHaveBeenCalledWith({
        where: { id: 'deoleo' },
        select: { features: true },
      });
    });

    it('allowPayoutWithoutPan=false / non-boolean / null features: still excluded (only strict true enables)', async () => {
      for (const features of [{ allowPayoutWithoutPan: false }, { allowPayoutWithoutPan: 'true' }, null]) {
        jest.clearAllMocks();
        mockPrisma.payoutBatch.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
        mockPrisma.client.findUnique.mockResolvedValue({ features });
        mockPrisma.payoutTransaction.findMany.mockResolvedValue([noPanTx()]);
        const res = await service.processBatch(gifsy, 'b1');
        expect(res.steps.validation.errors).toEqual(['No PAN for partner p-nopan']);
        expect(res.steps.disbursement.flagged).toBe(0);
      }
    });

    it('allowPayoutWithoutPan ON: no-PAN tx is valid and flagged INITIATED alongside a PAN tx', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.client.findUnique.mockResolvedValue({ features: { allowPayoutWithoutPan: true } });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        noPanTx(),
        noPanTx({ id: 't-blankpan', partnerId: 'p-blank', partner: {
          panNumber: '', isActive: true, deletedAt: null, kycSubmissions: [{ status: 'APPROVED' }],
        } }),
        noPanTx({ id: 't-pan', partnerId: 'p-pan', partner: {
          panNumber: 'ABCDE1234F', isActive: true, deletedAt: null, kycSubmissions: [{ status: 'APPROVED' }],
        } }),
      ]);

      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.validation.errors).toEqual([]);
      expect(res.steps.validation.status).toBe('PASSED');
      expect(res.steps.disbursement.flagged).toBe(3);
      expect(res.status).toBe('SUBMITTED');
      const flaggedIds = mockTx.payoutTransaction.updateMany.mock.calls.map((c) => c[0].where.id);
      expect(flaggedIds).toEqual(['t-nopan', 't-blankpan', 't-pan']);
      // Payouts still never withhold TDS (the TDS engine buckets no-PAN under __NO_PAN__).
      expect(mockPrisma.tdsRecord.create).not.toHaveBeenCalled();
    });

    it('allowPayoutWithoutPan ON: every OTHER validation still excludes a no-PAN tx', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.client.findUnique.mockResolvedValue({ features: { allowPayoutWithoutPan: true } });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        noPanTx({ id: 't-amt', partnerId: 'p-amt', amountPaise: 0 }),
        noPanTx({ id: 't-kyc', partnerId: 'p-kyc', partner: {
          panNumber: null, isActive: true, deletedAt: null, kycSubmissions: [{ status: 'PENDING_ASM_APPROVAL' }],
        } }),
        noPanTx({ id: 't-inactive', partnerId: 'p-inactive', partner: {
          panNumber: null, isActive: false, deletedAt: null, kycSubmissions: [{ status: 'APPROVED' }],
        } }),
        noPanTx({ id: 't-upi', partnerId: 'p-upi', upiId: null }),
        noPanTx({ id: 't-bank', partnerId: 'p-bank', payoutMode: 'BANK_TRANSFER', upiId: null, ifscCode: 'HDFC0001234' }),
      ]);

      const res = await service.processBatch(gifsy, 'b1');
      const errs = res.steps.validation.errors;
      expect(errs.some((e) => /No PAN/.test(e))).toBe(false);
      expect(errs).toEqual(expect.arrayContaining([
        'Invalid amount for tx t-amt',
        expect.stringMatching(/p-kyc KYC is not approved/),
        expect.stringMatching(/p-inactive is ineligible \(PARTNER_INACTIVE\)/),
        'Missing upiId for UPI transaction t-upi',
        expect.stringMatching(/\[bankAccountNumber\] for BANK_TRANSFER transaction t-bank/),
      ]));
      expect(res.steps.disbursement.flagged).toBe(0);
      expect(mockTx.payoutTransaction.updateMany).not.toHaveBeenCalled();
    });

    it('RACE: a tx recorded as paid off-platform meanwhile (CAS count 0) is skipped, never overwritten', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.client.findUnique.mockResolvedValue({ features: {} });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        noPanTx({ id: 't-raced', partnerId: 'p1', partner: {
          panNumber: 'ABCDE1234F', isActive: true, deletedAt: null, kycSubmissions: [{ status: 'APPROVED' }],
        } }),
        noPanTx({ id: 't-ok', partnerId: 'p2', partner: {
          panNumber: 'ABCDE1234G', isActive: true, deletedAt: null, kycSubmissions: [{ status: 'APPROVED' }],
        } }),
      ]);
      mockTx.payoutTransaction.updateMany
        .mockResolvedValueOnce({ count: 0 }) // t-raced: already SUCCESS (off-platform upload won)
        .mockResolvedValueOnce({ count: 1 });
      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.disbursement.flagged).toBe(1);
      expect(mockTx.payoutTransaction.update).not.toHaveBeenCalled();
      for (const c of mockTx.payoutTransaction.updateMany.mock.calls) {
        expect(c[0].where.status).toBe('PENDING');
      }
    });

    it('resets a claimed batch to FAILED if a step throws (never strands it in PROCESSING)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutBatch.updateMany.mockResolvedValue({ count: 1 }); // claim wins
      mockPrisma.payoutBatch.update.mockResolvedValue({});
      const boom = new Error('db dropped mid-process');
      mockPrisma.payoutTransaction.findMany.mockRejectedValue(boom);

      await expect(service.processBatch(gifsy, 'b1')).rejects.toBe(boom);
      // The claimed batch (PROCESSING) must be reset to FAILED — a re-claimable
      // state — so the transient error doesn't leave it permanently stuck.
      expect(mockPrisma.payoutBatch.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { status: 'FAILED' },
      });
    });

    // ── GLB-1b: partner eligibility gate in processBatch ──────────────────────

    it('GLB-1b: excludes a transaction whose partner KYC is not APPROVED', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'UPI', upiId: 'partner@upi', bankAccountNumber: null, ifscCode: null,
          partner: {
            panNumber: 'ABCDE1234F', isActive: true, deletedAt: null,
            kycSubmissions: [{ status: 'PENDING_ASM_APPROVAL' }],
          },
        },
      ]);
      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.validation.status).toBe('PASSED_WITH_WARNINGS');
      expect(res.steps.validation.errors.length).toBeGreaterThan(0);
      expect(res.steps.validation.errors[0]).toMatch(/KYC.*not approved/i);
      expect(res.steps.disbursement.flagged).toBe(0); // excluded from INITIATED
      expect(res.status).toBe('SUBMITTED');
    });

    it('GLB-1b: excludes a transaction whose partner has no KYC submission', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'UPI', upiId: 'partner@upi', bankAccountNumber: null, ifscCode: null,
          partner: {
            panNumber: 'ABCDE1234F', isActive: true, deletedAt: null,
            kycSubmissions: [], // no submission
          },
        },
      ]);
      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.validation.errors[0]).toMatch(/KYC.*not approved/i);
      expect(res.steps.disbursement.flagged).toBe(0);
    });

    it('GLB-1b: excludes a transaction whose partner is inactive', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'UPI', upiId: 'partner@upi', bankAccountNumber: null, ifscCode: null,
          partner: {
            panNumber: 'ABCDE1234F', isActive: false, deletedAt: null,
            kycSubmissions: [{ status: 'APPROVED' }],
          },
        },
      ]);
      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.validation.errors[0]).toMatch(/PARTNER_INACTIVE/);
      expect(res.steps.disbursement.flagged).toBe(0);
    });

    it('GLB-1b: excludes a transaction whose partner is soft-deleted', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'UPI', upiId: 'partner@upi', bankAccountNumber: null, ifscCode: null,
          partner: {
            panNumber: 'ABCDE1234F', isActive: true, deletedAt: new Date(),
            kycSubmissions: [{ status: 'APPROVED' }],
          },
        },
      ]);
      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.validation.errors[0]).toMatch(/PARTNER_DELETED/);
      expect(res.steps.disbursement.flagged).toBe(0);
    });

    // ── GLM-3: beneficiary field validation ───────────────────────────────────

    it('GLM-3: excludes a UPI transaction missing upiId', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'UPI', upiId: null, bankAccountNumber: null, ifscCode: null,
          partner: {
            panNumber: 'ABCDE1234F', isActive: true, deletedAt: null,
            kycSubmissions: [{ status: 'APPROVED' }],
          },
        },
      ]);
      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.validation.status).toBe('PASSED_WITH_WARNINGS');
      expect(res.steps.validation.errors[0]).toMatch(/upiId/);
      expect(res.steps.disbursement.flagged).toBe(0);
    });

    it('GLM-3: excludes a BANK_TRANSFER transaction missing bankAccountNumber', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'BANK_TRANSFER', upiId: null, bankAccountNumber: null, ifscCode: 'SBIN0000123',
          partner: {
            panNumber: 'ABCDE1234F', isActive: true, deletedAt: null,
            kycSubmissions: [{ status: 'APPROVED' }],
          },
        },
      ]);
      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.validation.errors[0]).toMatch(/bankAccountNumber/);
      expect(res.steps.disbursement.flagged).toBe(0);
    });

    it('GLM-3: excludes a BANK_TRANSFER transaction missing ifscCode', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'BANK_TRANSFER', upiId: null, bankAccountNumber: '123456789', ifscCode: null,
          partner: {
            panNumber: 'ABCDE1234F', isActive: true, deletedAt: null,
            kycSubmissions: [{ status: 'APPROVED' }],
          },
        },
      ]);
      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.validation.errors[0]).toMatch(/ifscCode/);
      expect(res.steps.disbursement.flagged).toBe(0);
    });

    it('GLM-3: excludes a BANK_TRANSFER transaction missing BOTH bankAccountNumber and ifscCode', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'BANK_TRANSFER', upiId: null, bankAccountNumber: null, ifscCode: null,
          partner: {
            panNumber: 'ABCDE1234F', isActive: true, deletedAt: null,
            kycSubmissions: [{ status: 'APPROVED' }],
          },
        },
      ]);
      const res = await service.processBatch(gifsy, 'b1');
      const err = res.steps.validation.errors[0];
      expect(err).toMatch(/bankAccountNumber/);
      expect(err).toMatch(/ifscCode/);
      expect(res.steps.disbursement.flagged).toBe(0);
    });

    it('GLM-3: passes a fully-valid BANK_TRANSFER transaction (both fields present)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'BANK_TRANSFER', upiId: null,
          bankAccountNumber: '123456789', ifscCode: 'SBIN0000123',
          partner: {
            panNumber: 'ABCDE1234F', isActive: true, deletedAt: null,
            kycSubmissions: [{ status: 'APPROVED' }],
          },
        },
      ]);
      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.validation.status).toBe('PASSED');
      expect(res.steps.disbursement.flagged).toBe(1);
      expect(res.status).toBe('SUBMITTED');
    });

    // ── resolveEffectiveKycStatus ordering coverage ───────────────────────────

    it('resolver: stale APPROVED loses to a newer RE_KYC_REQUIRED when createdAt is later', async () => {
      // Two submissions: older APPROVED (2026-01-01) + newer RE_KYC_REQUIRED (2026-06-01).
      // resolveEffectiveKycStatus sorts createdAt DESC → newer RE_KYC wins → not payable.
      // This exercises the multi-submission sort path (single-element sort skips comparator).
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'UPI', upiId: 'p@upi', bankAccountNumber: null, ifscCode: null,
          partner: {
            panNumber: 'ABCDE1234F', isActive: true, deletedAt: null,
            kycSubmissions: [
              // OLDER submission — was APPROVED (stale)
              { id: 'ks-old', status: 'APPROVED',        createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') },
              // NEWER submission — reKyc triggered RE_KYC_REQUIRED in-place on this row
              { id: 'ks-new', status: 'RE_KYC_REQUIRED', createdAt: new Date('2026-06-01'), updatedAt: new Date('2026-06-15') },
            ],
          },
        },
      ]);

      const res = await service.processBatch(gifsy, 'b1');

      // The newer RE_KYC_REQUIRED status wins — partner is ineligible → excluded.
      expect(res.steps.validation.errors.length).toBeGreaterThan(0);
      expect(res.steps.validation.errors[0]).toMatch(/KYC.*not approved/i);
      expect(res.steps.disbursement.flagged).toBe(0);
    });

    it('resolver: updatedAt tiebreak surfaces the in-place reKyc mutation over stale APPROVED', async () => {
      // Both submissions have the SAME createdAt (millisecond tie) — tests the secondary
      // updatedAt DESC sort path. ks-rekyc was mutated later (updatedAt 2026-06-15)
      // even though both were created at the same timestamp.
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      const sameCreated = new Date('2026-06-01T12:00:00.000Z');
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'UPI', upiId: 'p@upi', bankAccountNumber: null, ifscCode: null,
          partner: {
            panNumber: 'ABCDE1234F', isActive: true, deletedAt: null,
            kycSubmissions: [
              // Same createdAt — stale APPROVED (updatedAt also same)
              { id: 'ks-a', status: 'APPROVED',         createdAt: sameCreated, updatedAt: new Date('2026-06-01T12:00:00.000Z') },
              // Same createdAt — RE_KYC mutated later (updatedAt > ks-a.updatedAt) → wins
              { id: 'ks-b', status: 'RE_KYC_REQUIRED',  createdAt: sameCreated, updatedAt: new Date('2026-06-15T09:00:00.000Z') },
            ],
          },
        },
      ]);

      const res = await service.processBatch(gifsy, 'b1');

      // updatedAt tiebreak: ks-b (RE_KYC_REQUIRED, updated 2026-06-15) wins over
      // ks-a (APPROVED, updated same timestamp) → partner excluded.
      expect(res.steps.validation.errors[0]).toMatch(/KYC.*not approved/i);
      expect(res.steps.disbursement.flagged).toBe(0);
    });

    it('raises the interactive-tx timeout so a full-tenant disbursement survives (no 5s expiry)', async () => {
      // The disbursement loop over validTransactions runs inside ONE atomic tx; at
      // Deoleo scale it must not hit the default 5000ms interactive-tx budget.
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1', partnerId: 'p1', amountPaise: 100000,
          payoutMode: 'UPI', upiId: 'partner@upi', bankAccountNumber: null, ifscCode: null,
          partner: {
            panNumber: 'ABCDE1234F', isActive: true, deletedAt: null,
            kycSubmissions: [{ status: 'APPROVED' }],
          },
        },
      ]);

      await service.processBatch(gifsy, 'b1');

      // The disbursement $transaction receives an options 2nd arg with the raised timeout.
      const opts = mockPrisma.$transaction.mock.calls[0][1];
      expect(opts).toMatchObject({ timeout: 180000, maxWait: 20000 });
    });
  });

  describe('assignPendingTransactions', () => {
    it('throws NotFound when the batch is outside the tenant', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue(null);
      await expect(
        service.assignPendingTransactions(gifsy, 'b1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.payoutTransaction.updateMany).not.toHaveBeenCalled();
    });

    it('throws BadRequest when the batch is not DRAFT', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'SUBMITTED',
        payoutMode: 'UPI',
      });
      await expect(
        service.assignPendingTransactions(gifsy, 'b1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.payoutTransaction.updateMany).not.toHaveBeenCalled();
    });

    it('sweeps eligible unbatched PENDING txns into the DRAFT batch (tenant + mode scoped)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({
        id: 'b1',
        status: 'DRAFT',
        payoutMode: 'UPI',
      });
      mockPrisma.payoutTransaction.updateMany.mockResolvedValue({ count: 3 });

      const res = await service.assignPendingTransactions(gifsy, 'b1');

      const call = mockPrisma.payoutTransaction.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({
        batchId: null,
        status: 'PENDING',
        redemptionOrderId: { not: null },
        payoutMode: 'UPI',
        partner: { clientId: 'deoleo' },
      });
      expect(call.data).toEqual({ batchId: 'b1' });
      expect(res).toEqual({ batchId: 'b1', assigned: 3 });
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    });
  });

  describe('buildReconciliationFile', () => {
    it('produces an xlsx buffer with one row per transaction', async () => {
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          amountPaise: 100000,
          netAmountPaise: 90000,
          payoutMode: 'UPI',
          status: 'SUCCESS',
          createdAt: new Date('2026-06-01T00:00:00Z'),
          partner: { businessName: 'Acme', panNumber: 'ABCDE1234F' },
          tdsRecord: { tdsPaise: 10000, panNumber: 'ABCDE1234F' },
        },
      ]);

      const res = await service.buildReconciliationFile(gifsy, {});
      expect(res.recordCount).toBe(1);
      expect(Buffer.isBuffer(res.buffer)).toBe(true);
      expect(res.buffer.length).toBeGreaterThan(0);
      expect(res.filename).toMatch(/^reconciliation-\d+\.xlsx$/);
    });

    it('scopes the query to the tenant and honours the batch filter', async () => {
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([]);
      await service.buildReconciliationFile(gifsy, { batchId: 'b9' });
      const where = mockPrisma.payoutTransaction.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ batch: { clientId: 'deoleo' }, batchId: 'b9' });
    });
  });

  describe('buildPayoutUtrTemplate', () => {
    it('throws NotFound for a batch outside the tenant', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue(null);
      await expect(
        service.buildPayoutUtrTemplate(gifsy, 'b1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('builds a fillable xlsx keyed by Transaction ID with blank UTR/Status', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 'txn1',
          amountPaise: 250000,
          payoutMode: 'UPI',
          partner: { businessName: 'Acme', panNumber: 'ABCDE1234F' },
        },
      ]);
      const res = await service.buildPayoutUtrTemplate(gifsy, 'b1');
      expect(res.recordCount).toBe(1);
      expect(Buffer.isBuffer(res.buffer)).toBe(true);
      expect(res.buffer.length).toBeGreaterThan(0);
      expect(res.filename).toBe('payout-utr-PB-1.xlsx');
    });

    it("a no-PAN partner's transaction (allowPayoutWithoutPan ON) appears in the UTR template, PAN = N/A", async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-2' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 'txn-nopan', amountPaise: 150000, payoutMode: 'UPI', status: 'INITIATED',
          partner: { businessName: 'No Pan Traders', panNumber: null },
          beneficiaryName: 'Owner', bankAccountNumber: null, ifscCode: null, bankName: null, upiId: 'nopan@upi',
        },
      ]);
      const res = await service.buildPayoutUtrTemplate(gifsy, 'b1');
      expect(res.recordCount).toBe(1);
      const wb = XLSX.read(res.buffer, { type: 'buffer' });
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      expect(rows[0]['Transaction ID']).toBe('txn-nopan');
      expect(rows[0]['Partner Name']).toBe('No Pan Traders');
      expect(rows[0].PAN).toBe('N/A');
      expect(rows[0]['Amount (₹)']).toBe('1500.00');
      expect(rows[0]['UPI ID']).toBe('nopan@upi');
    });

    it('export carries ALL beneficiary columns from the PayoutTransaction snapshot (blank where missing)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          // Bank-rail beneficiary.
          id: 'txn-bank',
          amountPaise: 100000,
          payoutMode: 'BANK_TRANSFER',
          partner: { businessName: 'Acme', panNumber: 'ABCDE1234F' },
          beneficiaryName: 'Ravi Kumar',
          bankAccountNumber: '0011223344',
          ifscCode: 'HDFC0001234',
          bankName: 'HDFC Bank',
          upiId: null, // blank in the file
        },
        {
          // UPI-only beneficiary — bank columns blank.
          id: 'txn-upi',
          amountPaise: 50000,
          payoutMode: 'UPI',
          partner: { businessName: 'Beta', panNumber: 'ZZZZZ9999Z' },
          beneficiaryName: 'Sara',
          bankAccountNumber: null,
          ifscCode: null,
          bankName: null,
          upiId: 'sara@upi',
        },
      ]);

      const res = await service.buildPayoutUtrTemplate(gifsy, 'b1');

      // Re-parse the produced sheet to assert the columns + values round-trip.
      const wb = XLSX.read(res.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json<(string | number)[]>(ws, {
        header: 1,
        defval: '',
      }) as (string | number)[][];

      const headers = aoa[0].map(String);
      // New read-only beneficiary columns are present.
      for (const col of [
        'Beneficiary Name',
        'Bank Account Number',
        'IFSC',
        'Bank Name',
        'UPI ID',
      ]) {
        expect(headers).toContain(col);
      }
      // The existing round-trip key + fill columns are still present.
      for (const col of ['Transaction ID', 'UTR', 'Status']) {
        expect(headers).toContain(col);
      }

      const idIdx = headers.indexOf('Transaction ID');
      const benIdx = headers.indexOf('Beneficiary Name');
      const acctIdx = headers.indexOf('Bank Account Number');
      const ifscIdx = headers.indexOf('IFSC');
      const bankIdx = headers.indexOf('Bank Name');
      const upiIdx = headers.indexOf('UPI ID');

      const bankRow = aoa.find((r) => r[idIdx] === 'txn-bank')!;
      expect(bankRow[benIdx]).toBe('Ravi Kumar');
      expect(bankRow[acctIdx]).toBe('0011223344');
      expect(bankRow[ifscIdx]).toBe('HDFC0001234');
      expect(bankRow[bankIdx]).toBe('HDFC Bank');
      expect(bankRow[upiIdx]).toBe(''); // blank where missing

      const upiRow = aoa.find((r) => r[idIdx] === 'txn-upi')!;
      expect(upiRow[upiIdx]).toBe('sara@upi');
      expect(upiRow[acctIdx]).toBe(''); // bank columns blank for a UPI-only beneficiary
      expect(upiRow[ifscIdx]).toBe('');
    });
  });

  describe('uploadPayoutUtr', () => {
    // Build a real .xlsx the parser can read: header row 0, data from row 1, the
    // txn id under the "Transaction ID" column (parser reads by named-column index).
    function buildUpload(
      rows: { txnId: string; utr?: string; status: string }[],
    ): Express.Multer.File {
      const aoa: (string | number)[][] = [
        ['Transaction ID', 'Partner Name', 'PAN', 'Amount (₹)', 'Mode', 'UTR', 'Status'],
        ...rows.map((r) => [r.txnId, '', '', '', '', r.utr ?? '', r.status]),
      ];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'UTR Upload');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      return { buffer: buf } as Express.Multer.File;
    }

    beforeEach(() => {
      mockWallet.reverse.mockResolvedValue(undefined);
      mockTx.redemptionOrder.update.mockResolvedValue({});
      mockTx.redemptionOrder.updateMany.mockResolvedValue({ count: 1 });
      mockTx.payoutTransaction.update.mockResolvedValue({});
      // The terminal compare-and-set claim wins by default (no overlapping upload).
      mockTx.payoutTransaction.updateMany.mockResolvedValue({ count: 1 });
      // FAILED path still reads the order inside the tx to reverse points.
      mockTx.redemptionOrder.findFirst.mockResolvedValue({ pointsDeducted: 500, partnerId: 'p1', orderNumber: 'RO-1' });
      // Flow-B payout WhatsApp: POST-COMMIT batch-reads — partner owner (bare 10-digit
      // phone) keyed by id, and the redemption order (pointsDeducted) keyed by id.
      mockPrisma.channelPartner.findMany.mockResolvedValue([{ id: 'p1', ownerName: 'Ravi Traders', phone: '9900000041' }]);
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([{ id: 'o1', pointsDeducted: 500 }]);
      mockMsg91.sendWhatsappTemplate.mockResolvedValue(undefined);
    });

    it('throws NotFound for a batch outside the tenant', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue(null);
      await expect(
        service.uploadPayoutUtr(gifsy, 'b1', buildUpload([]), true),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('previews (does not mutate) when apply=false', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([
          { id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'UPI', partnerId: 'p1', redemptionOrderId: 'o1' },
        ]) // batch txns
        .mockResolvedValueOnce([]); // knownUtrs
      const res = await service.uploadPayoutUtr(
        gifsy,
        'b1',
        buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
        false,
      );
      expect((res as { parseResult: unknown }).parseResult).toBeDefined();
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('PAID → marks payout SUCCESS (UTR) and the order DELIVERED, no reversal', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([
          { id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'UPI', partnerId: 'p1', redemptionOrderId: 'o1' },
        ])
        .mockResolvedValueOnce([]);

      const res = await service.uploadPayoutUtr(
        gifsy,
        'b1',
        buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
        true,
      );

      expect(res).toMatchObject({ applied: true, paidCount: 1, failedCount: 0, reversedCount: 0, skipped: [] });
      // Compare-and-set on the exact non-terminal status read.
      expect(mockTx.payoutTransaction.updateMany).toHaveBeenCalledWith({
        where: { id: 'txn1', status: 'INITIATED' },
        data: expect.objectContaining({ status: 'SUCCESS', providerRefId: 'UTR12345678' }),
      });
      // Order completed; no reversal.
      expect(mockTx.redemptionOrder.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'DELIVERED' }),
        }),
      );
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    // ── PROCESS-FIRST guard + "Paid outside platform" (owner-approved 2026-11-12) ─────────────
    function buildOffPlatformUpload(
      rows: { txnId: string; utr?: string; status: string; off?: string; note?: string }[],
    ): Express.Multer.File {
      const aoa: (string | number)[][] = [
        ['Transaction ID', 'Partner Name', 'PAN', 'Amount (₹)', 'Mode', 'UTR', 'Status', 'Paid outside platform (Y/N)', 'Off-platform note'],
        ...rows.map((r) => [r.txnId, '', '', '', '', r.utr ?? '', r.status, r.off ?? '', r.note ?? '']),
      ];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'UTR Upload');
      return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File;
    }
    const pendingTxn = (over: Record<string, unknown> = {}) => ({
      id: 'txnP', status: 'PENDING', amountPaise: 150000n, providerRefId: null, payoutMode: 'UPI',
      partnerId: 'p1', redemptionOrderId: 'o1', ...over,
    });

    it('GUARD: PAID on a PENDING (unprocessed) tx without the off-platform flag → preview row error, apply refused, nothing written', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValueOnce([pendingTxn()]).mockResolvedValueOnce([]);
      const preview = (await service.uploadPayoutUtr(
        gifsy, 'b1', buildOffPlatformUpload([{ txnId: 'txnP', utr: 'UTR12345678', status: 'PAID' }]), false,
      )) as { parseResult: { canProceed: boolean; rows: Array<{ status: string; errors: string[] }> } };
      expect(preview.parseResult.canProceed).toBe(false);
      expect(preview.parseResult.rows[0].status).toBe('ERROR');
      expect(preview.parseResult.rows[0].errors).toContain(
        "This payment wasn't processed in a batch — process the batch first, or mark it 'Paid outside platform' if it was paid outside Gifsy.",
      );

      mockPrisma.payoutTransaction.findMany.mockResolvedValueOnce([pendingTxn()]).mockResolvedValueOnce([]);
      await expect(
        service.uploadPayoutUtr(gifsy, 'b1', buildOffPlatformUpload([{ txnId: 'txnP', utr: 'UTR12345678', status: 'PAID', off: 'N' }]), true),
      ).rejects.toThrow(/Row 2: This payment wasn't processed in a batch/);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockTx.payoutTransaction.updateMany).not.toHaveBeenCalled();
    });

    it('GUARD: legacy template (no off-platform columns) — PAID on a PENDING tx is refused the same way', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValueOnce([pendingTxn()]).mockResolvedValueOnce([]);
      await expect(
        service.uploadPayoutUtr(gifsy, 'b1', buildUpload([{ txnId: 'txnP', utr: 'UTR12345678', status: 'PAID' }]), true),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('OFF-PLATFORM: PAID + "Y" on a PENDING tx → SUCCESS flagged paidOffPlatform (+note), AuditLog row, order DELIVERED', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValueOnce([pendingTxn()]).mockResolvedValueOnce([]);

      const res = await service.uploadPayoutUtr(
        gifsy, 'b1',
        buildOffPlatformUpload([{ txnId: 'txnP', utr: 'NEFT98765432', status: 'PAID', off: 'Y', note: 'Paid by cheque at depot' }]),
        true,
      );

      expect(res).toMatchObject({ applied: true, paidCount: 1, offPlatformCount: 1, skipped: [] });
      const claim = mockTx.payoutTransaction.updateMany.mock.calls[0][0];
      expect(claim.where).toEqual({ id: 'txnP', status: 'PENDING' });
      expect(claim.data).toMatchObject({
        status: 'SUCCESS',
        providerRefId: 'NEFT98765432',
        providerResponse: {
          paidOffPlatform: true, note: 'Paid by cheque at depot', recordedById: 'admin1', previousStatus: 'PENDING',
        },
      });
      expect(mockTx.auditLog.create).toHaveBeenCalledWith({
        data: {
          actorId: 'admin1',
          action: 'UPDATE',
          entityType: 'PayoutTransaction',
          entityId: 'txnP',
          oldValues: { status: 'PENDING' },
          newValues: { status: 'SUCCESS', paidOffPlatform: true, providerRefId: 'NEFT98765432', note: 'Paid by cheque at depot' },
          metadata: {
            batchId: 'b1', batchCode: 'PB-1', source: 'PAYOUT_UTR_UPLOAD', paidOffPlatform: true,
            // Gates bypassed by design are recorded (partner p1 here: no PAN, no KYC submission).
            bypassedGates: ['noPan', 'kycNotApproved:NO_SUBMISSION', 'notProcessed', 'missingBeneficiaryFields'],
          },
        },
      });
      // Same downstream as a normal PAID: the linked redemption completes (→ 194R), no reversal.
      expect(mockTx.redemptionOrder.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'DELIVERED' }) }),
      );
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('OFF-PLATFORM: "Y" still needs a valid UTR/reference and a positive amount', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([pendingTxn(), pendingTxn({ id: 'txnZero', amountPaise: 0n })])
        .mockResolvedValueOnce([]);
      const preview = (await service.uploadPayoutUtr(
        gifsy, 'b1',
        buildOffPlatformUpload([
          { txnId: 'txnP', status: 'PAID', off: 'Y' },
          { txnId: 'txnZero', utr: 'UTR55554444', status: 'PAID', off: 'Y' },
        ]),
        false,
      )) as { parseResult: { canProceed: boolean; rows: Array<{ errors: string[] }> } };
      expect(preview.parseResult.canProceed).toBe(false);
      expect(preview.parseResult.rows[0].errors).toContain('UTR is required for a PAID transaction.');
      expect(preview.parseResult.rows[1].errors).toContain(
        'Cannot record an off-platform payment for a transaction with no valid amount.',
      );
    });

    it('PROCESSED: PAID on an INITIATED tx with blank flag applies exactly as before (no flag, no audit row)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([pendingTxn({ id: 'txnI', status: 'INITIATED' })])
        .mockResolvedValueOnce([]);
      const res = await service.uploadPayoutUtr(
        gifsy, 'b1', buildOffPlatformUpload([{ txnId: 'txnI', utr: 'UTR12345678', status: 'PAID' }]), true,
      );
      expect(res).toMatchObject({ applied: true, paidCount: 1, offPlatformCount: 0 });
      const claim = mockTx.payoutTransaction.updateMany.mock.calls[0][0];
      expect(claim.data).not.toHaveProperty('providerResponse');
      expect(mockTx.auditLog.create).not.toHaveBeenCalled();
    });

    it('FAILED on a PENDING tx is unaffected by the guard (still refunds once)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValueOnce([pendingTxn()]).mockResolvedValueOnce([]);
      const res = await service.uploadPayoutUtr(
        gifsy, 'b1', buildOffPlatformUpload([{ txnId: 'txnP', status: 'FAILED' }]), true,
      );
      expect(res).toMatchObject({ applied: true, failedCount: 1, paidCount: 0 });
      expect(mockTx.payoutTransaction.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'FAILED' });
    });

    // ── Off-platform hardening (audit of a020e8d7) ──────────────────────────────────
    function buildOff2(
      rows: { txnId: string; utr?: string; status: string; off?: string; amt?: string | number }[],
    ): Express.Multer.File {
      const aoa: (string | number)[][] = [
        ['Transaction ID', 'UTR', 'Status', 'Paid outside platform (Y/N)', 'Off-platform note', 'Amount paid (₹)'],
        ...rows.map((r) => [r.txnId, r.utr ?? '', r.status, r.off ?? '', '', r.amt ?? '']),
      ];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'UTR Upload');
      return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File;
    }
    type Preview = { parseResult: { canProceed: boolean; rows: Array<{ txnId: string; status: string; errors: string[] }> } };
    async function preview(
      txns: Array<Record<string, unknown>>,
      history: Array<{ providerRefId: string; partnerId: string; providerResponse?: unknown }>,
      rows: Parameters<typeof buildOff2>[0],
      orders: Array<Record<string, unknown>> = [],
    ): Promise<Preview['parseResult']> {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValueOnce(txns).mockResolvedValueOnce(history);
      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce(orders);
      const res = (await service.uploadPayoutUtr(gifsy, 'b1', buildOff2(rows), false)) as Preview;
      return res.parseResult;
    }
    const errorsOf = (r: Preview['parseResult'], id: string) => r.rows.find((x) => x.txnId === id)!.errors;

    it('OFF-1: a "Y" row accepts a free-form reference (cheque no. / CASH 12-Nov / NEFT/HDFC/123); a non-Y row keeps the strict UTR rule', async () => {
      const r = await preview(
        [pendingTxn({ id: 'a' }), pendingTxn({ id: 'b', partnerId: 'p2' }), pendingTxn({ id: 'c', partnerId: 'p3' }),
          pendingTxn({ id: 'd', status: 'INITIATED', partnerId: 'p4' })],
        [],
        [
          { txnId: 'a', utr: '004521', status: 'PAID', off: 'Y' },
          { txnId: 'b', utr: 'CASH 12-Nov', status: 'PAID', off: 'Y' },
          { txnId: 'c', utr: 'NEFT/HDFC/123', status: 'PAID', off: 'Y' },
          { txnId: 'd', utr: 'CASH 12-Nov2', status: 'PAID' },
        ],
      );
      expect(errorsOf(r, 'a')).toEqual([]);
      expect(errorsOf(r, 'b')).toEqual([]);
      expect(errorsOf(r, 'c')).toEqual([]);
      expect(errorsOf(r, 'd').join(' ')).toMatch(/not valid \(must be 8–22 alphanumeric/);
    });

    it('OFF-1: a "Y" reference over 60 chars or with other symbols is rejected', async () => {
      const r = await preview(
        [pendingTxn({ id: 'a' }), pendingTxn({ id: 'b', partnerId: 'p2' })],
        [],
        [
          { txnId: 'a', utr: 'X'.repeat(61), status: 'PAID', off: 'Y' },
          { txnId: 'b', utr: 'CASH<script>', status: 'PAID', off: 'Y' },
        ],
      );
      expect(errorsOf(r, 'a').join(' ')).toMatch(/1–60 characters/);
      expect(errorsOf(r, 'b').join(' ')).toMatch(/1–60 characters/);
    });

    it('OFF-2: same reference allowed for the SAME partner (history + this upload), rejected across partners', async () => {
      const r = await preview(
        [pendingTxn({ id: 'a', partnerId: 'p1' }), pendingTxn({ id: 'b', partnerId: 'p1' }), pendingTxn({ id: 'c', partnerId: 'p2' })],
        [{ providerRefId: 'CHQ 777', partnerId: 'p1', providerResponse: { paidOffPlatform: true } }],
        [
          { txnId: 'a', utr: 'chq 777', status: 'PAID', off: 'Y' },
          { txnId: 'b', utr: 'CHQ 777', status: 'PAID', off: 'Y' },
          { txnId: 'c', utr: 'CHQ 777', status: 'PAID', off: 'Y' },
        ],
      );
      expect(errorsOf(r, 'c').join(' ')).toMatch(/already been used for a different partner/);
      // a + b share p1 but c (p2) uses the same reference in this upload → a/b flagged too.
      expect(errorsOf(r, 'a').join(' ')).toMatch(/more than once in this upload for a different partner/);

      const ok = await preview(
        [pendingTxn({ id: 'a', partnerId: 'p1' }), pendingTxn({ id: 'b', partnerId: 'p1' })],
        [{ providerRefId: 'CHQ 777', partnerId: 'p1', providerResponse: { paidOffPlatform: true } }],
        [
          { txnId: 'a', utr: 'CHQ 777', status: 'PAID', off: 'Y' },
          { txnId: 'b', utr: 'chq-777', status: 'PAID', off: 'Y' }, // normalised → same reference
        ],
      );
      expect(ok.canProceed).toBe(true);
    });

    it('OFF-3: "Amount paid (₹)" must equal the payout amount on a Y row; blank = full amount; non-Y rows ignore it', async () => {
      const r = await preview(
        [pendingTxn({ id: 'a', partnerId: 'p1' }), pendingTxn({ id: 'b', partnerId: 'p2' }), pendingTxn({ id: 'c', partnerId: 'p3' }),
          pendingTxn({ id: 'd', status: 'INITIATED', partnerId: 'p4' })],
        [],
        [
          { txnId: 'a', utr: 'REF-A', status: 'PAID', off: 'Y', amt: 1500 },        // = ₹1,500.00
          { txnId: 'b', utr: 'REF-B', status: 'PAID', off: 'Y', amt: '1,499.99' },
          { txnId: 'c', utr: 'REF-C', status: 'PAID', off: 'Y' },                   // blank → full
          { txnId: 'd', utr: 'UTR12345678', status: 'PAID', amt: 1 },               // non-Y → ignored
        ],
      );
      expect(errorsOf(r, 'a')).toEqual([]);
      expect(errorsOf(r, 'b')).toEqual(["Amount paid doesn't match the payout amount"]);
      expect(errorsOf(r, 'c')).toEqual([]);
      expect(errorsOf(r, 'd')).toEqual([]);
    });

    it('OFF-4: an off-platform PAID never verify-stamps the partner\'s captured bank/UPI', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([pendingTxn({ upiId: 'p1@upi' })])
        .mockResolvedValueOnce([]);
      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce([{ id: 'o1', status: 'CONFIRMED', pointsDeducted: 500 }]);
      await service.uploadPayoutUtr(gifsy, 'b1', buildOff2([{ txnId: 'txnP', utr: 'CASH 1', status: 'PAID', off: 'Y' }]), true);
      expect(mockTx.payoutTransaction.updateMany).toHaveBeenCalled();
      expect(mockTx.channelPartner.updateMany).not.toHaveBeenCalled();
      expect(mockTx.channelPartner.findFirst).not.toHaveBeenCalled();
    });

    it('OFF-5: a Y row is rejected when the linked redemption was cancelled/returned/failed or refunded', async () => {
      const r = await preview(
        [pendingTxn({ id: 'a', redemptionOrderId: 'oC' }), pendingTxn({ id: 'b', partnerId: 'p2', redemptionOrderId: 'oR' }),
          pendingTxn({ id: 'c', partnerId: 'p3', redemptionOrderId: 'oOk' })],
        [],
        [
          { txnId: 'a', utr: 'REF-A', status: 'PAID', off: 'Y' },
          { txnId: 'b', utr: 'REF-B', status: 'PAID', off: 'Y' },
          { txnId: 'c', utr: 'REF-C', status: 'PAID', off: 'Y' },
        ],
        [
          { id: 'oC', status: 'CANCELLED', pointsDeducted: 500 },
          { id: 'oR', status: 'CONFIRMED', pointsDeducted: 0 }, // points refunded (M2 claim)
          { id: 'oOk', status: 'CONFIRMED', pointsDeducted: 500 },
        ],
      );
      const msg = "This redemption was cancelled and its points refunded — it can't be marked paid";
      expect(errorsOf(r, 'a')).toEqual([msg]);
      expect(errorsOf(r, 'b')).toEqual([msg]);
      expect(errorsOf(r, 'c')).toEqual([]);
    });

    it('OFF-5: a refund landing between preview and apply is caught inside the tx (row skipped, nothing written)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValueOnce([pendingTxn()]).mockResolvedValueOnce([]);
      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce([{ id: 'o1', status: 'CONFIRMED', pointsDeducted: 500 }]);
      mockTx.redemptionOrder.findFirst.mockResolvedValueOnce({ status: 'CANCELLED', pointsDeducted: 0 });
      const res = await service.uploadPayoutUtr(gifsy, 'b1', buildOff2([{ txnId: 'txnP', utr: 'CASH 1', status: 'PAID', off: 'Y' }]), true);
      expect(res).toMatchObject({ paidCount: 0, offPlatformCount: 0 });
      expect((res as { skipped: Array<{ reason: string }> }).skipped[0].reason).toMatch(/can't be marked paid/);
      expect(mockTx.payoutTransaction.updateMany).not.toHaveBeenCalled();
      expect(mockTx.auditLog.create).not.toHaveBeenCalled();
    });

    it('OFF-6: the audit row records every gate the off-platform payment bypassed', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValueOnce([pendingTxn()]).mockResolvedValueOnce([]);
      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce([]);
      mockPrisma.channelPartner.findMany.mockResolvedValueOnce([
        { id: 'p1', panNumber: null, isActive: false, deletedAt: new Date(), kycSubmissions: [
          { id: 'k1', status: 'REJECTED', createdAt: new Date(), updatedAt: new Date() },
        ] },
      ]);
      await service.uploadPayoutUtr(gifsy, 'b1', buildOff2([{ txnId: 'txnP', utr: 'CASH 1', status: 'PAID', off: 'Y' }]), true);
      const meta = mockTx.auditLog.create.mock.calls[0][0].data.metadata;
      expect(meta.bypassedGates).toEqual([
        'noPan', 'kycNotApproved:REJECTED', 'partnerInactive', 'partnerDeleted', 'notProcessed', 'missingBeneficiaryFields',
      ]);
      // a clean partner records an empty list
      jest.clearAllMocks();
      mockTx.payoutTransaction.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValueOnce([pendingTxn({ upiId: 'p1@upi' })]).mockResolvedValueOnce([]);
      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce([]);
      mockPrisma.channelPartner.findMany.mockResolvedValueOnce([
        { id: 'p1', panNumber: 'ABCDE1234F', isActive: true, deletedAt: null, kycSubmissions: [
          { id: 'k1', status: 'APPROVED', createdAt: new Date(), updatedAt: new Date() },
        ] },
      ]);
      await service.uploadPayoutUtr(gifsy, 'b1', buildOff2([{ txnId: 'txnP', utr: 'CASH 2', status: 'PAID', off: 'Y' }]), true);
      // clean partner + UPI present → only the inherent "notProcessed" (a Y row is by definition unprocessed)
      expect(mockTx.auditLog.create.mock.calls[0][0].data.metadata.bypassedGates).toEqual(['notProcessed']);
    });

    // ── Round-3 audit ──────────────────────────────────────────────────────────────
    it('R3-5: "Y" on a tx already sent to the bank (INITIATED) is rejected, naming the batch', async () => {
      const r = await preview(
        [pendingTxn({ id: 'a', status: 'INITIATED' }), pendingTxn({ id: 'b', status: 'PROCESSING', partnerId: 'p2' })],
        [],
        [
          { txnId: 'a', utr: 'CASH 1', status: 'PAID', off: 'Y' },
          { txnId: 'b', utr: 'CASH 2', status: 'PAID', off: 'Y' },
        ],
      );
      const msg = "This payment was already sent to the bank in batch PB-1 and its outcome isn't recorded yet. Record the bank result first: if the bank payment failed or was returned, upload it as FAILED. After that it can be marked 'Paid outside platform' = Y — unless its points were refunded when it failed.";
      expect(errorsOf(r, 'a')).toEqual([msg]);
      expect(errorsOf(r, 'b')).toEqual([msg]);
    });

    // ── Final audit of cc4d11be ────────────────────────────────────────────────────
    const REFUNDED_MSG = "Points for this redemption were already refunded — it can't also be marked paid";

    it('FA-1: "Y" on a FAILED/REVERSED tx — refunded order → explicit per-row error; unrefunded / no order → OK', async () => {
      const r = await preview(
        [
          pendingTxn({ id: 'fRef', status: 'FAILED', redemptionOrderId: 'oF' }),                    // order FAILED → refunded
          pendingTxn({ id: 'rRef', status: 'REVERSED', partnerId: 'p2', redemptionOrderId: 'oZ' }), // points 0 → refunded
          pendingTxn({ id: 'fVch', status: 'FAILED', partnerId: 'p3', redemptionOrderId: 'oV' }),   // voucher-blocked, unrefunded
          pendingTxn({ id: 'fNone', status: 'FAILED', partnerId: 'p4', redemptionOrderId: null }),  // no linked order
        ],
        [],
        [
          { txnId: 'fRef', utr: 'CASH A', status: 'PAID', off: 'Y' },
          { txnId: 'rRef', utr: 'CASH B', status: 'PAID', off: 'Y' },
          { txnId: 'fVch', utr: 'CASH C', status: 'PAID', off: 'Y' },
          { txnId: 'fNone', utr: 'CASH D', status: 'PAID', off: 'Y' },
        ],
        [
          { id: 'oF', status: 'FAILED', pointsDeducted: 500 },
          { id: 'oZ', status: 'CONFIRMED', pointsDeducted: 0 },
          { id: 'oV', status: 'PROCESSING', pointsDeducted: 500 },
        ],
      );
      expect(errorsOf(r, 'fRef')).toEqual([REFUNDED_MSG]);
      expect(errorsOf(r, 'rRef')).toEqual([REFUNDED_MSG]);
      expect(errorsOf(r, 'fVch')).toEqual([]);
      expect(errorsOf(r, 'fNone')).toEqual([]);
      expect(r.rows.find((x) => x.txnId === 'fVch')!.status).toBe('OK');
    });

    it('FA-1: "Y" on a FAILED tx (unrefunded) APPLIES → SUCCESS with audit bypassedGates incl. previouslyFailed (never silently dropped)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([pendingTxn({ status: 'FAILED', upiId: 'p1@upi' })])
        .mockResolvedValueOnce([]);
      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce([{ id: 'o1', status: 'PROCESSING', pointsDeducted: 500 }]);
      mockTx.redemptionOrder.findFirst.mockResolvedValueOnce({ status: 'PROCESSING', pointsDeducted: 500 });
      const res = await service.uploadPayoutUtr(gifsy, 'b1', buildOff2([{ txnId: 'txnP', utr: 'CASH 9', status: 'PAID', off: 'Y' }]), true);
      expect(res).toMatchObject({ applied: true, paidCount: 1, offPlatformCount: 1, skipped: [] });
      const claim = mockTx.payoutTransaction.updateMany.mock.calls[0][0];
      expect(claim.where).toEqual({ id: 'txnP', status: 'FAILED' });
      expect(claim.data).toMatchObject({ status: 'SUCCESS', providerResponse: { paidOffPlatform: true, previousStatus: 'FAILED' } });
      const meta = mockTx.auditLog.create.mock.calls[0][0].data.metadata;
      expect(meta.bypassedGates).toContain('previouslyFailed');
      expect(meta.bypassedGates).not.toContain('notProcessed');
    });

    it('FA-1: a refund landing between preview and apply on a FAILED tx is reported in skipped with the refunded message', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValueOnce([pendingTxn({ status: 'FAILED' })]).mockResolvedValueOnce([]);
      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce([{ id: 'o1', status: 'PROCESSING', pointsDeducted: 500 }]);
      mockTx.redemptionOrder.findFirst.mockResolvedValueOnce({ status: 'FAILED', pointsDeducted: 0 });
      const res = await service.uploadPayoutUtr(gifsy, 'b1', buildOff2([{ txnId: 'txnP', utr: 'CASH 9', status: 'PAID', off: 'Y' }]), true);
      expect((res as { skipped: Array<{ reason: string }> }).skipped).toEqual([
        expect.objectContaining({ rowNum: 2, reason: REFUNDED_MSG }),
      ]);
      expect(mockTx.payoutTransaction.updateMany).not.toHaveBeenCalled();
    });

    it('FA-1: on a FAILED tx a bank UTR (no Y) is an explicit error and a FAILED row is a visible notice', async () => {
      const r = (await preview(
        [pendingTxn({ id: 'a', status: 'FAILED' }), pendingTxn({ id: 'b', status: 'REVERSED', partnerId: 'p2' })],
        [],
        [
          { txnId: 'a', utr: 'UTR12345678', status: 'PAID' },
          { txnId: 'b', status: 'FAILED' },
        ],
      )) as unknown as Preview['parseResult'] & {
        alreadyPaid: Array<{ txnId: string; notice: string }>;
        noChange: Array<{ rowNum: number; txnId: string; notice: string }>;
      };
      expect(errorsOf(r, 'a').join(' ')).toMatch(/already recorded as failed — a bank UTR can't be applied/);
      expect(r.rows.find((x) => x.txnId === 'b')!.status).toBe('SKIP');
      // Informational no-op → its own `noChange` category, never the double-payment `alreadyPaid` list.
      expect(r.noChange).toEqual([{ rowNum: 3, txnId: 'b', notice: 'Already recorded as reversed — no change' }]);
      expect(r.alreadyPaid).toEqual([]);
    });

    it('FA-1b: apply — a FAILED row on an already-FAILED tx is returned in noChange (not alreadyPaid), nothing written', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([pendingTxn({ id: 'f1', status: 'FAILED' })])
        .mockResolvedValueOnce([]);
      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce([]);
      const res = (await service.uploadPayoutUtr(gifsy, 'b1', buildOff2([{ txnId: 'f1', status: 'FAILED' }]), true)) as {
        alreadyPaid: unknown[]; noChange: Array<{ rowNum: number; txnId: string; notice: string }>;
      };
      expect(res.noChange).toEqual([{ rowNum: 2, txnId: 'f1', notice: 'Already recorded as failed — no change' }]);
      expect(res.alreadyPaid).toEqual([]);
      expect(mockTx.payoutTransaction.updateMany).not.toHaveBeenCalled();
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('FA-5: a bank UTR collides only with GENUINE bank UTRs, not with a normalised off-platform reference', async () => {
      const r = await preview(
        [pendingTxn({ id: 'a', status: 'INITIATED' }), pendingTxn({ id: 'b', status: 'INITIATED', partnerId: 'p2' })],
        [
          { providerRefId: 'CHQ-123456', partnerId: 'p9', providerResponse: { paidOffPlatform: true } }, // off-platform ref
          { providerRefId: 'UTR99990000', partnerId: 'p8' },                                            // genuine bank UTR
        ],
        [
          { txnId: 'a', utr: 'CHQ123456', status: 'PAID' },
          { txnId: 'b', utr: 'utr99990000', status: 'PAID' },
        ],
      );
      expect(errorsOf(r, 'a')).toEqual([]);
      expect(errorsOf(r, 'b')).toEqual(['UTR "utr99990000" has already been used.']);
    });

    it('R3-6: a row for an already-SUCCESS tx is a visible notice (preview + apply result), never applied', async () => {
      const paidAt = new Date(Date.now() - 3 * 86_400_000);
      const success = pendingTxn({ id: 's1', status: 'SUCCESS', completedAt: paidAt, providerResponse: { paidOffPlatform: true } });
      const r = (await preview([success], [], [{ txnId: 's1', utr: 'UTR99998888', status: 'PAID' }])) as unknown as {
        canProceed: boolean; alreadyPaid: Array<{ notice: string }>; rows: Array<{ status: string }>;
      };
      expect(r.rows[0].status).toBe('SKIP');
      expect(r.alreadyPaid[0].notice).toMatch(/^Already marked paid on \d{4}-\d{2}-\d{2} \(off-platform\) — check for a double payment$/);
      expect(r.canProceed).toBe(true); // a no-op re-upload stays applicable (idempotent)

      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([pendingTxn({ id: 's1', status: 'SUCCESS', completedAt: paidAt, providerResponse: null })])
        .mockResolvedValueOnce([]);
      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce([]);
      const res = (await service.uploadPayoutUtr(gifsy, 'b1', buildOff2([{ txnId: 's1', status: 'FAILED' }]), true)) as {
        alreadyPaid: Array<{ notice: string }>;
      };
      expect(res.alreadyPaid[0].notice).toMatch(/\(bank\) — check for a double payment$/);
      expect(mockTx.payoutTransaction.updateMany).not.toHaveBeenCalled();
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('R3-7: references are compared normalised; a Y row may not reuse a genuine bank UTR (any partner)', async () => {
      const r = await preview(
        [pendingTxn({ id: 'a', partnerId: 'p1' }), pendingTxn({ id: 'b', status: 'INITIATED', partnerId: 'p2' })],
        [{ providerRefId: 'UTR12345678', partnerId: 'p1', providerResponse: null }],
        [
          { txnId: 'a', utr: 'utr-1234 5678', status: 'PAID', off: 'Y' }, // same partner, but it was a bank UTR
          { txnId: 'b', utr: 'utr12345678', status: 'PAID' },              // non-Y duplicate (case-insensitive)
        ],
      );
      expect(errorsOf(r, 'a').join(' ')).toMatch(/already used as a bank UTR/);
      expect(errorsOf(r, 'b').join(' ')).toMatch(/has already been used/);
    });

    it('R3-8: "Amount paid (₹)" accepts ₹ / Rs / Rs. / INR prefixes and commas; unknown headers are listed as ignored', async () => {
      const txns = ['a', 'b', 'c', 'd'].map((id, i) => pendingTxn({ id, partnerId: `p${i}` }));
      const r = await preview(txns, [], [
        { txnId: 'a', utr: 'R-A', status: 'PAID', off: 'Y', amt: 'Rs 1,500' },
        { txnId: 'b', utr: 'R-B', status: 'PAID', off: 'Y', amt: 'Rs. 1500.00' },
        { txnId: 'c', utr: 'R-C', status: 'PAID', off: 'Y', amt: 'INR 1,500' },
        { txnId: 'd', utr: 'R-D', status: 'PAID', off: 'Y', amt: '₹1,500' },
      ]);
      for (const id of ['a', 'b', 'c', 'd']) expect(errorsOf(r, id)).toEqual([]);

      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValueOnce([pendingTxn()]).mockResolvedValueOnce([]);
      mockPrisma.redemptionOrder.findMany.mockResolvedValueOnce([]);
      const ws = XLSX.utils.aoa_to_sheet([
        ['Transaction ID', 'UTR', 'Status', 'Paid outside platfrom (Y/N)'], // typo'd header
        ['txnP', 'UTR12345678', 'FAILED', 'Y'],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'UTR Upload');
      const res = (await service.uploadPayoutUtr(
        gifsy, 'b1', { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer } as Express.Multer.File, false,
      )) as { parseResult: { warnings: string[] } };
      expect(res.parseResult.warnings).toEqual(['Ignored columns (not recognised): "Paid outside platfrom (Y/N)"']);
    });

    it('template carries the three optional off-platform columns, blank', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        { id: 't1', amountPaise: 100000, payoutMode: 'UPI', partner: { businessName: 'A', panNumber: null } },
      ]);
      const res = await service.buildPayoutUtrTemplate(gifsy, 'b1');
      const wb = XLSX.read(res.buffer, { type: 'buffer' });
      const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      expect(aoa[0].slice(-5)).toEqual(['UTR', 'Status', 'Paid outside platform (Y/N)', 'Off-platform note', 'Amount paid (₹)']);
      expect(aoa[1].slice(-3)).toEqual(['', '', '']);
    });

    // capture-bank-at-redemption: a PAID payout verifies the partner ONLY when the current rail still
    // equals the paid snapshot, promoting UNVERIFIED *or* NEEDS_RECAPTURE (audit fixes money-F2/F3 + id-F1).
    it('PAID → verify-stamps the partner on a matching paid rail (in[UNVERIFIED,NEEDS_RECAPTURE] + snapshot match)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([
          {
            id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'UPI',
            partnerId: 'p1', redemptionOrderId: 'o1',
            upiId: 'shop@upi', bankAccountNumber: null, ifscCode: null,
          },
        ])
        .mockResolvedValueOnce([]);
      mockTx.channelPartner.findFirst.mockResolvedValue({ upiId: 'shop@upi' });

      await service.uploadPayoutUtr(
        gifsy,
        'b1',
        buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
        true,
      );

      expect(mockTx.channelPartner.findFirst).toHaveBeenCalledWith({
        where: { id: 'p1', paymentDetailsStatus: { in: ['UNVERIFIED', 'NEEDS_RECAPTURE'] } },
        select: { upiId: true },
      });
      expect(mockTx.channelPartner.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'p1',
            paymentDetailsStatus: { in: ['UNVERIFIED', 'NEEDS_RECAPTURE'] },
            upiId: 'shop@upi', // snapshot match on the paid rail
          }),
          data: expect.objectContaining({ paymentDetailsStatus: 'VERIFIED' }),
        }),
      );
    });

    it('PAID → UPI snapshot match is CASE-INSENSITIVE (snapshot Shop@OKAXIS vs partner shop@okaxis → VERIFIED)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([
          {
            id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'UPI',
            partnerId: 'p1', redemptionOrderId: 'o1',
            upiId: 'Shop@OKAXIS', bankAccountNumber: null, ifscCode: null,
          },
        ])
        .mockResolvedValueOnce([]);
      mockTx.channelPartner.findFirst.mockResolvedValue({ upiId: 'shop@okaxis' });

      await service.uploadPayoutUtr(
        gifsy,
        'b1',
        buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
        true,
      );

      // CAS-guarded on the partner's EXACT stored value (not the mixed-case snapshot).
      expect(mockTx.channelPartner.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'p1',
          paymentDetailsStatus: { in: ['UNVERIFIED', 'NEEDS_RECAPTURE'] },
          upiId: 'shop@okaxis',
        },
        data: expect.objectContaining({ paymentDetailsStatus: 'VERIFIED' }),
      });
    });

    it('PAID → a DIFFERENT current UPI (re-captured, never paid) is NOT verified', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([
          {
            id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'UPI',
            partnerId: 'p1', redemptionOrderId: 'o1',
            upiId: 'shop@okaxis', bankAccountNumber: null, ifscCode: null,
          },
        ])
        .mockResolvedValueOnce([]);
      mockTx.channelPartner.findFirst.mockResolvedValue({ upiId: 'other@okaxis' });

      await service.uploadPayoutUtr(
        gifsy,
        'b1',
        buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
        true,
      );

      expect(mockTx.channelPartner.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ paymentDetailsStatus: 'VERIFIED' }),
        }),
      );
    });

    it('PAID → a snapshot with NO UPI and NO bank details never verifies (null must not match null)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([
          {
            id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'BANK_TRANSFER',
            partnerId: 'p1', redemptionOrderId: 'o1',
            upiId: null, bankAccountNumber: null, ifscCode: null,
          },
        ])
        .mockResolvedValueOnce([]);

      await service.uploadPayoutUtr(
        gifsy,
        'b1',
        buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
        true,
      );

      expect(mockTx.channelPartner.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ paymentDetailsStatus: 'VERIFIED' }),
        }),
      );
    });

    // R2 — FAILED demotes UNVERIFIED → NEEDS_RECAPTURE only when the FAILED txn's rail (its frozen
    // snapshot) is still the partner's CURRENT rail — mirroring the PAID snapshot match.
    const primeFailed = (snap: { upiId: string | null; bankAccountNumber: string | null; ifscCode: string | null }) => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([
          {
            id: 'txn1', status: 'INITIATED', providerRefId: null,
            payoutMode: snap.upiId ? 'UPI' : 'BANK_TRANSFER',
            partnerId: 'p1', redemptionOrderId: 'o1', ...snap,
          },
        ])
        .mockResolvedValueOnce([]);
      mockTx.redemptionOrder.findFirst.mockResolvedValue({
        pointsDeducted: 0, partnerId: 'p1', orderNumber: 'o1',
      });
    };
    const runFailed = () =>
      service.uploadPayoutUtr(gifsy, 'b1', buildUpload([{ txnId: 'txn1', status: 'FAILED' }]), true);
    const demotions = () =>
      mockTx.channelPartner.updateMany.mock.calls.filter(
        (c: [{ data?: { paymentDetailsStatus?: string } }]) => c[0]?.data?.paymentDetailsStatus === 'NEEDS_RECAPTURE',
      );

    it('FAILED (UPI) → NEEDS_RECAPTURE when the snapshot UPI is the CURRENT UPI (case-insensitive, CAS on stored)', async () => {
      primeFailed({ upiId: 'Shop@UPI', bankAccountNumber: null, ifscCode: null });
      mockTx.channelPartner.findFirst.mockResolvedValue({ upiId: 'shop@upi' });
      await runFailed();
      expect(mockTx.channelPartner.findFirst).toHaveBeenCalledWith({
        where: { id: 'p1', paymentDetailsStatus: 'UNVERIFIED' },
        select: { upiId: true },
      });
      expect(mockTx.channelPartner.updateMany).toHaveBeenCalledWith({
        where: { id: 'p1', paymentDetailsStatus: 'UNVERIFIED', upiId: 'shop@upi' },
        data: { paymentDetailsStatus: 'NEEDS_RECAPTURE' },
      });
    });

    it('FAILED (UPI) on an OLD snapshot (partner re-captured a different UPI) → NO demotion', async () => {
      primeFailed({ upiId: 'old@upi', bankAccountNumber: null, ifscCode: null });
      mockTx.channelPartner.findFirst.mockResolvedValue({ upiId: 'new@upi' });
      await runFailed();
      expect(demotions()).toHaveLength(0);
    });

    it('FAILED (UPI) when the partner is not UNVERIFIED (e.g. VERIFIED / now bank) → NO demotion', async () => {
      primeFailed({ upiId: 'shop@upi', bankAccountNumber: null, ifscCode: null });
      mockTx.channelPartner.findFirst.mockResolvedValue(null); // status filter excludes it
      await runFailed();
      expect(demotions()).toHaveLength(0);
    });

    it('FAILED (bank) → NEEDS_RECAPTURE guarded on the snapshot account + IFSC being the CURRENT bank rail', async () => {
      primeFailed({ upiId: null, bankAccountNumber: '50100', ifscCode: 'HDFC0001' });
      await runFailed();
      expect(mockTx.channelPartner.updateMany).toHaveBeenCalledWith({
        where: { id: 'p1', paymentDetailsStatus: 'UNVERIFIED', bankAccountNumber: '50100', ifscCode: 'HDFC0001' },
        data: { paymentDetailsStatus: 'NEEDS_RECAPTURE' },
      });
    });

    it('FAILED with an incomplete bank snapshot (no IFSC) or no rail at all → NO demotion', async () => {
      primeFailed({ upiId: null, bankAccountNumber: '50100', ifscCode: null });
      await runFailed();
      expect(demotions()).toHaveLength(0);
      jest.clearAllMocks();
      primeFailed({ upiId: null, bankAccountNumber: null, ifscCode: null });
      await runFailed();
      expect(demotions()).toHaveLength(0);
    });

    it('PAID → sends the payout-credit WhatsApp POST-COMMIT with the right ordered bodyValues (Flow B)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-07-06T10:00:00.000Z'));
      try {
        mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
        mockPrisma.payoutTransaction.findMany
          .mockResolvedValueOnce([
            { id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'UPI', partnerId: 'p1', redemptionOrderId: 'o1' },
          ])
          .mockResolvedValueOnce([]);
        // Owner + redeemed points resolved POST-COMMIT via batch findMany for the WhatsApp.
        mockPrisma.channelPartner.findMany.mockResolvedValue([{ id: 'p1', ownerName: 'Ravi Traders', phone: '9900000041' }]);
        mockPrisma.redemptionOrder.findMany.mockResolvedValue([{ id: 'o1', pointsDeducted: 500 }]);

        await service.uploadPayoutUtr(
          gifsy,
          'b1',
          buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
          true,
        );

        // DIRECT send via Msg91 with the deoleo_payout_credit template + ordered bodyValues:
        //   [ownerName, points, utr, date-of-payment, month].
        expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledWith(
          '9900000041',
          'deoleo_payout_credit',
          ['Ravi Traders', '500', 'UTR12345678', '06 Jul 2026', 'July 2026'],
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('FIX D: a PAID txn with 0/absent redemption points sends NO WhatsApp (guards the "0 points" msg)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([
          { id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'UPI', partnerId: 'p1', redemptionOrderId: 'o1' },
        ])
        .mockResolvedValueOnce([]);
      // Partner resolves with a valid phone, but the order has 0 points (or is absent) —
      // e.g. an already-reversed / non-redemption txn. No "0 points" message must go out.
      mockPrisma.channelPartner.findMany.mockResolvedValue([{ id: 'p1', ownerName: 'Ravi Traders', phone: '9900000041' }]);
      mockPrisma.redemptionOrder.findMany.mockResolvedValue([{ id: 'o1', pointsDeducted: 0 }]);

      const res = await service.uploadPayoutUtr(
        gifsy,
        'b1',
        buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
        true,
      );

      // The payout still applied, but no WhatsApp fired.
      expect(res).toMatchObject({ applied: true, paidCount: 1 });
      expect(mockMsg91.sendWhatsappTemplate).not.toHaveBeenCalled();
    });

    it('a payout-credit WhatsApp failure does NOT fail the payout (fire-and-forget)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([
          { id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'UPI', partnerId: 'p1', redemptionOrderId: 'o1' },
        ])
        .mockResolvedValueOnce([]);
      mockMsg91.sendWhatsappTemplate.mockRejectedValue(new Error('MSG91 down'));

      const res = await service.uploadPayoutUtr(
        gifsy,
        'b1',
        buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
        true,
      );
      // The payout still applied despite the WhatsApp send throwing.
      expect(res).toMatchObject({ applied: true, paidCount: 1 });
    });

    // ── D5 delivery-receipt for the post-commit payout WhatsApp (best-effort, gated) ──
    describe('D5 delivery receipt (post-commit payout WhatsApp)', () => {
      function primePaid() {
        mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
        mockPrisma.payoutTransaction.findMany
          .mockResolvedValueOnce([
            { id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'UPI', partnerId: 'p1', redemptionOrderId: 'o1' },
          ])
          .mockResolvedValueOnce([]);
        mockPrisma.channelPartner.findMany.mockResolvedValue([{ id: 'p1', ownerName: 'Ravi Traders', phone: '9900000041' }]);
        mockPrisma.redemptionOrder.findMany.mockResolvedValue([{ id: 'o1', pointsDeducted: 500 }]);
      }

      const ORIGINAL_FLAG = process.env.DELIVERY_RECEIPTS_ENABLED;
      afterEach(() => {
        if (ORIGINAL_FLAG === undefined) delete process.env.DELIVERY_RECEIPTS_ENABLED;
        else process.env.DELIVERY_RECEIPTS_ENABLED = ORIGINAL_FLAG;
      });

      it('flag ON → writes a WHATSAPP receipt with a crqid, passes it to the send, and flips QUEUED→SENT with the requestId', async () => {
        process.env.DELIVERY_RECEIPTS_ENABLED = 'true';
        primePaid();
        mockPrisma.messageDeliveryReceipt.create.mockResolvedValue({ id: 'r1', crqid: 'abc123crqid' });
        mockPrisma.messageDeliveryReceipt.updateMany.mockResolvedValue({ count: 1 });
        mockMsg91.sendWhatsappTemplate.mockResolvedValue({ requestId: 'RQ-1' });

        await service.uploadPayoutUtr(
          gifsy,
          'b1',
          buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
          true,
        );

        // QUEUED receipt created for the payout's tenant, WHATSAPP, PAYOUT_NOTIFY, recipient phone.
        expect(mockPrisma.messageDeliveryReceipt.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              clientId: 'deoleo',
              channel: 'WHATSAPP',
              eventKey: 'PAYOUT_NOTIFY',
              recipientPhone: '9900000041',
              status: 'QUEUED',
              crqid: expect.any(String),
            }),
          }),
        );
        // The send carried the receipt's crqid as the 4th arg.
        expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledWith(
          '9900000041',
          'deoleo_payout_credit',
          ['Ravi Traders', '500', 'UTR12345678', expect.any(String), expect.any(String)],
          { crqid: 'abc123crqid' },
        );
        // QUEUED→SENT with the returned requestId, guarded on status:'QUEUED'.
        expect(mockPrisma.messageDeliveryReceipt.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'r1', status: 'QUEUED' },
            data: expect.objectContaining({ status: 'SENT', msg91RequestId: 'RQ-1' }),
          }),
        );
      });

      it('flag OFF → writes NO receipt and the send stays byte-identical (3-arg, no crqid)', async () => {
        delete process.env.DELIVERY_RECEIPTS_ENABLED;
        primePaid();

        await service.uploadPayoutUtr(
          gifsy,
          'b1',
          buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
          true,
        );

        expect(mockPrisma.messageDeliveryReceipt.create).not.toHaveBeenCalled();
        expect(mockPrisma.messageDeliveryReceipt.updateMany).not.toHaveBeenCalled();
        // 3-arg send, no opts object.
        expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledWith(
          '9900000041',
          'deoleo_payout_credit',
          ['Ravi Traders', '500', 'UTR12345678', expect.any(String), expect.any(String)],
        );
      });

      it('flag ON + receipt-write failure → payout notification STILL fires and the payout is unaffected', async () => {
        process.env.DELIVERY_RECEIPTS_ENABLED = 'true';
        primePaid();
        // createReceipt's create throws → helper swallows → returns null → send fires the 3-arg form.
        mockPrisma.messageDeliveryReceipt.create.mockRejectedValue(new Error('DB down'));
        mockMsg91.sendWhatsappTemplate.mockResolvedValue({ requestId: 'RQ-1' });

        const res = await service.uploadPayoutUtr(
          gifsy,
          'b1',
          buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]),
          true,
        );

        // Payout flow unaffected.
        expect(res).toMatchObject({ applied: true, paidCount: 1, failedCount: 0, reversedCount: 0 });
        // Notification still fired — as the byte-identical 3-arg send (no receipt → no crqid).
        expect(mockMsg91.sendWhatsappTemplate).toHaveBeenCalledWith(
          '9900000041',
          'deoleo_payout_credit',
          ['Ravi Traders', '500', 'UTR12345678', expect.any(String), expect.any(String)],
        );
        // No SENT/FAILED flip attempted for a null receipt.
        expect(mockPrisma.messageDeliveryReceipt.updateMany).not.toHaveBeenCalled();
      });
    });

    it('FAILED → marks payout FAILED, reverses points ONCE (M2 claim) and order FAILED', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([
          { id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'UPI', partnerId: 'p1', redemptionOrderId: 'o1' },
        ])
        .mockResolvedValueOnce([]);
      mockTx.redemptionOrder.findFirst.mockResolvedValue({
        pointsDeducted: 500,
        partnerId: 'p1',
        orderNumber: 'RO-1',
      });
      mockTx.redemptionOrder.updateMany.mockResolvedValue({ count: 1 }); // claim wins

      const res = await service.uploadPayoutUtr(
        gifsy,
        'b1',
        buildUpload([{ txnId: 'txn1', status: 'FAILED' }]),
        true,
      );

      expect(res).toMatchObject({ applied: true, paidCount: 0, failedCount: 1, reversedCount: 1 });
      expect(mockTx.payoutTransaction.updateMany).toHaveBeenCalledWith({
        where: { id: 'txn1', status: 'INITIATED' },
        data: expect.objectContaining({ status: 'FAILED' }),
      });
      // The exact M2 claim shape — plus the issued-voucher refund block (no code on the order).
      expect(mockTx.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', pointsDeducted: { gt: 0 }, OR: [{ voucherCode: null }, { voucherCode: '' }] },
        data: { pointsDeducted: 0 },
      });
      expect(mockWallet.reverse).toHaveBeenCalledWith(
        'p1',
        500,
        expect.objectContaining({ referenceId: 'o1' }),
        expect.anything(),
      );
      // Order FAILED write is a guarded claim (never re-FAILs / never duplicates history).
      expect(mockTx.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', status: { not: 'FAILED' }, OR: [{ voucherCode: null }, { voucherCode: '' }] },
        data: { status: 'FAILED' },
      });
      expect(mockTx.redemptionOrder.update).not.toHaveBeenCalled();
    });

    it('FAILED re-upload is a no-op when the claim finds 0 (idempotent reversal)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      // The payout txn is still non-terminal (e.g. INITIATED) but the order points
      // were already zeroed by a prior FAILED upload → claim finds 0, no reverse.
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([
          { id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'UPI', partnerId: 'p1', redemptionOrderId: 'o1' },
        ])
        .mockResolvedValueOnce([]);
      mockTx.redemptionOrder.findFirst.mockResolvedValue({
        pointsDeducted: 0,
        partnerId: 'p1',
        orderNumber: 'RO-1',
      });
      mockTx.redemptionOrder.updateMany.mockResolvedValue({ count: 0 }); // claim loses

      const res = await service.uploadPayoutUtr(
        gifsy,
        'b1',
        buildUpload([{ txnId: 'txn1', status: 'FAILED' }]),
        true,
      );
      expect(res).toMatchObject({ failedCount: 1, reversedCount: 0 });
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    it('skips a payout transaction already in a terminal state (idempotency)', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([
          { id: 'txn1', status: 'SUCCESS', providerRefId: 'UTROLD123456', payoutMode: 'UPI', partnerId: 'p1', redemptionOrderId: 'o1' },
        ])
        .mockResolvedValueOnce([{ providerRefId: 'UTROLD123456' }]);

      const res = await service.uploadPayoutUtr(
        gifsy,
        'b1',
        buildUpload([{ txnId: 'txn1', status: 'FAILED' }]),
        true,
      );
      // Terminal txn → never re-processed.
      expect(res).toMatchObject({ paidCount: 0, failedCount: 0, reversedCount: 0 });
      expect(mockTx.payoutTransaction.update).not.toHaveBeenCalled();
      expect(mockTx.payoutTransaction.updateMany).not.toHaveBeenCalled();
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });

    // Order-timeline D1 — the UTR upload now routes its order status writes through the shared
    // transition, which records a RedemptionStatusHistory row in the SAME tx. Money effects
    // (payout flip, M2 refund claim, wallet.reverse, counts) must stay exactly as before.
    describe('status history (shared order-status transition)', () => {
      const oneTxn = () =>
        mockPrisma.payoutTransaction.findMany
          .mockResolvedValueOnce([
            { id: 'txn1', status: 'INITIATED', providerRefId: null, payoutMode: 'UPI', partnerId: 'p1', redemptionOrderId: 'o1' },
          ])
          .mockResolvedValueOnce([]);
      beforeEach(() => {
        mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
        mockTx.redemptionStatusHistory.create.mockResolvedValue({});
      });

      it('FAILED on an order holding a voucher code: order left untouched (no refund, no FAILED flip), reported + logged', async () => {
        oneTxn();
        mockTx.redemptionOrder.findFirst.mockResolvedValue({
          pointsDeducted: 500, partnerId: 'p1', orderNumber: 'RO-1', status: 'CONFIRMED', voucherCode: 'ODD-CODE-1',
        });
        const errSpy = jest.spyOn((service as unknown as { logger: { error: (m: string) => void } }).logger, 'error');
        const res = await service.uploadPayoutUtr(gifsy, 'b1', buildUpload([{ txnId: 'txn1', status: 'FAILED' }]), true);
        expect(res).toMatchObject({ failedCount: 1, reversedCount: 0 });
        // The ORDER is left exactly as is: no refund claim, no FAILED flip, no history row.
        expect(mockTx.redemptionOrder.updateMany).not.toHaveBeenCalled();
        expect(mockTx.redemptionStatusHistory.create).not.toHaveBeenCalled();
        expect(mockWallet.reverse).not.toHaveBeenCalled();
        // …and it is reported back for the admin payouts screen.
        expect(res.blockedOrders).toEqual([
          expect.objectContaining({ txnId: 'txn1', orderId: 'o1', orderNumber: 'RO-1', reason: expect.stringMatching(/voucher code/) }),
        ]);
        expect(errSpy.mock.calls.some(([m]) => /voucher code is on the order/.test(String(m)))).toBe(true);
        expect(JSON.stringify(errSpy.mock.calls)).not.toContain('ODD-CODE-1');
      });

      it('PAID: the guarded DELIVERED claim is byte-identical and writes ONE DELIVERED history row (actor = uploader)', async () => {
        oneTxn();
        const res = await service.uploadPayoutUtr(gifsy, 'b1', buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]), true);
        expect(res).toMatchObject({ applied: true, paidCount: 1, failedCount: 0, reversedCount: 0 });
        expect(mockTx.redemptionOrder.updateMany).toHaveBeenCalledTimes(1);
        expect(mockTx.redemptionOrder.updateMany).toHaveBeenCalledWith({
          where: { id: 'o1', status: { notIn: ['DELIVERED', 'CANCELLED', 'RETURNED', 'FAILED'] } },
          data: { status: 'DELIVERED', deliveredAt: expect.any(Date) },
        });
        expect(mockTx.redemptionStatusHistory.create).toHaveBeenCalledTimes(1);
        expect(mockTx.redemptionStatusHistory.create).toHaveBeenCalledWith({
          data: { orderId: 'o1', fromStatus: null, toStatus: 'DELIVERED', changedById: gifsy.sub, notes: null },
        });
        expect(mockWallet.reverse).not.toHaveBeenCalled();
      });

      it('PAID on an already-terminal order (claim count 0) writes NO history row', async () => {
        oneTxn();
        mockTx.redemptionOrder.updateMany.mockResolvedValue({ count: 0 });
        await service.uploadPayoutUtr(gifsy, 'b1', buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]), true);
        expect(mockTx.redemptionStatusHistory.create).not.toHaveBeenCalled();
      });

      it('FAILED: refund + order flip unchanged, plus ONE FAILED history row from the prior status', async () => {
        oneTxn();
        mockTx.redemptionOrder.findFirst.mockResolvedValue({ pointsDeducted: 500, partnerId: 'p1', orderNumber: 'RO-1', status: 'CONFIRMED' });
        const res = await service.uploadPayoutUtr(gifsy, 'b1', buildUpload([{ txnId: 'txn1', status: 'FAILED' }]), true);
        expect(res).toMatchObject({ applied: true, paidCount: 0, failedCount: 1, reversedCount: 1 });
        expect(mockTx.redemptionOrder.findFirst).toHaveBeenCalledWith({
          where: { id: 'o1' },
          select: { pointsDeducted: true, partnerId: true, orderNumber: true, status: true, voucherCode: true },
        });
        expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
        expect(mockWallet.reverse).toHaveBeenCalledWith('p1', 500, { referenceId: 'o1', description: 'Reversal RO-1' }, mockTx);
        // Two guarded claims on the order: the M2 refund claim, then the FAILED status claim.
        expect(mockTx.redemptionOrder.updateMany).toHaveBeenCalledTimes(2);
        expect(mockTx.redemptionOrder.updateMany).toHaveBeenLastCalledWith({
          where: { id: 'o1', status: { not: 'FAILED' }, OR: [{ voucherCode: null }, { voucherCode: '' }] },
          data: { status: 'FAILED' },
        });
        expect(mockTx.redemptionOrder.update).not.toHaveBeenCalled();
        expect(mockTx.redemptionStatusHistory.create).toHaveBeenCalledTimes(1);
        expect(mockTx.redemptionStatusHistory.create).toHaveBeenCalledWith({
          data: { orderId: 'o1', fromStatus: 'CONFIRMED', toStatus: 'FAILED', changedById: gifsy.sub, notes: null },
        });
      });

      it('FAILED on an order that is already FAILED: no refund, no duplicate history row', async () => {
        oneTxn();
        mockTx.redemptionOrder.findFirst.mockResolvedValue({ pointsDeducted: 0, partnerId: 'p1', orderNumber: 'RO-1', status: 'FAILED' });
        mockTx.redemptionOrder.updateMany.mockResolvedValue({ count: 0 });
        const res = await service.uploadPayoutUtr(gifsy, 'b1', buildUpload([{ txnId: 'txn1', status: 'FAILED' }]), true);
        expect(res).toMatchObject({ failedCount: 1, reversedCount: 0 });
        expect(mockWallet.reverse).not.toHaveBeenCalled();
        expect(mockTx.redemptionStatusHistory.create).not.toHaveBeenCalled();
      });

      it('a history-write failure aborts the whole upload tx (same atomicity as the money path)', async () => {
        oneTxn();
        mockTx.redemptionStatusHistory.create.mockRejectedValue(new Error('db down'));
        await expect(
          service.uploadPayoutUtr(gifsy, 'b1', buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]), true),
        ).rejects.toThrow('db down');
      });
    });

    // Deadlock avoidance: rows are claimed in txnId order (same lock order across uploads), but
    // the reported rowNum stays the row's position in the uploaded file.
    it('claims payouts in deterministic txnId order regardless of file order; skipped keeps the file rowNum', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
      const txn = (id: string) => ({
        id, status: 'INITIATED', providerRefId: null, payoutMode: 'UPI', partnerId: 'p1', redemptionOrderId: null,
        upiId: null, bankAccountNumber: null, ifscCode: null,
      });
      mockPrisma.payoutTransaction.findMany
        .mockResolvedValueOnce([txn('txn-c'), txn('txn-a'), txn('txn-b')])
        .mockResolvedValueOnce([]);
      // txn-a lost its claim to an overlapping upload.
      mockTx.payoutTransaction.updateMany.mockImplementation(async ({ where }: { where: { id: string } }) => ({
        count: where.id === 'txn-a' ? 0 : 1,
      }));

      // File order c, a, b → sheet rows 2, 3, 4 (row 1 = header).
      const res = await service.uploadPayoutUtr(
        gifsy,
        'b1',
        buildUpload([
          { txnId: 'txn-c', utr: 'UTRCCCC11111', status: 'PAID' },
          { txnId: 'txn-a', utr: 'UTRAAAA11111', status: 'PAID' },
          { txnId: 'txn-b', utr: 'UTRBBBB11111', status: 'PAID' },
        ]),
        true,
      );

      const claimOrder = mockTx.payoutTransaction.updateMany.mock.calls.map(
        (c: [{ where: { id: string } }]) => c[0].where.id,
      );
      expect(claimOrder).toEqual(['txn-a', 'txn-b', 'txn-c']);
      expect(res).toMatchObject({
        paidCount: 2,
        skipped: [{ rowNum: 3, txnId: 'txn-a', outcome: 'PAID', reason: 'Payout already updated by another upload' }],
      });
    });

    // ── Overlapping uploads (read-before-tx race) ──
    // A tiny stateful fake of the rows the upload tx touches. Each upload's pre-tx findMany is
    // primed with a STALE snapshot (what it read before the other upload committed); the tx-side
    // writes are evaluated against the CURRENT fake state — exactly what Postgres does when the
    // losing tx's UPDATE re-checks its predicate after the winner commits.
    describe('overlapping uploads for the same payout (compare-and-set)', () => {
      type OrderRow = { id: string; status: string; pointsDeducted: number; partnerId: string; orderNumber: string };
      let db: { payout: { id: string; status: string }; order: OrderRow; history: Array<{ toStatus: string }> };

      const matchStatus = (actual: string, cond: unknown): boolean => {
        if (cond === undefined) return true;
        if (typeof cond === 'string') return actual === cond;
        const c = cond as { not?: string; notIn?: string[]; in?: string[] };
        if (c.not !== undefined && actual === c.not) return false;
        if (c.notIn && c.notIn.includes(actual)) return false;
        if (c.in && !c.in.includes(actual)) return false;
        return true;
      };

      beforeEach(() => {
        db = {
          payout: { id: 'txn1', status: 'INITIATED' },
          order: { id: 'o1', status: 'CONFIRMED', pointsDeducted: 500, partnerId: 'p1', orderNumber: 'RO-1' },
          history: [],
        };
        mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', batchCode: 'PB-1' });
        mockTx.payoutTransaction.updateMany.mockImplementation(
          async ({ where, data }: { where: { id: string; status?: string }; data: { status: string } }) => {
            if (where.id !== db.payout.id || !matchStatus(db.payout.status, where.status)) return { count: 0 };
            db.payout.status = data.status;
            return { count: 1 };
          },
        );
        mockTx.redemptionOrder.findFirst.mockImplementation(async () => ({ ...db.order }));
        mockTx.redemptionOrder.updateMany.mockImplementation(
          async ({ where, data }: {
            where: { id: string; status?: unknown; pointsDeducted?: { gt: number } };
            data: Partial<OrderRow>;
          }) => {
            if (where.id !== db.order.id) return { count: 0 };
            if (where.pointsDeducted && !(db.order.pointsDeducted > where.pointsDeducted.gt)) return { count: 0 };
            if (!matchStatus(db.order.status, where.status)) return { count: 0 };
            Object.assign(db.order, data);
            return { count: 1 };
          },
        );
        mockTx.redemptionStatusHistory.create.mockImplementation(async ({ data }: { data: { toStatus: string } }) => {
          db.history.push({ toStatus: data.toStatus });
          return {};
        });
        // Post-commit WhatsApp reads the order's CURRENT points.
        mockPrisma.redemptionOrder.findMany.mockImplementation(async () => [{ id: 'o1', pointsDeducted: db.order.pointsDeducted }]);
      });
      afterEach(() => {
        mockTx.redemptionStatusHistory.create.mockReset();
        mockPrisma.redemptionOrder.findMany.mockReset();
        mockTx.payoutTransaction.updateMany.mockReset();
      });

      // Prime ONE upload's pre-tx reads with the given (possibly stale) payout status.
      const primeRead = (status: string) =>
        mockPrisma.payoutTransaction.findMany
          .mockResolvedValueOnce([
            {
              id: 'txn1', status, providerRefId: null, payoutMode: 'UPI', partnerId: 'p1', redemptionOrderId: 'o1',
              upiId: null, bankAccountNumber: null, ifscCode: null,
            },
          ])
          .mockResolvedValueOnce([]);
      const paid = () => buildUpload([{ txnId: 'txn1', utr: 'UTR12345678', status: 'PAID' }]);
      const failed = () => buildUpload([{ txnId: 'txn1', status: 'FAILED' }]);
      const LOST = { rowNum: expect.any(Number), txnId: 'txn1', reason: 'Payout already updated by another upload' };

      it('PAID wins, overlapping FAILED loses: partner paid, NO refund, order stays DELIVERED, one history row', async () => {
        primeRead('INITIATED'); // upload A (PAID)
        primeRead('INITIATED'); // upload B (FAILED) — read BEFORE A committed (stale)
        const a = await service.uploadPayoutUtr(gifsy, 'b1', paid(), true);
        const b = await service.uploadPayoutUtr(gifsy, 'b1', failed(), true);

        expect(a).toMatchObject({ paidCount: 1, failedCount: 0, reversedCount: 0, skipped: [] });
        expect(b).toMatchObject({ paidCount: 0, failedCount: 0, reversedCount: 0, skipped: [{ ...LOST, outcome: 'FAILED' }] });
        expect(db.payout.status).toBe('SUCCESS');
        expect(mockWallet.reverse).not.toHaveBeenCalled();
        expect(db.order).toMatchObject({ status: 'DELIVERED', pointsDeducted: 500 });
        expect(db.history).toEqual([{ toStatus: 'DELIVERED' }]);
        // The loser ran NONE of its side effects: no order read, no NEEDS_RECAPTURE demote.
        expect(mockTx.redemptionOrder.findFirst).not.toHaveBeenCalled();
        expect(mockTx.channelPartner.updateMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ data: { paymentDetailsStatus: 'NEEDS_RECAPTURE' } }),
        );
      });

      it('FAILED wins, overlapping PAID loses: refund exactly once, order FAILED, no DELIVERED, no payout WhatsApp', async () => {
        primeRead('INITIATED'); // upload A (FAILED)
        primeRead('INITIATED'); // upload B (PAID) — stale
        const a = await service.uploadPayoutUtr(gifsy, 'b1', failed(), true);
        const b = await service.uploadPayoutUtr(gifsy, 'b1', paid(), true);

        expect(a).toMatchObject({ paidCount: 0, failedCount: 1, reversedCount: 1, skipped: [] });
        expect(b).toMatchObject({ paidCount: 0, failedCount: 0, reversedCount: 0, skipped: [{ ...LOST, outcome: 'PAID' }] });
        expect(db.payout.status).toBe('FAILED');
        expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
        expect(mockWallet.reverse).toHaveBeenCalledWith('p1', 500, expect.objectContaining({ referenceId: 'o1' }), mockTx);
        expect(db.order).toMatchObject({ status: 'FAILED', pointsDeducted: 0 });
        expect(db.history).toEqual([{ toStatus: 'FAILED' }]);
        // Loser gathered no WhatsApp and did not verify-stamp the partner.
        expect(mockMsg91.sendWhatsappTemplate).not.toHaveBeenCalled();
        expect(mockTx.channelPartner.updateMany).not.toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ paymentDetailsStatus: 'VERIFIED' }) }),
        );
      });

      it('two overlapping FAILED uploads of the same file: refund once, ONE FAILED history row', async () => {
        primeRead('INITIATED');
        primeRead('INITIATED');
        await service.uploadPayoutUtr(gifsy, 'b1', failed(), true);
        const b = await service.uploadPayoutUtr(gifsy, 'b1', failed(), true);
        expect(b).toMatchObject({ failedCount: 0, reversedCount: 0, skipped: [{ ...LOST, outcome: 'FAILED' }] });
        expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
        expect(db.history).toEqual([{ toStatus: 'FAILED' }]);
      });

      it('sequential re-upload of the SAME file (fresh read sees terminal) is still a silent no-op', async () => {
        primeRead('INITIATED');
        await service.uploadPayoutUtr(gifsy, 'b1', failed(), true);
        primeRead(db.payout.status); // fresh read → FAILED (terminal)
        const again = await service.uploadPayoutUtr(gifsy, 'b1', failed(), true);
        expect(again).toMatchObject({ paidCount: 0, failedCount: 0, reversedCount: 0, skipped: [] });
        expect(mockWallet.reverse).toHaveBeenCalledTimes(1);
        expect(db.history).toEqual([{ toStatus: 'FAILED' }]);
      });

      it('order FAILED write is guarded: an order that became FAILED after the in-tx read gets NO duplicate history row', async () => {
        primeRead('INITIATED');
        // The in-tx order read is stale (CONFIRMED) but the row is already FAILED in the DB.
        db.order.status = 'FAILED';
        db.order.pointsDeducted = 0;
        mockTx.redemptionOrder.findFirst.mockImplementationOnce(async () => ({
          ...db.order, status: 'CONFIRMED', pointsDeducted: 500,
        }));
        await service.uploadPayoutUtr(gifsy, 'b1', failed(), true);
        expect(mockWallet.reverse).not.toHaveBeenCalled(); // M2 claim found pointsDeducted 0
        expect(db.history).toEqual([]); // guarded FAILED claim lost → no phantom row
      });
    });
  });
});
