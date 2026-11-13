import { BadRequestException } from '@nestjs/common';
import { buildXlsx } from '../../../common/xlsx';
import { istDateKey } from '../../../common/ist-date';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { PaymentsReportService, type PaymentsReportScope } from '../../../payments-report/payments-report.service';
import { PAYMENTS_REPORT_KIND } from './payments-report.kind';
import { ctxFor, expectSameWorkbook, fakeModel, maxPage, readBook, renderKind } from './parity.support-spec';

type Row = Record<string, unknown>;
const CLIENT = { sub: 'c', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' } as JwtPayload;
const GIFSY = { sub: 'g', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' } as JwtPayload;

/** REFERENCE COPY of the old in-memory download (PaymentsReportService.paymentReportXlsx before the Downloads page). */
async function oldDownload(prisma: unknown, scope: PaymentsReportScope): Promise<Buffer> {
  const report = await new PaymentsReportService(prisma as never).paymentReport(scope);
  const sheetRows = report.rows.map((r, i) => ({
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
    { Metric: 'Rows', Value: report.count },
    { Metric: 'Total Amount (₹)', Value: report.totals.amount.inr },
    ...(report.truncated
      ? [{ Metric: `TRUNCATED — showing first ${report.maxRows}; narrow the date range for a complete report`, Value: 'YES' }]
      : []),
  ];
  return buildXlsx([
    { name: 'Payments', rows: sheetRows },
    { name: 'Summary', rows: summaryRows },
  ]);
}

const BASE = Date.UTC(2026, 5, 1);

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
    // Unique instants (the old query had no tiebreak; the kind adds id ↓). 18:45 UTC → next IST day.
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
  return {
    creditPayoutEntry: fakeModel([...Array.from({ length: n }, (_, i) => entry(i)), ...extra]),
    outlet: fakeModel(outlets),
    salesUserAssignment: fakeModel(assignments),
    salesUser: fakeModel(users),
  };
}

describe('payments-report export kind', () => {
  it('parity: tenant, PAID default — same 29 columns, chains, IST dates, totals; formula guard; foreign tenant excluded', async () => {
    const prisma = world(300, [entry(9999, { clientId: 'other', outletId: 'O1' })]);
    const params = PAYMENTS_REPORT_KIND.parseParams({ clientId: 'other' }, CLIENT);
    const { buffer } = await renderKind(PAYMENTS_REPORT_KIND, ctxFor(CLIENT, prisma), params);
    expectSameWorkbook(buffer, await oldDownload(prisma, { clientId: 'bajaj' }));
    const p = readBook(buffer).sheets.Payments;
    expect(p.aoa[0]).toHaveLength(29 + 1); // S.No + 29 report columns
    expect(p.aoa.flat()).toContain("'=cmd()");
    expect(p.aoa.flat()).not.toContain('FOREIGN');
  });

  it('parity: non-PAID status filter (attemptedAt ↓ nulls last) and a date range', async () => {
    const prisma = world(300);
    const params = PAYMENTS_REPORT_KIND.parseParams({ status: 'FAILED', from: '2026-06-02', to: '2026-06-10' }, CLIENT);
    expectSameWorkbook(
      (await renderKind(PAYMENTS_REPORT_KIND, ctxFor(CLIENT, prisma), params)).buffer,
      await oldDownload(prisma, { clientId: 'bajaj', status: 'FAILED' as never, from: '2026-06-02', to: '2026-06-10' }),
    );
  });

  it('parity at the cap: 10,001+ rows → first 10,000 + TRUNCATED notice; paged ≤ 2,000 per read', async () => {
    const prisma = world(12_000); // ≈ 10,285 PAID rows
    const expected = await oldDownload(prisma, {});
    prisma.creditPayoutEntry.findMany.mockClear();
    const params = PAYMENTS_REPORT_KIND.parseParams({}, GIFSY);
    expect(params.clientId).toBeNull();
    const { buffer, rowCount } = await renderKind(PAYMENTS_REPORT_KIND, ctxFor(GIFSY, prisma), params);
    expect(rowCount).toBe(10_000);
    expectSameWorkbook(buffer, expected);
    expect(readBook(buffer).sheets.Summary.aoa[3][0]).toMatch(/^TRUNCATED/);
    expect(await maxPage(prisma.creditPayoutEntry)).toBeLessThanOrEqual(2000);
  }, 120_000);

  it('parity: no rows → header-less Payments sheet + zero Summary', async () => {
    const prisma = world(0);
    const params = PAYMENTS_REPORT_KIND.parseParams({}, CLIENT);
    expectSameWorkbook((await renderKind(PAYMENTS_REPORT_KIND, ctxFor(CLIENT, prisma), params)).buffer, await oldDownload(prisma, { clientId: 'bajaj' }));
  });

  it('params / access / light rule / names', () => {
    expect(PAYMENTS_REPORT_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'reports:read' });
    expect(() => PAYMENTS_REPORT_KIND.parseParams({ status: 'NOPE' }, CLIENT)).toThrow(BadRequestException);
    expect(() => PAYMENTS_REPORT_KIND.parseParams({ from: 'yesterday' }, CLIENT)).toThrow(BadRequestException);
    expect(PAYMENTS_REPORT_KIND.parseParams({ clientId: 'x' }, GIFSY).clientId).toBe('x');
    expect(PAYMENTS_REPORT_KIND.isHeavy(PAYMENTS_REPORT_KIND.parseParams({}, GIFSY))).toBe(false);
    expect(PAYMENTS_REPORT_KIND.fileName(PAYMENTS_REPORT_KIND.parseParams({}, CLIENT), new Date())).toBe('payments-report-bajaj.xlsx');
    expect(PAYMENTS_REPORT_KIND.fileName(PAYMENTS_REPORT_KIND.parseParams({}, GIFSY), new Date())).toBe('payments-report-all.xlsx');
  });
});
