// Wallet Reversal Engine — WP4: credit-batch POINTS reversals (create / approve) routed by the tenant's engine
// mode (LEGACY default / SHADOW / V2), and the confirmBatch flag read hoisted to once per batch.
// Source of truth: platform/docs/plans/WALLET-REVERSAL-ENGINE-DESIGN.md §6, §9 step 5, §12 (Q1–Q14), §15.
//
// Drives the REAL CreditsService + REAL WalletService + REAL TenantSettingsService.getReversalEngineModeUncached
// against an in-memory emulation of the tables they touch, and compares the persisted result with:
//   - the WP0 oracle (reversal-model.ts) for V2 — every approval order;
//   - a GOLDEN snapshot of the pre-WP4 code (generated on 1aa5084e, see __fixtures__/README note in the fixture)
//     for LEGACY — proving LEGACY is byte-identical (same rows, same balances, same messages).
// Dates: a fixed NOW with offsets; real-time stamps are normalised in snapshots (WAYS #10).

import * as fs from 'fs';
import * as path from 'path';
import { CreditsService } from './credits.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService, ReversalEngineMode } from '../tenant/tenant-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { CreditAwardType } from '@prisma/client';
import { ReversalAction } from './dto/credits.dto';
import { checkInvariants, ModelEvent, Movement, run } from '../wallet/reversal-model';

jest.mock('../common/reward-account.helper', () => ({
  ensureOutletAccount: jest.fn().mockResolvedValue('acc-x'),
}));

const NOW = new Date('2026-06-01T00:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);
const TENANT = 'bajaj';

type Row = Record<string, any>;
const num = (x: any) => (x instanceof Date ? x.getTime() : x);

function matchWhere(row: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue;
    if (v === null) {
      if (row[k] !== null && row[k] !== undefined) return false;
      continue;
    }
    if (typeof v === 'object' && !(v instanceof Date)) {
      const ranged = 'gt' in v || 'gte' in v || 'lt' in v || 'lte' in v;
      if (ranged && (row[k] === null || row[k] === undefined)) return false;
      if ('in' in v) { if (!(v as any).in.includes(row[k])) return false; }
      else if ('gt' in v) { if (!(num(row[k]) > num((v as any).gt))) return false; }
      else if ('gte' in v) { if (!(num(row[k]) >= num((v as any).gte))) return false; }
      else if ('lt' in v) { if (!(num(row[k]) < num((v as any).lt))) return false; }
      else if ('lte' in v) { if (!(num(row[k]) <= num((v as any).lte))) return false; }
      else if ('not' in v) { if (row[k] === (v as any).not) return false; }
    } else if (row[k] !== v) return false;
  }
  return true;
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && typeof v !== 'bigint') {
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
  id, partnerId,
  earnedPoints: 0, lockedPoints: 0, redeemablePoints: 0, redeemedPoints: 0, expiredPoints: 0,
  lifetimeEarned: 0, lifetimeRedeemed: 0, lifetimeExpired: 0, debtPoints: 0, movementSeq: 0,
  ...extra,
});

interface WorldOpts {
  mode?: ReversalEngineMode | null; // null → no program_settings row (absent → LEGACY)
  partners?: string[];
  outlets?: Record<string, string | null>; // outletCode → partnerId
  wallets?: Row[];
}

