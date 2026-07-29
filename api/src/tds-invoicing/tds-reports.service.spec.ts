/**
 * Unit tests for TdsReportsService — Wave 1 Stream C (§6). Mock Prisma, no I/O.
 * Covers: payout report (GST reg type + frozen TDS treatment, BigInt serialisation, tenant
 * scoping), unregistered/RCM report (filters to UNREGISTERED partners), recovery report shape,
 * and the xlsx cellSafe formula-injection guard on a malicious cell.
 * Run: npx jest src/tds-invoicing/tds-reports.service.spec.ts
 */
import { TdsReportsService } from './tds-reports.service';
import { PrismaService } from '../prisma/prisma.service';
import * as XLSX from 'xlsx';

const mockPrisma = {
  creditPayoutEntry: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  autoInvoice: { findMany: jest.fn() },
  channelPartner: { findMany: jest.fn() },
  tdsRecoveryEntry: { findMany: jest.fn() },
};

/** Read a built workbook Buffer back into per-sheet array-of-objects. */
function readWorkbook(buffer: Buffer): Record<string, Record<string, unknown>[]> {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const name of wb.SheetNames) out[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
  return out;
}

describe('TdsReportsService', () => {
  let service: TdsReportsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TdsReportsService(mockPrisma as unknown as PrismaService);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.autoInvoice.findMany.mockResolvedValue([]);
    mockPrisma.channelPartner.findMany.mockResolvedValue([]);
    mockPrisma.tdsRecoveryEntry.findMany.mockResolvedValue([]);
  });

  describe('payoutReport', () => {
    it('joins GST reg type + frozen TDS treatment, serialises paise, totals; JSON-safe', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        {
          id: 'e1',
          clientId: 'deoleo',
          // FIX-E: CreditPayoutEntry.outletId IS the outlet CODE (join key), not the PK.
          outletId: 'OUT1',
          outletName: 'Shop 1',
          fieldName: 'Visibility',
          period: '2026-06',
          amountPaise: 500000n,
          tdsSection: 'SEC_194C',
          tdsMethodology: 'GROSS_UP',
          tdsDeductedPaise: 0n,
          autoInvoiceId: 'inv1',
          autoInvoice: { invoiceNumber: 'INV-1' },
        },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([
        {
          clientId: 'deoleo',
          outletCode: 'OUT1',
          partner: {
            gstRegistrationType: 'REGULAR',
            entityType: 'INDIVIDUAL',
            panNumber: 'ABCDE1234F',
            businessName: 'Shop One',
          },
        },
      ]);

      const res = await service.payoutReport({ clientId: 'deoleo' });

      expect(mockPrisma.creditPayoutEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tdsSection: { not: null }, clientId: 'deoleo' } }),
      );
      expect(res.count).toBe(1);
      const row = res.rows[0];
      expect(row.outletCode).toBe('OUT1');
      expect(row.gstRegistrationType).toBe('REGULAR');
      expect(row.tdsSection).toBe('SEC_194C');
      expect(row.tdsMethodology).toBe('GROSS_UP');
      expect(row.amount).toEqual({ paise: '500000', inr: 5000 });
      expect(row.invoiceNumber).toBe('INV-1');
      expect(res.totals.amount).toEqual({ paise: '500000', inr: 5000 });
      expect(() => JSON.stringify(res)).not.toThrow();
    });

    it('platform-wide scope (no clientId) does not pin the query to a tenant', async () => {
      await service.payoutReport({});
      expect(mockPrisma.creditPayoutEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tdsSection: { not: null } } }),
      );
    });

    it('xlsx export escapes a formula-injection cell (cellSafe via buildXlsx)', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        {
          id: 'e1',
          clientId: 'deoleo',
          // FIX-E: outletId is the outlet CODE — the malicious value flows through as the code cell.
          outletId: '=HYPERLINK("evil")',
          outletName: '=cmd()|calc',
          fieldName: 'Visibility',
          period: '2026-06',
          amountPaise: 100n,
          tdsSection: 'SEC_194C',
          tdsMethodology: 'DEDUCT',
          tdsDeductedPaise: 0n,
          autoInvoiceId: null,
          autoInvoice: null,
        },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([
        { clientId: 'deoleo', outletCode: '=HYPERLINK("evil")', partner: null },
      ]);

      const { buffer, filename } = await service.payoutReportXlsx({ clientId: 'deoleo' });
      expect(filename).toBe('payout-report-deoleo.xlsx');
      const wb = readWorkbook(buffer);
      const row = wb['Payouts'][0];
      // Both the malicious outlet code and outlet name are neutralised with a leading apostrophe.
      expect(String(row['Outlet Code'])).toBe("'=HYPERLINK(\"evil\")");
      expect(String(row['Outlet Name'])).toBe("'=cmd()|calc");
    });
  });

  describe('unregisteredReport', () => {
    it('keeps only invoices whose partner is UNREGISTERED, with invoice numbers', async () => {
      mockPrisma.autoInvoice.findMany.mockResolvedValue([
        {
          id: 'i1', clientId: 'deoleo', invoiceNumber: 'INV-U', partnerId: 'p1', outletCode: 'OUT1',
          period: '2026-06', invoiceDate: new Date('2026-06-30T00:00:00Z'), invoiceKind: 'SERVICE',
          subtotalPaise: 500000n, gstPaise: 0n, totalPaise: 500000n,
        },
        {
          id: 'i2', clientId: 'deoleo', invoiceNumber: 'INV-R', partnerId: 'p2', outletCode: 'OUT2',
          period: '2026-06', invoiceDate: new Date('2026-06-30T00:00:00Z'), invoiceKind: 'SERVICE',
          subtotalPaise: 700000n, gstPaise: 126000n, totalPaise: 826000n,
        },
      ]);
      mockPrisma.channelPartner.findMany.mockResolvedValue([
        { id: 'p1', gstRegistrationType: 'UNREGISTERED', businessName: 'U Shop', ownerName: 'U', panNumber: 'AAAAA1111A' },
        { id: 'p2', gstRegistrationType: 'REGULAR', businessName: 'R Shop', ownerName: 'R', panNumber: 'BBBBB2222B' },
      ]);

      const res = await service.unregisteredReport({ clientId: 'deoleo' });

      expect(res.count).toBe(1);
      expect(res.rows[0].invoiceNumber).toBe('INV-U');
      expect(res.rows[0].panNumber).toBe('AAAAA1111A');
      expect(res.totals.subtotal).toEqual({ paise: '500000', inr: 5000 });
      expect(() => JSON.stringify(res)).not.toThrow();
    });
  });

  describe('recoveryReport', () => {
    it('returns the "in lieu of TDS deduction" ledger, scoped + serialised', async () => {
      mockPrisma.tdsRecoveryEntry.findMany.mockResolvedValue([
        {
          clientId: 'deoleo', panNumber: 'ABCDE1234F', section: 'SEC_194C', fyLabel: '2026-27',
          tdsInvoiceId: 'tinv1', panTdsTotalPaise: 110000n, tenantBasePaise: 700000n,
          panBasePaise: 1100000n, tenantSharePaise: 70000n, createdAt: new Date('2026-07-01T00:00:00Z'),
        },
      ]);

      const res = await service.recoveryReport({ clientId: 'deoleo', fy: '2026-27' });

      expect(mockPrisma.tdsRecoveryEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { clientId: 'deoleo', fyLabel: '2026-27' } }),
      );
      expect(res.label).toBe('in lieu of TDS deduction');
      expect(res.count).toBe(1);
      expect(res.rows[0].tenantShare).toEqual({ paise: '70000', inr: 700 });
      expect(res.totals.tenantShare).toEqual({ paise: '70000', inr: 700 });
      expect(() => JSON.stringify(res)).not.toThrow();
    });
  });
});
