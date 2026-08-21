import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { NotificationChannel, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from './msg91.service';
import { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
import { EventKey, VARIABLE_CONTRACTS, defaultConfig } from '../notification-templates/notification-templates.config';

export interface EnqueueNotificationParams {
  userId: string;
  channel: NotificationChannel;
  body: string;
  subject?: string;
  recipientPhone?: string;
  recipientEmail?: string;
  recipientFcm?: string;
  templateId?: string;
  variables?: Record<string, unknown>;
  scheduledAt?: Date;
}

/** Write an IN_APP bell-feed row directly (status SENT). */
export interface WriteInAppParams {
  userId: string;
  body: string;
  subject?: string;
  /** Deep-link stored in variables.url so the bell feed can navigate on tap. */
  url?: string;
  variables?: Record<string, unknown>;
}

/** Fan a user-facing event out to BOTH the in-app bell feed and PUSH. */
export interface NotifyUserParams {
  userId: string;
  body: string;
  subject?: string;
  url?: string;
  /** Optional domain event tag, folded into variables (mirrors existing push sites). */
  event?: string;
  variables?: Record<string, unknown>;
}

/**
 * Fan a user-facing event out to the free channels (IN_APP + PUSH, unchanged) PLUS the
 * config-driven PAID channels (SMS enqueue + WhatsApp direct), resolved per-tenant from
 * NotificationTemplatesService.getChannelConfig(clientId, eventKey).
 */
export interface NotifyUserWithChannelsParams {
  /** The tenant whose notification-templates config decides the paid-channel routing. */
  clientId: string;
  /** The recipient's login user id (for IN_APP + PUSH). */
  userId: string;
  /** One of the canonical EVENT_KEYS — selects the config row + the variable contract. */
  eventKey: EventKey;
  /** The recipient's bare 10-digit mobile (for SMS + WhatsApp). Missing → paid channels skipped. */
  recipientPhone?: string | null;
  /**
   * NAMED variable values for this event. The method maps them onto the SMS + WhatsApp ordered
   * variable contracts (VARIABLE_CONTRACTS[eventKey]); an absent name resolves to ''.
   */
  vars?: Record<string, string | number | null | undefined>;
  subject?: string;
  body: string;
  url?: string;
  /** Optional domain event tag folded into the IN_APP/PUSH variables (mirrors notifyUser). */
  event?: string;
  /**
   * Whether to ALSO write the free channels (IN_APP feed + PUSH). Default true. Set false for an
   * event that is paid-channel-only today (e.g. KYC_SUBMITTED, which historically sent ONLY the
   * owner WhatsApp and no bell-feed/push row) so routing it here stays behaviour-neutral.
   */
  includeFreeChannels?: boolean;
}

/** One item in the bell feed. */
export interface FeedItem {
  id: string;
  subject: string | null;
  body: string;
  url: string | null;
  createdAt: Date;
  readAt: Date | null;
}

export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
}

const FEED_DEFAULT_LIMIT = 25;
const FEED_MAX_LIMIT = 50;

/**
 * Notifications — the enqueue SEAM plus the in-app "bell feed" (Phase 1).
 *
 * The kept DB queue model (`NotificationQueue`) is the source of truth. Domains call
 * `enqueue()` to register an asynchronously-delivered notification (PUSH is drained by
 * push-delivery.worker; SMS/EMAIL delivery is Phase 2 — those rows sit QUEUED).
 *
 * IN_APP is different: it is not "delivered" by a worker — it IS the feed. `writeInApp()`
 * inserts a row already marked SENT (processedAt = now), so the PUSH drainer
 * (channel='PUSH' AND status='QUEUED') never touches it and it shows in the bell
 * immediately. `notifyUser()` is the fan-out helper domains call for a user-facing
 * event: it writes the IN_APP feed row AND enqueues the PUSH row (identical to the
 * existing hand-written push enqueues).
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  // Lazily-resolved via ModuleRef (NOT constructor-injected) to break the provider cycle
  // NotificationsService → NotificationTemplatesService → AdminCoreService →
  // SalesNotificationsService → NotificationsService. Resolved once at bootstrap; a resolution
  // failure leaves it null and paid-channel routing simply falls back to free channels only.
  private templates: NotificationTemplatesService | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly msg91: Msg91Service,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    try {
      // strict:false → resolve the exported provider from the global container without importing
      // its module here (which would re-introduce the cycle above).
      this.templates = this.moduleRef.get(NotificationTemplatesService, { strict: false });
    } catch (e) {
      this.logger.warn(`[notifications] NotificationTemplatesService unavailable; paid channels disabled: ${e}`);
      this.templates = null;
    }
  }

  /** Enqueue a notification for later delivery by the worker. Returns the queued row id. */
  async enqueue(params: EnqueueNotificationParams): Promise<{ id: string }> {
    const row = await this.prisma.notificationQueue.create({
      data: {
        userId: params.userId,
        channel: params.channel,
        status: 'QUEUED',
        body: params.body,
        subject: params.subject,
        recipientPhone: params.recipientPhone,
        recipientEmail: params.recipientEmail,
        recipientFcm: params.recipientFcm,
        templateId: params.templateId,
        variables: (params.variables ?? undefined) as Prisma.InputJsonValue | undefined,
        scheduledAt: params.scheduledAt,
      },
      select: { id: true },
    });
    return row;
  }

  /**
   * Write an IN_APP bell-feed row directly as SENT (never drained). Best-effort: a feed
   * write must NEVER fail the caller's money/KYC/domain path, so failures are swallowed.
   * The deep-link is stored in `variables.url` (mirrors the PUSH convention).
   */
  async writeInApp(params: WriteInAppParams): Promise<{ id: string } | null> {
    const variables = this.mergeVariables(params.variables, params.url);
    try {
      return await this.prisma.notificationQueue.create({
        data: {
          userId: params.userId,
          channel: 'IN_APP',
          status: 'SENT',
          processedAt: new Date(),
          body: params.body,
          subject: params.subject,
          variables: variables as Prisma.InputJsonValue | undefined,
        },
        select: { id: true },
      });
    } catch (e) {
      this.logger.warn(`[notifications] writeInApp failed for ${params.userId}: ${e}`);
      return null;
    }
  }

  /**
   * Fan a user-facing event out to the bell feed (IN_APP, immediate) AND PUSH (QUEUED,
   * drained by the push worker). Both are best-effort — neither ever throws into the
   * caller's domain path. Keeps the PUSH row shape identical to the hand-written sites.
   */
  async notifyUser(params: NotifyUserParams): Promise<void> {
    const variables = this.mergeVariables(
      params.event ? { event: params.event, ...(params.variables ?? {}) } : params.variables,
      params.url,
    );
    // (a) IN_APP feed row — SENT immediately.
    await this.writeInApp({
      userId: params.userId,
      subject: params.subject,
      body: params.body,
      variables,
    });
    // (b) PUSH row — QUEUED for the push-delivery worker.
    await this.enqueue({
      userId: params.userId,
      channel: 'PUSH',
      subject: params.subject,
      body: params.body,
      variables,
    }).catch((e) => this.logger.warn(`[notifications] notifyUser push enqueue failed for ${params.userId}: ${e}`));
  }

  /**
   * The SINGLE canonical fan-out for a user-facing event across ALL channels:
   *   - IN_APP + PUSH exactly as notifyUser (unchanged, always attempted, best-effort);
   *   - the config-driven PAID channels resolved from getChannelConfig(clientId, eventKey):
   *       · SMS   → enqueue a channel='SMS' QUEUED row (drained by the push/SMS worker) when
   *                 masterSms && mode∈{SMS,BOTH} && smsTemplateId && a recipient phone exists;
   *       · WhatsApp → a DIRECT msg91.sendWhatsappTemplate when masterWhatsapp && mode∈{WHATSAPP,
   *                 BOTH} && whatsappTemplate && a recipient phone exists.
   *
   * FAIL-SAFE by construction: every leg is independently wrapped. A missing phone, a blank
   * template, a master/mode OFF, an unresolved config, or a delivery error each SKIPS that leg
   * with a log — never throws into, and never blocks, the caller's domain path. Callers invoke
   * this AFTER their own DB transaction commits (the SMS enqueue + WhatsApp send run on the base
   * client, never inside the domain tx).
   *
   * The paid-channel variable lists are mapped from the caller's NAMED `vars` onto the per-event
   * VARIABLE_CONTRACTS (ordered WhatsApp body values; named SMS variables), so a call site only
   * supplies values by name and the ordering/contract lives in one place.
   */
  async notifyUserWithChannels(params: NotifyUserWithChannelsParams): Promise<void> {
    // (a) Free channels — IN_APP feed + PUSH (identical to notifyUser). Attempted unless the
    // caller opts out (a paid-channel-only event such as KYC_SUBMITTED).
    if (params.includeFreeChannels !== false) {
      await this.notifyUser({
        userId: params.userId,
        subject: params.subject,
        body: params.body,
        url: params.url,
        event: params.event,
        variables: params.vars ? this.stringifyVars(params.vars) : undefined,
      });
    }

    // (b) Resolve the per-tenant paid-channel config. Fail-safe: no resolver / a throw → skip paid.
    if (!this.templates) {
      // A null resolver silently skips ALL paid channels. For a tenant whose DEFAULTS would fire a
      // paid WhatsApp for this event (a WHATSAPP_KYC tenant like Deoleo, with masterWhatsapp + the
      // event defaulting to WHATSAPP), that is a SILENT DARK-OUT of a LIVE channel — surface it at
      // error level (with tenant + event) so it's observable. Behaviour is otherwise identical
      // (still return; never throw into the domain path).
      try {
        const def = defaultConfig(params.clientId);
        const ev = def.events[params.eventKey];
        const wouldHaveFiredWhatsapp =
          def.masterWhatsapp &&
          !!ev &&
          (ev.mode === 'WHATSAPP' || ev.mode === 'BOTH') &&
          !!ev.whatsappTemplate &&
          !!params.recipientPhone?.trim();
        if (wouldHaveFiredWhatsapp) {
          this.logger.error(
            `[notifications] NotificationTemplatesService unavailable — a LIVE WhatsApp for tenant "${params.clientId}" event "${params.eventKey}" was NOT sent (paid channels darked). Investigate resolver wiring.`,
          );
        }
      } catch {
        // Observability must never break the domain path.
      }
      return;
    }
    let cfg;
    try {
      cfg = await this.templates.getChannelConfig(params.clientId, params.eventKey);
    } catch (e) {
      this.logger.warn(
        `[notifications] getChannelConfig(${params.clientId}, ${params.eventKey}) failed; paid channels skipped: ${e}`,
      );
      return;
    }

    const phone = params.recipientPhone?.trim();
    const contract = VARIABLE_CONTRACTS[params.eventKey];

    // (c) SMS leg — enqueue a QUEUED row for the drainer. Gated on master + mode + template + phone.
    if (cfg.masterSms && (cfg.mode === 'SMS' || cfg.mode === 'BOTH') && cfg.smsTemplateId && phone) {
      const smsVariables = this.mapNamedVars(contract?.sms ?? [], params.vars);
      await this.enqueue({
        userId: params.userId,
        channel: 'SMS',
        subject: params.subject,
        body: params.body,
        recipientPhone: phone,
        templateId: cfg.smsTemplateId,
        variables: smsVariables,
      }).catch((e) =>
        this.logger.warn(`[notifications] SMS enqueue failed for ${params.userId} (${params.eventKey}): ${e}`),
      );
    }

    // (d) WhatsApp leg — DIRECT send. Gated on master + mode + template + phone. Never throws.
    if (
      cfg.masterWhatsapp &&
      (cfg.mode === 'WHATSAPP' || cfg.mode === 'BOTH') &&
      cfg.whatsappTemplate &&
      phone
    ) {
      const orderedWhatsapp = (contract?.whatsapp ?? []).map((name) =>
        this.varToString(params.vars?.[name]),
      );
      try {
        await this.msg91.sendWhatsappTemplate(phone, cfg.whatsappTemplate, orderedWhatsapp);
      } catch (e) {
        // Non-critical: a WhatsApp delivery failure must NEVER fail the caller's domain path.
        this.logger.warn(
          `[notifications] WhatsApp send failed for ${params.userId} (${params.eventKey}, template ${cfg.whatsappTemplate}): ${e}`,
        );
      }
    }
  }

  /** Map an ordered contract of variable NAMES to a named { name: value } object for the SMS row. */
  private mapNamedVars(
    names: string[],
    vars: Record<string, string | number | null | undefined> | undefined,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of names) out[name] = this.varToString(vars?.[name]);
    return out;
  }

  /** Coerce a single variable value to a template string ('' for null/undefined). */
  private varToString(v: string | number | null | undefined): string {
    return v === null || v === undefined ? '' : String(v);
  }

  /** Coerce every value of a named vars map to a string (for the IN_APP/PUSH variables blob). */
  private stringifyVars(
    vars: Record<string, string | number | null | undefined>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) out[k] = this.varToString(v);
    return out;
  }

  // ─── Bell feed (Phase 1) ──────────────────────────────────────────────────────

  /**
   * Page a user's IN_APP feed, newest first. Keyset pagination on (createdAt DESC, id
   * DESC) — stable under inserts. `nextCursor` is null when the page is the last one.
   */
  async listFeed(userId: string, cursor: string | undefined, limit: number): Promise<FeedPage> {
    const take = this.clampLimit(limit);
    const decoded = this.decodeCursor(cursor);

    const rows = await this.prisma.notificationQueue.findMany({
      where: {
        userId,
        channel: 'IN_APP',
        ...(decoded
          ? {
              OR: [
                { createdAt: { lt: decoded.createdAt } },
                { createdAt: decoded.createdAt, id: { lt: decoded.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1, // one extra row tells us whether another page exists
      select: { id: true, subject: true, body: true, variables: true, createdAt: true, readAt: true },
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((r) => ({
        id: r.id,
        subject: r.subject,
        body: r.body,
        url: this.extractUrl(r.variables),
        createdAt: r.createdAt,
        readAt: r.readAt,
      })),
      nextCursor: hasMore && last ? this.encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /** Count a user's unread IN_APP rows. */
  async unreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma.notificationQueue.count({
      where: { userId, channel: 'IN_APP', readAt: null },
    });
    return { count };
  }

  /**
   * Mark one IN_APP row read, scoped to the owner. 404 if the row does not exist or
   * belongs to another user (ownership isolation). Idempotent: an already-read row
   * keeps its original readAt and is returned unchanged.
   */
  async markRead(userId: string, id: string): Promise<{ id: string; readAt: Date }> {
    const row = await this.prisma.notificationQueue.findFirst({
      where: { id, userId, channel: 'IN_APP' },
      select: { id: true, readAt: true },
    });
    if (!row) throw new NotFoundException('Notification not found');
    if (row.readAt) return { id: row.id, readAt: row.readAt };

    const updated = await this.prisma.notificationQueue.update({
      where: { id: row.id },
      data: { readAt: new Date() },
      select: { id: true, readAt: true },
    });
    return { id: updated.id, readAt: updated.readAt as Date };
  }

  /** Mark ALL of a user's unread IN_APP rows read. Returns how many rows flipped. */
  async markAllRead(userId: string): Promise<{ updated: number }> {
    const res = await this.prisma.notificationQueue.updateMany({
      where: { userId, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }

  // ─── helpers ──────────────────────────────────────────────────────────────────

  /** Merge caller variables with an optional deep-link url; undefined when empty. */
  private mergeVariables(
    variables: Record<string, unknown> | undefined,
    url: string | undefined,
  ): Record<string, unknown> | undefined {
    const merged = { ...(variables ?? {}), ...(url ? { url } : {}) };
    return Object.keys(merged).length ? merged : undefined;
  }

  /** Pull an optional deep-link `url` out of the stored variables JSON. */
  private extractUrl(variables: unknown): string | null {
    if (variables && typeof variables === 'object' && 'url' in variables) {
      const url = (variables as { url?: unknown }).url;
      if (typeof url === 'string') return url;
    }
    return null;
  }

  private clampLimit(limit: number | undefined): number {
    if (!limit || !Number.isFinite(limit) || limit < 1) return FEED_DEFAULT_LIMIT;
    return Math.min(Math.floor(limit), FEED_MAX_LIMIT);
  }

  /** Cursor = base64url("<ISO createdAt>|<id>"). Opaque to the client. */
  private encodeCursor(createdAt: Date, id: string): string {
    return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
  }

  private decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
    if (!cursor) return null;
    try {
      const raw = Buffer.from(cursor, 'base64url').toString('utf8');
      const sep = raw.indexOf('|');
      if (sep < 0) return null;
      const createdAt = new Date(raw.slice(0, sep));
      const id = raw.slice(sep + 1);
      if (Number.isNaN(createdAt.getTime()) || !id) return null;
      return { createdAt, id };
    } catch {
      return null; // a malformed cursor pages from the top rather than 500ing
    }
  }
}
