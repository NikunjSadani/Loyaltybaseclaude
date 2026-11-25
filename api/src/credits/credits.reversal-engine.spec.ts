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
const ALL_ACKS = ['SKIPPED', 'ROUNDED', 'NOT_APPLIED', 'BELOW_ZERO', 'REPEAT_DEDUCTION'];

/**
 * The confirm body an admin who ticked `cats` (default: everything) sends: the categories + the EXACT item keys the
 * server would require now (U1 round 3 — computed with the confirm's own presentAckItems, read-only, no audit row).
 */
async function ackFor(credits: CreditsService, models: any, batchId: string, cats: string[] = ALL_ACKS, extra: Row = {}) {
  const batch = models.__T.batches.find((b: Row) => b.id === batchId);
  const rows = batch.rows as Row[];
  const on = models.__T.settings.get(`${TENANT}:creditUploadNegativeDeductions`) === true;
  const deductRows = on ? rows.filter((r) => r.awardType === 'POINTS' && r.status === 'OK' && r.amount < 0) : [];
  const items = await (credits as any).presentAckItems(models, TENANT, batchId, batch.period, rows, deductRows);
  const ackItems = Object.fromEntries(Object.entries(items).filter(([c]) => cats.includes(c)).map(([c, list]) => [c, (list as Row[]).map((x) => x.key)]));
  return { acknowledged: cats, ackItems, ...extra };
}
const later = (ms: number) => new Date(NOW.getTime() + ms);
const TENANT = 'bajaj';

type Row = Record<string, any>;
const num = (x: any) => (x instanceof Date ? x.getTime() : x);

