/**
 * AuthService.refreshToken × REAL Postgres (B5, 2026-11-19 concurrent-refresh race + S2).
 *
 * Proves, against a real multi-connection Postgres, what auth.service.refresh-race.spec.ts proves against an
 * in-memory row-lock fake:
 *   1. N parallel refreshes of ONE token converge on ONE successor (claim + mint in one row-locked tx) — no 401.
 *   2. S2: a logout-all style STAMP + SWEEP inside ONE interactive transaction (admin-outlets deactivation, KYC
 *      phone change) cannot be out-raced by a concurrent refresh, in either lock order — the refresh's
 *      `SELECT … FROM users … FOR SHARE` inside its claim transaction orders it against the stamp.
 *
 * HOW TO RUN (never against a shared DB — the harness refuses non-localhost hosts and never reads DATABASE_URL):
 *   # real concurrency (the proof): a throw-away local Postgres ≥ 13, e.g.
 *   #   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=wre postgres:16
 *   WRE_PG_ADMIN_URL=postgresql://postgres:wre@localhost:55432/postgres \
 *     npx jest --config ./test/jest-e2e.json auth-refresh-race --maxWorkers=1
 *   # suite self-check only (PGlite, single session → SERIALISED; the gated race tests skip):
 *   WRE_PG_EMBEDDED=pglite npx jest --config ./test/jest-e2e.json auth-refresh-race --maxWorkers=1
 * Neither variable set → the whole suite is skipped.
 */
