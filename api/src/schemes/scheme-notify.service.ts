import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from '../notifications/msg91.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { platformWide } from '../common/tenant-scope';
import {
  ancestorSalesUserIds,
  matchesOutletFilter,
  phoneLast10,
} from '../common/audience/audience.helpers';
import {
  BroadcastChannel,
  BroadcastDto,
  BroadcastRecipientFilterDto,
} from './dto/scheme-notify.dto';

// The audience-resolution primitives (ancestorSalesUserIds, phoneLast10, filter
// matching) were generalised out of this file into common/audience/audience.helpers.ts
// so the WhatsApp Broadcasts module reuses the SAME logic. Re-exported here so the
// existing scheme-notify unit tests (which import ancestorSalesUserIds from this
// module) keep working unchanged and to document that this file still owns the
// scheme-roster resolution that consumes them.
export {
  ancestorSalesUserIds,
  type SalesReportingEdge,
} from '../common/audience/audience.helpers';

/**
 * Stable event tag for the MessageDeliveryReceipt rows written by scheme broadcasts
 * (D5 — member-facing scheme SMS/WhatsApp delivery tracking). Groups these sends in the
 * per-tenant/per-event delivery report (D4).
 */
const SCHEME_NOTIFY_EVENT_KEY = 'SCHEME_NOTIFY';

/**
 * Scheme notifications (D29) — an ad-hoc broadcast tool inside Scheme Management.
 *
 * GIFSY_ADMIN-only (enforced at the controller). Resolves recipients from the
 * scheme's roster (eligible outlets and/or the tagged sales team + up-hierarchy),
 * sends per-recipient via MSG91 DIRECTLY (fire-and-forget, mirroring KYC — a send
 * throw must never fail the batch), and writes ONE SchemeBroadcast send-log row
 * with sentCount/failedCount. Can be called multiple times per scheme.
 */
@Injectable()
export class SchemeNotifyService {
  private readonly logger = new Logger(SchemeNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly msg91: Msg91Service,
  ) {}

