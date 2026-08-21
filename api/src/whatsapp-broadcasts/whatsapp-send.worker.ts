import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { Msg91Service } from '../notifications/msg91.service';

const BATCH_SIZE = 50;

/**
 * WhatsApp broadcast send worker — drains QUEUED recipient rows of SENDING campaigns and
 * dispatches each via MSG91, mirroring the push delivery worker's discipline:
 *
 *   - GATED OFF by default (`WHATSAPP_WORKER_ENABLED === 'true'`). The tables may not exist
 *     on an env until the migration is applied, and prod stays off until cutover — so the
 *     drain only runs when an env opts in.
 *   - ATOMIC CLAIM (no double-send): each billable send is claimed QUEUED→SENDING via an
 *     updateMany that matches the still-QUEUED row; only the winner (count===1) sends, so
 *     the 30s @Interval racing the every-minute POST /v1/whatsapp/drain can never send the
 *     same message twice.
 *   - crqid = the recipient row id, passed to MSG91 and echoed back on the status webhook.
 *   - THROTTLED: a bounded batch per tick + an optional inter-send delay
 *     (`WHATSAPP_SEND_THROTTLE_MS`) to respect MSG91/Meta rate limits.
 *   - FAIL-SAFE: the whole drain is wrapped so a missing table / transient DB error logs
 *     and is swallowed, never crashing the scheduler; one bad row never aborts the batch.
 */
@Injectable()
export class WhatsappSendWorker {
  private readonly logger = new Logger(WhatsappSendWorker.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly msg91: Msg91Service,
  ) {}

  @Interval(30_000)
  async drain(): Promise<void> {
    if (process.env.WHATSAPP_WORKER_ENABLED !== 'true') return;
    if (this.running) return; // don't overlap ticks
    this.running = true;
    try {
      await this.promoteDueScheduled();
      await this.reapStrandedSending();
      await this.drainQueued();
    } catch (e) {
      // Missing table (pre-migration env), transient DB error, etc. — never crash.
      this.logger.warn(`[whatsapp-worker] drain skipped: ${e}`);
    } finally {
      this.running = false;
    }
  }

