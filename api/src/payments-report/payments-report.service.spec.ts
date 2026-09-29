/**
 * Unit tests for PaymentsReportService — READ-ONLY cross-stream payments report. Mock Prisma, no I/O.
 * Covers: ALL streams included (NO tdsSection filter in the where); paidAt not-null + [from,to]
 * range; optional status filter; batched lookups (findMany call counts — no N+1); the sales chain
 * built from the assignment + reportingTo up-walk (cycle-safe); BigInt → {paise,inr} serialisation;
 * and the xlsx cellSafe formula-injection guard.
 * Run: npx jest src/payments-report/payments-report.service.spec.ts
 */
import { PaymentsReportService } from './payments-report.service';
import { PrismaService } from '../prisma/prisma.service';
import { startOfIstDay, endOfIstDay } from '../common/ist-date';
import * as XLSX from 'xlsx';

const mockPrisma = {
  creditPayoutEntry: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  salesUserAssignment: { findMany: jest.fn() },
  salesUser: { findMany: jest.fn() },
};

/** Read a built workbook Buffer back into per-sheet array-of-objects. */
function readWorkbook(buffer: Buffer): Record<string, Record<string, unknown>[]> {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const name of wb.SheetNames) out[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
  return out;
}

const OUTLET = {
  id: 'outlet-pk-1',
  clientId: 'deoleo',
  outletCode: 'OUT1',
  partnerId: 'p1',
  zone: 'West',
  state: 'MH',
  city: 'Pune',
  partner: {
    businessName: 'Shop One',
    ownerName: 'Owner One',
    phone: '9999999999',
    panNumber: 'ABCDE1234F',
    gstRegistrationType: 'REGULAR',
    entityType: 'INDIVIDUAL',
  },
};

/** A visibility (194C) entry and an incentive (tdsSection null) entry — proves cross-stream. */
function twoStreamEntries() {
  return [
    {
      id: 'e1',
      clientId: 'deoleo',
      outletId: 'OUT1', // the outlet CODE
      outletName: 'Shop 1',
      fieldName: 'Visibility',
      period: '2026-06',
      amountPaise: 500000n,
      narration: 'visibility payout',
      status: 'PAID',
      utr: 'UTR-1',
      paidAt: new Date('2026-06-15T00:00:00Z'),
      tdsSection: 'SEC_194C',
      tdsMethodology: 'GROSS_UP',
      tdsDeductedPaise: 0n,
      download: { downloadCode: 'PD-2026-06-001', groupType: 'SEPARATE' },
      autoInvoice: { invoiceNumber: 'INV-1' },
    },
    {
      id: 'e2',
      clientId: 'deoleo',
      outletId: 'OUT1',
      outletName: 'Shop 1',
      fieldName: 'Incentive',
      period: '2026-06',
      amountPaise: 250000n,
      narration: 'incentive payout',
      status: 'PAID',
      utr: 'UTR-2',
      paidAt: new Date('2026-06-16T00:00:00Z'),
      tdsSection: null, // INCENTIVE/standard stream — must NOT be excluded
      tdsMethodology: null,
      tdsDeductedPaise: 0n,
      download: { downloadCode: 'PD-2026-06-002', groupType: 'STANDARD' },
      autoInvoice: null,
    },
  ];
}

