import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * 90-day retention prune for `message_delivery_receipts` (D4).
 *
 * GATED OFF BY DEFAULT (`NOTIFICATIONS_RETENTION_ENABLED === 'true'`), mirroring the other dormant
 * workers (push-delivery / whatsapp-send). Ships dormant: no env opts in until the owner enables it,
 * so no live env deletes anything on deploy. The retention window is configurable via
 * `NOTIFICATIONS_RETENTION_DAYS` (default 90).
 *
 * SAFETY: prunes ONLY MessageDeliveryReceipt rows with `createdAt < now - Nd`, in bounded batches
 * (never one unbounded DELETE). Wrapped in try/catch so a missing table (pre-migration env) or a
 * transient DB error logs and is swallowed — never crashes the scheduler. Touches NOTHING else.
 */
@Injectable()
export class NotificationDeliveryRetentionWorker {
  private readonly logger = new Logger(NotificationDeliveryRetentionWorker.name);
  private running = false;

  private static readonly RETENTION_DAYS_DEFAULT = 90;
  private static readonly BATCH = 1000;

  constructor(private readonly prisma: PrismaService) {}

  @Interval(SIX_HOURS_MS)
  async prune(): Promise<{ deleted: number }> {
    if (process.env.NOTIFICATIONS_RETENTION_ENABLED !== 'true') return { deleted: 0 };
    // Don't let a slow prune overlap the next tick.
    if (this.running) return { deleted: 0 };
    this.running = true;
    try {
      return await this.runPrune();
    } finally {
      this.running = false;
    }
  }

  /**
   * The actual prune, callable directly (bypasses the env gate + interval — used by tests and any
   * future manual trigger). Batches the delete of rows older than the retention window.
   */
  async runPrune(): Promise<{ deleted: number }> {
    // Guard against a mis-typed non-positive env (e.g. "-5"), which would otherwise put the cutoff in
    // the FUTURE and prune the ENTIRE table. Floor at 1 day.
    const days = Math.max(
      1,
      Number(process.env.NOTIFICATIONS_RETENTION_DAYS ?? '') ||
        NotificationDeliveryRetentionWorker.RETENTION_DAYS_DEFAULT,
    );
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    let deleted = 0;
    try {
      // Bounded batches: select a page of old ids, delete them, repeat until none remain. A large
      // backlog is drained across ticks rather than in one huge DELETE that could lock/time out.
      for (;;) {
        const batch = await this.prisma.messageDeliveryReceipt.findMany({
          where: { createdAt: { lt: cutoff } },
          select: { id: true },
          take: NotificationDeliveryRetentionWorker.BATCH,
        });
        if (batch.length === 0) break;
        const res = await this.prisma.messageDeliveryReceipt.deleteMany({
          where: { id: { in: batch.map((b) => b.id) } },
        });
        deleted += res.count;
        if (batch.length < NotificationDeliveryRetentionWorker.BATCH) break;
      }
    } catch (e) {
      // Missing table (pre-migration env) / transient DB error — never crash the scheduler.
      this.logger.warn(`[notification-retention] prune skipped: ${e}`);
      return { deleted };
    }

    if (deleted > 0) {
      this.logger.log(
        `[notification-retention] pruned ${deleted} receipt(s) older than ${days}d`,
      );
    }
    return { deleted };
  }
}
