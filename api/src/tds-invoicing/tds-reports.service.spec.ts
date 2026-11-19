/**
 * Unit tests for TdsReportsService — Wave 1 Stream C (§6). Mock Prisma, no I/O.
 * Covers: payout report (GST reg type + frozen TDS treatment, BigInt serialisation, tenant
 * scoping), unregistered/RCM report (filters to UNREGISTERED partners), recovery report shape.
 * Run: npx jest src/tds-invoicing/tds-reports.service.spec.ts
 */
import { TdsReportsService } from './tds-reports.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  creditPayoutEntry: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  autoInvoice: { findMany: jest.fn() },
  channelPartner: { findMany: jest.fn() },
  tdsRecoveryEntry: { findMany: jest.fn() },
  tdsCredit: { findMany: jest.fn().mockResolvedValue([]) },
};

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
    // The xlsx export (incl. the cellSafe guard) is the 'tds-payouts' export kind — exports/kinds/batch2/tds-payouts.kind.spec.ts.

    it('policy round B: TDS credits created / applied / outstanding (tenant + FY of the period), JSON-safe', async () => {
      mockPrisma.tdsCredit.findMany.mockResolvedValueOnce([
        {
          id: 'c1', clientId: 'bajaj', panNumber: 'ABCDE1234F', section: 'SEC_194C', fyLabel: '2026-27',
          amountPaise: 40000n, appliedPaise: 31000n, createdAt: new Date('2026-11-10T00:00:00Z'), creditReversalId: 'r1',
          sourcePayoutEntry: { id: 'va', outletId: 'O1', outletName: 'Shop 1', period: '2026-10', amountPaise: 4000000n },
          applications: [
            { id: 'a1', amountPaise: 31000n, createdAt: new Date('2026-11-12T00:00:00Z'), releasedAt: null, releaseReason: null, downloadId: 'd1', payoutEntry: { id: 'vb', outletId: 'O1', outletName: 'Shop 1', period: '2026-11' } },
            { id: 'a0', amountPaise: 9000n, createdAt: new Date('2026-11-11T00:00:00Z'), releasedAt: new Date('2026-11-11T05:00:00Z'), releaseReason: 'PAYOUT_FAILED', downloadId: 'd0', payoutEntry: { id: 'vz', outletId: 'O1', outletName: 'Shop 1', period: '2026-11' } },
          ],
        },
      ]);
      const res = await service.payoutReport({ clientId: 'bajaj', period: '2026-11' });
      expect(mockPrisma.tdsCredit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { clientId: 'bajaj', fyLabel: '2026-27' } }),
      );
      expect(res.tdsCredits.totals).toEqual({
        created: { paise: '40000', inr: 400 },
        applied: { paise: '31000', inr: 310 },
        outstanding: { paise: '9000', inr: 90 },
      });
      expect(res.tdsCredits.rows[0]).toMatchObject({ sourceEntryId: 'va', outstanding: { paise: '9000', inr: 90 } });
      expect(res.tdsCredits.rows[0].applications.map((a) => [a.entryId, a.released, a.releaseReason])).toEqual([
        ['vb', false, null],
        ['vz', true, 'PAYOUT_FAILED'],
      ]);
      expect(() => JSON.stringify(res)).not.toThrow();
    });

    it('policy round B: no credits → an empty section (count 0)', async () => {
      const res = await service.payoutReport({ clientId: 'deoleo' });
      expect(res.tdsCredits).toEqual({
        count: 0,
        totals: { created: { paise: '0', inr: 0 }, applied: { paise: '0', inr: 0 }, outstanding: { paise: '0', inr: 0 } },
        rows: [],
      });
    });
  });

  describe('fix round B — TDS credits panel + row call-outs', () => {
    const credit = (id: string, extra: Record<string, unknown> = {}) => ({
      id, clientId: 'bajaj', panNumber: 'ABCDE1234F', section: 'SEC_194C', fyLabel: '2025-26',
      amountPaise: 40000n, appliedPaise: 10000n, createdAt: new Date('2026-01-10T00:00:00Z'), creditReversalId: 'r1',
      sourcePayoutEntry: { id: `src-${id}`, outletId: 'O1', outletName: 'Shop 1', period: '2025-12', amountPaise: 4000000n },
      applications: [],
      ...extra,
    });

    it('scope (L2), unused-at-FY-end (D2), previous PAN (L6), tenant name, another-programme use masked in a tenant view, server paging', async () => {
      const db = {
        tdsCredit: { findMany: jest.fn().mockResolvedValue([
          credit('c1', {
            applications: [
              { id: 'a1', amountPaise: 10000n, createdAt: new Date('2026-02-01T00:00:00Z'), releasedAt: null, releaseReason: null, downloadId: 'dX', clientId: 'deoleo', payoutEntry: { id: 'deo-e', outletId: 'D9', outletName: 'Deo shop', period: '2026-01' } },
            ],
          }),
          credit('c2'),
          credit('c3'),
        ]) },
        client: { findMany: jest.fn().mockResolvedValue([{ id: 'bajaj', internalName: 'Bajaj Consumer Care' }]) },
        outlet: { findMany: jest.fn().mockResolvedValue([{ clientId: 'bajaj', outletCode: 'O1', partner: { panNumber: 'ZZZZZ9999Z' } }]) },
      };
      const res = await service.tdsCreditSection(db as never, { clientId: 'bajaj' }, { page: 1, limit: 2 });
      expect(res.count).toBe(3);
      expect(res.pagination).toEqual({ page: 1, limit: 2, total: 3, pages: 2 });
      expect(res.rows).toHaveLength(2);
      expect(res.totals.outstanding).toEqual({ paise: '90000', inr: 900 }); // totals over every credit, not the page
      const r = res.rows[0];
      expect(r).toMatchObject({
        clientName: 'Bajaj Consumer Care',
        panMasked: 'XXXXX1234F',
        scopeNote: 'Scoped to FY 2025-26 · 194C · usable by any programme on this PAN (Gifsy is the deductor)',
        unusedNote: '₹300.00 unused credit for FY 2025-26, not carried forward — the retailer can claim it in their return for that year',
        previousPanNote: "Credit on previous PAN XXXXX1234F — not applied automatically (the retailer's PAN is now XXXXX9999Z); settle it off-platform",
      });
      expect(r.applications[0]).toMatchObject({
        otherProgramme: true, entryId: null, outletCode: null, outletName: null, downloadId: null,
        note: "₹100.00 adjusted against the TDS of another programme's payout on this PAN (194C)",
      });
      expect(res.notes).toEqual([
        '2 credits on this page unused when the FY closed — not carried forward to the next FY.',
        "2 credits are on a retailer's previous PAN — not applied automatically.",
      ]);
      const p2 = await service.tdsCreditSection(db as never, { clientId: 'bajaj' }, { page: 2, limit: 2 });
      expect(p2.rows.map((x) => x.creditId)).toEqual(['c3']);
    });

    it('rows: reversed PAID payout + TDS lowered by a credit (own / another programme) are said on the row; others untouched', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        {
          id: 'e1', clientId: 'bajaj', outletId: 'O1', outletName: 'Shop 1', fieldName: 'Visibility', period: '2026-10',
          amountPaise: 4000000n, tdsSection: 'SEC_194C', tdsMethodology: 'DEDUCT', tdsDeductedPaise: 40000n, autoInvoiceId: null, autoInvoice: null,
          downloadId: null, tdsBaseReversedAt: new Date('2026-11-16T05:00:00Z'),
          reversalAllocations: [{ receivablePaise: 3960000n, tdsCreditPaise: 40000n }], tdsCreditApplications: [],
        },
        {
          id: 'e2', clientId: 'bajaj', outletId: 'O1', outletName: 'Shop 1', fieldName: 'Visibility', period: '2026-11',
          amountPaise: 5000000n, tdsSection: 'SEC_194C', tdsMethodology: 'DEDUCT', tdsDeductedPaise: 0n, autoInvoiceId: null, autoInvoice: null,
          downloadId: null, tdsBaseReversedAt: null, reversalAllocations: [],
          tdsCreditApplications: [
            { amountPaise: 30000n, tdsCredit: { clientId: 'bajaj' } },
            { amountPaise: 20000n, tdsCredit: { clientId: 'deoleo' } },
          ],
        },
        {
          id: 'e3', clientId: 'bajaj', outletId: 'O1', outletName: 'Shop 1', fieldName: 'Visibility', period: '2026-11',
          amountPaise: 100n, tdsSection: 'SEC_194C', tdsMethodology: 'DEDUCT', tdsDeductedPaise: 0n, autoInvoiceId: null, autoInvoice: null,
          downloadId: null, tdsBaseReversedAt: null, reversalAllocations: [], tdsCreditApplications: [],
        },
      ]);
      const res = await service.payoutReport({ clientId: 'bajaj' });
      expect(res.rows[0].reversedNote).toBe(
        "₹40,000.00 reversed on 16 Nov 2026 — off the PAN's TDS base; ₹39,600.00 owed back (receivable); ₹400.00 TDS credit",
      );
      expect(res.rows[1]).toMatchObject({
        tdsCreditAppliedPaise: 50000,
        tdsNote: 'TDS lowered: ₹300.00 adjusted from earlier TDS credit · ₹200.00 adjusted from earlier TDS credit (another programme)',
      });
      expect(res.rows[2]).not.toHaveProperty('reversedNote');
      expect(res.rows[2]).not.toHaveProperty('tdsNote');
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
