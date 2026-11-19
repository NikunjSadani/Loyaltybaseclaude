/**
 * WP6 backfill + verify — fixture-based specs (no database). Covers the design §15 rows WP6 owns: legacy credits,
 * relinked outlets (T-f1/T-f2), unresolved credits, historical clawbacks (T-h2, Q13), negative wallets (Bajaj's 8),
 * expiry lots, Deoleo parity (I5) — plus idempotency (run twice = same result) and resume mid-way.
 */
import {
  BfBatch,
  BfLedgerRow,
  BfReversal,
  BfTenantContext,
  BfTxRow,
  BfWalletHistory,
  orderChain,
  planIdentity,
  planTenant,
  planWallet,
  summarizeTenant,
  WalletPlan,
} from './backfill-plan';
import { ApplyOutcome, BackfillStore, runBackfill, BackfillConfig, PausePriorState, PayoutBackfillInput } from './backfill-runner';
import type { PlannedPayoutAllocation } from '../../credits/payout-reversal-v2';
import {
  assertWalletGuard,
  computeV0,
  reconcileV0Wallets,
  runVerifyChecks,
  V0_FIELDS,
  V0Snapshot,
  V0WalletRow,
  v0RowsOf,
  VerifySnapshot,
  VWallet,
  WalletGuardState,
} from './verify-checks';
import { runVerify, verifyConfigFromEnv } from './verify.main';
import { configFromEnv } from './backfill.main';

// ───────────────────────────── fixture builder ─────────────────────────────

const T0 = Date.parse('2026-04-01T00:00:00Z');

type Step =
  | { k: 'credit'; id: string; pts: number; batch?: string; meta?: { fieldId: string; outletCode?: string }; type?: string; at?: number }
  | { k: 'redeem'; id: string; pts: number; at?: number }
  | { k: 'vdebit'; id: string; pts: number; at?: number }
  | { k: 'expiry'; id: string; pts: number; lot: string; at?: number }
  | { k: 'claw'; id: string; pts: number; reversal: string; creditMeta?: string; at?: number }
  | { k: 'raw'; id: string; pts: number; balanceAfter: number; type: string; at?: number };

interface WalletSpec {
  id: string;
  clientId: string;
  outlets?: string[];
  steps: Step[];
  extraLedgers?: Partial<BfLedgerRow>[];
}

interface Built {
  history: BfWalletHistory;
  counters: Omit<VWallet, 'id' | 'redeemablePoints' | 'debtPoints' | 'movementSeq'>;
}

function build(spec: WalletSpec): Built {
  let cur = 0;
  const txs: BfTxRow[] = [];
  const ledgers: BfLedgerRow[] = [];
  const counters = { earnedPoints: 0, lifetimeEarned: 0, redeemedPoints: 0, expiredPoints: 0, lifetimeRedeemed: 0, lifetimeExpired: 0, lockedPoints: 0 };
  spec.steps.forEach((s, i) => {
    const createdAt = new Date(T0 + (s.at ?? i * 1000));
    let points = s.pts;
    let delta: number;
    let transactionType: string;
    let referenceType: string | null = null;
    let referenceId: string | null = null;
    let description: string | null = null;
    let metadata: unknown = null;
    let sourceType: string | null = null;
    let sourceId: string | null = null;
    switch (s.k) {
      case 'credit':
        transactionType = s.type ?? 'CREDIT_POINTS_EARNED';
        delta = s.pts;
        if (s.batch) {
          referenceType = 'CREDIT_BATCH';
          referenceId = s.batch;
          sourceType = 'CREDIT_FIELD';
          sourceId = s.meta?.fieldId ?? null;
        }
        if (s.meta) metadata = { ...s.meta };
        description = `credit ${s.id}`;
        counters.earnedPoints += s.pts;
        counters.lifetimeEarned += s.pts;
        break;
      case 'redeem':
        transactionType = 'DEBIT_REDEMPTION';
        points = -s.pts;
        delta = -s.pts;
        referenceType = 'REDEMPTION_ORDER';
        description = 'Points redeemed';
        counters.redeemedPoints += s.pts;
        counters.lifetimeRedeemed += s.pts;
        break;
      case 'vdebit':
        transactionType = 'DEBIT_ADJUSTMENT';
        points = -s.pts;
        delta = -s.pts;
        description = 'Points reversed';
        break;
      case 'expiry':
        transactionType = 'DEBIT_EXPIRY';
        points = -s.pts;
        delta = -s.pts;
        referenceType = 'POINTS_LEDGER';
        referenceId = s.lot;
        description = 'Points expired';
        counters.expiredPoints += s.pts;
        counters.lifetimeExpired += s.pts;
        break;
      case 'claw':
        transactionType = 'DEBIT_ADJUSTMENT';
        points = -s.pts;
        delta = -Math.max(0, Math.min(s.pts, cur)); // legacy floor at 0
        referenceType = 'CREDIT_REVERSAL';
        referenceId = s.reversal;
        description = `Clawback for reversal ${s.reversal}`;
        if (s.creditMeta) metadata = { reversedCreditTxId: s.creditMeta };
        break;
      case 'raw':
        transactionType = s.type;
        delta = s.balanceAfter - cur;
        description = `raw ${s.id}`;
        break;
    }
    const balanceBefore = cur;
    cur += delta;
    if (s.k === 'raw') cur = s.balanceAfter;
    txs.push({
      id: s.id,
      walletId: spec.id,
      transactionType,
      points,
      balanceBefore,
      balanceAfter: cur,
      balanceType: 'REDEEMABLE',
      referenceType,
      referenceId,
      description,
      metadata,
      createdAt,
      seq: null,
      pointsDelta: null,
      reversedCreditTxId: null,
      creditReversalId: null,
      pointsLedgerId: null,
    });
    ledgers.push({
      id: `L-${s.id}`,
      walletId: spec.id,
      transactionType: points > 0 ? 'EARN' : 'ADJUST',
      points,
      isExpired: false,
      sourceType,
      sourceId,
      notes: description,
      createdAt: new Date(createdAt.getTime() - (metadata ? 5 : 0)),
    });
  });
  for (const e of spec.extraLedgers ?? []) {
    ledgers.push({ id: 'X', walletId: spec.id, transactionType: 'EARN', points: 0, isExpired: false, sourceType: null, sourceId: null, notes: null, createdAt: new Date(T0), ...e });
  }
  return {
    history: {
      wallet: { id: spec.id, partnerId: `P-${spec.id}`, clientId: spec.clientId, redeemablePoints: cur, debtPoints: 0, movementSeq: 0 },
      txs,
      ledgers,
      currentOutletCodes: spec.outlets ?? [],
      existingPositionCount: 0,
    },
    counters,
  };
}

function ctxOf(clientId: string, batches: BfBatch[] = [], reversals: BfReversal[] = []): BfTenantContext {
  return {
    clientId,
    batches: new Map(batches.map((b) => [b.id, b])),
    reversals: new Map(reversals.map((r) => [r.id, r])),
    alreadyAllocatedReversalIds: new Set(),
  };
}

const row = (outletId: string, fieldId: string, amount: number, status = 'OK') => ({ outletId, fieldId, amount, awardType: 'POINTS', status });
const rev = (id: string, clientId: string, batchId: string, outletId: string, fieldId: string, approved: number, status = 'APPROVED'): BfReversal => ({
  id,
  clientId,
  batchId,
  outletId,
  fieldId,
  awardType: 'POINTS',
  status,
  approvedPaise: BigInt(approved),
});
const blocking = (p: WalletPlan) => p.anomalies.filter((a) => a.severity === 'BLOCKING').map((a) => a.code);
const warnings = (p: WalletPlan) => p.anomalies.filter((a) => a.severity === 'WARNING').map((a) => a.code);

// ───────────────────────────── shared tenant fixtures ─────────────────────────────

// Deoleo (never negative): metadata credits, a redemption, a historical clawback with shortfall, an expiry.
function deoleoFixture() {
  const b1: BfBatch = { id: 'B1', clientId: 'deoleo', rows: [row('O1', 'F1', 500), row('O2', 'F1', 300)] };
  const wallets: WalletSpec[] = [
    {
      id: 'W-D1',
      clientId: 'deoleo',
      outlets: ['O1', 'O2'],
      steps: [
        { k: 'credit', id: 'd1c1', pts: 500, batch: 'B1', meta: { fieldId: 'F1', outletCode: 'O1' } },
        { k: 'credit', id: 'd1c2', pts: 300, batch: 'B1', meta: { fieldId: 'F1', outletCode: 'O2' } },
        { k: 'redeem', id: 'd1r1', pts: 600 },
        { k: 'claw', id: 'd1k1', pts: 500, reversal: 'R1', creditMeta: 'd1c1' },
      ],
    },
    {
      id: 'W-D2',
      clientId: 'deoleo',
      steps: [
        { k: 'credit', id: 'd2c1', pts: 300, type: 'CREDIT_BONUS' },
        { k: 'expiry', id: 'd2e1', pts: 100, lot: 'L-d2c1' },
        { k: 'redeem', id: 'd2r1', pts: 50 },
      ],
    },
    { id: 'W-D3', clientId: 'deoleo', steps: [] },
  ];
  return { ctx: ctxOf('deoleo', [b1], [rev('R1', 'deoleo', 'B1', 'O1', 'F1', 500)]), wallets };
}

// Bajaj prod's 8 negative wallets (vendor "Points reversed" history), −840 … −280 = −3,549, + one positive wallet.
const BAJAJ_NEG = [-840, -612, -520, -360, -360, -297, -280, -280];
function bajajFixture() {
  const wallets: WalletSpec[] = BAJAJ_NEG.map((n, i) =>
    i === 2
      ? {
          // −520 reached through debt that a later vendor earn partly repaid: 100 − 800 → −700 (D 700) + 180 → −520 (D 520)
          id: `W-B${i}`,
          clientId: 'bajaj',
          steps: [
            { k: 'credit' as const, id: `b${i}e1`, pts: 100 },
            { k: 'vdebit' as const, id: `b${i}v1`, pts: 800 },
            { k: 'credit' as const, id: `b${i}e2`, pts: 180 },
          ],
        }
      : {
          id: `W-B${i}`,
          clientId: 'bajaj',
          steps: [
            { k: 'credit' as const, id: `b${i}e1`, pts: 1000 },
            { k: 'redeem' as const, id: `b${i}r1`, pts: 400 },
            { k: 'vdebit' as const, id: `b${i}v1`, pts: 600 - n },
          ],
        },
  );
  wallets.push({
    id: 'W-BP',
    clientId: 'bajaj',
    steps: [
      { k: 'credit', id: 'bpe1', pts: 2000 },
      { k: 'redeem', id: 'bpr1', pts: 700 },
    ],
  });
  return { ctx: ctxOf('bajaj'), wallets };
}