  /** Promote SCHEDULED campaigns whose time has come → SENDING (their rows then drain). */
  private async promoteDueScheduled(): Promise<void> {
    await this.prisma.whatsappBroadcast.updateMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
      data: { status: 'SENDING' },
    });
  }

  /**
   * Reaper — re-queue rows STRANDED in SENDING: claimed (QUEUED→SENDING) but never actually
   * dispatched (msg91RequestId still NULL) and untouched for longer than the reap window.
   * A successfully-sent row has its requestId written, so it is excluded — only genuinely
   * never-dispatched rows (e.g. the process died right after the claim) are recovered. This
   * also stops finalizeBroadcastIfDone from pinning a campaign in SENDING forever behind a
   * permanently-stuck row. Configurable via WHATSAPP_SENDING_REAP_MIN (default 15m).
   */
  private async reapStrandedSending(): Promise<void> {
    const min = Number(process.env.WHATSAPP_SENDING_REAP_MIN ?? '') || 15;
    const cutoff = new Date(Date.now() - min * 60_000);
    const res = await this.prisma.whatsappBroadcastRecipient.updateMany({
      where: {
        status: 'SENDING',
        msg91RequestId: null,
        updatedAt: { lt: cutoff },
        broadcast: { status: 'SENDING' },
      },
      data: { status: 'QUEUED' },
    });
    if (res.count > 0) {
      this.logger.warn(
        `[whatsapp-worker] re-queued ${res.count} row(s) stranded in SENDING (never dispatched)`,
      );
    }
  }

  /** Atomically claim a QUEUED recipient row (QUEUED→SENDING). True iff THIS caller won it. */
  private async claim(id: string): Promise<boolean> {
    const res = await this.prisma.whatsappBroadcastRecipient.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'SENDING' },
    });
    return res.count === 1;
  }

  private async drainQueued(): Promise<void> {
    const rows = await this.prisma.whatsappBroadcastRecipient.findMany({
      where: { status: 'QUEUED', broadcast: { status: 'SENDING' } },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      include: {
        broadcast: {
          select: {
            id: true,
            template: { select: { msg91TemplateName: true, languageCode: true } },
          },
        },
      },
    });

    const throttleMs = Number(process.env.WHATSAPP_SEND_THROTTLE_MS ?? '0') || 0;
    const touchedBroadcasts = new Set<string>();

    for (const row of rows) {
      touchedBroadcasts.add(row.broadcastId);
      // Claim before the billable send so a concurrent drain can't send twice. Loser skips.
      if (!(await this.claim(row.id))) continue;

      const templateName = row.broadcast.template.msg91TemplateName;
      const languageCode = row.broadcast.template.languageCode;
      const bodyValues = this.readVariables(row.variables);

      // STEP 1 — the billable send, in its OWN try. A throw here means the message was NOT
      // dispatched (not billed) → mark FAILED (resendable). A billed message can never reach
      // this catch, so resendFailed can never re-bill a message that actually went out.
      let requestId: string | null;
      try {
        // crqid = the recipient row id → echoed back on the outbound-report webhook.
        ({ requestId } = await this.msg91.sendWhatsappTemplate(
          row.phone,
          templateName,
          bodyValues,
          { crqid: row.id, languageCode },
        ));
      } catch (e) {
        await this.prisma.whatsappBroadcastRecipient.update({
          where: { id: row.id },
          data: { status: 'FAILED', errorReason: this.shortError(e) },
        });
        await this.prisma.whatsappBroadcast.update({
          where: { id: row.broadcastId },
          data: { failedCount: { increment: 1 } },
        });
        this.logger.warn(`[whatsapp-worker] row ${row.id} send failed: ${e}`);
        if (throttleMs > 0) await this.sleep(throttleMs);
        continue;
      }

      // A null requestId after a successful (non-throwing) send means MSG91 returned no id we
      // recognised — surface it so a wrong response field name is observable, not silent (the
      // reconcile then can't correlate this row by requestId → it would stay stuck at Sent).
      if (!requestId) {
        this.logger.warn(
          `[whatsapp-worker] row ${row.id} sent but MSG91 returned a null requestId — verify the response field name (reconcile will fall back to crqid).`,
        );
      }

      // STEP 2 — the send SUCCEEDED (billed). Persist SENT with a bounded retry; on total
      // failure we log loudly but NEVER write FAILED (a billed message must not become
      // resendable). Each update is retried independently so a retry can't double-count.
      try {
        await this.withRetry(() =>
          this.prisma.whatsappBroadcastRecipient.update({
            where: { id: row.id },
            data: { status: 'SENT', sentAt: new Date(), msg91RequestId: requestId ?? undefined },
          }),
        );
        await this.withRetry(() =>
          this.prisma.whatsappBroadcast.update({
            where: { id: row.broadcastId },
            data: { sentCount: { increment: 1 } },
          }),
        );
      } catch (e) {
        this.logger.error(
          `[whatsapp-worker] row ${row.id} was SENT (billed) but the status write failed after retries — left non-FAILED to avoid a re-bill: ${e}`,
        );
      }

      if (throttleMs > 0) await this.sleep(throttleMs);
    }

    // Roll any drained campaign to SENT once it has no more QUEUED/SENDING rows.
    for (const bId of touchedBroadcasts) {
      await this.finalizeBroadcastIfDone(bId);
    }

    if (rows.length > 0) {
      this.logger.debug(`[whatsapp-worker] processed ${rows.length} recipient row(s)`);
    }
  }

  /** Mark a SENDING broadcast SENT once none of its rows remain QUEUED or SENDING. */
  private async finalizeBroadcastIfDone(broadcastId: string): Promise<void> {
    const remaining = await this.prisma.whatsappBroadcastRecipient.count({
      where: { broadcastId, status: { in: ['QUEUED', 'SENDING'] } },
    });
    if (remaining > 0) return;
    // Only a SENDING campaign transitions to SENT (never re-touch a CANCELLED one).
    await this.prisma.whatsappBroadcast.updateMany({
      where: { id: broadcastId, status: 'SENDING' },
      data: { status: 'SENT', sentAt: new Date() },
    });
  }

  /** Coerce the stored variables JSON into the ordered string[] sendWhatsappTemplate wants. */
  private readVariables(variables: unknown): string[] {
    if (!Array.isArray(variables)) return [];
    return variables.map((v) => (v === null || v === undefined ? '' : String(v)));
  }

  /** A compact, bounded error string for errorReason (never dumps a huge stack). */
  private shortError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.slice(0, 500);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Run a single idempotent DB write with a small bounded retry. Used only for the post-send
   * status write (#9): the message is already billed, so we try hard to persist SENT rather
   * than let a transient DB blip flip a billed row into FAILED. Each op here is individually
   * idempotent (update-by-id / a one-shot atomic increment) so a retry never double-applies.
   */
  private async withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) await this.sleep(200 * (i + 1));
      }
    }
    throw lastErr;
  }
}