function matchWhere(row: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue;
    if (k === 'OR' && Array.isArray(v)) {
      if (!v.some((w: Row) => matchWhere(row, w))) return false;
      continue;
    }
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
      findMany: findMany(T.wallets),
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
      update: update(T.walletTxns, 'walletTransaction'),
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
      // listReversals → withDeductionUndoKind: markers by entityId + metadata.kind
      findMany: async ({ where }: any = {}) =>
        T.auditLogs
          .filter((l) => (!where?.entityType || l.entityType === where.entityType)
            && (!where?.entityId?.in || where.entityId.in.includes(l.entityId))
            && (!where?.metadata?.path || l.metadata?.[where.metadata.path[0]] === where.metadata.equals))
          .map((l) => ({ ...l })),
    },
    // B1: the client's display name for the WALLET_NOT_SEQUENCED message
    client: { findFirst: find(T.clients) },
    creditBatch: {
      findFirst: find(T.batches),
      findMany: findMany(T.batches),
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
  models.__T = T;
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
      // These scenarios are about the engine, not the preview: every acknowledgement given (own tests below).
      return credits.confirmBatch(admin, batchId, await ackFor(credits, models, batchId));
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
    // (the confirm's own acknowledgement record, CREDIT_BATCH_CONFIRM, is not a reversal audit row)
    const revAudit = h.T.auditLogs.filter((a) => !String(a.entityType).startsWith('CREDIT_BATCH'));
    expect(revAudit.filter((a) => a.entityType !== POINTS_REVERSAL_ENGINE_MARKER_ENTITY)).toHaveLength(0);
    expect(revAudit.map((a) => a.entityId).sort()).toEqual(h.T.reversals.map((r) => r.id).sort());
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
    expect(h.T.auditLogs.filter((a) => !String(a.entityType).startsWith('CREDIT_BATCH'))).toEqual([
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
    expect(h.T.auditLogs.filter((a) => !String(a.entityType).startsWith('CREDIT_BATCH')).map((a) => [a.entityType, a.entityId, a.metadata.phase])).toEqual([
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

// ───────────────────────── Upload deductions (UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md) ─────────────────────────
// Real CreditsService + WalletService on the in-memory tables: a negative POINTS row deducts through the one write path
// (WP0 debt-creating debit), atomic with the credits; undo = a per-row reversal that gives the points back.

describe('upload deductions — negative POINTS rows deduct from the wallet (tenant switch)', () => {
  const ON = (h: World) => h.T.settings.set(`${TENANT}:creditUploadNegativeDeductions`, true);
  const adminUser = { sub: 'client-admin', role: 'CLIENT_ADMIN', clientId: TENANT } as JwtPayload;
  const deductBatch = async (h: World, batchId: string, rows: { outlet: string; field?: string; amount: number; narration?: string }[], ack?: string[]) => {
    h.T.batches.push({
      id: batchId, clientId: TENANT, status: 'PENDING_CONFIRM', period: '2026-05', uploadedBy: 'client-admin',
      totalOutlets: rows.length, totalPoints: rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0), totalPayoutPaise: 0n,
      rows: rows.map((r, i) => ({
        rowNum: i + 3, outletId: r.outlet, outletName: `Outlet ${r.outlet}`, fieldId: r.field ?? 'F', fieldName: 'Field',
        amount: r.amount, narration: r.narration ?? '', awardType: 'POINTS', status: 'OK',
      })),
    });
    return h.credits.confirmBatch(adminUser, batchId, await ackFor(h.credits, h.models, batchId, ack ?? ALL_ACKS));
  };
  const createUndo = (h: World, batchId: string, outlet: string, requested: number, field = 'F') =>
    h.credits.createReversal(adminUser, batchId, {
      outletId: outlet, outletName: `Outlet ${outlet}`, fieldId: field, fieldName: 'Field',
      awardType: CreditAwardType.POINTS, originalPaise: requested, requestedPaise: requested,
    });

  it('F3 / D1 — switch OFF (Deoleo): a batch with a negative POINTS row is REFUSED at confirm, never silently ignored', async () => {
    const h = world();
    await h.confirm('B1', [{ outlet: 'O1', amount: 100 }]);
    expect(await errorOf(deductBatch(h, 'B2', [{ outlet: 'O1', amount: 500 }, { outlet: 'O1', field: 'G', amount: -320 }]))).toMatch(
      /^BadRequestException: Deductions are switched off for this client — remove the negative rows or ask Gifsy\. Row for Outlet O1 \(O1\) \/ field "Field" has -320 points\.$/,
    );
    expect(h.w('cp1').redeemablePoints).toBe(100); // the credit in the same batch was not applied either
    expect(h.T.batches.find((b) => b.id === 'B2')!.status).toBe('PENDING_CONFIRM');
  });

  it('a batch without negative rows never reads the switch', async () => {
    const h = world();
    await h.confirm('B1', [{ outlet: 'O1', amount: 100 }]);
    expect(h.T.settingReads.creditUploadNegativeDeductions ?? 0).toBe(0);
  });

  it('switch ON: −320 on a wallet holding 100 → balance −220, debt 220, a dated passbook line linked to the batch row; the next credit repays the debt first', async () => {
    const h = world();
    ON(h);
    await h.confirm('B1', [{ outlet: 'O1', amount: 100 }]);
    const res = (await deductBatch(h, 'B2', [{ outlet: 'O1', amount: -320, narration: 'sales returns' }])) as Row;
    expect(res).toMatchObject({
      pointsCredited: 0, pointsDeducted: 1, pointsDeductedTotal: 320,
      deductions: [{ outletId: 'O1', fieldName: 'Field', points: 320, balanceBefore: 100, balanceAfter: -220 }],
    });
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: -220, debtPoints: 220, earnedPoints: 100 });
    const d = h.T.walletTxns.find((t) => t.transactionType === 'DEBIT_ADJUSTMENT')!;
    expect(d).toMatchObject({
      points: -320, pointsDelta: -320, balanceBefore: 100, balanceAfter: -220, referenceType: 'CREDIT_BATCH', referenceId: 'B2',
      description: '320 points deducted — Field, May 2026 · sales returns',
      metadata: { kind: 'UPLOAD_DEDUCTION', outletCode: 'O1', fieldId: 'F', fieldName: 'Field', period: '2026-05', rowNum: 3 },
    });
    expect(d.seq).toBe(2);
    const ledger = h.T.ledger.find((l) => l.id === d.pointsLedgerId)!;
    expect(ledger).toMatchObject({ transactionType: 'ADJUST', points: -320, remainingPoints: 0, sourceType: 'CREDIT_FIELD', sourceId: 'F' });
    // the credit lot was consumed (holdings were 100)
    expect(h.T.ledger.filter((l) => l.points > 0).reduce((n, l) => n + l.remainingPoints, 0)).toBe(0);
    // future earnings repay the debt first
    await h.confirm('B3', [{ outlet: 'O1', amount: 500 }]);
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: 280, debtPoints: 0 });
    expect(h.T.ledger.filter((l) => l.points > 0).reduce((n, l) => n + l.remainingPoints, 0)).toBe(280); // lot mirror = B + D
  });

  it('credits and deductions of one batch are applied together — credits first, then deductions', async () => {
    const h = world();
    ON(h);
    const res = (await deductBatch(h, 'B1', [{ outlet: 'O1', field: 'G', amount: -200 }, { outlet: 'O1', field: 'F', amount: 500 }])) as Row;
    expect(res).toMatchObject({ pointsCredited: 1, pointsCreditedTotal: 500, pointsDeducted: 1, pointsDeductedTotal: 200 });
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: 300, debtPoints: 0 });
    expect(h.T.walletTxns.map((t) => [t.transactionType, t.points])).toEqual([['CREDIT_POINTS_EARNED', 500], ['DEBIT_ADJUSTMENT', -200]]);
  });

  it('an outlet that cannot be resolved is skipped WITH its reason (NOT deducted), never silently', async () => {
    const h = world();
    ON(h);
    const res = (await deductBatch(h, 'B1', [{ outlet: 'O9', amount: -50 }])) as Row;
    expect(res.skipped).toEqual([{ outletId: 'O9', fieldName: 'Field', points: -50, reason: 'OUTLET_NOT_FOUND', kind: 'DEDUCTION' }]);
    expect(res).toMatchObject({ pointsDeducted: 0, pointsDeductedTotal: 0 });
  });

  it('a wallet with UN-sequenced history refuses the WHOLE confirm (nothing credited or deducted), named and audited', async () => {
    const h = world({ outlets: { O1: 'cp1', O4: 'cp3' }, wallets: [blankWallet('w-cp3', 'cp3', { redeemablePoints: 40 })] });
    ON(h);
    const err = await errorOf(deductBatch(h, 'B1', [{ outlet: 'O1', amount: 500 }, { outlet: 'O4', amount: -100 }]));
    // U2: tenant-facing wording; the Gifsy runbook pointer is only in the audit row
    expect(err).toBe("ReversalAttentionException: Some outlets' wallets aren't ready for deductions yet — ask Gifsy to prepare them, then upload again. Outlets: O4. Nothing was credited or deducted.");
    expect(h.T.batches.find((b) => b.id === 'B1')!.status).toBe('PENDING_CONFIRM');
    expect(h.T.walletTxns).toHaveLength(0);
    expect(h.w('cp3')).toMatchObject({ redeemablePoints: 40, movementSeq: 0 });
    expect(h.T.auditLogs.filter((a) => a.entityType === 'REVERSAL_ENGINE_REFUSAL').map((a) => [a.metadata.phase, a.metadata.code])).toEqual([
      ['CONFIRM_DEDUCTION', 'WALLET_NOT_SEQUENCED'],
    ]);
    expect(h.T.auditLogs.find((a) => a.entityType === 'REVERSAL_ENGINE_REFUSAL')!.metadata.gifsyNextStep).toMatch(/BAJAJ-PROD-FOLLOWUPS-RUNBOOK §C/);
    expect(h.T.auditLogs.filter((a) => a.entityType === 'CREDIT_BATCH')).toHaveLength(0); // round-3 #3: not logged twice
  });

  it('the movement itself refuses an un-sequenced wallet (defence in depth, under the wallet lock)', async () => {
    const h = world({ outlets: { O4: 'cp3' }, wallets: [blankWallet('w-cp3', 'cp3', { redeemablePoints: 40 })] });
    const err = await errorOf(
      (h.models as any).$transaction((tx: any) =>
        h.wallet.debitUploadDeduction(tx, {
          partnerId: 'cp3', points: 10, batchId: 'B1', outletCode: 'O4', fieldId: 'F', fieldName: 'Field', period: '2026-05', rowNum: 3,
        }),
      ),
    );
    expect(err).toMatch(/^ReversalAttentionException: Some outlets' wallets aren't ready for deductions yet/);
    expect(h.w('cp3').redeemablePoints).toBe(40);
  });

  it('atomic: a failure mid-confirm rolls back the credits too; the retry applies once; a second confirm never deducts twice', async () => {
    const h = world({ outlets: { O1: 'cp1', O2: 'cp2' } });
    ON(h);
    const real = h.wallet.debitUploadDeduction.bind(h.wallet);
    const spy = jest.spyOn(h.wallet, 'debitUploadDeduction').mockImplementationOnce(async () => {
      throw new Error('connection lost');
    });
    const err = await errorOf(deductBatch(h, 'B1', [{ outlet: 'O1', amount: 500 }, { outlet: 'O2', amount: -100 }]));
    expect(err).toBe('Error: connection lost');
    expect(h.T.batches.find((b) => b.id === 'B1')!.status).toBe('PENDING_CONFIRM');
    expect(h.T.walletTxns).toHaveLength(0);
    spy.mockImplementation(real);
    const res = (await h.credits.confirmBatch(adminUser, 'B1', await ackFor(h.credits, h.models, 'B1'))) as Row;
    expect(res).toMatchObject({ pointsCreditedTotal: 500, pointsDeductedTotal: 100 });
    expect(h.w('cp2')).toMatchObject({ redeemablePoints: -100, debtPoints: 100 });
    expect(await errorOf(h.credits.confirmBatch(adminUser, 'B1', { acknowledged: [...ALL_ACKS] }))).toBe('BadRequestException: Batch is already CONFIRMED');
    // round-3 #3: the claim race / already-confirmed refusal is not recorded as a refused confirm
    expect(h.T.auditLogs.filter((a) => a.entityType === 'CREDIT_BATCH')).toHaveLength(0);
    expect(h.T.walletTxns.filter((t) => t.transactionType === 'DEBIT_ADJUSTMENT')).toHaveLength(1);
  });

  it('undo: a per-row request gives the points back to the charged wallet, capped by what was deducted; the list labels it', async () => {
    const h = world();
    ON(h);
    await h.confirm('B1', [{ outlet: 'O1', amount: 100 }]);
    await deductBatch(h, 'B2', [{ outlet: 'O1', amount: -320 }]);
    expect(await errorOf(createUndo(h, 'B2', 'O1', 321))).toMatch(/Undo exceeds what was deducted .*deducted 320 pts, already given back 0 pts, requested 321 pts/);
    const r1 = (await createUndo(h, 'B2', 'O1', 200)) as Row;
    expect(r1).toMatchObject({ kind: 'DEDUCTION_UNDO', originalPaise: 320n, requestedPaise: 200n });
    // the pending request is labelled before approval
    const pending = await h.credits.listReversals(h.gifsy, {} as any);
    expect((pending.reversals as Row[]).find((r) => r.id === r1.id)).toMatchObject({ kind: 'DEDUCTION_UNDO' });
    const a1 = (await h.approve(r1.id, 120)) as Row; // partial approval
    expect(a1.pointsOutcome).toMatchObject({
      kind: 'DEDUCTION_UNDO', reversed: 120,
      headline: 'Partially approved (200 pts requested) · 120 pts given back to the wallet — deduction undone',
    });
    // the give-back repaid the debt first and is not new earning
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: -100, debtPoints: 100, earnedPoints: 100 });
    const back = h.T.walletTxns.find((t) => t.transactionType === 'CREDIT_REVERSAL')!;
    expect(back).toMatchObject({
      points: 120, referenceType: 'CREDIT_REVERSAL', creditReversalId: r1.id,
      description: '120 points given back — deduction undone (Field, May 2026)',
    });
    expect(back.reversedCreditTxId).toBe(h.T.walletTxns.find((t) => t.transactionType === 'DEBIT_ADJUSTMENT')!.id);
    const r2 = (await createUndo(h, 'B2', 'O1', 200)) as Row;
    await h.approve(r2.id);
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: 100, debtPoints: 0 }); // fully undone: B and D restored exactly
    expect(await errorOf(createUndo(h, 'B2', 'O1', 1))).toMatch(/already given back 320 pts/);
    const listed = await h.credits.listReversals(h.gifsy, {} as any);
    expect((listed.reversals as Row[]).find((r) => r.id === r2.id)).toMatchObject({
      kind: 'DEDUCTION_UNDO', pointsOutcome: { headline: 'Approved · 200 pts given back to the wallet — deduction undone' },
    });
  });

  it('undo approve re-checks the cap (nothing left to give back → refused, nothing moves)', async () => {
    const h = world();
    ON(h);
    await deductBatch(h, 'B1', [{ outlet: 'O1', amount: -100 }]);
    const r1 = (await createUndo(h, 'B1', 'O1', 100)) as Row;
    await h.approve(r1.id);
    // a second pending request for the same line (e.g. raised before the first approval landed)
    h.T.reversals.push({ ...h.T.reversals.find((r) => r.id === r1.id)!, id: 'second', status: 'PENDING_GIFSY', approvedPaise: null });
    h.T.auditLogs.push({ entityType: POINTS_REVERSAL_ENGINE_MARKER_ENTITY, entityId: 'second', metadata: { kind: 'UPLOAD_DEDUCTION_UNDO' } });
    expect(await errorOf(h.approve('second'))).toMatch(/Approval exceeds what is still to give back for this deduction .*still to give back 0 pts/);
    expect(h.w('cp1').redeemablePoints).toBe(0);
    expect(h.T.reversals.find((r) => r.id === 'second')!.status).toBe('PENDING_GIFSY');
  });
});

