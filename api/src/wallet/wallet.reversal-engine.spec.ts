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
  byCreditOrder,
  planV2Reversal,
  POINTS_EXPIRY_DEBT_ONLY_ENTITY,
  POINTS_EXPIRY_FAILURE_ENTITY,
  ReversalPositionRow,
  WalletService,
  DEBT_REVERSAL_PAUSED_MESSAGE,
} from './wallet.service';
import { ReversalAttentionException } from './reversal-policy';
import { PrismaService } from '../prisma/prisma.service';
import {
  InvalidReversalEngineSettingException,
  ReversalEngineMode,
  TenantSettingsService,
} from '../tenant/tenant-settings.service';
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
  const batches: Row[] = [];
  const reversals: Row[] = [];
  const settings ={ mode: opts.mode ?? ('LEGACY' as ReversalEngineMode), modeReads: 0, modeDbs: [] as unknown[] };
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
        // Prisma's "record to update not found" (P2025) — e.g. the L5 `movementSeq: 0` guard missed
        if (!w) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' });
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
      // withExpiry (owner 2026-11-19): ε_X = Σ alreadyExpired of the position's earlier allocations
      findMany: async ({ where }: any = {}) => allocations.filter((a) => matchWhere(a, where ?? {})).map((a) => ({ ...a })),
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
    creditBatch: { findFirst: async ({ where }: any = {}) => batches.find((b) => b.id === where?.id) ?? null },
    // M3 (fix round A): approved reversals of a line with NO allocation row count against the V2 cap.
    creditReversal: {
      findMany: async ({ where }: any = {}) =>
        reversals.filter((r) => {
          if (where?.id?.not !== undefined && r.id === where.id.not) return false;
          if (where?.batchId !== undefined && r.batchId !== where.batchId) return false;
          if (where?.outletId !== undefined && r.outletId !== where.outletId) return false;
          if (where?.fieldId !== undefined && r.fieldId !== where.fieldId) return false;
          if (where?.awardType !== undefined && r.awardType !== where.awardType) return false;
          if (where?.status?.in && !where.status.in.includes(r.status)) return false;
          if (where?.creditAllocations?.none && allocations.some((a) => a.creditReversalId === r.id)) return false;
          return true;
        }),
    },
    pointExpiryConfig: { findFirst: async () => null },
    channelPartner: { findFirst: async ({ where }: any) => ({ id: where?.id, clientId: 'bajaj' }) },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (cb: any) => cb(models)),
  };
  const tenantSettings = {
    getConversionRate: async () => 1,
    getReversalEngineModeUncached: async (_clientId: string, db?: unknown) => {
      settings.modeReads++;
      settings.modeDbs.push(db);
      // a malformed stored value (fix round A, M1) — the real service throws exactly this
      if (!['LEGACY', 'SHADOW', 'V2'].includes(settings.mode)) throw new InvalidReversalEngineSettingException(settings.mode);
      return settings.mode;
    },
  };
  const service = new WalletService(models as unknown as PrismaService, tenantSettings as unknown as TenantSettingsService);
  return { service, models, wallets, walletTxns, ledger, positions, allocations, auditLogs, outlets, settings, batches, reversals };
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
        pointsDelta: -(res.debtRestored + res.recovered + res.owed),
        debtDelta: res.debtRestored + res.owed,
        offsetDelta: -res.debtRestored,
        offsetPositionId: ev.creditId,
        lotDraws: [],
        shortfall: res.shortfall,
        owed: res.owed,
        alreadyExpired: res.alreadyExpired,
        debtExposed: res.debtExposed,
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
  // no wallet row: a debt-only expiry, and (A6, fix round 3) a reversal fully covered by the credit's expired points
  const rowless = oracleMoves.filter((mv) => (mv.kind === 'EXPIRY' || mv.kind === 'REVERSAL') && mv.pointsDelta === 0).length;
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
  const sum = (ms: Movement[], k: 'shortfall' | 'recovered' | 'debtRestored' | 'owed' | 'alreadyExpired') => ms.reduce((s, x) => s + x[k], 0);
  expect(sum(d.movements, 'alreadyExpired')).toBe(sum(oracleRev, 'alreadyExpired'));
  expect(d.h.allocations.reduce((s, a) => s + (a.alreadyExpired ?? 0), 0)).toBe(sum(oracleRev, 'alreadyExpired'));
  expect(sum(d.movements, 'shortfall')).toBe(sum(oracleRev, 'shortfall'));
  expect(sum(d.movements, 'shortfall')).toBe(0); // owner 2026-11-19: V2 never writes points off
  expect(sum(d.movements, 'recovered')).toBe(sum(oracleRev, 'recovered'));
  expect(sum(d.movements, 'debtRestored')).toBe(sum(oracleRev, 'debtRestored'));
  expect(sum(d.movements, 'owed')).toBe(sum(oracleRev, 'owed'));
  // allocation rows carry the same totals (one per reversal × position here)
  expect(d.h.allocations.reduce((s, a) => s + a.shortfall, 0)).toBe(sum(oracleRev, 'shortfall'));
  expect(d.h.allocations.reduce((s, a) => s + (a.owed ?? 0), 0)).toBe(sum(oracleRev, 'owed'));
  for (const a of d.h.allocations) expect(a.overReversalDebt ?? false).toBe((a.owed ?? 0) > 0);
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
  const finals: { B: number; D: number; sf: number; owed: number; rec: number }[] = [];
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
      owed: oracleRev.reduce((s, x) => s + x.owed, 0),
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
  it('T-a: 0, f1 +500, redeem 500, f2 +300; reverse f1, f2 → B −500, D 500, Σrec 300, Σowed 500 (owner 2026-11-19: debt, not written off)', async () => {
    const f = await allOrders(0, [cr('f1', 500), sp(500), cr('f2', 300)], [rv('f1', 500), rv('f2', 300)]);
    for (const x of f) expect(x).toEqual({ B: -500, D: 500, sf: 0, owed: 500, rec: 300 });
  });

  it('T-b: −841, f1 +500, f2 +300; reverse both → B −841, shortfall 0 (R1)', async () => {
    const f = await allOrders(-841, [cr('f1', 500), cr('f2', 300)], [rv('f1', 500), rv('f2', 300)]);
    for (const x of f) expect(x).toMatchObject({ B: -841, D: 841, sf: 0, owed: 0 });
  });

  it('T-c: −100, E +500, redeem 400, X +300; reverse E, X → B −500, D 500, Σrec 400, Σowed 400', async () => {
    const f = await allOrders(-100, [cr('E', 500), sp(400), cr('X', 300)], [rv('E', 500), rv('X', 300)]);
    for (const x of f) expect(x).toMatchObject({ B: -500, D: 500, sf: 0, owed: 400, rec: 400 });
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
    // Z's 200 were already spent → owed as debt (owner 2026-11-19)
    for (const x of f3) expect(x).toMatchObject({ B: -300, D: 300, owed: 200, sf: 0 });
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

  it('DE-4: 0, f1 +500, redeem 500, f2 +300 → either order ends at −500 / debt 500 (owner 2026-11-19) and the lot fix applies (own lot first)', async () => {
    const f = await allOrders(0, [cr('f1', 500), sp(500), cr('f2', 300)], [rv('f1', 500), rv('f2', 300)]);
    for (const x of f) expect(x).toMatchObject({ B: -500, D: 500 });
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

  it('DE-9 (reduced): 150 random never-negative histories — a reversal takes min(r, B) from the wallet (the LEGACY amount) and books the rest as debt (owner 2026-11-19); D stays 0 until then', async () => {
    const rnd = prng(42);
    let overReversals = 0;
    for (let i = 0; i < 150; i++) {
      const open = randInt(rnd, 0, 800);
      const { prefix, reversals } = randomHistory(rnd, open, randInt(rnd, 2, 7));
      const events = [...prefix, ...reversals];
      const d: Driver = { h: harness({ wallets: [openWallet(0)], mode: 'V2' }), lotOf: {}, movements: [], revSeq: 0 };
      for (const ev of openingEvents(open)) await apply(d, ev);
      let inDebt = false;
      for (const ev of events) {
        const B = d.h.wallets[0].redeemablePoints;
        const D = d.h.wallets[0].debtPoints;
        await apply(d, ev);
        if (ev.type === 'reverse') {
          // the whole r leaves the balance, except the credit's own already-expired points (owner 2026-11-19)
          const q = d.movements[d.movements.length - 1].alreadyExpired;
          expect(B - d.h.wallets[0].redeemablePoints).toBe(ev.amount - q);
          if (!inDebt) {
            const taken = legacyReversalDecrement(B, ev.amount - q);
            expect(d.movements[d.movements.length - 1].recovered).toBe(taken);
            expect(d.h.wallets[0].debtPoints - D).toBe(ev.amount - q - taken);
            if (ev.amount - q > taken) {
              inDebt = true;
              overReversals++;
            }
          }
        }
        if (!inDebt) {
          expect(d.h.wallets[0].debtPoints).toBe(0);
          expect(d.h.positions.every((p) => p.offsetPoints === 0)).toBe(true);
        }
      }
      const oracle = run([...openingEvents(open), ...events]);
      expect(checkInvariants(oracle.model, { neverNegative: !inDebt })).toEqual([]);
      expectMatchesOracle(d, oracle.model, oracle.movements);
    }
    expect(overReversals).toBeGreaterThan(5);
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

  it('policy Q1: SHADOW / V2 tenant, wallet WITH un-sequenced history (BLOCKED or not yet backfilled) -> keeps TODAY\'s rules (legacy path), never refused', async () => {
    for (const mode of ['SHADOW', 'V2'] as const) {
      for (const extra of [{}, { backfillStatus: 'BLOCKED', backfillBlockedReason: 'CHAIN_BROKEN: …' }]) {
        const h = harness({ wallets: [{ ...withHistory(), ...extra }], mode });
        seedRow(h);
        await batchCredit(h, 50); // earn works
        await h.service.debitRedeem('cp1', 10, {}); // redeem works
        expect(h.wallets[0]).toMatchObject({ redeemablePoints: 140, movementSeq: 0, debtPoints: 0 });
        // legacy write path: no seq / pointsDelta / position (no mixed history)
        expect(h.walletTxns.slice(1).every((t) => t.seq === undefined && t.pointsDelta === undefined)).toBe(true);
        expect(h.positions).toHaveLength(0);
        expect(h.walletTxns).toHaveLength(3);
      }
    }
  });

  it('policy Q1: expiry on a BLOCKED wallet of a V2 tenant also runs on today’s clamp (legacy path)', async () => {
    const h = harness({ wallets: [{ ...withHistory(), backfillStatus: 'BLOCKED', backfillBlockedReason: 'x' }], mode: 'V2' });
    seedRow(h);
    h.ledger.push({ id: 'L1', walletId: 'w1', transactionType: 'EARN', points: 100, remainingPoints: 60, isExpired: false, expiresAt: later(-10), createdAt: later(-9000) });
    await expect(h.service.expireDuePoints({ now: NOW })).resolves.toEqual({ expiredLots: 1, expiredPoints: 60, failedLots: 0, failures: [] });
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 40, movementSeq: 0, debtPoints: 0 });
  });

  it('WP7 pool fix: movementPath reads the tenant flag through the CALLER\'s tx (never a second pool connection)', async () => {
    const h = harness({ mode: 'V2' });
    await batchCredit(h, 50);
    expect(h.settings.modeReads).toBe(1);
    expect(h.settings.modeDbs[0]).toBe(h.models); // the tx client handed to the $transaction callback
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

  it('policy Q1: the expiry sweep follows the same guard (V2 tenant, un-backfilled wallet -> today’s clamp, legacy row)', async () => {
    const h = harness({ wallets: [withHistory()], mode: 'V2' });
    seedRow(h);
    h.ledger.push({ id: 'L1', walletId: 'w1', transactionType: 'EARN', points: 100, remainingPoints: 100, isExpired: false, expiresAt: later(-10), createdAt: later(-9000) });
    await expect(h.service.expireDuePoints({ now: NOW })).resolves.toEqual({ expiredLots: 1, expiredPoints: 100, failedLots: 0, failures: [] });
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 0, movementSeq: 0 });
    expect(h.walletTxns[1].seq).toBeUndefined();
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
    await expect(reverse(h, 10)).rejects.toThrow(/couldn't be identified — Gifsy must map it first/);
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
    expect(res.steps.map((s) => [s.requested, s.recovered, s.owed, s.shortfall])).toEqual([
      [100, 50, 50, 0],
      [150, 0, 150, 0],
    ]);
    expect(h.allocations).toHaveLength(2);
    expect(h.allocations.map((a) => [a.owed, a.overReversalDebt, a.shortfall])).toEqual([
      [50, true, 0],
      [150, true, 0],
    ]);
    expect(h.positions.map((p) => p.reversedPoints)).toEqual([100, 150]);
    // owner 2026-11-19: the 200 already redeemed are debt — B −200, D 200
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: -200, debtPoints: 200 });
    await expect(reverse(h, 51, 'R2')).rejects.toBeInstanceOf(BadRequestException);
    await reverse(h, 50, 'R2');
    expect(h.positions.map((p) => p.reversedPoints)).toEqual([100, 200]);
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: -250, debtPoints: 250 });
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

  describe('owner decision 2026-11-19 — an over-reversal becomes wallet debt, repaid from future earnings', () => {
    /** The staging example: 10,000 pts credited, 2,986 redeemed (holds 7,014), the whole 10,000 reversed. */
    const overReversed = async () => {
      const h = harness({ mode: 'V2' });
      await credit(h, 'cp1', 'O1', 10000);
      await h.service.debitRedeem('cp1', 2986, { referenceId: 'ord-1' });
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: 7014, debtPoints: 0 });
      const res = await reverse(h, 10000, 'REV');
      return { h, res };
    };

    it('reverse 10,000 from a wallet holding 7,014 → balance −2,986, debt 2,986, nothing written off (amounts, ledger rows, position, allocation)', async () => {
      const { h, res } = await overReversed();
      expect(res).toMatchObject({ shortfall: 0, recovered: 7014, debtRestored: 0, owed: 2986 });
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: -2986, debtPoints: 2986, movementSeq: 3 });
      // one passbook row for the whole 10,000 (the balance really moved by it) + its ledger row
      const t = h.walletTxns[h.walletTxns.length - 1];
      expect(t).toMatchObject({
        transactionType: 'DEBIT_ADJUSTMENT', points: -10000, pointsDelta: -10000, seq: 3,
        balanceBefore: 7014, balanceAfter: -2986, creditReversalId: 'REV', referenceType: 'CREDIT_REVERSAL', referenceId: 'REV',
      });
      // Q8: no debt / shortfall wording on the partner's passbook row
      expect(t.description).not.toMatch(/SHORTFALL|debt/i);
      expect(h.ledger.find((l) => l.id === t.pointsLedgerId)).toMatchObject({ transactionType: 'ADJUST', points: -10000, remainingPoints: 0 });
      // the credit's own lot gave up the 7,014 it still held (FIFO lots stay = holdings H = 0)
      const lot = h.ledger.find((l) => l.id === h.positions[0].lotId)!;
      expect(lot.remainingPoints).toBe(0);
      expect(h.positions[0]).toMatchObject({ amount: 10000, offsetPoints: 0, reversedPoints: 10000 });
      expect(h.allocations).toEqual([
        expect.objectContaining({
          creditReversalId: 'REV', requested: 10000, debtRestored: 0, recovered: 7014, owed: 2986, overReversalDebt: true, shortfall: 0,
        }),
      ]);
      // and the credit can't be reversed again
      await expect(reverse(h, 1, 'REV2')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('owner decision 2: the passbook row explains itself — "Credit reversed (<field · period>) −10,000 · 2,986 owed, repaid from future earnings"', async () => {
      const h = harness({ mode: 'V2' });
      await credit(h, 'cp1', 'O1', 10000);
      await h.service.debitRedeem('cp1', 2986, { referenceId: 'ord-1' });
      await h.models.$transaction((tx: any) =>
        h.service.applyCreditReversal(tx, {
          batchId: 'B1', outletCode: 'O1', fieldId: 'F1', creditReversalId: 'REV', points: 10000, passbookLabel: 'Volume · 2026-10',
        }),
      );
      expect(h.walletTxns[h.walletTxns.length - 1].description).toBe(
        'Credit reversed (Volume · 2026-10) −10,000 · 2,986 owed, repaid from future earnings',
      );
    });

    it('fix round 3 A4/A5: holdings that were backing earlier debt — B 60 / D 40, reverse Y 100 → B −40, recorded + said (never "imported history")', async () => {
      const h = harness({ wallets: [openWallet(-40)], mode: 'V2' });
      await credit(h, 'cp1', 'O1', 100); // X: repays the 40 debt (O 40), B 60
      await credit(h, 'cp1', 'O2', 100, 'B2'); // Y: B 160
      await reverse(h, 40, 'RX'); // X 40 → p 40: B 120, D 40
      await h.service.debitRedeem('cp1', 60, {}); // B 60, D 40, H 100
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: 60, debtPoints: 40 });
      const res = await h.models.$transaction((tx: any) =>
        h.service.applyCreditReversal(tx, {
          batchId: 'B2', outletCode: 'O2', fieldId: 'F1', creditReversalId: 'RY', points: 100, passbookLabel: 'Volume · 2026-10',
        }),
      );
      expect(res).toMatchObject({ recovered: 100, owed: 0, debtExposed: 40, balanceBelowZero: 40 });
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: -40, debtPoints: 40 });
      expect(h.allocations.find((a) => a.creditReversalId === 'RY')).toMatchObject({
        recovered: 100, owed: 0, debtExposed: 40, engineSource: 'V2', overReversalDebt: false,
      });
      // A5: the passbook says what the BALANCE did — 40 now owed — not "100 owed" and not silent
      expect(h.walletTxns[h.walletTxns.length - 1].description).toBe(
        'Credit reversed (Volume · 2026-10) −100 · 40 owed, repaid from future earnings',
      );
    });

    it('fix round 3 A5: debt a credit had paid off, restored while the balance stays ≥ 0, is NOT called "owed" on the passbook', async () => {
      const h = harness({ wallets: [openWallet(-40)], mode: 'V2' });
      await credit(h, 'cp1', 'O1', 100); // X repays 40 (O 40), B 60
      await credit(h, 'cp1', 'O2', 500, 'B2'); // B 560
      await h.models.$transaction((tx: any) =>
        h.service.applyCreditReversal(tx, {
          batchId: 'B1', outletCode: 'O1', fieldId: 'F1', creditReversalId: 'RX', points: 100, passbookLabel: 'Volume · 2026-10',
        }),
      );
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: 460, debtPoints: 40 });
      expect(h.walletTxns[h.walletTxns.length - 1].description).toBe('Credit reversed (Volume · 2026-10) −100');
    });

    it('fix round 3 A6: the stored points ARE the balance change −(r − q) — expired points are never counted twice in ledger sums', async () => {
      const h = harness({ mode: 'V2' });
      await credit(h, 'cp1', 'O1', 10000);
      await h.service.debitRedeem('cp1', 4000, {});
      const pos = h.positions[0];
      const lot = h.ledger.find((l) => l.id === pos.lotId)!;
      lot.expiresAt = later(-10);
      await h.service.expireDuePoints({ now: NOW }); // 6,000 expired
      lot.expiresAt = null;
      await credit(h, 'cp1', 'O2', 5000, 'B2');
      await reverse(h, 10000, 'REV');
      const t = h.walletTxns[h.walletTxns.length - 1];
      expect(t).toMatchObject({ points: -4000, pointsDelta: -4000, balanceBefore: 5000, balanceAfter: 1000 });
      expect(h.ledger.find((l) => l.id === t.pointsLedgerId)).toMatchObject({ points: -4000 });
      // Σ ledger points (EARN + REDEEM + EXPIRE + ADJUST) = the balance
      const sum = h.ledger.reduce((n, l) => n + l.points, 0);
      expect(sum).toBe(h.wallets[0].redeemablePoints);
    });

    it('fix round 4 item 1: a position WITHOUT lotId still finds its own lot via its credit row — expired points counted, nothing taken twice', async () => {
      const h = harness({ mode: 'V2' });
      await credit(h, 'cp1', 'O1', 10000);
      const pos = h.positions[0];
      const lot = h.ledger.find((l) => l.id === pos.lotId)!;
      lot.expiresAt = later(-10);
      await h.service.expireDuePoints({ now: NOW }); // all 10,000 expired
      lot.expiresAt = null;
      await credit(h, 'cp1', 'O2', 5000, 'B2');
      pos.lotId = null; // a backfilled position without its lot link — the credit row still carries pointsLedgerId
      const res = await reverse(h, 10000, 'REV');
      expect(res).toMatchObject({ alreadyExpired: 10000, recovered: 0, owed: 0 });
      expect(h.wallets[0].redeemablePoints).toBe(5000); // Y's points untouched
      expect(h.auditLogs).toEqual([]);
    });

    it('fix round 4 item 1: credit whose own lot cannot be found at all — flagged LOUDLY whenever points are taken or owed (not only owed)', async () => {
      const h = harness({ mode: 'V2' });
      await credit(h, 'cp1', 'O1', 1000);
      await credit(h, 'cp1', 'O2', 5000, 'B2');
      h.positions[0].lotId = null;
      h.walletTxns.find((t) => t.id === h.positions[0].creditTxId)!.pointsLedgerId = null; // no link at all
      await h.models.$transaction((tx: any) =>
        h.service.applyCreditReversal(tx, {
          batchId: 'B1', outletCode: 'O1', fieldId: 'F1', creditReversalId: 'RT', points: 1000, clientId: 'bajaj',
        }),
      );
      expect(h.auditLogs).toEqual([
        expect.objectContaining({
          entityType: 'REVERSAL_EXPIRY_UNTRACKED', entityId: 'RT',
          metadata: expect.objectContaining({ clientId: 'bajaj', recovered: 1000, owed: 0 }),
        }),
      ]);
    });

    it('round 5 A1: ONE audit row per reversal even when it touches two unlinked positions; a lot of ANOTHER wallet is not "known"', async () => {
      const h = harness({ mode: 'V2' });
      await h.service.creditEarn('cp1', 'bajaj', 300, { referenceType: 'CREDIT_BATCH', referenceId: 'B1', metadata: { fieldId: 'F1', outletCode: 'O1' } });
      await h.service.creditEarn('cp1', 'bajaj', 200, { referenceType: 'CREDIT_BATCH', referenceId: 'B1', metadata: { fieldId: 'F1', outletCode: 'O1' } });
      expect(h.positions).toHaveLength(2);
      for (const p of h.positions) {
        // the link points at a lot that is not a credit lot of THIS wallet → expiry history unknown
        const lot = h.ledger.find((l) => l.id === p.lotId)!;
        lot.walletId = 'some-other-wallet';
      }
      await h.models.$transaction((tx: any) =>
        h.service.applyCreditReversal(tx, {
          batchId: 'B1', outletCode: 'O1', fieldId: 'F1', creditReversalId: 'R2P', points: 500, clientId: 'bajaj',
        }),
      );
      const rows = h.auditLogs.filter((x) => x.entityType === 'REVERSAL_EXPIRY_UNTRACKED');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entityId: 'R2P', metadata: expect.objectContaining({ recovered: 500, owed: 0 }) });
      expect((rows[0].metadata as { positions: unknown[] }).positions).toHaveLength(2);
    });

    it('fix round 3: debt booked on a credit with NO lot link (expiry history unknown) is never silent — audit row for the banner', async () => {
      const h = harness({ mode: 'V2' });
      await credit(h, 'cp1', 'O1', 1000);
      await h.service.debitRedeem('cp1', 600, {});
      h.positions[0].lotId = null; // a backfilled credit without its lot
      h.walletTxns.find((t) => t.id === h.positions[0].creditTxId)!.pointsLedgerId = null; // …and no link on its credit row
      await h.models.$transaction((tx: any) =>
        h.service.applyCreditReversal(tx, {
          batchId: 'B1', outletCode: 'O1', fieldId: 'F1', creditReversalId: 'RU', points: 1000, clientId: 'bajaj',
        }),
      );
      expect(h.auditLogs).toEqual([
        expect.objectContaining({
          entityType: 'REVERSAL_EXPIRY_UNTRACKED', entityId: 'RU',
          metadata: expect.objectContaining({ clientId: 'bajaj', owed: 600, outletCode: 'O1' }),
        }),
      ]);
    });

    it('no redemption while in debt (redeemable < 0): refused, nothing written', async () => {
      const { h } = await overReversed();
      const rows = h.walletTxns.length;
      await expect(h.service.debitRedeem('cp1', 1, { referenceId: 'ord-2' })).rejects.toBeInstanceOf(BadRequestException);
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: -2986, debtPoints: 2986, movementSeq: 3 });
      expect(h.walletTxns).toHaveLength(rows);
    });

    it('repaid from the next credit: +1,000 only reduces the debt (still nothing to redeem); +5,000 more clears it and leaves 3,014 spendable', async () => {
      const { h } = await overReversed();
      await credit(h, 'cp1', 'O2', 1000, 'B2');
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: -1986, debtPoints: 1986 });
      const p2 = h.positions.find((p) => p.batchId === 'B2')!;
      expect(p2).toMatchObject({ amount: 1000, offsetPoints: 1000 }); // the whole credit repaid debt
      expect(h.ledger.find((l) => l.id === p2.lotId)!.remainingPoints).toBe(0);
      await expect(h.service.debitRedeem('cp1', 1, {})).rejects.toBeInstanceOf(BadRequestException);

      await credit(h, 'cp1', 'O3', 5000, 'B3');
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: 3014, debtPoints: 0 });
      const p3 = h.positions.find((p) => p.batchId === 'B3')!;
      expect(p3).toMatchObject({ amount: 5000, offsetPoints: 1986 });
      expect(h.ledger.find((l) => l.id === p3.lotId)!.remainingPoints).toBe(3014);
      await h.service.debitRedeem('cp1', 3014, { referenceId: 'ord-3' });
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: 0, debtPoints: 0 });
      // reversing the repaying credit puts the debt it paid off back (R1) — never below the debt
      await reverse(h, 5000, 'REV3', 'O3', 'B3');
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: -5000, debtPoints: 5000 });
      expect(h.allocations.find((a) => a.creditReversalId === 'REV3')).toMatchObject({
        requested: 5000, debtRestored: 1986, recovered: 0, owed: 3014, overReversalDebt: true, shortfall: 0,
      });
    });

    describe('owner decision 2026-11-19 — expired points are not recovered twice (the reversed credit\'s own expired points)', () => {
      const expireLotOf = async (h: H, batch: string) => {
        const pos = h.positions.find((p) => p.batchId === batch)!;
        const lot = h.ledger.find((l) => l.id === pos.lotId)!;
        lot.expiresAt = later(-10);
        await h.service.expireDuePoints({ now: NOW });
        lot.expiresAt = null;
      };

      it('auditor example: X 10,000 fully expired, Y 5,000; reverse X 10,000 → nothing taken from Y, no debt', async () => {
        const h = harness({ mode: 'V2' });
        await credit(h, 'cp1', 'O1', 10000);
        await expireLotOf(h, 'B1');
        await credit(h, 'cp1', 'O2', 5000, 'B2');
        expect(h.wallets[0]).toMatchObject({ redeemablePoints: 5000, debtPoints: 0, expiredPoints: 10000 });
        const res = await reverse(h, 10000, 'REV');
        expect(res).toMatchObject({ alreadyExpired: 10000, recovered: 0, owed: 0, debtRestored: 0, shortfall: 0 });
        expect(h.wallets[0]).toMatchObject({ redeemablePoints: 5000, debtPoints: 0 });
        const yLot = h.ledger.find((l) => l.id === h.positions.find((p) => p.batchId === 'B2')!.lotId)!;
        expect(yLot.remainingPoints).toBe(5000);
        expect(h.allocations[0]).toMatchObject({ requested: 10000, alreadyExpired: 10000, recovered: 0, owed: 0, overReversalDebt: false, shortfall: 0 });
        // A6 (fix round 3): nothing moved → NO wallet row (no "−10,000" line that changes nothing, no seq)
        expect(h.walletTxns.some((t) => t.referenceType === 'CREDIT_REVERSAL')).toBe(false);
        expect(res.transactionIds).toEqual([]);
        // never counted twice: the credit is fully reversed now
        await expect(reverse(h, 1, 'REV2')).rejects.toBeInstanceOf(BadRequestException);
      });

      it('partly expired: X 10,000 (4,000 redeemed, 6,000 expired), Y 5,000; reverse X → 6,000 already expired, 4,000 taken, no debt', async () => {
        const h = harness({ mode: 'V2' });
        await credit(h, 'cp1', 'O1', 10000);
        await h.service.debitRedeem('cp1', 4000, {});
        await expireLotOf(h, 'B1');
        await credit(h, 'cp1', 'O2', 5000, 'B2');
        const res = await reverse(h, 10000, 'REV');
        expect(res).toMatchObject({ alreadyExpired: 6000, recovered: 4000, owed: 0 });
        expect(h.wallets[0]).toMatchObject({ redeemablePoints: 1000, debtPoints: 0 });
      });

      it('partly expired AND partly spent beyond holdings: X 10,000 (7,000 redeemed, 3,000 expired), Y 2,000 → 3,000 expired, 2,000 taken, 5,000 debt', async () => {
        const h = harness({ mode: 'V2' });
        await credit(h, 'cp1', 'O1', 10000);
        await h.service.debitRedeem('cp1', 7000, {});
        await expireLotOf(h, 'B1');
        await credit(h, 'cp1', 'O2', 2000, 'B2');
        const res = await reverse(h, 10000, 'REV');
        expect(res).toMatchObject({ alreadyExpired: 3000, recovered: 2000, owed: 5000 });
        expect(h.wallets[0]).toMatchObject({ redeemablePoints: -5000, debtPoints: 5000 });
        expect(h.allocations[0]).toMatchObject({ alreadyExpired: 3000, recovered: 2000, owed: 5000, overReversalDebt: true, shortfall: 0 });
      });

      it('LEGACY is unchanged: the same expired credit reversed on LEGACY takes from the other credit (floor 0)', async () => {
        const h = harness({ outlets: [{ clientId: 'bajaj', outletCode: 'O1', partnerId: 'cp1' }] });
        await credit(h, 'cp1', 'O1', 1000);
        const lot = h.ledger.find((l) => l.transactionType === 'EARN')!;
        lot.expiresAt = later(-10);
        await h.service.expireDuePoints({ now: NOW });
        await credit(h, 'cp1', 'O2', 500, 'B2');
        const res = await h.models.$transaction((tx: any) =>
          h.service.reverseCreditBatchPoints(tx, { clientId: 'bajaj', batchId: 'B1', outletCode: 'O1', fieldId: 'F1', creditReversalId: 'RL', points: 1000 }),
        );
        expect(res).toMatchObject({ mode: 'LEGACY', alreadyExpired: 0, recovered: 500, shortfall: 500 });
        expect(h.wallets[0].redeemablePoints).toBe(0);
      });
    });

    it('expiry while in debt: nothing can expire from a wallet holding 0 (a stray lot is clamped to H = 0) — balance and debt unchanged', async () => {
      const { h } = await overReversed();
      // a lot the mirror still shows (legacy-era drift) falls due
      h.ledger.push({
        id: 'stray', walletId: 'w1', transactionType: 'EARN', points: 500, remainingPoints: 500, isExpired: false,
        expiresAt: later(-10), createdAt: later(-9000),
      });
      const r = await h.service.expireDuePoints({ now: NOW });
      expect(r.expiredPoints).toBe(0);
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: -2986, debtPoints: 2986, expiredPoints: 0 });
      expect(h.walletTxns.some((t) => t.transactionType === 'DEBIT_EXPIRY')).toBe(false);
    });
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
    // LEGACY is unchanged by owner 2026-11-19: floor 0, the 400 already redeemed are written off (never debt)
    expect(res).toEqual({ mode: 'LEGACY', shortfall: 400, recovered: 100, debtRestored: 0, owed: 0, alreadyExpired: 0, debtExposed: 0, balanceBelowZero: 0, walletIds: ['w1'] });
    expect(h.settings.modeReads).toBe(1);
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 0, debtPoints: 0, movementSeq: 4 });
    expect(h.positions[0].reversedPoints).toBe(500);
    expect(h.allocations[0]).toMatchObject({ requested: 500, debtRestored: 0, recovered: 100, shortfall: 400 });
    expect(h.allocations[0].owed ?? 0).toBe(0);
    expect(h.allocations[0].overReversalDebt ?? false).toBe(false);
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

  it('SHADOW: an un-backfilled wallet (history, movementSeq 0) → LEGACY applies (today\'s rules); the v2 refusal names the wallet problem', async () => {
    const h = harness({
      outlets: linked,
      mode: 'SHADOW',
      wallets: [blankWallet('w1', 'cp1', { redeemablePoints: 500, earnedPoints: 500, lifetimeEarned: 500 })],
    });
    h.walletTxns.push({
      id: 'old', walletId: 'w1', transactionType: 'CREDIT_POINTS_EARNED', referenceType: 'CREDIT_BATCH', referenceId: 'B1',
      points: 500, balanceBefore: 0, balanceAfter: 500, metadata: { fieldId: 'F1', outletCode: 'O1' }, createdAt: later(-9000),
    });
    await dispatch(h, 200);
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 300, movementSeq: 0 });
    expect(h.auditLogs[0].metadata).toMatchObject({
      differs: true,
      v2: { refused: expect.stringMatching(/^Can't reverse: the wallet that received this credit for outlet O1 needs Gifsy attention \(not yet prepared by the wallet backfill\)/) },
    });
  });

  it('WP7 pool fix: the dispatcher reads the flag through the caller\'s tx when the caller did not pass it', async () => {
    const h = harness({ outlets: linked, mode: 'LEGACY' });
    await credit(h, 100);
    h.settings.modeDbs.length = 0;
    await h.service.reverseCreditBatchPoints(h.models as any, {
      batchId: 'B1', outletCode: 'O1', fieldId: 'F1', clientId: 'bajaj', creditReversalId: 'R1', points: 10,
    });
    expect(h.settings.modeDbs[0]).toBe(h.models);
  });

  it('SHADOW on a SEQUENCED wallet whose credit is UNRESOLVED: LEGACY no longer passes silently — refused CREDIT_UNMAPPED (fix round A, M3); nothing written', async () => {
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
    // Before fix round A the LEGACY clawback ran (B 500 → 300) and the positions were left untouched (log-only), so a
    // later V2 reversal could have taken the same credit back again.
    const err = await dispatch(h, 200).catch((e) => e);
    expect(err).toBeInstanceOf(ReversalAttentionException);
    expect(err).toMatchObject({ code: 'CREDIT_UNMAPPED', detail: expect.objectContaining({ engine: 'LEGACY', walletId: 'w1' }) });
    expect(err.message).toBe("Can't reverse: the original credit for outlet O1 in this batch couldn't be identified — Gifsy must map it first.");
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 500, movementSeq: 1 });
    expect(h.walletTxns).toHaveLength(1);
  });

  it('V2: the position engine runs (debt wallet R1: −841 +500 → reverse → −841); LEGACY helpers are not consulted', async () => {
    const h = harness({ wallets: [openWallet(-841)], outlets: [], mode: 'V2' });
    await credit(h, 500);
    const res = await dispatch(h, 500);
    expect(res).toEqual({ mode: 'V2', shortfall: 0, recovered: 0, debtRestored: 500, owed: 0, alreadyExpired: 0, debtExposed: 0, balanceBelowZero: 500, walletIds: ['w1'] });
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: -841, debtPoints: 841 });
  });

  it('SHADOW over-reversal: LEGACY applies (floor 0, written off); the v2 diff records the debt V2 would book', async () => {
    const h = harness({ outlets: linked, mode: 'SHADOW' });
    await credit(h, 500);
    await h.service.debitRedeem('cp1', 400, {});
    const res = await dispatch(h, 500);
    expect(res).toEqual({ mode: 'SHADOW', shortfall: 400, recovered: 100, debtRestored: 0, owed: 0, alreadyExpired: 0, debtExposed: 0, balanceBelowZero: 0, walletIds: ['w1'] });
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 0, debtPoints: 0 });
    expect(h.auditLogs[0].metadata).toMatchObject({
      differs: true,
      legacy: expect.objectContaining({ removed: 100, shortfall: 400 }),
      v2: expect.objectContaining({ removed: 500, owed: 400, shortfall: 0, debtExposed: 0, belowZero: 400 }),
    });
    // round 5 A1: the diff says whether V2 could count the credit's expired points
    expect((h.auditLogs[0].metadata as { v2: { steps: Array<{ expiryKnown: boolean }> } }).v2.steps[0].expiryKnown).toBe(true);
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
    // owner 2026-11-19: what the wallet no longer holds is owed (debt), never written off
    expect(steps.map((s) => [s.debtRestored, s.recovered, s.owed, s.shortfall, s.after.seq])).toEqual([
      [60, 30, 10, 0, 8],
      [0, 0, 50, 0, 9],
    ]);
    expect(steps.map((s) => s.after)).toEqual([
      { B: -70, D: 70, seq: 8 },
      { B: -120, D: 120, seq: 9 },
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

// ───────────────────────── policy round A: v2 refusals name the reason (Q1 / Q3) ─────────────────────────

describe('policy round A — v2PointsReversalCap refusals (owner 2026-11-16)', () => {
  const key = { batchId: 'B1', outletCode: 'O1', fieldId: 'F1' };
  const tracked = (extra: Row = {}) => blankWallet('w1', 'cp1', { redeemablePoints: 300, movementSeq: 1, ...extra });
  const pos = (id: string, extra: Row) => ({
    id, walletId: 'w1', creditTxId: `t-${id}`, lotId: null, batchId: 'B1', amount: 300, offsetPoints: 0, reversedPoints: 0,
    attribution: 'EXACT', outletCode: 'O1', fieldId: 'F1', ...extra,
  });
  const err = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      return e as ReversalAttentionException;
    }
  };

  it('Q3: an UNRESOLVED credit of ANOTHER outlet line does not block this one (narrowed from whole-batch)', async () => {
    const h = harness({ wallets: [tracked()], mode: 'V2' });
    h.positions.push(pos('p1', {}), pos('u-other', { attribution: 'UNRESOLVED', outletCode: 'O2', fieldId: 'F1', amount: 50 }));
    const r = await h.service.v2PointsReversalCap(h.models as any, key);
    expect(r.cap).toBe(300);
    expect(r.positions.map((p) => p.id)).toEqual(['p1']);
  });

  it('Q3: an UNRESOLVED credit that COULD be this line\'s → refused with the owner\'s wording, only for this line', async () => {
    const h = harness({ wallets: [tracked()], mode: 'V2' });
    h.positions.push(pos('u1', { attribution: 'UNRESOLVED', outletCode: null, fieldId: null, amount: 300 }));
    h.batches.push({ id: 'B1', rows: [{ outletId: 'O1', fieldId: 'F1', amount: 300, awardType: 'POINTS', status: 'OK' }, { outletId: 'O2', fieldId: 'F1', amount: 80, awardType: 'POINTS', status: 'OK' }] });
    const e = await err(h.service.v2PointsReversalCap(h.models as any, key));
    expect(e).toBeInstanceOf(ReversalAttentionException);
    expect(e!.code).toBe('CREDIT_UNMAPPED');
    expect(e!.message).toBe("Can't reverse: the original credit for outlet O1 in this batch couldn't be identified — Gifsy must map it first.");
    expect(e!.getStatus()).toBe(409);
    // the batch's OTHER outlet line (fully identified by its resolved position) stays reversible
    h.positions.push(pos('p2', { outletCode: 'O2', amount: 80 }));
    await expect(h.service.v2PointsReversalCap(h.models as any, { ...key, outletCode: 'O2' })).resolves.toMatchObject({ cap: 80 });
  });

  it('Q3: an UNRESOLVED position carrying EXACTLY this key (backfill downgrade) is never drawn on and always blocks', async () => {
    const h = harness({ wallets: [tracked()], mode: 'V2' });
    h.positions.push(pos('p1', {}), pos('u1', { attribution: 'UNRESOLVED', amount: 100 }));
    const e = await err(h.service.v2PointsReversalCap(h.models as any, key));
    expect(e!.code).toBe('CREDIT_UNMAPPED');
  });

  it('Q1: no position because the receiving wallet is BLOCKED → refused naming the wallet\'s reason and what to do', async () => {
    const h = harness({ wallets: [blankWallet('w1', 'cp1', { redeemablePoints: 300, backfillStatus: 'BLOCKED', backfillBlockedReason: 'CHAIN_BROKEN: no row continues' })], mode: 'V2' });
    h.walletTxns.push({ id: 'c', walletId: 'w1', transactionType: 'CREDIT_POINTS_EARNED', referenceType: 'CREDIT_BATCH', referenceId: 'B1', points: 300, metadata: { fieldId: 'F1', outletCode: 'O1' }, createdAt: later(-1) });
    const e = await err(h.service.v2PointsReversalCap(h.models as any, key));
    expect(e!.code).toBe('WALLET_NEEDS_ATTENTION');
    expect(e!.message).toMatch(/^Can't reverse: the wallet that received this credit for outlet O1 needs Gifsy attention \(CHAIN_BROKEN: no row continues\)\. Gifsy must fix that wallet's points history and re-run the wallet backfill — earning and redeeming on it keep working meanwhile\.$/);
    expect(e!.detail).toMatchObject({ walletId: 'w1', backfillStatus: 'BLOCKED' });
  });

  it('a pre-engine credit with no per-credit metadata and no position → CREDIT_UNMAPPED; nothing credited → 400 settle off-platform', async () => {
    const h = harness({ wallets: [tracked()], mode: 'V2' });
    h.walletTxns.push({ id: 'c', walletId: 'w1', transactionType: 'CREDIT_POINTS_EARNED', referenceType: 'CREDIT_BATCH', referenceId: 'B1', points: 300, metadata: null, createdAt: later(-1) });
    expect((await err(h.service.v2PointsReversalCap(h.models as any, key)))!.code).toBe('CREDIT_UNMAPPED');
    const none = harness({ wallets: [tracked()], mode: 'V2' });
    const e = await err(none.service.v2PointsReversalCap(none.models as any, key));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e!.message).toMatch(/settle it off-platform/);
  });
});

