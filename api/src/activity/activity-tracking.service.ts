import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { type ActivityContext, UNKNOWN_ACTIVITY_CONTEXT } from './client-medium';

/** IST is a fixed UTC+5:30 offset (India observes no DST). */
const IST_OFFSET_MIN = 5 * 60 + 30;

/** At most one DB write per user per this many ms, per instance (unless a NEW medium/device shows up). */
export const ACTIVITY_WRITE_THROTTLE_MS = 60_000;
/** A gap of at least this many seconds between recorded actions starts a NEW visit (owner-approved: 30 min). */
export const VISIT_GAP_SECONDS = 30 * 60;

/** Bit flags for the per-day medium/device booleans. */
const F_APP = 1;
const F_BROWSER = 2;
const F_PHONE = 4;
const F_COMPUTER = 8;

export function contextFlags(ctx: ActivityContext): number {
  return (
    (ctx.medium === 'app' ? F_APP : 0) |
    (ctx.medium === 'browser' ? F_BROWSER : 0) |
    (ctx.device === 'phone' ? F_PHONE : 0) |
    (ctx.device === 'computer' ? F_COMPUTER : 0)
  );
}

export interface ActivityUpsertParams {
  id: string;
  userId: string;
  clientId: string;
  /** IST calendar day 'YYYY-MM-DD'. */
  day: string;
  now: Date;
  flags: number;
}

/**
 * THE one atomic statement behind the Usage Report (docs/plans/USAGE-REPORT.md). Correct with any number of
 * writers (Cloud Run instances) because every accumulation is computed INSIDE the row-locked ON CONFLICT update
 * from the row's own stored values — never read-then-write in Node:
 *
 *   gap = now − stored lastSeenAt
 *   • first write of the day (INSERT)           → visits 1, activeSeconds 0
 *   • legacy row (visits = 0, written pre-ship) → visits 1, activeSeconds +0 (this write starts the first visit)
 *   • 0 < gap < 30 min                          → same visit: activeSeconds += gap
 *   • gap ≥ 30 min                              → new visit:  visits += 1, activeSeconds +0
 *   • gap ≤ 0 (a slower writer arriving late)   → nothing added; lastSeenAt keeps the later time (GREATEST)
 *   medium/device booleans are OR-ed in; firstSeenAt keeps the earliest time (LEAST).
 *
 * Each IST day is its own row, so a visit that spans midnight is split: day 1 keeps the time up to its last action
 * before midnight, day 2 starts a new visit at its first action after it (the minutes across midnight between those
 * two actions are not counted — consistent with "duration is a minimum").
 */
export function buildActivityUpsertSql(p: ActivityUpsertParams): Prisma.Sql {
  const app = (p.flags & F_APP) !== 0;
  const browser = (p.flags & F_BROWSER) !== 0;
  const phone = (p.flags & F_PHONE) !== 0;
  const computer = (p.flags & F_COMPUTER) !== 0;
  // The columns are TIMESTAMP(3) WITHOUT time zone holding UTC wall time (Prisma's convention). Send the instant
  // as UTC text and cast it, so the stored value never depends on the DB session's TimeZone setting.
  const ts = p.now.toISOString().replace('Z', '');
  const gap = Prisma.raw(`INTERVAL '${VISIT_GAP_SECONDS} seconds'`);
  return Prisma.sql`
    INSERT INTO "user_activity_day" AS d
      ("id", "userId", "clientId", "activityDate", "firstSeenAt", "lastSeenAt", "createdAt", "updatedAt",
       "visits", "activeSeconds", "appUsed", "browserUsed", "phoneUsed", "computerUsed")
    VALUES
      (${p.id}, ${p.userId}, ${p.clientId}, CAST(${p.day} AS date),
       CAST(${ts} AS timestamp(3)), CAST(${ts} AS timestamp(3)), CAST(${ts} AS timestamp(3)), CAST(${ts} AS timestamp(3)),
       1, 0, ${app}, ${browser}, ${phone}, ${computer})
    ON CONFLICT ("userId", "activityDate") DO UPDATE SET
      "activeSeconds" = d."activeSeconds" + CASE
        WHEN d."visits" > 0
         AND EXCLUDED."lastSeenAt" > d."lastSeenAt"
         AND EXCLUDED."lastSeenAt" - d."lastSeenAt" < ${gap}
        THEN FLOOR(EXTRACT(EPOCH FROM (EXCLUDED."lastSeenAt" - d."lastSeenAt")))::int
        ELSE 0 END,
      "visits" = d."visits" + CASE
        WHEN d."visits" = 0 THEN 1
        WHEN EXCLUDED."lastSeenAt" - d."lastSeenAt" >= ${gap} THEN 1
        ELSE 0 END,
      "lastSeenAt"   = GREATEST(d."lastSeenAt", EXCLUDED."lastSeenAt"),
      "firstSeenAt"  = LEAST(d."firstSeenAt", EXCLUDED."firstSeenAt"),
      "appUsed"      = d."appUsed" OR EXCLUDED."appUsed",
      "browserUsed"  = d."browserUsed" OR EXCLUDED."browserUsed",
      "phoneUsed"    = d."phoneUsed" OR EXCLUDED."phoneUsed",
      "computerUsed" = d."computerUsed" OR EXCLUDED."computerUsed",
      "clientId"     = EXCLUDED."clientId",
      "updatedAt"    = EXCLUDED."updatedAt"`;
}

