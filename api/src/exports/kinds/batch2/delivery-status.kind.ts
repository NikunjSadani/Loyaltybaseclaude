/**
 * Transactional delivery-status report — GET /v1/admin/notification-delivery/export as an export kind (Downloads
 * page design). Output identical to the old NotificationDeliveryReportService.export: one sheet "Delivery" (Channel …
 * Created At, IST date-times), a visible truncation-notice row at the 100,000-row cap, and a header + blank row when
 * there is nothing to export.
 *
 * Paging: receipts ordered createdAt ↑ (id ↑ as the keyset tiebreak), ≤ 2,000 per read, written before the next read.
 *
 * Scope exactly as today (D4, isolation-critical): from the JWT only — CLIENT_ADMIN / assumed operator → their
 * tenant; un-assumed GIFSY_ADMIN → all tenants. No clientId param exists. A non-platform-wide caller with no tenant
 * is refused (fail closed) before any read.
 */
import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { istDateTimeCell } from '../../../common/ist-date';
import { platformWide, tenantScope } from '../../../common/tenant-scope';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { NotificationDeliverySummaryQueryDto } from '../../../notifications/dto/notification-delivery-report.dto';
import {
  NotificationDeliveryReportService,
  deliveryDateRange,
} from '../../../notifications/notification-delivery-report.service';
import type { ExportKindDef, ExportRunContext } from '../../export-kinds';
import type { XlsxStreamWriter } from '../../../common/xlsx-stream';
import { keysetPages, parseQueryDto } from './kind-support';

export interface DeliveryStatusParams {
  channel: 'SMS' | 'WHATSAPP' | null;
  from: string | null;
  to: string | null;
  event: string | null;
  /** true when requested by an un-assumed GIFSY_ADMIN (all tenants) — informs the heavy rule + summary only. */
  platformWide: boolean;
}

const HEADERS = ['Channel', 'Event', 'Recipient Phone', 'Status', 'Sent At', 'Delivered At', 'Read At', 'Failure Reason', 'Created At'];

/** A range longer than this (or open-ended, or all tenants) is prepared on the Downloads page. */
export const DELIVERY_INSTANT_MAX_DAYS = 31;

/** The same WHERE as the old export (NotificationDeliveryReportService.listWhere). Throws when the scope is unsafe. */
function whereFor(user: JwtPayload, p: DeliveryStatusParams): Prisma.MessageDeliveryReceiptWhereInput {
  const scope = tenantScope(user);
  if (!platformWide(user) && !scope) throw new ForbiddenException('Delivery report requires a tenant scope.');
  const where: Prisma.MessageDeliveryReceiptWhereInput = {};
  if (scope) where.clientId = scope;
  if (p.event) where.eventKey = p.event;
  const createdAt = deliveryDateRange(p.from ?? undefined, p.to ?? undefined);
  if (createdAt) where.createdAt = createdAt;
  if (p.channel) where.channel = p.channel;
  return where;
}

async function run(ctx: ExportRunContext, p: DeliveryStatusParams, out: XlsxStreamWriter): Promise<{ rowCount: number }> {
  const where = whereFor(ctx.user, p);
  const cap = NotificationDeliveryReportService.MAX_EXPORT_ROWS;
  const sheet = await out.addSheet('Delivery', HEADERS);
  const cell = (d: Date | null) => (d ? istDateTimeCell(d) : '');
  let written = 0;
  for await (const page of keysetPages((q) =>
    ctx.prisma.messageDeliveryReceipt.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      // NEVER selects providerResponse / crqid.
      select: {
        id: true,
        channel: true,
        eventKey: true,
        recipientPhone: true,
        status: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        failureReason: true,
        createdAt: true,
      },
      ...q,
      take: Math.min(q.take, cap - written),
    }),
  )) {
    for (const r of page) {
      await sheet.addRow([
        r.channel,
        r.eventKey ?? '',
        r.recipientPhone ?? '',
        r.status,
        cell(r.sentAt),
        cell(r.deliveredAt),
        cell(r.readAt),
        r.failureReason ?? '',
        cell(r.createdAt),
      ]);
      written++;
    }
    if (written >= cap) break;
  }
  if (written >= cap) {
    // M3: a silently-clipped file would be read as complete — say so in the file.
    await sheet.addRow([
      `⚠️ Export truncated at ${cap.toLocaleString('en-US')} rows — narrow the date range for a complete export.`,
      '', '', '', '', '', '', '', '',
    ]);
  } else if (written === 0) {
    // The old builder seeded one all-blank row so the header row is present.
    await sheet.addRow(HEADERS.map(() => ''));
  }
  return { rowCount: written };
}

function spanDays(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = new Date(/^\d{4}-\d{2}-\d{2}$/.test(from) ? `${from}T00:00:00+05:30` : from).getTime();
  const b = new Date(/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T00:00:00+05:30` : to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.floor((b - a) / 86_400_000) + 1;
}

export const DELIVERY_STATUS_KIND: ExportKindDef<DeliveryStatusParams> = {
  kind: 'delivery-status',
  label: 'Message delivery report',
  // Same as the controller: @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN'), no @RequirePermission.
  access: { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'] },
  parseParams(raw: unknown, user: JwtPayload) {
    const q = parseQueryDto(NotificationDeliverySummaryQueryDto, raw);
    const p: DeliveryStatusParams = {
      channel: q.channel ?? null,
      from: q.from ?? null,
      to: q.to ?? null,
      event: q.event ?? null,
      platformWide: platformWide(user),
    };
    whereFor(user, p); // fail closed at request time too (403, never queued)
    return p;
  },
  // Receipts grow with every OTP / SMS / WhatsApp message (up to 100,000 rows exported): one tenant over ≤ 31 days
  // streams instantly; an open-ended or longer range, or all tenants, is prepared in the background.
  isHeavy(p) {
    const days = spanDays(p.from, p.to);
    return p.platformWide || days === null || days > DELIVERY_INSTANT_MAX_DAYS;
  },
  describeParams: (p) =>
    [
      p.from || p.to ? `${p.from ?? '…'} – ${p.to ?? '…'}` : 'All dates',
      p.channel ?? 'SMS + WhatsApp',
      ...(p.event ? [p.event] : []),
      ...(p.platformWide ? ['All tenants'] : []),
    ].join(' · '),
  fileName: (_p, now) => `notification-delivery-${now.toISOString().slice(0, 10)}.xlsx`,
  run,
};
