// Wallet Reversal Engine — WP2 (applyMovement v2) + WP3 (applyCreditReversal, LEGACY/SHADOW/V2 dispatch).
// Source of truth: platform/docs/plans/WALLET-REVERSAL-ENGINE-DESIGN.md §5–§7, §12 (Q1–Q14), §15 (test matrix).
//
// Every scenario drives the REAL WalletService against an in-memory emulation of the tables it touches and then
// compares the persisted state — B, D, movementSeq, every position's O_X / ρ_X, Σ shortfall / recovered from the
// allocation rows, and every credit lot's remainingPoints — with the WP0 oracle (reversal-model.ts) run on the
// same events. The service must match WP0 EXACTLY (it calls WP0; these tests prove the wiring).
// No dates are hardcoded relative to the calendar: NOW is fixed and everything is offset from it (WAYS #10).

import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  planV2Reversal,
  WalletService,
  DEBT_REVERSAL_PAUSED_MESSAGE,
  WALLET_NOT_BACKFILLED_MESSAGE,
} from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReversalEngineMode, TenantSettingsService } from '../tenant/tenant-settings.service';
import {
  checkInvariants,
  legacyReversalDecrement,
  ModelEvent,
  Movement,
  run,
  WalletModel,
} from './reversal-model';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

type Row = Record<string, any>;
const num = (x: any) => (x instanceof Date ? x.getTime() : x);

function matchWhere(row: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === null) {
      if (row[k] !== null && row[k] !== undefined) return false;
      continue;
    }
    if (typeof v === 'object' && !(v instanceof Date)) {
      const ranged = 'gt' in v || 'gte' in v || 'lt' in v || 'lte' in v;
      if (ranged && (row[k] === null || row[k] === undefined)) return false; // SQL: NULL compares false
      if ('in' in v) { if (!(v as any).in.includes(row[k])) return false; }
      else if ('gt' in v) { if (!(num(row[k]) > num((v as any).gt))) return false; }
      else if ('gte' in v) { if (!(num(row[k]) >= num((v as any).gte))) return false; }
      else if ('lt' in v) { if (!(num(row[k]) < num((v as any).lt))) return false; }
      else if ('lte' in v) { if (!(num(row[k]) <= num((v as any).lte))) return false; }
      else if ('not' in v) { if (row[k] === (v as any).not) return false; }
      // else: relation filter — ignored (tenant scope is covered by wallet.service.spec.ts)
    } else if (v instanceof Date) {
      if (!(row[k] instanceof Date) || row[k].getTime() !== v.getTime()) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('increment' in v) row[k] = (row[k] ?? 0) + (v as any).increment;
      else if ('decrement' in v) row[k] = (row[k] ?? 0) - (v as any).decrement;
      else if ('set' in v) row[k] = (v as any).set;
      else row[k] = v;
    } else row[k] = v;
  }
}

function orderRows(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [key, dir] = Object.entries(spec)[0] as [string, string];
      const d = num(a[key]) < num(b[key]) ? -1 : num(a[key]) > num(b[key]) ? 1 : 0;
      if (d !== 0) return dir === 'asc' ? d : -d;
    }
    return 0;
  });
}

const blankWallet = (id: string, partnerId: string, extra: Row = {}): Row => ({
  id,
  partnerId,
  earnedPoints: 0,
  lockedPoints: 0,
  redeemablePoints: 0,
  redeemedPoints: 0,
  expiredPoints: 0,
  lifetimeEarned: 0,
  lifetimeRedeemed: 0,
  lifetimeExpired: 0,
  debtPoints: 0,
  movementSeq: 0,
  ...extra,
});

