// Wallet Reversal Engine — credit-batch POINTS reversals (create / approve) through the credits endpoints, on the ONE
// engine every tenant runs since 2026-11-21 (the per-tenant LEGACY / SHADOW / V2 mode is retired; a leftover
// `reversalEngine` settings row is ignored), plus the safety gate: a receiving wallet whose history is not sequenced
// refuses the reversal (WALLET_NOT_SEQUENCED) before anything is written.
// Source of truth: platform/docs/plans/WALLET-REVERSAL-ENGINE-DESIGN.md §6, §12 (Q1–Q14), §15.
//
// Drives the REAL CreditsService + REAL WalletService + REAL TenantSettingsService against an in-memory emulation of
// the tables they touch, and compares the persisted result with the WP0 oracle (reversal-model.ts) — every approval
// order. Dates: a fixed NOW with offsets; real-time stamps are normalised in snapshots (WAYS #10).

import { CreditsService, POINTS_REVERSAL_ENGINE_MARKER_ENTITY } from './credits.service';
import { WalletService } from '../wallet/wallet.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { CreditAwardType } from '@prisma/client';
import { ReversalAction } from './dto/credits.dto';
import { checkInvariants, ModelEvent, Movement, run } from '../wallet/reversal-model';
import { RAISED_UNDER_OLD_ENGINE_MESSAGE, ReversalAttentionException, walletNotSequencedMessage } from '../wallet/reversal-policy';

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
  /** a `reversalEngine` program_settings row left behind from before the retirement — must be IGNORED */
  leftoverEngineRow?: unknown;
  partners?: string[];
  outlets?: Record<string, string | null>; // outletCode → partnerId
  wallets?: Row[];
  /** `clients` rows (id, internalName, branding) — B1 display name */
  clients?: Row[];
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
    clients: (opts.clients ?? []) as Row[],
    batches: [] as Row[],
    reversals: [] as Row[],
    partners: (opts.partners ?? ['cp1', 'cp2', 'cp3']).map((id) => ({ id, clientId: TENANT })),
    outlets: Object.entries(opts.outlets ?? { O1: 'cp1' }).map(([outletCode, partnerId]) => ({
      clientId: TENANT, outletCode, partnerId,
    })) as Row[],
    settings: new Map<string, unknown>(),
    /** reads per program_settings key (reversalEngine vs pointsReversalApprovalsPaused) */
    settingReads: {} as Record<string, number>,
    /** every raw SQL text issued (the pause gate's shared advisory lock is asserted on) */
    rawSql: [] as string[],
  };
  if (opts.leftoverEngineRow !== undefined) T.settings.set(`${TENANT}:reversalEngine`, opts.leftoverEngineRow);

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
    // HELD OPENING BALANCES gate in confirmBatch — no held rows in these scenarios (dormant).
    heldOpeningBalance: { count: async () => 0, findMany: async () => [] },
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
      // listReversals → withPointsOutcomes: `creditReversalId: { in: [...] }`
      findMany: async ({ where }: any = {}) =>
        T.allocations.filter((a) => (where?.creditReversalId?.in ?? []).includes(a.creditReversalId)).map((a) => ({ ...a })),
    },
    auditLog: {
      create: async ({ data }: any) => {
        T.auditLogs.push(JSON.parse(JSON.stringify(data)));
        return data;
      },
      // audit A1: patchReversal looks up the one-engine marker written at create
      findFirst: find(T.auditLogs),
    },
    // B1: the client's display name for the WALLET_NOT_SEQUENCED message
    client: { findFirst: find(T.clients) },
    creditBatch: {
      findFirst: find(T.batches),
      updateMany: updateMany(T.batches),
    },
    creditReversal: {
      findFirst: find(T.reversals),
      // `creditAllocations: { none: {} }` (fix round A M3 — approved reversals without an allocation row)
      findMany: async ({ where, ...rest }: any = {}) => {
        const { creditAllocations, ...plain } = where ?? {};
        const rows = await findMany(T.reversals)({ where: plain, ...rest });
        return creditAllocations?.none
          ? rows.filter((r) => !T.allocations.some((a) => a.creditReversalId === r.id))
          : rows;
      },
      create: async ({ data }: any) => {
        const row = {
          id: `rev${++clock}`, status: 'PENDING_GIFSY', approvedPaise: null, shortfallPaise: null, ...data,
        };
        T.reversals.push(row);
        return { ...row };
      },
      updateMany: updateMany(T.reversals),
      update: update(T.reversals, 'creditReversal'),
      count: async () => T.reversals.length,
    },
    creditField: { findMany: async () => [] },
    creditPayoutEntry: { createMany: async ({ data }: any) => ({ count: data.length }) },
    outlet: { findFirst: find(T.outlets), findMany: findMany(T.outlets) },
    channelPartner: { findFirst: find(T.partners) },
    pointExpiryConfig: { findFirst: async () => null },
    programSetting: {
      findUnique: async ({ where }: any) => {
        const k = `${where.clientId_settingKey.clientId}:${where.clientId_settingKey.settingKey}`;
        T.settingReads[where.clientId_settingKey.settingKey] = (T.settingReads[where.clientId_settingKey.settingKey] ?? 0) + 1;
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
  models.$queryRaw = async (strings: TemplateStringsArray | { strings: string[]; values: unknown[] }) => {
    bump('$queryRaw');
    const sqlObj = !Array.isArray(strings) && strings && typeof strings === 'object' && 'strings' in strings ? strings : null;
    const text = sqlObj ? sqlObj.strings.join('?') : Array.isArray(strings) ? strings.join('?') : String(strings);
    T.rawSql.push(text);
    // The V2 approve path row-locks the reversal and re-checks its status (Prisma.sql object).
    if (sqlObj && /FROM credit_reversals WHERE id = \?/.test(text)) {
      const row = T.reversals.find((r) => r.id === sqlObj.values[0]);
      return row ? [{ status: row.status }] : [];
    }
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
    T, counts, wallet, credits, models, gifsy,
    resetCounts() {
      counts.tx = {};
      counts.out = {};
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

// ───────────────────────── One engine for every tenant (the LEGACY mode is retired, 2026-11-21) ─────────────────────────

/**
 * The history that used to be the LEGACY golden (a Deoleo-style tenant: brand-new wallets) — now on the one engine:
 * full approve that over-reverses (debt, never written off), partial approve, over-cap create, reject, nothing
 * credited, outlet relinked (the RECEIVING wallet is debited), and a wallet with UN-sequenced history (the gate refuses).
 */
async function oneEngineScenario(leftoverEngineRow?: unknown) {
  const h = world({
    leftoverEngineRow,
    outlets: { O1: 'cp1', O2: 'cp2', O3: 'cp1', O4: 'cp3' },
    // cp3: an imported / pre-engine wallet with history (−100) the wallet backfill has NOT sequenced
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
  const { settings, settingReads, rawSql, ...tables } = h.T;
  return { h, out, snapshot: normalise({ out, tables }) };
}

describe('one engine for every tenant — a fresh (Deoleo-like) tenant, the safety gate, and a leftover engine row', () => {
  it('fresh wallets are sequenced from their first credit; an over-reversal becomes debt; un-sequenced history is refused', async () => {
    const { h, out } = await oneEngineScenario();
    // every new wallet is sequenced from its first movement (no tenant setting involved)
    expect(h.w('cp1').movementSeq).toBeGreaterThan(0);
    expect(h.w('cp2').movementSeq).toBeGreaterThan(0);
    // r1: 500 reversed from a wallet holding 100 → 100 taken, 400 owed (debt), nothing written off
    expect((out.approve1 as Row).pointsOutcome).toMatchObject({ reversed: 500, recovered: 100, owed: 400, shortfall: 0 });
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: -400, debtPoints: 400 });
    expect((out.approve2 as Row).pointsOutcome).toMatchObject({ reversed: 120, recovered: 120, owed: 0, shortfall: 0 });
    expect(out.errors[0]).toMatch(/BadRequestException: Reversal exceeds the amount still reversible .*already reversed 120 pts, pending 0 pts, requested 181 pts/);
    expect(out.errors[1]).toMatch(/BadRequestException: Cannot reverse: no wallet received a credit .*settle it off-platform/);
    expect(out.errors[2]).toBeNull(); // relinked outlet: the wallet that RECEIVED the credit (cp1) is the one reversed
    // the imported wallet with un-sequenced history: refused loudly, naming the program + outlet + what to do
    expect(out.errors[3]).toBe(`ReversalAttentionException: ${walletNotSequencedMessage('O4', TENANT)}`);
    // B1: no clients row in this world → the slug; the exact next step + the runbook section
    expect(out.errors[3]).toMatch(/outlet O4 \(bajaj\)/);
    expect(out.errors[3]).toMatch(/Gifsy: run the wallet backfill \(dry run, then APPLY\) for this client — see BAJAJ-PROD-FOLLOWUPS-RUNBOOK §C/);
    // …nothing was written for it: no reversal row, the wallet untouched by any reversal, still un-sequenced
    expect(h.T.reversals.filter((r) => r.batchId === 'B2')).toHaveLength(0);
    expect(h.w('cp3')).toMatchObject({ redeemablePoints: 400, movementSeq: 0 });
    expect(h.T.walletTxns.filter((t) => t.walletId === 'w-cp3' && t.referenceType === 'CREDIT_REVERSAL')).toHaveLength(0);
    // …and audited for the attention banner
    expect(h.T.auditLogs.filter((a) => a.entityType === 'REVERSAL_ENGINE_REFUSAL').map((a) => [a.metadata.phase, a.metadata.code, a.metadata.walletId])).toEqual([
      ['CREATE', 'WALLET_NOT_SEQUENCED', 'w-cp3'],
    ]);
    // no reversal-engine setting is ever read
    expect(h.T.settingReads.reversalEngine ?? 0).toBe(0);
  });

  it.each([['LEGACY'], ['SHADOW'], ['V2'], ['v2 (malformed)'], [{ mode: 'LEGACY' }]] as const)(
    'a leftover reversalEngine row (%s) is ignored: byte-identical outcome to no row, and never read',
    async (row) => {
      const none = await oneEngineScenario();
      const leftover = await oneEngineScenario(row);
      expect(leftover.snapshot).toEqual(none.snapshot);
      expect(leftover.h.T.settingReads.reversalEngine ?? 0).toBe(0);
    },
  );
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
  const h = world({ outlets: { O1: 'cp1' }, wallets: [openingWallet(open)] });
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
  const results: { B: number; D: number; sf: number; owed: number }[] = [];
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
      // owner 2026-11-19: what the wallet no longer held is owed (debt) — flagged as such, never written off
      expect(allocs.reduce((s, a) => s + (a.owed ?? 0), 0)).toBe(oracleRev[k].owed);
      for (const a of allocs) expect(a.overReversalDebt ?? false).toBe((a.owed ?? 0) > 0);
      // the approver's plain-words summary carries the same split
      expect(r.pointsOutcome).toMatchObject({
        reversed: oracleRev[k].pointsRequested,
        recovered: oracleRev[k].recovered,
        debtRestored: oracleRev[k].debtRestored,
        owed: oracleRev[k].owed,
        shortfall: 0,
      });
    });
    // passbook chain exact
    const rows = [...h.T.walletTxns].filter((t) => t.walletId === 'w1').sort((a, b) => a.seq - b.seq);
    rows.forEach((r, i) => {
      expect(r.balanceAfter).toBe(r.balanceBefore + r.pointsDelta);
      if (i > 0) expect(r.balanceBefore).toBe(rows[i - 1].balanceAfter);
    });
    // no shadow / refusal rows — only the A1 one-engine marker, one per reversal created
    expect(h.T.auditLogs.filter((a) => a.entityType !== POINTS_REVERSAL_ENGINE_MARKER_ENTITY)).toHaveLength(0);
    expect(h.T.auditLogs.map((a) => a.entityId).sort()).toEqual(h.T.reversals.map((r) => r.id).sort());
    results.push({
      B: oracle.model.state.B,
      D: oracle.model.state.D,
      sf: oracle.movements.filter((m) => m.kind === 'REVERSAL').reduce((s, m) => s + m.shortfall, 0),
      owed: oracle.movements.filter((m) => m.kind === 'REVERSAL').reduce((s, m) => s + m.owed, 0),
    });
  }
  return results;
}

describe('WP4 — V2 create/approve through the credits endpoints ≡ WP0 oracle (every approval order)', () => {
  it('T-a: 0, f1 +500, redeem 500, f2 +300; reverse f1, f2 → B −500, D 500, Σowed 500, nothing written off (owner 2026-11-19)', async () => {
    for (const x of await allOrdersV2(0, [cr('f1', 500), sp(500), cr('f2', 300)], [rv('f1', 500), rv('f2', 300)])) {
      expect(x).toEqual({ B: -500, D: 500, sf: 0, owed: 500 });
    }
  });

  it('T-b: −841, f1 +500, f2 +300; reverse both → B −841, shortfall 0 (R1)', async () => {
    for (const x of await allOrdersV2(-841, [cr('f1', 500), cr('f2', 300)], [rv('f1', 500), rv('f2', 300)])) {
      expect(x).toEqual({ B: -841, D: 841, sf: 0, owed: 0 });
    }
  });

  it('T-c: −100, E +500, redeem 400, X +300; reverse E, X → B −500, D 500, Σowed 400', async () => {
    for (const x of await allOrdersV2(-100, [cr('E', 500), sp(400), cr('X', 300)], [rv('E', 500), rv('X', 300)])) {
      expect(x).toEqual({ B: -500, D: 500, sf: 0, owed: 400 });
    }
  });

  it('T-d: −1000, Dc +1200, E +500, reverse Dc, X +300; reverse E, X → B −1000 (patched code: −700 ✗)', async () => {
    for (const x of await allOrdersV2(
      -1000, [cr('Dc', 1200), cr('E', 500), rv('Dc', 1200), cr('X', 300)], [rv('E', 500), rv('X', 300)],
    )) {
      expect(x.B).toBe(-1000);
    }
  });

  it('T-R2*: −100, X +100, Z +200, redeem 200, Y +200; reverse X, Y, Z (3! orders) → B −300, Z\'s spent 200 owed (Q1 + owner 2026-11-19)', async () => {
    for (const x of await allOrdersV2(
      -100, [cr('X', 100), cr('Z', 200), sp(200), cr('Y', 200)], [rv('X', 100), rv('Y', 200), rv('Z', 200)],
    )) {
      expect(x).toEqual({ B: -300, D: 300, sf: 0, owed: 200 });
    }
  });

  it('T-g: partial reversals of one credit — approved in sequence, identical B across orders', async () => {
    const res = await allOrdersV2(-300, [cr('X', 400), sp(50), cr('Y', 200), rv('X', 150)], [rv('X', 250), rv('Y', 120)]);
    expect(new Set(res.map((x) => JSON.stringify(x))).size).toBe(1);
  });
});

describe('owner decision 2026-11-19 — V2 over-reversal becomes debt, said in plain words (approve response + reversal list)', () => {
  it('reverse 10,000 from a wallet holding 7,014: balance −2,986, debt 2,986, nothing written off; summary in the approve response and the list', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 10000 }]);
    await h.redeem('cp1', 2986);
    const r = await h.create('B1', 'O1', 10000);
    const done = (await h.approve(r.id)) as Row;
    expect(done).toMatchObject({ status: 'APPROVED', clawbackShortfall: 0 });
    expect(Number(done.shortfallPaise ?? 0n)).toBe(0); // nothing written off → nothing "pending" in the report
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: -2986, debtPoints: 2986 });
    expect(h.T.allocations).toEqual([
      expect.objectContaining({ creditReversalId: r.id, requested: 10000, debtRestored: 0, recovered: 7014, owed: 2986, overReversalDebt: true, shortfall: 0 }),
    ]);
    expect(done.pointsOutcome).toMatchObject({ reversed: 10000, recovered: 7014, debtRestored: 0, owed: 2986, shortfall: 0 });
    expect(done.pointsOutcome.headline).toBe(
      'Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings',
    );
    // the reversal list carries the same summary (from the stored allocation rows)
    const list = await h.credits.listReversals(h.gifsy, {} as any);
    const row = list.reversals.find((x: Row) => x.id === r.id) as Row;
    expect(row.pointsOutcome.summary).toBe(
      '10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings',
    );
    // redemption is refused while the wallet is in debt
    await expect(h.redeem('cp1', 1)).rejects.toThrow();
    // the next credit repays the debt first
    await h.confirm('B2', [{ outlet: 'O1', amount: 5000 }]);
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: 2014, debtPoints: 0 });
  });

  it('a V2 reversal the wallet fully covers says only what was taken; a pending / rejected one carries no approved summary in the list', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 500 }, { outlet: 'O1', field: 'G', amount: 300 }]);
    const r = await h.create('B1', 'O1', 200);
    const done = (await h.approve(r.id)) as Row;
    expect(done.pointsOutcome.headline).toBe('Approved · 200 pts reversed · 200 taken from the wallet');
    const r2 = await h.create('B1', 'O1', 100, 'G');
    const rej = (await h.reject(r2.id)) as Row;
    expect(rej.pointsOutcome.headline).toBe('Rejected · nothing was reversed — the wallet is unchanged');
    const list = await h.credits.listReversals(h.gifsy, {} as any);
    expect((list.reversals.find((x: Row) => x.id === r2.id) as Row).pointsOutcome).toBeUndefined();
  });
});

