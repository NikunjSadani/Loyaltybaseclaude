// Unit tests for PayoutsService — ported from platform/src/app/api/payouts/*.
// Covers tenant scoping, the fund-receipt + ledger transaction, the batch
// process pipeline (validation/TDS/fund-check/disbursement), and the
// reconciliation export. Run: npx jest src/payouts/payouts.service.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PayoutsService } from './payouts.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockTx = {
  fundReceipt: { create: jest.fn() },
  fundLedger: { create: jest.fn() },
  auditLog: { create: jest.fn() },
  payoutTransaction: { update: jest.fn() },
  payoutBatch: { update: jest.fn() },
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
      providers: [PayoutsService, { provide: PrismaService, useValue: mockPrisma }],
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

    it('passes the fund check (FULL amount, no TDS), flags transactions and SUBMITs', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      // One eligible tx (amountPaise 3,000,000 = ₹30,000).
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        {
          id: 't1',
          partnerId: 'p1',
          amountPaise: 3000000,
          partner: { panNumber: 'ABCDE1234F' },
        },
      ]);
      // Required is now the FULL 3,000,000 (no TDS deduction); ledger 5,000,000 passes.
      mockPrisma.fundLedger.findFirst.mockResolvedValue({ balancePaise: 5000000 });

      const res = await service.processBatch(gifsy, 'b1');

      // Payouts do NOT withhold TDS — the TDS engine owns that.
      expect(mockPrisma.tdsRecord.create).not.toHaveBeenCalled();
      expect(res.steps).not.toHaveProperty('tdsComputation');
      expect(res.steps.fundCheck.required).toBe(3000000); // full gross, not netted
      expect(res.steps.fundCheck.status).toBe('PASSED');
      expect(res.steps.disbursement.flagged).toBe(1);
      expect(res.status).toBe('SUBMITTED');
      // The disbursement + finalisation run inside the $transaction.
      expect(mockTx.payoutTransaction.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { status: 'INITIATED' },
      });
      expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    });

    it('FAILs the batch when funds are insufficient', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        { id: 't1', partnerId: 'p1', amountPaise: 500000, partner: { panNumber: 'ABCDE1234F' } },
      ]);
      // Required = full 500,000; ledger 1,000 is short.
      mockPrisma.fundLedger.findFirst.mockResolvedValue({ balancePaise: 1000 });

      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.fundCheck.required).toBe(500000);
      expect(res.steps.fundCheck.status).toBe('FAILED');
      expect(res.steps.disbursement.flagged).toBe(0);
      expect(res.status).toBe('FAILED');
    });

    it('flags PAN-less transactions as validation warnings and excludes them', async () => {
      mockPrisma.payoutBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DRAFT' });
      mockPrisma.payoutTransaction.findMany.mockResolvedValue([
        { id: 't1', partnerId: 'p1', amountPaise: 100000, partner: { panNumber: null } },
      ]);
      mockPrisma.fundLedger.findFirst.mockResolvedValue({ balancePaise: 5000000 });

      const res = await service.processBatch(gifsy, 'b1');
      expect(res.steps.validation.status).toBe('PASSED_WITH_WARNINGS');
      expect(res.steps.disbursement.flagged).toBe(0); // invalid tx excluded
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
});