// ───────────────────────────── in-memory store ─────────────────────────────

interface MemTenant {
  ctx: BfTenantContext;
  histories: Map<string, BfWalletHistory>;
  counters: Map<string, Built['counters']>;
}

class MemStore implements BackfillStore {
  tenants = new Map<string, MemTenant>();
  positions: { id: string; walletId: string; creditTxId: string; amount: number; offsetPoints: number; reversedPoints: number; attribution: string; clientId: string }[] = [];
  allocations: { positionId: string; creditReversalId: string; requested: number; recovered: number; owed: number; clientId: string }[] = [];
  payoutAllocations: { payoutEntryId: string; creditReversalId: string; state: string; clientId: string; amountPaise?: bigint }[] = [];
  /** policy round A: wallets.backfillStatus / reason */
  status = new Map<string, { status: 'DONE' | 'BLOCKED'; reason: string | null }>();
  /** Q5 pause switch per tenant + a log of every set / drain, in order */
  pause = new Map<string, PausePriorState>();
  pauseLog: string[] = [];
  /** WP5 payout planner input per tenant */
  payoutInput = new Map<string, Omit<PayoutBackfillInput, 'existingAllocations'>>();
  beforePayoutApply: (() => void) | null = null;
  writes = 0;
  applyCalls = 0;
  failOnApplyCall: number | null = null;
  beforeApply: ((walletId: string) => void) | null = null;
  /** simulates a DEFECTIVE backfill write: runs after the wallet's writes, inside the emulated transaction */
  corruptOnApply: ((walletId: string) => void) | null = null;

  constructor(public db = 'gifsy_test') {}

  add(clientId: string, ctx: BfTenantContext, specs: WalletSpec[]): this {
    const t: MemTenant = { ctx, histories: new Map(), counters: new Map() };
    for (const s of specs) {
      const b = build(s);
      t.histories.set(s.id, b.history);
      t.counters.set(s.id, b.counters);
    }
    this.tenants.set(clientId, t);
    return this;
  }

  private clone(h: BfWalletHistory): BfWalletHistory {
    return {
      wallet: { ...h.wallet },
      txs: h.txs.map((t) => ({ ...t, createdAt: new Date(t.createdAt) })),
      ledgers: h.ledgers.map((l) => ({ ...l })),
      currentOutletCodes: [...h.currentOutletCodes],
      existingPositionCount: this.positions.filter((p) => p.walletId === h.wallet.id).length,
    };
  }

