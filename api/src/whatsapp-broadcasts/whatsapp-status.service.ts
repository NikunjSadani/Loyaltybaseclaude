import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from '../notifications/msg91.service';

/** A normalised delivery event extracted from an MSG91 outbound-report payload. */
export interface StatusEvent {
  /** The crqid we sent (= the recipient row id) — the primary correlation key. */
  crqid?: string;
  /** MSG91's request id — the fallback correlation key. */
  requestId?: string;
  /** Lower-cased status: 'sent' | 'delivered' | 'read' | 'failed' (others ignored). */
  status: string;
  /** Event time (ms since epoch) if the payload carried one; else undefined → now(). */
  at?: number;
  /** Failure reason text, when present. */
  reason?: string;
}

const RECONCILE_AGE_MIN_DEFAULT = 30;
const RECONCILE_BATCH = 200;

/**
 * WhatsApp status ingestion — the webhook handler + the fallback reconcile.
 *
 * IDEMPOTENT + FAST: each event maps to at most one guarded update. A DELIVERED/READ/FAILED
 * transition is applied via an updateMany guarded on the not-yet-set timestamp so a retried
 * webhook (MSG91 retries ×4) is a no-op, and the campaign counter is incremented ONLY when
 * the guarded update actually flipped the row (count===1) — so counters never double-count.
 * The webhook does the minimal DB work and returns, to ack within MSG91's ≤8s budget.
 */
@Injectable()
export class WhatsappStatusService {
  private readonly logger = new Logger(WhatsappStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly msg91: Msg91Service,
  ) {}

  /**
   * Parse the MSG91 "On Outbound Report Received" payload into normalised events.
   *
   * ⚠️ RUNTIME-VERIFY: the exact payload shape (top-level array vs `{ data: [...] }` vs a
   * single object) and the field names (crqid / requestId / status / timestamp) are per the
   * MSG91 webhook docs and MUST be confirmed against a real callback on staging. This parser
   * is deliberately tolerant of the common shapes; an unrecognised event is skipped (never
   * throws), so a shape mismatch degrades to "no update" rather than a 500.
   */
  parseEvents(payload: unknown): StatusEvent[] {
    const items: unknown[] = Array.isArray(payload)
      ? payload
      : this.isRecord(payload) && Array.isArray(payload.data)
        ? payload.data
        : payload != null
          ? [payload]
          : [];

    const events: StatusEvent[] = [];
    for (const it of items) {
      if (!this.isRecord(it)) continue;
      const statusRaw =
        this.str(it.status) ??
        this.str((this.isRecord(it.report) ? it.report.status : undefined)) ??
        this.str(it.event);
      if (!statusRaw) continue;
      const crqid = this.str(it.crqid) ?? this.str(it.crqId) ?? this.str(it.clientRefId);
      const requestId = this.str(it.requestId) ?? this.str(it.request_id) ?? this.str(it.id);
      const atRaw = this.str(it.timestamp) ?? this.str(it.time) ?? this.str(it.eventTime);
      const at = atRaw ? this.toMillis(atRaw) : undefined;
      const reason =
        this.str(it.reason) ?? this.str(it.error) ?? this.str(it.failureReason) ?? undefined;
      events.push({ crqid, requestId, status: statusRaw.toLowerCase(), at, reason });
    }
    return events;
  }

  /** Handle a webhook payload: apply every parsed event. Returns how many rows changed. */
  async handleWebhook(payload: unknown): Promise<{ processed: number; updated: number }> {
    const events = this.parseEvents(payload);
    let updated = 0;
    for (const ev of events) {
      try {
        if (await this.applyEvent(ev)) updated++;
      } catch (e) {
        // A single bad event never fails the ack — log and continue.
        this.logger.warn(`[whatsapp-status] event apply failed: ${e}`);
      }
    }
    return { processed: events.length, updated };
  }