function harness(opts: { wallets?: Row[]; outlets?: Row[]; mode?: ReversalEngineMode } = {}) {
  let clock = 0;
  const wallets: Row[] = opts.wallets ?? [blankWallet('w1', 'cp1')];
  const walletTxns: Row[] = [];
  const ledger: Row[] = [];
  const positions: Row[] = [];
  const allocations: Row[] = [];
  const auditLogs: Row[] = [];
  const outlets: Row[] = opts.outlets ?? [];
  const settings = { mode: opts.mode ?? ('LEGACY' as ReversalEngineMode), modeReads: 0 };
  const positionView = (p: Row) => {
    const c = walletTxns.find((t) => t.id === p.creditTxId);
    return { ...p, creditTx: { seq: c?.seq ?? null, createdAt: c?.createdAt ?? NOW } };
  };
  const models: Row = {
    wallet: {
      findFirst: async ({ where }: any) => {
        const w = wallets.find((x) => matchWhere(x, where));
        return w ? { ...w } : null; // a SNAPSHOT, like Prisma
      },
      updateMany: async ({ where, data }: any) => {
        const ws = wallets.filter((x) => matchWhere(x, where));
        ws.forEach((w) => applyData(w, data));
        return { count: ws.length };
      },
      update: async ({ where, data }: any) => {
        const w = wallets.find((x) => matchWhere(x, where));
        if (!w) throw new Error('wallet not found');
        applyData(w, data);
        return { ...w };
      },
      findUniqueOrThrow: async ({ where }: any) => {
        const w = wallets.find((x) => matchWhere(x, where));
        if (!w) throw new Error('wallet not found');
        return { ...w };
      },
    },
    walletTransaction: {
      create: async ({ data }: any) => {
        const row = { id: `wt${++clock}`, ...data, createdAt: later(clock) };
        walletTxns.push(row);
        return row;
      },
      findFirst: async ({ where, orderBy }: any = {}) =>
        orderRows(walletTxns.filter((r) => matchWhere(r, where ?? {})), orderBy)[0] ?? null,
      findMany: async ({ where, orderBy }: any = {}) =>
        orderRows(walletTxns.filter((r) => matchWhere(r, where ?? {})), orderBy),
    },
    pointsLedger: {
      create: async ({ data }: any) => {
        const row = { id: `pl${++clock}`, isExpired: false, remainingPoints: 0, createdAt: later(clock), ...data };
        ledger.push(row);
        return row;
      },
      findMany: async ({ where, orderBy, take }: any = {}) => {
        let rows = orderRows(ledger.filter((r) => matchWhere(r, where ?? {})), orderBy);
        if (take != null) rows = rows.slice(0, take);
        return rows.map((r) => ({ ...r }));
      },
      findFirst: async ({ where }: any = {}) => {
        const r = ledger.find((x) => matchWhere(x, where ?? {}));
        return r ? { ...r } : null;
      },
      findUnique: async ({ where }: any) => {
        const r = ledger.find((x) => matchWhere(x, where ?? {}));
        return r ? { ...r } : null;
      },
      update: async ({ where, data }: any) => {
        const r = ledger.find((x) => matchWhere(x, where));
        if (!r) throw new Error('ledger row not found');
        applyData(r, data);
        return { ...r };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = ledger.filter((r) => matchWhere(r, where));
        rows.forEach((r) => applyData(r, data));
        return { count: rows.length };
      },
    },
    walletCreditPosition: {
      create: async ({ data }: any) => {
        const row = { id: `pos${++clock}`, offsetPoints: 0, reversedPoints: 0, ...data };
        positions.push(row);
        return row;
      },
      findMany: async ({ where }: any = {}) => positions.filter((p) => matchWhere(p, where ?? {})).map(positionView),
      findFirst: async ({ where }: any = {}) => {
        const p = positions.find((x) => matchWhere(x, where ?? {}));
        return p ? { ...p } : null;
      },
      count: async ({ where }: any = {}) => positions.filter((p) => matchWhere(p, where ?? {})).length,
      updateMany: async ({ where, data }: any) => {
        const rows = positions.filter((p) => matchWhere(p, where));
        rows.forEach((r) => applyData(r, data));
        return { count: rows.length };
      },
    },
    creditReversalAllocation: {
      create: async ({ data }: any) => {
        if (allocations.some((a) => a.creditReversalId === data.creditReversalId && a.positionId === data.positionId)) {
          throw new Error('unique (creditReversalId, positionId) violated');
        }
        const row = { id: `al${++clock}`, ...data };
        allocations.push(row);
        return row;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        auditLogs.push(data);
        return data;
      },
    },
    outlet: {
      findFirst: async ({ where }: any) => outlets.find((o) => matchWhere(o, where ?? {})) ?? null,
      findMany: async ({ where }: any) => outlets.filter((o) => matchWhere(o, where ?? {})),
    },
    creditBatch: { findFirst: async () => null },
    pointExpiryConfig: { findFirst: async () => null },
    channelPartner: { findFirst: async ({ where }: any) => ({ id: where?.id, clientId: 'bajaj' }) },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (cb: any) => cb(models)),
  };
  const tenantSettings = {
    getConversionRate: async () => 1,
    getReversalEngineModeUncached: async () => {
      settings.modeReads++;
      return settings.mode;
    },
  };
  const service = new WalletService(models as unknown as PrismaService, tenantSettings as unknown as TenantSettingsService);
  return { service, models, wallets, walletTxns, ledger, positions, allocations, auditLogs, outlets, settings };
}
type H = ReturnType<typeof harness>;

// ───────────────────────── scenario driver (service ⟷ WP0) ─────────────────────────

/** Opening balance as the WP6 backfill leaves it: B = n, D = max(0, −n), movementSeq 1 (one historical movement). */
function openWallet(n: number): Row {
  return n < 0
    ? blankWallet('w1', 'cp1', { redeemablePoints: n, debtPoints: -n, movementSeq: 1 })
    : blankWallet('w1', 'cp1');
}
function openingEvents(n: number): ModelEvent[] {
  if (n < 0) return [{ type: 'legacyDebit', amount: -n }];
  if (n > 0) return [{ type: 'credit', id: 'OPEN', amount: n, reversible: false }];
  return [];
}

interface Driver {
  h: H;
  lotOf: Record<string, string>; // model credit id → DB ledger lot id
  movements: Movement[]; // service-side reversal results, in order
  revSeq: number;
}

async function apply(d: Driver, ev: ModelEvent): Promise<void> {
  const { h } = d;
  switch (ev.type) {
    case 'credit': {
      const res = await h.service.creditEarn(
        'cp1',
        'bajaj',
        ev.amount,
        ev.reversible === false
          ? { description: `open ${ev.id}` }
          : {
              referenceType: 'CREDIT_BATCH',
              referenceId: `B-${ev.id}`,
              sourceType: 'CREDIT_FIELD',
              sourceId: 'F',
              metadata: { fieldId: 'F', outletCode: `O-${ev.id}` },
            },
      );
      d.lotOf[ev.id] = res.ledgerId;
      return;
    }
    case 'spend':
      await h.service.debitRedeem('cp1', ev.amount, { referenceId: `order-${ev.amount}` });
      return;
    case 'expire': {
      const lot = h.ledger.find((l) => l.id === d.lotOf[ev.lotId])!;
      lot.expiresAt = later(-1000);
      await h.service.expireDuePoints({ now: NOW });
      lot.expiresAt = null;
      return;
    }
    case 'reverse': {
      const res = await h.models.$transaction((tx: any) =>
        h.service.applyCreditReversal(tx, {
          batchId: `B-${ev.creditId}`,
          outletCode: `O-${ev.creditId}`,
          fieldId: 'F',
          creditReversalId: `R${++d.revSeq}`,
          points: ev.amount,
        }),
      );
      d.movements.push({
        kind: 'REVERSAL',
        seq: 0,
        refId: ev.creditId,
        pointsRequested: ev.amount,
        pointsDelta: -(res.debtRestored + res.recovered),
        debtDelta: res.debtRestored,
        offsetDelta: -res.debtRestored,
        offsetPositionId: ev.creditId,
        lotDraws: [],
        shortfall: res.shortfall,
        debtRestored: res.debtRestored,
        recovered: res.recovered,
      });
      return;
    }
    case 'legacyDebit':
      throw new Error('legacy debits are seeded as the opening state, not driven');
  }
}

