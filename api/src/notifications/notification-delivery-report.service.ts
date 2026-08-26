import { ForbiddenException, Injectable, StreamableFile } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide, tenantScope } from '../common/tenant-scope';
import { buildXlsx } from '../common/xlsx';
import { MessageDeliveryStatusService } from './message-delivery-status.service';
import {
  NotificationDeliveryListQueryDto,
  NotificationDeliverySummaryQueryDto,
} from './dto/notification-delivery-report.dto';

/** Per-channel status bucket counts (raw, from groupBy). */
type StatusCounts = {
  QUEUED: number;
  SENT: number;
  DELIVERED: number;
  READ: number;
  FAILED: number;
};

/** SMS funnel (SMS never reports READ). */
export interface SmsFunnel {
  sent: number;
  delivered: number;
  failed: number;
  pending: number;
  deliveryRate: number | null;
}

/** WhatsApp funnel (adds READ). */
export interface WhatsappFunnel {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  pending: number;
  deliveryRate: number | null;
}

/** OTP tile (aggregate, light D1). `indicative` = tenant-scoped undercount caveat (see below). */
export interface OtpTile {
  /** All OTP rows in the window — the denominator behind the funnel (D2: surfaced so the tile isn't rate-only). */
  total: number;
  sent: number;
  delivered: number;
  failed: number;
  /** No delivery handle captured yet (never dispatched / pre-feature rows). */
  pending: number;
  deliveryRate: number | null;
  /** true when the count is tenant-scoped (redemption OTPs only) — the FE renders the caveat. */
  indicative: boolean;
}

export interface DeliverySummary {
  sms: SmsFunnel;
  whatsapp: WhatsappFunnel;
  otp: OtpTile;
}

export interface DeliveryListItem {
  id: string;
  channel: string;
  eventKey: string | null;
  recipientPhone: string | null;
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failureReason: string | null;
  createdAt: string | null;
}

export interface DeliveryListPage {
  items: DeliveryListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Transactional delivery-status REPORTING surface (Wave 4) — reads over the shared
 * `MessageDeliveryReceipt` table (SMS + transactional WhatsApp) plus the aggregate OTP rate.
 *
 * D4 SCOPING (isolation-critical): every read is scoped by `tenantScope(user)`, which is derived
 * ENTIRELY from the JWT — never from request input:
 *   - CLIENT_ADMIN → tenantScope returns their own clientId (they are never platform-wide), so the
 *     WHERE always pins `clientId` to their token's tenant. They can never see another tenant's rows.
 *   - GIFSY_ADMIN un-assumed → tenantScope returns undefined → no clientId filter → platform-wide.
 *   - GIFSY_ADMIN assumed into a tenant → tenantScope returns the assumed clientId → pinned.
 * The DTOs carry NO clientId param (and whitelist:true would strip one), so the tenant filter can
 * only ever come from the token. THIS is the leak-prevention invariant — a tenant seeing another
 * tenant's recipient phones/delivery data would be a breach.
 *
 * Funnel semantics: counts are CUMULATIVE delivery milestones (Sent ⊇ Delivered ⊇ Read), so the
 * funnel narrows monotonically — a DELIVERED message is also counted in `sent`. `deliveryRate` is
 * TERMINAL-based: delivered / (delivered + failed), null until a terminal outcome exists (mirrors
 * getOtpDeliveryStats), so messages still awaiting a delivery callback don't drag the rate down.
 */
@Injectable()
export class NotificationDeliveryReportService {
  /** Hard cap so a 90-day export can never build an unbounded workbook in memory. */
  private static readonly MAX_EXPORT_ROWS = 100_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly status: MessageDeliveryStatusService,
  ) {}