function world(opts: WorldOpts = {}) {
  let clock = 0;
  const T = {
    wallets: (opts.wallets ?? []) as Row[],
    walletTxns: [] as Row[],
    ledger: [] as Row[],
    positions: [] as Row[],
    allocations: [] as Row[],
    auditLogs: [] as Row[],
    batches: [] as Row[],
    reversals: [] as Row[],
    partners: (opts.partners ?? ['cp1', 'cp2', 'cp3']).map((id) => ({ id, clientId: TENANT })),
    outlets: Object.entries(opts.outlets ?? { O1: 'cp1' }).map(([outletCode, partnerId]) => ({
      clientId: TENANT, outletCode, partnerId,
    })) as Row[],
    settings: new Map<string, unknown>(),
  };
  if (opts.mode !== null) T.settings.set(`${TENANT}:reversalEngine`, opts.mode ?? 'LEGACY');

  // Query counter: `${model}.${method}` (and $queryRaw), split into in-transaction vs outside.
  const counts = { tx: {} as Record<string, number>, out: {} as Record<string, number> };
  let inTx = 0;
  const bump = (k: string) => {
    const bucket = inTx > 0 ? counts.tx : counts.out;
    bucket[k] = (bucket[k] ?? 0) + 1;
  };
  const positionView = (p: Row) => {
    const c = T.walletTxns.find((t) => t.id === p.creditTxId);
    return { ...p, creditTx: { seq: c?.seq ?? null, createdAt: c?.createdAt ?? NOW } };
  };
  const find = (rows: Row[]) => async ({ where, orderBy }: any = {}) => {
    const r = orderRows(rows.filter((x) => matchWhere(x, where ?? {})), orderBy)[0];
    return r ? { ...r } : null;
  };
  const findMany = (rows: Row[]) => async ({ where, orderBy, take }: any = {}) => {
    let out = orderRows(rows.filter((x) => matchWhere(x, where ?? {})), orderBy);
    if (take != null) out = out.slice(0, take);
    return out.map((x) => ({ ...x }));
  };
  const updateMany = (rows: Row[]) => async ({ where, data }: any) => {
    const hit = rows.filter((x) => matchWhere(x, where));
    hit.forEach((x) => applyData(x, data));
    return { count: hit.length };
  };
  const update = (rows: Row[], name: string) => async ({ where, data }: any) => {
    const x = rows.find((r) => matchWhere(r, where));
    if (!x) throw new Error(`${name} not found`);
    applyData(x, data);
    return { ...x };
  };

  const raw: Record<string, any> = {
    wallet: {
      findFirst: find(T.wallets),
      findUniqueOrThrow: async ({ where }: any) => {
        const w = T.wallets.find((x) => matchWhere(x, where));
        if (!w) throw new Error('wallet not found');
        return { ...w };
      },
      updateMany: updateMany(T.wallets),
      update: update(T.wallets, 'wallet'),
      upsert: async ({ where, create }: any) => {
        const w = T.wallets.find((x) => matchWhere(x, where));
        if (w) return { ...w };
        const row = blankWallet(`w-${create.partnerId}`, create.partnerId, { accountId: create.accountId });
        T.wallets.push(row);
        return { ...row };
      },
    },
    walletTransaction: {
      create: async ({ data }: any) => {
        const row = { id: `wt${++clock}`, ...data, createdAt: later(clock) };
        T.walletTxns.push(row);
        return { ...row };
      },
      findFirst: find(T.walletTxns),
      findMany: findMany(T.walletTxns),
    },
    pointsLedger: {
      create: async ({ data }: any) => {
        const row = { id: `pl${++clock}`, isExpired: false, remainingPoints: 0, ...data, createdAt: later(clock) };
        T.ledger.push(row);
        return { ...row };
      },
      findMany: findMany(T.ledger),
      findFirst: find(T.ledger),
      findUnique: find(T.ledger),
      update: update(T.ledger, 'ledger'),
      updateMany: updateMany(T.ledger),
    },
    walletCreditPosition: {
      create: async ({ data }: any) => {
        const row = { id: `pos${++clock}`, offsetPoints: 0, reversedPoints: 0, ...data };
        T.positions.push(row);
        return { ...row };
      },
      findMany: async ({ where }: any = {}) => T.positions.filter((p) => matchWhere(p, where ?? {})).map(positionView),
      findFirst: find(T.positions),
      count: async ({ where }: any = {}) => T.positions.filter((p) => matchWhere(p, where ?? {})).length,
      updateMany: updateMany(T.positions),
    },
    creditReversalAllocation: {
      create: async ({ data }: any) => {
        if (T.allocations.some((a) => a.creditReversalId === data.creditReversalId && a.positionId === data.positionId)) {
          throw new Error('unique (creditReversalId, positionId) violated');
        }
        const row = { id: `al${++clock}`, ...data };
        T.allocations.push(row);
        return { ...row };
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        T.auditLogs.push(JSON.parse(JSON.stringify(data)));
        return data;
      },
    },
    creditBatch: {
      findFirst: find(T.batches),
      updateMany: updateMany(T.batches),
    },
    creditReversal: {
      findFirst: find(T.reversals),
      findMany: findMany(T.reversals),
      create: async ({ data }: any) => {
        const row = {
          id: `rev${++clock}`, status: 'PENDING_GIFSY', approvedPaise: null, shortfallPaise: null, ...data,
        };
        T.reversals.push(row);
        return { ...row };
      },
      updateMany: updateMany(T.reversals),
      update: update(T.reversals, 'creditReversal'),
    },
    creditField: { findMany: async () => [] },
    creditPayoutEntry: { createMany: async ({ data }: any) => ({ count: data.length }) },
    outlet: { findFirst: find(T.outlets), findMany: findMany(T.outlets) },
    channelPartner: { findFirst: find(T.partners) },
    pointExpiryConfig: { findFirst: async () => null },
    programSetting: {
      findUnique: async ({ where }: any) => {
        const k = `${where.clientId_settingKey.clientId}:${where.clientId_settingKey.settingKey}`;
        return T.settings.has(k) ? { settingValue: T.settings.get(k) } : null;
      },
    },
  };
  const models: Record<string, any> = {};
  for (const [model, methods] of Object.entries(raw)) {
    models[model] = {};
    for (const [m, fn] of Object.entries(methods as Record<string, any>)) {
      models[model][m] = (...args: any[]) => {
        bump(`${model}.${m}`);
        return fn(...args);
      };
    }
  }
  models.$queryRaw = async () => {
    bump('$queryRaw');
    return [];
  };
  models.$transaction = async (cb: any) => {
    // Atomic like Postgres: on a throw, every table is restored to its pre-transaction state.
    const snap = Object.fromEntries(
      Object.entries(T).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as Row[]).map((r) => ({ ...r }))]),
    );
    inTx++;
    try {
      return await cb(models);
    } catch (e) {
      for (const [k, rows] of Object.entries(snap)) {
        const live = (T as any)[k] as Row[];
        live.splice(0, live.length, ...(rows as Row[]));
      }
      throw e;
    } finally {
      inTx--;
    }
  };

  const prisma = models as unknown as PrismaService;
  const tenantSettings = new TenantSettingsService(prisma);
  Object.assign(tenantSettings, {
    getEffectiveSettings: async () => ({
      creditsPayouts: { monthCutoffDay: 31, safetyCapPoints: 1_000_000, safetyCapInr: 10_000_000, fourEyesEnabled: false, notifyEmails: ['ops@example.test'] },
    }),
    resolveTdsPolicy: async () => ({ section: 'SEC_194C', methodology: 'GROSS_UP' }),
    getConversionRate: async () => 1,
  });
  const wallet = new WalletService(prisma, tenantSettings);
  const credits = new CreditsService(prisma, {} as any, {} as any, wallet, tenantSettings, {} as any, {} as any);
  Object.assign(credits as any, { notify: async () => undefined, notifyPointsCredited: async () => undefined });

  const admin: JwtPayload = { sub: 'client-admin', role: 'CLIENT_ADMIN', clientId: TENANT, phone: '', name: '' } as JwtPayload;
  const gifsy: JwtPayload = { sub: 'gifsy-admin', role: 'GIFSY_ADMIN', clientId: TENANT, phone: '', name: '' } as JwtPayload;

  const api = {
    T, counts, wallet, credits, models,
    resetCounts() {
      counts.tx = {};
      counts.out = {};
    },
    setMode(mode: ReversalEngineMode) {
      T.settings.set(`${TENANT}:reversalEngine`, mode);
    },
    async confirm(batchId: string, rows: { outlet: string; field?: string; amount: number }[]) {
      T.batches.push({
        id: batchId, clientId: TENANT, status: 'PENDING_CONFIRM', period: '2026-05', uploadedBy: 'client-admin',
        totalOutlets: rows.length, totalPoints: rows.reduce((s, r) => s + r.amount, 0), totalPayoutPaise: 0n,
        rows: rows.map((r) => ({
          outletId: r.outlet, outletName: `Outlet ${r.outlet}`, fieldId: r.field ?? 'F', fieldName: 'Field',
          amount: r.amount, narration: `credit ${batchId}`, awardType: 'POINTS', status: 'OK',
        })),
      });
      return credits.confirmBatch(admin, batchId);
    },
    redeem: (partnerId: string, amount: number) => wallet.debitRedeem(partnerId, amount, { referenceId: `ord-${amount}` }),
    create: (batchId: string, outlet: string, amount: number, field = 'F') =>
      credits.createReversal(admin, batchId, {
        outletId: outlet, outletName: `Outlet ${outlet}`, fieldId: field, fieldName: 'Field',
        awardType: CreditAwardType.POINTS, originalPaise: amount, requestedPaise: amount,
      }),
    approve: (id: string, approvedPaise?: number) =>
      credits.patchReversal(gifsy, id, { action: ReversalAction.approve, ...(approvedPaise ? { approvedPaise } : {}) }),
    reject: (id: string) => credits.patchReversal(gifsy, id, { action: ReversalAction.reject }),
    w: (partnerId: string) => T.wallets.find((x) => x.partnerId === partnerId)!,
  };
  return api;
}
type World = ReturnType<typeof world>;

const errorOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return `${(e as Error).constructor.name}: ${(e as Error).message}`;
  }
};

/** Normalise a snapshot: real-time Dates → '<date>', fake-clock Dates → offset, BigInt → 'n'-suffixed string. */
function normalise(x: unknown): unknown {
  return JSON.parse(
    JSON.stringify(x, (_k, v) => {
      if (typeof v === 'bigint') return `${v}n`;
      return v;
    }),
    (_k, v) => {
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
        const t = new Date(v).getTime() - NOW.getTime();
        return t >= 0 && t < 1_000_000 ? `<clock+${t}>` : '<date>';
      }
      return v;
    },
  );
}

// ───────────────────────── LEGACY: byte-identical to the pre-WP4 code ─────────────────────────

/**
 * One Deoleo-style LEGACY history exercising every legacy create/approve branch: full approve with a shortfall,
 * partial approve, over-cap create, reject, nothing-credited, outlet relinked (refused), wallet with debt (Q14
 * refused). Returns the full persisted state + every error message.
 */
async function legacyScenario(mode: ReversalEngineMode | null) {
  const h = world({
    mode,
    outlets: { O1: 'cp1', O2: 'cp2', O3: 'cp1', O4: 'cp3' },
    wallets: [blankWallet('w-cp3', 'cp3', { redeemablePoints: -100 })],
  });
  const out: Row = { errors: [] as (string | null)[] };
  out.confirm1 = await h.confirm('B1', [
    { outlet: 'O1', amount: 500 }, { outlet: 'O2', amount: 300 }, { outlet: 'O3', amount: 200 }, { outlet: 'O9', amount: 50 },
  ]);
  await h.redeem('cp1', 600);
  const r1 = await h.create('B1', 'O1', 500);
  out.approve1 = await h.approve(r1.id);
  const r2 = await h.create('B1', 'O2', 300);
  out.approve2 = await h.approve(r2.id, 120);
  out.errors.push(await errorOf(h.create('B1', 'O2', 181)));
  const r3 = await h.create('B1', 'O2', 180);
  out.reject3 = await h.reject(r3.id);
  out.errors.push(await errorOf(h.create('B1', 'O9', 50)));
  h.T.outlets.find((o) => o.outletCode === 'O3')!.partnerId = 'cp2'; // relinked after the credit
  out.errors.push(await errorOf(h.create('B1', 'O3', 200)));
  out.confirm2 = await h.confirm('B2', [{ outlet: 'O4', amount: 500 }]);
  out.errors.push(await errorOf(h.create('B2', 'O4', 100)));
  const { settings, ...tables } = h.T;
  return { h, snapshot: normalise({ out, tables }) };
}

const GOLDEN = path.join(__dirname, '__fixtures__', 'legacy-reversal-golden.json');