async function drive(open: number, events: ModelEvent[]): Promise<Driver> {
  const d: Driver = { h: harness({ wallets: [openWallet(open)], mode: 'V2' }), lotOf: {}, movements: [], revSeq: 0 };
  for (const ev of [...(open > 0 ? openingEvents(open) : []), ...events]) await apply(d, ev);
  return d;
}

/** Assert the persisted state equals the WP0 model (and the passbook chain is exact). */
function expectMatchesOracle(d: Driver, m: WalletModel, oracleMoves: Movement[]): void {
  const oracleRev = oracleMoves.filter((mv) => mv.kind === 'REVERSAL');
  const rowless = oracleMoves.filter((mv) => mv.kind === 'EXPIRY' && mv.pointsDelta === 0).length;
  const w = d.h.wallets[0];
  expect({ B: w.redeemablePoints, D: w.debtPoints, seq: w.movementSeq }).toEqual({ ...m.state, seq: m.state.seq - rowless });
  for (const pos of Object.values(m.positions)) {
    const row = d.h.positions.find((p) => p.outletCode === `O-${pos.id}`)!;
    expect({ id: pos.id, offset: row.offsetPoints, reversed: row.reversedPoints }).toEqual({
      id: pos.id,
      offset: pos.offset,
      reversed: pos.reversed,
    });
  }
  for (const lot of m.lots) {
    const row = d.h.ledger.find((l) => l.id === d.lotOf[lot.id]);
    expect({ lot: lot.id, remaining: row ? row.remainingPoints : undefined }).toEqual({ lot: lot.id, remaining: lot.remaining });
  }
  const sum = (ms: Movement[], k: 'shortfall' | 'recovered' | 'debtRestored') => ms.reduce((s, x) => s + x[k], 0);
  expect(sum(d.movements, 'shortfall')).toBe(sum(oracleRev, 'shortfall'));
  expect(sum(d.movements, 'recovered')).toBe(sum(oracleRev, 'recovered'));
  expect(sum(d.movements, 'debtRestored')).toBe(sum(oracleRev, 'debtRestored'));
  // allocation rows carry the same totals (one per reversal × position here)
  expect(d.h.allocations.reduce((s, a) => s + a.shortfall, 0)).toBe(sum(oracleRev, 'shortfall'));
  // passbook chain: seq contiguous, balanceAfter = balanceBefore + pointsDelta, chained, last = wallet
  const rows = [...d.h.walletTxns].sort((a, b) => a.seq - b.seq);
  rows.forEach((r, i) => {
    expect(r.balanceAfter).toBe(r.balanceBefore + r.pointsDelta);
    if (i > 0) {
      expect(r.seq).toBe(rows[i - 1].seq + 1);
      expect(r.balanceBefore).toBe(rows[i - 1].balanceAfter);
    }
    expect(r.pointsLedgerId).toBeTruthy();
  });
  if (rows.length) {
    expect(rows[rows.length - 1].seq).toBe(w.movementSeq);
    expect(rows[rows.length - 1].balanceAfter).toBe(w.redeemablePoints);
  }
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const p of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...p]);
  });
  return out;
}

/** Run every approval order through the service and the oracle; assert equality per order. Returns the finals. */
async function allOrders(open: number, prefix: ModelEvent[], reversals: ModelEvent[]) {
  const finals: { B: number; D: number; sf: number; rec: number }[] = [];
  for (const perm of permutations(reversals)) {
    const oracle = run([...openingEvents(open), ...prefix, ...perm]);
    expect(checkInvariants(oracle.model)).toEqual([]);
    const oracleRev = oracle.movements.filter((mv) => mv.kind === 'REVERSAL');
    const d = await drive(open, [...prefix, ...perm]);
    expectMatchesOracle(d, oracle.model, oracle.movements);
    finals.push({
      B: oracle.model.state.B,
      D: oracle.model.state.D,
      sf: oracleRev.reduce((s, x) => s + x.shortfall, 0),
      rec: oracleRev.reduce((s, x) => s + x.debtRestored + x.recovered, 0),
    });
  }
  return finals;
}

const cr = (id: string, amount: number): ModelEvent => ({ type: 'credit', id, amount, reversible: true });
const sp = (amount: number): ModelEvent => ({ type: 'spend', amount });
const rv = (creditId: string, amount: number): ModelEvent => ({ type: 'reverse', creditId, amount });
const ex = (lotId: string): ModelEvent => ({ type: 'expire', lotId });

// ───────────────────────── §15 test matrix through the service ─────────────────────────