describe('WP4 — V2 caps (position-based) at create and approve', () => {
  const v2 = (wallets = [blankWallet('w1', 'cp1')]) => world({ outlets: { O1: 'cp1' }, wallets });

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

  it('create / approve read ONLY the Q5 pause (once, in the tx) — never a reversal-engine setting', async () => {
    const h = v2();
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    h.resetCounts();
    h.T.settingReads = {};
    const r = await h.create('B1', 'O1', 100);
    expect(h.T.settingReads).toEqual({ pointsReversalApprovalsPaused: 1 });
    h.resetCounts();
    h.T.settingReads = {};
    await h.approve(r.id);
    expect(h.T.settingReads).toEqual({ pointsReversalApprovalsPaused: 1 });
    // read inside the tx, after the pause gate's shared lock
    expect(h.counts.out['programSetting.findUnique'] ?? 0).toBe(0);
    expect(h.counts.tx['programSetting.findUnique']).toBe(1);
  });

  it('approves on a backfilled wallet with debt (Q1 — the old interim Q14 refusal is gone with the LEGACY mode)', async () => {
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
      outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1'), blankWallet('w2', 'cp2')],
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

  it('T-f2 / SAFETY GATE: the receiving wallet has un-sequenced history (or is BLOCKED) → 409 naming the client, outlet + what to do; audited; nothing written', async () => {
    const h = world({
      outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1', { redeemablePoints: 300 })],
      // B1: the client's display name (branding.displayName) is what the admin reads, never the raw slug
      clients: [{ id: TENANT, internalName: 'Bajaj Consumer Care', branding: { displayName: 'Bajaj Consumer Care Ltd' } }],
    });
    h.T.batches.push({ id: 'B0', clientId: TENANT, status: 'CONFIRMED', period: '2026-04', rows: [] });
    // a pre-engine credit: metadata present, but no WalletCreditPosition (the backfill has not covered this wallet)
    h.T.walletTxns.push({
      id: 'old', walletId: 'w1', transactionType: 'CREDIT_POINTS_EARNED', referenceType: 'CREDIT_BATCH', referenceId: 'B0',
      points: 300, balanceBefore: 0, balanceAfter: 300, metadata: { fieldId: 'F', outletCode: 'O1' }, createdAt: later(-9000),
    });
    expect(await errorOf(h.create('B0', 'O1', 100))).toBe(
      "ReversalAttentionException: Can't reverse: the wallet of outlet O1 (Bajaj Consumer Care Ltd) has points history that has not been prepared for reversals yet. Gifsy: run the wallet backfill (dry run, then APPLY) for this client — see BAJAJ-PROD-FOLLOWUPS-RUNBOOK §C, then retry. Nothing was changed — earning and redeeming on this wallet keep working meanwhile.",
    );
    expect(h.T.reversals).toHaveLength(0);
    expect(h.T.auditLogs).toEqual([
      expect.objectContaining({
        action: 'REJECT', entityType: 'REVERSAL_ENGINE_REFUSAL', entityId: 'B0', actorId: 'client-admin',
        metadata: expect.objectContaining({
          phase: 'CREATE', code: 'WALLET_NOT_SEQUENCED', walletId: 'w1', outletId: 'O1', clientId: 'bajaj',
          clientName: 'Bajaj Consumer Care Ltd', reason: 'not yet prepared by the wallet backfill',
        }),
      }),
    ]);
    // the gate also holds at APPROVE (a request carrying the one-engine marker): refused before the guarded flip —
    // nothing flipped, nothing debited
    h.T.reversals.push({
      id: 'R-new', clientId: TENANT, batchId: 'B0', outletId: 'O1', outletName: 'O1', fieldId: 'F', fieldName: 'Field',
      period: '2026-04', awardType: 'POINTS', status: 'PENDING_GIFSY', requestedPaise: 100n, originalPaise: 300n,
      approvedPaise: null, shortfallPaise: null,
    });
    h.T.auditLogs.push({ action: 'CREATE', entityType: POINTS_REVERSAL_ENGINE_MARKER_ENTITY, entityId: 'R-new', metadata: {} });
    expect(await errorOf(h.approve('R-new'))).toMatch(/^ReversalAttentionException: Can't reverse: the wallet of outlet O1 \(Bajaj Consumer Care Ltd\)/);
    expect(h.T.reversals.find((r) => r.id === 'R-new')!.status).toBe('PENDING_GIFSY');
    expect(h.w('cp1').redeemablePoints).toBe(300);
    expect(h.T.auditLogs.at(-1)!.metadata).toMatchObject({ phase: 'APPROVE', code: 'WALLET_NOT_SEQUENCED' });
    h.T.reversals.pop();
    // B1 fallback: no branding.displayName → internalName
    h.T.clients[0].branding = {};
    expect(await errorOf(h.create('B0', 'O1', 100))).toMatch(/outlet O1 \(Bajaj Consumer Care\) has points history/);
    // BLOCKED by the backfill → the stored reason is what the admin sees
    Object.assign(h.T.wallets[0], { backfillStatus: 'BLOCKED', backfillBlockedReason: 'CHAIN_BROKEN: no row continues the balance chain' });
    expect(await errorOf(h.create('B0', 'O1', 100))).toMatch(/needs Gifsy attention \(CHAIN_BROKEN: no row continues the balance chain\)/);
    // …and earning on it keeps working on today's rules (legacy path, no position)
    await h.confirm('B5', [{ outlet: 'O1', amount: 40 }]);
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: 340, movementSeq: 0 });
    expect(h.T.positions).toHaveLength(0);
  });

  it('T-h (unknown credit): nothing was credited for the key → 400 "settle it off-platform"', async () => {
    const h = world({ outlets: { O1: 'cp1', O2: 'cp2' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }, { outlet: 'O9', amount: 50 }]); // O9 unknown → skipped
    expect(await errorOf(h.create('B1', 'O9', 50))).toMatch(/BadRequestException: Cannot reverse: no wallet received .*settle it off-platform/);
    expect(await errorOf(h.create('B1', 'O1', 10, 'OTHER-FIELD'))).toMatch(/no wallet received/);
  });

  it('policy Q3: an UNRESOLVED credit refuses ONLY the outlet line it could belong to — create AND approve; the rest of the batch stays reversible', async () => {
    const h = world({ outlets: { O1: 'cp1', O2: 'cp2' }, wallets: [blankWallet('w1', 'cp1'), blankWallet('w2', 'cp2')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }, { outlet: 'O2', amount: 200 }, { outlet: 'O3', amount: 50 }]); // O3 unknown → not credited
    const r = await h.create('B1', 'O1', 100);
    // an unattributable credit of 50 (the O3 row's, credited to some wallet before the engine) — could be O3's line only:
    // O1 and O2 are fully identified by their resolved positions (300 / 200 = their batch rows)
    h.T.positions.push({
      id: 'u1', walletId: 'w2', creditTxId: 'x', lotId: null, batchId: 'B1', outletCode: null, fieldId: null,
      amount: 50, offsetPoints: 0, reversedPoints: 0, attribution: 'UNRESOLVED',
    });
    await expect(h.approve(r.id)).resolves.toMatchObject({ status: 'APPROVED' });
    await expect(h.create('B1', 'O2', 200)).resolves.toMatchObject({ status: 'PENDING_GIFSY' });
    const msg = "ReversalAttentionException: Can't reverse: the original credit for outlet O3 in this batch couldn't be identified — Gifsy must map it first.";
    expect(await errorOf(h.create('B1', 'O3', 50))).toBe(msg);
    expect(h.T.auditLogs.filter((a) => a.entityType === 'REVERSAL_ENGINE_REFUSAL').map((a) => [a.metadata.phase, a.metadata.code, a.metadata.outletId])).toEqual([
      ['CREATE', 'CREDIT_UNMAPPED', 'O3'],
    ]);
  });

  it('policy Q3: an UNRESOLVED position on THIS exact line (backfill downgrade) refuses it at approve too — nothing flipped or written', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    const r = await h.create('B1', 'O1', 100);
    h.T.positions[0].attribution = 'UNRESOLVED';
    expect(await errorOf(h.create('B1', 'O1', 50))).toMatch(/pending reversal already exists/); // dup guard first
    expect(await errorOf(h.approve(r.id))).toBe(
      "ReversalAttentionException: Can't reverse: the original credit for outlet O1 in this batch couldn't be identified — Gifsy must map it first.",
    );
    expect(h.T.reversals[0].status).toBe('PENDING_GIFSY');
    expect(h.w('cp1').redeemablePoints).toBe(300);
    expect(h.T.auditLogs.map((a) => [a.entityType, a.entityId, a.metadata.phase])).toEqual([
      [POINTS_REVERSAL_ENGINE_MARKER_ENTITY, r.id, undefined], // A1 marker written at create
      ['REVERSAL_ENGINE_REFUSAL', r.id, 'APPROVE'],
    ]);
  });
});

