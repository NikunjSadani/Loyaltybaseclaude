import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from './msg91.service';

/**
 * A normalised delivery event extracted from an MSG91 delivery-report payload.
 *
 * Channel-agnostic: the same shape is produced from the SMS DLR webhook (Wave 1) and,
 * unchanged, the transactional-WhatsApp report webhook (Wave 2) — the service correlates
 * either against the shared `MessageDeliveryReceipt` table.
 */
export interface DeliveryEvent {
  /** The crqid we sent (= the MessageDeliveryReceipt row id) — the primary correlation key. */
  crqid?: string;
  /** MSG91's request id — the fallback correlation key. */
  requestId?: string;
  /** Lower-cased status: 'sent' | 'delivered' | 'read' | 'failed' (others ignored). */
  status: string;
  /** Event time (ms since epoch) if the payload carried one; else undefined → now(). */
  at?: number;
  /** Failure reason text, when present. */
  reason?: string;
  /** The raw event object, merged into the receipt's providerResponse for audit/debug. */
  raw?: unknown;
}

const RECONCILE_AGE_MIN_DEFAULT = 30;
const RECONCILE_BATCH = 200;

/**
 * Shared, CHANNEL-AGNOSTIC delivery-status ingestion (D3).
 *
 * Correlates an MSG91 delivery callback back to a `MessageDeliveryReceipt` row (by the crqid we
 * sent = the receipt id, falling back to the provider requestId) and applies an IDEMPOTENT,
 * GUARDED status transition. Generic over the receipt's channel (SMS in Wave 1, transactional
 * WHATSAPP in Wave 2) so Wave 2 reuses this service unchanged — the WhatsApp *broadcast* webhook
 * keeps its own recipient-row service; this one owns the receipt table.
 *
 * IDEMPOTENT + FAST: each event maps to at most one guarded `updateMany`. A DELIVERED/READ/FAILED
 * transition is guarded on the not-yet-set timestamp (or a non-terminal status), so a retried
 * callback (MSG91 retries ×4) is a no-op — `count === 1` means "actually flipped". A terminal
 * DELIVERED/READ is NEVER downgraded by a late FAILED. The webhook does the minimal DB work and
 * returns, to ack within MSG91's tight budget.
 */
@Injectable()
export class MessageDeliveryStatusService {
  private readonly logger = new Logger(MessageDeliveryStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly msg91: Msg91Service,
  ) {}

  /**
   * Parse an MSG91 delivery-report payload into normalised events.
   *
   * ⚠️ RUNTIME-VERIFY (SMS DLR field spellings): the exact SMS DLR payload shape (top-level array
   * vs `{ data: [...] }` vs a single object) and the field names MUST be confirmed against a real
   * MSG91 SMS DLR callback on staging. Per the MSG91 SMS DLR-webhook docs the client reference id
   * is echoed as `crqid` and MSG91's handle as a request id, with a numeric DLR `status` code +
   * `description`/`err` reason — but the precise spellings vary across docs/plans, so this parser
   * reads the common aliases and LOWERCASES the status. An unrecognised event is skipped (never
   * throws), so a shape mismatch degrades to "no update" rather than a 500.
   */
  parseEvents(payload: unknown): DeliveryEvent[] {
    const items: unknown[] = Array.isArray(payload)
      ? payload
      : this.isRecord(payload) && Array.isArray(payload.data)
        ? payload.data
        : payload != null
          ? [payload]
          : [];

    const events: DeliveryEvent[] = [];
    for (const it of items) {
      if (!this.isRecord(it)) continue;
      // ⚠️ RUNTIME-VERIFY: SMS DLR may carry the outcome as a text `status`, a nested
      // `report.status`, an `event`, or a numeric DLR code in `description`/`state`.
      const statusRaw =
        this.str(it.status) ??
        this.str(this.isRecord(it.report) ? it.report.status : undefined) ??
        this.str(it.event) ??
        this.str(it.state);
      if (!statusRaw) continue;
      // ⚠️ RUNTIME-VERIFY: crqid aliases seen across MSG91 channels — crqid / crqId /
      // clientRefId / cref.
      const crqid =
        this.str(it.crqid) ??
        this.str(it.crqId) ??
        this.str(it.clientRefId) ??
        this.str(it.cref);
      // ⚠️ RUNTIME-VERIFY: requestId aliases — requestId / request_id / requestID / id.
      const requestId =
        this.str(it.requestId) ??
        this.str(it.request_id) ??
        this.str(it.requestID) ??
        this.str(it.id);
      const atRaw =
        this.str(it.timestamp) ?? this.str(it.time) ?? this.str(it.eventTime) ?? this.str(it.date);
      const at = atRaw ? this.toMillis(atRaw) : undefined;
      // ⚠️ RUNTIME-VERIFY: failure-reason aliases — reason / error / err / description / failureReason.
      const reason =
        this.str(it.reason) ??
        this.str(it.error) ??
        this.str(it.err) ??
        this.str(it.description) ??
        this.str(it.failureReason) ??
        undefined;
      events.push({ crqid, requestId, status: statusRaw.toLowerCase(), at, reason, raw: it });
    }
    return events;
  }