describe('Reversal engine v2 — §15 test matrix (service ≡ WP0, every approval order)', () => {
  it('T-a: 0, f1 +500, redeem 500, f2 +300; reverse f1, f2 → B 0, D 0, Σrec 300, Σsf 500 (= today)', async () => {
    const f = await allOrders(0, [cr('f1', 500), sp(500), cr('f2', 300)], [rv('f1', 500), rv('f2', 300)]);
    for (const x of f) expect(x).toEqual({ B: 0, D: 0, sf: 500, rec: 300 });
  });

  it('T-b: −841, f1 +500, f2 +300; reverse both → B −841, shortfall 0 (R1)', async () => {
    const f = await allOrders(-841, [cr('f1', 500), cr('f2', 300)], [rv('f1', 500), rv('f2', 300)]);
    for (const x of f) expect(x).toMatchObject({ B: -841, D: 841, sf: 0 });
  });

  it('T-c: −100, E +500, redeem 400, X +300; reverse E, X → B −100, Σrec 400, Σsf 400', async () => {
    const f = await allOrders(-100, [cr('E', 500), sp(400), cr('X', 300)], [rv('E', 500), rv('X', 300)]);
    for (const x of f) expect(x).toMatchObject({ B: -100, sf: 400, rec: 400 });
  });

  it('T-d: −1000, D +1200, E +500, reverse D, X +300; reverse E, X → B −1000, sf 0 (patched code: −700 ✗)', async () => {
    const f = await allOrders(
      -1000,
      [cr('Dc', 1200), cr('E', 500), rv('Dc', 1200), cr('X', 300)],
      [rv('E', 500), rv('X', 300)],
    );
    for (const x of f) expect(x).toMatchObject({ B: -1000 });
  });

  it('T-R2*: −100, X +100, Z +200, redeem 200, Y +200; reverse X & Y → B −100 (Q1)', async () => {
    const f = await allOrders(-100, [cr('X', 100), cr('Z', 200), sp(200), cr('Y', 200)], [rv('X', 100), rv('Y', 200)]);
    for (const x of f) expect(x.B).toBe(-100);
    const f3 = await allOrders(
      -100,
      [cr('X', 100), cr('Z', 200), sp(200), cr('Y', 200)],
      [rv('X', 100), rv('Y', 200), rv('Z', 200)],
    );
    for (const x of f3) expect(x.B).toBe(-100);
  });

  it('T-g1..3: partial reversals — identical B across orders, and the cap a − ρ is enforced', async () => {
    const f = await allOrders(-300, [cr('X', 400), sp(50), cr('Y', 200)], [rv('X', 150), rv('X', 250), rv('Y', 120)]);
    expect(new Set(f.map((x) => `${x.B}/${x.D}/${x.sf}`)).size).toBe(1);
    const d = await drive(0, [cr('X', 100), rv('X', 60)]);
    await expect(
      d.h.models.$transaction((tx: any) =>
        d.h.service.applyCreditReversal(tx, { batchId: 'B-X', outletCode: 'O-X', fieldId: 'F', creditReversalId: 'R9', points: 41 }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(d.h.wallets[0].redeemablePoints).toBe(40);
  });

  it('T-x1: expiry on a wallet with debt = today\'s clamp; the excess is reclassified as debt repayment (Q6)', async () => {
    // −100, X +300 (o 100), redeem 150, reverse X 100 (p 100 → B −50, D 100), expire X's lot (h 50, e 0, x 50)
    const events = [cr('X', 300), sp(150), rv('X', 100), ex('X')];
    const oracle = run([...openingEvents(-100), ...events]);
    const d = await drive(-100, events);
    expectMatchesOracle(d, oracle.model, oracle.movements);
    expect(d.h.wallets[0]).toMatchObject({ redeemablePoints: -50, debtPoints: 50, expiredPoints: 0 });
    // e = 0 → no DEBIT_EXPIRY passbook row (as today), only D / O changed
    expect(d.h.walletTxns.some((t) => t.transactionType === 'DEBIT_EXPIRY')).toBe(false);
    // and a positive-balance expiry on a debt wallet still expires min(h, B)
    const events2 = [cr('X', 300), cr('Y', 200), sp(100), ex('Y')];
    const o2 = run([...openingEvents(-100), ...events2]);
    const d2 = await drive(-100, events2);
    expectMatchesOracle(d2, o2.model, o2.movements);
    expect(d2.h.wallets[0].expiredPoints).toBe(-o2.movements[o2.movements.length - 1].pointsDelta);
  });

  it('DE-4: 0, f1 +500, redeem 500, f2 +300 → either order ends at 0 and the lot fix applies (own lot first)', async () => {
    const f = await allOrders(0, [cr('f1', 500), sp(500), cr('f2', 300)], [rv('f1', 500), rv('f2', 300)]);
    for (const x of f) expect(x.B).toBe(0);
  });

  it('Q7: the reversed credit\'s OWN lot is drawn first — an older lot keeps its points (today burnt the oldest)', async () => {
    const d = await drive(0, [cr('A', 100), cr('X', 100), rv('X', 100)]);
    expect(d.h.ledger.find((l) => l.id === d.lotOf.A)!.remainingPoints).toBe(100);
    expect(d.h.ledger.find((l) => l.id === d.lotOf.X)!.remainingPoints).toBe(0);
    expect(d.h.wallets[0].redeemablePoints).toBe(100);
  });
});

// ───────────────────────── property tests ─────────────────────────

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rnd: () => number, lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

/** A random live history (credits / spends / expiries / interleaved reversals) valid for the oracle. */
function randomHistory(rnd: () => number, open: number, len: number): { prefix: ModelEvent[]; reversals: ModelEvent[] } {
  const prefix: ModelEvent[] = [];
  let k = 0;
  for (let i = 0; i < len; i++) {
    const m = run([...openingEvents(open), ...prefix]).model;
    const roll = rnd();
    const live = m.lots.filter((l) => l.remaining > 0 && l.id !== 'OPEN');
    const reversible = Object.values(m.positions).filter((p) => p.amount - p.reversed > 0);
    if (roll < 0.45) prefix.push(cr(`c${++k}`, randInt(rnd, 1, 600)));
    else if (roll < 0.7 && m.state.B > 0) prefix.push(sp(randInt(rnd, 1, m.state.B)));
    else if (roll < 0.82 && live.length) prefix.push(ex(live[randInt(rnd, 0, live.length - 1)].id));
    else if (reversible.length) {
      const p = reversible[randInt(rnd, 0, reversible.length - 1)];
      prefix.push(rv(p.id, randInt(rnd, 1, p.amount - p.reversed)));
    } else prefix.push(cr(`c${++k}`, randInt(rnd, 1, 600)));
  }
  // final batch of up to 3 reversals whose approval order is permuted
  const m = run([...openingEvents(open), ...prefix]).model;
  const left: Record<string, number> = {};
  for (const p of Object.values(m.positions)) left[p.id] = p.amount - p.reversed;
  const reversals: ModelEvent[] = [];
  const n = randInt(rnd, 1, 3);
  for (let i = 0; i < n; i++) {
    const ids = Object.keys(left).filter((id) => left[id] > 0);
    if (!ids.length) break;
    const id = ids[randInt(rnd, 0, ids.length - 1)];
    const r = randInt(rnd, 1, left[id]);
    left[id] -= r;
    reversals.push(rv(id, r));
  }
  return { prefix, reversals };
}

describe('Reversal engine v2 — property tests against WP0', () => {
  it('DE-10 (reduced): 120 random negative-start histories × every approval order of ≤3 reversals ≡ WP0', async () => {
    const rnd = prng(20261115);
    for (let i = 0; i < 120; i++) {
      const open = -randInt(rnd, 1, 1500);
      const { prefix, reversals } = randomHistory(rnd, open, randInt(rnd, 2, 7));
      if (!reversals.length) continue;
      const finals = await allOrders(open, prefix, reversals);
      // R3: wallet totals are order-free
      expect(new Set(finals.map((f) => JSON.stringify(f))).size).toBe(1);
    }
  });

  it('DE-9 (reduced): 150 random never-negative histories — every reversal removes exactly min(r, B), D stays 0', async () => {
    const rnd = prng(42);
    for (let i = 0; i < 150; i++) {
      const open = randInt(rnd, 0, 800);
      const { prefix, reversals } = randomHistory(rnd, open, randInt(rnd, 2, 7));
      const events = [...prefix, ...reversals];
      const d: Driver = { h: harness({ wallets: [openWallet(0)], mode: 'V2' }), lotOf: {}, movements: [], revSeq: 0 };
      for (const ev of openingEvents(open)) await apply(d, ev);
      for (const ev of events) {
        const B = d.h.wallets[0].redeemablePoints;
        await apply(d, ev);
        if (ev.type === 'reverse') {
          const removed = B - d.h.wallets[0].redeemablePoints;
          expect(removed).toBe(legacyReversalDecrement(B, ev.amount));
        }
        expect(d.h.wallets[0].debtPoints).toBe(0);
        expect(d.h.positions.every((p) => p.offsetPoints === 0)).toBe(true);
      }
      const oracle = run([...openingEvents(open), ...events]);
      expect(checkInvariants(oracle.model, { neverNegative: true })).toEqual([]);
      expectMatchesOracle(d, oracle.model, oracle.movements);
    }
  });
});

// ───────────────────────── applyMovement v2 write path (WP2) ─────────────────────────

describe('rollout guard - which write path a movement takes (movementPath)', () => {
  const withHistory = () => blankWallet('w1', 'cp1', { redeemablePoints: 100, earnedPoints: 100, lifetimeEarned: 100 });
  const seedRow = (h: H) => h.walletTxns.push({ id: 'old', walletId: 'w1', points: 100, createdAt: later(-5000) });
  const batchCredit = (h: H, amt: number) =>
    h.service.creditEarn('cp1', 'bajaj', amt, {
      referenceType: 'CREDIT_BATCH', referenceId: 'B1', metadata: { fieldId: 'F1', outletCode: 'O1' },
    });

  it('LEGACY tenant (default), pristine wallet -> legacy write path: no seq / pointsDelta / position', async () => {
    const h = harness();
    await batchCredit(h, 50);
    expect(h.walletTxns[0].seq).toBeUndefined();
    expect(h.walletTxns[0].pointsDelta).toBeUndefined();
    expect(h.walletTxns[0].pointsLedgerId).toBeUndefined();
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 50, movementSeq: 0 });
    expect(h.positions).toHaveLength(0);
  });

  it('SHADOW / V2 tenant, wallet WITH un-sequenced history (backfill not applied) -> refused (409), nothing written', async () => {
    for (const mode of ['SHADOW', 'V2'] as const) {
      const h = harness({ wallets: [withHistory()], mode });
      seedRow(h);
      await expect(batchCredit(h, 50)).rejects.toThrow(WALLET_NOT_BACKFILLED_MESSAGE);
      await expect(h.service.debitRedeem('cp1', 10, {})).rejects.toBeInstanceOf(ConflictException);
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: 100, movementSeq: 0 });
      expect(h.walletTxns).toHaveLength(1);
      expect(h.ledger).toHaveLength(0);
    }
  });

  it('SHADOW / V2 tenant, pristine wallet -> v2 from its first movement (seq 1)', async () => {
    const h = harness({ mode: 'SHADOW' });
    await batchCredit(h, 50);
    expect(h.walletTxns[0]).toMatchObject({ seq: 1, pointsDelta: 50 });
    expect(h.positions).toHaveLength(1);
  });

  it('backfilled wallet (movementSeq > 0) on a LEGACY tenant stays sequenced (no mixed history); balances = legacy', async () => {
    const h = harness({ wallets: [blankWallet('w1', 'cp1', { redeemablePoints: 100, earnedPoints: 100, lifetimeEarned: 100, movementSeq: 1 })] });
    seedRow(h);
    await batchCredit(h, 50);
    await h.service.debitRedeem('cp1', 30, {});
    expect(h.walletTxns.slice(1).map((t) => [t.seq, t.pointsDelta])).toEqual([[2, 50], [3, -30]]);
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 120, earnedPoints: 150, redeemedPoints: 30, movementSeq: 3 });
  });

  it('the expiry sweep follows the same guard (V2 tenant, un-backfilled wallet -> refused, balance untouched)', async () => {
    const h = harness({ wallets: [withHistory()], mode: 'V2' });
    seedRow(h);
    h.ledger.push({ id: 'L1', walletId: 'w1', transactionType: 'EARN', points: 100, remainingPoints: 100, isExpired: false, expiresAt: later(-10), createdAt: later(-9000) });
    await expect(h.service.expireDuePoints({ now: NOW })).rejects.toBeInstanceOf(ConflictException);
    expect(h.wallets[0].redeemablePoints).toBe(100);
  });
});