// ───────────────────────── Fix round (owner D1 / D2 / no-silent-failure acknowledgements, 2026-11-25) ─────────────────────────

describe('fix round — row guards (D1), undo once repaid (D2), expiry (F2 / L1), acknowledgements, batch outcome', () => {
  const ON = (h: World) => h.T.settings.set(`${TENANT}:creditUploadNegativeDeductions`, true);
  const adminUser = { sub: 'client-admin', role: 'CLIENT_ADMIN', clientId: TENANT } as JwtPayload;
  const push = (h: World, batchId: string, rows: Row[]) =>
    h.T.batches.push({
      id: batchId, clientId: TENANT, status: 'PENDING_CONFIRM', period: '2026-05', uploadedBy: 'client-admin',
      totalOutlets: rows.length, totalPoints: 0, totalPayoutPaise: 0n,
      rows: rows.map((r, i) => ({
        rowNum: i + 3, outletName: `Outlet ${r.outletId}`, fieldId: 'F', fieldName: 'Field', narration: '', awardType: 'POINTS', status: 'OK', ...r,
      })),
    });
  const confirm = async (h: World, batchId: string, acknowledged: string[] = [...ALL_ACKS]) =>
    h.credits.confirmBatch(adminUser, batchId, await ackFor(h.credits, h.models, batchId, acknowledged, { skippedRows: 7 }));
  const undo = (h: World, batchId: string, outlet: string, n: number) =>
    h.credits.createReversal(adminUser, batchId, {
      outletId: outlet, outletName: `Outlet ${outlet}`, fieldId: 'F', fieldName: 'Field',
      awardType: CreditAwardType.POINTS, originalPaise: n, requestedPaise: n,
    });

  it.each([
    ['an OK row of amount 0', { outletId: 'O1', amount: 0 }, /is marked OK but its amount is 0/],
    ['an OK PAYOUT row below zero', { outletId: 'O1', amount: -10000, awardType: 'PAYOUT' }, /^BadRequestException: Payout amounts can't be negative — use Reverse on Payout Status\./],
  ])('D1 (every tenant, at confirm — covers older pending batches): %s is refused, nothing written', async (_n, row, msg) => {
    const h = world();
    push(h, 'B1', [{ outletId: 'O1', amount: 100 }, row]);
    expect(await errorOf(confirm(h, 'B1'))).toMatch(msg);
    expect(h.T.walletTxns).toHaveLength(0);
    expect(h.T.batches[0].status).toBe('PENDING_CONFIRM');
  });

  it('D2: deduct → credit (repays the debt) → undo REFUSED at create; deduct → undo before any credit still works', async () => {
    const h = world({ outlets: { O1: 'cp1', O2: 'cp2' } });
    ON(h);
    push(h, 'B1', [{ outletId: 'O1', amount: -300 }, { outletId: 'O2', fieldId: 'F', amount: -200 }]);
    await confirm(h, 'B1');
    push(h, 'B2', [{ outletId: 'O1', amount: 500 }]);
    await confirm(h, 'B2');
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: 200, debtPoints: 0 });
    expect(await errorOf(undo(h, 'B1', 'O1', 300))).toMatch(
      /^BadRequestException: Can't undo: points were added to this wallet after the deduction on \d{2} \w{3} \d{4}\. Give the points back with a manual credit instead\.$/,
    );
    // no credit after O2's deduction → its undo works
    const r = (await undo(h, 'B1', 'O2', 200)) as Row;
    await h.approve(r.id);
    expect(h.w('cp2')).toMatchObject({ redeemablePoints: 0, debtPoints: 0 });
    // Payout Status reads the same rule from the actual wallet rows
    const detail = (await h.credits.getBatch(adminUser, 'B1')) as Row;
    expect(detail.deductionLines).toEqual([
      { outletId: 'O1', fieldId: 'F', points: 300, givenBack: 0, undoBlockedReason: expect.stringMatching(/^Can't undo: points were added to this wallet after the deduction on /), pastExpiryPoints: 0 },
      { outletId: 'O2', fieldId: 'F', points: 200, givenBack: 200, undoBlockedReason: null, pastExpiryPoints: 0 },
    ]);
  });

  it('D2 at approve (re-checked under the wallet lock): requested before the credit, approved after it → refused, nothing moves', async () => {
    const h = world();
    ON(h);
    push(h, 'B1', [{ outletId: 'O1', amount: -300 }]);
    await confirm(h, 'B1');
    const r = (await undo(h, 'B1', 'O1', 300)) as Row;
    push(h, 'B2', [{ outletId: 'O1', amount: 500 }]);
    await confirm(h, 'B2');
    expect(await errorOf(h.approve(r.id))).toMatch(/Can't undo: points were added to this wallet after the deduction/);
    expect(h.w('cp1').redeemablePoints).toBe(200);
    expect(h.T.reversals.find((x) => x.id === r.id)!.status).toBe('PENDING_GIFSY');
  });

  it('F2: due lots are expired (EXPIRE recorded) BEFORE the deduction; L1: the undo restores the earliest expiry of the lots it consumed', async () => {
    const h = world();
    ON(h);
    await h.confirm('B0', [{ outlet: 'O1', amount: 100 }]);
    await h.confirm('B00', [{ outlet: 'O1', field: 'H', amount: 50 }]);
    const lots = h.T.ledger.filter((l) => l.points > 0);
    lots[0].expiresAt = new Date(Date.now() - 60_000); // due, not swept
    const later2 = new Date(Date.now() + 10 * 86_400_000);
    lots[1].expiresAt = later2;
    push(h, 'B1', [{ outletId: 'O1', amount: -30 }]);
    await confirm(h, 'B1');
    // 100 expired first (an EXPIRE row), then 30 deducted from the 50 that were still valid
    expect(h.T.walletTxns.map((t) => [t.transactionType, t.points])).toEqual([
      ['CREDIT_POINTS_EARNED', 100], ['CREDIT_POINTS_EARNED', 50], ['DEBIT_EXPIRY', -100], ['DEBIT_ADJUSTMENT', -30],
    ]);
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: 20, debtPoints: 0, expiredPoints: 100 });
    const d = h.T.walletTxns.find((t) => t.transactionType === 'DEBIT_ADJUSTMENT')!;
    expect(d.metadata).toMatchObject({ debtCreated: 0, consumedLotPoints: 30, giveBackSegments: [{ points: 30, expiresAt: later2.toISOString() }] });
    const r = (await undo(h, 'B1', 'O1', 30)) as Row;
    await h.approve(r.id);
    const back = h.T.walletTxns.find((t) => t.transactionType === 'CREDIT_REVERSAL')!;
    expect(h.T.ledger.find((l) => l.id === back.pointsLedgerId)!.expiresAt).toEqual(later2);
  });

  it('acknowledgements: a category present but not ticked → 400 naming it, nothing written; ticked → confirmed and recorded with what was not applied', async () => {
    const h = world({ outlets: { O1: 'cp1', O2: null } });
    ON(h);
    push(h, 'B1', [
      { outletId: 'O1', amount: 200, originalAmount: 199.5 },
      { outletId: 'O1', fieldId: 'G', amount: -500 },
      { outletId: 'O2', amount: 40 }, // not linked → not applied
    ]);
    const err = await errorOf(confirm(h, 'B1', ['ROUNDED']));
    expect(err).toBe(
      'BadRequestException: Before confirming, reload the page and tick: rows that will not be applied (outlet not found or not linked) (1); wallets that will go below zero (1). Nothing was credited or deducted — the batch is still waiting.',
    );
    expect(h.T.walletTxns).toHaveLength(0);
    // audit #5: the refused confirm is recorded too, with what was missing
    expect(h.T.auditLogs.filter((a) => a.entityType === 'CREDIT_BATCH').map((a) => [a.action, a.entityId, a.metadata.event, a.metadata.missingAcknowledgements])).toEqual([
      ['REJECT', 'B1', 'CREDIT_BATCH_CONFIRM_REFUSED', ['NOT_APPLIED', 'BELOW_ZERO']],
    ]);
    await confirm(h, 'B1', ['ROUNDED', 'NOT_APPLIED', 'BELOW_ZERO', 'SKIPPED']);
    const row = h.T.auditLogs.find((a) => a.entityType === 'CREDIT_BATCH_CONFIRM')!;
    expect(row).toMatchObject({
      entityId: 'B1', actorId: 'client-admin',
      metadata: {
        acknowledged: ['ROUNDED', 'NOT_APPLIED', 'BELOW_ZERO', 'SKIPPED'],
        required: { ROUNDED: 1, NOT_APPLIED: 1, BELOW_ZERO: 1 },
        acknowledgedItems: { ROUNDED: ['O1|F|POINTS|200|199.5'], NOT_APPLIED: ['O2|F'], BELOW_ZERO: ['cp1|-300'] },
        skippedRowsReported: 7,
        notAppliedCount: 1,
        notApplied: [{ outletId: 'O2', fieldName: 'Field', points: 40, reason: 'OUTLET_NOT_LINKED_TO_PARTNER' }],
      },
    });
    const detail = (await h.credits.getBatch(adminUser, 'B1')) as Row;
    expect(detail).toMatchObject({ acknowledged: ['ROUNDED', 'NOT_APPLIED', 'BELOW_ZERO', 'SKIPPED'], notApplied: [{ outletId: 'O2' }] });
  });

  it('D2 strict: deductA → credit → deductB → undo A refused, undo B ok; partial undo → credit → undo the rest refused', async () => {
    const h = world();
    ON(h);
    push(h, 'BA', [{ outletId: 'O1', amount: -100 }]);
    await confirm(h, 'BA');
    push(h, 'BC', [{ outletId: 'O1', amount: 500 }]);
    await confirm(h, 'BC');
    push(h, 'BB', [{ outletId: 'O1', amount: -80 }]);
    await confirm(h, 'BB');
    expect(await errorOf(undo(h, 'BA', 'O1', 100))).toMatch(/Can't undo: points were added to this wallet after the deduction/);
    const rb = (await undo(h, 'BB', 'O1', 30)) as Row; // partial undo of B (no credit after B)
    await h.approve(rb.id);
    // the give-back of B itself never blocks B's own rest…
    const rb2 = (await undo(h, 'BB', 'O1', 20)) as Row;
    await h.approve(rb2.id);
    // …but any other credit after B does
    push(h, 'BD', [{ outletId: 'O1', amount: 5 }]);
    await confirm(h, 'BD');
    expect(await errorOf(undo(h, 'BB', 'O1', 30))).toMatch(/Can't undo: points were added to this wallet after the deduction/);
    expect(h.w('cp1').redeemablePoints).toBe(-100 + 500 - 80 + 30 + 20 + 5);
  });

  it('money audit #1: an undo returns each consumed lot with ITS OWN expiry (reverse of consumption), the debt part with the normal expiry', async () => {
    const h = world();
    ON(h);
    await h.confirm('B0', [{ outlet: 'O1', amount: 50 }]);
    await h.confirm('B00', [{ outlet: 'O1', field: 'H', amount: 50 }]);
    const [l1, l2] = h.T.ledger.filter((l) => l.points > 0);
    const e1 = new Date(Date.now() + 5 * 86_400_000);
    l1.expiresAt = e1; // l2 never expires
    push(h, 'B1', [{ outletId: 'O1', amount: -150 }]); // consumes l1 50, l2 50, then 50 becomes debt
    await confirm(h, 'B1');
    const d = h.T.walletTxns.find((t) => t.transactionType === 'DEBIT_ADJUSTMENT')!;
    expect(d.metadata).toMatchObject({
      debtCreated: 50,
      giveBackSegments: [{ points: 50, expiresAt: 'NEW' }, { points: 50, expiresAt: null }, { points: 50, expiresAt: e1.toISOString() }],
    });
    const r = (await undo(h, 'B1', 'O1', 120)) as Row; // partial: debt 50, l2 50, l1 20
    await h.approve(r.id);
    const backs = h.T.walletTxns.filter((t) => t.transactionType === 'CREDIT_REVERSAL');
    expect(backs.map((b) => [b.points, h.T.ledger.find((l) => l.id === b.pointsLedgerId)!.expiresAt ?? null])).toEqual([
      [50, null], // normal expiry for a new credit (no expiry config in this world → null)
      [50, null], // l2 never expires
      [20, e1],
    ]);
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: 70, debtPoints: 0 });
    const r2 = (await undo(h, 'B1', 'O1', 30)) as Row; // the rest: l1's remaining 30
    await h.approve(r2.id);
    const last = h.T.walletTxns.filter((t) => t.transactionType === 'CREDIT_REVERSAL').at(-1)!;
    expect([last.points, h.T.ledger.find((l) => l.id === last.pointsLedgerId)!.expiresAt]).toEqual([30, e1]);
  });

  it('audit #7: debtCreated is the wallet\'s ACTUAL debt change (a wallet already in debt); a B + D < 0 wallet is refused as inconsistent', async () => {
    const h = world({ outlets: { O1: 'cp1', O2: 'cp2' }, wallets: [blankWallet('w-cp2', 'cp2', { redeemablePoints: -100, debtPoints: 0, movementSeq: 5 })] });
    ON(h);
    push(h, 'B1', [{ outletId: 'O1', amount: -300 }]);
    await confirm(h, 'B1');
    push(h, 'B2', [{ outletId: 'O1', amount: -50 }]);
    await confirm(h, 'B2');
    const rows = h.T.walletTxns.filter((t) => t.transactionType === 'DEBIT_ADJUSTMENT');
    expect(rows.map((t) => t.metadata.debtCreated)).toEqual([300, 50]);
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: -350, debtPoints: 350 });
    push(h, 'B3', [{ outletId: 'O2', amount: -10 }]);
    expect(await errorOf(confirm(h, 'B3'))).toMatch(/points state is inconsistent/);
    expect(h.w('cp2')).toMatchObject({ redeemablePoints: -100, debtPoints: 0 });
  });

  it('audit #5: a D1 refusal at confirm is recorded (CREDIT_BATCH_CONFIRM_REFUSED) with its reason', async () => {
    const h = world();
    push(h, 'B1', [{ outletId: 'O1', amount: -5 }]); // switch OFF
    expect(await errorOf(confirm(h, 'B1'))).toMatch(/Deductions are switched off/);
    const row = h.T.auditLogs.find((a) => a.entityType === 'CREDIT_BATCH')!;
    expect(row).toMatchObject({ action: 'REJECT', entityId: 'B1', metadata: { event: 'CREDIT_BATCH_CONFIRM_REFUSED', status: 400, reason: expect.stringMatching(/^Deductions are switched off/) } });
  });

  it('U2 / U4: the tick check subtracts points due to expire first and counts a held opening balance only when it would post', async () => {
    const h = world();
    ON(h);
    await h.confirm('B0', [{ outlet: 'O1', amount: 100 }]);
    h.T.ledger.find((l) => l.points > 0)!.expiresAt = new Date(Date.now() - 1000); // all 100 due
    const preview = await h.credits.uploadPreview(adminUser, { outletCodes: ['O1'], period: '2026-05', lines: [] });
    expect(preview.outlets[0]).toMatchObject({ balance: 100, dueExpiry: 100, heldOpeningBalance: null });
    // −60 looks covered by the 100 balance, but those 100 expire first → the wallet goes below zero → tick required
    push(h, 'B1', [{ outletId: 'O1', amount: -60 }]);
    expect(await errorOf(confirm(h, 'B1', []))).toMatch(/wallets that will go below zero \(1\)/);
  });

  it('round-3 #1: undo give-backs never block — field A + B on one wallet: undo A then undo B; duplicate rows on one line: partial then the rest', async () => {
    const h = world();
    ON(h);
    push(h, 'B1', [{ outletId: 'O1', amount: -100 }, { outletId: 'O1', fieldId: 'G', fieldName: 'Returns', amount: -40 }]);
    await confirm(h, 'B1');
    const ra = (await undo(h, 'B1', 'O1', 100)) as Row;
    await h.approve(ra.id);
    const rb = (await h.credits.createReversal(adminUser, 'B1', {
      outletId: 'O1', outletName: 'Outlet O1', fieldId: 'G', fieldName: 'Returns', awardType: CreditAwardType.POINTS, originalPaise: 40, requestedPaise: 40,
    })) as Row;
    await h.approve(rb.id);
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: 0, debtPoints: 0 });
    // duplicate rows (d1 + d2) on one line
    push(h, 'B2', [{ outletId: 'O1', amount: -30 }, { outletId: 'O1', amount: -20 }]);
    await confirm(h, 'B2');
    const p1 = (await undo(h, 'B2', 'O1', 35)) as Row; // all of d1 + 5 of d2
    await h.approve(p1.id);
    const p2 = (await undo(h, 'B2', 'O1', 15)) as Row; // the rest
    await h.approve(p2.id);
    expect(h.w('cp1')).toMatchObject({ redeemablePoints: 0, debtPoints: 0 });
    // a real credit still blocks
    push(h, 'B3', [{ outletId: 'O1', amount: -10 }]);
    await confirm(h, 'B3');
    push(h, 'B4', [{ outletId: 'O1', amount: 7 }]);
    await confirm(h, 'B4');
    expect(await errorOf(undo(h, 'B3', 'O1', 10))).toMatch(/Can't undo: points were added to this wallet after the deduction/);
    const detail = (await h.credits.getBatch(adminUser, 'B3')) as Row;
    expect(detail.deductionLines[0].undoBlockedReason).toMatch(/Can't undo/);
  });

  it('U1 round 3: a tick binds to the exact items — the balance moved after the tick → refused, the server returns the row to re-show', async () => {
    const h = world();
    ON(h);
    await h.confirm('B0', [{ outlet: 'O1', amount: 100 }]);
    push(h, 'B1', [{ outletId: 'O1', amount: -300 }]);
    const ticked = await ackFor(h.credits, h.models, 'B1'); // BELOW_ZERO: w-cp1 100 → −200
    expect(ticked.ackItems).toEqual({ BELOW_ZERO: ['cp1|-200'] });
    await h.confirm('B9', [{ outlet: 'O1', field: 'H', amount: 50 }]); // the balance moves: now 150 → −150
    let e: any;
    try { await h.credits.confirmBatch(adminUser, 'B1', ticked); } catch (x) { e = x; }
    expect(e.getResponse()).toMatchObject({
      details: { missingAcknowledgements: ['BELOW_ZERO'], items: { BELOW_ZERO: [{ key: 'cp1|-150', text: 'Wallet of O1: 150 pts → −150 pts' }] } },
    });
    expect(h.T.walletTxns.filter((t) => t.transactionType === 'DEBIT_ADJUSTMENT')).toHaveLength(0);
    await h.credits.confirmBatch(adminUser, 'B1', { acknowledged: ['BELOW_ZERO'], ackItems: { BELOW_ZERO: ['cp1|-150'] } });
    expect(h.w('cp1').redeemablePoints).toBe(-150);
  });

  it('round-3 #4: points coming back on a lot already past its expiry are said so (passbook line + approve outcome + request reply)', async () => {
    const h = world();
    ON(h);
    await h.confirm('B0', [{ outlet: 'O1', amount: 100 }]);
    const lot = h.T.ledger.find((l) => l.points > 0)!;
    lot.expiresAt = new Date(Date.now() + 60 * 60_000); // valid when the deduction consumes it
    push(h, 'B1', [{ outletId: 'O1', amount: -40 }]);
    await confirm(h, 'B1');
    // the consumed lot's expiry passes before the undo
    const d = h.T.walletTxns.find((t) => t.transactionType === 'DEBIT_ADJUSTMENT')!;
    d.metadata.giveBackSegments = [{ points: 40, expiresAt: new Date(Date.now() - 1000).toISOString() }];
    const r = (await undo(h, 'B1', 'O1', 40)) as Row;
    expect(r.pastExpiryPoints).toBe(40);
    const a = (await h.approve(r.id)) as Row;
    expect(a.pointsOutcome.headline).toBe(
      'Approved · 40 pts given back to the wallet — deduction undone · 40 pts returned already past their expiry and will expire at the next sweep',
    );
    expect(h.T.walletTxns.find((t) => t.transactionType === 'CREDIT_REVERSAL')!.description).toBe(
      '40 points given back — deduction undone (Field, May 2026) · 40 pts returned already past their expiry and will expire at the next sweep',
    );
  });

  it('a clean batch needs no acknowledgement (confirms exactly as before) and a repeat deduction must be acknowledged', async () => {
    const h = world();
    ON(h);
    await h.confirm('B0', [{ outlet: 'O1', amount: 1000 }]);
    push(h, 'B1', [{ outletId: 'O1', amount: -100 }]);
    await confirm(h, 'B1', []); // clean: no category present
    push(h, 'B2', [{ outletId: 'O1', amount: -100 }]);
    expect(await errorOf(confirm(h, 'B2', []))).toMatch(/deductions that may be a repeat \(1\)/);
    const preview = await h.credits.uploadPreview(adminUser, { outletCodes: ['O1'], period: '2026-05', lines: [{ outletCode: 'O1', fieldId: 'F' }] });
    expect(preview).toMatchObject({
      deductionsEnabled: true,
      ackCategories: ['SKIPPED', 'ROUNDED', 'NOT_APPLIED', 'BELOW_ZERO', 'REPEAT_DEDUCTION'],
      outlets: [{ outletCode: 'O1', found: true, linked: true, walletId: 'w-cp1', partnerId: 'cp1', balance: 900, heldOpeningBalance: null, dueExpiry: 0, ready: true }],
      priorDeductions: [{ outletCode: 'O1', fieldId: 'F', batchId: 'B1', points: 100, givenBack: 0 }],
    });
  });
});