describe('audit A1 — a POINTS reversal raised under the OLD engine is refused at approve (never a silent switch of rules)', () => {
  it('no one-engine marker (requested before the retirement) → RAISED_UNDER_OLD_ENGINE, nothing flipped or written, audited; reject still works', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    // a pending request exactly as the LEGACY create left it: no marker row
    h.T.reversals.push({
      id: 'R-legacy', clientId: TENANT, batchId: 'B1', outletId: 'O1', outletName: 'O1', fieldId: 'F', fieldName: 'Field',
      period: '2026-05', awardType: 'POINTS', status: 'PENDING_GIFSY', requestedPaise: 500n, originalPaise: 300n,
      approvedPaise: null, shortfallPaise: null, requestedAt: later(-1000),
    });
    const before = JSON.stringify({ w: h.T.wallets, t: h.T.walletTxns, p: h.T.positions, a: h.T.allocations }, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    const err = await errorOf(h.approve('R-legacy'));
    expect(err).toBe(`ReversalAttentionException: ${RAISED_UNDER_OLD_ENGINE_MESSAGE}`);
    expect(err).toMatch(/re-raise it/);
    expect(h.T.reversals.find((r) => r.id === 'R-legacy')!.status).toBe('PENDING_GIFSY');
    expect(JSON.stringify({ w: h.T.wallets, t: h.T.walletTxns, p: h.T.positions, a: h.T.allocations }, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toBe(before);
    expect(h.T.auditLogs.filter((a) => a.entityType === 'REVERSAL_ENGINE_REFUSAL').map((a) => [a.entityId, a.metadata.phase, a.metadata.code])).toEqual([
      ['R-legacy', 'APPROVE', 'RAISED_UNDER_OLD_ENGINE'],
    ]);
    // reject is never refused (it moves no points)
    await expect(h.reject('R-legacy')).resolves.toMatchObject({ status: 'REJECTED' });
  });

  it('a reversal created now carries the marker (same transaction) and approves', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    const r = await h.create('B1', 'O1', 100);
    expect(h.T.auditLogs.filter((a) => a.entityType === POINTS_REVERSAL_ENGINE_MARKER_ENTITY)).toEqual([
      expect.objectContaining({ action: 'CREATE', entityId: r.id, actorId: 'client-admin', metadata: expect.objectContaining({ clientId: TENANT, batchId: 'B1', outletId: 'O1', fieldId: 'F' }) }),
    ]);
    await expect(h.approve(r.id)).resolves.toMatchObject({ status: 'APPROVED' });
    expect(h.w('cp1').redeemablePoints).toBe(200);
  });

  it('a create refused by the gate leaves NO marker (rolled back with the transaction)', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    expect(await errorOf(h.create('B1', 'O1', 301))).toMatch(/exceeds/);
    expect(h.T.auditLogs.filter((a) => a.entityType === POINTS_REVERSAL_ENGINE_MARKER_ENTITY)).toHaveLength(0);
  });
});