  /**
   * Send a broadcast for a scheme and log it. Returns the send-log row + counts.
   *
   * platformWide-aware: an un-assumed GIFSY operator resolves ANY tenant's scheme,
   * then EVERY downstream query (recipient resolution, the send-log row) is pinned to
   * the scheme's OWN `clientId` — never the caller's `gifsy` clientId. Everyone else
   * is hard-pinned to `user.clientId`, so a tenant caller can never reach another
   * tenant's scheme.
   */
  async broadcast(user: JwtPayload, schemeId: string, dto: BroadcastDto) {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, ...(platformWide(user) ? {} : { clientId: user.clientId }) },
      select: { id: true, clientId: true },
    });
    if (!scheme) throw new NotFoundException('Scheme not found');
    const clientId = scheme.clientId;
    const sentByUserId = user.sub ?? null;

    const filter = dto.recipientFilter;

    const phones = await this.resolveRecipientPhones(schemeId, clientId, dto);

    let sentCount = 0;
    let failedCount = 0;
    const bodyValues = dto.bodyValues ?? [];
    // Serial fire-and-forget (mirrors KYC — the NotificationQueue worker is a seam
    // only). A throw on any single recipient is caught, counted, and swallowed so
    // one bad number can never abort the whole broadcast.
    for (const phone of phones) {
      try {
        await this.send(clientId, dto.channel, phone, dto.templateId, bodyValues);
        sentCount++;
      } catch (e) {
        failedCount++;
        this.logger.warn(
          `[scheme-broadcast] send failed for a recipient (scheme ${schemeId}, channel ${dto.channel}): ${e}`,
        );
      }
    }

    const broadcast = await this.prisma.schemeBroadcast.create({
      data: {
        clientId,
        schemeId,
        channel: dto.channel,
        templateId: dto.templateId,
        recipientScope: dto.recipientScope,
        recipientFilter: filter ? (filter as Prisma.InputJsonValue) : Prisma.JsonNull,
        sentCount,
        failedCount,
        sentByUserId: sentByUserId ?? undefined,
      },
    });

    return { broadcast, recipientCount: phones.size, sentCount, failedCount };
  }

  /** Broadcast send history for a scheme (newest first). platformWide-aware. */
  async listBroadcasts(user: JwtPayload, schemeId: string) {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, ...(platformWide(user) ? {} : { clientId: user.clientId }) },
      select: { id: true, clientId: true },
    });
    if (!scheme) throw new NotFoundException('Scheme not found');

    const broadcasts = await this.prisma.schemeBroadcast.findMany({
      where: { schemeId, clientId: scheme.clientId },
      orderBy: { createdAt: 'desc' },
    });
    return { broadcasts };
  }

  /**
   * Dry-run preview: resolve the recipient set for the given scope/filter and return
   * ONLY the count. Sends nothing and writes NO SchemeBroadcast row. platformWide-aware
   * (same scheme-resolution rules as `broadcast`).
   */
  async previewBroadcast(user: JwtPayload, schemeId: string, dto: BroadcastDto) {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, ...(platformWide(user) ? {} : { clientId: user.clientId }) },
      select: { id: true, clientId: true },
    });
    if (!scheme) throw new NotFoundException('Scheme not found');

    const phones = await this.resolveRecipientPhones(schemeId, scheme.clientId, dto);
    return { recipientCount: phones.size };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Recipient resolution
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The de-duped canonical-phone recipient set for a scheme + scope/filter. Shared by
   * `broadcast` (the send path) and `previewBroadcast` (the dry-run count). De-dup is on
   * the canonical phone form so an outlet owner who is ALSO a resolved sales recipient
   * (unlikely, but possible) is never messaged — or billed — twice.
   */
  private async resolveRecipientPhones(
    schemeId: string,
    clientId: string,
    dto: BroadcastDto,
  ): Promise<Set<string>> {
    const filter = dto.recipientFilter;
    const phones = new Set<string>();
    if (dto.recipientScope === 'OUTLETS' || dto.recipientScope === 'BOTH') {
      for (const p of await this.resolveOutletPhones(schemeId, clientId, filter)) phones.add(p);
    }
    if (dto.recipientScope === 'SALES' || dto.recipientScope === 'BOTH') {
      for (const p of await this.resolveSalesPhones(schemeId, clientId, filter)) phones.add(p);
    }
    return phones;
  }

  /**
   * Phones for the OUTLETS scope: the matched outlet/owner phone of each roster
   * row. Standalone (unmatched) rows carry no outlet-master attributes/phone —
   * they are excluded whenever any outlet filter is set, and contribute no phone
   * regardless. Prefers the owner (matchedPartner) phone over the outlet phone.
   */
  private async resolveOutletPhones(
    schemeId: string,
    clientId: string,
    filter?: BroadcastRecipientFilterDto,
  ): Promise<string[]> {
    const rows = await this.prisma.schemeOutlet.findMany({
      // A soft-removed roster row contributes no broadcast recipient.
      where: { schemeId, clientId, deletedAt: null },
      select: {
        matchedOutletId: true,
        matchedPartner: { select: { phone: true } },
        matchedOutlet: {
          select: {
            phone: true,
            zone: true,
            programName: true,
            programCategory: true,
            state: true,
            outletTypeId: true,
          },
        },
      },
    });

    const phones: string[] = [];
    for (const r of rows) {
      const o = r.matchedOutlet;
      // Standalone rows (no matched outlet) can never satisfy an outlet filter and
      // have no phone to notify.
      if (!o) continue;
      // Shared inclusion-only facet matching (identical semantics to the old inline
      // hasOutletFilter/inFilter): an absent/empty facet matches all.
      if (
        !matchesOutletFilter(filter, {
          zone: o.zone,
          programName: o.programName,
          programCategory: o.programCategory,
          state: o.state,
          outletTypeId: o.outletTypeId,
        })
      ) {
        continue;
      }
      const phone = phoneLast10(r.matchedPartner?.phone ?? o.phone);
      if (/^\d{10}$/.test(phone)) phones.push(phone);
    }
    return phones;
  }

  /**
   * Phones for the SALES scope: the roster's tagged employees + their whole
   * up-hierarchy (D20), resolved SalesUser → User.phone. `taggedSalesUserIds`
   * (when supplied) narrows the tagged set before the ancestor walk.
   */
  private async resolveSalesPhones(
    schemeId: string,
    clientId: string,
    filter?: BroadcastRecipientFilterDto,
  ): Promise<string[]> {
    const tagRows = await this.prisma.schemeOutlet.findMany({
      // A soft-removed roster row contributes no tagged-employee recipient.
      where: { schemeId, clientId, taggedSalesUserId: { not: null }, deletedAt: null },
      select: { taggedSalesUserId: true },
    });

    let tagged = [...new Set(tagRows.map((r) => r.taggedSalesUserId as string))];
    const narrow = filter?.taggedSalesUserIds;
    if (narrow && narrow.length > 0) {
      const allow = new Set(narrow);
      tagged = tagged.filter((id) => allow.has(id));
    }
    if (tagged.length === 0) return [];

    // Tenant-scoped reporting edges (id → manager) + the SalesUser→User link. Loaded
    // WITHOUT the deletedAt filter so the up-hierarchy walk does NOT truncate at a
    // soft-deleted mid-chain manager (B-LOW-2 — "skip vacant, next active up"); the
    // FINAL recipient set is then narrowed to ACTIVE (non-deleted) sales users.
    const salesUsers = await this.prisma.salesUser.findMany({
      where: { clientId },
      select: { id: true, reportingToId: true, userId: true, deletedAt: true },
    });

    const wanted = ancestorSalesUserIds(tagged, salesUsers);
    const userIds = salesUsers
      .filter((s) => wanted.has(s.id) && !s.deletedAt)
      .map((s) => s.userId);
    if (userIds.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds }, clientId },
      select: { phone: true },
    });

    const phones: string[] = [];
    for (const u of users) {
      const phone = phoneLast10(u.phone);
      if (/^\d{10}$/.test(phone)) phones.push(phone);
    }
    return phones;
  }

  /**
   * One recipient send. WHATSAPP → the template API; SMS → the OTP/SMS template
   * API (a single {{var}} = bodyValues[0], the MSG91 SMS/OTP template shape).
   * Both throw on failure — the caller wraps them fire-and-forget.
   *
   * ── Additive per-message delivery receipt (D3/D5 — DELIVERY-STATUS-REPORTING-SCOPE.md) ──
   * Each member-facing send writes a best-effort MessageDeliveryReceipt so it lands in the
   * delivery report (previously these sends were tracked NOWHERE — neither the receipt table
   * nor the OTP tile). BEST-EFFORT + billing-safe, mirroring the SMS leg in push-delivery.worker
   * and the transactional-WhatsApp leg in notifications.service:
   *   - WHATSAPP → create a QUEUED receipt with a generated crqid, pass {crqid} to
   *     sendWhatsappTemplate (echoed back on the outbound-report webhook → correlated by crqid),
   *     then flip QUEUED→SENT with the returned requestId. (The existing /v1/whatsapp/status
   *     delegation already resolves transactional receipts.)
   *   - SMS (via sendOtp) → sendOtp has NO crqid param and its DLR echoes only a requestId, so we
   *     still write a QUEUED receipt with a generated crqid ONLY to satisfy the unique PK column
   *     (MSG91 never sees it) and store the requestId sendOtp returns — correlation then happens
   *     via ladder step 2 (receipt-by-msg91RequestId). sendOtp's signature is UNCHANGED (we do NOT
   *     route through sendSms, which would change the DLT template behaviour).
   * A receipt-write failure NEVER affects the send (the helpers swallow their own errors and the
   * send fires unchanged / with no crqid), and a billed send is never left FAILED (SENT is flipped
   * before the catch, and the FAILED flip is guarded on status:'QUEUED'). The send STILL throws on
   * failure so the caller's fire-and-forget sentCount/failedCount tally is unchanged.
   */
  private async send(
    clientId: string,
    channel: BroadcastChannel,
    phone: string,
    templateId: string,
    bodyValues: string[],
  ): Promise<void> {
    if (channel === 'WHATSAPP') {
      const receipt = await this.createReceipt(clientId, 'WHATSAPP', phone);
      try {
        // crqid passed ONLY when a receipt exists — a no-receipt call (gate off / write failure)
        // stays byte-identical to the prior 3-arg send. Destructure defensively (`?? {}`).
        const sendRes = receipt
          ? await this.msg91.sendWhatsappTemplate(phone, templateId, bodyValues, {
              crqid: receipt.crqid,
            })
          : await this.msg91.sendWhatsappTemplate(phone, templateId, bodyValues);
        await this.markReceiptSent(receipt, (sendRes ?? {}).requestId ?? null);
      } catch (e) {
        // Guarded (QUEUED-only): only an UNBILLED send (the send threw, receipt still QUEUED) flips
        // to FAILED; a billed send is already SENT → no-op. Rethrow so the caller counts the failure.
        await this.markReceiptFailed(receipt, String(e));
        throw e;
      }
      return;
    }

    // SMS via sendOtp — receipt gets a generated crqid (for the required-unique PK column only;
    // MSG91 never receives it because sendOtp takes no crqid), correlation is by the returned
    // requestId (ladder step 2). sendOtp's signature is unchanged.
    const receipt = await this.createReceipt(clientId, 'SMS', phone);
    try {
      const sendRes = await this.msg91.sendOtp(phone, bodyValues[0] ?? '', 'SMS', templateId);
      await this.markReceiptSent(receipt, (sendRes ?? {}).requestId ?? null);
    } catch (e) {
      await this.markReceiptFailed(receipt, String(e));
      throw e;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Delivery receipts (D3/D5) — best-effort, gated, never-throwing. Mirrors the
  // helpers in push-delivery.worker (SMS) and notifications.service (WhatsApp).
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a QUEUED MessageDeliveryReceipt for a to-be-sent scheme notification. Returns
   * `{ id, crqid }` or null when a receipt can't be written — BEST-EFFORT: this must never break
   * the send, so every failure (feature off, missing clientId, pre-migration table, transient DB
   * error) is swallowed with a log and returns null (the send then proceeds without a crqid).
   *
   * The crqid is 32 hex chars from Node's built-in `crypto` (alphanumeric, hyphen-free per the
   * MSG91 CRQID constraint) — NO external dependency (a new npm dep would pass gates but crash at boot).
   */
  private async createReceipt(
    clientId: string,
    channel: 'SMS' | 'WHATSAPP',
    recipientPhone: string,
  ): Promise<{ id: string; crqid: string } | null> {
    // M2 dormancy gate — the ENTIRE delivery-receipt feature is OFF unless DELIVERY_RECEIPTS_ENABLED
    // === 'true'. Returning null here makes every scheme send byte-identical to pre-feature behaviour
    // (no receipt row, WhatsApp fires the 3-arg send with NO crqid).
    if (process.env.DELIVERY_RECEIPTS_ENABLED !== 'true') return null;
    // Never write an unscoped receipt — an empty clientId would mis-scope the row in the per-tenant
    // (D4) delivery report.
    if (!clientId?.trim()) return null;
    const crqid = randomBytes(16).toString('hex');
    try {
      return await this.prisma.messageDeliveryReceipt.create({
        data: {
          clientId,
          channel,
          crqid,
          eventKey: SCHEME_NOTIFY_EVENT_KEY,
          recipientPhone,
          status: 'QUEUED',
        },
        select: { id: true, crqid: true },
      });
    } catch (e) {
      this.logger.warn(`[scheme-broadcast] delivery-receipt create skipped: ${e}`);
      return null;
    }
  }

  /**
   * Flip a receipt QUEUED→SENT (guarded on status:'QUEUED' so it's idempotent and can never be
   * downgraded from a terminal state later). BEST-EFFORT + billing-safe: a billed send must persist
   * SENT if at all possible, so we NEVER throw and NEVER write FAILED here — a total failure logs.
   */
  private async markReceiptSent(
    receipt: { id: string } | null,
    requestId: string | null,
  ): Promise<void> {
    if (!receipt) return;
    try {
      await this.prisma.messageDeliveryReceipt.updateMany({
        where: { id: receipt.id, status: 'QUEUED' },
        data: { status: 'SENT', sentAt: new Date(), msg91RequestId: requestId ?? undefined },
      });
    } catch (e) {
      this.logger.warn(
        `[scheme-broadcast] receipt ${receipt.id} SENT write failed (left non-FAILED to avoid a false failure on a billed send): ${e}`,
      );
    }
  }

  /**
   * Flip a receipt QUEUED→FAILED (guarded on status:'QUEUED'). Only ever applies to a receipt that
   * was never marked SENT — i.e. the send genuinely threw (unbilled). A receipt already SENT (billed
   * message) does NOT match the guard, so a billed message's receipt is never downgraded to FAILED.
   */
  private async markReceiptFailed(
    receipt: { id: string } | null,
    reason: string,
  ): Promise<void> {
    if (!receipt) return;
    try {
      await this.prisma.messageDeliveryReceipt.updateMany({
        where: { id: receipt.id, status: 'QUEUED' },
        data: { status: 'FAILED', failureReason: reason.slice(0, 500) },
      });
    } catch (e) {
      this.logger.warn(`[scheme-broadcast] receipt ${receipt.id} FAILED write failed: ${e}`);
    }
  }
}