import { randomBytes } from 'node:crypto';
import { Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import type { Client } from 'pg';
import { AuthService } from '../src/auth/auth.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { DisposableDb, disposableMode, startDisposableDb } from './support/disposable-postgres';

jest.setTimeout(180_000);

const MODE = disposableMode();
const d = MODE ? describe : describe.skip;
/** Needs truly parallel sessions (real server). */
const itServer = MODE === 'server' ? it : it.skip;
const rid = () => randomBytes(4).toString('hex');
const HOUR = 60 * 60_000;

d(`AuthService.refreshToken × real Postgres [${MODE ?? 'skipped'}]`, () => {
  let db: DisposableDb;
  let prisma: PrismaClient;
  let auth: AuthService;
  let monitor: Client | null = null;
  let holder: Client | null = null;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    db = await startDisposableDb({ poolSize: 30 });
    prisma = db.prisma({ poolSize: 30 });
    const config = { get: (k: string) => (k === 'JWT_SECRET' ? 'e2e-secret' : k === 'JWT_EXPIRES_IN' ? '60m' : undefined) };
    auth = new AuthService(
      prisma as unknown as PrismaService,
      new JwtService({}),
      config as never,
      {} as never,
      {} as never,
      {} as never,
      { hasGrantUncached: async () => true } as never,
      {} as never,
    );
    if (db.concurrent) {
      monitor = await db.rawClient();
      holder = await db.rawClient();
    }
  });

  afterAll(async () => {
    if (db) await db.dispose();
  });

  async function seedUserWithSession(): Promise<{ userId: string; sessionId: string; refreshToken: string }> {
    const userId = `u_${rid()}`;
    const sessionId = `s_${rid()}`;
    const refreshToken = `R_${rid()}`;
    await prisma.user.create({
      data: { id: userId, clientId: `t_${rid()}`, phone: `9${Date.now() % 1e9}`, name: 'E2E', role: 'WHOLESALER', status: 'ACTIVE' },
    });
    await prisma.userSession.create({
      data: {
        id: sessionId,
        userId,
        clientId: 'deoleo',
        token: `access_${rid()}`,
        refreshToken,
        expiresAt: new Date(Date.now() + 24 * HOUR),
        createdAt: new Date(Date.now() - HOUR),
      },
    });
    return { userId, sessionId, refreshToken };
  }

  const liveSessions = (userId: string) =>
    prisma.userSession.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } });

  async function waitForLockWaiters(n: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { rows } = await monitor!.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (rows[0].n >= n) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} lock waiter(s); have ${rows[0].n}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('10 parallel refreshes of the SAME token → all succeed with the SAME successor pair, exactly one successor row', async () => {
    const { userId, sessionId, refreshToken } = await seedUserWithSession();

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => auth.refreshToken(refreshToken)));

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const pairs = results.map((r) => (r as PromiseFulfilledResult<{ accessToken: string; refreshToken: string }>).value);
    for (const p of pairs) expect(p).toEqual(pairs[0]);
    expect(await prisma.userSession.count({ where: { rotatedFromId: sessionId } })).toBe(1);
    expect(await liveSessions(userId)).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.sessionsInvalidBefore).toBeNull(); // no false-positive theft response
  });

  itServer('S2: stamp written (uncommitted) FIRST, refresh arrives → refresh waits on the user row, then refuses; nothing live survives', async () => {
    const { userId, refreshToken } = await seedUserWithSession();

    await holder!.query('BEGIN');
    await holder!.query(`UPDATE "users" SET "sessionsInvalidBefore" = now() WHERE "id" = $1`, [userId]);
    const refresh = auth.refreshToken(refreshToken).then(() => 'ok' as const, (e: unknown) => e);
    await waitForLockWaiters(1); // the refresh is blocked on FOR SHARE behind our uncommitted stamp
    await holder!.query(`UPDATE "user_sessions" SET "revokedAt" = now() WHERE "userId" = $1 AND "revokedAt" IS NULL`, [userId]);
    await holder!.query('COMMIT');

    // Refused either way: 401 (it waited, then saw the stamp) or 503 (lock_timeout hit first) —
    // never a 200, and nothing for the pre-stamp lineage survives.
    const result = await refresh;
    expect(result === 'ok').toBe(false);
    expect([UnauthorizedException, ServiceUnavailableException].some((E) => result instanceof E)).toBe(true);
    expect(await liveSessions(userId)).toBe(0);
  });

  itServer('S2: refresh holds the user share lock FIRST, stamp+sweep tx arrives → the sweep still revokes the new successor', async () => {
    const { userId, sessionId, refreshToken } = await seedUserWithSession();

    // Stall the refresh INSIDE its claim tx: it takes FOR SHARE on the user row, then blocks claiming the
    // session row we hold FOR UPDATE.
    await holder!.query('BEGIN');
    await holder!.query(`SELECT 1 FROM "user_sessions" WHERE "id" = $1 FOR UPDATE`, [sessionId]);
    const refresh = auth.refreshToken(refreshToken).then(() => 'ok' as const, (e: unknown) => e);
    await waitForLockWaiters(1);

    // The stamper (same shape as admin-outlets / KYC: stamp then sweep in ONE interactive tx) now blocks on
    // the refresh's share lock on the user row.
    const stamper = prisma.$transaction(async (tx) => {
      await tx.user.updateMany({ where: { id: { in: [userId] } }, data: { sessionsInvalidBefore: new Date() } });
      await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    await waitForLockWaiters(2);
    await holder!.query('ROLLBACK'); // release: refresh claims + mints + commits, then the stamper runs

    await Promise.all([refresh, stamper]);
    expect(await liveSessions(userId)).toBe(0); // the successor the refresh minted did NOT survive the sweep
  });

  itServer('F1: refresh blocked on a user-row lock → rolls back at lock_timeout (~1s, 503), predecessor LIVE, a later retry succeeds', async () => {
    const { userId, sessionId, refreshToken } = await seedUserWithSession();

    await holder!.query('BEGIN');
    await holder!.query(`UPDATE "users" SET "name" = 'held' WHERE "id" = $1`, [userId]); // long writer
    const started = Date.now();
    const first = await auth.refreshToken(refreshToken).then(() => 'ok' as const, (e: unknown) => e);
    const took = Date.now() - started;
    await holder!.query('ROLLBACK');

    expect(first).toBeInstanceOf(ServiceUnavailableException);
    expect(took).toBeLessThan(2_500);
    const row = await prisma.userSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.revokedAt).toBeNull(); // the claim rolled back with the tx
    expect(await prisma.userSession.count({ where: { rotatedFromId: sessionId } })).toBe(0);

    const retry = await auth.refreshToken(refreshToken);
    expect(retry.refreshToken).toBeTruthy();
    expect(await prisma.userSession.count({ where: { rotatedFromId: sessionId } })).toBe(1);
  });

  it('F1: receipt + budget already spent (stalled before the tx) → 503, nothing committed, predecessor LIVE', async () => {
    const { sessionId, refreshToken } = await seedUserWithSession();
    await expect(auth.refreshToken(refreshToken, { receivedAt: Date.now() - 5_000 })).rejects.toBeInstanceOf(ServiceUnavailableException);
    const row = await prisma.userSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.revokedAt).toBeNull();
  });

  it('S2: a past absolute deadline / tiny budget is floored → the refresh rotates (no free 503 liveness probe)', async () => {
    const { sessionId, refreshToken } = await seedUserWithSession();
    const res = await auth.refreshToken(refreshToken, { clientDeadlineMs: Date.now() - 60_000, budgetMs: 1 });
    expect(res.refreshToken).toBeTruthy();
    expect(await prisma.userSession.count({ where: { rotatedFromId: sessionId } })).toBe(1);
  });

  it('S1/H4: a rotated token replayed past grace while its successor is live AND USED → reuse kill, nothing handed back', async () => {
    const { userId, sessionId, refreshToken } = await seedUserWithSession();
    const first = await auth.refreshToken(refreshToken); // legit rotation R0 → R1
    // Age the rotation past the grace window, and mark R1's session used (JWT guard first-use stamp).
    await prisma.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date(Date.now() - 2 * HOUR) } });
    await prisma.userSession.updateMany({ where: { rotatedFromId: sessionId }, data: { firstUsedAt: new Date() } });

    await expect(auth.refreshToken(refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await liveSessions(userId)).toBe(0); // R1's session killed too
    await expect(auth.refreshToken(first.refreshToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await prisma.auditLog.count({ where: { entityType: 'SECURITY_EVENT', entityId: userId } })).toBe(1);
  });

  it.each([
    ['30 seconds', 30_000],
    ['2 hours', 2 * HOUR],
    ['2 days', 48 * HOUR],
  ])('C1: lost response — the old token replayed %s later from the SAME device, successor never used → renewed forward, stays logged in', async (_l, ago) => {
    const { userId, sessionId, refreshToken } = await seedUserWithSession();
    const first = await auth.refreshToken(refreshToken, { fingerprint: 'fp-e2e-phone' }); // response "lost"
    await prisma.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date(Date.now() - ago) } });

    const replay = await auth.refreshToken(refreshToken, { fingerprint: 'fp-e2e-phone' });

    expect(replay.refreshToken).not.toBe(first.refreshToken); // a FRESH pair (renewed forward)
    const b = await prisma.userSession.findFirstOrThrow({ where: { rotatedFromId: sessionId } });
    expect(b.handedBackAt).toBeInstanceOf(Date);
    expect(b.revokedAt).toBeInstanceOf(Date);
    const c = await prisma.userSession.findFirstOrThrow({ where: { rotatedFromId: b.id } });
    expect(c.refreshToken).toBe(replay.refreshToken);
    expect(c.createdFingerprint).toBe(b.createdFingerprint); // bound to the same device
    expect(await liveSessions(userId)).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: 'SECURITY_EVENT', entityId: userId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityType: 'AUTH_EVENT', entityId: userId, action: 'REFRESH_HANDOFF' } })).toBe(1);
  });

  it('H-A (a): the handback reply is lost TOO — same device replays the old token again later → renewed again, still signed in', async () => {
    const { userId, sessionId, refreshToken } = await seedUserWithSession();
    await auth.refreshToken(refreshToken, { fingerprint: 'fp-e2e-phone' }); // lost
    await prisma.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date(Date.now() - 2 * HOUR) } });
    const first = await auth.refreshToken(refreshToken, { fingerprint: 'fp-e2e-phone' }); // handback reply lost too
    await prisma.userSession.updateMany({ where: { userId, handedBackAt: { not: null } }, data: { handedBackAt: new Date(Date.now() - 60_000) } });

    const second = await auth.refreshToken(refreshToken, { fingerprint: 'fp-e2e-phone' });

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(await liveSessions(userId)).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: 'SECURITY_EVENT', entityId: userId } })).toBe(0);
  });

  it('H-A (c): the old token replayed from a DIFFERENT device → 401, only that lineage ends + SECURITY_EVENT, nothing renewed', async () => {
    const { userId, sessionId, refreshToken } = await seedUserWithSession();
    await auth.refreshToken(refreshToken, { fingerprint: 'fp-e2e-phone' });
    await prisma.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date(Date.now() - 2 * HOUR) } });

    await expect(auth.refreshToken(refreshToken, { fingerprint: 'fp-e2e-thief' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await liveSessions(userId)).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityType: 'SECURITY_EVENT', entityId: userId } })).toBe(1);
  });

  itServer('S-H1b: two CONCURRENT post-grace replays of the same old token → exactly one renewal, both get the same pair', async () => {
    const { userId, sessionId, refreshToken } = await seedUserWithSession();
    await auth.refreshToken(refreshToken, { fingerprint: 'fp-e2e-phone' });
    await prisma.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date(Date.now() - 2 * HOUR) } });

    const [a, b] = await Promise.all([
      auth.refreshToken(refreshToken, { fingerprint: 'fp-e2e-phone' }),
      auth.refreshToken(refreshToken, { fingerprint: 'fp-e2e-phone' }),
    ]);

    expect(b).toEqual(a);
    expect(await liveSessions(userId)).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityType: 'SECURITY_EVENT', entityId: userId } })).toBe(0);
  });
});
