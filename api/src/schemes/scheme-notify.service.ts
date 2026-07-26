import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from '../notifications/msg91.service';
import {
  BroadcastChannel,
  BroadcastDto,
  BroadcastRecipientFilterDto,
} from './dto/scheme-notify.dto';

/** Minimal reporting edge for the up-hierarchy walk (id → its manager). */
export interface SalesReportingEdge {
  id: string;
  reportingToId: string | null;
}

/**
 * Pure: given the tagged employees on a scheme's roster, return the set of
 * SalesUser ids that should be notified for the SALES scope — the tagged users
 * themselves PLUS every ANCESTOR up their reporting chain (D20: "the tagged
 * employee and everyone above them"). Walks `reportingToId` upward from each
 * tagged id. Cycle-safe + bounded.
 *
 * Kept local (not in sales-hierarchy-access.helper) so this stream owns it and
 * so it can be unit-tested with plain arrays.
 */
export function ancestorSalesUserIds(
  taggedIds: string[],
  edges: SalesReportingEdge[],
): Set<string> {
  const parentOf = new Map<string, string | null>();
  for (const e of edges) parentOf.set(e.id, e.reportingToId);

  const out = new Set<string>();
  for (const start of taggedIds) {
    if (!start || !parentOf.has(start)) continue; // unknown/foreign id — skip
    const seen = new Set<string>();
    let current: string | null = start;
    while (current && !seen.has(current)) {
      seen.add(current);
      out.add(current);
      current = parentOf.get(current) ?? null;
    }
  }
  return out;
}

/** Canonical last-10-digit phone form (strips +91/91/punctuation). Empty when no digits. */
function phoneLast10(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').slice(-10);
}

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
   * Tenant-scoped by `clientId` (the scheme must belong to the caller's tenant).
   */
  async broadcast(
    schemeId: string,
    clientId: string,
    sentByUserId: string | null,
    dto: BroadcastDto,
  ) {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, clientId },
      select: { id: true },
    });
    if (!scheme) throw new NotFoundException('Scheme not found');

    const filter = dto.recipientFilter;

    // De-dup recipients across scopes on the canonical phone form so an outlet
    // owner who is ALSO a resolved sales recipient (unlikely, but possible) is
    // never messaged — or billed — twice.
    const phones = new Set<string>();
    if (dto.recipientScope === 'OUTLETS' || dto.recipientScope === 'BOTH') {
      for (const p of await this.resolveOutletPhones(schemeId, clientId, filter)) phones.add(p);
    }
    if (dto.recipientScope === 'SALES' || dto.recipientScope === 'BOTH') {
      for (const p of await this.resolveSalesPhones(schemeId, clientId, filter)) phones.add(p);
    }

    let sentCount = 0;
    let failedCount = 0;
    const bodyValues = dto.bodyValues ?? [];
    // Serial fire-and-forget (mirrors KYC — the NotificationQueue worker is a seam
    // only). A throw on any single recipient is caught, counted, and swallowed so
    // one bad number can never abort the whole broadcast.
    for (const phone of phones) {
      try {
        await this.send(dto.channel, phone, dto.templateId, bodyValues);
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

  /** Broadcast send history for a scheme (newest first). Tenant-scoped. */
  async listBroadcasts(schemeId: string, clientId: string) {
    const scheme = await this.prisma.scheme.findFirst({
      where: { id: schemeId, clientId },
      select: { id: true },
    });
    if (!scheme) throw new NotFoundException('Scheme not found');

    const broadcasts = await this.prisma.schemeBroadcast.findMany({
      where: { schemeId, clientId },
      orderBy: { createdAt: 'desc' },
    });
    return { broadcasts };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Recipient resolution
  // ───────────────────────────────────────────────────────────────────────────

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
      where: { schemeId, clientId },
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

    const hasOutletFilter =
      !!filter &&
      [
        filter.zones,
        filter.programNames,
        filter.programCategories,
        filter.outletTypeIds,
        filter.states,
      ].some((f) => Array.isArray(f) && f.length > 0);

    const inFilter = (vals?: string[], v?: string | null): boolean =>
      !vals || vals.length === 0 || (v != null && vals.includes(v));

    const phones: string[] = [];
    for (const r of rows) {
      const o = r.matchedOutlet;
      // Standalone rows (no matched outlet) can never satisfy an outlet filter and
      // have no phone to notify.
      if (!o) continue;
      if (hasOutletFilter) {
        if (
          !inFilter(filter?.zones, o.zone) ||
          !inFilter(filter?.programNames, o.programName) ||
          !inFilter(filter?.programCategories, o.programCategory) ||
          !inFilter(filter?.states, o.state) ||
          !inFilter(filter?.outletTypeIds, o.outletTypeId)
        ) {
          continue;
        }
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
      where: { schemeId, clientId, taggedSalesUserId: { not: null } },
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
   */
  private async send(
    channel: BroadcastChannel,
    phone: string,
    templateId: string,
    bodyValues: string[],
  ): Promise<void> {
    if (channel === 'WHATSAPP') {
      await this.msg91.sendWhatsappTemplate(phone, templateId, bodyValues);
      return;
    }
    await this.msg91.sendOtp(phone, bodyValues[0] ?? '', 'SMS', templateId);
  }
}