// ───────────────────────── fix round A (money audit, 2026-11-16) ─────────────────────────

describe('fix round A — M1 (malformed flag never stops points activity; expiry failures isolated + reported)', () => {
  it('a malformed reversalEngine value: movements run on LEGACY rules (pristine wallet too), logged — never refused', async () => {
    const h = harness({ mode: 'v2' as unknown as ReversalEngineMode });
    const warn = jest.spyOn((h.service as any).logger, 'warn').mockImplementation(() => undefined);
    await h.service.creditEarn('cp1', 'bajaj', 50, { referenceType: 'CREDIT_BATCH', referenceId: 'B1', metadata: { fieldId: 'F1', outletCode: 'O1' } });
    await h.service.debitRedeem('cp1', 20, {});
    expect(h.wallets[0]).toMatchObject({ redeemablePoints: 30, movementSeq: 0 });
    expect(h.walletTxns.every((t) => t.seq === undefined)).toBe(true);
    expect(h.positions).toHaveLength(0);
    expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringMatching(/reversalEngine setting is invalid: "v2" — treated as LEGACY; fix in settings/),
    );
    // movementEngineMode reports it to callers that want to say so (attention banner / confirm)
    await expect(h.service.movementEngineMode('bajaj')).resolves.toEqual({ mode: 'LEGACY', invalid: 'v2' });
  });

  it('expiry sweep: one lot failing never stops the others (any tenant); counted, listed, audited, retried next sweep', async () => {
    const h = harness({
      wallets: [
        blankWallet('w1', 'cp1', { redeemablePoints: 100, earnedPoints: 100, lifetimeEarned: 100, partner: { clientId: 'bajaj' } }),
        blankWallet('w2', 'cp2', { redeemablePoints: 70, earnedPoints: 70, lifetimeEarned: 70, partner: { clientId: 'deoleo' } }),
      ],
    });
    h.ledger.push(
      { id: 'L1', walletId: 'w1', transactionType: 'EARN', points: 100, remainingPoints: 100, isExpired: false, expiresAt: later(-20), createdAt: later(-9000) },
      { id: 'L2', walletId: 'w2', transactionType: 'EARN', points: 70, remainingPoints: 70, isExpired: false, expiresAt: later(-10), createdAt: later(-9000) },
    );
    const realClaim = h.models.pointsLedger.updateMany;
    h.models.pointsLedger.updateMany = async (a: any) => {
      if (a.where?.id === 'L1' && a.data?.isExpired === true) throw new Error('boom: deadlock detected');
      return realClaim(a);
    };
    const err = jest.spyOn((h.service as any).logger, 'error').mockImplementation(() => undefined);
    const res = await h.service.expireDuePoints({ now: NOW });
    expect(res).toEqual({
      expiredLots: 1,
      expiredPoints: 70,
      failedLots: 1,
      failures: [{ lotId: 'L1', walletId: 'w1', clientId: 'bajaj', error: 'boom: deadlock detected' }],
    });
    expect(h.wallets.find((w) => w.id === 'w2')!.redeemablePoints).toBe(0); // the other tenant's lot still expired
    expect(h.ledger.find((l) => l.id === 'L1')!.isExpired).toBe(false); // still due → next sweep retries it
    expect(h.auditLogs).toEqual([
      expect.objectContaining({
        entityType: POINTS_EXPIRY_FAILURE_ENTITY, entityId: 'bajaj', actorId: null,
        metadata: expect.objectContaining({ lotId: 'L1', walletId: 'w1', error: 'boom: deadlock detected' }),
      }),
    ]);
    expect(err).toHaveBeenCalled();
  });
});

