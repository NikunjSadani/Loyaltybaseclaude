import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { buildXlsx } from '../../../common/xlsx';
import { istDateTimeCell } from '../../../common/ist-date';
import { platformWide, tenantScope } from '../../../common/tenant-scope';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { NotificationDeliveryReportService, deliveryDateRange } from '../../../notifications/notification-delivery-report.service';
import type { NotificationDeliverySummaryQueryDto } from '../../../notifications/dto/notification-delivery-report.dto';
import { DELIVERY_STATUS_KIND } from './delivery-status.kind';
import { ctxFor, expectSameWorkbook, fakeModel, maxPage, readBook, renderKind } from './parity.support-spec';

type Row = Record<string, unknown>;
const CLIENT = { sub: 'c', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' } as JwtPayload;
const GIFSY = { sub: 'g', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' } as JwtPayload;
const NO_TENANT = { ...CLIENT, clientId: '' } as JwtPayload;

/** REFERENCE COPY of the old in-memory download (NotificationDeliveryReportService.export before the Downloads page). */
async function oldDownload(prisma: { messageDeliveryReceipt: { findMany: (a: unknown) => Promise<Row[]> } }, user: JwtPayload, q: NotificationDeliverySummaryQueryDto, cap: number): Promise<Buffer> {
  const scope = tenantScope(user);
  if (!platformWide(user) && !scope) throw new ForbiddenException('Delivery report requires a tenant scope.');
  const where: Prisma.MessageDeliveryReceiptWhereInput = {};
  if (scope) where.clientId = scope;
  if (q.event) where.eventKey = q.event;
  const createdAt = deliveryDateRange(q.from, q.to);
  if (createdAt) where.createdAt = createdAt;
  if (q.channel) where.channel = q.channel;
  const rows = await prisma.messageDeliveryReceipt.findMany({ where, orderBy: { createdAt: 'asc' }, take: cap });
  const iso = (d: unknown) => (d ? istDateTimeCell(d as Date) : '');
  const sheetRows: Record<string, string>[] = rows.map((r) => ({
    Channel: r.channel as string,
    Event: (r.eventKey as string) ?? '',
    'Recipient Phone': (r.recipientPhone as string) ?? '',
    Status: r.status as string,
    'Sent At': iso(r.sentAt),
    'Delivered At': iso(r.deliveredAt),
    'Read At': iso(r.readAt),
    'Failure Reason': (r.failureReason as string) ?? '',
    'Created At': iso(r.createdAt),
  }));
  const blank = { Channel: '', Event: '', 'Recipient Phone': '', Status: '', 'Sent At': '', 'Delivered At': '', 'Read At': '', 'Failure Reason': '', 'Created At': '' };
  if (rows.length === cap) {
    sheetRows.push({ ...blank, Channel: `⚠️ Export truncated at ${cap.toLocaleString('en-US')} rows — narrow the date range for a complete export.` });
  }
  return buildXlsx([{ name: 'Delivery', rows: sheetRows.length > 0 ? sheetRows : [blank] }]);
}

const BASE = Date.UTC(2026, 9, 1);
function receipt(i: number, over: Row = {}): Row {
  return {
    id: `r${String(i).padStart(7, '0')}`,
    clientId: i % 9 === 0 ? 'other' : 'bajaj',
    channel: i % 2 ? 'SMS' : 'WHATSAPP',
    eventKey: i % 3 ? 'OTP' : null,
    recipientPhone: i % 4 ? `9${String(i).padStart(9, '0')}` : null,
    status: ['SENT', 'DELIVERED', 'READ', 'FAILED'][i % 4],
    sentAt: i % 5 ? new Date(BASE + i * 60_000 + 1000) : null,
    deliveredAt: i % 4 === 1 ? new Date(BASE + i * 60_000 + 5000) : null,
    readAt: null,
    failureReason: i % 4 === 3 ? (i === 3 ? '=HYPERLINK("x")' : 'DND') : null,
    createdAt: new Date(BASE + i * 60_000), // unique (the old query had no tiebreak)
    providerResponse: { secret: 'never exported' },
    ...over,
  };
}

describe('delivery-status export kind', () => {
  it('parity: tenant, ≤ 31 days, channel filter — identical; formula guard; foreign tenant excluded', async () => {
    const prisma = { messageDeliveryReceipt: fakeModel(Array.from({ length: 500 }, (_, i) => receipt(i))) };
    const q = { from: '2026-10-01', to: '2026-10-31' };
    const params = DELIVERY_STATUS_KIND.parseParams(q, CLIENT);
    expect(DELIVERY_STATUS_KIND.isHeavy(params)).toBe(false);
    const { buffer, rowCount } = await renderKind(DELIVERY_STATUS_KIND, ctxFor(CLIENT, prisma), params);
    expectSameWorkbook(buffer, await oldDownload(prisma, CLIENT, q, 100_000));
    const flat = readBook(buffer).sheets.Delivery.aoa.flat();
    expect(flat).toContain("'=HYPERLINK(\"x\")");
    expect(rowCount).toBe(500 - Math.ceil(500 / 9));
    const sms = DELIVERY_STATUS_KIND.parseParams({ ...q, channel: 'SMS', event: 'OTP' }, CLIENT);
    expectSameWorkbook((await renderKind(DELIVERY_STATUS_KIND, ctxFor(CLIENT, prisma), sms)).buffer, await oldDownload(prisma, CLIENT, { ...q, channel: 'SMS', event: 'OTP' }, 100_000));
  }, 30_000);

  it('parity: platform-wide across > 2,000 rows (paged ≤ 2,000) and the truncation notice at the cap', async () => {
    const rows = Array.from({ length: 2100 }, (_, i) => receipt(i));
    const prisma = { messageDeliveryReceipt: fakeModel(rows) };
    const params = DELIVERY_STATUS_KIND.parseParams({}, GIFSY);
    expect(DELIVERY_STATUS_KIND.isHeavy(params)).toBe(true);
    const expected = await oldDownload(prisma, GIFSY, {}, 100_000);
    prisma.messageDeliveryReceipt.findMany.mockClear();
    const { buffer, rowCount } = await renderKind(DELIVERY_STATUS_KIND, ctxFor(GIFSY, prisma), params);
    expect(rowCount).toBe(2100);
    expectSameWorkbook(buffer, expected);
    expect(await maxPage(prisma.messageDeliveryReceipt)).toBeLessThanOrEqual(2000);

    // Truncation at the cap (cap lowered for the test; the production cap is 100,000).
    const real = NotificationDeliveryReportService.MAX_EXPORT_ROWS;
    (NotificationDeliveryReportService as unknown as { MAX_EXPORT_ROWS: number }).MAX_EXPORT_ROWS = 1500;
    try {
      const capped = await renderKind(DELIVERY_STATUS_KIND, ctxFor(GIFSY, prisma), params);
      expect(capped.rowCount).toBe(1500);
      expectSameWorkbook(capped.buffer, await oldDownload(prisma, GIFSY, {}, 1500));
      expect(readBook(capped.buffer).sheets.Delivery.aoa.at(-1)?.[0]).toMatch(/truncated at 1,500 rows/);
    } finally {
      (NotificationDeliveryReportService as unknown as { MAX_EXPORT_ROWS: number }).MAX_EXPORT_ROWS = real;
    }
  }, 30_000);

  it('parity: no rows → header + one blank row', async () => {
    const prisma = { messageDeliveryReceipt: fakeModel([]) };
    const params = DELIVERY_STATUS_KIND.parseParams({ from: '2026-10-01', to: '2026-10-02' }, CLIENT);
    expectSameWorkbook((await renderKind(DELIVERY_STATUS_KIND, ctxFor(CLIENT, prisma), params)).buffer, await oldDownload(prisma, CLIENT, { from: '2026-10-01', to: '2026-10-02' }, 100_000));
  });

  it('isolation + params: no clientId param exists; a tenant-less non-owner is refused; heavy rule; access', () => {
    expect(() => DELIVERY_STATUS_KIND.parseParams({ clientId: 'other' }, CLIENT)).toThrow(BadRequestException);
    expect(() => DELIVERY_STATUS_KIND.parseParams({}, NO_TENANT)).toThrow(ForbiddenException);
    expect(() => DELIVERY_STATUS_KIND.parseParams({ channel: 'EMAIL' }, CLIENT)).toThrow(BadRequestException);
    const p = (q: Row) => DELIVERY_STATUS_KIND.parseParams(q, CLIENT);
    expect(DELIVERY_STATUS_KIND.isHeavy(p({}))).toBe(true); // open-ended
    expect(DELIVERY_STATUS_KIND.isHeavy(p({ from: '2026-10-01' }))).toBe(true);
    expect(DELIVERY_STATUS_KIND.isHeavy(p({ from: '2026-10-01', to: '2026-10-31' }))).toBe(false);
    expect(DELIVERY_STATUS_KIND.isHeavy(p({ from: '2026-10-01', to: '2026-11-01' }))).toBe(true);
    expect(DELIVERY_STATUS_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'] });
    expect(DELIVERY_STATUS_KIND.fileName(p({}), new Date('2026-11-13T10:00:00Z'))).toBe('notification-delivery-2026-11-13.xlsx');
  });

  it('a queued request re-derives the scope from the requester at run time (assumed operator stays pinned)', async () => {
    const prisma = { messageDeliveryReceipt: fakeModel(Array.from({ length: 50 }, (_, i) => receipt(i))) };
    const assumed = { ...GIFSY, clientId: 'bajaj', assumed: true } as JwtPayload;
    const params = { ...DELIVERY_STATUS_KIND.parseParams({}, assumed), platformWide: true }; // tampered flag
    await renderKind(DELIVERY_STATUS_KIND, ctxFor(assumed, prisma), params);
    for (const call of prisma.messageDeliveryReceipt.findMany.mock.calls) expect(call[0].where.clientId).toBe('bajaj');
  });
});
