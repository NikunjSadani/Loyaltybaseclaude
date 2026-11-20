// Concurrent-refresh race (prod 2026-11-19 10:38:23 UTC): one cold page load after the 60m
// access token expired fired ~10 parallel POST /v1/auth/refresh with the SAME refresh token;
// 7 got 200 and 3 got 401 within ~20ms, and the proxy bounced the 401'd requests to login.
//
// Root cause reproduced here: the single-use claim (revoke) and the successor INSERT were two
// separate autocommitted statements with awaited gate reads (partner/vendor/grant) in between.
// A loser whose claim lost DURING that window looked for the successor BEFORE the winner had
// inserted it → "no live successor" → 401.
//
// This spec drives the REAL AuthService.refreshToken against a small in-memory Postgres-like
// fake that models what matters: committed-only reads (no dirty reads), row locks taken by an
// UPDATE and held until the owning transaction commits, and an UPDATE that blocks on a locked
// row and then RE-CHECKS its WHERE against the committed version (READ COMMITTED semantics).
// All timestamps are relative to Date.now() — no hardcoded dates.

import { ForbiddenException, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthService, REFRESH_SERVER_BUDGET_MS, REFRESH_TX_OPTS, ROTATION_GRACE_MS } from './auth.service';

type Row = Record<string, any>;

const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
    if (v === null) return row[k] === null || row[k] === undefined;
    if (v && typeof v === 'object' && Array.isArray((v as Row).in)) return ((v as Row).in as unknown[]).includes(row[k]);
    return row[k] === v;
  });
}

/** Minimal Postgres-ish fake for the tables refreshToken touches. */
class FakeDb {
  sessions = new Map<string, Row>();
  users = new Map<string, Row>();
  audit: Row[] = [];
  createCount = 0;
  /** Gate-read latency (ms) — widens the winner's claim→insert window like a real DB round-trip. */
  gateLatencyMs = 15;
  partner: Row | null = null;
  activeOutlets = 1;
  /** Test hook: how long refresh holds the user-row SHARE lock before claiming (0 = no pause). */
  shareLockHoldMs = 0;
  shareLocksTaken = 0;

  // ── Row locks: S (FOR SHARE) is shared; X (UPDATE / FOR UPDATE) is exclusive. Held until the
  // owning transaction ends (autocommit statements release immediately). ──
  private locks = new Map<string, { mode: 'S' | 'X'; owners: Set<symbol> }>();
  private changed: Promise<void> = Promise.resolve();
  private signal: () => void = () => undefined;
  private txSeq = 0;

  constructor() {
    this.resetSignal();
  }
  private resetSignal() {
    this.changed = new Promise<void>((r) => (this.signal = r));
  }

  /** Per-transaction `SET LOCAL lock_timeout` (ms), keyed by the tx owner symbol. */
  private lockTimeouts = new Map<symbol, number>();

  private async lock(key: string, mode: 'S' | 'X', owner: symbol) {
    const timeoutMs = this.lockTimeouts.get(owner);
    const giveUpAt = timeoutMs ? Date.now() + timeoutMs : Infinity;
    for (;;) {
      const l = this.locks.get(key);
      const onlyMine = !!l && l.owners.size === 1 && l.owners.has(owner);
      if (!l) {
        this.locks.set(key, { mode, owners: new Set([owner]) });
        return;
      }
      if (onlyMine) {
        if (mode === 'X') l.mode = 'X'; // upgrade
        return;
      }
      if (mode === 'S' && l.mode === 'S') {
        l.owners.add(owner);
        return;
      }
      if (l.owners.has(owner) && mode === 'S') return; // already hold a stronger/equal lock
      // Wait for any release, then re-check — bounded by lock_timeout like Postgres (55P03).
      const remaining = giveUpAt - Date.now();
      if (remaining <= 0) {
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
      }
      if (remaining === Infinity) await this.changed;
      else await Promise.race([this.changed, sleep(remaining)]);
    }
  }
  private unlockAll(owner: symbol) {
    let any = false;
    for (const [key, l] of [...this.locks]) {
      if (l.owners.delete(owner)) {
        any = true;
        if (l.owners.size === 0) this.locks.delete(key);
      }
    }
    if (any) {
      const fire = this.signal;
      this.resetSignal();
      fire();
    }
  }