describe('WP4 — LEGACY (default for every tenant) is byte-identical to the pre-WP4 code', () => {
  it('golden snapshot of a full legacy reversal history (generated on the pre-WP4 commit 1aa5084e)', async () => {
    const { snapshot } = await legacyScenario(null);
    if (process.env.WP4_WRITE_GOLDEN) fs.writeFileSync(process.env.WP4_WRITE_GOLDEN, JSON.stringify(snapshot, null, 2));
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    expect(snapshot).toEqual(golden);
  });

  it('an explicit LEGACY row behaves exactly like an absent row', async () => {
    const absent = await legacyScenario(null);
    const legacy = await legacyScenario('LEGACY');
    expect(legacy.snapshot).toEqual(absent.snapshot);
    // and no v2 table / column is ever written for a LEGACY tenant on un-backfilled wallets
    expect(legacy.h.T.positions).toHaveLength(0);
    expect(legacy.h.T.allocations).toHaveLength(0);
    expect(legacy.h.T.auditLogs).toHaveLength(0);
    expect(legacy.h.T.walletTxns.every((t) => t.seq === undefined && t.pointsDelta === undefined)).toBe(true);
  });
});

// ───────────────────────── V2: service ≡ WP0 oracle, every approval order ─────────────────────────

const cr = (id: string, amount: number): ModelEvent => ({ type: 'credit', id, amount, reversible: true });
const sp = (amount: number): ModelEvent => ({ type: 'spend', amount });
const rv = (creditId: string, amount: number): ModelEvent => ({ type: 'reverse', creditId, amount });

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const p of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...p]);
  });
  return out;
}

/** Opening state as the WP6 backfill leaves it: B = n, D = max(0, −n), movementSeq 1 (or a pristine wallet). */
function openingWallet(n: number): Row {
  return n < 0
    ? blankWallet('w1', 'cp1', { redeemablePoints: n, debtPoints: -n, movementSeq: 1 })
    : blankWallet('w1', 'cp1');
}
const openingEvents = (n: number): ModelEvent[] =>
  n < 0 ? [{ type: 'legacyDebit', amount: -n }] : n > 0 ? [{ type: 'credit', id: 'OPEN', amount: n, reversible: false }] : [];

/**
 * Drive a history through the credits endpoints on a V2 tenant: every credit X is its own batch `B-X` for outlet
 * O1 (→ cp1 / w1); a prefix reversal is create + approve; the final reversals are ALL created first (create cap with
 * other reversals pending) and then approved in `order`.
 */
async function driveV2(open: number, prefix: ModelEvent[], finals: ModelEvent[], order: number[]) {
  const h = world({ mode: 'V2', outlets: { O1: 'cp1' }, wallets: [openingWallet(open)] });
  if (open > 0) await h.wallet.creditEarn('cp1', TENANT, open, {});
  for (const ev of prefix) {
    if (ev.type === 'credit') await h.confirm(`B-${ev.id}`, [{ outlet: 'O1', amount: ev.amount }]);
    else if (ev.type === 'spend') await h.redeem('cp1', ev.amount);
    else if (ev.type === 'reverse') {
      const r = await h.create(`B-${ev.creditId}`, 'O1', ev.amount);
      await h.approve(r.id);
    }
  }
  const created: Row[] = [];
  for (const ev of finals) {
    if (ev.type !== 'reverse') throw new Error('finals are reversals');
    created.push(await h.create(`B-${ev.creditId}`, 'O1', ev.amount));
  }
  const approved: Row[] = [];
  for (const i of order) approved.push((await h.approve(created[i].id)) as Row);
  return { h, approved };
}

async function allOrdersV2(open: number, prefix: ModelEvent[], finals: ModelEvent[]) {
  const results: { B: number; D: number; sf: number }[] = [];
  for (const order of permutations(finals.map((_, i) => i))) {
    const events = [...openingEvents(open), ...prefix, ...order.map((i) => finals[i])];
    const oracle = run(events);
    expect(checkInvariants(oracle.model)).toEqual([]);
    const { h, approved } = await driveV2(open, prefix, finals, order);
    const w = h.w('cp1');
    expect({ B: w.redeemablePoints, D: w.debtPoints }).toEqual({ B: oracle.model.state.B, D: oracle.model.state.D });
    for (const pos of Object.values(oracle.model.positions)) {
      const row = h.T.positions.find((p) => p.batchId === `B-${pos.id}`)!;
      expect({ id: pos.id, offset: row.offsetPoints, reversed: row.reversedPoints }).toEqual({
        id: pos.id, offset: pos.offset, reversed: pos.reversed,
      });
    }
    // per-reversal shortfall (in approval order) = the oracle's, recorded on the CreditReversal + its allocations
    const oracleRev = oracle.movements.filter((m: Movement) => m.kind === 'REVERSAL').slice(-finals.length);
    approved.forEach((r, k) => {
      expect(r.status).toBe('APPROVED');
      expect(Number(r.shortfallPaise ?? 0n)).toBe(oracleRev[k].shortfall);
      expect(r.clawbackShortfall).toBe(oracleRev[k].shortfall);
      const allocs = h.T.allocations.filter((a) => a.creditReversalId === r.id);
      expect(allocs.reduce((s, a) => s + a.shortfall, 0)).toBe(oracleRev[k].shortfall);
      expect(allocs.reduce((s, a) => s + a.debtRestored, 0)).toBe(oracleRev[k].debtRestored);
      expect(allocs.reduce((s, a) => s + a.recovered, 0)).toBe(oracleRev[k].recovered);
    });
    // passbook chain exact
    const rows = [...h.T.walletTxns].filter((t) => t.walletId === 'w1').sort((a, b) => a.seq - b.seq);
    rows.forEach((r, i) => {
      expect(r.balanceAfter).toBe(r.balanceBefore + r.pointsDelta);
      if (i > 0) expect(r.balanceBefore).toBe(rows[i - 1].balanceAfter);
    });
    expect(h.T.auditLogs).toHaveLength(0); // V2 writes no shadow rows
    results.push({
      B: oracle.model.state.B,
      D: oracle.model.state.D,
      sf: oracle.movements.filter((m) => m.kind === 'REVERSAL').reduce((s, m) => s + m.shortfall, 0),
    });
  }
  return results;
}

