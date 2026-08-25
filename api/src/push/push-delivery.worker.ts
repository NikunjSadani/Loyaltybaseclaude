import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PushSenderService, PushPayload } from './push-sender.service';
import { Msg91Service } from '../notifications/msg91.service';

const BATCH_SIZE = 50;

/**
 * Delivery worker — drains QUEUED `NotificationQueue` rows and dispatches them:
 *   - the PUSH leg (channel='PUSH') via the Web Push sender;
 *   - the SMS leg (channel='SMS') via the MSG91 v5 flow API (Phase 2 delivery).
 * Each row is marked SENT (or FAILED with a retry bump) and gets a NotificationDeliveryLog.
 * IN_APP rows are NEVER selected — they are written already-SENT and ARE the bell feed.
 *
 * GATED OFF BY DEFAULT (`PUSH_WORKER_ENABLED === 'true'`). The push_subscription /
 * PUSH-channel rows may not exist on an env until the orchestrator applies the
 * migration, and prod stays off until cutover — so the drain only runs when an env
 * explicitly opts in. Each leg is wrapped in its own try/catch: a missing table or a
 * transient DB error logs and is swallowed, never crashing the scheduler/app, and an
 * SMS-phase failure never affects the PUSH phase (or vice versa).
 */
@Injectable()
export class PushDeliveryWorker {
  private readonly logger = new Logger(PushDeliveryWorker.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: PushSenderService,
    private readonly msg91: Msg91Service,
  ) {}

  @Interval(30_000)
  async drain(): Promise<void> {
    if (process.env.PUSH_WORKER_ENABLED !== 'true') return;
    // Don't let a slow batch overlap with the next tick.
    if (this.running) return;
    this.running = true;

    try {
      await this.drainPush();
      await this.drainSms();
    } finally {
      this.running = false;
    }
  }