  async currentDatabase() {
    return this.db;
  }
  async listTenants() {
    return [...this.tenants.keys()].sort();
  }
  async loadTenantContext(clientId: string) {
    const t = this.tenants.get(clientId)!;
    return { ...t.ctx, alreadyAllocatedReversalIds: new Set(this.allocations.filter((a) => a.clientId === clientId).map((a) => a.creditReversalId)) };
  }
  async loadTenantHistories(clientId: string) {
    return [...this.tenants.get(clientId)!.histories.values()].map((h) => this.clone(h));
  }
  private wallets(clientId: string): VWallet[] {
    const t = this.tenants.get(clientId)!;
    return [...t.histories.values()].map((h) => ({
      id: h.wallet.id,
      redeemablePoints: h.wallet.redeemablePoints,
      debtPoints: h.wallet.debtPoints,
      movementSeq: h.wallet.movementSeq,
      backfillStatus: this.status.get(h.wallet.id)?.status ?? null,
      ...t.counters.get(h.wallet.id)!,
    }));
  }
  async markWalletsBlocked(clientId: string, items: { walletId: string; reason: string }[]) {
    let n = 0;
    for (const it of items) {
      const h = this.tenants.get(clientId)!.histories.get(it.walletId);
      if (!h || h.wallet.movementSeq !== 0) continue;
      this.status.set(it.walletId, { status: 'BLOCKED', reason: it.reason });
      n++;
    }
    return n;
  }
  async getPointsReversalPause(clientId: string): Promise<PausePriorState> {
    return this.pause.get(clientId) ?? { paused: false, since: null };
  }
  async setPointsReversalPause(clientId: string, paused: boolean) {
    this.pause.set(clientId, { paused, since: paused ? 'T' : null });
    this.pauseLog.push(`${clientId}:${paused ? 'ON' : 'OFF'}`);
  }
  async drainPointsReversals(clientId: string) {
    this.pauseLog.push(`${clientId}:DRAIN`);
  }
  private payoutOf(clientId: string): PayoutBackfillInput {
    const pin = this.payoutInput.get(clientId) ?? { reversals: [], entries: [] };
    return {
      reversals: pin.reversals.map((r) => ({ ...r })),
      entries: pin.entries.map((e) => ({ ...e })),
      existingAllocations: this.payoutAllocations.filter((a) => a.clientId === clientId).map((a) => ({ creditReversalId: a.creditReversalId, payoutEntryId: a.payoutEntryId, state: a.state })),
    };
  }
  async loadPayoutBackfillInput(clientId: string) {
    return this.payoutOf(clientId);
  }
  async applyPayoutPlan(clientId: string, decide: (fresh: PayoutBackfillInput) => PlannedPayoutAllocation[] | null) {
    this.beforePayoutApply?.();
    const rows = decide(this.payoutOf(clientId));
    if (!rows) return { outcome: 'CHANGED' as const, inserted: 0 };
    for (const r of rows) {
      this.payoutAllocations.push({ payoutEntryId: r.payoutEntryId, creditReversalId: r.creditReversalId, state: r.state, clientId, amountPaise: r.amountPaise });
      this.writes++;
    }
    return { outcome: 'APPLIED' as const, inserted: rows.length };
  }
  async snapshotV0Wallets(clientId: string): Promise<V0WalletRow[]> {
    const t = this.tenants.get(clientId)!;
    return v0RowsOf(this.wallets(clientId), [...t.histories.values()].flatMap((h) => h.txs));
  }
  /** convenience for the verify specs (the V0 baseline APPLY prints) */
  async snapshotV0(clientId: string): Promise<V0Snapshot> {
    return computeV0(clientId, await this.snapshotV0Wallets(clientId));
  }
  /** mirror of the Prisma store's walletGuardState (figures + movement amounts + lots) */
  private guardState(clientId: string, walletId: string): WalletGuardState {
    const t = this.tenants.get(clientId)!;
    const h = t.histories.get(walletId)!;
    const w = this.wallets(clientId).find((x) => x.id === walletId)!;
    const txs = [...h.txs].sort((a, b) => (a.id < b.id ? -1 : 1)).map((x) => [x.id, x.transactionType, x.points, x.balanceBefore, x.balanceAfter, x.balanceType]);
    const lots = [...h.ledgers].sort((a, b) => (a.id < b.id ? -1 : 1)).map((l) => [l.id, l.transactionType, l.points, l.isExpired]);
    const s = { txCount: txs.length, txDigest: JSON.stringify(txs), lotCount: lots.length, lotDigest: JSON.stringify(lots) } as WalletGuardState;
    for (const f of V0_FIELDS) s[f] = w[f];
    return s;
  }
  async applyWalletPlan(walletId: string, clientId: string, decide: (fresh: BfWalletHistory) => WalletPlan | null): Promise<ApplyOutcome> {
    this.applyCalls++;
    if (this.failOnApplyCall === this.applyCalls) throw new Error('simulated crash');
    this.beforeApply?.(walletId);
    const live = this.tenants.get(clientId)!.histories.get(walletId)!;
    if (live.wallet.movementSeq > 0) return 'ALREADY_DONE';
    const plan = decide(this.clone(live));
    if (!plan) return 'CHANGED';
    // transaction emulation: everything below rolls back on a throw (guard miss or V0 wallet guard)
    const counters = this.tenants.get(clientId)!.counters.get(walletId)!;
    const saved = {
      wallet: { ...live.wallet },
      counters: { ...counters },
      txs: live.txs.map((x) => ({ ...x })),
      ledgers: live.ledgers.map((l) => ({ ...l })),
      positions: this.positions.length,
      allocations: this.allocations.length,
      status: this.status.get(walletId),
      writes: this.writes,
    };
    try {
      const guardBefore = this.guardState(clientId, walletId);
      const r = this.writePlanMem(live, plan, walletId, clientId);
      this.corruptOnApply?.(walletId);
      assertWalletGuard(walletId, guardBefore, this.guardState(clientId, walletId));
      return r;
    } catch (e) {
      Object.assign(live.wallet, saved.wallet);
      Object.assign(counters, saved.counters);
      live.txs = saved.txs;
      live.ledgers = saved.ledgers;
      this.positions.length = saved.positions;
      this.allocations.length = saved.allocations;
      if (saved.status) this.status.set(walletId, saved.status);
      else this.status.delete(walletId);
      this.writes = saved.writes;
      throw e;
    }
  }
  private writePlanMem(live: BfWalletHistory, plan: WalletPlan, walletId: string, clientId: string): ApplyOutcome {
    // guarded writes (mirror writePlan): all-or-nothing
    const txById = new Map(live.txs.map((t) => [t.id, t]));
    for (const u of plan.txUpdates) if (!txById.get(u.txId) || txById.get(u.txId)!.seq !== null) throw new Error('guard: tx');
    if (live.wallet.debtPoints !== 0 || live.wallet.redeemablePoints !== plan.redeemablePoints) throw new Error('guard: wallet');
    for (const u of plan.txUpdates) {
      const t = txById.get(u.txId)!;
      t.seq = u.seq;
      t.pointsDelta = u.pointsDelta;
      t.pointsLedgerId = u.pointsLedgerId;
      t.reversedCreditTxId = u.reversedCreditTxId;
      t.creditReversalId = u.creditReversalId;
      this.writes++;
    }
    for (const p of plan.positions) {
      this.positions.push({ id: `P-${p.creditTxId}`, walletId: p.walletId, creditTxId: p.creditTxId, amount: p.amount, offsetPoints: p.offsetPoints, reversedPoints: p.reversedPoints, attribution: p.attribution, clientId });
      this.writes++;
    }
    for (const a of plan.allocations) {
      if (this.allocations.some((x) => x.creditReversalId === a.creditReversalId && x.positionId === `P-${a.creditTxId}`)) throw new Error('unique');
      this.allocations.push({ positionId: `P-${a.creditTxId}`, creditReversalId: a.creditReversalId, requested: a.requested, recovered: a.recovered, owed: a.owed, clientId });
      this.writes++;
    }
    live.wallet.debtPoints = plan.debtPoints;
    live.wallet.movementSeq = plan.movementSeq;
    this.status.set(walletId, { status: 'DONE', reason: null });
    this.writes++;
    return 'APPLIED';
  }
  async loadVerifySnapshot(clientId: string): Promise<VerifySnapshot> {
    const t = this.tenants.get(clientId)!;
    return {
      clientId,
      wallets: this.wallets(clientId),
      txs: [...t.histories.values()].flatMap((h) => h.txs.map((x) => ({ id: x.id, walletId: x.walletId, seq: x.seq, pointsDelta: x.pointsDelta, balanceBefore: x.balanceBefore, balanceAfter: x.balanceAfter, transactionType: x.transactionType, referenceType: x.referenceType, referenceId: x.referenceId, points: x.points }))),
      positions: this.positions.filter((p) => p.clientId === clientId),
      allocations: this.allocations.filter((a) => a.clientId === clientId),
      payoutAllocations: this.payoutAllocations.filter((a) => a.clientId === clientId),
      payoutBackfill: this.payoutOf(clientId),
    };
  }
  /** full observable state, for run-twice / resume equality */
  state(): string {
    const ts = [...this.tenants.entries()].map(([c, t]) => [c, [...t.histories.values()].map((h) => ({ w: h.wallet, t: h.txs.map((x) => [x.id, x.seq, x.pointsDelta, x.pointsLedgerId, x.reversedCreditTxId, x.creditReversalId]) }))]);
    return JSON.stringify(
      { ts, p: this.positions, a: this.allocations, s: [...this.status.entries()].sort(), pa: this.payoutAllocations },
      (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
  }
}

const silent = () => undefined;
const cfg = (over: Partial<BackfillConfig> = {}): BackfillConfig => ({ expectedDb: 'gifsy_test', apply: false, confirm: undefined, ...over });
const applyCfg = (over: Partial<BackfillConfig> = {}) => cfg({ apply: true, confirm: 'APPLY gifsy_test', ...over });

function fullStore(): MemStore {
  const d = deoleoFixture();
  const b = bajajFixture();
  return new MemStore().add('deoleo', d.ctx, d.wallets).add('bajaj', b.ctx, b.wallets);
}

// ───────────────────────────── planner ─────────────────────────────

describe('WP6 backfill planner', () => {
  it('Deoleo-style wallet: seq + pointsDelta + ledger pairing, EXACT positions, D = 0 / O = 0 (I5), historical clawback classified', () => {
    const { ctx, wallets } = deoleoFixture();
    const p = planWallet(build(wallets[0]).history, ctx);
    expect(p.status).toBe('PLANNED');
    expect(blocking(p)).toEqual([]);
    expect(p.neverNegative).toBe(true);
    expect(p.debtPoints).toBe(0);
    expect(p.movementSeq).toBe(4);
    expect(p.txUpdates).toEqual([
      { txId: 'd1c1', seq: 1, pointsDelta: 500, pointsLedgerId: 'L-d1c1', reversedCreditTxId: null, creditReversalId: null },
      { txId: 'd1c2', seq: 2, pointsDelta: 300, pointsLedgerId: 'L-d1c2', reversedCreditTxId: null, creditReversalId: null },
      { txId: 'd1r1', seq: 3, pointsDelta: -600, pointsLedgerId: 'L-d1r1', reversedCreditTxId: null, creditReversalId: null },
      // legacy floor: B was 200 → only 200 came off (recorded), 300 = shortfall; kept as recorded (Q13)
      { txId: 'd1k1', seq: 4, pointsDelta: -200, pointsLedgerId: 'L-d1k1', reversedCreditTxId: 'd1c1', creditReversalId: 'R1' },
    ]);
    expect(p.positions).toEqual([
      { walletId: 'W-D1', creditTxId: 'd1c1', lotId: 'L-d1c1', batchId: 'B1', outletCode: 'O1', fieldId: 'F1', amount: 500, offsetPoints: 0, reversedPoints: 500, attribution: 'EXACT' },
      { walletId: 'W-D1', creditTxId: 'd1c2', lotId: 'L-d1c2', batchId: 'B1', outletCode: 'O2', fieldId: 'F1', amount: 300, offsetPoints: 0, reversedPoints: 0, attribution: 'EXACT' },
    ]);
    expect(p.allocations).toEqual([{ creditReversalId: 'R1', creditTxId: 'd1c1', requested: 500, debtRestored: 0, recovered: 200, owed: 0, shortfall: 300 }]);
  });

  it('never writes balances: the plan carries no balance / counter / lot field, and redeemablePoints is only a guard', () => {
    const { ctx, wallets } = deoleoFixture();
    const p = planWallet(build(wallets[0]).history, ctx);
    const keys = new Set([...p.txUpdates.flatMap((u) => Object.keys(u)), ...p.positions.flatMap((x) => Object.keys(x))]);
    for (const k of ['redeemablePoints', 'balanceAfter', 'balanceBefore', 'earnedPoints', 'remainingPoints', 'points']) expect(keys.has(k)).toBe(false);
    expect(p.redeemablePoints).toBe(build(wallets[0]).history.wallet.redeemablePoints);
  });

  it("Bajaj's 8 negative wallets: D = −B so H = 0 ≥ 0, Σ −3,549; balances untouched; a later earn repays debt first", () => {
    const { ctx, wallets } = bajajFixture();
    const tp = planTenant(ctx, wallets.map((w) => build(w).history));
    const neg = tp.wallets.filter((p) => p.redeemablePoints < 0);
    expect(neg).toHaveLength(8);
    expect(neg.map((p) => p.redeemablePoints).sort((a, b) => a - b)).toEqual([...BAJAJ_NEG].sort((a, b) => a - b));
    expect(neg.reduce((s, p) => s + p.redeemablePoints, 0)).toBe(-3549);
    for (const p of neg) {
      expect(p.status).toBe('PLANNED');
      expect(p.debtPoints).toBe(-p.redeemablePoints);
      expect(p.redeemablePoints + p.debtPoints).toBeGreaterThanOrEqual(0);
      expect(p.neverNegative).toBe(false);
    }
    expect(tp.wallets.find((p) => p.walletId === 'W-B2')!.debtPoints).toBe(520); // 700 − 180 repaid by the later earn (Q12)
    const pos = tp.wallets.find((p) => p.walletId === 'W-BP')!;
    expect(pos.debtPoints).toBe(0);
    expect(pos.neverNegative).toBe(true);
  });

  it('R1 set-up: a credit-batch credit landing on −841 gets O = 500, D = 341 (the debt it repaid)', () => {
    const ctx = ctxOf('bajaj', [{ id: 'B2', clientId: 'bajaj', rows: [row('O9', 'F1', 500)] }]);
    const p = planWallet(
      build({
        id: 'W-R1',
        clientId: 'bajaj',
        steps: [
          { k: 'credit', id: 'r1e', pts: 100 },
          { k: 'vdebit', id: 'r1v', pts: 941 },
          { k: 'credit', id: 'r1c', pts: 500, batch: 'B2', meta: { fieldId: 'F1', outletCode: 'O9' } },
        ],
      }).history,
      ctx,
    );
    expect(p.status).toBe('PLANNED');
    expect(p.redeemablePoints).toBe(-341);
    expect(p.debtPoints).toBe(341);
    expect(p.positions[0]).toMatchObject({ creditTxId: 'r1c', amount: 500, offsetPoints: 500, reversedPoints: 0, attribution: 'EXACT' });
  });

  it('historical clawback on a debt wallet (legacy floor moved 0): kept as recorded, ρ = requested, all shortfall', () => {
    const ctx = ctxOf('bajaj', [{ id: 'B2', clientId: 'bajaj', rows: [row('O9', 'F1', 500)] }], [rev('R9', 'bajaj', 'B2', 'O9', 'F1', 500)]);
    const p = planWallet(
      build({
        id: 'W-R2',
        clientId: 'bajaj',
        steps: [
          { k: 'credit', id: 'r2e', pts: 100 },
          { k: 'vdebit', id: 'r2v', pts: 941 },
          { k: 'credit', id: 'r2c', pts: 500, batch: 'B2', meta: { fieldId: 'F1', outletCode: 'O9' } },
          { k: 'claw', id: 'r2k', pts: 500, reversal: 'R9', creditMeta: 'r2c' },
        ],
      }).history,
      ctx,
    );
    expect(p.status).toBe('PLANNED');
    expect(p.redeemablePoints).toBe(-341);
    expect(p.txUpdates[3]).toMatchObject({ pointsDelta: 0, reversedCreditTxId: 'r2c', creditReversalId: 'R9' });
    expect(p.positions[0]).toMatchObject({ offsetPoints: 500, reversedPoints: 500 });
    expect(p.allocations).toEqual([{ creditReversalId: 'R9', creditTxId: 'r2c', requested: 500, debtRestored: 0, recovered: 0, owed: 0, shortfall: 500 }]);
    expect(p.debtPoints).toBe(341);
    // no −0 anywhere in the persisted write-set
    const nums = [p.debtPoints, ...p.txUpdates.map((u) => u.pointsDelta), ...p.positions.flatMap((x) => [x.offsetPoints, x.reversedPoints]), ...p.allocations.flatMap((a) => [a.debtRestored, a.recovered, a.shortfall])];
    expect(nums.some((n) => Object.is(n, -0))).toBe(false);
  });

  it('legacy credits (no metadata) pair to the batch rows of the partner’s current outlets → LEGACY_REPLAY; legacy clawback attributed by reversal key', () => {
    const batch: BfBatch = {
      id: 'BL',
      clientId: 't',
      rows: [row('O1', 'F1', 200), row('O2', 'F1', 50), row('O3', 'F2', 100), row('O3', 'F2', 0), row('O1', 'F1', 70, 'SKIPPED')],
    };
    const ctx = ctxOf('t', [batch], [rev('RL', 't', 'BL', 'O1', 'F1', 120)]);
    const p = planWallet(
      build({
        id: 'W-L1',
        clientId: 't',
        outlets: ['O1', 'O3'],
        steps: [
          { k: 'credit', id: 'l1', pts: 200, batch: 'BL' },
          { k: 'credit', id: 'l2', pts: 100, batch: 'BL' },
          { k: 'claw', id: 'lk', pts: 120, reversal: 'RL' },
        ],
      }).history,
      ctx,
    );
    expect(blocking(p)).toEqual([]);
    expect(p.positions.map((x) => [x.creditTxId, x.attribution, x.outletCode, x.fieldId, x.reversedPoints])).toEqual([
      ['l1', 'LEGACY_REPLAY', 'O1', 'F1', 120],
      ['l2', 'LEGACY_REPLAY', 'O3', 'F2', 0],
    ]);
    expect(p.allocations).toEqual([{ creditReversalId: 'RL', creditTxId: 'l1', requested: 120, debtRestored: 0, recovered: 120, owed: 0, shortfall: 0 }]);
    expect(p.txUpdates[2].reversedCreditTxId).toBe('l1');
  });

  it('T-f2 relinked outlet, legacy credit: the receiving wallet no longer owns the outlet → UNRESOLVED (reversals refused until mapped)', () => {
    const ctx = ctxOf('t', [{ id: 'BL', clientId: 't', rows: [row('O2', 'F1', 50)] }]);
    const p = planWallet(build({ id: 'W-L2', clientId: 't', outlets: ['O9'], steps: [{ k: 'credit', id: 'l3', pts: 50, batch: 'BL' }] }).history, ctx);
    expect(p.status).toBe('PLANNED');
    expect(p.positions).toEqual([expect.objectContaining({ creditTxId: 'l3', attribution: 'UNRESOLVED', outletCode: null, fieldId: null, amount: 50 })]);
    expect(warnings(p)).toContain('UNRESOLVED_CREDIT');
  });

  it('T-f1 relinked outlet, metadata credit: EXACT on the wallet that RECEIVED it (Q4), whatever the current owner', () => {
    const ctx = ctxOf('t', [{ id: 'BM', clientId: 't', rows: [row('O5', 'F1', 400)] }]);
    const p = planWallet(build({ id: 'W-L3', clientId: 't', outlets: [], steps: [{ k: 'credit', id: 'm1', pts: 400, batch: 'BM', meta: { fieldId: 'F1', outletCode: 'O5' } }] }).history, ctx);
    expect(p.positions[0]).toMatchObject({ walletId: 'W-L3', attribution: 'EXACT', outletCode: 'O5', fieldId: 'F1' });
  });

  it('unresolved credits: amount mismatch, missing batch rows, mixed metadata → UNRESOLVED; missing batch → non-reversible + warning', () => {
    const ctx = ctxOf('t', [
      { id: 'BA', clientId: 't', rows: [row('O1', 'F1', 999)] },
      { id: 'BN', clientId: 't', rows: null },
      { id: 'BX', clientId: 't', rows: [row('O1', 'F1', 10), row('O1', 'F2', 20)] },
    ]);
    const p = planWallet(
      build({
        id: 'W-U',
        clientId: 't',
        outlets: ['O1'],
        steps: [
          { k: 'credit', id: 'u1', pts: 100, batch: 'BA' },
          { k: 'credit', id: 'u2', pts: 100, batch: 'BN' },
          { k: 'credit', id: 'u3', pts: 10, batch: 'BX', meta: { fieldId: 'F1', outletCode: 'O1' } },
          { k: 'credit', id: 'u4', pts: 20, batch: 'BX' },
          { k: 'credit', id: 'u5', pts: 30, batch: 'GONE' },
        ],
      }).history,
      ctx,
    );
    expect(p.status).toBe('PLANNED');
    expect(p.positions.map((x) => [x.creditTxId, x.attribution])).toEqual([
      ['u1', 'UNRESOLVED'],
      ['u2', 'UNRESOLVED'],
      ['u3', 'EXACT'],
      ['u4', 'UNRESOLVED'],
    ]);
    expect(warnings(p)).toContain('POSITION_BATCH_MISSING');
    expect(p.txUpdates).toHaveLength(5);
  });

  it('T-h2 clawback of an unknown credit: classified as a debit, balances untouched, no allocation; the reversal’s key is left UNRESOLVED tenant-wide', () => {
    const ctx = ctxOf('t', [{ id: 'BX', clientId: 't', rows: [row('OX', 'F1', 400)] }], [rev('RX', 't', 'BX', 'OX', 'F1', 400)]);
    const receiving = build({ id: 'W-A', clientId: 't', steps: [{ k: 'credit', id: 'xa', pts: 400, batch: 'BX', meta: { fieldId: 'F1', outletCode: 'OX' } }] });
    // legacy clawback debited the outlet's NEW owner, who never received the credit
    const debited = build({
      id: 'W-B',
      clientId: 't',
      steps: [
        { k: 'credit', id: 'xb', pts: 1000, type: 'CREDIT_BONUS' },
        { k: 'claw', id: 'xk', pts: 400, reversal: 'RX' },
      ],
    });
    const tp = planTenant(ctx, [receiving.history, debited.history]);
    const b = tp.wallets.find((p) => p.walletId === 'W-B')!;
    expect(b.status).toBe('PLANNED');
    expect(warnings(b)).toContain('CLAWBACK_UNKNOWN_CREDIT');
    expect(b.allocations).toEqual([]);
    expect(b.txUpdates[1]).toMatchObject({ pointsDelta: -400, reversedCreditTxId: null, creditReversalId: 'RX' });
    expect(b.debtPoints).toBe(0);
    expect(b.redeemablePoints).toBe(600);
    expect(tp.anomalies.map((a) => a.code)).toEqual(['REVERSAL_UNATTRIBUTED']);
    const a = tp.wallets.find((p) => p.walletId === 'W-A')!;
    expect(a.positions[0]).toMatchObject({ attribution: 'UNRESOLVED', outletCode: 'OX', fieldId: 'F1', reversedPoints: 0 });
    expect(warnings(a)).toContain('UNRESOLVED_BY_UNATTRIBUTED_REVERSAL');
  });

  it('expiry lots: recorded expiry on a never-negative wallet is today’s clamp (D = 0)', () => {
    const { ctx, wallets } = deoleoFixture();
    const p = planWallet(build(wallets[1]).history, ctx);
    expect(p.status).toBe('PLANNED');
    expect(p.debtPoints).toBe(0);
    expect(p.txUpdates.map((u) => u.pointsDelta)).toEqual([300, -100, -50]);
  });

  it('expiry lots: a lot that expired silently (no expiry row) on a wallet that carried debt → BLOCKED (D not reconstructable)', () => {
    const p = planWallet(
      build({
        id: 'W-E',
        clientId: 't',
        steps: [
          { k: 'credit', id: 'e1', pts: 100 },
          { k: 'vdebit', id: 'e2', pts: 300 },
        ],
        extraLedgers: [{ id: 'LOT-old', points: 50, isExpired: true }],
      }).history,
      ctxOf('t'),
    );
    expect(p.status).toBe('BLOCKED');
    expect(blocking(p)).toEqual(['EXPIRY_UNRECORDED_ON_DEBT_WALLET']);
    expect(p.txUpdates).toEqual([]);
  });

  it('chain-following: createdAt order broken (concurrent credits) → reordered by the balance chain', () => {
    const h = build({ id: 'W-C', clientId: 't', steps: [{ k: 'credit', id: 'c1', pts: 100 }, { k: 'credit', id: 'c2', pts: 50 }] }).history;
    h.txs[0].createdAt = new Date(T0 + 2000); // c1 stamped AFTER c2 although it moved the balance first
    h.txs[1].createdAt = new Date(T0 + 1000);
    const r = orderChain(h.txs);
    expect(r.ok && r.ordered.map((t) => t.id)).toEqual(['c1', 'c2']);
    const p = planWallet(h, ctxOf('t'));
    expect(p.txUpdates.map((u) => [u.txId, u.seq])).toEqual([
      ['c1', 1],
      ['c2', 2],
    ]);
    expect(warnings(p)).toContain('CHAIN_REORDERED');
  });

  it('chain-following: no continuation → BLOCKED with no writes; final balance mismatch → BLOCKED', () => {
    const broken = build({
      id: 'W-X',
      clientId: 't',
      steps: [
        { k: 'credit', id: 'x1', pts: 100 },
        { k: 'raw', id: 'x2', pts: 50, balanceAfter: 999, type: 'CREDIT_BONUS' },
      ],
    }).history;
    const p = planWallet(broken, ctxOf('t'));
    expect(p.status).toBe('BLOCKED');
    expect(blocking(p)).toEqual(['CHAIN_BROKEN']);
    expect(p.txUpdates).toEqual([]);
    expect(p.debtPoints).toBe(0);

    const mismatch = build({ id: 'W-Y', clientId: 't', steps: [{ k: 'credit', id: 'y1', pts: 100 }] }).history;
    mismatch.wallet.redeemablePoints = 90;
    expect(blocking(planWallet(mismatch, ctxOf('t')))).toContain('FINAL_BALANCE_MISMATCH');
  });

  it('a debit that ADDED points (pre-fix legacy bug) cannot continue the chain → BLOCKED for the owner', () => {
    const h = build({ id: 'W-Z', clientId: 't', steps: [{ k: 'vdebit', id: 'z1', pts: 100 }, { k: 'raw', id: 'z2', pts: -50, balanceAfter: -80, type: 'DEBIT_ADJUSTMENT' }] }).history;
    h.txs[1].points = -50;
    expect(planWallet(h, ctxOf('t')).status).toBe('BLOCKED');
  });

  it('resume state: fully sequenced wallet → DONE; partially sequenced / pre-existing debt or positions → BLOCKED; empty → NOOP', () => {
    const { ctx, wallets } = deoleoFixture();
    const done = build(wallets[0]).history;
    done.txs.forEach((t, i) => (t.seq = i + 1));
    done.wallet.movementSeq = 4;
    expect(planWallet(done, ctx).status).toBe('DONE');
    const mixed = build(wallets[0]).history;
    mixed.txs[0].seq = 1;
    expect(blocking(planWallet(mixed, ctx))).toEqual(['SEQ_STATE_MIXED']);
    const pre = build(wallets[0]).history;
    pre.existingPositionCount = 1;
    expect(blocking(planWallet(pre, ctx))).toEqual(['POSITIONS_PREEXIST']);
    expect(planWallet(build(wallets[2]).history, ctx).status).toBe('NOOP');
  });

  it('LOCK/UNLOCK rows are not on the redeemable chain → BLOCKED (unsupported)', () => {
    const h = build({ id: 'W-K', clientId: 't', steps: [{ k: 'raw', id: 'k1', pts: 10, balanceAfter: 0, type: 'LOCK_HOLDING' }] }).history;
    expect(blocking(planWallet(h, ctxOf('t')))).toContain('UNSUPPORTED_ROW');
  });

  it('idempotent planning: the same input yields byte-identical plans', () => {
    const d = deoleoFixture();
    const hs = () => d.wallets.map((w) => build(w).history);
    const a = planTenant(d.ctx, hs()).wallets.map(planIdentity);
    const b = planTenant(d.ctx, hs().reverse()).wallets.map(planIdentity);
    expect(b).toEqual(a);
  });
});

// ───────────────────────────── runner (DRY_RUN / APPLY / resume / guards) ─────────────────────────────

describe('WP6 backfill runner', () => {
  it('refuses without EXPECTED_DB, on a DB mismatch, and APPLY without the exact confirmation', async () => {
    const s = fullStore();
    expect((await runBackfill(s, cfg({ expectedDb: undefined }), silent)).exitCode).toBe(2);
    expect((await runBackfill(s, cfg({ expectedDb: 'gifsy_prod' }), silent)).exitCode).toBe(2);
    expect((await runBackfill(s, cfg({ apply: true, confirm: 'APPLY gifsy_prod' }), silent)).exitCode).toBe(2);
    expect(s.writes).toBe(0);
  });

  it('DRY_RUN (default) plans every tenant and writes nothing', async () => {
    const s = fullStore();
    const lines: string[] = [];
    const r = await runBackfill(s, cfg(), (l) => lines.push(l));
    expect(r.mode).toBe('DRY_RUN');
    expect(r.exitCode).toBe(0);
    expect(s.writes).toBe(0);
    expect(s.applyCalls).toBe(0);
    const bajaj = r.tenants.find((t) => t.clientId === 'bajaj')!.summary;
    expect(bajaj.debtWallets).toHaveLength(8);
    expect(bajaj.totalDebt).toBe(3549);
    expect(lines.some((l) => l.includes('debt wallet W-B0: B -840 → D 840 (H 0)'))).toBe(true);
  });

  it('env parsing: APPLY only on BACKFILL_APPLY="true"', () => {
    expect(configFromEnv({ EXPECTED_DB: 'x', BACKFILL_APPLY: '1' }).apply).toBe(false);
    expect(configFromEnv({ EXPECTED_DB: 'x', BACKFILL_APPLY: 'true', TENANTS: 'bajaj, deoleo', MAX_WALLETS: '5' })).toMatchObject({ apply: true, tenants: ['bajaj', 'deoleo'], maxWallets: 5 });
  });

  it('APPLY writes, V0 unchanged, and a second run is a no-op (run twice = same result)', async () => {
    const s = fullStore();
    const r1 = await runBackfill(s, applyCfg(), silent);
    expect(r1.exitCode).toBe(0);
    for (const t of r1.tenants) expect(t.v0Diff).toEqual([]);
    const after1 = s.state();
    const writes1 = s.writes;
    const r2 = await runBackfill(s, applyCfg(), silent);
    expect(r2.exitCode).toBe(0);
    expect(s.writes).toBe(writes1);
    expect(s.state()).toBe(after1);
    for (const t of r2.tenants) expect(t.summary.wallets.planned).toBe(0);
  });

  it('resume mid-way: a crash after some wallets, then a re-run, ends in exactly the one-shot state', async () => {
    const oneShot = fullStore();
    await runBackfill(oneShot, applyCfg(), silent);

    const s = fullStore();
    s.failOnApplyCall = 6;
    await expect(runBackfill(s, applyCfg(), silent)).rejects.toThrow('simulated crash');
    const partial = s.tenants.get('bajaj')!;
    expect([...partial.histories.values()].some((h) => h.wallet.movementSeq > 0)).toBe(true);
    expect([...partial.histories.values()].some((h) => h.wallet.movementSeq === 0 && h.txs.length > 0)).toBe(true);
    s.failOnApplyCall = null;
    const r = await runBackfill(s, applyCfg(), silent);
    expect(r.exitCode).toBe(0);
    expect(s.state()).toBe(oneShot.state());
  });

  it('RESUME_AFTER_WALLET / MAX_WALLETS stage the run; the remainder completes later', async () => {
    const s = fullStore();
    await runBackfill(s, applyCfg({ tenants: ['bajaj'], maxWallets: 3 }), silent);
    expect([...s.tenants.get('bajaj')!.histories.values()].filter((h) => h.wallet.movementSeq > 0)).toHaveLength(3);
    await runBackfill(s, applyCfg({ tenants: ['bajaj'], resumeAfterWallet: 'W-B2' }), silent);
    expect([...s.tenants.get('bajaj')!.histories.values()].every((h) => h.wallet.movementSeq > 0)).toBe(true);
  });

  it('a wallet that moved between planning and its lock is CHANGED: no writes for it (exit 3), next run applies it', async () => {
    const s = fullStore();
    s.beforeApply = (walletId) => {
      if (walletId !== 'W-BP') return;
      const h = s.tenants.get('bajaj')!.histories.get('W-BP')!;
      const last = h.txs[h.txs.length - 1];
      h.txs.push({ ...last, id: 'bp-new', points: -100, balanceBefore: last.balanceAfter, balanceAfter: last.balanceAfter - 100, createdAt: new Date(T0 + 99_000), transactionType: 'DEBIT_REDEMPTION', description: 'Points redeemed' });
      h.ledgers.push({ id: 'L-bp-new', walletId: 'W-BP', transactionType: 'REDEEM', points: -100, isExpired: false, sourceType: null, sourceId: null, notes: 'Points redeemed', createdAt: new Date(T0 + 99_000) });
      h.wallet.redeemablePoints -= 100;
      s.beforeApply = null;
    };
    const lines: string[] = [];
    const r = await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), (l) => lines.push(l));
    expect(r.tenants[0].changed).toBe(1);
    // the concurrent redemption is live traffic (its movement row explains the balance change) — not a V0 alarm
    expect(r.exitCode).toBe(3);
    expect(r.tenants[0].v0Reconciliation).toMatchObject({ explained: true, tenantBalanceDelta: -100, movementNet: -100 });
    expect(lines.some((l) => l.includes('V0 ✓ live activity during the run: +0 earned / −100 redeemed') && l.endsWith('— explained'))).toBe(true);
    expect(s.tenants.get('bajaj')!.histories.get('W-BP')!.wallet.movementSeq).toBe(0);
    const r2 = await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), silent);
    expect(r2.exitCode).toBe(0);
    expect(s.tenants.get('bajaj')!.histories.get('W-BP')!.wallet.movementSeq).toBe(3);
  });

  it('Q2: BLOCKED wallets never stop the clean ones — every clean wallet is backfilled, each BLOCKED one is marked with its reason and listed', async () => {
    const s = new MemStore().add('t', ctxOf('t'), [
      { id: 'W-ok', clientId: 't', steps: [{ k: 'credit', id: 'ok1', pts: 10 }] },
      { id: 'W-bad', clientId: 't', steps: [{ k: 'credit', id: 'bad1', pts: 10 }, { k: 'raw', id: 'bad2', pts: 5, balanceAfter: 999, type: 'CREDIT_BONUS' }] },
    ]);
    const lines: string[] = [];
    const r = await runBackfill(s, applyCfg(), (l) => lines.push(l));
    expect(r.exitCode).toBe(0); // blocked wallets are ATTENTION, not a failed run
    expect(s.tenants.get('t')!.histories.get('W-ok')!.wallet.movementSeq).toBe(1);
    expect(s.status.get('W-ok')).toEqual({ status: 'DONE', reason: null });
    expect(s.tenants.get('t')!.histories.get('W-bad')!.wallet.movementSeq).toBe(0);
    expect(s.status.get('W-bad')!.status).toBe('BLOCKED');
    expect(s.status.get('W-bad')!.reason).toMatch(/^CHAIN_BROKEN: no row within/);
    const t = r.tenants[0];
    expect(t.markedBlocked).toBe(1);
    expect(t.attention.blockedWallets).toEqual([{ walletId: 'W-bad', reason: s.status.get('W-bad')!.reason }]);
    expect(lines.some((l) => l.includes('ATTENTION — 1 wallet(s) need Gifsy'))).toBe(true);
    expect(lines.some((l) => l.includes("WALLET W-bad BLOCKED — keeps today's earn/redeem/expiry rules"))).toBe(true);
    // ALLOW_BLOCKED is gone (ignored if still set)
    expect(configFromEnv({ EXPECTED_DB: 'x', ALLOW_BLOCKED: 'true' })).not.toHaveProperty('allowBlocked');
  });

  it('Q2: DRY_RUN lists the blocked wallets with reasons but marks nothing', async () => {
    const s = new MemStore().add('t', ctxOf('t'), [
      { id: 'W-bad', clientId: 't', steps: [{ k: 'raw', id: 'b', pts: 5, balanceAfter: 999, type: 'CREDIT_BONUS' }] },
    ]);
    const r = await runBackfill(s, cfg(), silent);
    expect(r.tenants[0].attention.blockedWallets.map((w) => w.walletId)).toEqual(['W-bad']);
    expect(s.status.size).toBe(0);
    expect(s.pauseLog).toEqual([]);
  });

  it('Q1: a previously BLOCKED wallet that Gifsy fixed is backfilled on the next run and becomes DONE (reason cleared)', async () => {
    const s = new MemStore().add('t', ctxOf('t'), [
      { id: 'W-bad', clientId: 't', steps: [{ k: 'credit', id: 'b1', pts: 10 }, { k: 'raw', id: 'b2', pts: 5, balanceAfter: 999, type: 'CREDIT_BONUS' }] },
    ]);
    await runBackfill(s, applyCfg(), silent);
    expect(s.status.get('W-bad')!.status).toBe('BLOCKED');
    // Gifsy repairs the row (balanceAfter 15) and re-runs
    const h = s.tenants.get('t')!.histories.get('W-bad')!;
    h.txs[1].balanceAfter = 15;
    h.wallet.redeemablePoints = 15;
    await runBackfill(s, applyCfg(), silent);
    expect(s.status.get('W-bad')).toEqual({ status: 'DONE', reason: null });
    expect(h.wallet.movementSeq).toBe(2);
  });

  it('Q5: APPLY pauses POINTS reversal approvals, drains in-flight ones, and resumes at the end; DRY_RUN never touches the switch', async () => {
    const s = fullStore();
    await runBackfill(s, cfg(), silent);
    expect(s.pauseLog).toEqual([]);
    const r = await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), silent);
    expect(s.pauseLog).toEqual(['bajaj:ON', 'bajaj:DRAIN', 'bajaj:OFF']);
    expect(r.tenants[0].pause).toEqual({ pausedByRun: true, leftPaused: false, priorSince: null });
    expect(s.pause.get('bajaj')!.paused).toBe(false);
  });

  it('Q5: KEEP_POINTS_REVERSALS_PAUSED leaves it on; a pause that was already on is never lifted by the run; a crash still resumes', async () => {
    const s = fullStore();
    expect(configFromEnv({ EXPECTED_DB: 'x', KEEP_POINTS_REVERSALS_PAUSED: 'true' }).keepPaused).toBe(true);
    await runBackfill(s, applyCfg({ tenants: ['bajaj'], keepPaused: true }), silent);
    expect(s.pause.get('bajaj')!.paused).toBe(true);
    s.pauseLog = [];
    const r = await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), silent); // already paused (manual / kept)
    expect(s.pauseLog).toEqual(['bajaj:DRAIN']);
    expect(s.pause.get('bajaj')!.paused).toBe(true);
    expect(r.tenants[0].pause).toMatchObject({ pausedByRun: false, priorSince: 'T' });

    const c = fullStore();
    c.failOnApplyCall = 2;
    await expect(runBackfill(c, applyCfg({ tenants: ['bajaj'] }), silent)).rejects.toThrow('simulated crash');
    expect(c.pauseLog).toEqual(['bajaj:ON', 'bajaj:DRAIN', 'bajaj:OFF']);
  });

  it('Q5: a re-run right before the V2 flip only works on what is new (already-sequenced wallets: counts only, no writes)', async () => {
    const s = fullStore();
    await runBackfill(s, applyCfg(), silent);
    const writes = s.writes;
    // a NEW wallet with legacy history appears after the first run
    const extra = build({ id: 'W-NEW', clientId: 'bajaj', steps: [{ k: 'credit', id: 'n1', pts: 70 }] });
    s.tenants.get('bajaj')!.histories.set('W-NEW', extra.history);
    s.tenants.get('bajaj')!.counters.set('W-NEW', extra.counters);
    const r = await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), silent);
    expect(r.tenants[0].summary.wallets).toMatchObject({ planned: 1, done: 9 });
    expect(r.tenants[0].applied).toBe(1);
    expect(s.writes - writes).toBe(2); // 1 row sequenced + the wallet row
    // and the planner decides DONE from counts alone (what the Prisma store loads for sequenced wallets)
    const summaryOnly: BfWalletHistory = {
      wallet: { id: 'W-S', partnerId: 'P', clientId: 'bajaj', redeemablePoints: 5, debtPoints: 0, movementSeq: 3 },
      txs: [],
      ledgers: [],
      currentOutletCodes: [],
      existingPositionCount: 0,
      sequencedSummary: { txCount: 3, sequencedCount: 3, maxSeq: 3 },
    };
    expect(planWallet(summaryOnly, ctxOf('bajaj')).status).toBe('DONE');
    expect(planWallet({ ...summaryOnly, sequencedSummary: { txCount: 4, sequencedCount: 3, maxSeq: 3 } }, ctxOf('bajaj')).status).toBe('BLOCKED');
  });
});

