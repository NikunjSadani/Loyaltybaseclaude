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

import { ForbiddenException, Logger, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

type Row = Record<string, any>;

const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
    if (v === null) return row[k] === null || row[k] === undefined;
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

  private locks = new Map<string, { owner: symbol; released: Promise<void>; release: () => void }>();
  private txSeq = 0;

  private async lockRow(id: string, owner: symbol) {
    for (;;) {
      const l = this.locks.get(id);
      if (!l || l.owner === owner) break;
      await l.released;
    }
    if (!this.locks.has(id)) {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      this.locks.set(id, { owner, released, release });
    }
  }
  private unlockAll(owner: symbol) {
    for (const [id, l] of [...this.locks]) {
      if (l.owner === owner) {
        this.locks.delete(id);
        l.release();
      }
    }
  }

  /** UPDATE … WHERE: lock each candidate (blocking), re-check WHERE on the committed row, write. */
  private async updateMany(where: Row, data: Row, owner: symbol, pending: Array<() => void> | null) {
    await tick();
    const candidates = [...this.sessions.values()].filter((r) => matches(r, where)).map((r) => r.id);
    let count = 0;
    for (const id of candidates) {
      await this.lockRow(id, owner);
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
      updateMany: ({ where, data }: { where: Row; data: Row }) => this.updateMany(where, data, owner, pending),
      create: async ({ data }: { data: Row }) => {
        await tick();
        const row: Row = { revokedAt: null, rotatedFromId: null, createdAt: new Date(), ...data };
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

  client(): any {
    const autoOwner = () => Symbol('autocommit');
    return {
      userSession: {
        findFirst: (a: any) => this.sessionApi(autoOwner(), null).findFirst(a),
        updateMany: (a: any) => this.sessionApi(autoOwner(), null).updateMany(a),
        create: (a: any) => this.sessionApi(autoOwner(), null).create(a),
      },
      user: {
        findUnique: async ({ where }: any) => {
          await tick();
          const u = this.users.get(where.id);
          return u ? { sessionsInvalidBefore: u.sessionsInvalidBefore ?? null } : null;
        },
        update: async ({ where, data }: any) => {
          await tick();
          Object.assign(this.users.get(where.id)!, data);
          return this.users.get(where.id);
        },
      },
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
        };
        try {
          const result = await fn(tx);
          pending.forEach((apply) => apply()); // COMMIT
          return result;
        } finally {
          this.unlockAll(owner); // commit or rollback releases the row locks
        }
      },
    };
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
    seedSession(db, { id: 's1', userId: 'u1', clientId: 'deoleo', refreshToken: 'R1', rotatedFromId: 's0', revokedAt: new Date(Date.now() - 5 * 60_000) });
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
});