describe('WP4 — V2 create/approve through the credits endpoints ≡ WP0 oracle (every approval order)', () => {
  it('T-a: 0, f1 +500, redeem 500, f2 +300; reverse f1, f2 → B 0, Σsf 500 (= today)', async () => {
    for (const x of await allOrdersV2(0, [cr('f1', 500), sp(500), cr('f2', 300)], [rv('f1', 500), rv('f2', 300)])) {
      expect(x).toEqual({ B: 0, D: 0, sf: 500 });
    }
  });

  it('T-b: −841, f1 +500, f2 +300; reverse both → B −841, shortfall 0 (R1 — LEGACY refuses this wallet, Q14)', async () => {
    for (const x of await allOrdersV2(-841, [cr('f1', 500), cr('f2', 300)], [rv('f1', 500), rv('f2', 300)])) {
      expect(x).toEqual({ B: -841, D: 841, sf: 0 });
    }
  });

  it('T-c: −100, E +500, redeem 400, X +300; reverse E, X → B −100, Σsf 400', async () => {
    for (const x of await allOrdersV2(-100, [cr('E', 500), sp(400), cr('X', 300)], [rv('E', 500), rv('X', 300)])) {
      expect(x).toMatchObject({ B: -100, sf: 400 });
    }
  });

  it('T-d: −1000, Dc +1200, E +500, reverse Dc, X +300; reverse E, X → B −1000 (patched code: −700 ✗)', async () => {
    for (const x of await allOrdersV2(
      -1000, [cr('Dc', 1200), cr('E', 500), rv('Dc', 1200), cr('X', 300)], [rv('E', 500), rv('X', 300)],
    )) {
      expect(x.B).toBe(-1000);
    }
  });

  it('T-R2*: −100, X +100, Z +200, redeem 200, Y +200; reverse X, Y, Z (3! orders) → B −100 (Q1)', async () => {
    for (const x of await allOrdersV2(
      -100, [cr('X', 100), cr('Z', 200), sp(200), cr('Y', 200)], [rv('X', 100), rv('Y', 200), rv('Z', 200)],
    )) {
      expect(x.B).toBe(-100);
    }
  });

  it('T-g: partial reversals of one credit — approved in sequence, identical B across orders', async () => {
    const res = await allOrdersV2(-300, [cr('X', 400), sp(50), cr('Y', 200), rv('X', 150)], [rv('X', 250), rv('Y', 120)]);
    expect(new Set(res.map((x) => JSON.stringify(x))).size).toBe(1);
  });
});