// ───────────────────────────── V0 under live traffic (earn/redeem are NOT paused during APPLY) ─────────────────────────────

/** A live earn (+) / redeem (−) committed by the app while the backfill runs: wallet update + its movement row, together. */
function liveMove(s: MemStore, clientId: string, walletId: string, id: string, delta: number, opts: { rowDelta?: number; noRow?: boolean } = {}): void {
  const t = s.tenants.get(clientId)!;
  const h = t.histories.get(walletId)!;
  const c = t.counters.get(walletId)!;
  const before = h.wallet.redeemablePoints;
  h.wallet.redeemablePoints += delta;
  if (delta > 0) {
    c.earnedPoints += delta;
    c.lifetimeEarned += delta;
  } else {
    c.redeemedPoints += -delta;
    c.lifetimeRedeemed += -delta;
  }
  if (opts.noRow) return;
  const rd = opts.rowDelta ?? delta;
  h.txs.push({
    id,
    walletId,
    transactionType: delta > 0 ? 'CREDIT_POINTS_EARNED' : 'DEBIT_REDEMPTION',
    points: rd,
    balanceBefore: before,
    balanceAfter: before + rd,
    balanceType: 'REDEEMABLE',
    referenceType: null,
    referenceId: null,
    description: 'live',
    metadata: null,
    createdAt: new Date(T0 + 500_000),
    seq: h.wallet.movementSeq > 0 ? ++h.wallet.movementSeq : null,
    pointsDelta: h.wallet.movementSeq > 0 ? rd : null,
    reversedCreditTxId: null,
    creditReversalId: null,
    pointsLedgerId: null,
  });
}

