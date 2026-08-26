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
// D4: the OTP delivery-rate tile is an intentionally ROLLING window. Bound it EXPLICITLY (createdAt
// >= now - N hours) rather than relying on the opportunistic ~24h OtpCode cleanup, which only runs on
// a login send — a tenant with heavy non-login OTP but little login traffic would otherwise let rows
// linger and silently widen the window. Default 24h (matches the historical cleanup horizon),
// overridable via OTP_STATS_WINDOW_HOURS.
const OTP_STATS_WINDOW_HOURS_DEFAULT = 24;

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
   * SMS DLR payload (confirmed vs the MSG91 SMS DLR webhook docs, 2026-08): a per-recipient JSON
   * object with `requestId`, `telNum`, a NUMERIC `status` code (string, e.g. "1"=delivered / "2"=failed),
   * `CRQID` (the client-reference id we send — MSG91 defaults it to "0" when none was passed),
   * `eventName` (text, e.g. "delivered"), `deliveryTime`/`requestedAt`, and `failureReason`. This
   * parser reads those (plus tolerant aliases for other channels) and the classifiers map both the
   * numeric SMS codes and the text WhatsApp statuses. An unrecognised event is skipped (never throws),
   * so a shape mismatch degrades to "no update" rather than a 500. ⚠️ Still confirm the LIVE callback
   * body once the MSG91 webhook is wired on staging (top-level object vs `{data:[...]}` batching).
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
      // MSG91 SMS DLR carries the outcome as a NUMERIC `status` code (string, e.g. "1") PLUS a
      // text `eventName` ("delivered"); WhatsApp (Wave 2) carries a text status. Read the numeric
      // `status` first (classifiers map the codes), then the text fallbacks. Confirmed against the
      // MSG91 SMS DLR webhook docs 2026-08 — see the classifiers for the code map.
      const statusRaw =
        this.str(it.status) ??
        this.str(this.isRecord(it.report) ? it.report.status : undefined) ??
        this.str(it.event) ??
        this.str(it.eventName) ??
        this.str(it.state);
      if (!statusRaw) continue;
      // Correlation id we sent. MSG91 SMS DLR echoes it as `CRQID` (uppercase); other channels use
      // `crqid`/`crqId`/`clientRefId`/`cref`. MSG91 defaults CRQID to "0" when none was sent — treat
      // that (and empty) as absent so it never spuriously "matches".
      const crqidRaw =
        this.str(it.crqid) ??
        this.str(it.CRQID) ??
        this.str(it.crqId) ??
        this.str(it.CRQId) ??
        this.str(it.clientRefId) ??
        this.str(it.cref);
      const crqid = crqidRaw && crqidRaw !== '0' ? crqidRaw : undefined;
      // requestId aliases — requestId (MSG91 SMS DLR) / request_id / requestID / id.
      const requestId =
        this.str(it.requestId) ??
        this.str(it.request_id) ??
        this.str(it.requestID) ??
        this.str(it.id);
      const atRaw =
        this.str(it.deliveryTime) ??
        this.str(it.timestamp) ??
        this.str(it.time) ??
        this.str(it.eventTime) ??
        this.str(it.date) ??
        this.str(it.requestedAt);
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

  /**
   * Resolve the target for an event and transition it. Correlation ORDER (the invariant that keeps
   * a receipt and an OtpCode from ever both matching one event):
   *   1. MessageDeliveryReceipt by crqid (SMS / transactional WhatsApp — the unique correlation key), then
   *   2. MessageDeliveryReceipt by msg91RequestId (fallback), then — ONLY when neither matched —
   *   3. OtpCode by msg91RequestId (light D1 OTP tracking).
   * A receipt ALWAYS wins: OTP is tried only after both receipt lookups miss. They cannot collide in
   * practice — receipts carry a crqid (OTP sends none, so its DLR's CRQID is absent/"0"), and an OTP
   * requestId comes from the distinct v5/otp API, so it won't be found in the receipt table.
   */
  async applyEvent(ev: DeliveryEvent): Promise<boolean> {
    const at = ev.at ? new Date(ev.at) : new Date();

    // ── (1)+(2) Receipt correlation. Primary key: the crqid we sent (unique). Fallback: msg91RequestId.
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

    if (receiptId) {
      const s = ev.status;
      if (this.isRead(s)) return this.markRead(receiptId, at, ev.raw);
      if (this.isDelivered(s)) return this.markDelivered(receiptId, at, ev.raw);
      if (this.isFailed(s)) return this.markFailed(receiptId, ev.reason ?? 'Failed', at, ev.raw);
      // 'sent'/'submitted' (or anything else) — the worker already set SENT; nothing to flip.
      return false;
    }

    // ── (3) OTP fallback (light D1). Reached ONLY when NO receipt matched by crqid AND none by
    // requestId. OTP carries no crqid, so it is correlated by msg91RequestId alone.
    if (ev.requestId) return this.applyOtpEvent(ev, at);

    return false; // unknown correlation — ignore
  }

  /**
   * Light D1 OTP delivery tracking — correlate an OtpCode by its captured msg91RequestId and apply the
   * SAME numeric/text classifiers to flip its deliveryStatus/deliveredAt. OTP has NO read state, so only
   * delivered/failed transition it. Idempotent + no-downgrade, mirroring the receipt transitions.
   */
  private async applyOtpEvent(ev: DeliveryEvent, at: Date): Promise<boolean> {
    // Most-recent send wins if a requestId somehow recurs (it won't in practice — one id per send).
    const row = await this.prisma.otpCode.findFirst({
      where: { msg91RequestId: ev.requestId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!row) return false; // unknown correlation — ignore

    const s = ev.status;
    if (this.isDelivered(s)) return this.markOtpDelivered(row.id, at);
    if (this.isFailed(s)) return this.markOtpFailed(row.id);
    // 'read' is WhatsApp-only + OTP is SMS; 'sent' already stored by the send path — nothing to flip.
    return false;
  }

  /** OtpCode SENT→DELIVERED (guarded on deliveredAt null; never overrides a terminal FAILED). */
  private async markOtpDelivered(otpCodeId: string, at: Date): Promise<boolean> {
    const res = await this.prisma.otpCode.updateMany({
      where: { id: otpCodeId, deliveredAt: null, deliveryStatus: { notIn: ['FAILED'] } },
      data: { deliveryStatus: 'DELIVERED', deliveredAt: at },
    });
    return res.count === 1;
  }

  /** OtpCode →FAILED (guarded so a terminal DELIVERED/FAILED row is never re-counted or downgraded). */
  private async markOtpFailed(otpCodeId: string): Promise<boolean> {
    const res = await this.prisma.otpCode.updateMany({
      where: { id: otpCodeId, deliveryStatus: { notIn: ['DELIVERED', 'FAILED'] } },
      data: { deliveryStatus: 'FAILED' },
    });
    return res.count === 1;
  }

  /** SENT→DELIVERED (guarded on deliveredAt null; never overrides a terminal FAILED). */
  private async markDelivered(receiptId: string, at: Date, raw: unknown): Promise<boolean> {
    const res = await this.prisma.messageDeliveryReceipt.updateMany({
      // notIn FAILED (never revive) + READ (never downgrade a read row back to delivered — matters
      // when Wave 2 reuses this for WhatsApp, where READ can arrive before/around DELIVERED).
      where: { id: receiptId, deliveredAt: null, status: { notIn: ['FAILED', 'READ'] } },
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
   * Fallback poll (best-effort) — reconcile receipts stuck at SENT (no terminal callback) older than
   * N minutes, via MSG91's status-by-requestId APIs. Covers BOTH channels (D6):
   *   - SMS   → getSmsStatusByRequestId
   *   - WHATSAPP (transactional) → getWhatsappStatusByRequestId
   * The transactional-WhatsApp funnel depends ENTIRELY on the outbound-report webhook, so a missed
   * webhook would otherwise leave a WhatsApp receipt SENT forever — reconcile is the safety net.
   * FAIL-SAFE: each row is best-effort; a null/failed lookup leaves the row untouched. Gated by the
   * caller + by having a stored msg91RequestId (the report APIs key on MSG91's id, not our crqid).
   * Never breaks if MSG91 is unconfigured (both getters return null on the DEV bypass), so it ships
   * dormant behind the caller's secret + the age env.
   *
   * ⚠️ RUNTIME-VERIFY: the SMS and WhatsApp report-by-requestId endpoint URLs + shapes are per
   * msg91.service's `getSmsStatusByRequestId` / `getWhatsappStatusByRequestId` (both RUNTIME-VERIFY)
   * — a wrong/unknown shape returns null (no false flips), so this is safe to ship dormant.
   */
  async reconcile(): Promise<{ checked: number; updated: number }> {
    const ageMin =
      Number(process.env.NOTIFICATIONS_RECONCILE_AGE_MIN ?? '') || RECONCILE_AGE_MIN_DEFAULT;
    const cutoff = new Date(Date.now() - ageMin * 60_000);

    let rows: { id: string; channel: string; msg91RequestId: string | null }[] = [];
    try {
      rows = await this.prisma.messageDeliveryReceipt.findMany({
        where: {
          // D6: reconcile SMS AND transactional WHATSAPP (the WhatsApp funnel has no other fallback
          // than this poll if the outbound-report webhook is missed).
          channel: { in: ['SMS', 'WHATSAPP'] },
          status: 'SENT',
          deliveredAt: null,
          sentAt: { lt: cutoff },
          // The report APIs key on MSG91's request id (our crqid = the receipt id is unknown to
          // them), so only rows that captured a requestId can be reconciled; the rest rely on the
          // webhook. ⚠️ RUNTIME-VERIFY: confirm each channel's response returns a usable request id.
          msg91RequestId: { not: null },
        },
        select: { id: true, channel: true, msg91RequestId: true },
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
        // Poll the channel-appropriate report API (mirrored idempotent transitions for both).
        const res =
          row.channel === 'WHATSAPP'
            ? await this.msg91.getWhatsappStatusByRequestId(row.msg91RequestId!)
            : await this.msg91.getSmsStatusByRequestId(row.msg91RequestId!);
        if (!res) continue;
        const status = res.status.toLowerCase();
        const at = new Date();
        let changed = false;
        // WhatsApp can report 'read' — treat it as delivered-and-read via the same guarded path.
        if (this.isRead(status)) changed = await this.markRead(row.id, at, res.raw);
        else if (this.isDelivered(status)) changed = await this.markDelivered(row.id, at, res.raw);
        else if (this.isFailed(status))
          changed = await this.markFailed(row.id, 'Failed (reconcile)', at, res.raw);
        if (changed) updated++;
      } catch (e) {
        this.logger.warn(`[message-delivery-status] reconcile row ${row.id} failed: ${e}`);
      }
    }
    return { checked: rows.length, updated };
  }

  /**
   * Aggregate OTP delivery-rate (light D1) — counts over the CURRENT OtpCode rows, grouped by
   * deliveryStatus. This feeds Wave 4's report; it does NOT render anything itself.
   *
   * WINDOW (D4): the tile is an intentionally ROLLING window, but its bound is now EXPLICIT — the
   * groupBy is filtered `createdAt >= now - N hours` (default 24h, override OTP_STATS_WINDOW_HOURS)
   * rather than leaning on the opportunistic >24h-past-expiry OtpCode cleanup in auth.service (which
   * only runs on a login send — so a tenant with heavy non-login OTP but little login traffic would
   * otherwise let rows linger and silently widen the "rolling ~24h" tile). The explicit filter makes
   * the window deterministic regardless of cleanup timing. Long-term retention (a daily rollup) is
   * deliberately out of scope.
   * // FUTURE (b): a daily-rollup table would give long-term OTP delivery history — deferred.
   *
   * TENANT SCOPING: OtpCode.userId is null for most sends (login/KYC/scheme OTPs carry no user), so a
   * per-tenant filter can only see the redemption OTPs that DO set userId — it would undercount. The
   * `clientId` filter is therefore PARTIAL; platform-level (no clientId) is authoritative for now.
   * Full per-tenant OTP attribution is deferred to Wave 4.
   *
   * @returns counts + a deliveryRate = delivered / (delivered + failed) in [0,1], null when no OTP
   *   has reached a terminal (delivered/failed) outcome yet.
   */
  async getOtpDeliveryStats(opts?: { clientId?: string }): Promise<{
    total: number;
    delivered: number;
    failed: number;
    sent: number; // dispatched, awaiting a terminal delivery report
    pending: number; // no delivery handle captured (null) — pre-feature rows / a capture that no-op'd
    deliveryRate: number | null;
  }> {
    // D4: bound the window explicitly so it does not depend on the opportunistic cleanup running.
    const windowHours =
      Number(process.env.OTP_STATS_WINDOW_HOURS ?? '') || OTP_STATS_WINDOW_HOURS_DEFAULT;
    const since = new Date(Date.now() - windowHours * 3_600_000);

    // Deterministic rolling window (createdAt >= since) AND the PARTIAL per-tenant filter (see the
    // doc note): only rows WITH a userId under this client.
    const where: Prisma.OtpCodeWhereInput = {
      createdAt: { gte: since },
      ...(opts?.clientId ? { user: { is: { clientId: opts.clientId } } } : {}),
    };

    const groups = await this.prisma.otpCode.groupBy({
      by: ['deliveryStatus'],
      where,
      _count: { _all: true },
    });

    let total = 0;
    let delivered = 0;
    let failed = 0;
    let sent = 0;
    let pending = 0;
    for (const g of groups) {
      const c = g._count._all;
      total += c;
      switch (g.deliveryStatus) {
        case 'DELIVERED':
        case 'READ': // OTP never reports read, but fold it into delivered defensively
          delivered += c;
          break;
        case 'FAILED':
          failed += c;
          break;
        case 'SENT':
        case 'QUEUED':
          sent += c;
          break;
        default: // null — no handle captured yet
          pending += c;
          break;
      }
    }
    const terminal = delivered + failed;
    const deliveryRate = terminal > 0 ? delivered / terminal : null;
    return { total, delivered, failed, sent, pending, deliveryRate };
  }

  // ── status classifiers (tolerant of MSG91's per-channel status vocabularies) ─────────────
  // MSG91 SMS DLR reports a NUMERIC status code (confirmed vs the MSG91 SMS DLR webhook docs, 2026-08):
  //   0 = Sent, 1 = Delivered, 2 = Failed, 9 = NDNC, 16 & 25 = Rejected, 17 = Blocked number,
  //   20 = Country code blocked. Code "0" (Sent) maps to neither → no flip (stays SENT).
  // WhatsApp (Wave 2) reports TEXT statuses (sent/delivered/read/failed). Both handled below.
  private static readonly SMS_CODE_DELIVERED = new Set(['1']);
  private static readonly SMS_CODE_FAILED = new Set(['2', '9', '16', '17', '20', '25']);

  private isRead(s: string): boolean {
    return s.includes('read'); // WhatsApp only; SMS has no read code
  }
  private isDelivered(s: string): boolean {
    if (MessageDeliveryStatusService.SMS_CODE_DELIVERED.has(s)) return true;
    // 'delivered' / 'deliver' (avoid matching 'undelivered'/'not delivered', which are failures).
    return s.includes('deliver') && !s.includes('undeliver') && !s.includes('not deliver');
  }
  private isFailed(s: string): boolean {
    if (MessageDeliveryStatusService.SMS_CODE_FAILED.has(s)) return true;
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