  /**
   * Atomically CLAIM a QUEUED row (flip QUEUED→PROCESSING) before doing any billable/observable
   * side-effect. Only the single writer whose updateMany matches the still-QUEUED row (count===1)
   * proceeds; a concurrent instance (the 30s interval racing the every-minute POST /v1/push/drain)
   * matches 0 rows and skips, so a row is never sent twice. Returns true iff THIS caller won it.
   */
  private async claimQueuedRow(id: string): Promise<boolean> {
    const res = await this.prisma.notificationQueue.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'PROCESSING' },
    });
    return res.count === 1;
  }

  /** PUSH leg — select QUEUED PUSH rows, atomically claim, send, mark, log, retry. */
  private async drainPush(): Promise<void> {
    try {
      const rows = await this.prisma.notificationQueue.findMany({
        where: { channel: 'PUSH', status: 'QUEUED' },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });

      for (const row of rows) {
        // Claim before sending so two instances can't both dispatch the same PUSH row. A losing
        // racer (count!==1) skips. Observable lifecycle is otherwise unchanged: PROCESSING→SENT
        // on success, PROCESSING→(QUEUED|FAILED) via markFailed on error.
        if (!(await this.claimQueuedRow(row.id))) continue;

        const payload: PushPayload = {
          title: row.subject ?? 'Notification',
          body: row.body,
          url: this.extractUrl(row.variables),
        };

        try {
          const sent = await this.sender.sendToUser(row.userId, payload);
          await this.markSent(row.id);
          await this.writeLog(row.id, 'PUSH', 'SENT', null, { endpointsSent: sent });
        } catch (e) {
          // sendToUser is best-effort and shouldn't throw, but guard anyway so one
          // row never aborts the batch.
          await this.markFailed(row.id, row.retryCount, row.maxRetries);
          await this.writeLog(row.id, 'PUSH', 'FAILED', String(e), { endpointsSent: 0 });
          this.logger.warn(`[push-worker] row ${row.id} failed: ${e}`);
        }
      }

      if (rows.length > 0) {
        this.logger.debug(`[push-worker] processed ${rows.length} PUSH row(s)`);
      }
    } catch (e) {
      // Missing table (pre-migration env), transient DB error, etc. — never crash.
      this.logger.warn(`[push-worker] drain skipped: ${e}`);
    }
  }

  /**
   * SMS leg — select QUEUED SMS rows, atomically CLAIM each, send via the MSG91 flow API, mark
   * SENT/FAILED, write the delivery log, retry to maxRetries.
   *
   * ATOMIC CLAIM (multi-instance safety): each SMS is billable, so a row is claimed (QUEUED→
   * PROCESSING) before the send; only the winner (count===1) calls sendSms, so the 30s interval
   * racing the every-minute POST /v1/push/drain can never double-send the same billed SMS.
   *
   * NULL-FIELD FILTER: the select requires a NON-NULL templateId AND recipientPhone, so the
   * pre-existing legacy dead-SMS rows (enqueued before this feature with templateId/phone NULL)
   * are NEVER picked up — they stay QUEUED and are never churned to FAILED. A currently-enqueued
   * row always carries both fields.
   * NEVER selects IN_APP (channel filter) — the feed rows are already SENT.
   */
  private async drainSms(): Promise<void> {
    try {
      const rows = await this.prisma.notificationQueue.findMany({
        where: {
          channel: 'SMS',
          status: 'QUEUED',
          // Skip legacy dead rows (NULL template/phone) so they're never selected or failed.
          templateId: { not: null },
          recipientPhone: { not: null },
        },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
        // Derive the receipt's tenant scope (clientId) from the recipient user (Wave 1 delivery
        // receipts). Additive: an absent user just means no receipt (send still proceeds).
        include: { user: { select: { clientId: true } } },
      });

      for (const row of rows) {
        // Claim before sending so a concurrent drain can't bill the same SMS twice. Loser skips.
        if (!(await this.claimQueuedRow(row.id))) continue;

        // ── Additive per-message delivery receipt (Wave 1 — DELIVERY-STATUS-REPORTING-SCOPE.md) ──
        // Create the receipt QUEUED FIRST with a generated crqid, echoed back by MSG91 on the SMS
        // DLR webhook → the status service correlates the callback to this row by crqid. BEST-EFFORT:
        // a receipt failure (e.g. pre-migration table, missing clientId) must NEVER break the
        // billable send — createSmsReceipt swallows its own errors and returns null, and the send
        // proceeds without a crqid (delivery tracking simply degrades for that one message).
        const receipt = await this.createSmsReceipt(row, row.user?.clientId ?? null);

        try {
          // Non-null by the select filter above; assert for the type checker. crqid is passed only
          // when a receipt exists (keeps the no-receipt call byte-identical to the prior 3-arg send).
          // Destructure defensively (`?? {}`) so a caller/mock returning no object never throws.
          const sendRes = receipt
            ? await this.msg91.sendSms(
                row.recipientPhone!,
                row.templateId!,
                this.smsVariables(row.variables),
                { crqid: receipt.crqid },
              )
            : await this.msg91.sendSms(
                row.recipientPhone!,
                row.templateId!,
                this.smsVariables(row.variables),
              );
          const requestId = (sendRes ?? {}).requestId ?? null;
          // The send SUCCEEDED (billed). Flip the receipt QUEUED→SENT FIRST (best-effort, guarded,
          // never throws) — done before the queue post-writes so that even if a queue write below
          // throws into the catch, the receipt is already SENT and its guarded markSmsReceiptFailed
          // (QUEUED-only) is a no-op → a BILLED message's receipt is NEVER flipped to FAILED.
          await this.markSmsReceiptSent(receipt, requestId);
          await this.markSent(row.id);
          await this.writeLog(row.id, 'SMS', 'SENT', null, null);
        } catch (e) {
          // A send failure (MSG91 error / timeout) — mark FAILED + bump retry, and keep going so
          // one bad row never aborts the batch. NotificationQueue transitions are unchanged.
          await this.markFailed(row.id, row.retryCount, row.maxRetries);
          await this.writeLog(row.id, 'SMS', 'FAILED', String(e), null);
          // Guarded (QUEUED-only): if the throw was the (unbilled) sendSms, the receipt flips to
          // FAILED; if a post-write threw after a billed send, the receipt is already SENT so this
          // is a no-op — a billed message can never end up FAILED.
          await this.markSmsReceiptFailed(receipt, String(e));
          this.logger.warn(`[push-worker] SMS row ${row.id} failed: ${e}`);
        }
      }

      if (rows.length > 0) {
        this.logger.debug(`[push-worker] processed ${rows.length} SMS row(s)`);
      }
    } catch (e) {
      // Missing table (pre-migration env), transient DB error, etc. — never crash.
      this.logger.warn(`[push-worker] SMS drain skipped: ${e}`);
    }
  }

  /**
   * Create the additive MessageDeliveryReceipt (channel SMS, status QUEUED) for a to-be-sent SMS.
   * Returns `{ id }` (used as the crqid) or null when a receipt can't be written — BEST-EFFORT:
   * this must never break the billable send, so every failure (pre-migration table, a recipient
   * with no derivable clientId, transient DB error) is swallowed with a log and returns null.
   *
   * The payout/scheme SMS that currently route through `msg91.sendOtp` (D5) are NOT covered here —
   * they get their receipt in a later step (they don't flow through this SMS drain leg).
   */
  private async createSmsReceipt(
    row: { templateId: string | null; recipientPhone: string | null },
    clientId: string | null,
  ): Promise<{ id: string; crqid: string } | null> {
    // clientId is required on the receipt (its tenant scope). Without it we can't write a valid
    // row — skip the receipt rather than fail (delivery tracking degrades for this one message).
    if (!clientId) return null;
    // The crqid is the correlation key echoed back by MSG91 on the DLR webhook. Must be
    // alphanumeric + hyphen-free (MSG91 CRQID constraint). 32 hex chars from Node's built-in
    // crypto — no external dependency (a new npm dep here would pass gates but crash at boot).
    const crqid = randomBytes(16).toString('hex');
    try {
      return await this.prisma.messageDeliveryReceipt.create({
        data: {
          clientId,
          channel: 'SMS',
          crqid,
          // eventKey: the queue row carries no trigger key, so the DLT templateId is the best
          // available handle for grouping in the report (nullable is fine).
          eventKey: row.templateId ?? undefined,
          recipientPhone: row.recipientPhone ?? undefined,
          status: 'QUEUED',
        },
        select: { id: true, crqid: true },
      });
    } catch (e) {
      this.logger.warn(`[push-worker] SMS delivery-receipt create skipped: ${e}`);
      return null;
    }
  }

  /**
   * Flip a receipt QUEUED→SENT (guarded on status:'QUEUED' so it's idempotent and can never be
   * downgraded from a terminal state later). BEST-EFFORT + billing-safe: a billed send must persist
   * SENT if at all possible, so we NEVER throw and NEVER write FAILED here — a total failure logs.
   */
  private async markSmsReceiptSent(
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
      this.logger.warn(`[push-worker] SMS receipt ${receipt.id} SENT write failed (left non-FAILED to avoid a false failure on a billed send): ${e}`);
    }
  }

  /**
   * Flip a receipt QUEUED→FAILED (guarded on status:'QUEUED'). Only ever applies to a receipt that
   * was never marked SENT — i.e. the send genuinely threw (unbilled). A receipt already SENT (billed
   * message) does NOT match the guard, so a billed message's receipt is never downgraded to FAILED.
   */
  private async markSmsReceiptFailed(
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
      this.logger.warn(`[push-worker] SMS receipt ${receipt.id} FAILED write failed: ${e}`);
    }
  }

  private async markSent(id: string): Promise<void> {
    await this.prisma.notificationQueue.update({
      where: { id },
      data: { status: 'SENT', processedAt: new Date() },
    });
  }

  private async markFailed(id: string, retryCount: number, maxRetries: number): Promise<void> {
    const nextRetry = retryCount + 1;
    // Exhausted retries → terminal FAILED; otherwise back to QUEUED for another pass.
    const status = nextRetry >= maxRetries ? 'FAILED' : 'QUEUED';
    await this.prisma.notificationQueue.update({
      where: { id },
      data: {
        status,
        retryCount: nextRetry,
        processedAt: status === 'FAILED' ? new Date() : null,
      },
    });
  }

  private async writeLog(
    queueId: string,
    channel: 'PUSH' | 'SMS',
    status: 'SENT' | 'FAILED',
    failureReason: string | null,
    providerResponse: Prisma.InputJsonValue | null,
  ): Promise<void> {
    await this.prisma.notificationDeliveryLog
      .create({
        data: {
          queueId,
          channel,
          status,
          deliveredAt: status === 'SENT' ? new Date() : null,
          failureReason,
          providerResponse: providerResponse ?? undefined,
        },
      })
      .catch((e) => this.logger.warn(`[push-worker] delivery-log write failed for ${queueId}: ${e}`));
  }

  /** Coerce the enqueued variables JSON into the { name: string } map sendSms spreads. */
  private smsVariables(variables: unknown): Record<string, string> {
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(variables as Record<string, unknown>)) {
      out[k] = v === null || v === undefined ? '' : String(v);
    }
    return out;
  }

  /** Pull an optional deep-link `url` out of the enqueued variables JSON. */
  private extractUrl(variables: unknown): string | undefined {
    if (variables && typeof variables === 'object' && 'url' in variables) {
      const url = (variables as { url?: unknown }).url;
      if (typeof url === 'string') return url;
    }
    return undefined;
  }
}
