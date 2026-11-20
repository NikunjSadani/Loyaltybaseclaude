/**
 * Unit tests for GstReimbursementService — Wave 1 Stream C (D5). Mock Prisma, no I/O.
 * Covers: list (filters + BigInt serialisation + totals), release happy path,
 * idempotency (already-RELEASED → 409), not-found (→ 404), and race-safe conditional write.
 * Run: npx jest src/tds-invoicing/gst-reimbursement.service.spec.ts
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { GstReimbursementService } from './gst-reimbursement.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const mockPrisma = {
  gstReimbursement: {
    findMany: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
  },
  auditLog: { create: jest.fn() },
};

const GIFSY: JwtPayload = {
  sub: 'op-1',
  role: 'GIFSY_ADMIN',
  clientId: 'gifsy',
  phone: '9000000000',
  name: 'Operator',
};

describe('GstReimbursementService', () => {
  let service: GstReimbursementService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GstReimbursementService(mockPrisma as unknown as PrismaService);
    mockPrisma.gstReimbursement.findMany.mockResolvedValue([]);
    mockPrisma.gstReimbursement.count.mockResolvedValue(0);
    mockPrisma.auditLog.create.mockResolvedValue({});
  });

  describe('list', () => {
    it('defaults to HELD and serialises BigInt paise to strings + rupee mirror + total', async () => {
      mockPrisma.gstReimbursement.findMany.mockResolvedValue([
        {
          id: 'r1',
          clientId: 'deoleo',
          autoInvoiceId: 'inv1',
          partnerId: 'p1',
          outletCode: 'OUT1',
          status: 'HELD',
          gstPaise: 90000n,
          proofUrl: null,
          releasePayoutRef: null,
          releasedAt: null,
          releasedById: null,
          notes: null,
          createdAt: new Date('2026-07-01T00:00:00Z'),
          autoInvoice: { invoiceNumber: 'INV-1', period: '2026-06', invoiceDate: new Date(), gstType: 'CGST_SGST' },
        },
      ]);

      const res = await service.list({});

      expect(mockPrisma.gstReimbursement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'HELD', gstPaise: { gt: 0n } } }),
      );
      expect(res.status).toBe('HELD');
      expect(res.zeroHeldCount).toBe(0);
      expect(res.count).toBe(1);
      expect(res.items[0].gst).toEqual({ paise: '90000', inr: 900 });
      expect(res.items[0].invoiceNumber).toBe('INV-1');
      expect(res.totalGst).toEqual({ paise: '90000', inr: 900 });
      // No BigInt leaks — the payload must be JSON-serialisable.
      expect(() => JSON.stringify(res)).not.toThrow();
    });

    it('applies clientId + period filters (period via the linked invoice)', async () => {
      await service.list({ status: 'RELEASED', clientId: 'deoleo', period: '2026-06' });
      expect(mockPrisma.gstReimbursement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'RELEASED', clientId: 'deoleo', autoInvoice: { period: '2026-06' } },
        }),
      );
      // RELEASED never runs the ₹0-held side count.
      expect(mockPrisma.gstReimbursement.count).not.toHaveBeenCalled();
    });

    it('HELD queue excludes ₹0 HELD rows from items/count/total and reports how many were left out (same scope)', async () => {
      mockPrisma.gstReimbursement.count.mockResolvedValue(2);
      // DB returns only GST > 0 rows for the HELD queue (the where clause does the exclusion).
      mockPrisma.gstReimbursement.findMany.mockResolvedValue([
        {
          id: 'r1', clientId: 'bajaj', autoInvoiceId: 'inv1', partnerId: 'p1', outletCode: 'OUT1',
          status: 'HELD', gstPaise: 1n, proofUrl: null, releasePayoutRef: null, releasedAt: null,
          releasedById: null, notes: null, createdAt: new Date('2026-11-01T00:00:00Z'),
          autoInvoice: { invoiceNumber: 'INV-1', period: '2026-10', invoiceDate: new Date(), gstType: 'IGST' },
        },
      ]);

      const res = await service.list({ status: 'HELD', clientId: 'bajaj', period: '2026-10' });

      expect(mockPrisma.gstReimbursement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'HELD', gstPaise: { gt: 0n }, clientId: 'bajaj', autoInvoice: { period: '2026-10' } },
        }),
      );
      expect(mockPrisma.gstReimbursement.count).toHaveBeenCalledWith({
        where: { status: 'HELD', gstPaise: 0n, clientId: 'bajaj', autoInvoice: { period: '2026-10' } },
      });
      // A 1-paise row is still releasable — it must stay in the queue.
      expect(res.count).toBe(1);
      expect(res.totalGst).toEqual({ paise: '1', inr: 0.01 });
      expect(res.zeroHeldCount).toBe(2);
    });

    it('HELD_ZERO lists only the ₹0 HELD rows (audit view), no side count', async () => {
      const res = await service.list({ status: 'HELD_ZERO', clientId: 'bajaj' });
      expect(mockPrisma.gstReimbursement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'HELD', gstPaise: 0n, clientId: 'bajaj' } }),
      );
      expect(res.status).toBe('HELD_ZERO');
      expect(res.zeroHeldCount).toBeNull();
      expect(mockPrisma.gstReimbursement.count).not.toHaveBeenCalled();
    });
  });

  describe('release', () => {
    const dto = { proofUrl: 'https://proof/1', releasePayoutRef: 'UTR-123', notes: 'ok' };

    it('flips HELD → RELEASED, stamps proof/payout/releasedBy, and audits', async () => {
      mockPrisma.gstReimbursement.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.gstReimbursement.findUnique.mockResolvedValue({
        clientId: 'deoleo',
        outletCode: 'OUT1',
        gstPaise: 90000n,
        autoInvoice: { invoiceNumber: 'INV-1', period: '2026-06' },
      });

      const res = await service.release(GIFSY, 'r1', dto);

      expect(mockPrisma.gstReimbursement.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'r1', status: 'HELD', gstPaise: { gt: 0n } },
          data: expect.objectContaining({
            status: 'RELEASED',
            proofUrl: 'https://proof/1',
            releasePayoutRef: 'UTR-123',
            releasedById: 'op-1',
          }),
        }),
      );
      expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(res.status).toBe('RELEASED');
      expect(res.gst).toEqual({ paise: '90000', inr: 900 });
      expect(res.releasedById).toBe('op-1');
    });

    it('idempotent: an already-RELEASED row → 409 Conflict, never re-stamps or audits', async () => {
      mockPrisma.gstReimbursement.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.gstReimbursement.findUnique.mockResolvedValue({ status: 'RELEASED' });

      await expect(service.release(GIFSY, 'r1', dto)).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('a HELD row kept at ₹0 → 409 "Nothing to release", never released or audited', async () => {
      mockPrisma.gstReimbursement.updateMany.mockResolvedValue({ count: 0 }); // the GST > 0 guard matched nothing
      mockPrisma.gstReimbursement.findUnique.mockResolvedValue({ status: 'HELD', gstPaise: 0n });

      const err = await service.release(GIFSY, 'r0', dto).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toMatch(/Nothing to release/);
      expect(mockPrisma.gstReimbursement.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'r0', status: 'HELD', gstPaise: { gt: 0n } } }),
      );
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('unknown id → 404 NotFound, never audits', async () => {
      mockPrisma.gstReimbursement.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.gstReimbursement.findUnique.mockResolvedValue(null);

      await expect(service.release(GIFSY, 'nope', dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });
  });
});