describe('V0 per-wallet guard + tenant reconciliation (live earn/redeem during APPLY)', () => {
  it('concurrent earn + redeem on other wallets during APPLY → exit 0 with "live activity … explained" (the backfill changed nothing)', async () => {
    const s = fullStore();
    s.beforeApply = (walletId) => {
      if (walletId !== 'W-B5') return; // W-B0 is already backfilled at this point (wallets go in ascending id order)
      liveMove(s, 'bajaj', 'W-B0', 'live-earn', 1000);
      liveMove(s, 'bajaj', 'W-B0', 'live-redeem', -100);
      s.beforeApply = null;
    };
    const lines: string[] = [];
    const r = await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), (l) => lines.push(l));
    expect(r.exitCode).toBe(0);
    const t = r.tenants[0];
    expect(t.walletGuardFailures).toEqual([]);
    expect(t.v0Diff!.length).toBeGreaterThan(0); // raw tenant totals DID move …
    expect(t.v0Reconciliation).toMatchObject({ explained: true, identical: false, tenantBalanceDelta: 900, movementNet: 900, unexplained: [] }); // … and every point is explained
    expect(t.v0Reconciliation!.activity).toMatchObject({ wallets: 1, rows: 2, earned: 1000, redeemed: 100 });
    expect(lines.some((l) => l.startsWith('[bajaj] V0 ✓ live activity during the run: +1000 earned / −100 redeemed (2 movement row(s) on 1 wallet(s)') && l.endsWith('— explained'))).toBe(true);
    expect(lines.some((l) => l.includes('V0 per-wallet guard ✓ — 9 wallet(s) written'))).toBe(true);
    expect([...s.tenants.get('bajaj')!.histories.values()].every((h) => h.wallet.movementSeq > 0)).toBe(true);
  });

  it('a backfill write that changes a balance → rolled back, run STOPS, exit 4 naming the wallet', async () => {
    const s = fullStore();
    const pristine = fullStore();
    s.corruptOnApply = (walletId) => {
      if (walletId === 'W-B3') s.tenants.get('bajaj')!.histories.get('W-B3')!.wallet.redeemablePoints += 1;
    };
    const lines: string[] = [];
    const r = await runBackfill(s, applyCfg(), (l) => lines.push(l)); // bajaj then deoleo
    expect(r.exitCode).toBe(4);
    const t = r.tenants.find((x) => x.clientId === 'bajaj')!;
    expect(t.walletGuardFailures).toEqual([{ walletId: 'W-B3', diff: ['redeemablePoints: -360 → -359'] }]);
    expect(lines.some((l) => l.includes("‼ V0 WALLET GUARD: the backfill's writes changed wallet W-B3 (redeemablePoints: -360 → -359) — rolled back"))).toBe(true);
    expect(lines.some((l) => l.includes("‼ ALARM — the backfill's writes changed wallet W-B3"))).toBe(true);
    // rolled back: W-B3 untouched (balance, seq, positions); nothing after it written; deoleo never processed
    const b = s.tenants.get('bajaj')!.histories;
    expect(b.get('W-B3')!.wallet).toEqual(pristine.tenants.get('bajaj')!.histories.get('W-B3')!.wallet);
    expect(b.get('W-B3')!.txs.every((x) => x.seq === null)).toBe(true);
    expect(['W-B0', 'W-B1', 'W-B2'].every((id) => b.get(id)!.wallet.movementSeq > 0)).toBe(true);
    expect(['W-B4', 'W-B5', 'W-B6', 'W-B7', 'W-BP'].every((id) => b.get(id)!.wallet.movementSeq === 0)).toBe(true);
    expect(r.tenants.map((x) => x.clientId)).toEqual(['bajaj']);
    expect([...s.tenants.get('deoleo')!.histories.values()].every((h) => h.wallet.movementSeq === 0)).toBe(true);
    expect(lines.some((l) => l.includes('‼ STOPPED') && l.includes('tenants not processed: deoleo'))).toBe(true);
    expect(s.pause.get('bajaj')!.paused).toBe(false); // pause still lifted
    expect(t.v0Reconciliation!.explained).toBe(true); // the rollback left the tenant totals intact
    // the defect fixed → a re-run completes and ends in the one-shot state
    s.corruptOnApply = null;
    expect((await runBackfill(s, applyCfg(), silent)).exitCode).toBe(0);
    await runBackfill(pristine, applyCfg(), silent);
    expect(s.state()).toBe(pristine.state());
  });

  it('a counter / movement-amount / lot changed by a backfill write is caught too (diffWalletGuard covers every field)', async () => {
    for (const corrupt of [
      (s: MemStore) => (s.tenants.get('bajaj')!.counters.get('W-B1')!.lifetimeEarned += 5),
      (s: MemStore) => (s.tenants.get('bajaj')!.histories.get('W-B1')!.txs[0].balanceAfter += 1),
      (s: MemStore) => (s.tenants.get('bajaj')!.histories.get('W-B1')!.ledgers[0].isExpired = true),
    ]) {
      const s = fullStore();
      s.corruptOnApply = (w) => (w === 'W-B1' ? void corrupt(s) : undefined);
      const r = await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), silent);
      expect(r.exitCode).toBe(4);
      expect(r.tenants[0].walletGuardFailures.map((g) => g.walletId)).toEqual(['W-B1']);
    }
  });

  it('a tenant change no committed movement row explains → exit 4 with the unexplained amount and the wallets', async () => {
    const s = fullStore();
    s.beforeApply = (walletId) => {
      if (walletId !== 'W-B5') return;
      liveMove(s, 'bajaj', 'W-B0', 'x0', 50, { noRow: true }); // balance + counters moved, no row
      s.tenants.get('bajaj')!.counters.get('W-B1')!.redeemedPoints += 7; // a counter alone, no row
      liveMove(s, 'bajaj', 'W-B2', 'x2', 150, { rowDelta: 100 }); // the row says +100, the balance moved +150
      liveMove(s, 'bajaj', 'W-B3', 'x3', 40); // legit live earn — explained, not listed
      s.beforeApply = null;
    };
    const lines: string[] = [];
    const r = await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), (l) => lines.push(l));
    expect(r.exitCode).toBe(4);
    const rec = r.tenants[0].v0Reconciliation!;
    expect(rec.explained).toBe(false);
    expect(rec.unexplainedAmount).toBe(100); // 50 (no row) + 0 (counter only) + 50 (row short)
    expect(rec.unexplained.map((u) => u.walletId)).toEqual(['W-B0', 'W-B1', 'W-B2']);
    expect(rec.unexplained[2].detail).toContain('balance moved 150 but the 1 new movement row(s) net 100 — unexplained 50');
    expect(r.tenants[0].walletGuardFailures).toEqual([]); // the backfill itself is not the culprit
    expect(lines.some((l) => l.startsWith('[bajaj] ‼ V0 UNEXPLAINED change during APPLY') && l.includes('UNEXPLAINED 100 pts on 3 wallet(s)') && l.includes('W-B0') && l.includes('W-B2'))).toBe(true);
    expect(lines.some((l) => l.includes('‼ ALARM — V0 unexplained 100 pts on 3 wallet(s)'))).toBe(true);
  });

  it('reconcileV0Wallets: new wallet opened during the run is fine; a vanished wallet or lost rows are unexplained', () => {
    const w = (id: string, B: number, n = 0, i = 0, o = 0): V0WalletRow => {
      const r = { id, txCount: n, txIn: i, txOut: o } as V0WalletRow;
      for (const f of V0_FIELDS) r[f] = 0;
      r.redeemablePoints = B;
      return r;
    };
    expect(reconcileV0Wallets([w('A', 10, 1, 10)], [w('A', 10, 1, 10)]).identical).toBe(true);
    const opened = reconcileV0Wallets([w('A', 10, 1, 10)], [w('A', 10, 1, 10), w('N', 0)]);
    expect(opened).toMatchObject({ explained: true, identical: false, activity: { newWallets: 1 } });
    const openedAndEarned = reconcileV0Wallets([w('A', 10, 1, 10)], [w('A', 10, 1, 10), w('N', 25, 1, 25)]);
    expect(openedAndEarned).toMatchObject({ explained: true, activity: { earned: 25, wallets: 1 } });
    expect(reconcileV0Wallets([w('A', 10, 1, 10)], []).unexplained).toEqual([{ walletId: 'A', detail: 'wallet disappeared during the run' }]);
    expect(reconcileV0Wallets([w('A', 10, 2, 15, -5)], [w('A', 10, 1, 10)]).explained).toBe(false);
  });
});