  /** UPDATE user_sessions … WHERE: lock each candidate (X, blocking), re-check WHERE on the committed row. */
  private async updateSessions(where: Row, data: Row, owner: symbol, pending: Array<() => void> | null) {
    await tick();
    const candidates = [...this.sessions.values()].filter((r) => matches(r, where)).map((r) => r.id);
    let count = 0;
    for (const id of candidates) {
      await this.lock(`session:${id}`, 'X', owner);
      const row = this.sessions.get(id)!;
      if (!matches(row, where)) continue; // EvalPlanQual re-check after the lock wait
      count++;
      const apply = () => Object.assign(row, data);
      if (pending) pending.push(apply);
      else apply();
    }
    if (!pending) this.unlockAll(owner); // autocommit
    return { count };
  }

  /** UPDATE users … : X lock on each matching user row. */
  private async updateUsers(ids: string[], data: Row, owner: symbol, pending: Array<() => void> | null) {
    await tick();
    for (const id of ids) {
      await this.lock(`user:${id}`, 'X', owner);
      const apply = () => Object.assign(this.users.get(id)!, data);
      if (pending) pending.push(apply);
      else apply();
    }
    if (!pending) this.unlockAll(owner);
    return { count: ids.length };
  }

  private sessionApi(owner: symbol, pending: Array<() => void> | null) {
    return {
      findFirst: async ({ where, include }: { where: Row; include?: Row }) => {
        await tick();
        const row = [...this.sessions.values()].find((r) => matches(r, where));
        if (!row) return null;
        const copy = { ...row };
        if (include?.user) copy.user = { ...this.users.get(row.userId) };
        return copy;
      },
      findUnique: async ({ where }: { where: Row }) => {
        await tick();
        const row = this.sessions.get(where.id);
        return row ? { ...row } : null;
      },
      findMany: async ({ where }: { where: Row }) => {
        await tick();
        return [...this.sessions.values()].filter((r) => matches(r, where)).map((r) => ({ ...r }));
      },
      updateMany: ({ where, data }: { where: Row; data: Row }) => this.updateSessions(where, data, owner, pending),
      update: async ({ where, data }: { where: Row; data: Row }) => {
        await this.updateSessions({ id: where.id }, data, owner, pending);
        return { ...this.sessions.get(where.id), ...data };
      },
      create: async ({ data }: { data: Row }) => {
        await tick();
        const row: Row = { revokedAt: null, rotatedFromId: null, firstUsedAt: null, createdAt: new Date(), ...data };
        const apply = () => {
          this.sessions.set(row.id, row);
          this.createCount++;
        };
        if (pending) pending.push(apply);
        else apply();
        return row;
      },
    };
  }

  private userApi(owner: () => symbol, pending: Array<() => void> | null) {
    return {
      findUnique: async ({ where }: any) => {
        await tick();
        const u = this.users.get(where.id);
        return u ? { sessionsInvalidBefore: u.sessionsInvalidBefore ?? null } : null;
      },
      update: ({ where, data }: any) => this.updateUsers([where.id], data, owner(), pending),
      updateMany: ({ where, data }: any) => this.updateUsers(where.id.in as string[], data, owner(), pending),
    };
  }