describe('applyMovement v2 (WP2)', () => {
  it('tracked wallet: lock first, seq / pointsDelta / exact balanceBefore / ledger link; credit-batch credit gets an EXACT position', async () => {
    const h = harness({ mode: 'V2' });
    await h.service.creditEarn('cp1', 'bajaj', 500, {
      referenceType: 'CREDIT_BATCH', referenceId: 'B1', metadata: { fieldId: 'F1', outletCode: 'O1' },
    });
    await h.service.debitRedeem('cp1', 200, { referenceId: 'ord' });
    expect(h.models.$queryRaw).toHaveBeenCalled();
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 300, debtPoints: 0, movementSeq: 2, earnedPoints: 500, redeemedPoints: 200 });
    expect(h.walletTxns.map((t) => [t.seq, t.pointsDelta, t.balanceBefore, t.balanceAfter])).toEqual([
      [1, 500, 0, 500],
      [2, -200, 500, 300],
    ]);
    for (const t of h.walletTxns) expect(h.ledger.some((l) => l.id === t.pointsLedgerId)).toBe(true);
    expect(h.positions).toEqual([
      expect.objectContaining({
        walletId: 'w1', batchId: 'B1', outletCode: 'O1', fieldId: 'F1', amount: 500, offsetPoints: 0,
        reversedPoints: 0, attribution: 'EXACT', creditTxId: h.walletTxns[0].id, lotId: h.walletTxns[0].pointsLedgerId,
      }),
    ]);
  });

  it('a credit on a debt wallet repays debt first (Q12): D −= o, O_X = o, lot remaining a − o', async () => {
    const h = harness({ wallets: [openWallet(-841)], mode: 'V2' });
    await h.service.creditEarn('cp1', 'bajaj', 500, {
      referenceType: 'CREDIT_BATCH', referenceId: 'B1', metadata: { fieldId: 'F1', outletCode: 'O1' },
    });
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: -341, debtPoints: 341, movementSeq: 2 });
    expect(h.positions[0].offsetPoints).toBe(500);
    expect(h.ledger.find((l) => l.transactionType === 'EARN')!.remainingPoints).toBe(0);
    // a refund credit (non-reversible) repays debt too, without a position
    await h.service.reverse('cp1', 400, { referenceId: 'ord' });
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 59, debtPoints: 0 });
    expect(h.positions).toHaveLength(1);
    expect(h.ledger.find((l) => l.transactionType === 'REVERSE')!.remainingPoints).toBe(59);
  });

  it('a guarded debit on a tracked wallet still refuses B < s (no row, no seq)', async () => {
    const h = harness({ mode: 'V2' });
    await h.service.creditEarn('cp1', 'bajaj', 50, {});
    await expect(h.service.debitRedeem('cp1', 60, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(h.wallets[0].movementSeq).toBe(1);
    expect(h.walletTxns).toHaveLength(1);
  });

  it('UNTRACKED wallet (has history, movementSeq 0): today\'s write path — no seq, no pointsDelta, no D, no position', async () => {
    const h = harness({ wallets: [blankWallet('w1', 'cp1', { redeemablePoints: 100, earnedPoints: 100, lifetimeEarned: 100 })] });
    h.walletTxns.push({ id: 'old', walletId: 'w1', points: 100, createdAt: later(-5000) });
    await h.service.creditEarn('cp1', 'bajaj', 50, {
      referenceType: 'CREDIT_BATCH', referenceId: 'B1', metadata: { fieldId: 'F1', outletCode: 'O1' },
    });
    const t = h.walletTxns[h.walletTxns.length - 1];
    expect(t.seq).toBeUndefined();
    expect(t.pointsDelta).toBeUndefined();
    expect(t.pointsLedgerId).toBeUndefined();
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 150, movementSeq: 0, debtPoints: 0 });
    expect(h.positions).toHaveLength(0);
  });

  it('isWalletPristine: no rows + every figure 0 -> true; any figure, any row, or movementSeq > 0 -> false', async () => {
    const h = harness();
    const tx = h.models as any;
    await expect(h.service.isWalletPristine(tx, blankWallet('w1', 'cp1') as any)).resolves.toBe(true);
    await expect(h.service.isWalletPristine(tx, blankWallet('w1', 'cp1', { lifetimeExpired: 3 }) as any)).resolves.toBe(false);
    await expect(h.service.isWalletPristine(tx, blankWallet('w1', 'cp1', { movementSeq: 2 }) as any)).resolves.toBe(false);
    h.walletTxns.push({ id: 'x', walletId: 'w1' });
    await expect(h.service.isWalletPristine(tx, blankWallet('w1', 'cp1') as any)).resolves.toBe(false);
  });

  it('refuses to write a tracked wallet whose stored state breaks H ≥ 0', async () => {
    const h = harness({ wallets: [blankWallet('w1', 'cp1', { redeemablePoints: -10, debtPoints: 0, movementSeq: 3 })] });
    await expect(h.service.creditEarn('cp1', 'bajaj', 5, {})).rejects.toBeInstanceOf(ConflictException);
    expect(h.walletTxns).toHaveLength(0);
  });
});