// ───────────────────────── confirmBatch: no engine mode, every new wallet sequenced ─────────────────────────

describe('confirmBatch on the one engine (2,000-row batch, fresh tenant)', () => {
  const N = 2000;
  const outlets = Object.fromEntries(Array.from({ length: N }, (_, i) => [`O${i}`, `cp${i}`]));
  const partners = Array.from({ length: N }, (_, i) => `cp${i}`);
  const rows = Array.from({ length: N }, (_, i) => ({ outlet: `O${i}`, amount: 10 + (i % 7) }));

  it('reads no reversal-engine setting, takes no engine lock, and sequences every new wallet with its credit position', async () => {
    const h = world({ outlets, partners });
    h.resetCounts();
    h.T.rawSql.length = 0;
    const res = await h.confirm('BIG', rows);
    expect(res.pointsCredited).toBe(N);
    expect((h.counts.out['programSetting.findUnique'] ?? 0) + (h.counts.tx['programSetting.findUnique'] ?? 0)).toBe(0);
    expect(h.T.rawSql.some((s) => s.includes('pg_advisory_xact_lock_shared'))).toBe(false);
    // no per-row tenant lookup any more (movementPath decides from the locked wallet alone)
    expect(h.counts.tx['channelPartner.findFirst'] ?? 0).toBe(0);
    expect(h.T.wallets).toHaveLength(N);
    expect(h.T.wallets.every((w) => w.movementSeq === 1)).toBe(true);
    expect(h.T.positions).toHaveLength(N);
    expect(h.T.walletTxns.every((t) => t.seq === 1 && typeof t.pointsDelta === 'number')).toBe(true);
  }, 120_000);

  it('a leftover malformed reversalEngine row is ignored: the confirm sequences, a reversal works; a PAYOUT-only batch reads nothing', async () => {
    const h = world({ leftoverEngineRow: 'v2', outlets: { O1: 'cp1' } });
    await expect(h.confirm('B1', [{ outlet: 'O1', amount: 10 }])).resolves.toMatchObject({ pointsCredited: 1 });
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: 10, movementSeq: 1 });
    expect(h.T.positions).toHaveLength(1);
    const r = await h.create('B1', 'O1', 10);
    await expect(h.approve(r.id)).resolves.toMatchObject({ status: 'APPROVED' });
    expect(h.w('cp1').redeemablePoints).toBe(0);
    expect(h.T.settingReads.reversalEngine ?? 0).toBe(0);

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

// ───────────────────────── policy round A Q5: POINTS reversal approvals paused (backfill window) ─────────────────────────

describe('policy Q5 — "POINTS reversal approvals paused" switch', () => {
  const SINCE = '2026-11-16T03:00:00.000Z';
  const pause = (h: World, v: unknown) => h.T.settings.set(`${TENANT}:pointsReversalApprovalsPaused`, v);

  it('create AND approve refused with the owner wording + start time; reject still works; audited', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    const r = await h.create('B1', 'O1', 100);
    pause(h, { paused: true, since: SINCE, by: 'wallet-backfill', reason: 'wallet backfill APPLY in progress' });
    const msg = `ReversalAttentionException: Points reversal approvals are paused — wallet maintenance in progress (started ${SINCE})`;
    expect(await errorOf(h.create('B1', 'O1', 50))).toBe(msg);
    expect(await errorOf(h.approve(r.id))).toBe(msg);
    expect(h.T.reversals.find((x) => x.id === r.id)!.status).toBe('PENDING_GIFSY');
    expect(h.w('cp1').redeemablePoints).toBe(300);
    expect(h.T.auditLogs.filter((a) => a.entityType === 'REVERSAL_ENGINE_REFUSAL').map((a) => [a.metadata.phase, a.metadata.code, a.metadata.since])).toEqual([
      ['CREATE', 'APPROVALS_PAUSED', SINCE],
      ['APPROVE', 'APPROVALS_PAUSED', SINCE],
    ]);
    await expect(h.reject(r.id)).resolves.toMatchObject({ status: 'REJECTED' }); // reject moves no points
    pause(h, { paused: false, clearedAt: SINCE });
    await expect(h.create('B1', 'O1', 50)).resolves.toMatchObject({ status: 'PENDING_GIFSY' });
  });

  it('the gate takes the SHARED advisory lock (the backfill drains with the exclusive one) and reads the switch inside the tx', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    h.T.rawSql.length = 0;
    h.resetCounts();
    await h.create('B1', 'O1', 100);
    expect(h.T.rawSql[0]).toContain('pg_advisory_xact_lock_shared(hashtextextended(');
    // the pause only (no engine mode any more) — read through the tx, after the shared lock
    expect(h.counts.tx['programSetting.findUnique']).toBe(1);
    expect(h.counts.out['programSetting.findUnique'] ?? 0).toBe(0);
  });

  it('an unreadable switch value fails CLOSED (treated as paused, says so)', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    pause(h, 'yes');
    expect(await errorOf(h.create('B1', 'O1', 100))).toMatch(/Points reversal approvals are paused — the pause setting is unreadable/);
  });

  it('PAYOUT reversals are never paused by the POINTS switch', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    pause(h, { paused: true, since: SINCE });
    h.T.settingReads = {};
    await errorOf(
      h.credits.createReversal({ sub: 'client-admin', role: 'CLIENT_ADMIN', clientId: TENANT } as JwtPayload, 'B1', {
        outletId: 'O1', outletName: 'O1', fieldId: 'F', fieldName: 'Field', awardType: CreditAwardType.PAYOUT, originalPaise: 100, requestedPaise: 100,
      }),
    );
    expect(h.T.settingReads.pointsReversalApprovalsPaused ?? 0).toBe(0);
  });

  it('ReversalAttentionException is a 409 carrying a machine-readable code', () => {
    const e = new ReversalAttentionException('APPROVALS_PAUSED', 'x');
    expect(e.getStatus()).toBe(409);
    expect(e.code).toBe('APPROVALS_PAUSED');
  });
});