  /** Resolve the target recipient row (by crqid = id, else by msg91RequestId) then transition it. */
  private async applyEvent(ev: StatusEvent): Promise<boolean> {
    const at = ev.at ? new Date(ev.at) : new Date();

    // Resolve the row id. crqid IS the recipient id (primary). Fallback: msg91RequestId.
    let rowId: string | null = null;
    let broadcastId: string | null = null;
    if (ev.crqid) {
      const row = await this.prisma.whatsappBroadcastRecipient.findUnique({
        where: { id: ev.crqid },
        select: { id: true, broadcastId: true },
      });
      if (row) {
        rowId = row.id;
        broadcastId = row.broadcastId;
      }
    }
    if (!rowId && ev.requestId) {
      // crqid is the primary key; this is only the fallback. A bulk requestId can in principle
      // match more than one row — findFirst tolerates that (never throws), and the explicit
      // orderBy makes the pick deterministic (most-recent send) rather than arbitrary.
      const row = await this.prisma.whatsappBroadcastRecipient.findFirst({
        where: { msg91RequestId: ev.requestId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, broadcastId: true },
      });
      if (row) {
        rowId = row.id;
        broadcastId = row.broadcastId;
      }
    }
    if (!rowId || !broadcastId) return false; // unknown correlation — ignore

    if (ev.status === 'delivered') return this.markDelivered(rowId, broadcastId, at);
    if (ev.status === 'read') return this.markRead(rowId, broadcastId, at);
    if (ev.status === 'failed') return this.markFailed(rowId, broadcastId, ev.reason ?? 'Failed', at);
    // 'sent' (or anything else) — the worker already set SENT; nothing to roll.
    return false;
  }

  /** DELIVERED transition (guarded on deliveredAt null so a retry is a no-op). */
  private async markDelivered(rowId: string, broadcastId: string, at: Date): Promise<boolean> {
    const res = await this.prisma.whatsappBroadcastRecipient.updateMany({
      where: { id: rowId, deliveredAt: null, status: { notIn: ['FAILED', 'SKIPPED'] } },
      data: { status: 'DELIVERED', deliveredAt: at },
    });
    if (res.count !== 1) return false;
    await this.prisma.whatsappBroadcast.update({
      where: { id: broadcastId },
      data: { deliveredCount: { increment: 1 } },
    });
    return true;
  }

  /**
   * READ transition (guarded on readAt null). READ implies delivered, so if the row was not
   * yet delivered we set deliveredAt too and roll the delivered counter — a read-without-a-
   * prior-delivered-webhook still counts once toward delivered.
   *
   * RACE-SAFE delivered roll: rather than read deliveredAt and then decide (which races a
   * concurrent DELIVERED webhook — both could observe null and both increment), the delivered
   * counter is gated on a SEPARATE atomic `deliveredAt: null` guarded update. Whichever of
   * markRead / markDelivered wins that guard increments deliveredCount exactly once.
   */
  private async markRead(rowId: string, broadcastId: string, at: Date): Promise<boolean> {
    const res = await this.prisma.whatsappBroadcastRecipient.updateMany({
      where: { id: rowId, readAt: null, status: { notIn: ['FAILED', 'SKIPPED'] } },
      data: { status: 'READ', readAt: at },
    });
    if (res.count !== 1) return false;
    await this.prisma.whatsappBroadcast.update({
      where: { id: broadcastId },
      data: { readCount: { increment: 1 } },
    });
    // Atomically claim the delivered milestone iff not already set — no double count.
    const deliv = await this.prisma.whatsappBroadcastRecipient.updateMany({
      where: { id: rowId, deliveredAt: null },
      data: { deliveredAt: at },
    });
    if (deliv.count === 1) {
      await this.prisma.whatsappBroadcast.update({
        where: { id: broadcastId },
        data: { deliveredCount: { increment: 1 } },
      });
    }
    return true;
  }