// ───────────────────────────── Q4: historical clawbacks beyond holdings ─────────────────────────────

describe('policy Q4 — historical clawback that exceeded holdings: "recovered X, owed Y", owed never counted as recovered', () => {
  it('a recorded clawback that took 300 from a wallet holding 100 → recovered 100, owed 200 (debt), shortfall = requested − moved', () => {
    const ctx = ctxOf('t', [{ id: 'BQ', clientId: 't', rows: [row('OQ', 'F1', 400)] }], [rev('RQ', 't', 'BQ', 'OQ', 'F1', 400)]);
    const h = build({
      id: 'W-Q',
      clientId: 't',
      steps: [
        { k: 'credit', id: 'q1', pts: 400, batch: 'BQ', meta: { fieldId: 'F1', outletCode: 'OQ' } },
        { k: 'redeem', id: 'q2', pts: 300 },
        // a pre-engine patched clawback recorded −300 on a wallet holding 100 (pushed it to −200)
        { k: 'raw', id: 'q3', pts: -400, balanceAfter: -200, type: 'DEBIT_ADJUSTMENT' },
      ],
    }).history;
    Object.assign(h.txs[2], { referenceType: 'CREDIT_REVERSAL', referenceId: 'RQ', metadata: { reversedCreditTxId: 'q1' } });
    const p = planWallet(h, ctx);
    expect(p.status).toBe('PLANNED');
    expect(p.allocations).toEqual([
      { creditReversalId: 'RQ', creditTxId: 'q1', requested: 400, debtRestored: 0, recovered: 100, owed: 200, shortfall: 100 },
    ]);
    expect(p.debtPoints).toBe(200);
    const a = p.anomalies.find((x) => x.code === 'CLAWBACK_OWED')!;
    expect(a.detail).toMatch(/recovered 100, owed 200/);
    expect(p.anomalies.find((x) => x.code === 'CLAWBACK_BEYOND_HOLDINGS')!.detail).toMatch(/recovered 100, owed 200 \(booked as debt\)/);
    const sum = summarizeTenant({ clientId: 't', wallets: [p], adjustments: { downgradeKeys: new Set() }, anomalies: [] });
    expect(sum.historicalClawbacks).toEqual({ count: 1, requested: 400, debtRestored: 0, recovered: 100, owed: 200, shortfall: 100 });
  });

  it('the run report and verify V8 say "recovered X, owed Y"', async () => {
    const ctx = ctxOf('t', [{ id: 'BQ', clientId: 't', rows: [row('OQ', 'F1', 400)] }], [rev('RQ', 't', 'BQ', 'OQ', 'F1', 400)]);
    const s = new MemStore().add('t', ctx, [
      {
        id: 'W-Q',
        clientId: 't',
        steps: [
          { k: 'credit', id: 'q1', pts: 400, batch: 'BQ', meta: { fieldId: 'F1', outletCode: 'OQ' } },
          { k: 'redeem', id: 'q2', pts: 300 },
          { k: 'raw', id: 'q3', pts: -400, balanceAfter: -200, type: 'DEBIT_ADJUSTMENT' },
        ],
      },
    ]);
    Object.assign(s.tenants.get('t')!.histories.get('W-Q')!.txs[2], { referenceType: 'CREDIT_REVERSAL', referenceId: 'RQ', metadata: { reversedCreditTxId: 'q1' } });
    const lines: string[] = [];
    const r = await runBackfill(s, applyCfg(), (l) => lines.push(l));
    expect(r.tenants[0].attention.owedClawbacks).toEqual({ owed: 200, recovered: 100, count: 1 });
    expect(lines.some((l) => l.includes('= debt restored 0 + recovered 100 + owed 200 + shortfall 100'))).toBe(true);
    expect(lines.some((l) => l.includes('historical clawbacks: recovered 100, owed 200 (booked as debt — not recovered)'))).toBe(true);
    const v8 = runVerifyChecks(await s.loadVerifySnapshot('t'), { neverNegativeTenant: false }).find((c) => c.check.startsWith('V8'))!;
    expect(v8.status).toBe('PASS');
    expect(v8.detail).toContain('recovered 100, owed 200');
  });
});