  client(): any {
    const autoOwner = () => Symbol('autocommit');
    return {
      userSession: {
        findFirst: (a: any) => this.sessionApi(autoOwner(), null).findFirst(a),
        findUnique: (a: any) => this.sessionApi(autoOwner(), null).findUnique(a),
        findMany: (a: any) => this.sessionApi(autoOwner(), null).findMany(a),
        updateMany: (a: any) => this.sessionApi(autoOwner(), null).updateMany(a),
        create: (a: any) => this.sessionApi(autoOwner(), null).create(a),
      },
      user: this.userApi(autoOwner, null),
      channelPartner: {
        findFirst: async () => {
          await sleep(this.gateLatencyMs);
          return this.partner;
        },
      },
      outlet: {
        count: async () => {
          await sleep(this.gateLatencyMs);
          return this.activeOutlets;
        },
      },
      vendor: { findFirst: async () => null },
      vendorTenantGrant: { findFirst: async () => null },
      auditLog: {
        create: async ({ data }: any) => {
          this.audit.push(data);
          return data;
        },
      },
      $transaction: async (fn: (tx: any) => Promise<any>) => {
        const owner = Symbol(`tx${++this.txSeq}`);
        const pending: Array<() => void> = [];
        const tx = {
          userSession: this.sessionApi(owner, pending),
          user: this.userApi(() => owner, pending),
          // `SET LOCAL lock_timeout = '<n>s'` → bound every later lock wait of THIS tx (F1).
          $executeRawUnsafe: async (sql: string) => {
            const m = /SET LOCAL lock_timeout = '(\d+)(ms|s)'/.exec(sql);
            if (!m) throw new Error(`unexpected raw statement: ${sql}`);
            this.lockTimeouts.set(owner, Number(m[1]) * (m[2] === 's' ? 1000 : 1));
            return 0;
          },
          // The only raw query refreshToken issues in its tx:
          //   SELECT "sessionsInvalidBefore" FROM "users" WHERE "id" = $1 FOR SHARE
          $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            if (!/FOR SHARE/.test(strings.join('?'))) throw new Error('unexpected raw query');
            const id = values[0] as string;
            await tick();
            await this.lock(`user:${id}`, 'S', owner);
            this.shareLocksTaken++;
            if (this.shareLockHoldMs) await sleep(this.shareLockHoldMs); // test hook: widen the window
            const u = this.users.get(id);
            return u ? [{ sessionsInvalidBefore: u.sessionsInvalidBefore ?? null }] : [];
          },
        };
        try {
          const result = await fn(tx);
          pending.forEach((apply) => apply()); // COMMIT
          return result;
        } finally {
          this.lockTimeouts.delete(owner);
          this.unlockAll(owner); // commit or rollback releases the row locks
        }
      },
    };
  }

  /** Is any session of this user still live (unrevoked, unexpired)? */
  liveSessions(userId: string) {
    return [...this.sessions.values()].filter(
      (r) => r.userId === userId && r.revokedAt === null && r.expiresAt > new Date(),
    );
  }
}

function buildService(db: FakeDb, opts: { grant?: boolean } = {}) {
  const jwt = {
    sign: jest.fn((p: Row) => `jwt.${p.sid}.${p.clientId}${p.assumed ? '.assumed' : ''}`),
    verify: jest.fn(),
  };
  const config = { get: jest.fn((k: string) => (k === 'JWT_EXPIRES_IN' ? '60m' : k === 'JWT_SECRET' ? 's' : undefined)) };
  const grants = { hasGrantUncached: jest.fn(async () => opts.grant ?? true) };
  const svc = new AuthService(
    db.client(),
    jwt as any,
    config as any,
    {} as any,
    {} as any,
    {} as any,
    grants as any,
    {} as any,
  );
  return { svc, jwt };
}

function seedUser(db: FakeDb, user: Row) {
  db.users.set(user.id, { sessionsInvalidBefore: null, gifsyRoleId: null, vendorId: null, ...user });
}

function seedSession(db: FakeDb, s: Row) {
  db.sessions.set(s.id, {
    token: `old.access.${s.id}`,
    rotatedFromId: null,
    firstUsedAt: null,
    revokedAt: null,
    createdAt: new Date(Date.now() - 60 * 60_000),
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    ...s,
  });
}