  /**
   * FAILED transition (guarded so a row that already failed isn't re-counted).
   *
   * COUNTER INTEGRITY:
   *   - Does NOT overwrite `sentAt` — a FAILED event must not stamp a send time onto a row
   *     that was never (successfully) sent, nor clobber the real sentAt of one that was.
   *   - If the row was already SENT (sentCount already rolled), flipping it to FAILED also
   *     DECREMENTS sentCount as it increments failedCount, so sent+failed never exceeds the
   *     recipient count. DELIVERED/READ rows are still never downgraded.
   */
  private async markFailed(
    rowId: string,
    broadcastId: string,
    reason: string,
    at: Date,
  ): Promise<boolean> {
    // Read prior status to know whether we must unwind a prior sentCount roll.
    const current = await this.prisma.whatsappBroadcastRecipient.findUnique({
      where: { id: rowId },
      select: { status: true },
    });
    const wasSent = current?.status === 'SENT';
    const res = await this.prisma.whatsappBroadcastRecipient.updateMany({
      // Only flip a non-terminal, not-yet-delivered/read row to FAILED. A DELIVERED/READ
      // row is not downgraded by a late failure event.
      where: {
        id: rowId,
        status: { notIn: ['FAILED', 'SKIPPED', 'DELIVERED', 'READ'] },
      },
      data: { status: 'FAILED', errorReason: reason.slice(0, 500) },
    });
    if (res.count !== 1) return false;
    await this.prisma.whatsappBroadcast.update({
      where: { id: broadcastId },
      data: {
        failedCount: { increment: 1 },
        ...(wasSent ? { sentCount: { decrement: 1 } } : {}),
      },
    });
    return true;
  }

  /**
   * Fallback poll — reconcile SENT-but-not-yet-terminal recipients older than N minutes via
   * MSG91's status-by-requestID API (catches missed webhooks). FAIL-SAFE: each row is
   * best-effort; a null/failed lookup leaves the row untouched. Gated by the caller.
   */
  async reconcile(): Promise<{ checked: number; updated: number }> {
    const ageMin = Number(process.env.WHATSAPP_RECONCILE_AGE_MIN ?? '') || RECONCILE_AGE_MIN_DEFAULT;
    const cutoff = new Date(Date.now() - ageMin * 60_000);

    const rows = await this.prisma.whatsappBroadcastRecipient.findMany({
      where: {
        status: 'SENT',
        deliveredAt: null,
        readAt: null,
        sentAt: { lt: cutoff },
        // NOTE: no `msg91RequestId: { not: null }` filter — a row whose send returned a null
        // requestId (e.g. an unexpected MSG91 response field name) must still be reconciled,
        // falling back to its crqid (= row id) below, rather than being silently stuck at Sent.
      },
      select: { id: true, broadcastId: true, msg91RequestId: true },
      take: RECONCILE_BATCH,
    });

    let updated = 0;
    for (const row of rows) {
      try {
        // Prefer the stored MSG91 requestId; fall back to the crqid (the row id we sent) when
        // requestId is null so a missing/renamed requestId doesn't strand the row forever.
        const lookupId = row.msg91RequestId ?? row.id;
        const res = await this.msg91.getWhatsappStatusByRequestId(lookupId);
        if (!res) continue;
        const status = res.status.toLowerCase();
        const at = new Date();
        let changed = false;
        if (status.includes('read')) changed = await this.markRead(row.id, row.broadcastId, at);
        else if (status.includes('deliver'))
          changed = await this.markDelivered(row.id, row.broadcastId, at);
        else if (status.includes('fail'))
          changed = await this.markFailed(row.id, row.broadcastId, 'Failed (reconcile)', at);
        if (changed) updated++;
      } catch (e) {
        this.logger.warn(`[whatsapp-status] reconcile row ${row.id} failed: ${e}`);
      }
    }
    return { checked: rows.length, updated };
  }

  // ── small parse helpers ──────────────────────────────────────────────────
  private isRecord(v: unknown): v is Record<string, any> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }
  private str(v: unknown): string | undefined {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number') return String(v);
    return undefined;
  }
  /** Coerce a timestamp string (ms epoch, seconds epoch, or ISO) into ms since epoch. */
  private toMillis(raw: string): number | undefined {
    const n = Number(raw);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000; // seconds → ms heuristic
    const d = Date.parse(raw);
    return Number.isNaN(d) ? undefined : d;
  }
}
