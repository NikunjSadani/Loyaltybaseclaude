import { BadRequestException } from '@nestjs/common';
import type { XlsxStreamWriter } from '../../../common/xlsx-stream';
import { buildXlsx } from '../../../common/xlsx';
import { istDateKey } from '../../../common/ist-date';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { PaymentsReportService, type PaymentsReportScope } from '../../../payments-report/payments-report.service';
import { PAYMENTS_REPORT_KIND } from './payments-report.kind';
import { ctxFor, expectSameWorkbook, fakeModel, maxPage, readBook, renderKind } from './parity.support-spec';

type Row = Record<string, unknown>;
const CLIENT = { sub: 'c', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' } as JwtPayload;
const GIFSY = { sub: 'g', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' } as JwtPayload;

/**
 * REFERENCE: what the SCREEN shows for the same filters, page by page (PaymentsReportService.paymentReport at the max
 * page size, every page concatenated) laid out as the old in-memory download did. The export must equal it cell for
 * cell — same rows, same order across page boundaries, and a Summary equal to the screen's whole-range totals.
 */
async function screenDownload(prisma: unknown, scope: PaymentsReportScope): Promise<Buffer> {
  const svc = new PaymentsReportService(prisma as never);
  type Page = Awaited<ReturnType<PaymentsReportService['paymentReport']>>;
  const rows: Page['rows'] = [];
  let first: Page | null = null;
  for (let page = 1; ; page++) {
    const r = await svc.paymentReport({ ...scope, page, pageSize: 200 });
    first ??= r;
    rows.push(...r.rows);
    if (page >= r.totalPages) break;
  }
  const report = first!;
  expect(rows).toHaveLength(report.totalRows); // the screen's pages cover the range exactly
  const sheetRows = rows.map((r, i) => ({
    'S.No': i + 1,
    'Client': r.clientId,
    'Payment Date': r.paymentDate ? istDateKey(new Date(r.paymentDate)) : '',
    'Outlet Code': r.outletCode ?? '',
    'Outlet Name': r.outletName,
    'Business Name': r.businessName ?? '',
    'Owner Name': r.ownerName ?? '',
    'Zone': r.zone ?? '',
    'State': r.state ?? '',
    'City': r.city ?? '',
    'Sales Rep Code': r.salesRepCode ?? '',
    'Sales Rep Name': r.salesRepName ?? '',
    'Sales Rep Role': r.salesRepRole ?? '',
    'Reporting Chain': r.reportingChain ?? '',
    'Amount (₹)': r.amount.inr,
    'UTR': r.utr ?? '',
    'Status': r.status,
    'Payout Header': r.payoutHeader ?? '',
    'Group Type': r.groupType ?? '',
    'Payout Field': r.payoutField,
    'Remarks': r.remarks ?? '',
    'Failure Reason': r.failureReason ?? '',
    'Period': r.period,
    'TDS Section': r.tdsSection ?? '',
    'TDS Methodology': r.tdsMethodology ?? '',
    'TDS Deducted (₹)': r.tdsDeducted.inr,
    'Invoice No.': r.invoiceNumber ?? '',
    'GST Reg Type': r.gstRegistrationType ?? '',
    'PAN': r.panNumber ?? '',
    'Phone': r.phone ?? '',
  }));
  const summaryRows = [
    { Metric: 'Rows', Value: report.totals.count },
    { Metric: 'Total Amount (₹)', Value: report.totals.amount.inr },
    { Metric: 'Total TDS Deducted (₹)', Value: report.totals.tdsDeducted.inr },
  ];
  return buildXlsx([
    { name: 'Payments', rows: sheetRows },
    { name: 'Summary', rows: summaryRows },
  ]);
}

const BASE = Date.UTC(2026, 5, 1);
/** Real exceljs build + SheetJS read-backs: explicit headroom for a loaded full-suite run (alone: well under 1 s). */
const XLSX_TIMEOUT = 30_000;

function entry(i: number, over: Row = {}): Row {
  const paid = i % 7 !== 0;
  return {
    id: `e${String(i).padStart(6, '0')}`,
    clientId: 'bajaj',
    outletId: `O${i % 40}`,
    outletName: i === 5 ? '=cmd()' : `Shop ${i}`,
    fieldName: i % 2 ? 'Visibility' : 'Incentive',
    period: '2026-06',
    amountPaise: BigInt(10_000 + i),
    narration: i % 3 ? `note ${i}` : null,
    status: paid ? 'PAID' : 'FAILED',
    utr: paid ? `UTR${i}` : null,
    // Unique instants here (the tie test below forces ties). 18:45 UTC → next IST day.
    paidAt: paid ? new Date(BASE + i * 3_600_000 + 67_500_000) : null,
    attemptedAt: paid ? null : i % 2 ? new Date(BASE + i * 3_600_000) : null,
    failureReason: paid ? null : 'Bank rejected',
    tdsSection: i % 2 ? 'SEC_194C' : null,
    tdsMethodology: i % 2 ? 'DEDUCT' : null,
    tdsDeductedPaise: BigInt(i),
    createdAt: new Date(BASE + i * 1000),
    download: i % 4 ? { downloadCode: `PD-${i % 4}`, groupType: 'SEPARATE' } : null,
    autoInvoice: i % 5 ? { invoiceNumber: `INV-${i}` } : null,
    ...over,
  };
}

function world(n: number, extra: Row[] = []) {
  const outlets: Row[] = [];
  const assignments: Row[] = [];
  const users: Row[] = [
    { id: 'nsm', clientId: 'bajaj', reportingToId: null, employeeCode: 'NSM-1', user: { name: 'Nat' }, hierarchyLevel: { code: 'NSM' } },
    { id: 'asm', clientId: 'bajaj', reportingToId: 'nsm', employeeCode: 'ASM-1', user: { name: null }, hierarchyLevel: { code: 'ASM' } },
    { id: 'loop', clientId: 'bajaj', reportingToId: 'loop', employeeCode: 'LOOP', user: null, hierarchyLevel: null },
  ];
  for (let i = 0; i < 40; i++) {
    outlets.push({ id: `pk${i}`, clientId: 'bajaj', outletCode: `O${i}`, zone: 'W', state: i % 2 ? 'MH' : null, city: 'Pune', partner: i % 6 ? { businessName: `Biz${i}`, ownerName: 'Own', phone: '99', panNumber: `PAN${i}`, gstRegistrationType: 'REGULAR', entityType: 'INDIVIDUAL' } : null });
    if (i % 3) {
      const rep = `rep${i}`;
      users.push({ id: rep, clientId: 'bajaj', reportingToId: i % 9 === 1 ? 'loop' : 'asm', employeeCode: `XSR-${i}`, user: { name: `Rep ${i}` }, hierarchyLevel: { code: 'XSR' } });
      assignments.push({ id: `a${i}`, outletId: `pk${i}`, salesUserId: rep, unassignedAt: null, assignedAt: new Date(BASE) });
      assignments.push({ id: `b${i}`, outletId: `pk${i}`, salesUserId: 'asm', unassignedAt: null, assignedAt: new Date(BASE - 1) }); // older → loses
    }
  }
  outlets.push({ id: 'pkF', clientId: 'other', outletCode: 'O1', zone: 'FOREIGN', state: null, city: null, partner: null });
  const live = {
    creditPayoutEntry: fakeModel([...Array.from({ length: n }, (_, i) => entry(i)), ...extra]),
    outlet: fakeModel(outlets),
    salesUserAssignment: fakeModel(assignments),
    salesUser: fakeModel(users),
  };
  // Interactive transaction over the same (live) models; the snapshot test below replaces it with a frozen copy.
  const $transaction = jest.fn(async (cb: (tx: unknown) => Promise<unknown>, _opts?: unknown) => cb(live));
  return Object.assign(live, { $transaction });
}

describe('payments-report export kind', () => {
  it('parity: tenant, PAID default — same 29 columns, chains, IST dates, totals; formula guard; foreign tenant excluded', async () => {
    const prisma = world(300, [entry(9999, { clientId: 'other', outletId: 'O1' })]);
    const params = PAYMENTS_REPORT_KIND.parseParams({ clientId: 'other' }, CLIENT);
    const { buffer } = await renderKind(PAYMENTS_REPORT_KIND, ctxFor(CLIENT, prisma), params);
    expectSameWorkbook(buffer, await screenDownload(prisma, { clientId: 'bajaj' }));
    const p = readBook(buffer).sheets.Payments;
    expect(p.aoa[0]).toHaveLength(29 + 1); // S.No + 29 report columns
    expect(p.aoa.flat()).toContain("'=cmd()");
    expect(p.aoa.flat()).not.toContain('FOREIGN');
  }, XLSX_TIMEOUT);

  it('parity: non-PAID status filter (attemptedAt ↓ nulls last) and a date range', async () => {
    const prisma = world(300);
    const params = PAYMENTS_REPORT_KIND.parseParams({ status: 'FAILED', from: '2026-06-02', to: '2026-06-10' }, CLIENT);
    expectSameWorkbook(
      (await renderKind(PAYMENTS_REPORT_KIND, ctxFor(CLIENT, prisma), params)).buffer,
      await screenDownload(prisma, { clientId: 'bajaj', status: 'FAILED' as never, from: '2026-06-02', to: '2026-06-10' }),
    );
  }, XLSX_TIMEOUT);

  it('UNCAPPED: > 10,000 matching rows are ALL exported (no TRUNCATED notice); paged ≤ 2,000 per read; Summary == DB aggregate', async () => {
    const prisma = world(12_300); // 10,543 PAID rows — past the old 10,000 cap
    const paid = (prisma.creditPayoutEntry.rows as Row[]).filter((r) => r.paidAt);
    expect(paid.length).toBeGreaterThan(10_000);
    const params = PAYMENTS_REPORT_KIND.parseParams({}, CLIENT);
    const { buffer, rowCount } = await renderKind(PAYMENTS_REPORT_KIND, ctxFor(CLIENT, prisma), params);
    expect(rowCount).toBe(paid.length);
    const book = readBook(buffer);
    expect(book.sheets.Payments.aoa.length - 1).toBe(paid.length);
    const sumPaise = paid.reduce((t, r) => t + (r.amountPaise as bigint), 0n);
    const sumTds = paid.reduce((t, r) => t + (r.tdsDeductedPaise as bigint), 0n);
    expect(book.sheets.Summary.aoa).toEqual([
      ['Metric', 'Value'],
      ['Rows', paid.length],
      ['Total Amount (₹)', Number(sumPaise) / 100],
      ['Total TDS Deducted (₹)', Number(sumTds) / 100],
    ]); // and no TRUNCATED row
    // Summary comes from the DB aggregate (one call, the report's WHERE), not from summing rows in memory.
    expect(prisma.creditPayoutEntry.aggregate).toHaveBeenCalledTimes(1);
    expect(prisma.creditPayoutEntry.aggregate.mock.calls[0][0]).toMatchObject({
      where: { clientId: 'bajaj', paidAt: { not: null } },
      _count: { _all: true },
      _sum: { amountPaise: true, tdsDeductedPaise: true },
    });
    // Six OFFSET pages: 5 × 2,000 + 543 — never more than 2,000 rows per read.
    expect(prisma.creditPayoutEntry.findMany.mock.calls.map((c) => [c[0].skip, c[0].take])).toEqual([
      [0, 2000], [2000, 2000], [4000, 2000], [6000, 2000], [8000, 2000], [10_000, 2000],
    ]);
    expect(await maxPage(prisma.creditPayoutEntry)).toBeLessThanOrEqual(2000);
  }, 120_000);

  it('MEMORY: streams — each page is handed to the writer before the next is read; no read returns > 2,000 rows', async () => {
    const prisma = world(7_000); // 6,000 PAID → 3 full pages + an empty probe read
    const writtenAtRead: number[] = [];
    let written = 0;
    const out: XlsxStreamWriter = {
      async addSheet() {
        return {
          addRow: async () => {
            written++;
          },
          get rowCount() {
            return written;
          },
        };
      },
      finish: async () => undefined,
      get rowCount() {
        return written;
      },
    };
    const inner = prisma.creditPayoutEntry.findMany.getMockImplementation()!;
    prisma.creditPayoutEntry.findMany.mockImplementation(async (args) => {
      writtenAtRead.push(written);
      return inner(args);
    });
    await PAYMENTS_REPORT_KIND.run(ctxFor(CLIENT, prisma), PAYMENTS_REPORT_KIND.parseParams({}, CLIENT), out);
    // Before page k is read, exactly the previous pages' rows are already in the streaming writer — the kind never
    // accumulates pages (peak = one page + its lookups), however big the range.
    expect(writtenAtRead).toEqual([0, 2000, 4000, 6000]);
    expect(await maxPage(prisma.creditPayoutEntry)).toBeLessThanOrEqual(2000);
  }, 60_000);

  it('stable order with TIES on paidAt + createdAt: id ↓ tiebreak — screen pages and the file agree across every boundary', async () => {
    const prisma = world(0);
    const all = prisma.creditPayoutEntry.rows as Row[];
    const sameInstant = new Date(BASE + 5 * 86_400_000);
    // 650 rows paid in ONE bulk UTR upload (same paidAt AND createdAt), inserted in scrambled id order.
    for (let i = 0; i < 650; i++) {
      all.push(entry(i * 7 + 1, { id: `t${String((i * 389) % 650).padStart(4, '0')}`, paidAt: sameInstant, createdAt: sameInstant, status: 'PAID' }));
    }
    const params = PAYMENTS_REPORT_KIND.parseParams({}, CLIENT);
    const { buffer } = await renderKind(PAYMENTS_REPORT_KIND, ctxFor(CLIENT, prisma), params);
    expectSameWorkbook(buffer, await screenDownload(prisma, { clientId: 'bajaj' }));
    // The screen's page-by-page ids: exactly id-descending, no duplicates, no gaps across the 200-row boundaries.
    const svc = new PaymentsReportService(prisma as never);
    const ids: string[] = [];
    for (let page = 1; page <= 4; page++) {
      prisma.creditPayoutEntry.findMany.mockClear();
      const r = await svc.paymentReport({ clientId: 'bajaj', page, pageSize: 200 });
      expect(r.totalRows).toBe(650);
      const pageRows = (await prisma.creditPayoutEntry.findMany.mock.results[0].value) as Row[];
      expect(pageRows).toHaveLength(page < 4 ? 200 : 50);
      ids.push(...pageRows.map((x) => x.id as string));
    }
    expect(new Set(ids).size).toBe(650);
    expect(ids).toEqual([...ids].sort().reverse());
  }, 60_000);

  it('SCREEN MEMORY at Bajaj scale (48,086 entries): each request loads ≤ pageSize entries; totals == the whole range', async () => {
    const prisma = world(56_101); // 48,086 PAID rows (every 7th is FAILED)
    const paid = (prisma.creditPayoutEntry.rows as Row[]).filter((r) => r.paidAt);
    expect(paid).toHaveLength(48_086);
    const svc = new PaymentsReportService(prisma as never);
    const sum = paid.reduce((t, r) => t + (r.amountPaise as bigint), 0n);
    const lastPage = Math.ceil(48_086 / 200);
    for (const page of [1, 2, lastPage]) {
      prisma.creditPayoutEntry.findMany.mockClear();
      prisma.outlet.findMany.mockClear();
      const r = await svc.paymentReport({ clientId: 'bajaj', page, pageSize: 200 });
      const loaded = (await prisma.creditPayoutEntry.findMany.mock.results[0].value) as Row[];
      expect(prisma.creditPayoutEntry.findMany).toHaveBeenCalledTimes(1);
      expect(loaded.length).toBe(page === lastPage ? 48_086 - 200 * (lastPage - 1) : 200);
      expect(r.rows).toHaveLength(loaded.length);
      expect(prisma.outlet.findMany.mock.calls[0][0].where.outletCode.in.length).toBeLessThanOrEqual(200);
      expect(r).toMatchObject({ page, pageSize: 200, totalRows: 48_086, totalPages: lastPage });
      expect(r.totals.amount.paise).toBe(sum.toString()); // whole range on every page
    }
  }, 60_000);

  it('Summary guard: if the aggregate ever disagreed with the streamed rows the export fails instead of shipping a wrong file', async () => {
    const prisma = world(50);
    prisma.creditPayoutEntry.aggregate.mockResolvedValueOnce({ _count: { _all: 1 }, _sum: { amountPaise: 1n, tdsDeductedPaise: 0n } });
    await expect(renderKind(PAYMENTS_REPORT_KIND, ctxFor(CLIENT, prisma), PAYMENTS_REPORT_KIND.parseParams({}, CLIENT))).rejects.toThrow(
      /aggregate is 1/,
    );
  }, XLSX_TIMEOUT);

  it('all pages read inside ONE REPEATABLE READ snapshot: a payout added / re-paid between pages never duplicates, skips or double-counts', async () => {
    const prisma = world(2_300); // > one 2,000-row page of PAID rows (1,971 PAID)… plus FAILED; force two pages below
    const all = prisma.creditPayoutEntry.rows as Row[];
    // Add PAID rows so there are > 2,000 PAID entries → two page reads.
    for (let i = 0; i < 200; i++) all.push(entry(20_000 + i, { status: 'PAID', paidAt: new Date(BASE - i * 1000), utr: `X${i}`, attemptedAt: null }));
    const expected = await screenDownload(prisma, { clientId: 'bajaj' }); // the state when the export starts
    prisma.creditPayoutEntry.findMany.mockClear();
    prisma.$transaction.mockClear(); // the screen reference also reads in a (RepeatableRead) transaction

    // The DB snapshot the transaction sees (frozen copies taken at BEGIN).
    const frozen = {
      creditPayoutEntry: fakeModel(all.map((r) => ({ ...r }))),
      outlet: fakeModel([...(prisma.outlet.rows as Row[])]),
      salesUserAssignment: fakeModel([...(prisma.salesUserAssignment.rows as Row[])]),
      salesUser: fakeModel([...(prisma.salesUser.rows as Row[])]),
    };
    // Between page 1 and page 2, the LIVE table changes: a newer payout is paid (sorts first → offset paging on the live
    // table would shift every later row by one → a duplicate) and an old one is deleted.
    const firstPage = frozen.creditPayoutEntry.findMany.getMockImplementation()!;
    frozen.creditPayoutEntry.findMany.mockImplementation(async (args) => {
      const rows = await firstPage(args);
      if (!args?.skip) {
        all.unshift(entry(99_999, { status: 'PAID', paidAt: new Date(BASE + 10_000 * 3_600_000), utr: 'NEW' }));
        all.pop();
      }
      return rows;
    });
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(frozen));

    const params = PAYMENTS_REPORT_KIND.parseParams({}, CLIENT);
    const { buffer } = await renderKind(PAYMENTS_REPORT_KIND, ctxFor(CLIENT, prisma), params);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: 'RepeatableRead' });
    expect(frozen.creditPayoutEntry.findMany.mock.calls.length).toBe(2); // two pages, both in the snapshot
    expect(prisma.creditPayoutEntry.findMany).not.toHaveBeenCalled(); // never read outside the transaction
    expectSameWorkbook(buffer, expected);
    const ids = readBook(buffer).sheets.Payments.aoa.slice(1).map((r) => r[15]); // UTR column
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('NEW');
  }, 60_000);

  it('parity: no rows → header-less Payments sheet + zero Summary', async () => {
    const prisma = world(0);
    const params = PAYMENTS_REPORT_KIND.parseParams({}, CLIENT);
    expectSameWorkbook((await renderKind(PAYMENTS_REPORT_KIND, ctxFor(CLIENT, prisma), params)).buffer, await screenDownload(prisma, { clientId: 'bajaj' }));
  }, XLSX_TIMEOUT);

  it('params / access / light rule / names', () => {
    expect(PAYMENTS_REPORT_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'reports:read' });
    expect(() => PAYMENTS_REPORT_KIND.parseParams({ status: 'NOPE' }, CLIENT)).toThrow(BadRequestException);
    expect(() => PAYMENTS_REPORT_KIND.parseParams({ from: 'yesterday' }, CLIENT)).toThrow(BadRequestException);
    expect(PAYMENTS_REPORT_KIND.parseParams({ clientId: 'x' }, GIFSY).clientId).toBe('x');
    // Uncapped now: ≤ 31 days is instant (one tenant or all tenants); open-ended / longer → Downloads page.
    const heavy = (q: Record<string, unknown>, u = CLIENT) => PAYMENTS_REPORT_KIND.isHeavy(PAYMENTS_REPORT_KIND.parseParams(q, u));
    expect(heavy({})).toBe(true);
    expect(heavy({ from: '2026-06-01' })).toBe(true);
    expect(heavy({ from: '2026-06-01', to: '2026-06-30' })).toBe(false);
    expect(heavy({ from: '2026-06-01', to: '2026-08-31' })).toBe(true);
    expect(heavy({ from: '2026-06-01', to: '2026-06-30' }, GIFSY)).toBe(false); // all tenants, one month: still instant
    expect(heavy({ from: '2026-06-01', to: '2026-07-31' }, GIFSY)).toBe(true);
    expect(heavy({ clientId: 'bajaj', from: '2026-06-01', to: '2026-06-30' }, GIFSY)).toBe(false);
    expect(() => PAYMENTS_REPORT_KIND.parseParams({ page: 2 }, CLIENT)).toThrow(BadRequestException); // export = all rows
    expect(PAYMENTS_REPORT_KIND.fileName(PAYMENTS_REPORT_KIND.parseParams({}, CLIENT), new Date())).toBe('payments-report-bajaj.xlsx');
    expect(PAYMENTS_REPORT_KIND.fileName(PAYMENTS_REPORT_KIND.parseParams({}, GIFSY), new Date())).toBe('payments-report-all.xlsx');
  });
});