// ───────────────────────────── WP5 payout planner wired into the backfill (WP6) ─────────────────────────────

describe('WP6 × WP5 — PAYOUT reversal allocation backfill', () => {
  const T1 = new Date(T0 + 50_000);
  const entry = (id: string, amount: number, status: string, outletId = 'O1') => ({
    id, clientId: 'bajaj', batchId: 'PB', outletId, fieldId: 'F', amountPaise: BigInt(amount), status, createdAt: new Date(T0),
  });
  const prev = (id: string, approved: number, consumed: unknown, extra: Record<string, unknown> = {}) => ({
    id, clientId: 'bajaj', batchId: 'PB', outletId: 'O1', fieldId: 'F', status: 'APPROVED', awardType: 'PAYOUT',
    approvedPaise: BigInt(approved), shortfallPaise: 0n, approvedAt: T1, consumedPayoutEntryIds: consumed, ...extra,
  });
  const store = () => {
    const s = fullStore();
    s.payoutInput.set('bajaj', {
      reversals: [
        prev('PR1', 30000, ['E1']), // clean: E1 REVERSED → APPLIED_CANCELLED
        prev('PR2', 50000, null), // pre-column: E2 + E3 both settled, no unique subset of 50000 among [30000, 30000] → AMBIGUOUS
        prev('PR3', 10000, null, { status: 'PENDING_GIFSY', approvedPaise: null, approvedAt: null }),
      ],
      entries: [entry('E1', 30000, 'REVERSED'), entry('E2', 30000, 'PAID'), entry('E3', 30000, 'PAID')],
    });
    return s;
  };

  it('DRY_RUN prints the planner flags in the anomaly list and inserts nothing', async () => {
    const s = store();
    const lines: string[] = [];
    const r = await runBackfill(s, cfg({ tenants: ['bajaj'] }), (l) => lines.push(l));
    const p = r.tenants[0].payout!;
    expect(p).toMatchObject({ planned: 1, inserted: 0, outcome: 'DRY_RUN' });
    expect(p.flags.map((f) => [f.creditReversalId, f.code])).toEqual([['PR2', 'AMBIGUOUS_LEGACY'], ['PR3', 'PENDING_LEGACY']]);
    expect(lines.some((l) => l.includes('BLOCKING PAYOUT_AMBIGUOUS_LEGACY reversal PR2'))).toBe(true);
    expect(r.tenants[0].attention.payoutReversals.map((f) => f.creditReversalId)).toEqual(['PR2']);
    expect(s.payoutAllocations).toEqual([]);
  });

  it('APPLY inserts the planned rows (never for a BLOCKING-flagged reversal); a re-run inserts nothing; verify V9/V9b', async () => {
    const s = store();
    const r = await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), silent);
    expect(r.exitCode).toBe(0);
    expect(r.tenants[0].payout).toMatchObject({ planned: 1, inserted: 1, outcome: 'APPLIED' });
    expect(s.payoutAllocations).toEqual([{ payoutEntryId: 'E1', creditReversalId: 'PR1', state: 'APPLIED_CANCELLED', clientId: 'bajaj', amountPaise: 30000n }]);
    const r2 = await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), silent);
    expect(r2.tenants[0].payout).toMatchObject({ planned: 0, outcome: 'NONE' });
    expect(s.payoutAllocations).toHaveLength(1);
    const rs = runVerifyChecks(await s.loadVerifySnapshot('bajaj'), { neverNegativeTenant: false });
    expect(rs.find((c) => c.check.startsWith('V9 '))!.status).toBe('PASS');
    const v9b = rs.find((c) => c.check.startsWith('V9b'))!;
    expect(v9b.status).toBe('WARN'); // PR2 is ambiguous → called out, never silent
    expect(v9b.ids).toEqual(['PR2']);
    expect(v9b.detail).toMatch(/AMBIGUOUS_LEGACY/);
  });

  it('a reversal approved between planning and the locked insert → CHANGED: nothing inserted, exit 3, the next run inserts', async () => {
    const s = store();
    s.beforePayoutApply = () => {
      s.payoutInput.get('bajaj')!.reversals.push(prev('PR4', 30000, ['E3'], { shortfallPaise: 30000n })); // receivable recorded = net (re-audit B3)
      s.beforePayoutApply = null;
    };
    const r = await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), silent);
    expect(r.tenants[0].payout!.outcome).toBe('CHANGED');
    expect(r.exitCode).toBe(3);
    expect(s.payoutAllocations).toEqual([]);
    await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), silent);
    expect(s.payoutAllocations.map((a) => a.creditReversalId).sort()).toEqual(['PR1', 'PR4']);
  });
});