describe('WP4 — V2 caps (position-based) at create and approve', () => {
  const v2 = (wallets = [blankWallet('w1', 'cp1')]) => world({ mode: 'V2', outlets: { O1: 'cp1' }, wallets });

  it('create cap = Σ(amount − reversed) − Σ pending; originalPaise = Σ position amounts; partial approve frees the rest', async () => {
    const h = v2();
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }, { outlet: 'O1', amount: 200 }]); // two positions, one key
    expect(h.T.positions).toHaveLength(2);
    expect(await errorOf(h.create('B1', 'O1', 501))).toMatch(
      /BadRequestException: Reversal exceeds the amount still reversible .*credited 500 pts, already reversed 0 pts, pending 0 pts, requested 501 pts/,
    );
    const r1 = await h.create('B1', 'O1', 400);
    expect(r1).toMatchObject({ originalPaise: 500n, requestedPaise: 400n, status: 'PENDING_GIFSY' });
    expect(await errorOf(h.create('B1', 'O1', 10))).toMatch(/pending reversal already exists/);
    await h.approve(r1.id, 250); // PARTIAL: ρ 250 over the two positions (oldest first: 250 of the 300)
    expect(h.T.positions.map((p) => p.reversedPoints)).toEqual([250, 0]);
    expect(await errorOf(h.create('B1', 'O1', 251))).toMatch(/already reversed 250 pts, pending 0 pts, requested 251/);
    const r2 = await h.create('B1', 'O1', 250);
    await h.approve(r2.id);
    expect(h.T.positions.map((p) => p.reversedPoints)).toEqual([300, 200]);
    expect(h.w('cp1').redeemablePoints).toBe(0);
    expect(await errorOf(h.create('B1', 'O1', 1))).toMatch(/requested 1 pts/);
  });

  it('approve re-checks the cap under the batch lock: refused → no flip, no wallet write', async () => {
    const h = v2();
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    const r = await h.create('B1', 'O1', 300);
    h.T.positions[0].reversedPoints = 100; // e.g. a reversal recorded since (another path) — only 200 left
    const before = JSON.stringify(h.w('cp1'));
    expect(await errorOf(h.approve(r.id))).toMatch(
      /BadRequestException: Approval exceeds the amount still reversible .*credited 300 pts, already reversed 100 pts, approving 300 pts/,
    );
    expect(h.T.reversals[0].status).toBe('PENDING_GIFSY');
    expect(JSON.stringify(h.w('cp1'))).toBe(before);
    expect(h.T.allocations).toHaveLength(0);
    await h.approve(r.id, 200); // PARTIAL within the cap is fine
    expect(h.T.reversals[0]).toMatchObject({ status: 'PARTIAL', approvedPaise: 200n });
    expect(h.w('cp1').redeemablePoints).toBe(100);
  });

  it('reject never consults the engine (no flag read, no cap)', async () => {
    const h = v2();
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    const r = await h.create('B1', 'O1', 300);
    h.T.positions.length = 0; // even with no position at all
    h.resetCounts();
    await expect(h.reject(r.id)).resolves.toMatchObject({ status: 'REJECTED' });
    expect(h.counts.out['programSetting.findUnique'] ?? 0).toBe(0);
    expect(h.counts.tx['programSetting.findUnique'] ?? 0).toBe(0);
  });

  it('the tenant flag is read ONCE per create / approve request (dispatcher does not re-read)', async () => {
    const h = v2();
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    h.resetCounts();
    const r = await h.create('B1', 'O1', 100);
    expect((h.counts.out['programSetting.findUnique'] ?? 0) + (h.counts.tx['programSetting.findUnique'] ?? 0)).toBe(1);
    h.resetCounts();
    await h.approve(r.id);
    expect((h.counts.out['programSetting.findUnique'] ?? 0) + (h.counts.tx['programSetting.findUnique'] ?? 0)).toBe(1);
  });

  it('V2 approves on a wallet with debt (Q1) where LEGACY refuses it (Q14)', async () => {
    const legacy = world({ mode: 'LEGACY', outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1', { redeemablePoints: -841 })] });
    await legacy.confirm('B1', [{ outlet: 'O1', amount: 500 }]);
    expect(await errorOf(legacy.create('B1', 'O1', 500))).toMatch(/ConflictException: This wallet carries debt/);
    const h = v2([openingWallet(-841)]);
    await h.confirm('B1', [{ outlet: 'O1', amount: 500 }]);
    const r = await h.create('B1', 'O1', 500);
    const res = await h.approve(r.id);
    expect(res).toMatchObject({ status: 'APPROVED', clawbackShortfall: 0 });
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: -841, debtPoints: 841 });
  });
});