// ───────────────────────── fix round A (money audit, 2026-11-16) ─────────────────────────

describe('fix round A — L3 lock order; B8 / B9 confirm ordering (every tenant)', () => {
  it('L3: a POINTS approve locks the batch row BEFORE the reversal row (same order as a PAYOUT approve / every create)', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    const r = await h.create('B1', 'O1', 100);
    h.T.rawSql.length = 0;
    await h.approve(r.id);
    const iBatch = h.T.rawSql.findIndex((s) => /FROM credit_batches WHERE id = \? FOR UPDATE/.test(s));
    const iRev = h.T.rawSql.findIndex((s) => /FROM credit_reversals WHERE id = \? FOR UPDATE/.test(s));
    expect(h.T.rawSql[0]).toContain('pg_advisory_xact_lock_shared('); // the pause gate's shared lock first
    expect(iBatch).toBeGreaterThan(0);
    expect(iRev).toBeGreaterThan(iBatch);
    expect(h.T.rawSql.filter((s) => /FROM credit_batches WHERE id = \? FOR UPDATE/.test(s))).toHaveLength(1); // no re-lock
  });

  it('audit B9: every confirm pre-locks every target wallet in ascending id (the reversal engine order) in ONE statement before crediting', async () => {
    for (const leftoverEngineRow of [undefined, 'LEGACY']) {
      const h = world({ leftoverEngineRow, outlets: { O2: 'cp2', O1: 'cp1' }, partners: ['cp1', 'cp2'] });
      h.T.rawSql.length = 0;
      await h.confirm('B9', [{ outlet: 'O2', amount: 10 }, { outlet: 'O1', amount: 5 }]);
      const pre = h.T.rawSql.filter((q: string) => q.includes('FOR UPDATE OF w'));
      expect(pre).toHaveLength(1);
      expect(pre[0]).toContain('ORDER BY w."id"');
      // it is the confirm's FIRST raw statement (no engine lock before it any more) — before any credit's own wallet lock
      expect(h.T.rawSql.findIndex((q: string) => q.includes('FOR UPDATE OF w'))).toBe(0);
    }
  });

  it('re-audit B8: every confirm creates the MISSING wallets in ascending partnerId order before crediting any row', async () => {
    const csv = [{ outlet: 'O3', amount: 10 }, { outlet: 'O1', amount: 5 }, { outlet: 'O2', amount: 7 }];
    const outlets = { O3: 'cp3', O1: 'cp1', O2: 'cp2' };
    /** The order wallets were created and rows credited, as one event log. */
    const trace = (h: ReturnType<typeof world>) => {
      const log: string[] = [];
      const wPush = h.T.wallets.push.bind(h.T.wallets);
      h.T.wallets.push = (...rows: Row[]) => {
        rows.forEach((r) => log.push(`wallet:${r.partnerId}`));
        return wPush(...rows);
      };
      const tPush = h.T.walletTxns.push.bind(h.T.walletTxns);
      h.T.walletTxns.push = (...rows: Row[]) => {
        rows.forEach((r) => log.push(`credit:${h.T.wallets.find((w) => w.id === r.walletId)?.partnerId}`));
        return tPush(...rows);
      };
      return log;
    };
    for (const leftoverEngineRow of [undefined, 'LEGACY']) {
      const h = world({ leftoverEngineRow, outlets, partners: ['cp1', 'cp2', 'cp3'] });
      const log = trace(h);
      await h.confirm(`B8-${String(leftoverEngineRow)}`, csv);
      // every missing wallet first, ascending partnerId; then the credits in CSV order
      expect(log).toEqual(['wallet:cp1', 'wallet:cp2', 'wallet:cp3', 'credit:cp3', 'credit:cp1', 'credit:cp2']);
    }
  });

  it('a POINTS confirm takes no reversal-engine advisory lock and reads no engine setting (the mode is retired)', async () => {
    const h = world({ outlets: { O1: 'cp1' } });
    h.T.rawSql.length = 0;
    h.resetCounts();
    await h.confirm('B1', [{ outlet: 'O1', amount: 10 }]);
    expect(h.T.rawSql.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(false);
    expect((h.counts.tx['programSetting.findUnique'] ?? 0) + (h.counts.out['programSetting.findUnique'] ?? 0)).toBe(0);
  });
});