  /** Per-channel funnels + the OTP tile, all scoped + filtered identically. */
  async summary(
    user: JwtPayload,
    q: NotificationDeliverySummaryQueryDto,
  ): Promise<DeliverySummary> {
    const scope = tenantScope(user);
    const base = this.baseWhere(user, q);

    // Respect an optional channel filter by only computing the requested channel (the other stays
    // zeroed). Channel is added explicitly per-funnel — the base intentionally omits it.
    const wantSms = !q.channel || q.channel === 'SMS';
    const wantWa = !q.channel || q.channel === 'WHATSAPP';

    const smsWhere: Prisma.MessageDeliveryReceiptWhereInput = { ...base, channel: 'SMS' };
    const waWhere: Prisma.MessageDeliveryReceiptWhereInput = { ...base, channel: 'WHATSAPP' };

    // M1: "Sent" means "was DISPATCHED" (has a sentAt), NOT the SENT status bucket. A row that was
    // dispatched then delivery-FAILED carries sentAt but sits in the FAILED bucket, so the old
    // `SENT + delivered` understated Sent once real DLRs flipped rows. Count sentAt-not-null directly
    // so Sent ≥ delivered + delivery-failures always holds.
    const smsCounts = wantSms ? await this.statusCounts(smsWhere) : this.zeroCounts();
    const smsDispatched = wantSms ? await this.dispatchedCount(smsWhere) : 0;
    const waCounts = wantWa ? await this.statusCounts(waWhere) : this.zeroCounts();
    const waDispatched = wantWa ? await this.dispatchedCount(waWhere) : 0;

    // OTP: platform-authoritative for an un-assumed operator (scope undefined); tenant-scoped OTP is
    // a documented undercount (login/kyc OTPs carry no userId — only redemption OTPs set one), so it
    // is flagged `indicative` for the FE to label. See DELIVERY-STATUS-REPORTING-SCOPE.md §6 (D1).
    const otpRaw = await this.status.getOtpDeliveryStats(
      scope ? { clientId: scope } : undefined,
    );

    return {
      sms: this.smsFunnel(smsCounts, smsDispatched),
      whatsapp: this.whatsappFunnel(waCounts, waDispatched),
      otp: {
        // D2: pass total + pending through so the tile has a denominator, not just a rate.
        total: otpRaw.total,
        sent: otpRaw.sent,
        delivered: otpRaw.delivered,
        failed: otpRaw.failed,
        pending: otpRaw.pending,
        deliveryRate: otpRaw.deliveryRate,
        indicative: scope != null,
      },
    };
  }