describe('WP4 — V2 attribution: relinked outlets (T-f1/f2), unresolved / unknown credits (T-h, Q5)', () => {
  it('T-f1 / Q4: outlet relinked after the credit → create + approve debit the wallet that RECEIVED it', async () => {
    const h = world({
      mode: 'V2', outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1'), blankWallet('w2', 'cp2')],
    });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    await h.wallet.creditEarn('cp2', TENANT, 1000, {});
    h.T.outlets[0].partnerId = 'cp2'; // relinked
    const r = await h.create('B1', 'O1', 300);
    expect(r.originalPaise).toBe(300n);
    await h.approve(r.id);
    expect(h.w('cp1').redeemablePoints).toBe(0);
    expect(h.w('cp2').redeemablePoints).toBe(1000);
    const clawback = h.T.walletTxns.find((t) => t.referenceType === 'CREDIT_REVERSAL')!;
    expect(clawback).toMatchObject({ walletId: 'w1', creditReversalId: r.id, reversedCreditTxId: h.T.positions[0].creditTxId });
  });

  it('T-f1 contrast: the same relink under LEGACY is refused (current partner never received it)', async () => {
    const h = world({ mode: 'LEGACY', outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1'), blankWallet('w2', 'cp2')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    h.T.outlets[0].partnerId = 'cp2';
    expect(await errorOf(h.create('B1', 'O1', 300))).toMatch(/BadRequestException: Cannot reverse: outlet O1 is not linked|Cannot claw back/);
  });

  it('T-f2: a credit with no position (wallet not prepared / old unmapped credit) → 400 "Gifsy must prepare / map", nothing written', async () => {
    const h = world({ mode: 'V2', outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    h.T.batches.push({ id: 'B0', clientId: TENANT, status: 'CONFIRMED', period: '2026-04', rows: [] });
    // a pre-engine credit: metadata present, but no WalletCreditPosition (the backfill has not covered this wallet)
    h.T.walletTxns.push({
      id: 'old', walletId: 'w1', transactionType: 'CREDIT_POINTS_EARNED', referenceType: 'CREDIT_BATCH', referenceId: 'B0',
      points: 300, balanceBefore: 0, balanceAfter: 300, metadata: { fieldId: 'F', outletCode: 'O1' }, createdAt: later(-9000),
    });
    expect(await errorOf(h.create('B0', 'O1', 100))).toMatch(/BadRequestException: Cannot reverse yet: .*Gifsy must prepare \/ map/);
    expect(h.T.reversals).toHaveLength(0);
  });

  it('T-h (unknown credit): nothing was credited for the key → 400 "settle it off-platform"', async () => {
    const h = world({ mode: 'V2', outlets: { O1: 'cp1', O2: 'cp2' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }, { outlet: 'O9', amount: 50 }]); // O9 unknown → skipped
    expect(await errorOf(h.create('B1', 'O9', 50))).toMatch(/BadRequestException: Cannot reverse: no wallet received .*settle it off-platform/);
    expect(await errorOf(h.create('B1', 'O1', 10, 'OTHER-FIELD'))).toMatch(/no wallet received/);
  });

  it('T-h / Q5: an UNRESOLVED credit in the batch → 400 at create AND at approve; nothing flipped or written', async () => {
    const h = world({ mode: 'V2', outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    const r = await h.create('B1', 'O1', 100);
    const unresolved = {
      id: 'u1', walletId: 'w1', creditTxId: 'x', lotId: null, batchId: 'B1', outletCode: null, fieldId: null,
      amount: 5, offsetPoints: 0, reversedPoints: 0, attribution: 'UNRESOLVED',
    };
    h.T.positions.push(unresolved);
    expect(await errorOf(h.create('B1', 'O1', 50))).toMatch(/pending reversal already exists/); // dup guard first
    expect(await errorOf(h.approve(r.id))).toMatch(/BadRequestException: Cannot reverse yet: 1 credit\(s\) .*map them first/);
    expect(h.T.reversals[0].status).toBe('PENDING_GIFSY');
    expect(h.w('cp1').redeemablePoints).toBe(300);
    await h.reject(r.id);
    expect(await errorOf(h.create('B1', 'O1', 50))).toMatch(/map them first/);
  });
});

describe('WP4 — SHADOW: LEGACY decides and applies; the v2 result is recorded next to it', () => {
  const run2 = async (mode: ReversalEngineMode) => {
    const h = world({ mode, outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 500 }]);
    await h.redeem('cp1', 400);
    const r = await h.create('B1', 'O1', 500);
    const res = await h.approve(r.id, 450);
    return { h, r, res };
  };

  it('balances, passbook, reversal row: identical to LEGACY; create + approve diffs written (no diff here)', async () => {
    const legacy = await run2('LEGACY');
    const shadow = await run2('SHADOW');
    // SHADOW wallets are tracked from their first credit (pristine wallet) — compare the LEGACY-visible fields
    const vis = (w: Row) => ({
      B: w.redeemablePoints, earned: w.earnedPoints, redeemed: w.redeemedPoints, lifetimeEarned: w.lifetimeEarned,
    });
    expect(vis(shadow.h.w('cp1'))).toEqual(vis(legacy.h.w('cp1')));
    const pb = (h: World) =>
      h.T.walletTxns.map((t) => [t.transactionType, t.points, t.balanceBefore, t.balanceAfter, String(t.description).replace(/rev\d+/, 'rev#')]);
    expect(pb(shadow.h)).toEqual(pb(legacy.h));
    const rev = (x: Row) => ({ status: x.status, approvedPaise: x.approvedPaise, shortfallPaise: x.shortfallPaise, clawbackShortfall: x.clawbackShortfall });
    expect(rev(shadow.res as Row)).toEqual(rev(legacy.res as Row));
    expect(legacy.h.T.auditLogs).toHaveLength(0);
    expect(shadow.h.T.auditLogs.map((a) => [a.action, a.entityType, a.entityId, a.metadata.differs])).toEqual([
      ['CREATE', 'REVERSAL_ENGINE_SHADOW', shadow.r.id, false],
      ['UPDATE', 'REVERSAL_ENGINE_SHADOW', shadow.r.id, false],
    ]);
    expect(shadow.h.T.auditLogs[0].metadata).toMatchObject({
      phase: 'CREATE', legacy: { credited: 500, headroom: 500 }, v2: { credited: 500, headroom: 500, pending: 0 },
    });
    expect(shadow.h.T.auditLogs[1].metadata).toMatchObject({
      requested: 450, legacy: { removed: 100, shortfall: 350 }, v2: { removed: 100, shortfall: 350 },
    });
  });

  it('a v2 refusal (UNRESOLVED credit in the batch, Q5) is recorded as a diff at create and approve; LEGACY still runs', async () => {
    const h = world({ mode: 'SHADOW', outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 500 }]);
    h.T.positions.push({
      id: 'u1', walletId: 'w1', creditTxId: 'x', lotId: null, batchId: 'B1', outletCode: null, fieldId: null,
      amount: 5, offsetPoints: 0, reversedPoints: 0, attribution: 'UNRESOLVED',
    });
    const r = await h.create('B1', 'O1', 200);
    await h.approve(r.id);
    expect(h.w('cp1').redeemablePoints).toBe(300);
    expect(h.T.auditLogs.map((a) => [a.metadata.differs, a.metadata.v2.refused])).toEqual([
      [true, expect.stringMatching(/map them first/)],
      [true, expect.stringMatching(/map them first/)],
    ]);
  });

  it('a LEGACY refusal (wallet with debt, Q14) refuses in SHADOW too, and records nothing', async () => {
    const h = world({ mode: 'SHADOW', outlets: { O1: 'cp1' }, wallets: [openingWallet(-841)] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 500 }]);
    expect(await errorOf(h.create('B1', 'O1', 500))).toMatch(/This wallet carries debt/);
    expect(h.T.reversals).toHaveLength(0);
    expect(h.T.auditLogs).toHaveLength(0);
    expect(h.w('cp1').redeemablePoints).toBe(-341);
  });
});

// ───────────────────────── confirmBatch: the flag is read once per batch ─────────────────────────

describe('WP4 — confirmBatch resolves the reversal-engine mode ONCE per batch (2,000-row measurement)', () => {
  const N = 2000;
  const outlets = Object.fromEntries(Array.from({ length: N }, (_, i) => [`O${i}`, `cp${i}`]));
  const partners = Array.from({ length: N }, (_, i) => `cp${i}`);
  const rows = Array.from({ length: N }, (_, i) => ({ outlet: `O${i}`, amount: 10 + (i % 7) }));

  /**
   * Confirm a 2,000-row POINTS batch. `preWp4` restores the old per-row behaviour (the mode is NOT passed down to
   * creditEarn, so movementPath reads partner + flag per row); the one batch-level read WP4 added is still made, so
   * the true pre-WP4 count is this − 1 (measured on 1aa5084e: see the commit message).
   */
  const measure = async (mode: ReversalEngineMode | null, preWp4: boolean) => {
    const h = world({ mode, outlets, partners });
    if (preWp4) {
      const orig = h.wallet.creditEarn.bind(h.wallet);
      jest.spyOn(h.wallet, 'creditEarn').mockImplementation((p, c, a, o = {}, tx) => {
        const { reversalEngineMode: _dropped, ...rest } = o as typeof o & { reversalEngineMode?: unknown };
        return orig(p, c, a, rest, tx);
      });
    }
    h.resetCounts();
    const res = await h.confirm('BIG', rows);
    expect(res.pointsCredited).toBe(N);
    const all = { ...h.counts.out };
    for (const [k, v] of Object.entries(h.counts.tx)) all[k] = (all[k] ?? 0) + v;
    const total = Object.values(all).reduce((s, v) => s + v, 0);
    return { h, all, total, tx: h.counts.tx };
  };

  it('LEGACY tenant: 2 reads per row (partner + flag) → 1 flag read per batch; every written row identical', async () => {
    const before = await measure(null, true);
    const after = await measure(null, false);
    // eslint-disable-next-line no-console
    console.log(
      `[WP4 query count] 2,000-row POINTS confirm, LEGACY tenant: before ${before.total} queries ` +
        `(channelPartner.findFirst ${before.all['channelPartner.findFirst'] ?? 0}, programSetting.findUnique ${before.all['programSetting.findUnique'] ?? 0}) ` +
        `→ after ${after.total} (channelPartner.findFirst ${after.all['channelPartner.findFirst'] ?? 0}, programSetting.findUnique ${after.all['programSetting.findUnique'] ?? 0}); ` +
        `saved ${before.total - after.total}`,
    );
    expect(before.all['programSetting.findUnique']).toBe(N + 1); // N per-row + WP4's batch-level read
    expect(before.tx['channelPartner.findFirst']).toBe(N);
    expect(after.all['programSetting.findUnique']).toBe(1);
    expect(after.tx['channelPartner.findFirst'] ?? 0).toBe(0); // (the post-commit notify loop's reads are outside the tx)
    expect(before.total - after.total).toBe(2 * N); // vs true pre-WP4: 2N − 1
    // byte-identical writes
    const strip = (h: World) => normalise({ w: h.T.wallets, t: h.T.walletTxns, l: h.T.ledger, p: h.T.positions });
    expect(strip(after.h)).toEqual(strip(before.h));
  }, 120_000);

  it('V2 tenant (pristine wallets): same saving; positions written identically', async () => {
    const before = await measure('V2', true);
    const after = await measure('V2', false);
    // eslint-disable-next-line no-console
    console.log(`[WP4 query count] 2,000-row POINTS confirm, V2 tenant: before ${before.total} → after ${after.total} queries`);
    expect(before.total - after.total).toBe(2 * N);
    expect(after.h.T.positions).toHaveLength(N);
    const strip = (h: World) => normalise({ w: h.T.wallets, t: h.T.walletTxns, l: h.T.ledger, p: h.T.positions });
    expect(strip(after.h)).toEqual(strip(before.h));
  }, 120_000);

  it('a malformed flag aborts a POINTS confirm before any write (fail closed); a PAYOUT-only batch never reads it', async () => {
    const h = world({ mode: null, outlets: { O1: 'cp1' } });
    h.T.settings.set(`${TENANT}:reversalEngine`, 'v2'); // malformed
    expect(await errorOf(h.confirm('B1', [{ outlet: 'O1', amount: 10 }]))).toMatch(/Invalid reversalEngine setting/);
    expect(h.T.batches[0].status).toBe('PENDING_CONFIRM');
    expect(h.T.walletTxns).toHaveLength(0);

    h.resetCounts();
    h.T.batches.push({
      id: 'P1', clientId: TENANT, status: 'PENDING_CONFIRM', period: '2026-05', uploadedBy: 'client-admin',
      totalOutlets: 1, totalPoints: 0, totalPayoutPaise: 10000n,
      rows: [{ outletId: 'O1', outletName: 'O1', fieldId: 'F', fieldName: 'Field', amount: 10000, narration: '', awardType: 'PAYOUT', status: 'OK' }],
    });
    await expect(h.credits.confirmBatch({ sub: 'client-admin', role: 'CLIENT_ADMIN', clientId: TENANT } as JwtPayload, 'P1'))
      .resolves.toMatchObject({ payoutEntriesCreated: 1, pointsCredited: 0 });
    expect((h.counts.out['programSetting.findUnique'] ?? 0) + (h.counts.tx['programSetting.findUnique'] ?? 0)).toBe(0);
  });
});