describe('fix round A — M3 through the credits endpoints (sequenced wallet)', () => {
  it('a credit on a SEQUENCED wallet with no position for the line: create refused 409 CREDIT_UNMAPPED + audit row; approve of an earlier request refused too; nothing written', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1', { movementSeq: 1 })] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]); // sequenced wallet → v2 maintenance → a position
    const pending = await h.create('B1', 'O1', 100); // fine while the position exists
    h.T.positions.length = 0; // …now the credit is no longer attributable (e.g. a backfill that could not map it)
    const msg = "ReversalAttentionException: Can't reverse: the original credit for outlet O1 in this batch couldn't be identified — Gifsy must map it first.";
    expect(await errorOf(h.create('B1', 'O1', 50))).toMatch(/pending reversal already exists/); // dup guard first
    expect(await errorOf(h.approve(pending.id))).toBe(msg);
    expect(h.T.reversals[0].status).toBe('PENDING_GIFSY');
    expect(h.w('cp1').redeemablePoints).toBe(300);
    await h.reject(pending.id);
    expect(await errorOf(h.create('B1', 'O1', 50))).toBe(msg);
    expect(h.T.auditLogs.filter((a) => a.entityType === 'REVERSAL_ENGINE_REFUSAL').map((a) => [a.metadata.phase, a.metadata.code])).toEqual([
      ['APPROVE', 'CREDIT_UNMAPPED'],
      ['CREATE', 'CREDIT_UNMAPPED'],
    ]);
  });

  it('V2 create/approve caps subtract an APPROVED reversal of the line that has no allocation row (double clawback impossible)', async () => {
    const h = world({ outlets: { O1: 'cp1' }, wallets: [blankWallet('w1', 'cp1')] });
    await h.confirm('B1', [{ outlet: 'O1', amount: 300 }]);
    h.T.reversals.push({
      id: 'R0', clientId: TENANT, batchId: 'B1', outletId: 'O1', fieldId: 'F', awardType: 'POINTS', status: 'APPROVED',
      approvedPaise: 200n, requestedPaise: 200n, shortfallPaise: 0n,
    });
    expect(await errorOf(h.create('B1', 'O1', 150))).toMatch(/Reversal exceeds the amount still reversible .*requested 150 pts/);
    const r = await h.create('B1', 'O1', 100);
    await expect(h.approve(r.id)).resolves.toMatchObject({ status: 'APPROVED' });
    expect(h.w('cp1').redeemablePoints).toBe(200);
    expect(await errorOf(h.create('B1', 'O1', 1))).toMatch(/requested 1 pts/);
  });
});