  /** Paginated per-message receipt list, newest first, scoped + filtered. */
  async list(
    user: JwtPayload,
    q: NotificationDeliveryListQueryDto,
  ): Promise<DeliveryListPage> {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const skip = (page - 1) * pageSize;
    const where = this.listWhere(user, q);

    const [rows, total] = await Promise.all([
      this.prisma.messageDeliveryReceipt.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: this.rowSelect,
      }),
      this.prisma.messageDeliveryReceipt.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toItem(r)),
      total,
      page,
      pageSize,
    };
  }

  /** Excel export — one row per receipt, scoped + filtered identically to the list. */
  async export(
    user: JwtPayload,
    q: NotificationDeliverySummaryQueryDto,
  ): Promise<StreamableFile> {
    const where = this.listWhere(user, q);
    const rows = await this.prisma.messageDeliveryReceipt.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: NotificationDeliveryReportService.MAX_EXPORT_ROWS,
      select: this.rowSelect,
    });

    const iso = (d: Date | null) => (d ? d.toISOString() : '');
    const sheetRows: Record<string, string>[] = rows.map((r) => ({
      Channel: r.channel,
      Event: r.eventKey ?? '',
      'Recipient Phone': r.recipientPhone ?? '',
      Status: r.status,
      'Sent At': iso(r.sentAt),
      'Delivered At': iso(r.deliveredAt),
      'Read At': iso(r.readAt),
      'Failure Reason': r.failureReason ?? '',
      'Created At': iso(r.createdAt),
    }));

    // M3: the export is hard-capped at MAX_EXPORT_ROWS with no signal, while the on-screen totals show
    // the TRUE count — a silently-clipped xlsx would mismatch and be read as complete. When we hit the
    // cap, append a visible notice row so the reader knows the file is truncated and how to fix it.
    if (rows.length === NotificationDeliveryReportService.MAX_EXPORT_ROWS) {
      sheetRows.push({
        Channel: `⚠️ Export truncated at ${NotificationDeliveryReportService.MAX_EXPORT_ROWS.toLocaleString(
          'en-US',
        )} rows — narrow the date range for a complete export.`,
        Event: '',
        'Recipient Phone': '',
        Status: '',
        'Sent At': '',
        'Delivered At': '',
        'Read At': '',
        'Failure Reason': '',
        'Created At': '',
      });
    }

    // buildXlsx derives the header from the first row's keys; an empty result still needs a header
    // row so the sheet isn't blank (mirrors the broadcast report).
    const finalRows =
      sheetRows.length > 0
        ? sheetRows
        : [
            {
              Channel: '',
              Event: '',
              'Recipient Phone': '',
              Status: '',
              'Sent At': '',
              'Delivered At': '',
              'Read At': '',
              'Failure Reason': '',
              'Created At': '',
            },
          ];

    const buffer = buildXlsx([{ name: 'Delivery', rows: finalRows }]);
    const filename = `notification-delivery-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  // ── scoping + filter builders ───────────────────────────────────────────────

  /** The columns every row-returning read selects (NEVER selects providerResponse / crqid). */
  private readonly rowSelect = {
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
  } satisfies Prisma.MessageDeliveryReceiptSelect;

  /**
   * Base WHERE = tenant scope (from the JWT) + optional event + optional date window. Channel is
   * NOT included here — the summary adds it per-funnel; the list/export add it via listWhere.
   */
  private baseWhere(
    user: JwtPayload,
    q: NotificationDeliverySummaryQueryDto,
  ): Prisma.MessageDeliveryReceiptWhereInput {
    const scope = tenantScope(user);
    // INFO-2 (defence-in-depth): a non-platform-wide caller (anyone but an un-assumed GIFSY_ADMIN)
    // MUST resolve to a concrete tenant scope. If it were ever falsy (e.g. a token with an empty
    // clientId) we would fall through to an UNSCOPED, platform-wide read — a cross-tenant leak. Not
    // reachable today (TenantGuard 403s an empty clientId upstream), but fail closed here rather than
    // silently widen. platformWide() is true ONLY for the un-assumed OWNER, whose unscoped read is legit.
    if (!platformWide(user) && !scope) {
      throw new ForbiddenException('Delivery report requires a tenant scope.');
    }
    const where: Prisma.MessageDeliveryReceiptWhereInput = {};
    // ISOLATION invariant: the clientId filter comes ONLY from the token-derived scope.
    if (scope) where.clientId = scope;
    if (q.event) where.eventKey = q.event;
    const createdAt = this.dateRange(q.from, q.to);
    if (createdAt) where.createdAt = createdAt;
    return where;
  }

  /** List/export WHERE = base + the optional channel filter. */
  private listWhere(
    user: JwtPayload,
    q: NotificationDeliverySummaryQueryDto,
  ): Prisma.MessageDeliveryReceiptWhereInput {
    return {
      ...this.baseWhere(user, q),
      ...(q.channel ? { channel: q.channel } : {}),
    };
  }

  private dateRange(
    from?: string,
    to?: string,
  ): Prisma.DateTimeFilter | undefined {
    // A date-only string (the FE's <input type="date">, e.g. "2026-08-25") is interpreted as an IST
    // calendar day: `from` → start of that IST day; `to` → INCLUSIVE of the whole IST day (via an
    // exclusive `lt` at the start of the next IST day) so "To = today" doesn't drop all of today's
    // messages (every receipt has a time > IST-midnight). A full ISO datetime is used as given.
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    const range: Prisma.DateTimeFilter = {};
    if (from) {
      const gte = DATE_ONLY.test(from) ? new Date(`${from}T00:00:00+05:30`) : new Date(from);
      if (!Number.isNaN(gte.getTime())) range.gte = gte;
    }
    if (to) {
      if (DATE_ONLY.test(to)) {
        const startOfIstDay = new Date(`${to}T00:00:00+05:30`);
        if (!Number.isNaN(startOfIstDay.getTime())) {
          range.lt = new Date(startOfIstDay.getTime() + 24 * 60 * 60 * 1000); // start of next IST day (exclusive)
        }
      } else {
        const lte = new Date(to);
        if (!Number.isNaN(lte.getTime())) range.lte = lte;
      }
    }
    return Object.keys(range).length > 0 ? range : undefined;
  }

  // ── counting + funnel math ──────────────────────────────────────────────────

  private zeroCounts(): StatusCounts {
    return { QUEUED: 0, SENT: 0, DELIVERED: 0, READ: 0, FAILED: 0 };
  }

  private async statusCounts(
    where: Prisma.MessageDeliveryReceiptWhereInput,
  ): Promise<StatusCounts> {
    const groups = await this.prisma.messageDeliveryReceipt.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    const counts = this.zeroCounts();
    for (const g of groups) {
      counts[g.status as keyof StatusCounts] = g._count._all;
    }
    return counts;
  }

  /**
   * M1: how many rows in this scope were DISPATCHED (have a sentAt), regardless of their current
   * status bucket. This is the true "Sent" — it includes rows that were dispatched then FAILED
   * delivery (sentAt set, but sitting in the FAILED bucket), which the status buckets alone can't
   * express. Guarantees Sent ≥ delivered + delivery-failures.
   */
  private async dispatchedCount(
    where: Prisma.MessageDeliveryReceiptWhereInput,
  ): Promise<number> {
    return this.prisma.messageDeliveryReceipt.count({
      where: { ...where, sentAt: { not: null } },
    });
  }

  private smsFunnel(c: StatusCounts, dispatched: number): SmsFunnel {
    // READ shouldn't occur for SMS, but fold it into delivered defensively.
    const delivered = c.DELIVERED + c.READ;
    // M1: Sent = rows actually dispatched (sentAt != null), so it never understates delivered+failed.
    const sent = dispatched;
    const failed = c.FAILED;
    const pending = c.QUEUED;
    const terminal = delivered + failed;
    return {
      sent,
      delivered,
      failed,
      pending,
      deliveryRate: terminal > 0 ? delivered / terminal : null,
    };
  }

  private whatsappFunnel(c: StatusCounts, dispatched: number): WhatsappFunnel {
    const read = c.READ;
    const delivered = c.DELIVERED + c.READ;
    const sent = dispatched; // M1: dispatched (sentAt != null), not the SENT bucket
    const failed = c.FAILED;
    const pending = c.QUEUED;
    const terminal = delivered + failed;
    return {
      sent,
      delivered,
      read,
      failed,
      pending,
      deliveryRate: terminal > 0 ? delivered / terminal : null,
    };
  }

  private toItem(r: {
    id: string;
    channel: string;
    eventKey: string | null;
    recipientPhone: string | null;
    status: string;
    sentAt: Date | null;
    deliveredAt: Date | null;
    readAt: Date | null;
    failureReason: string | null;
    createdAt: Date | null;
  }): DeliveryListItem {
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      id: r.id,
      channel: r.channel,
      eventKey: r.eventKey,
      recipientPhone: r.recipientPhone,
      status: r.status,
      sentAt: iso(r.sentAt),
      deliveredAt: iso(r.deliveredAt),
      readAt: iso(r.readAt),
      failureReason: r.failureReason,
      createdAt: iso(r.createdAt),
    };
  }
}