// ───────────────────────────── verify V0–V9 ─────────────────────────────

describe('WP6 verify V0–V9', () => {
  const opts = (clientId: string, baseline?: V0Snapshot) => ({
    v0Baseline: baseline,
    neverNegativeTenant: clientId === 'deoleo',
    expectedNegativeBalances: clientId === 'bajaj' ? BAJAJ_NEG : undefined,
  });

  it('after APPLY every check passes: Deoleo D = 0 / O = 0 (V5), Bajaj 8 negatives covered with balances unchanged (V6/V6b), V0 identical', async () => {
    const s = fullStore();
    const before = { deoleo: await s.snapshotV0('deoleo'), bajaj: await s.snapshotV0('bajaj') };
    await runBackfill(s, applyCfg(), silent);
    for (const c of ['deoleo', 'bajaj'] as const) {
      const rs = runVerifyChecks(await s.loadVerifySnapshot(c), opts(c, before[c]));
      expect(rs.filter((r) => r.status === 'FAIL')).toEqual([]);
      expect(rs.find((r) => r.check.startsWith('V0'))!.status).toBe('PASS');
    }
    const bj = runVerifyChecks(await s.loadVerifySnapshot('bajaj'), opts('bajaj', before.bajaj));
    expect(bj.find((r) => r.check.startsWith('V6b'))!.status).toBe('PASS');
    expect(bj.find((r) => r.check.startsWith('V6 '))!.detail).toContain('Σ balance -3549, Σ debt 3549');
    const de = runVerifyChecks(await s.loadVerifySnapshot('deoleo'), opts('deoleo', before.deoleo));
    expect(de.find((r) => r.check.startsWith('V5'))!.status).toBe('PASS');
    expect(de.find((r) => r.check.startsWith('V8'))!.status).toBe('PASS');
  });

  it('before the backfill V1/V2/V6 fail (seq NULL, no pointsDelta, debt 0) — the checks are not vacuous', async () => {
    const s = fullStore();
    const rs = runVerifyChecks(await s.loadVerifySnapshot('bajaj'), opts('bajaj'));
    const status = Object.fromEntries(rs.map((r) => [r.check.split(' ')[0], r.status]));
    expect(status).toMatchObject({ V0: 'INFO', V1: 'FAIL', V2: 'FAIL', V4: 'FAIL', V6: 'FAIL', V6b: 'PASS' });
  });

  it('detects: a changed balance (V0/V3/V6b), a broken chain (V2), reversedPoints ≠ Σ allocations (V8), a payout entry in two live reversals (V9), a Deoleo debt (V5), a missing position (V7)', async () => {
    const s = fullStore();
    const before = await s.snapshotV0('bajaj');
    await runBackfill(s, applyCfg(), silent);
    const bj = s.tenants.get('bajaj')!.histories.get('W-B0')!;
    bj.wallet.redeemablePoints = -841;
    bj.txs[1].pointsDelta = -401;
    s.payoutAllocations.push({ payoutEntryId: 'PE1', creditReversalId: 'X1', state: 'RESERVED', clientId: 'bajaj' }, { payoutEntryId: 'PE1', creditReversalId: 'X2', state: 'APPLIED_RECEIVABLE', clientId: 'bajaj' });
    const rb = Object.fromEntries(runVerifyChecks(await s.loadVerifySnapshot('bajaj'), opts('bajaj', before)).map((r) => [r.check.split(' ')[0], r.status]));
    expect(rb).toMatchObject({ V0: 'FAIL', V2: 'FAIL', V3: 'FAIL', V6b: 'FAIL', V9: 'FAIL' });

    s.positions.find((p) => p.creditTxId === 'd1c1')!.reversedPoints = 400;
    s.tenants.get('deoleo')!.histories.get('W-D2')!.wallet.debtPoints = 5;
    s.positions = s.positions.filter((p) => p.creditTxId !== 'd1c2');
    const rd = Object.fromEntries(runVerifyChecks(await s.loadVerifySnapshot('deoleo'), opts('deoleo')).map((r) => [r.check.split(' ')[0], r.status]));
    expect(rd).toMatchObject({ V5: 'FAIL', V7: 'FAIL', V8: 'FAIL' });
  });

  it('V0 vs the APPLY baseline: live earn/redeem since → PASS "live activity … explained"; a change no row explains → FAIL', async () => {
    const s = fullStore();
    const before = await s.snapshotV0('bajaj');
    await runBackfill(s, applyCfg({ tenants: ['bajaj'] }), silent);
    liveMove(s, 'bajaj', 'W-BP', 'v-earn', 30);
    liveMove(s, 'bajaj', 'W-BP', 'v-redeem', -20);
    const v0 = async (baseline: V0Snapshot = before) => runVerifyChecks(await s.loadVerifySnapshot('bajaj'), opts('bajaj', baseline)).find((r) => r.check.startsWith('V0'))!;
    const ok = await v0();
    expect(ok.status).toBe('PASS');
    expect(ok.detail).toMatch(/^live activity since the APPLY baseline: \+30 earned \/ −20 redeemed \(2 movement row\(s\).*— explained$/);
    liveMove(s, 'bajaj', 'W-BP', 'v-ghost', 5, { noRow: true });
    const bad = await v0();
    expect(bad.status).toBe('FAIL');
    expect(bad.detail).toContain('UNEXPLAINED 5 pts');
    // a baseline without movement totals can't be reconciled → FAIL (re-capture), never a silent pass
    const old: Partial<V0Snapshot> = { ...before };
    delete old.txCount;
    delete old.txIn;
    delete old.txOut;
    const stale = await v0(old as V0Snapshot);
    expect(stale.status).toBe('FAIL');
    expect(stale.detail).toContain('re-capture');
  });

  it('V10 / Q2: a BLOCKED wallet is excluded from V1/V2/V3/V7 and listed as WARN (never silent); the run still passes', async () => {
    const s = new MemStore().add('t', ctxOf('t'), [
      { id: 'W-ok', clientId: 't', steps: [{ k: 'credit', id: 'ok1', pts: 10 }] },
      { id: 'W-bad', clientId: 't', steps: [{ k: 'credit', id: 'bad1', pts: 10 }, { k: 'raw', id: 'bad2', pts: 5, balanceAfter: 999, type: 'CREDIT_BONUS' }] },
    ]);
    await runBackfill(s, applyCfg(), silent);
    const rs = runVerifyChecks(await s.loadVerifySnapshot('t'), { neverNegativeTenant: false });
    const st = Object.fromEntries(rs.map((r) => [r.check.split(' ')[0], r.status]));
    expect(st).toMatchObject({ V1: 'PASS', V2: 'PASS', V3: 'PASS', V7: 'PASS', V10: 'WARN' });
    expect(rs.find((r) => r.check.startsWith('V10'))!.ids).toEqual(['W-bad']);
    const lines: string[] = [];
    const out = await runVerify(s, verifyConfigFromEnv({ EXPECTED_DB: 'gifsy_test', NEVER_NEGATIVE_TENANTS: 'none' }), (l) => lines.push(l));
    expect(out.exitCode).toBe(0);
    expect(lines.some((l) => l.includes('WARN V10 wallets needing Gifsy attention') && l.includes('[W-bad]'))).toBe(true);
    expect(lines.some((l) => l.startsWith('VERIFY: ⚠ 1 check(s) need Gifsy attention'))).toBe(true);
  });

  it('verify job: guard + env parsing + exit codes (0 pass, 5 fail)', async () => {
    const s = fullStore();
    await runBackfill(s, applyCfg(), silent);
    const env = {
      EXPECTED_DB: 'gifsy_test',
      EXPECTED_NEGATIVE_BALANCES: JSON.stringify({ bajaj: BAJAJ_NEG }),
      V0_BASELINE_JSON: JSON.stringify([await s.snapshotV0('bajaj')]),
    };
    expect((await runVerify(s, { ...verifyConfigFromEnv(env), expectedDb: 'gifsy_prod' }, silent)).exitCode).toBe(2);
    const c = verifyConfigFromEnv(env);
    expect(c.neverNegativeTenants.has('deoleo')).toBe(true);
    expect((await runVerify(s, c, silent)).exitCode).toBe(0);
    s.tenants.get('deoleo')!.histories.get('W-D1')!.wallet.debtPoints = 1;
    expect((await runVerify(s, c, silent)).exitCode).toBe(5);
  });
});