// ───────────────────────── applyCreditReversal refusals (WP3) ─────────────────────────

describe('applyCreditReversal (WP3) — R5 / Q4 / Q5', () => {
  const credit = (h: H, partnerId: string, outlet: string, amt: number, batch = 'B1') =>
    h.service.creditEarn(partnerId, 'bajaj', amt, {
      referenceType: 'CREDIT_BATCH', referenceId: batch, metadata: { fieldId: 'F1', outletCode: outlet },
    });
  const reverse = (h: H, points: number, id = 'R1', outlet = 'O1', batch = 'B1') =>
    h.models.$transaction((tx: any) =>
      h.service.applyCreditReversal(tx, { batchId: batch, outletCode: outlet, fieldId: 'F1', creditReversalId: id, points }),
    );

  it('T-f1 / Q4: outlet relinked after the credit → v2 debits the wallet that RECEIVED it, never the new owner', async () => {
    const h = harness({
      mode: 'V2',
      wallets: [blankWallet('w1', 'cp1'), blankWallet('w2', 'cp2')],
      outlets: [{ clientId: 'bajaj', outletCode: 'O1', partnerId: 'cp1' }],
    });
    await credit(h, 'cp1', 'O1', 300);
    await h.service.creditEarn('cp2', 'bajaj', 1000, {});
    h.outlets[0].partnerId = 'cp2'; // relinked
    await reverse(h, 300);
    expect(h.wallets.find((w) => w.id === 'w1')!.redeemablePoints).toBe(0);
    expect(h.wallets.find((w) => w.id === 'w2')!.redeemablePoints).toBe(1000);
  });

  it('no position for the key → 400; UNRESOLVED credit in the batch → 400 (Q5); over cap → 400; nothing written', async () => {
    const h = harness({ mode: 'V2' });
    await expect(reverse(h, 10)).rejects.toBeInstanceOf(BadRequestException);
    await credit(h, 'cp1', 'O1', 300);
    h.positions.push({ id: 'u1', walletId: 'w1', batchId: 'B1', outletCode: null, fieldId: null, amount: 5, offsetPoints: 0, reversedPoints: 0, attribution: 'UNRESOLVED', creditTxId: 'x' });
    await expect(reverse(h, 10)).rejects.toThrow(/map them first/);
    h.positions.pop();
    await expect(reverse(h, 301)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 300, movementSeq: 1 });
    expect(h.allocations).toHaveLength(0);
  });

  it('several positions for one key: oldest first, one allocation each, cap Σ(a − ρ) across them', async () => {
    const h = harness({ mode: 'V2' });
    await credit(h, 'cp1', 'O1', 100);
    await credit(h, 'cp1', 'O1', 200);
    await h.service.debitRedeem('cp1', 250, {});
    const res = await reverse(h, 250);
    expect(res.steps.map((s) => [s.requested, s.recovered, s.shortfall])).toEqual([
      [100, 50, 50],
      [150, 0, 150],
    ]);
    expect(h.allocations).toHaveLength(2);
    expect(h.positions.map((p) => p.reversedPoints)).toEqual([100, 150]);
    expect(h.wallets[0].redeemablePoints).toBe(0);
    await expect(reverse(h, 51, 'R2')).rejects.toBeInstanceOf(BadRequestException);
    await reverse(h, 50, 'R2');
    expect(h.positions.map((p) => p.reversedPoints)).toEqual([100, 200]);
  });

  it('writes the v2 columns: seq, pointsDelta (actual), reversedCreditTxId, creditReversalId; ledger keeps −r', async () => {
    const h = harness({ wallets: [openWallet(-841)], mode: 'V2' });
    await credit(h, 'cp1', 'O1', 500);
    await reverse(h, 500, 'REV');
    const t = h.walletTxns[h.walletTxns.length - 1];
    expect(t).toMatchObject({
      transactionType: 'DEBIT_ADJUSTMENT', points: -500, pointsDelta: -500, seq: 3,
      balanceBefore: -341, balanceAfter: -841, reversedCreditTxId: h.positions[0].creditTxId, creditReversalId: 'REV',
      referenceType: 'CREDIT_REVERSAL', referenceId: 'REV',
    });
    expect(h.ledger.find((l) => l.id === t.pointsLedgerId)).toMatchObject({ transactionType: 'ADJUST', points: -500 });
    expect(h.allocations[0]).toMatchObject({ requested: 500, debtRestored: 500, recovered: 0, shortfall: 0 });
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: -841, debtPoints: 841 });
  });
});

