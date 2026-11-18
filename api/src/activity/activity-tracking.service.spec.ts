import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVITY_FAILURE_BACKOFF_MS,
  ACTIVITY_MAX_IN_FLIGHT,
  ACTIVITY_WRITE_THROTTLE_MS,
  ActivityTrackingService,
  buildActivityUpsertSql,
  contextFlags,
} from './activity-tracking.service';
import type { ActivityContext } from './client-medium';
import { startPgliteTestDb, type PgliteTestDb } from '../common/testing/pglite-testkit-spec';

const APP_PHONE: ActivityContext = { medium: 'app', device: 'phone' };
const BROWSER_PC: ActivityContext = { medium: 'browser', device: 'computer' };
const UNKNOWN: ActivityContext = { medium: 'unknown', device: 'unknown' };

/** 10:00:00 IST on 2026-11-20 (= 04:30Z). */
const T0 = new Date('2026-11-20T04:30:00.000Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

describe('ActivityTrackingService', () => {
  describe('istDateKey', () => {
    it('returns the IST calendar date for an instant before the IST midnight roll', () => {
      // 2026-06-30T18:00:00Z = 2026-06-30 23:30 IST → still June 30 (IST)
      expect(ActivityTrackingService.istDateKey(new Date('2026-06-30T18:00:00Z'))).toBe('2026-06-30');
    });

    it('rolls to the next IST day after 18:30Z (00:00 IST)', () => {
      // 2026-06-30T20:00:00Z = 2026-07-01 01:30 IST → July 1 (IST), not June 30
      expect(ActivityTrackingService.istDateKey(new Date('2026-06-30T20:00:00Z'))).toBe('2026-07-01');
    });

    it('handles the exact IST midnight boundary (18:30Z)', () => {
      expect(ActivityTrackingService.istDateKey(new Date('2026-06-30T18:30:00Z'))).toBe('2026-07-01');
    });
  });

  // ── Hot path: throttle, never blocks, never throws (mocked Prisma) ──────────────────────────────────
  describe('markActive (throttle + hot path)', () => {
    function makePrisma(impl: () => Promise<unknown> = () => Promise.resolve(1)) {
      return { $executeRaw: jest.fn(impl) } as any;
    }
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    it('writes on the first hit, then at most once per 60 s per user', () => {
      const prisma = makePrisma();
      const svc = new ActivityTrackingService(prisma);

      svc.markActive('u1', 'bajaj', APP_PHONE, at(0));
      svc.markActive('u1', 'bajaj', APP_PHONE, at(10));
      svc.markActive('u1', 'bajaj', APP_PHONE, at(59));
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);

      svc.markActive('u1', 'bajaj', APP_PHONE, at(60)); // exactly 60 s later → writes
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
      svc.markActive('u1', 'bajaj', APP_PHONE, at(90));
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
      expect(ACTIVITY_WRITE_THROTTLE_MS).toBe(60_000);
    });

    it('throttles each user independently', () => {
      const prisma = makePrisma();
      const svc = new ActivityTrackingService(prisma);
      svc.markActive('u1', 'bajaj', APP_PHONE, at(0));
      svc.markActive('u2', 'bajaj', APP_PHONE, at(1));
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('a NEW medium/device inside the 60 s window bypasses the throttle (so the medium is never lost)', async () => {
      const prisma = makePrisma();
      const svc = new ActivityTrackingService(prisma);
      // requests are seconds apart in reality — let each write settle (the in-flight cap is 2)
      svc.markActive('u1', 'bajaj', UNKNOWN, at(0)); // e.g. a server-side call with no header
      await flush();
      svc.markActive('u1', 'bajaj', APP_PHONE, at(5)); // first app+phone request → must write
      await flush();
      svc.markActive('u1', 'bajaj', APP_PHONE, at(6)); // nothing new → throttled
      await flush();
      svc.markActive('u1', 'bajaj', BROWSER_PC, at(7)); // browser+computer is new → writes
      await flush();
      svc.markActive('u1', 'bajaj', { medium: 'app', device: 'computer' }, at(8)); // both already sent → throttled
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    });

    it('the IST day roll resets the throttle (first request after midnight always writes)', () => {
      const prisma = makePrisma();
      const svc = new ActivityTrackingService(prisma);
      const beforeMidnight = new Date('2026-11-20T18:29:50.000Z'); // 23:59:50 IST
      const afterMidnight = new Date('2026-11-20T18:30:10.000Z'); // 00:00:10 IST next day
      svc.markActive('u1', 'bajaj', APP_PHONE, beforeMidnight);
      svc.markActive('u1', 'bajaj', APP_PHONE, afterMidnight);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
      const days = prisma.$executeRaw.mock.calls.map((c: any[]) => c[0].values[3]);
      expect(days).toEqual(['2026-11-20', '2026-11-21']);
    });

    it('passes userId / clientId / IST day / medium flags into the statement', () => {
      const prisma = makePrisma();
      const svc = new ActivityTrackingService(prisma);
      svc.markActive('u1', 'bajaj', APP_PHONE, at(0));
      const sql = prisma.$executeRaw.mock.calls[0][0];
      expect(sql.values.slice(1, 4)).toEqual(['u1', 'bajaj', '2026-11-20']);
      expect(sql.values.slice(-4)).toEqual([true, false, true, false]); // app, browser, phone, computer
    });

    it('returns synchronously (void) and never awaits the DB — a write that never settles does not block', () => {
      const prisma = makePrisma(() => new Promise(() => undefined)); // never settles
      const svc = new ActivityTrackingService(prisma);
      const ret = svc.markActive('u1', 'bajaj', APP_PHONE, at(0));
      expect(ret).toBeUndefined();
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('a rejected write never throws, KEEPS the throttle entry and backs the user off for 5 min (no retry storm)', async () => {
      const prisma = makePrisma(() => Promise.reject(new Error('column "visits" does not exist')));
      const svc = new ActivityTrackingService(prisma);
      expect(() => svc.markActive('u1', 'bajaj', APP_PHONE, at(0))).not.toThrow();
      await flush();
      svc.markActive('u1', 'bajaj', APP_PHONE, at(1)); // next request: NOT retried
      svc.markActive('u1', 'bajaj', BROWSER_PC, at(90)); // even a new medium waits for the backoff
      svc.markActive('u1', 'bajaj', APP_PHONE, at(4 * 60 + 59));
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      svc.markActive('u1', 'bajaj', APP_PHONE, at(ACTIVITY_FAILURE_BACKOFF_MS / 1000)); // backoff over → writes
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
      // the failed write's flags were un-marked, so the post-backoff write carries them again
      expect(prisma.$executeRaw.mock.calls[1][0].values.slice(-4)).toEqual([true, false, true, false]);
      await flush();
      expect(svc.stats()).toMatchObject({ failed: 2, inFlight: 0 });
    });

    it('a client that throws synchronously never throws to the caller and is backed off too', () => {
      const prisma = {
        $executeRaw: jest.fn(() => {
          throw new Error('sync boom');
        }),
      } as any;
      const svc = new ActivityTrackingService(prisma);
      expect(() => svc.markActive('u1', 'bajaj', APP_PHONE, at(0))).not.toThrow();
      expect(() => svc.markActive('u1', 'bajaj', APP_PHONE, at(1))).not.toThrow();
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(svc.stats().inFlight).toBe(0); // the counter never leaks
    });

    it(`caps in-flight writes per instance at ${ACTIVITY_MAX_IN_FLIGHT}; beyond that writes are dropped, not queued`, async () => {
      const resolvers: Array<() => void> = [];
      const prisma = makePrisma(() => new Promise<void>((r) => resolvers.push(r)));
      const svc = new ActivityTrackingService(prisma);
      for (let i = 0; i < 9; i++) svc.markActive(`u${i}`, 'bajaj', APP_PHONE, at(i));
      expect(ACTIVITY_MAX_IN_FLIGHT).toBe(2); // small share of the ~10-connection pool per instance
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(ACTIVITY_MAX_IN_FLIGHT);
      expect(svc.stats()).toMatchObject({ inFlight: ACTIVITY_MAX_IN_FLIGHT, dropped: 9 - ACTIVITY_MAX_IN_FLIGHT });
      resolvers.forEach((r) => r());
      await flush();
      expect(svc.stats().inFlight).toBe(0);
      // a dropped user was not marked as sent → their next request writes
      svc.markActive('u8', 'bajaj', APP_PHONE, at(20));
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(ACTIVITY_MAX_IN_FLIGHT + 1);
    });

    it('ignores a missing userId / clientId', () => {
      const prisma = makePrisma();
      const svc = new ActivityTrackingService(prisma);
      svc.markActive('', 'bajaj', APP_PHONE, at(0));
      svc.markActive('u1', '', APP_PHONE, at(0));
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('defaults to an unknown medium when none is given (old call shape still works)', () => {
      const prisma = makePrisma();
      const svc = new ActivityTrackingService(prisma);
      svc.markActive('u1', 'bajaj');
      expect(prisma.$executeRaw.mock.calls[0][0].values.slice(-4)).toEqual([false, false, false, false]);
    });
  });

  // ── The atomic SQL, executed against a REAL Postgres engine (PGlite, in-process) ───────────────────────
  describe('buildActivityUpsertSql — real Postgres semantics', () => {
    // PGlite (real Postgres compiled to WASM) in a forked child — see common/testing/pglite-testkit-spec.ts.
    let db: PgliteTestDb;
    const MIG = join(__dirname, '..', '..', 'prisma', 'migrations');

    beforeAll(async () => {
      db = startPgliteTestDb();
      // The real table DDL: the original CREATE TABLE (minus the users FK — no users table here) + this change's
      // migration file exactly as it will run in prod (SET/RESET lock_timeout included).
      const create = readFileSync(join(MIG, '20260630120000_add_user_activity_day', 'migration.sql'), 'utf8').replace(
        /-- AddForeignKey[\s\S]*$/,
        '',
      );
      await db.exec(create);
      await db.exec(readFileSync(join(MIG, '20261118190000_user_activity_usage', 'migration.sql'), 'utf8'));
      // Idempotent: running the migration again is a no-op, not an error.
      await db.exec(readFileSync(join(MIG, '20261118190000_user_activity_usage', 'migration.sql'), 'utf8'));
    }, 60_000);

    afterAll(async () => {
      await db?.close();
    });

    beforeEach(async () => {
      await db.exec('DELETE FROM "user_activity_day"');
    });

    let seq = 0;
    async function write(userId: string, now: Date, ctx: ActivityContext = APP_PHONE, clientId = 'bajaj') {
      const sql = buildActivityUpsertSql({
        id: `row-${++seq}`,
        userId,
        clientId,
        day: ActivityTrackingService.istDateKey(now),
        now,
        flags: contextFlags(ctx),
      });
      await db.query(sql.text, sql.values as unknown[]);
    }
    /** Timestamps come back as UTC ISO text (to_char), so nothing depends on how the driver parses them. */
    const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
    async function rows(userId = 'u1') {
      return db.query<any>(
        `SELECT to_char("activityDate", 'YYYY-MM-DD') AS day, "visits", "activeSeconds", "appUsed", "browserUsed",
                "phoneUsed", "computerUsed", to_char("firstSeenAt", ${ISO}) AS "firstSeenAt",
                to_char("lastSeenAt", ${ISO}) AS "lastSeenAt", "clientId"
           FROM "user_activity_day" WHERE "userId" = $1 ORDER BY "activityDate"`,
        [userId],
      );
    }

    it('first write of the day → 1 visit, 0 seconds, medium flags set', async () => {
      await write('u1', at(0), APP_PHONE);
      const [r] = await rows();
      expect(r).toMatchObject({ day: '2026-11-20', visits: 1, activeSeconds: 0, appUsed: true, browserUsed: false, phoneUsed: true, computerUsed: false });
    });

    it('consecutive actions inside one visit accumulate the gaps (first → last action)', async () => {
      await write('u1', at(0));
      await write('u1', at(60));
      await write('u1', at(180));
      await write('u1', at(29 * 60 + 179)); // gap 29m59s → still the same visit
      const [r] = await rows();
      expect(r.visits).toBe(1);
      expect(r.activeSeconds).toBe(29 * 60 + 179);
    });

    it('a gap of 30 minutes or more starts a new visit and adds nothing for the idle time', async () => {
      await write('u1', at(0));
      await write('u1', at(300)); // +5 min
      await write('u1', at(300 + 30 * 60)); // exactly 30 min idle → new visit
      await write('u1', at(300 + 30 * 60 + 120)); // +2 min in visit 2
      const [r] = await rows();
      expect(r.visits).toBe(2);
      expect(r.activeSeconds).toBe(300 + 120);
    });

    it('medium/device flags OR-accumulate across the day', async () => {
      await write('u1', at(0), APP_PHONE);
      await write('u1', at(60), BROWSER_PC);
      await write('u1', at(120), UNKNOWN); // unknown never clears anything
      const [r] = await rows();
      expect(r).toMatchObject({ appUsed: true, browserUsed: true, phoneUsed: true, computerUsed: true });
    });

    it('midnight: a visit spanning IST midnight is split into two days', async () => {
      const d1 = new Date('2026-11-20T18:20:00.000Z'); // 23:50 IST
      await write('u1', d1);
      await write('u1', new Date(d1.getTime() + 5 * 60_000)); // 23:55 IST
      await write('u1', new Date('2026-11-20T18:32:00.000Z')); // 00:02 IST next day
      await write('u1', new Date('2026-11-20T18:40:00.000Z')); // 00:10 IST
      const [day1, day2] = await rows();
      expect(day1).toMatchObject({ day: '2026-11-20', visits: 1, activeSeconds: 300 });
      expect(day2).toMatchObject({ day: '2026-11-21', visits: 1, activeSeconds: 480 });
    });

    it('two writers (instances) racing: a late, OLDER write adds nothing and never moves lastSeenAt back', async () => {
      await write('u1', at(0));
      await write('u1', at(120)); // instance A
      await write('u1', at(60)); // instance B's older request lands after A's
      const [r] = await rows();
      expect(r.visits).toBe(1);
      expect(r.activeSeconds).toBe(120);
      expect(r.lastSeenAt).toBe(at(120).toISOString());
    });

    it('two writers interleaving in order give the same total as one writer (first → last)', async () => {
      // Instance A and B each throttle independently, so their writes interleave; the DB row serialises them.
      const times = [0, 30, 61, 95, 125, 160, 200];
      await Promise.all(times.map((s) => write('u1', at(s)))); // concurrent submission
      const [r] = await rows();
      // Whatever order they land in, the counted time can never exceed first→last, and no visit is invented.
      expect(r.visits).toBe(1);
      expect(r.activeSeconds).toBeLessThanOrEqual(200);
      // In submission order (what a real row lock produces for in-order arrivals) it is exactly first→last.
      await db.exec('DELETE FROM "user_activity_day"');
      for (const s of times) await write('u1', at(s));
      expect((await rows())[0].activeSeconds).toBe(200);
    });

    it('two different rows racing to INSERT the same (user, day) end as ONE row (unique conflict → update)', async () => {
      await Promise.all([write('u1', at(0)), write('u1', at(10))]);
      const r = await rows();
      expect(r).toHaveLength(1);
      expect(r[0].visits).toBe(1);
    });

    it('a legacy (pre-ship) row with visits = 0 starts its first tracked visit without inventing time', async () => {
      await db.query(
        `INSERT INTO "user_activity_day" ("id","userId","clientId","activityDate","firstSeenAt","lastSeenAt","updatedAt")
         VALUES ('legacy','u1','bajaj','2026-11-20',$1,$1,$1)`,
        [at(-600).toISOString().replace('Z', '')],
      );
      await write('u1', at(0)); // 10 min after the legacy stamp
      const [r] = await rows();
      expect(r.visits).toBe(1);
      expect(r.activeSeconds).toBe(0);
      expect(r.firstSeenAt).toBe(at(-600).toISOString()); // earliest kept
    });

    it('stores UTC wall time regardless of the DB session time zone', async () => {
      await db.exec(`SET TIME ZONE 'Asia/Kolkata'`);
      try {
        await write('u1', at(0));
      } finally {
        await db.exec(`SET TIME ZONE 'UTC'`);
      }
      const [r] = await rows();
      expect(r.firstSeenAt).toBe(at(0).toISOString());
    });

    it('the service + throttle + SQL together: a 20-minute session of requests every 10 s → 1 visit, ≥ 19 min', async () => {
      const svc = new ActivityTrackingService({
        $executeRaw: (sql: any) => db.query(sql.text, sql.values),
      } as any);
      for (let s = 0; s <= 20 * 60; s += 10) {
        svc.markActive('u1', 'bajaj', APP_PHONE, at(s));
        // real requests are seconds apart — let each write land (the in-flight cap would drop a burst)
        while (svc.stats().inFlight > 0) await new Promise((r) => setTimeout(r, 2));
      }
      const [r] = await rows();
      expect(r.visits).toBe(1);
      expect(r.activeSeconds).toBe(20 * 60); // writes at 0,60,…,1200 — the last action lands on a write
    });
  });
});
