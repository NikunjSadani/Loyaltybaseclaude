import { BadRequestException } from '@nestjs/common';
import { buildXlsx } from '../../../common/xlsx';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { TdsReportsService, type ReportScope } from '../../../tds-invoicing/tds-reports.service';
import { TDS_PAYOUTS_KIND } from './tds-payouts.kind';
import { ctxFor, expectSameWorkbook, fakeModel, maxPage, readBook, renderKind } from './parity.support-spec';

type Row = Record<string, unknown>;
const CLIENT = { sub: 'c', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' } as JwtPayload;
const GIFSY = { sub: 'g', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' } as JwtPayload;
const ASSUMED = { ...GIFSY, clientId: 'bajaj', assumed: true } as JwtPayload;

/** REFERENCE COPY of the old in-memory download (TdsReportsService.payoutReportXlsx before the Downloads page). */
async function oldDownload(prisma: unknown, scope: ReportScope): Promise<Buffer> {
  const report = await new TdsReportsService(prisma as never).payoutReport(scope);
  const sheetRows = report.rows.map((r, i) => ({
    'S.No': i + 1,
    'Client': r.clientId,
    'Outlet Code': r.outletCode ?? '',
    'Outlet Name': r.outletName,
    'Business Name': r.businessName ?? '',
    'PAN': r.panNumber ?? '',
    'GST Reg Type': r.gstRegistrationType ?? '',
    'Entity Type': r.entityType ?? '',
    'Payout Field': r.fieldName,
    'Period': r.period,
    'Amount (₹)': r.amount.inr,
    'TDS Section': r.tdsSection ?? '',
    'TDS Methodology': r.tdsMethodology ?? '',
    'TDS Deducted (₹)': r.tdsDeducted.inr,
    'Invoice No.': r.invoiceNumber ?? '',
  }));
  const summaryRows = [
    { Metric: 'Rows', Value: report.count },
    { Metric: 'Total Amount (₹)', Value: report.totals.amount.inr },
    { Metric: 'Total TDS Deducted (₹)', Value: report.totals.tdsDeducted.inr },
  ];
  return buildXlsx([
    { name: 'Payouts', rows: sheetRows },
    { name: 'Summary', rows: summaryRows },
  ]);
}

function db(entries: Row[], outlets: Row[]) {
  return { creditPayoutEntry: fakeModel(entries), outlet: fakeModel(outlets) };
}

function entry(i: number, over: Row = {}): Row {
  return {
    id: `e${String(i).padStart(6, '0')}`,
    clientId: 'bajaj',
    outletId: `O${i % 50}`,
    outletName: `Shop ${i}`,
    fieldName: 'Visibility',
    period: i % 2 ? '2026-06' : '2026-07',
    amountPaise: BigInt(1000 + i * 7),
    tdsSection: 'SEC_194C',
    tdsMethodology: i % 3 ? 'DEDUCT' : 'GROSS_UP',
    tdsDeductedPaise: BigInt(i * 3),
    // Unique per row: the old query had no tiebreak (DB order on ties is arbitrary), the kind adds id ↓.
    createdAt: new Date(Date.UTC(2026, 5, 1) + i * 1000),
    autoInvoice: i % 4 ? { invoiceNumber: `INV-${i}` } : null,
    ...over,
  };
}

function outlets(): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < 50; i++) {
    out.push({
      clientId: 'bajaj',
      outletCode: `O${i}`,
      partner: i % 5 ? { gstRegistrationType: 'REGULAR', entityType: 'INDIVIDUAL', panNumber: `PAN${i}`, businessName: `Biz ${i}` } : null,
    });
  }
  out.push({ clientId: 'other', outletCode: 'O1', partner: { gstRegistrationType: 'X', entityType: 'X', panNumber: 'FOREIGN', businessName: 'Foreign' } });
  return out;
}