interface ThrottleEntry {
  /** ms timestamp of the last write this instance sent for the user. */
  at: number;
  /** medium/device flags already sent for the user today (a new flag bypasses the throttle). */
  flags: number;
}

/**
 * Records per-user, per-IST-day activity: the Session Report's "active days" AND the Usage Report's visits,
 * duration (a minimum) and medium (installed app vs browser; phone vs computer).
 *
 * Called fire-and-forget from JwtStrategy.validate (the choke point every authenticated request passes through).
 * It is deliberately:
 *   - NON-BLOCKING: never awaited on the request path, never throws;
 *   - THROTTLED in memory to ≤ 1 DB write per user per 60 s per instance — except that a request bringing a
 *     medium/device not yet sent today writes immediately, so the throttle never hides how someone used the app.
 *     Duration therefore has ~1-minute resolution (up to a minute per visit can go uncounted — it's a minimum).
 *     The map holds only today's users and resets when the IST day rolls over;
 *   - MULTI-INSTANCE SAFE: all accumulation happens in ONE atomic SQL upsert (buildActivityUpsertSql).
 *
 * "Active" = made ≥ 1 authenticated request that day — NOT "logged in".
 */
@Injectable()
export class ActivityTrackingService {
  private readonly logger = new Logger(ActivityTrackingService.name);

  /** The IST day the in-memory throttle map currently represents. */
  private dayKey = '';
  /** userId → last write sent (for `dayKey`). */
  private readonly sent = new Map<string, ThrottleEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /** The IST calendar date ('YYYY-MM-DD') for an instant. */
  static istDateKey(now: Date): string {
    // Shift the UTC instant by the IST offset, then read the date fields of the
    // shifted time as the IST wall-clock date.
    const shifted = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
    return shifted.toISOString().slice(0, 10);
  }

  /**
   * Record that `userId` acted now. Safe to call on every request — it returns synchronously, skips the DB
   * when throttled, and never blocks or throws on the request path. `now` is injectable for tests only.
   */
  markActive(
    userId: string,
    clientId: string,
    ctx: ActivityContext = UNKNOWN_ACTIVITY_CONTEXT,
    now: Date = new Date(),
  ): void {
    try {
      if (!userId || !clientId) return;
      const day = ActivityTrackingService.istDateKey(now);

      // Roll the in-memory window when the IST day changes.
      if (day !== this.dayKey) {
        this.dayKey = day;
        this.sent.clear();
      }

      const flags = contextFlags(ctx ?? UNKNOWN_ACTIVITY_CONTEXT);
      const nowMs = now.getTime();
      const prev = this.sent.get(userId);
      if (prev && nowMs - prev.at < ACTIVITY_WRITE_THROTTLE_MS && (prev.flags | flags) === prev.flags) return;

      const entry: ThrottleEntry = { at: nowMs, flags: (prev?.flags ?? 0) | flags };
      this.sent.set(userId, entry);

      void this.prisma
        .$executeRaw(buildActivityUpsertSql({ id: randomUUID(), userId, clientId, day, now, flags }))
        .catch((e: unknown) => {
          // Forget this write so the user's next request retries (unless a newer write already replaced it).
          if (this.sent.get(userId) === entry) this.sent.delete(userId);
          this.logger.debug(`activity stamp failed for ${userId}: ${(e as Error)?.message ?? String(e)}`);
        });
    } catch (e) {
      // A synchronous failure (e.g. the client threw before returning a promise): never reaches the request.
      this.sent.delete(userId);
      this.logger.debug(`markActive error: ${(e as Error)?.message ?? String(e)}`);
    }
  }
}
