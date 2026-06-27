import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PushSenderService, PushPayload } from './push-sender.service';

const BATCH_SIZE = 50;

/**
 * Push delivery worker — drains QUEUED `NotificationQueue` rows on the PUSH channel
 * and dispatches them via the Web Push sender, then marks each row SENT (or FAILED
 * with a retry bump) and writes a NotificationDeliveryLog.
 *
 * GATED OFF BY DEFAULT (`PUSH_WORKER_ENABLED === 'true'`). The push_subscription /
 * PUSH-channel rows may not exist on an env until the orchestrator applies the
 * migration, and prod stays off until cutover — so the drain only runs when an env
 * explicitly opts in. The whole drain is wrapped in try/catch: a missing table or a
 * transient DB error logs and is swallowed, never crashing the scheduler/app.
 */
@Injectable()
export class PushDeliveryWorker {
  private readonly logger = new Logger(PushDeliveryWorker.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: PushSenderService,
  ) {}

  @Interval(30_000)
  async drain(): Promise<void> {
    if (process.env.PUSH_WORKER_ENABLED !== 'true') return;
    // Don't let a slow batch overlap with the next tick.
    if (this.running) return;
    this.running = true;

    try {
      const rows = await this.prisma.notificationQueue.findMany({
        where: { channel: 'PUSH', status: 'QUEUED' },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });

      for (const row of rows) {
        const payload: PushPayload = {
          title: row.subject ?? 'Notification',
          body: row.body,
          url: this.extractUrl(row.variables),
        };

        try {
          const sent = await this.sender.sendToUser(row.userId, payload);
          await this.markSent(row.id);
          await this.writeLog(row.id, 'SENT', null, sent);
        } catch (e) {
          // sendToUser is best-effort and shouldn't throw, but guard anyway so one
          // row never aborts the batch.
          await this.markFailed(row.id, row.retryCount, row.maxRetries);
          await this.writeLog(row.id, 'FAILED', String(e), 0);
          this.logger.warn(`[push-worker] row ${row.id} failed: ${e}`);
        }
      }

      if (rows.length > 0) {
        this.logger.debug(`[push-worker] processed ${rows.length} PUSH row(s)`);
      }
    } catch (e) {
      // Missing table (pre-migration env), transient DB error, etc. — never crash.
      this.logger.warn(`[push-worker] drain skipped: ${e}`);
    } finally {
      this.running = false;
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
    status: 'SENT' | 'FAILED',
    failureReason: string | null,
    endpointsSent: number,
  ): Promise<void> {
    await this.prisma.notificationDeliveryLog
      .create({
        data: {
          queueId,
          channel: 'PUSH',
          status,
          deliveredAt: status === 'SENT' ? new Date() : null,
          failureReason,
          providerResponse: { endpointsSent },
        },
      })
      .catch((e) => this.logger.warn(`[push-worker] delivery-log write failed for ${queueId}: ${e}`));
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
