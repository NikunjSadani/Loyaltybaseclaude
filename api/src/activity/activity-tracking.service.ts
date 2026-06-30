import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** IST is a fixed UTC+5:30 offset (India observes no DST). */
const IST_OFFSET_MIN = 5 * 60 + 30;

/**
 * Records, once per IST calendar day, that a user made an authenticated request —
 * the activity signal behind the Session Report's "active days" metric.
 *
 * Called fire-and-forget from JwtStrategy.validate (the choke point every
 * authenticated request passes through). It is deliberately:
 *   - NON-BLOCKING: never awaited on the request path, never throws;
 *   - DEDUPED in-memory to ~1 DB write per user per IST day per instance (the set
 *     holds only today's keys and resets when the IST day rolls over, so memory is
 *     bounded to roughly today's active users);
 *   - IDEMPOTENT across instances/races via the unique (userId, activityDate).
 *
 * "Active" = made >=1 authenticated request that day — NOT "logged in". A 7-day
 * access token means one login spans many active days, so login events would badly
 * undercount real usage.
 */
@Injectable()
export class ActivityTrackingService {
  private readonly logger = new Logger(ActivityTrackingService.name);

  /** The IST day the in-memory `seen` set currently represents. */
  private dayKey = '';
  /** `${userId}` keys already stamped for `dayKey` — skips a DB round-trip on repeat hits. */
  private seen = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /** The IST calendar date ('YYYY-MM-DD') for an instant. */
  static istDateKey(now: Date): string {
    // Shift the UTC instant by the IST offset, then read the date fields of the
    // shifted time as the IST wall-clock date.
    const shifted = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
    return shifted.toISOString().slice(0, 10);
  }

  /**
   * Stamp `userId` active for today (IST). Safe to call on every request — it
   * short-circuits in memory after the first hit each day and never blocks or
   * throws on the request path.
   */
  markActive(userId: string, clientId: string): void {
    try {
      const today = ActivityTrackingService.istDateKey(new Date());

      // Roll the in-memory window when the IST day changes.
      if (today !== this.dayKey) {
        this.dayKey = today;
        this.seen.clear();
      }

      if (this.seen.has(userId)) return;
      this.seen.add(userId);

      // DATE column: midnight-UTC of the IST calendar day. Grouping by its
      // year-month therefore yields IST months directly.
      const activityDate = new Date(`${today}T00:00:00.000Z`);

      void this.prisma.userActivityDay
        .upsert({
          where:  { userId_activityDate: { userId, activityDate } },
          create: { userId, clientId, activityDate },
          update: { lastSeenAt: new Date(), clientId },
        })
        .catch((e: unknown) => {
          // Drop the dedupe key so a later request this day retries the write.
          this.seen.delete(userId);
          this.logger.debug(
            `activity stamp failed for ${userId}: ${(e as Error)?.message ?? String(e)}`,
          );
        });
    } catch (e) {
      this.logger.debug(`markActive error: ${(e as Error)?.message ?? String(e)}`);
    }
  }
}
