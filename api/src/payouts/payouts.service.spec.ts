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
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockTx = {
  fundReceipt: { create: jest.fn() },
  fundLedger: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  payoutTransaction: { update: jest.fn() },
  payoutBatch: { update: jest.fn() },
  redemptionOrder: {
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
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
  tdsRecord: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx)),
};

const mockWallet = {
  reverse: jest.fn(),
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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWallet },
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
      const from = new Date('2026-01-01');
      const to = new Date('2026-02-01');
      await service.listTransactions(gifsy, { dateFrom: from, dateTo: to });
      const where = mockPrisma.payoutTransaction.findMany.mock.calls[0][0].where;
      expect(where.createdAt).toEqual({ gte: from, lte: to });
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
      expect(mockTx.payoutTransaction.update).toHaveBeenCalledWith({
        where: { id: 't1' },
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

      expect(res).toMatchObject({ applied: true, paidCount: 1, failedCount: 0, reversedCount: 0 });
      expect(mockTx.payoutTransaction.update).toHaveBeenCalledWith({
        where: { id: 'txn1' },
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
      expect(mockTx.payoutTransaction.update).toHaveBeenCalledWith({
        where: { id: 'txn1' },
        data: expect.objectContaining({ status: 'FAILED' }),
      });
      // The exact M2 claim shape.
      expect(mockTx.redemptionOrder.updateMany).toHaveBeenCalledWith({
        where: { id: 'o1', pointsDeducted: { gt: 0 } },
        data: { pointsDeducted: 0 },
      });
      expect(mockWallet.reverse).toHaveBeenCalledWith(
        'p1',
        500,
        expect.objectContaining({ referenceId: 'o1' }),
        expect.anything(),
      );
      expect(mockTx.redemptionOrder.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { status: 'FAILED' },
      });
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
      expect(mockWallet.reverse).not.toHaveBeenCalled();
    });
  });
});