describe('PaymentsReportService', () => {
  let service: PaymentsReportService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PaymentsReportService(mockPrisma as unknown as PrismaService);
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]);
    mockPrisma.salesUser.findMany.mockResolvedValue([]);
  });

  describe('paymentReport — stream inclusion + where clause', () => {
    it('does NOT filter on tdsSection — both visibility and incentive streams are included', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue(twoStreamEntries());
      mockPrisma.outlet.findMany.mockResolvedValue([OUTLET]);

      const res = await service.paymentReport({ clientId: 'deoleo' });

      const call = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0];
      expect(call.where).not.toHaveProperty('tdsSection'); // the whole point of this report
      expect(call.where.paidAt).toEqual({ not: null }); // paid entries only, no range given
      expect(call.where.clientId).toBe('deoleo');

      expect(res.count).toBe(2);
      expect(res.rows.map((r) => r.payoutField)).toEqual(['Visibility', 'Incentive']);
      // the incentive row (tdsSection null) survived
      expect(res.rows[1].tdsSection).toBeNull();
      expect(res.totals.amount).toEqual({ paise: '750000', inr: 7500 });
    });

    it('applies the paidAt [from,to] range as a FULL INCLUSIVE IST day, keeping the not-null floor', async () => {
      await service.paymentReport({ clientId: 'deoleo', from: '2026-06-01', to: '2026-06-30' });
      const call = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0];
      // date-only bounds → start-of-IST-day(from) .. end-of-IST-day(to) so same-day payments
      // (paid after 05:30 IST) are not dropped (istDayRangeFilter — the shared date-range fix).
      expect(call.where.paidAt).toEqual({
        not: null,
        gte: startOfIstDay(new Date('2026-06-01')),
        lte: endOfIstDay(new Date('2026-06-30')),
      });
      // the inclusive upper bound must be LATER than the naive midnight parse (the bug we fixed).
      expect(call.where.paidAt.lte.getTime()).toBeGreaterThan(new Date('2026-06-30').getTime());
    });

    it('applies the optional status filter', async () => {
      await service.paymentReport({ clientId: 'deoleo', status: 'FAILED' as never });
      const call = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0];
      expect(call.where.status).toBe('FAILED');
    });

    it('platform-wide scope (no clientId) does not pin the query to a tenant', async () => {
      await service.paymentReport({});
      const call = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ paidAt: { not: null } });
    });

    it('platform-wide: a shared outletCode across tenants enriches each row from its OWN tenant', async () => {
      const baseEntry = {
        fieldName: 'Visibility', period: '2026-06', amountPaise: 100000n, narration: '',
        status: 'PAID', utr: 'U', paidAt: new Date('2026-06-15T00:00:00Z'),
        tdsSection: null, tdsMethodology: null, tdsDeductedPaise: 0n, download: null, autoInvoice: null,
      };
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { ...baseEntry, id: 'a', clientId: 'deoleo', outletId: 'OUT1', outletName: 'D' },
        { ...baseEntry, id: 'b', clientId: 'tenantB', outletId: 'OUT1', outletName: 'B' },
      ]);
      const mk = (clientId: string, tag: string, zone: string) => ({
        id: `o-${tag}`, clientId, outletCode: 'OUT1', partnerId: `p-${tag}`, zone, state: tag, city: tag,
        partner: { businessName: `${tag}Shop`, ownerName: `${tag}Owner`, phone: tag, panNumber: tag, gstRegistrationType: 'REGULAR', entityType: 'INDIVIDUAL' },
      });
      mockPrisma.outlet.findMany.mockResolvedValue([mk('deoleo', 'D', 'West'), mk('tenantB', 'B', 'South')]);
      const res = await service.paymentReport({}); // platform-wide (un-assumed GIFSY)
      const byClient = Object.fromEntries(res.rows.map((r) => [r.clientId, r]));
      // Each row must enrich from its OWN tenant's outlet — the composite clientId|outletCode key
      // prevents tenant B's zone/partner/PAN from bleeding onto tenant A's same-code row.
      expect(byClient['deoleo'].zone).toBe('West');
      expect(byClient['deoleo'].businessName).toBe('DShop');
      expect(byClient['deoleo'].panNumber).toBe('D');
      expect(byClient['tenantB'].zone).toBe('South');
      expect(byClient['tenantB'].businessName).toBe('BShop');
      expect(byClient['tenantB'].panNumber).toBe('B');
    });

    it('caps at MAX_ROWS and flags truncated (take = MAX_ROWS + 1)', async () => {
      const one = {
        clientId: 'deoleo', outletId: 'OUT1', outletName: 'S', fieldName: 'F', period: '2026-06',
        amountPaise: 100n, narration: '', status: 'PAID', utr: 'U', paidAt: new Date('2026-06-15T00:00:00Z'),
        tdsSection: null, tdsMethodology: null, tdsDeductedPaise: 0n, download: null, autoInvoice: null,
      };
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue(
        Array.from({ length: 10001 }, (_, i) => ({ ...one, id: `e${i}` })),
      );
      mockPrisma.outlet.findMany.mockResolvedValue([OUTLET]);
      const res = await service.paymentReport({ clientId: 'deoleo' });
      expect(res.truncated).toBe(true);
      expect(res.count).toBe(10000);
      expect(mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0].take).toBe(10001);
    });

    it('picks the latest active assignment (orderBy assignedAt desc)', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue(twoStreamEntries());
      mockPrisma.outlet.findMany.mockResolvedValue([OUTLET]);
      await service.paymentReport({ clientId: 'deoleo' });
      const call = mockPrisma.salesUserAssignment.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ outletId: { in: ['outlet-pk-1'] }, unassignedAt: null });
      expect(call.orderBy).toEqual({ assignedAt: 'desc' });
    });
  });

  describe('enrichment + sales reporting chain', () => {
    it('joins outlet geo + partner, builds the rep code/name/role and full reporting chain', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([twoStreamEntries()[0]]);
      mockPrisma.outlet.findMany.mockResolvedValue([OUTLET]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { outletId: 'outlet-pk-1', salesUserId: 'su-rep' },
      ]);
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'su-rep', reportingToId: 'su-mgr', employeeCode: 'XSR-M001', isActive: true, user: { name: 'Rep Name' }, hierarchyLevel: { code: 'XSR-M' } },
        { id: 'su-mgr', reportingToId: 'su-head', employeeCode: 'ASM-002', isActive: true, user: { name: 'Mgr' }, hierarchyLevel: { code: 'ASM' } },
        { id: 'su-head', reportingToId: null, employeeCode: 'RSM-003', isActive: true, user: { name: 'Head' }, hierarchyLevel: { code: 'RSM' } },
      ]);

      const res = await service.paymentReport({ clientId: 'deoleo' });
      const row = res.rows[0];

      expect(row.zone).toBe('West');
      expect(row.state).toBe('MH');
      expect(row.city).toBe('Pune');
      expect(row.businessName).toBe('Shop One');
      expect(row.ownerName).toBe('Owner One');
      expect(row.phone).toBe('9999999999');
      expect(row.panNumber).toBe('ABCDE1234F');
      expect(row.gstRegistrationType).toBe('REGULAR');
      expect(row.salesRepCode).toBe('XSR-M001');
      expect(row.salesRepName).toBe('Rep Name');
      expect(row.salesRepRole).toBe('XSR-M');
      expect(row.reportingChain).toBe('XSR-M001 (Rep Name) → ASM-002 (Mgr) → RSM-003 (Head)');
      expect(row.payoutHeader).toBe('PD-2026-06-001');
      expect(row.groupType).toBe('SEPARATE');
      expect(row.paymentDate).toBe('2026-06-15T00:00:00.000Z');
      expect(row.amount).toEqual({ paise: '500000', inr: 5000 });
      expect(row.utr).toBe('UTR-1');
      expect(row.invoiceNumber).toBe('INV-1');
      expect(() => JSON.stringify(res)).not.toThrow();
    });

    it('reporting-chain up-walk is cycle-safe (a loop terminates, no infinite spin)', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([twoStreamEntries()[0]]);
      mockPrisma.outlet.findMany.mockResolvedValue([OUTLET]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { outletId: 'outlet-pk-1', salesUserId: 'su-a' },
      ]);
      // su-a → su-b → su-a (cycle)
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'su-a', reportingToId: 'su-b', employeeCode: 'A-1', isActive: true, user: { name: 'A' }, hierarchyLevel: { code: 'A' } },
        { id: 'su-b', reportingToId: 'su-a', employeeCode: 'B-2', isActive: true, user: { name: 'B' }, hierarchyLevel: { code: 'B' } },
      ]);

      const res = await service.paymentReport({ clientId: 'deoleo' });
      expect(res.rows[0].reportingChain).toBe('A-1 (A) → B-2 (B)'); // stops at the repeat
    });

    it('leaves sales fields null when the outlet has no active assignment', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([twoStreamEntries()[0]]);
      mockPrisma.outlet.findMany.mockResolvedValue([OUTLET]);
      // no assignments, no sales users
      const res = await service.paymentReport({ clientId: 'deoleo' });
      expect(res.rows[0].salesRepCode).toBeNull();
      expect(res.rows[0].reportingChain).toBeNull();
    });
  });

  describe('batching — no N+1', () => {
    it('makes exactly ONE findMany per entity regardless of row count', async () => {
      // two entries for the SAME outlet — a naive impl would re-query per row.
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue(twoStreamEntries());
      mockPrisma.outlet.findMany.mockResolvedValue([OUTLET]);
      mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
        { outletId: 'outlet-pk-1', salesUserId: 'su-rep' },
      ]);
      mockPrisma.salesUser.findMany.mockResolvedValue([
        { id: 'su-rep', reportingToId: null, employeeCode: 'XSR-M001', isActive: true, user: { name: 'Rep' }, hierarchyLevel: { code: 'XSR-M' } },
      ]);

      await service.paymentReport({ clientId: 'deoleo' });

      expect(mockPrisma.creditPayoutEntry.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.outlet.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.salesUserAssignment.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.salesUser.findMany).toHaveBeenCalledTimes(1);
    });

    it('skips the downstream queries entirely when there are no entries', async () => {
      const res = await service.paymentReport({ clientId: 'deoleo' });
      expect(res.count).toBe(0);
      expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.salesUserAssignment.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.salesUser.findMany).not.toHaveBeenCalled();
    });
  });

  describe('paymentReportXlsx', () => {
    it('emits Payments + Summary sheets and escapes a formula-injection cell', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        {
          ...twoStreamEntries()[0],
          outletId: '=HYPERLINK("evil")',
          outletName: '=cmd()|calc',
          narration: '@SUM(A1)',
        },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([]); // no enrichment; focus on the cell guard

      const { buffer, filename } = await service.paymentReportXlsx({ clientId: 'deoleo' });
      expect(filename).toBe('payments-report-deoleo.xlsx');

      const wb = readWorkbook(buffer);
      expect(Object.keys(wb)).toEqual(['Payments', 'Summary']);
      const row = wb['Payments'][0];
      expect(String(row['Outlet Code'])).toBe("'=HYPERLINK(\"evil\")");
      expect(String(row['Outlet Name'])).toBe("'=cmd()|calc");
      expect(String(row['Remarks'])).toBe("'@SUM(A1)");
      expect(wb['Summary'][0]).toEqual({ Metric: 'Rows', Value: 1 });
    });

    it('platform-wide export filename is "all"', async () => {
      const { filename } = await service.paymentReportXlsx({});
      expect(filename).toBe('payments-report-all.xlsx');
    });
  });
});