describe('fix round A — L1 (expiry that only repays debt leaves a trace)', () => {
  it('e = 0, x > 0: audit row with the debt repaid; still no zero-points passbook row and no seq consumed', async () => {
    const d = await drive(-100, [cr('X', 300), sp(150), rv('X', 100), ex('X')]);
    expect(d.h.wallets[0]).toMatchObject({ redeemablePoints: -50, debtPoints: 50 });
    expect(d.h.walletTxns.some((t) => t.transactionType === 'DEBIT_EXPIRY')).toBe(false);
    const trace = d.h.auditLogs.filter((a) => a.entityType === POINTS_EXPIRY_DEBT_ONLY_ENTITY);
    expect(trace).toEqual([
      expect.objectContaining({
        entityId: 'w1',
        metadata: expect.objectContaining({ expiredFromBalance: 0, debtRepaid: 50, debtBefore: 100, debtAfter: 50, lotRemaining: 50 }),
      }),
    ]);
    const seqs = d.h.walletTxns.filter((t) => t.seq != null).map((t) => t.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(d.h.wallets[0].movementSeq).toBe(Math.max(...seqs));
  });
});

describe('fix round A — L2 (positions ordered by seq, createdAt fallback)', () => {
  const pos = (id: string, walletId: string, seq: number | null, t: number): ReversalPositionRow => ({
    id, walletId, creditTxId: `c-${id}`, lotId: null, amount: 10, offsetPoints: 0, reversedPoints: 0,
    creditTx: { seq, createdAt: later(t) },
  });
  it('same wallet: seq wins over createdAt; mixed / other wallet / no seq: createdAt, then id', () => {
    // same wallet, clock skew made the later movement's stamp earlier — seq is the truth
    expect([pos('b', 'w1', 2, 1), pos('a', 'w1', 1, 5)].sort(byCreditOrder).map((p) => p.id)).toEqual(['a', 'b']);
    // different wallets: per-wallet seq is not comparable → createdAt
    expect([pos('b', 'w2', 1, 9), pos('a', 'w1', 7, 3)].sort(byCreditOrder).map((p) => p.id)).toEqual(['a', 'b']);
    // missing seq → createdAt, tie → id
    expect([pos('z', 'w1', null, 4), pos('y', 'w1', 3, 4), pos('x', 'w1', null, 2)].sort(byCreditOrder).map((p) => p.id)).toEqual(['x', 'y', 'z']);
  });
});

describe('fix round A — L5 (un-sequenced LEGACY wallet: today path, no lock / partner / flag read)', () => {
  const withHistory = () => blankWallet('w1', 'cp1', { redeemablePoints: 100, earnedPoints: 100, lifetimeEarned: 100 });

  it('a wallet with history: no FOR UPDATE, no partner read, no flag read — whatever the tenant flag', async () => {
    for (const mode of ['LEGACY', 'SHADOW', 'V2'] as const) {
      const h = harness({ wallets: [withHistory()], mode });
      const partner = jest.spyOn(h.models.channelPartner, 'findFirst');
      await h.service.creditEarn('cp1', 'bajaj', 50, { referenceType: 'CREDIT_BATCH', referenceId: 'B1', metadata: { fieldId: 'F1', outletCode: 'O1' } });
      await h.service.debitRedeem('cp1', 30, {});
      expect(h.models.$queryRaw).not.toHaveBeenCalled();
      expect(partner).not.toHaveBeenCalled();
      expect(h.settings.modeReads).toBe(0);
      expect(h.wallets[0]).toMatchObject({ redeemablePoints: 120, movementSeq: 0 });
      expect(h.walletTxns.every((t) => t.seq === undefined)).toBe(true);
    }
  });

  it('race: the wallet was sequenced (backfill APPLY) after the caller read it → guarded UPDATE matches nothing, nothing written, the locked V2 path runs (never a mixed history)', async () => {
    for (const op of ['credit', 'redeem'] as const) {
      const h = harness({ wallets: [blankWallet('w1', 'cp1', { redeemablePoints: 100, earnedPoints: 100, lifetimeEarned: 100, movementSeq: 1 })] });
      h.walletTxns.push({ id: 'old', walletId: 'w1', points: 100, seq: 1, pointsDelta: 100, balanceBefore: 0, balanceAfter: 100, createdAt: later(-5000) });
      const real = h.models.wallet.findFirst;
      let stale = true; // the caller's (pre-backfill) read
      h.models.wallet.findFirst = async (a: any) => {
        const r = await real(a);
        if (stale && r) {
          stale = false;
          return { ...r, movementSeq: 0 };
        }
        return r;
      };
      if (op === 'credit') await h.service.creditEarn('cp1', 'bajaj', 50, {});
      else await h.service.debitRedeem('cp1', 40, {});
      const last = h.walletTxns[h.walletTxns.length - 1];
      expect(h.walletTxns).toHaveLength(2);
      expect(last).toMatchObject({ seq: 2, pointsDelta: op === 'credit' ? 50 : -40 });
      expect(h.wallets[0]).toMatchObject({ movementSeq: 2, redeemablePoints: op === 'credit' ? 150 : 60 });
      expect(h.models.$queryRaw).toHaveBeenCalled(); // the locked path
    }
  });

  it('a guarded debit that is simply insufficient still says so (the guard does not mask it)', async () => {
    const h = harness({ wallets: [withHistory()] });
    // the pre-check passes on a stale read; the guarded UPDATE then finds the balance gone
    const real = h.models.wallet.findFirst;
    h.models.wallet.findFirst = async (a: any) => {
      const r = await real(a);
      return r && !a?.select ? { ...r, redeemablePoints: 1000 } : r;
    };
    await expect(h.service.debitRedeem('cp1', 500, {})).rejects.toThrow('Insufficient wallet balance for redemption');
    expect(h.walletTxns).toHaveLength(0);
  });
});

describe('fix round A — M3 (LEGACY clawback on a sequenced wallet must land on a position; V2 caps count un-allocated approvals)', () => {
  const linked = [{ clientId: 'bajaj', outletCode: 'O1', partnerId: 'cp1' }];
  const dispatch = (h: H, points: number, id = 'R1') =>
    h.models.$transaction((tx: any) =>
      h.service.reverseCreditBatchPoints(tx, {
        clientId: 'bajaj', batchId: 'B1', outletCode: 'O1', fieldId: 'F1', creditReversalId: id, points, actorId: 'u1',
      }),
    );
  const credit = (h: H, amt: number) =>
    h.service.creditEarn('cp1', 'bajaj', amt, { referenceType: 'CREDIT_BATCH', referenceId: 'B1', metadata: { fieldId: 'F1', outletCode: 'O1' } });

  it('LEGACY, sequenced wallet, clawback larger than the positions reversible room → 409 CREDIT_UNMAPPED before any write', async () => {
    const h = harness({ outlets: linked, wallets: [blankWallet('w1', 'cp1', { movementSeq: 1 })] });
    await credit(h, 300);
    h.positions[0].reversedPoints = 250; // e.g. an earlier reversal took most of it
    const before = JSON.stringify(h.wallets[0]);
    const e = await dispatch(h, 100).catch((x) => x);
    expect(e).toBeInstanceOf(ReversalAttentionException);
    expect(e).toMatchObject({ code: 'CREDIT_UNMAPPED', detail: expect.objectContaining({ coverable: 50, requested: 100, engine: 'LEGACY' }) });
    expect(JSON.stringify(h.wallets[0])).toBe(before);
    expect(h.allocations).toHaveLength(0);
  });

  it('LEGACY, sequenced wallet whose credit has NO position (credited before tracking, not attributed) → refused at the gate and at clawback', async () => {
    const h = harness({ outlets: linked, wallets: [blankWallet('w1', 'cp1', { redeemablePoints: 300, earnedPoints: 300, lifetimeEarned: 300, movementSeq: 1 })] });
    h.walletTxns.push({
      id: 'old', walletId: 'w1', transactionType: 'CREDIT_POINTS_EARNED', referenceType: 'CREDIT_BATCH', referenceId: 'B1',
      points: 300, balanceBefore: 0, balanceAfter: 300, seq: 1, pointsDelta: 300, metadata: { fieldId: 'F1', outletCode: 'O1' }, createdAt: later(-9000),
    });
    const gate = await h.service
      .assertPointsReversalAllowed(h.models as any, { clientId: 'bajaj', batchId: 'B1', outletCode: 'O1', fieldId: 'F1' })
      .catch((x) => x);
    expect(gate).toMatchObject({ code: 'CREDIT_UNMAPPED', detail: expect.objectContaining({ reason: 'sequenced wallet: no credit position records this credit' }) });
    const cb = await h.models
      .$transaction((tx: any) =>
        h.service.clawbackAward('cp1', 100, { referenceType: 'CREDIT_REVERSAL', referenceId: 'R1', originalCredit: { batchId: 'B1', outletCode: 'O1', fieldId: 'F1' } }, tx),
      )
      .catch((x: unknown) => x);
    expect(cb).toMatchObject({ code: 'CREDIT_UNMAPPED' });
    expect(h.wallets[0].redeemablePoints).toBe(300);
  });

  it('V2 cap: an APPROVED reversal of the line with no allocation row counts against the credit (double clawback impossible); the reversal being applied is not counted twice', async () => {
    const h = harness({ outlets: linked, mode: 'V2' });
    await credit(h, 300);
    const key = { batchId: 'B1', outletCode: 'O1', fieldId: 'F1' };
    // a clawback approved earlier whose amount never reached the position (old log-only path / un-attributed legacy)
    h.reversals.push({ id: 'R0', batchId: 'B1', outletId: 'O1', fieldId: 'F1', awardType: 'POINTS', status: 'APPROVED', approvedPaise: 200n });
    await expect(h.service.v2PointsReversalCap(h.models as any, key)).resolves.toMatchObject({ cap: 100, unallocatedApproved: 200 });
    await expect(dispatch(h, 150, 'R1')).rejects.toThrow(/reversible 100 pts after 200 pts of earlier approved reversals/);
    expect(h.wallets[0].redeemablePoints).toBe(300);
    // R1 itself is already APPROVED (flipped by the caller) without allocations yet — excluded from "others"
    h.reversals.push({ id: 'R1', batchId: 'B1', outletId: 'O1', fieldId: 'F1', awardType: 'POINTS', status: 'APPROVED', approvedPaise: 100n });
    await expect(dispatch(h, 100, 'R1')).resolves.toMatchObject({ mode: 'V2', shortfall: 0 });
    expect(h.wallets[0].redeemablePoints).toBe(200);
    // once R1 has its allocation it is reflected in ρ, so the cap is now 0 (300 − ρ 100 − R0's 200)
    await expect(h.service.v2PointsReversalCap(h.models as any, key)).resolves.toMatchObject({ cap: 0 });
  });
});