describe('tds-payouts export kind', () => {
  it('parity: one tenant × one period — identical Payouts + Summary; formula guard; no foreign rows', async () => {
    const entries = [
      ...Array.from({ length: 40 }, (_, i) => entry(i)),
      entry(899, { outletId: '=HYPERLINK("evil")', outletName: '=cmd()|calc' }),
      entry(901, { tdsSection: null }), // legacy/incentive — excluded
      entry(902, { clientId: 'other' }),
    ];
    const prisma = db(entries, outlets());
    const params = TDS_PAYOUTS_KIND.parseParams({ period: '2026-06', clientId: 'other' }, CLIENT);
    expect(params).toEqual({ clientId: 'bajaj', period: '2026-06' });
    const { buffer, rowCount } = await renderKind(TDS_PAYOUTS_KIND, ctxFor(CLIENT, prisma), params);
    expectSameWorkbook(buffer, await oldDownload(prisma, { clientId: 'bajaj', period: '2026-06' }));
    const book = readBook(buffer);
    expect(book.names).toEqual(['Payouts', 'Summary']);
    expect(rowCount).toBe(book.sheets.Payouts.aoa.length - 1);
    const flat = book.sheets.Payouts.aoa.flat();
    expect(flat).toContain("'=HYPERLINK(\"evil\")");
    expect(flat).not.toContain('FOREIGN');
  });

  it('parity: platform-wide (un-assumed Gifsy, all periods) across > 2,000 rows (2,100) — paged, identical, totals exact', async () => {
    const entries = Array.from({ length: 2100 }, (_, i) => entry(i, i % 10 === 0 ? { clientId: 'other' } : {}));
    const prisma = db(entries, outlets());
    const params = TDS_PAYOUTS_KIND.parseParams({}, GIFSY);
    expect(params).toEqual({ clientId: null, period: null });
    expect(TDS_PAYOUTS_KIND.isHeavy(params)).toBe(true);
    const expected = await oldDownload(prisma, {});
    prisma.creditPayoutEntry.findMany.mockClear();
    prisma.outlet.findMany.mockClear();
    const { buffer, rowCount } = await renderKind(TDS_PAYOUTS_KIND, ctxFor(GIFSY, prisma), params);
    expect(rowCount).toBe(2100);
    expectSameWorkbook(buffer, expected);
    expect(prisma.creditPayoutEntry.findMany.mock.calls.length).toBe(2);
    expect(await maxPage(prisma.creditPayoutEntry)).toBeLessThanOrEqual(2000);
    expect(TDS_PAYOUTS_KIND.fileName(params, new Date())).toBe('payout-report-all.xlsx');
  }, 30_000);

  it('parity: nothing to export → header-less Payouts sheet + zero Summary (as json_to_sheet([]))', async () => {
    const prisma = db([], outlets());
    const params = TDS_PAYOUTS_KIND.parseParams({ period: '2026-01' }, CLIENT);
    expectSameWorkbook((await renderKind(TDS_PAYOUTS_KIND, ctxFor(CLIENT, prisma), params)).buffer, await oldDownload(prisma, { clientId: 'bajaj', period: '2026-01' }));
  }, 30_000); // xlsx build + parity read is slow under full-suite load (timed out at 5 s on 2026-11-15)

  it('scope: assumed operator pinned; un-assumed Gifsy may pick a tenant; heavy rule; access; validation', () => {
    expect(TDS_PAYOUTS_KIND.parseParams({ clientId: 'other' }, ASSUMED)).toEqual({ clientId: 'bajaj', period: null });
    expect(TDS_PAYOUTS_KIND.parseParams({ clientId: 'other', period: '2026-06' }, GIFSY)).toEqual({ clientId: 'other', period: '2026-06' });
    expect(TDS_PAYOUTS_KIND.isHeavy({ clientId: 'bajaj', period: '2026-06' })).toBe(false);
    expect(TDS_PAYOUTS_KIND.isHeavy({ clientId: 'bajaj', period: null })).toBe(true);
    expect(TDS_PAYOUTS_KIND.isHeavy({ clientId: null, period: '2026-06' })).toBe(true);
    expect(TDS_PAYOUTS_KIND.access).toEqual({ roles: ['CLIENT_ADMIN', 'GIFSY_ADMIN'] });
    expect(() => TDS_PAYOUTS_KIND.parseParams({ period: 'June' }, CLIENT)).toThrow(BadRequestException);
    expect(() => TDS_PAYOUTS_KIND.parseParams({ foo: 1 }, CLIENT)).toThrow(BadRequestException);
    expect(TDS_PAYOUTS_KIND.fileName({ clientId: 'bajaj', period: '2026-06' }, new Date())).toBe('payout-report-bajaj.xlsx');
  });

  it('a stale params.clientId never widens a tenant user: the scope is re-derived from the requester at run time', async () => {
    const prisma = db([entry(1), entry(3, { clientId: 'other' })], outlets());
    const { buffer } = await renderKind(TDS_PAYOUTS_KIND, ctxFor(CLIENT, prisma), { clientId: 'other', period: '2026-06' });
    const rows = readBook(buffer).sheets.Payouts.aoa.slice(1);
    expect(rows.map((r) => r[1])).toEqual(['bajaj']);
  });
});