// ───────────────────────── LEGACY / SHADOW / V2 dispatch (WP3) ─────────────────────────

describe('reverseCreditBatchPoints — per-tenant flag', () => {
  const linked = [{ clientId: 'bajaj', outletCode: 'O1', partnerId: 'cp1' }];
  const credit = (h: H, amt: number) =>
    h.service.creditEarn('cp1', 'bajaj', amt, {
      referenceType: 'CREDIT_BATCH', referenceId: 'B1', metadata: { fieldId: 'F1', outletCode: 'O1' },
    });
  const dispatch = (h: H, points: number, id = 'R1') =>
    h.models.$transaction((tx: any) =>
      h.service.reverseCreditBatchPoints(tx, {
        clientId: 'bajaj', batchId: 'B1', outletCode: 'O1', fieldId: 'F1', creditReversalId: id, points, actorId: 'u1',
      }),
    );

  it('LEGACY (default): floor-0 clawback on the current partner\'s wallet; a sequenced (backfilled) wallet keeps ρ + allocations in step', async () => {
    const h = harness({ outlets: linked, wallets: [blankWallet('w1', 'cp1', { movementSeq: 1 })] });
    await credit(h, 500);
    await h.service.debitRedeem('cp1', 400, {});
    const res = await dispatch(h, 500);
    expect(res).toEqual({ mode: 'LEGACY', shortfall: 400, walletIds: ['w1'] });
    expect(h.settings.modeReads).toBe(1);
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 0, debtPoints: 0, movementSeq: 4 });
    expect(h.positions[0].reversedPoints).toBe(500);
    expect(h.allocations[0]).toMatchObject({ requested: 500, debtRestored: 0, recovered: 100, shortfall: 400 });
    const t = h.walletTxns[h.walletTxns.length - 1];
    expect(t.description).toBe(
      'Clawback for reversal R1 — batch POINTS reversal [SHORTFALL: 400 pts already redeemed — owner review required]',
    );
    expect(h.auditLogs).toHaveLength(0);
  });

  it('LEGACY: a wallet with debt is still refused (Q14) — negative B, recorded D, or a credit that repaid debt', async () => {
    const neg = harness({ wallets: [openWallet(-841)], outlets: linked });
    await credit(neg, 500);
    await expect(dispatch(neg, 500)).rejects.toThrow(DEBT_REVERSAL_PAUSED_MESSAGE);
    expect(neg.wallets[0].redeemablePoints).toBe(-341);
    // credit repaid debt but B ≥ 0 now: O_X > 0 → paused
    const off = harness({ wallets: [openWallet(-100)], outlets: linked });
    await credit(off, 500);
    expect(off.wallets[0]).toMatchObject({ redeemablePoints: 400, debtPoints: 0 });
    await expect(dispatch(off, 100)).rejects.toThrow(DEBT_REVERSAL_PAUSED_MESSAGE);
    expect(off.wallets[0].redeemablePoints).toBe(400);
  });

  it('SHADOW: applies LEGACY and records the v2 result next to it (no diff on a never-negative wallet)', async () => {
    const h = harness({ outlets: linked, mode: 'SHADOW' });
    await credit(h, 500);
    await h.service.debitRedeem('cp1', 100, {});
    const res = await dispatch(h, 300);
    expect(res.mode).toBe('SHADOW');
    expect(h.wallets[0].redeemablePoints).toBe(100);
    expect(h.auditLogs).toHaveLength(1);
    expect(h.auditLogs[0]).toMatchObject({
      entityType: 'REVERSAL_ENGINE_SHADOW', entityId: 'R1', actorId: 'u1',
      metadata: expect.objectContaining({ differs: false, legacy: expect.objectContaining({ removed: 300, shortfall: 0 }) }),
    });
    expect(h.auditLogs[0].metadata.v2).toMatchObject({ removed: 300, shortfall: 0 });
  });

  it('SHADOW: an un-backfilled wallet (history, movementSeq 0) is refused before anything is written', async () => {
    const h = harness({
      outlets: linked,
      mode: 'SHADOW',
      wallets: [blankWallet('w1', 'cp1', { redeemablePoints: 500, earnedPoints: 500, lifetimeEarned: 500 })],
    });
    h.walletTxns.push({
      id: 'old', walletId: 'w1', transactionType: 'CREDIT_POINTS_EARNED', referenceType: 'CREDIT_BATCH', referenceId: 'B1',
      points: 500, balanceBefore: 0, balanceAfter: 500, metadata: { fieldId: 'F1', outletCode: 'O1' }, createdAt: later(-9000),
    });
    await expect(dispatch(h, 200)).rejects.toThrow(WALLET_NOT_BACKFILLED_MESSAGE);
    expect(h.wallets[0].redeemablePoints).toBe(500);
    expect(h.auditLogs).toHaveLength(0);
  });

  it('SHADOW: a v2 refusal (UNRESOLVED credit in the batch, Q5) is recorded as a diff; LEGACY still applied', async () => {
    const h = harness({
      outlets: linked,
      mode: 'SHADOW',
      // backfilled wallet whose batch credit could not be attributed
      wallets: [blankWallet('w1', 'cp1', { redeemablePoints: 500, earnedPoints: 500, lifetimeEarned: 500, movementSeq: 1 })],
    });
    h.walletTxns.push({
      id: 'old', walletId: 'w1', transactionType: 'CREDIT_POINTS_EARNED', referenceType: 'CREDIT_BATCH', referenceId: 'B1',
      points: 500, balanceBefore: 0, balanceAfter: 500, seq: 1, pointsDelta: 500,
      metadata: { fieldId: 'F1', outletCode: 'O1' }, createdAt: later(-9000),
    });
    h.positions.push({
      id: 'u1', walletId: 'w1', creditTxId: 'old', lotId: null, batchId: 'B1', outletCode: null, fieldId: null,
      amount: 500, offsetPoints: 0, reversedPoints: 0, attribution: 'UNRESOLVED',
    });
    await dispatch(h, 200);
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 300, movementSeq: 2 });
    expect(h.auditLogs[0].metadata).toMatchObject({ differs: true, v2: { refused: expect.stringMatching(/map them first/) } });
  });

  it('V2: the position engine runs (debt wallet R1: −841 +500 → reverse → −841); LEGACY helpers are not consulted', async () => {
    const h = harness({ wallets: [openWallet(-841)], outlets: [], mode: 'V2' });
    await credit(h, 500);
    const res = await dispatch(h, 500);
    expect(res).toEqual({ mode: 'V2', shortfall: 0, walletIds: ['w1'] });
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: -841, debtPoints: 841 });
  });

  it('malformed / unreadable flag → the reversal is refused, nothing written', async () => {
    const h = harness({ outlets: linked });
    await credit(h, 100);
    (h.service as any).tenantSettings.getReversalEngineModeUncached = async () => {
      throw new BadRequestException('Invalid reversalEngine setting');
    };
    await expect(dispatch(h, 50)).rejects.toThrow(/Invalid reversalEngine/);
    expect(h.wallets[0].redeemablePoints).toBe(100);
  });
});

