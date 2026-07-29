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
        expect.objectContaining({ where: { status: 'HELD' } }),
      );
      expect(res.status).toBe('HELD');
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
          where: { id: 'r1', status: 'HELD' },
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

    it('unknown id → 404 NotFound, never audits', async () => {
      mockPrisma.gstReimbursement.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.gstReimbursement.findUnique.mockResolvedValue(null);

      await expect(service.release(GIFSY, 'nope', dto)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
    });
  });
});
