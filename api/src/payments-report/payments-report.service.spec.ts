/**
 * Unit tests for PaymentsReportService — READ-ONLY cross-stream payments report. Mock Prisma, no I/O.
 * Covers: ALL streams included (NO tdsSection filter in the where); paidAt not-null + [from,to]
 * range; optional status filter; batched lookups (findMany call counts — no N+1); the sales chain
 * built from the assignment + reportingTo up-walk (cycle-safe); BigInt → {paise,inr} serialisation; server-side
 * PAGING (page/pageSize, total order with an id tiebreak) with WHOLE-RANGE totals from a DB aggregate.
 * Run: npx jest src/payments-report/payments-report.service.spec.ts
 */
import { PaymentsReportService } from './payments-report.service';
import { PrismaService } from '../prisma/prisma.service';
import { startOfIstDay, endOfIstDay } from '../common/ist-date';

const mockPrisma: Record<string, unknown> & {
  creditPayoutEntry: { findMany: jest.Mock; aggregate: jest.Mock };
  outlet: { findMany: jest.Mock };
  salesUserAssignment: { findMany: jest.Mock };
  salesUser: { findMany: jest.Mock };
  $transaction: jest.Mock;
} = {
  creditPayoutEntry: { findMany: jest.fn(), aggregate: jest.fn() },
  outlet: { findMany: jest.fn() },
  salesUserAssignment: { findMany: jest.fn() },
  salesUser: { findMany: jest.fn() },
  // Interactive transaction: run the callback against the same mock delegates.
  $transaction: jest.fn(),
};

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
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockPrisma));
    mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([]);
    mockPrisma.creditPayoutEntry.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { amountPaise: null, tdsDeductedPaise: null } });
    mockPrisma.outlet.findMany.mockResolvedValue([]);
    mockPrisma.salesUserAssignment.findMany.mockResolvedValue([]);
    mockPrisma.salesUser.findMany.mockResolvedValue([]);
  });

  describe('paymentReport — stream inclusion + where clause', () => {
    it('does NOT filter on tdsSection — both visibility and incentive streams are included', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue(twoStreamEntries());
      mockPrisma.creditPayoutEntry.aggregate.mockResolvedValue({ _count: { _all: 2 }, _sum: { amountPaise: 750000n, tdsDeductedPaise: 0n } });
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

    it('a NON-PAID status (FAILED) DROPS the paidAt not-null floor and orders by attemptedAt desc (nulls last)', async () => {
      // A FAILED entry (bank-rejected) has paidAt null; forcing paidAt not-null would hide it. The
      // status filter therefore relaxes the floor and orders by the uploaded failure date newest-first.
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        {
          id: 'f1', clientId: 'deoleo', outletId: 'OUT1', outletName: 'Shop 1', fieldName: 'Incentive',
          period: '2026-06', amountPaise: 300000n, narration: 'incentive payout', status: 'FAILED',
          utr: 'UTR-FAIL', paidAt: null, attemptedAt: new Date('2026-06-20T00:00:00Z'),
          failureReason: 'Account Closed', tdsSection: null, tdsMethodology: null, tdsDeductedPaise: 0n,
          download: null, autoInvoice: null,
        },
      ]);
      mockPrisma.outlet.findMany.mockResolvedValue([OUTLET]);

      mockPrisma.creditPayoutEntry.aggregate.mockResolvedValue({ _count: { _all: 1 }, _sum: { amountPaise: 300000n, tdsDeductedPaise: 0n } });

      const res = await service.paymentReport({ clientId: 'deoleo', status: 'FAILED' as never });
      const call = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0];
      expect(call.where.status).toBe('FAILED');
      expect(call.where).not.toHaveProperty('paidAt'); // the not-null floor is dropped for FAILED
      expect(call.where.clientId).toBe('deoleo'); // tenant scope intact
      expect(call.orderBy).toEqual([
        { attemptedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'desc' }, // total order → stable OFFSET pages, identical to the export
      ]);

      // The FAILED row surfaces: its reason + the attempt date as the display date (paidAt ?? attemptedAt).
      expect(res.count).toBe(1);
      expect(res.rows[0].status).toBe('FAILED');
      expect(res.rows[0].failureReason).toBe('Account Closed');
      expect(res.rows[0].paymentDate).toBe('2026-06-20T00:00:00.000Z'); // from attemptedAt (paidAt null)
      expect(res.rows[0].utr).toBe('UTR-FAIL'); // uploaded reference kept
    });

    it('a NON-PAID status + date range bounds attemptedAt (FAILED rows have no paidAt to range on)', async () => {
      await service.paymentReport({ clientId: 'deoleo', status: 'FAILED' as never, from: '2026-06-01', to: '2026-06-30' });
      const call = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0];
      expect(call.where).not.toHaveProperty('paidAt');
      expect(call.where.attemptedAt).toEqual({
        gte: startOfIstDay(new Date('2026-06-01')),
        lte: endOfIstDay(new Date('2026-06-30')),
      });
    });

    it('status=PAID KEEPS the paidAt not-null floor + the paidAt-desc order (byte-identical default)', async () => {
      await service.paymentReport({ clientId: 'deoleo', status: 'PAID' as never });
      const call = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0];
      expect(call.where.status).toBe('PAID');
      expect(call.where.paidAt).toEqual({ not: null });
      expect(call.orderBy).toEqual([{ paidAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('the default (no status) path is byte-identical: paidAt floor + paidAt-desc order', async () => {
      await service.paymentReport({ clientId: 'deoleo' });
      const call = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0];
      expect(call.where.paidAt).toEqual({ not: null });
      expect(call.where).not.toHaveProperty('attemptedAt');
      expect(call.orderBy).toEqual([{ paidAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
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

    it('NO cap / truncated flag: the envelope is a page + whole-range totals', async () => {
      const res = await service.paymentReport({ clientId: 'deoleo' });
      expect(res).not.toHaveProperty('truncated');
      expect(res).not.toHaveProperty('maxRows');
      expect(res).toMatchObject({ page: 1, pageSize: 50, totalRows: 0, totalPages: 0, count: 0 });
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

  describe('server-side paging + whole-range DB totals', () => {
    function entries(n: number, start = 0) {
      return Array.from({ length: n }, (_, i) => ({
        ...twoStreamEntries()[0],
        id: `e${start + i}`,
        amountPaise: 100n,
      }));
    }

    it('defaults to page 1 × 50: skip 0, take 50 — never more than one page of entries is loaded', async () => {
      await service.paymentReport({ clientId: 'deoleo' });
      const call = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0];
      expect(call.skip).toBe(0);
      expect(call.take).toBe(50);
    });

    it('page N → skip (N−1)·pageSize; pageSize is clamped to 1..200', async () => {
      mockPrisma.creditPayoutEntry.aggregate.mockResolvedValue({ _count: { _all: 100_000 }, _sum: { amountPaise: 1n, tdsDeductedPaise: 0n } });
      await service.paymentReport({ clientId: 'deoleo', page: 3, pageSize: 100 });
      expect(mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0]).toMatchObject({ skip: 200, take: 100 });
      await service.paymentReport({ clientId: 'deoleo', page: 2, pageSize: 5000 });
      expect(mockPrisma.creditPayoutEntry.findMany.mock.calls[1][0]).toMatchObject({ skip: 200, take: 200 });
      await service.paymentReport({ clientId: 'deoleo', page: 0, pageSize: 0 });
      expect(mockPrisma.creditPayoutEntry.findMany.mock.calls[2][0]).toMatchObject({ skip: 0, take: 1 });
    });

    it('totals come from ONE aggregate over the SAME where (all matching rows), not from the page', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue(entries(50, 50)); // page 2: 50 rows × ₹1
      mockPrisma.creditPayoutEntry.aggregate.mockResolvedValue({
        _count: { _all: 48_086 },
        _sum: { amountPaise: 28_900_000_000n, tdsDeductedPaise: 123_456n },
      });
      const res = await service.paymentReport({ clientId: 'deoleo', from: '2026-01-01', to: '2026-06-30', page: 2 });
      const agg = mockPrisma.creditPayoutEntry.aggregate.mock.calls[0][0];
      const find = mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0];
      expect(agg.where).toEqual(find.where); // identical filter → totals are for exactly the paged set
      expect(agg).toMatchObject({ _count: { _all: true }, _sum: { amountPaise: true, tdsDeductedPaise: true } });
      expect(agg).not.toHaveProperty('take');
      expect(agg).not.toHaveProperty('skip');
      expect(res.rows).toHaveLength(50);
      expect(res).toMatchObject({ page: 2, pageSize: 50, totalRows: 48_086, totalPages: 962, count: 48_086 });
      expect(res.totals).toEqual({
        count: 48_086,
        amount: { paise: '28900000000', inr: 289_000_000 },
        tdsDeducted: { paise: '123456', inr: 1234.56 },
      });
    });

    it('a page past the end is CLAMPED to the last page (never an empty page with non-zero totals)', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue(entries(10, 100));
      mockPrisma.creditPayoutEntry.aggregate.mockResolvedValue({ _count: { _all: 110 }, _sum: { amountPaise: 11000n, tdsDeductedPaise: 0n } });
      const res = await service.paymentReport({ clientId: 'deoleo', page: 9, pageSize: 50 });
      expect(mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0]).toMatchObject({ skip: 100, take: 50 }); // page 3 = last
      expect(res).toMatchObject({ page: 3, totalPages: 3, totalRows: 110 });
      expect(res.rows).toHaveLength(10);
    });

    it('an empty range returns page 1 of 0 with zero totals', async () => {
      const res = await service.paymentReport({ clientId: 'deoleo', page: 5 });
      expect(mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0]).toMatchObject({ skip: 0 });
      expect(res).toMatchObject({ page: 1, totalPages: 0, totalRows: 0, rows: [] });
      expect(res.totals.amount).toEqual({ paise: '0', inr: 0 });
    });

    it('the totals and the page are read in ONE REPEATABLE READ transaction (cards and pager always agree)', async () => {
      const order: string[] = [];
      const tx = {
        creditPayoutEntry: {
          aggregate: jest.fn(async () => {
            order.push('aggregate');
            return { _count: { _all: 2 }, _sum: { amountPaise: 750000n, tdsDeductedPaise: 0n } };
          }),
          findMany: jest.fn(async () => {
            order.push('findMany');
            return twoStreamEntries();
          }),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
      mockPrisma.outlet.findMany.mockResolvedValue([OUTLET]);
      const res = await service.paymentReport({ clientId: 'deoleo' });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(order).toEqual(['aggregate', 'findMany']); // both inside the snapshot
      expect(mockPrisma.creditPayoutEntry.findMany).not.toHaveBeenCalled(); // never outside it
      expect(mockPrisma.creditPayoutEntry.aggregate).not.toHaveBeenCalled();
      expect(res.totals.count).toBe(res.totalRows);
      expect(res.rows).toHaveLength(2);
    });

    it('joins outlets for THIS PAGE only (outlet lookup sized by the page, not the range)', async () => {
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue(entries(3));
      mockPrisma.creditPayoutEntry.aggregate.mockResolvedValue({ _count: { _all: 48_086 }, _sum: { amountPaise: 1n, tdsDeductedPaise: 0n } });
      await service.paymentReport({ clientId: 'deoleo', pageSize: 3 });
      expect(mockPrisma.outlet.findMany.mock.calls[0][0].where.outletCode.in).toEqual(['OUT1']);
    });
  });

  describe('fix round B (L1) — reversal / TDS-credit marks on a row', () => {
    it('a reversed PAID entry is marked (owed back + TDS credit); TDS lowered by a credit is explained; other rows unchanged', async () => {
      const [e1, e2] = twoStreamEntries();
      mockPrisma.creditPayoutEntry.findMany.mockResolvedValue([
        { ...e1, tdsBaseReversedAt: new Date('2026-11-16T05:00:00Z'), reversalAllocations: [{ receivablePaise: 495000n, tdsCreditPaise: 5000n }], tdsCreditApplications: [] },
        { ...e2, tdsBaseReversedAt: null, reversalAllocations: [], tdsCreditApplications: [{ amountPaise: 2500n, tdsCredit: { clientId: 'bajaj' } }] },
        { ...e2, id: 'e3', tdsBaseReversedAt: null, reversalAllocations: [], tdsCreditApplications: [] },
      ]);
      mockPrisma.creditPayoutEntry.aggregate.mockResolvedValue({ _count: { _all: 3 }, _sum: { amountPaise: 1000000n, tdsDeductedPaise: 0n } });
      const res = await service.paymentReport({ clientId: 'deoleo' });
      // still ONE page query (the marks ride on it)
      expect(mockPrisma.creditPayoutEntry.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.creditPayoutEntry.findMany.mock.calls[0][0].select).toMatchObject({ tdsBaseReversedAt: true });
      expect(res.rows[0].reversal).toEqual({
        receivablePaise: 495000, tdsCreditPaise: 5000, reversedAt: '2026-11-16T05:00:00.000Z',
        note: 'Reversed on 16 Nov 2026 — ₹4,950.00 owed back (receivable); ₹50.00 TDS credit carried forward',
      });
      expect(res.rows[1]).toMatchObject({ tdsCreditPaise: 2500, tdsNote: 'TDS lowered by ₹25.00 adjusted from earlier TDS credit (₹25.00 from another programme)' });
      expect(res.rows[2]).not.toHaveProperty('reversal');
      expect(res.rows[2]).not.toHaveProperty('tdsNote');
    });
  });
});