describe('planV2Reversal (pure)', () => {
  it('refuses non-positive / over-cap amounts and chains two positions on one wallet', () => {
    const pos = (id: string, amount: number, offset = 0, reversed = 0) => ({
      id, walletId: 'w', creditTxId: `t-${id}`, lotId: null, amount, offsetPoints: offset, reversedPoints: reversed,
      creditTx: { seq: 1, createdAt: NOW },
    });
    expect(() => planV2Reversal([pos('a', 10)], new Map([['w', { B: 10, D: 0, seq: 1 }]]), 0)).toThrow(BadRequestException);
    expect(() => planV2Reversal([pos('a', 10, 0, 5)], new Map([['w', { B: 10, D: 0, seq: 1 }]]), 6)).toThrow(BadRequestException);
    const steps = planV2Reversal(
      [pos('a', 100, 60), pos('b', 50)],
      new Map([['w', { B: 30, D: 0, seq: 7 }]]),
      150,
    );
    expect(steps.map((s) => [s.debtRestored, s.recovered, s.shortfall, s.after.seq])).toEqual([
      [60, 30, 10, 8],
      [0, 0, 50, 9],
    ]);
  });
});

describe('TenantSettingsService.getReversalEngineModeUncached', () => {
  const svc = (row: unknown) =>
    new TenantSettingsService({ programSetting: { findUnique: async () => row } } as unknown as PrismaService);
  it('absent → LEGACY; valid strings pass; anything else throws (fail closed)', async () => {
    await expect(svc(null).getReversalEngineModeUncached('t')).resolves.toBe('LEGACY');
    await expect(svc({ settingValue: 'SHADOW' }).getReversalEngineModeUncached('t')).resolves.toBe('SHADOW');
    await expect(svc({ settingValue: 'V2' }).getReversalEngineModeUncached('t')).resolves.toBe('V2');
    await expect(svc({ settingValue: 'v2' }).getReversalEngineModeUncached('t')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc({ settingValue: true }).getReversalEngineModeUncached('t')).rejects.toBeInstanceOf(BadRequestException);
  });
});