  /** Handle a webhook payload: apply every parsed event. Returns counts for the ack body. */
  async handleWebhook(payload: unknown): Promise<{ processed: number; updated: number }> {
    const events = this.parseEvents(payload);
    let updated = 0;
    for (const ev of events) {
      try {
        if (await this.applyEvent(ev)) updated++;
      } catch (e) {
        // A single bad event never fails the ack — log and continue.
        this.logger.warn(`[message-delivery-status] event apply failed: ${e}`);
      }
    }
    return { processed: events.length, updated };
  }

  /** Resolve the target receipt (by crqid = id, else by msg91RequestId) then transition it. */
  async applyEvent(ev: DeliveryEvent): Promise<boolean> {
    const at = ev.at ? new Date(ev.at) : new Date();

    // Resolve the receipt. Primary key: the crqid we sent (unique column). Fallback: msg91RequestId.
    let receiptId: string | null = null;
    if (ev.crqid) {
      const row = await this.prisma.messageDeliveryReceipt.findUnique({
        where: { crqid: ev.crqid },
        select: { id: true },
      });
      if (row) receiptId = row.id;
    }
    if (!receiptId && ev.requestId) {
      // crqid is the primary key; requestId is only the fallback. A bulk requestId can in
      // principle match more than one row — findFirst tolerates that (never throws), and the
      // explicit orderBy makes the pick deterministic (most-recent send) rather than arbitrary.
      const row = await this.prisma.messageDeliveryReceipt.findFirst({
        where: { msg91RequestId: ev.requestId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (row) receiptId = row.id;
    }
    if (!receiptId) return false; // unknown correlation — ignore

    const s = ev.status;
    if (this.isRead(s)) return this.markRead(receiptId, at, ev.raw);
    if (this.isDelivered(s)) return this.markDelivered(receiptId, at, ev.raw);
    if (this.isFailed(s)) return this.markFailed(receiptId, ev.reason ?? 'Failed', at, ev.raw);
    // 'sent'/'submitted' (or anything else) — the worker already set SENT; nothing to flip.
    return false;
  }

  /** SENT→DELIVERED (guarded on deliveredAt null; never overrides a terminal FAILED). */
  private async markDelivered(receiptId: string, at: Date, raw: unknown): Promise<boolean> {
    const res = await this.prisma.messageDeliveryReceipt.updateMany({
      where: { id: receiptId, deliveredAt: null, status: { notIn: ['FAILED'] } },
      data: { status: 'DELIVERED', deliveredAt: at },
    });
    if (res.count !== 1) return false;
    await this.mergeProviderResponse(receiptId, raw);
    return true;
  }

  /**
   * DELIVERED→READ (guarded on readAt null; WhatsApp only — SMS never reports read). READ implies
   * delivered, so if the row was not yet delivered we also claim deliveredAt via a SEPARATE atomic
   * guarded update (so a read-without-a-prior-delivered-webhook still records a delivery time).
   */
  private async markRead(receiptId: string, at: Date, raw: unknown): Promise<boolean> {
    const res = await this.prisma.messageDeliveryReceipt.updateMany({
      where: { id: receiptId, readAt: null, status: { notIn: ['FAILED'] } },
      data: { status: 'READ', readAt: at },
    });
    if (res.count !== 1) return false;
    // Atomically claim the delivered milestone iff not already set.
    await this.prisma.messageDeliveryReceipt.updateMany({
      where: { id: receiptId, deliveredAt: null },
      data: { deliveredAt: at },
    });
    await this.mergeProviderResponse(receiptId, raw);
    return true;
  }

  /**
   * →FAILED (guarded so a terminal row isn't re-counted and, crucially, a DELIVERED/READ row is
   * NEVER downgraded by a late failure event). Does NOT overwrite sentAt.
   */
  private async markFailed(
    receiptId: string,
    reason: string,
    _at: Date,
    raw: unknown,
  ): Promise<boolean> {
    const res = await this.prisma.messageDeliveryReceipt.updateMany({
      where: { id: receiptId, status: { notIn: ['FAILED', 'DELIVERED', 'READ'] } },
      data: { status: 'FAILED', failureReason: reason.slice(0, 500) },
    });
    if (res.count !== 1) return false;
    await this.mergeProviderResponse(receiptId, raw);
    return true;
  }

  /**
   * Best-effort merge of the raw provider event into the receipt's providerResponse JSON. Runs
   * only after a guarded flip actually changed the row, so a duplicate callback never re-merges.
   * Non-critical: a failure here never fails the transition (the status flip already succeeded).
   */
  private async mergeProviderResponse(receiptId: string, raw: unknown): Promise<void> {
    if (!this.isRecord(raw)) return;
    try {
      const cur = await this.prisma.messageDeliveryReceipt.findUnique({
        where: { id: receiptId },
        select: { providerResponse: true },
      });
      const base = this.isRecord(cur?.providerResponse) ? cur!.providerResponse : {};
      const merged = { ...(base as Record<string, unknown>), ...raw } as Prisma.InputJsonValue;
      await this.prisma.messageDeliveryReceipt.update({
        where: { id: receiptId },
        data: { providerResponse: merged },
      });
    } catch (e) {
      this.logger.warn(`[message-delivery-status] providerResponse merge failed for ${receiptId}: ${e}`);
    }
  }

  /**
   * Fallback poll (best-effort) — reconcile SMS receipts stuck at SENT (no terminal callback) older
   * than N minutes, via MSG91's SMS status-by-requestId API. FAIL-SAFE: each row is best-effort; a
   * null/failed lookup leaves the row untouched. Gated by the caller + by having a stored
   * msg91RequestId (the report API keys on MSG91's id, not our crqid). Never breaks if MSG91 is
   * unconfigured (getSmsStatusByRequestId returns null on the DEV bypass).
   *
   * ⚠️ RUNTIME-VERIFY: the SMS report-by-requestId endpoint URL + shape are per msg91.service's
   * `getSmsStatusByRequestId` (itself RUNTIME-VERIFY) — a wrong/unknown shape returns null (no false
   * flips), so this is safe to ship dormant behind the caller's secret + the age env.
   */
  async reconcile(): Promise<{ checked: number; updated: number }> {
    const ageMin =
      Number(process.env.NOTIFICATIONS_RECONCILE_AGE_MIN ?? '') || RECONCILE_AGE_MIN_DEFAULT;
    const cutoff = new Date(Date.now() - ageMin * 60_000);

    let rows: { id: string; msg91RequestId: string | null }[] = [];
    try {
      rows = await this.prisma.messageDeliveryReceipt.findMany({
        where: {
          channel: 'SMS',
          status: 'SENT',
          deliveredAt: null,
          sentAt: { lt: cutoff },
          // The SMS report API keys on MSG91's request id (our crqid = the receipt id is unknown to
          // it), so only rows that captured a requestId can be reconciled; the rest rely on the
          // webhook. ⚠️ RUNTIME-VERIFY: confirm the SMS response returns a usable request id.
          msg91RequestId: { not: null },
        },
        select: { id: true, msg91RequestId: true },
        take: RECONCILE_BATCH,
      });
    } catch (e) {
      // Missing table (pre-migration env) / transient DB error — never crash the scheduler.
      this.logger.warn(`[message-delivery-status] reconcile skipped: ${e}`);
      return { checked: 0, updated: 0 };
    }

    let updated = 0;
    for (const row of rows) {
      try {
        const res = await this.msg91.getSmsStatusByRequestId(row.msg91RequestId!);
        if (!res) continue;
        const status = res.status.toLowerCase();
        const at = new Date();
        let changed = false;
        if (this.isDelivered(status)) changed = await this.markDelivered(row.id, at, res.raw);
        else if (this.isFailed(status))
          changed = await this.markFailed(row.id, 'Failed (reconcile)', at, res.raw);
        if (changed) updated++;
      } catch (e) {
        this.logger.warn(`[message-delivery-status] reconcile row ${row.id} failed: ${e}`);
      }
    }
    return { checked: rows.length, updated };
  }

  // ── status classifiers (tolerant of MSG91's per-channel status vocabularies) ─────────────
  private isRead(s: string): boolean {
    return s.includes('read');
  }
  private isDelivered(s: string): boolean {
    // 'delivered' / 'deliver' (avoid matching 'undelivered'/'not delivered', which are failures).
    return s.includes('deliver') && !s.includes('undeliver') && !s.includes('not deliver');
  }
  private isFailed(s: string): boolean {
    return (
      s.includes('fail') ||
      s.includes('undeliver') ||
      s.includes('reject') ||
      s.includes('block') ||
      s.includes('expire') ||
      s.includes('bounce')
    );
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