describe('AuthService.refreshToken — concurrent refresh race (real service, row-lock fake DB)', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  it('10 parallel refreshes of the SAME token (partner user, slow gate reads) → all 200, identical successor, one mint', async () => {
    const db = new FakeDb();
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    db.partner = { id: 'cp1', isActive: true };
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0' });
    const { svc } = buildService(db);

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => svc.refreshToken('R0')));

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toEqual([]); // the prod bug: 3/10 were UnauthorizedException
    const pairs = results.map((r) => (r as PromiseFulfilledResult<any>).value);
    const first = pairs[0];
    for (const p of pairs) expect(p).toEqual(first); // all converge on ONE successor pair
    expect(db.createCount).toBe(1); // exactly one successor minted
    const successor = [...db.sessions.values()].find((r) => r.rotatedFromId === 's0');
    expect(successor).toMatchObject({ refreshToken: first.refreshToken, token: first.accessToken, revokedAt: null });
    expect(db.sessions.get('s0')!.revokedAt).toBeInstanceOf(Date);
    // No false-positive theft response.
    expect(db.users.get('u1')!.sessionsInvalidBefore).toBeNull();
    expect(db.audit.filter((a) => a.entityType === 'SECURITY_EVENT')).toHaveLength(0);
  });

  it('assumed-tenant refresh under concurrency still works (tenant scope + assumed flag kept)', async () => {
    const db = new FakeDb();
    seedUser(db, { id: 'op1', role: 'GIFSY_STAFF', clientId: 'gifsy', phone: '98', name: 'Op' });
    seedSession(db, { id: 'sa', userId: 'op1', clientId: 'bajaj', refreshToken: 'RA' });
    const { svc } = buildService(db, { grant: true });

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => svc.refreshToken('RA')));

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    const pairs = results.map((r) => (r as PromiseFulfilledResult<any>).value);
    for (const p of pairs) expect(p).toEqual(pairs[0]);
    expect(pairs[0].accessToken).toMatch(/\.bajaj\.assumed$/);
    expect(db.createCount).toBe(1);
    expect([...db.sessions.values()].find((r) => r.rotatedFromId === 'sa')!.clientId).toBe('bajaj');
  });

  it('a revoked (logged-out) session → 401 for every concurrent caller, nothing minted', async () => {
    const db = new FakeDb();
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0', revokedAt: new Date(Date.now() - 1_000) });
    const { svc } = buildService(db);

    const results = await Promise.allSettled(Array.from({ length: 4 }, () => svc.refreshToken('R0')));

    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(UnauthorizedException);
    }
    expect(db.createCount).toBe(0);
  });

  it('a session swept by logout-all (stamp after createdAt) → 401, nothing minted', async () => {
    const db = new FakeDb();
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P', sessionsInvalidBefore: new Date(Date.now() - 1_000) });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0' });
    const { svc } = buildService(db);

    await expect(svc.refreshToken('R0')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.createCount).toBe(0);
  });

  it('an expired (never revoked) session → 401 for concurrent callers, no theft response', async () => {
    const db = new FakeDb();
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0', expiresAt: new Date(Date.now() - 1_000) });
    const { svc } = buildService(db);

    const results = await Promise.allSettled(Array.from({ length: 3 }, () => svc.refreshToken('R0')));
    for (const r of results) expect(r.status).toBe('rejected');
    expect(db.createCount).toBe(0);
    expect(db.users.get('u1')!.sessionsInvalidBefore).toBeNull();
  });

  it('theft protection unchanged: an OLD rotated token past grace whose successor was itself rotated → 401 + lineage kill + SECURITY_EVENT', async () => {
    const db = new FakeDb();
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0', revokedAt: new Date(Date.now() - 10 * 60_000) });
    // s1 was rotated BY ITS HOLDER (a normal refresh) — which marks it used (firstUsedAt) → strict.
    seedSession(db, { id: 's1', userId: 'u1', clientId: 'deoleo', refreshToken: 'R1', rotatedFromId: 's0', revokedAt: new Date(Date.now() - 5 * 60_000), firstUsedAt: new Date(Date.now() - 5 * 60_000) });
    seedSession(db, { id: 's2', userId: 'u1', clientId: 'deoleo', refreshToken: 'R2', rotatedFromId: 's1' });
    const { svc } = buildService(db);

    await expect(svc.refreshToken('R0')).rejects.toBeInstanceOf(UnauthorizedException);

    expect(db.createCount).toBe(0);
    expect(db.sessions.get('s2')!.revokedAt).toBeInstanceOf(Date); // live tip killed
    expect(db.users.get('u1')!.sessionsInvalidBefore).toBeInstanceOf(Date);
    expect(db.audit.filter((a) => a.entityType === 'SECURITY_EVENT' && a.metadata?.event === 'refresh_token_reuse')).toHaveLength(1);
  });

  it('a deactivated partner refreshing concurrently: every caller refused (403), predecessor consumed, nothing minted', async () => {
    const db = new FakeDb();
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    db.partner = { id: 'cp1', isActive: false };
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0' });
    const { svc } = buildService(db);

    const results = await Promise.allSettled(Array.from({ length: 4 }, () => svc.refreshToken('R0')));

    const reasons = results.map((r) => (r as PromiseRejectedResult).reason);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    // The gate runs before the claim, so EVERY caller sees the gate's 403 (the user-facing
    // "outlet deactivated" message) — never a 200.
    expect(reasons.every((e) => e instanceof ForbiddenException)).toBe(true);
    expect(db.createCount).toBe(0);
    expect(db.sessions.get('s0')!.revokedAt).toBeInstanceOf(Date); // the session is still consumed
  });

  // ── S1: no successor handoff outside the grace window ─────────────────────────────────────
  it('S1: a stolen rotated token replayed DAYS later while its successor is LIVE → reuse kill, attacker gets nothing', async () => {
    const db = new FakeDb();
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    const DAY = 24 * 60 * 60_000;
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0', createdAt: new Date(Date.now() - 4 * DAY), revokedAt: new Date(Date.now() - 3 * DAY) });
    seedSession(db, {
      id: 's1', userId: 'u1', clientId: 'deoleo', refreshToken: 'R1', rotatedFromId: 's0', createdAt: new Date(Date.now() - 3 * DAY),
      createdFingerprint: 'v3:fp-victim', firstUsedAt: new Date(Date.now() - 3 * DAY), // the victim has been USING s1
    });
    const { svc } = buildService(db);

    await expect(svc.refreshToken('R0', { fingerprint: 'v3:fp-victim' })).rejects.toBeInstanceOf(UnauthorizedException);

    expect(db.liveSessions('u1')).toHaveLength(0); // the live successor s1 is killed, not handed out
    expect(db.users.get('u1')!.sessionsInvalidBefore).toBeInstanceOf(Date);
    expect(db.audit.filter((a) => a.metadata?.event === 'refresh_token_reuse')).toHaveLength(1);
  });

  it.each([
    ['70 minutes', 70 * 60_000],
    ['2 days', 2 * 24 * 60 * 60_000],
  ])('C1: refresh response LOST (app switch), same device returns %s later with the OLD token → renewed forward, stays logged in', async (_l, ago) => {
    const db = new FakeDb();
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0', createdAt: new Date(Date.now() - ago - 60 * 60_000), revokedAt: new Date(Date.now() - ago) });
    seedSession(db, { id: 's1', userId: 'u1', clientId: 'deoleo', refreshToken: 'R1', rotatedFromId: 's0', createdAt: new Date(Date.now() - ago), createdFingerprint: 'v3:fp-phone' });
    const { svc } = buildService(db);

    const res = await svc.refreshToken('R0', { fingerprint: 'v3:fp-phone' });

    expect(res.refreshToken).not.toBe('R1'); // a FRESH pair (renewed forward), not the stale stored one
    expect(db.createCount).toBe(1);
    const live = db.liveSessions('u1');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ rotatedFromId: 's1', refreshToken: res.refreshToken, createdFingerprint: 'v3:fp-phone' });
    expect(db.sessions.get('s1')!.handedBackAt).toBeInstanceOf(Date);
    expect(db.audit.filter((a) => a.entityType === 'SECURITY_EVENT')).toHaveLength(0);
  });

  // ── S2: a logout-all style stamp + sweep inside ONE transaction vs a concurrent refresh ─────
  const stampAndSweepInOneTx = (db: FakeDb, userId: string, holdMs: number) =>
    db.client().$transaction(async (tx: any) => {
      // Same shape as admin-outlets deactivation / KYC phone change: stamp, (work), sweep.
      await tx.user.updateMany({ where: { id: { in: [userId] } }, data: { sessionsInvalidBefore: new Date() } });
      await sleep(holdMs);
      await tx.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });

  it('S2: stamper FIRST (uncommitted stamp held), refresh arrives meanwhile → refresh waits, then refuses; nothing survives', async () => {
    const db = new FakeDb();
    db.gateLatencyMs = 0;
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0' });
    const { svc } = buildService(db);

    const sweep = stampAndSweepInOneTx(db, 'u1', 40);
    await sleep(5); // the stamp is written (uncommitted) and its user-row lock held
    const refresh = svc.refreshToken('R0').then(() => 'ok', (e) => e);

    await sweep;
    const result = await refresh;
    expect(result).toBeInstanceOf(UnauthorizedException);
    expect(db.createCount).toBe(0);
    expect(db.liveSessions('u1')).toHaveLength(0);
  });

  it('S2: refresh FIRST (holds the user-row share lock), stamper arrives meanwhile → its sweep still kills the new successor', async () => {
    const db = new FakeDb();
    db.gateLatencyMs = 0;
    db.shareLockHoldMs = 30;
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0' });
    const { svc } = buildService(db);

    const refresh = svc.refreshToken('R0').then(() => 'ok', (e) => e);
    while (db.shareLocksTaken === 0) await tick(); // refresh now holds FOR SHARE on the user row
    const sweep = stampAndSweepInOneTx(db, 'u1', 0);

    await Promise.all([refresh, sweep]);
    // Whatever the refresh returned, NOTHING minted for the pre-stamp lineage is still live.
    expect(db.liveSessions('u1')).toHaveLength(0);
  });

  // ── F1: the server never commits a rotation after the client gave up; fail fast on locks ─────
  it('F1: a refresh blocked on a user-row lock rolls back within ~lock_timeout (503), predecessor stays LIVE, a later retry succeeds', async () => {
    const db = new FakeDb();
    db.gateLatencyMs = 0;
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0' });
    const { svc } = buildService(db);

    // A long user-row writer (e.g. a slow admin edit) holds the row for 1.6s.
    const writer = db.client().$transaction(async (tx: any) => {
      await tx.user.updateMany({ where: { id: { in: ['u1'] } }, data: { name: 'P2' } });
      await sleep(1_600);
    });
    await sleep(5);
    const started = Date.now();
    const first = await svc.refreshToken('R0').then(() => 'ok', (e) => e);
    const took = Date.now() - started;

    expect(first).toBeInstanceOf(ServiceUnavailableException); // transient → the client retries
    expect(took).toBeLessThan(1_500); // failed fast at lock_timeout (1s), not after the writer
    expect(db.createCount).toBe(0);
    expect(db.sessions.get('s0')!.revokedAt).toBeNull(); // claim rolled back — still usable

    await writer;
    const retry = await svc.refreshToken('R0');
    expect(retry.refreshToken).toBeTruthy();
    expect(db.createCount).toBe(1);
  });

  it('S2: a caller deadline already in the past is FLOORED (500ms from receipt) → the refresh rotates normally, no free 503 probe', async () => {
    const db = new FakeDb();
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0' });
    const { svc } = buildService(db);

    await expect(svc.refreshToken('R0', { clientDeadlineMs: Date.now() - 60_000, budgetMs: 1 })).resolves.toMatchObject({ refreshToken: expect.any(String) });
    expect(db.createCount).toBe(1);
  });

  it('F1: receipt + budget already spent before the tx (stalled gates) → 503, nothing committed, predecessor LIVE', async () => {
    const db = new FakeDb();
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0' });
    const { svc } = buildService(db);

    await expect(svc.refreshToken('R0', { receivedAt: Date.now() - 5_000 })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.createCount).toBe(0);
    expect(db.sessions.get('s0')!.revokedAt).toBeNull();
  });

  it('F1: the deadline passing INSIDE the tx (slow lock path) rolls the whole rotation back — never commits late', async () => {
    const db = new FakeDb();
    db.gateLatencyMs = 0;
    db.shareLockHoldMs = 650; // the tx is slow…
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0' });
    const { svc } = buildService(db);

    // …and the caller's budget is the 500ms floor.
    await expect(svc.refreshToken('R0', { budgetMs: 500 })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.createCount).toBe(0); // the INSERT was rolled back with the claim
    expect(db.sessions.get('s0')!.revokedAt).toBeNull();
  });

  it('F4: the grace window starts at COMMIT — the predecessor revokedAt is re-stamped after the successor INSERT', async () => {
    const db = new FakeDb();
    db.gateLatencyMs = 0;
    db.shareLockHoldMs = 150; // slow tx: claim happens ≥150ms before commit
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0' });
    const { svc } = buildService(db);

    await svc.refreshToken('R0');
    const successor = [...db.sessions.values()].find((r) => r.rotatedFromId === 's0')!;
    expect(db.sessions.get('s0')!.revokedAt.getTime()).toBeGreaterThanOrEqual(successor.createdAt.getTime());
  });

  it('timing budget invariants (mirrors platform/src/lib/auth-refresh.ts: client timeout 5s, retry 200ms, client deadline 4s)', () => {
    const CLIENT_TIMEOUT_MS = 5_000;
    const RETRY_DELAY_MS = 200;
    const CLIENT_DEADLINE_MS = 4_000;
    // The server's own budget never outlives the client's give-up (1s left for commit + transit).
    expect(REFRESH_SERVER_BUDGET_MS + 1_000).toBeLessThanOrEqual(CLIENT_TIMEOUT_MS);
    expect(CLIENT_DEADLINE_MS + 1_000).toBeLessThanOrEqual(CLIENT_TIMEOUT_MS);
    expect(REFRESH_TX_OPTS.timeout).toBeLessThanOrEqual(REFRESH_SERVER_BUDGET_MS);
    // A retry of a committed-but-unanswered rotation (commit ≥ attempt start) lands inside grace.
    expect(CLIENT_TIMEOUT_MS + RETRY_DELAY_MS + 500 /* transit */).toBeLessThanOrEqual(ROTATION_GRACE_MS);
  });

  // ── H4 / C1 / S-H1 (owner decisions 2026-11-20): never-used successor, made safe ─────────────
  const lostResponseSetup = (successorUsed: boolean) => {
    const db = new FakeDb();
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    // R0 rotated to R1 30s ago on the phone (fp-phone); the phone never received R1 — or did and used it.
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0', revokedAt: new Date(Date.now() - 30_000) });
    seedSession(db, {
      id: 's1', userId: 'u1', clientId: 'deoleo', refreshToken: 'R1', token: 'A1', rotatedFromId: 's0',
      createdAt: new Date(Date.now() - 30_000), createdFingerprint: 'v3:fp-phone',
      firstUsedAt: successorUsed ? new Date(Date.now() - 20_000) : null,
    });
    return db;
  };

  it('H4: successor USED → strict: the old-token replay kills everything + SECURITY_EVENT', async () => {
    const db = lostResponseSetup(true);
    const { svc } = buildService(db);

    await expect(svc.refreshToken('R0', { fingerprint: 'v3:fp-phone' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.liveSessions('u1')).toHaveLength(0);
    expect(db.audit.filter((a) => a.metadata?.event === 'refresh_token_reuse')).toHaveLength(1);
  });

  it('H-A (c): a thief replaying the stolen old token from ANOTHER device class → 401, gets nothing; ONLY that lineage ends; other devices stay signed in', async () => {
    const db = lostResponseSetup(false);
    seedSession(db, { id: 'laptop', userId: 'u1', clientId: 'deoleo', refreshToken: 'RL', firstUsedAt: new Date() }); // the user's laptop
    const { svc } = buildService(db);

    await expect(svc.refreshToken('R0', { fingerprint: 'v3:fp-thief' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.createCount).toBe(0);
    expect(db.users.get('u1')!.sessionsInvalidBefore).toBeNull(); // no all-device kill
    expect(db.liveSessions('u1').map((r) => r.id)).toEqual(['laptop']); // the laptop is untouched
    expect(db.sessions.get('s1')!.revokedAt).toBeInstanceOf(Date); // this lineage ended
    expect(db.audit.filter((x) => x.metadata?.event === 'refresh_handback_refused' && x.metadata?.reason === 'device_mismatch')).toHaveLength(1);
  });

  it('S-H1: thief ROTATES FIRST from the stolen live token, the user later replays it → not shared (device mismatch) → strict kill', async () => {
    const db = new FakeDb();
    seedUser(db, { id: 'u1', role: 'WHOLESALER', clientId: 'deoleo', phone: '99', name: 'P' });
    seedSession(db, { id: 's0', userId: 'u1', clientId: 'deoleo', refreshToken: 'R0' }); // live; stolen
    const { svc } = buildService(db);

    const thief = await svc.refreshToken('R0', { fingerprint: 'v3:fp-thief' }); // thief rotates first: R0 → T1 (unused)
    expect(thief.refreshToken).toBeTruthy();
    db.sessions.get('s0')!.revokedAt = new Date(Date.now() - 60_000); // … the user comes back later

    await expect(svc.refreshToken('R0', { fingerprint: 'v3:fp-phone' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.liveSessions('u1')).toHaveLength(0); // the thief's session (same lineage) is revoked too
    expect(db.users.get('u1')!.sessionsInvalidBefore).toBeNull(); // …without an all-device kill
    expect(db.audit.filter((a) => a.metadata?.reason === 'device_mismatch')).toHaveLength(1);
  });

  it('H-A (a): the handback REPLY was lost too — same device replays the old token again later → renewed AGAIN (stays signed in)', async () => {
    const db = lostResponseSetup(false);
    const { svc } = buildService(db);

    const first = await svc.refreshToken('R0', { fingerprint: 'v3:fp-phone' }); // renewed: s1 → s2 (reply lost)
    for (const r of db.sessions.values()) if (r.handedBackAt) r.handedBackAt = new Date(Date.now() - 60_000);

    const second = await svc.refreshToken('R0', { fingerprint: 'v3:fp-phone' }); // s2 still unused → s2 → s3
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(db.createCount).toBe(2);
    expect(db.liveSessions('u1')).toHaveLength(1);
    expect(db.audit.filter((x) => x.entityType === 'SECURITY_EVENT')).toHaveLength(0);
  });

  it('S-H1b concurrency: two simultaneous post-grace replays of the same old token (one resume) → ONE renewal, both get the SAME pair', async () => {
    const db = lostResponseSetup(false);
    const { svc } = buildService(db);

    const [a, b] = await Promise.all([
      svc.refreshToken('R0', { fingerprint: 'v3:fp-phone' }),
      svc.refreshToken('R0', { fingerprint: 'v3:fp-phone' }),
    ]);

    expect(b).toEqual(a);
    expect(db.createCount).toBe(1); // exactly one renewal minted
    expect(db.liveSessions('u1')).toHaveLength(1);
    expect(db.audit.filter((x) => x.entityType === 'SECURITY_EVENT')).toHaveLength(0);
    expect(db.audit.filter((x) => x.metadata?.event === 'REFRESH_HANDOFF_UNUSED_SUCCESSOR')).toHaveLength(1);
  });

  it('H4: once the renewed session is USED, a stale replay of the old token → strict kill', async () => {
    const db = lostResponseSetup(false);
    const { svc } = buildService(db);

    const renewed = await svc.refreshToken('R0', { fingerprint: 'v3:fp-phone' });
    const s2 = [...db.sessions.values()].find((r) => r.refreshToken === renewed.refreshToken)!;
    s2.firstUsedAt = new Date(); // JWT guard first-use mark
    for (const r of db.sessions.values()) if (r.handedBackAt) r.handedBackAt = new Date(Date.now() - 60_000);

    await expect(svc.refreshToken('R0', { fingerprint: 'v3:fp-phone' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.liveSessions('u1')).toHaveLength(0);
  });
});
