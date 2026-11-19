/**
 * Wallet Reversal Engine — WP6 VERIFY checks V0–V9 (PURE, read-only evaluation of a loaded tenant snapshot).
 *
 * Mirrors the verification queries of WALLET-REVERSAL-ENGINE-DESIGN.md §9 one-for-one (the SQL text is kept below in
 * VERIFY_SQL for manual psql runs); the verify job loads each tenant's rows and evaluates them here so every check is
 * unit-tested on fixtures. Each check returns PASS / FAIL (or INFO) per tenant with the offending ids.
 */
import { createHash } from 'node:crypto';
import { planPayoutAllocationBackfill } from '../../credits/payout-reversal-v2';
import type { PayoutBackfillInput } from './backfill-runner';

export interface VWallet {
  id: string;
  redeemablePoints: number;
  debtPoints: number;
  movementSeq: number;
  earnedPoints: number;
  lifetimeEarned: number;
  redeemedPoints: number;
  expiredPoints: number;
  lifetimeRedeemed: number;
  lifetimeExpired: number;
  lockedPoints: number;
  /** wallets.backfillStatus (policy round A): 'BLOCKED' wallets are excluded from V1/V2/V3/V7 and listed by V10 */
  backfillStatus?: string | null;
}

export interface VTx {
  id: string;
  walletId: string;
  seq: number | null;
  pointsDelta: number | null;
  /** V0 live-activity reconciliation: each row's real balance change is balanceAfter − balanceBefore */
  balanceBefore: number;
  balanceAfter: number;
  transactionType: string;
  referenceType: string | null;
  referenceId: string | null;
  points: number;
}

export interface VPosition {
  id: string;
  walletId: string;
  creditTxId: string;
  amount: number;
  offsetPoints: number;
  reversedPoints: number;
  attribution: string;
}

export interface VAllocation {
  positionId: string;
  creditReversalId: string;
  requested: number;
  recovered?: number;
  /** points taken beyond holdings, booked as debt — Q4 historical clawback, or a V2 over-reversal (see below) */
  owed?: number;
  /** true ⇔ `owed` is a live V2 over-reversal's debt (owner decision 2026-11-19), not a historical clawback */
  overReversalDebt?: boolean;
}

export interface VPayoutAllocation {
  payoutEntryId: string;
  creditReversalId: string;
  state: string;
}

export interface VerifySnapshot {
  clientId: string;
  wallets: VWallet[];
  txs: VTx[];
  positions: VPosition[];
  allocations: VAllocation[];
  payoutAllocations: VPayoutAllocation[];
  /** WP5 payout planner input — V9b re-runs the planner read-only (absent → V9b skipped) */
  payoutBackfill?: PayoutBackfillInput;
}

// ───────────────────────────── V0 — balances / counters / lots ─────────────────────────────
//
// The backfill NEVER changes a balance, a counter or a lot. Live earn/redeem traffic is NOT paused during APPLY (only
// POINTS reversal approvals are — Q5), so tenant totals legitimately move during a run. V0 therefore has two layers:
//  1. PER WALLET, in the backfill's own transaction (the hard guarantee): the wallet's figures + a digest of its
//     movement rows (balance columns only) + a digest of its lots are read under the wallet row lock immediately BEFORE
//     the backfill's writes and again immediately AFTER them, in the same transaction. Nothing else can move that wallet
//     in between (we hold its lock), so ANY difference is a backfill defect → the transaction is rolled back and the run
//     exits 4 naming the wallet (diffWalletGuard).
//  2. TENANT RECONCILIATION (explains live traffic, never a silent pass): a per-wallet snapshot (figures + count / Σ in /
//     Σ out of its movement rows, one SQL statement = one consistent MVCC view) before and after the run. Each wallet's
//     balance change must equal the net of the movement rows committed between the two snapshots, and a wallet whose
//     figures changed must have new movement rows (every live earn/redeem/expiry writes one in the same transaction as
//     the wallet update). Anything else is UNEXPLAINED → exit 4 with the amount and the wallets (reconcileV0Wallets).
// "Rows committed during the run" is measured as the difference between the two consistent snapshots (row count / Σ),
// not by createdAt: a DB-side now() is the transaction START time, so a timestamp cut-off would mis-attribute a live
// transaction that began before the snapshot but committed after it. Rows are append-only and the backfill only fills
// seq / pointsDelta / link columns — never balanceBefore / balanceAfter — so the Σ columns are untouched by it.

/** The wallet balance + counter columns the backfill must never change. */
export const V0_FIELDS = [
  'redeemablePoints',
  'earnedPoints',
  'lifetimeEarned',
  'redeemedPoints',
  'expiredPoints',
  'lifetimeRedeemed',
  'lifetimeExpired',
  'lockedPoints',
] as const;
export type V0Field = (typeof V0_FIELDS)[number];
export type WalletFigures = Record<V0Field, number>;

/** One wallet in the tenant V0 snapshot: its figures + the movement rows it has (count, Σ positive / Σ negative change). */
export interface V0WalletRow extends WalletFigures {
  id: string;
  txCount: number;
  /** Σ max(balanceAfter − balanceBefore, 0) over the wallet's movement rows */
  txIn: number;
  /** Σ min(balanceAfter − balanceBefore, 0) over the wallet's movement rows (≤ 0) */
  txOut: number;
}

/** V0 — tenant totals + movement totals + a digest over EVERY wallet's balance and counters (equal digest ⇔ no wallet figure changed). */
export interface V0Snapshot extends WalletFigures {
  clientId: string;
  wallets: number;
  /** movement rows of the tenant's wallets and their Σ positive / Σ negative balance change (live-activity reconciliation) */
  txCount: number;
  txIn: number;
  txOut: number;
  /** sha256 over sorted `id:redeemable:earned:lifetimeEarned:redeemed:expired:lifetimeRedeemed:lifetimeExpired:locked` */
  balanceDigest: string;
}

const zeroFigures = (): WalletFigures => ({
  redeemablePoints: 0,
  earnedPoints: 0,
  lifetimeEarned: 0,
  redeemedPoints: 0,
  expiredPoints: 0,
  lifetimeRedeemed: 0,
  lifetimeExpired: 0,
  lockedPoints: 0,
});

/** Per-wallet V0 rows from loaded wallets + their movement rows (verify job / fixtures; the Prisma store aggregates in SQL). */
export function v0RowsOf(wallets: (WalletFigures & { id: string })[], txs: Pick<VTx, 'walletId' | 'balanceBefore' | 'balanceAfter'>[]): V0WalletRow[] {
  const agg = new Map<string, { n: number; i: number; o: number }>();
  for (const t of txs) {
    const a = agg.get(t.walletId) ?? { n: 0, i: 0, o: 0 };
    const d = t.balanceAfter - t.balanceBefore;
    a.n++;
    if (d > 0) a.i += d;
    else a.o += d;
    agg.set(t.walletId, a);
  }
  return wallets.map((w) => {
    const a = agg.get(w.id) ?? { n: 0, i: 0, o: 0 };
    const row = { id: w.id, txCount: a.n, txIn: a.i, txOut: a.o } as V0WalletRow;
    for (const f of V0_FIELDS) row[f] = w[f];
    return row;
  });
}

/** Tenant V0 summary of per-wallet rows. Accepts plain wallets too (no movement figures → 0). */
export function computeV0(clientId: string, wallets: (WalletFigures & { id: string; txCount?: number; txIn?: number; txOut?: number })[]): V0Snapshot {
  const s: V0Snapshot = { clientId, wallets: wallets.length, ...zeroFigures(), txCount: 0, txIn: 0, txOut: 0, balanceDigest: '' };
  const lines: string[] = [];
  for (const w of wallets) {
    for (const f of V0_FIELDS) s[f] += w[f];
    s.txCount += w.txCount ?? 0;
    s.txIn += w.txIn ?? 0;
    s.txOut += w.txOut ?? 0;
    lines.push([w.id, ...V0_FIELDS.map((f) => w[f])].join(':'));
  }
  lines.sort();
  s.balanceDigest = createHash('sha256').update(lines.join('\n')).digest('hex');
  return s;
}

/** Field-by-field V0 difference (empty = identical). */
export function diffV0(before: V0Snapshot, after: V0Snapshot): string[] {
  const out: string[] = [];
  for (const k of Object.keys(before) as (keyof V0Snapshot)[]) {
    if (before[k] !== after[k]) out.push(`${k}: ${String(before[k])} → ${String(after[k])}`);
  }
  return out;
}

/**
 * Per-wallet guard state, read under the wallet row lock immediately before AND after the backfill's writes (same
 * transaction). txDigest covers each movement row's id / type / points / balanceBefore / balanceAfter / balanceType
 * (NOT the seq / pointsDelta / link columns the backfill fills); lotDigest covers each points_ledger row's id / type /
 * points / remainingPoints / isExpired / expiresAt / lockedUntil / isClaimed.
 */
export interface WalletGuardState extends WalletFigures {
  txCount: number;
  txDigest: string;
  lotCount: number;
  lotDigest: string;
}

/** Any difference = the backfill itself changed a balance / counter / movement amount / lot (hard failure). */
export function diffWalletGuard(before: WalletGuardState, after: WalletGuardState): string[] {
  const keys: (keyof WalletGuardState)[] = [...V0_FIELDS, 'txCount', 'txDigest', 'lotCount', 'lotDigest'];
  return keys.filter((k) => before[k] !== after[k]).map((k) => `${k}: ${String(before[k])} → ${String(after[k])}`);
}

/** Thrown INSIDE the backfill's wallet transaction when diffWalletGuard is non-empty → that transaction rolls back. */
export class WalletGuardError extends Error {
  constructor(
    readonly walletId: string,
    readonly diff: string[],
  ) {
    super(`V0 wallet guard: the backfill's writes changed wallet ${walletId}: ${diff.join('; ')}`);
    this.name = 'WalletGuardError';
  }
}

/** Throws WalletGuardError when the wallet's guard state moved across the backfill's writes. */
export function assertWalletGuard(walletId: string, before: WalletGuardState, after: WalletGuardState): void {
  const d = diffWalletGuard(before, after);
  if (d.length) throw new WalletGuardError(walletId, d);
}

/** What live traffic did between the two V0 snapshots. */
export interface LiveActivity {
  /** wallets with new movement rows */
  wallets: number;
  /** new movement rows */
  rows: number;
  /** Σ positive balance change of the new rows (earned / credited) */
  earned: number;
  /** Σ |negative balance change| of the new rows (redeemed / expired / debited) */
  redeemed: number;
  /** wallets opened during the run (no figures yet) */
  newWallets: number;
  /** Σ(after) − Σ(before) per figure (only non-zero ones) */
  figureDeltas: Partial<WalletFigures>;
}

export interface V0Reconciliation {
  /** nothing moved at all */
  identical: boolean;
  /** every change is explained by movement rows committed during the run */
  explained: boolean;
  activity: LiveActivity;
  /** Σ(after) − Σ(before) of redeemablePoints */
  tenantBalanceDelta: number;
  /** Σ net balance change of the movement rows committed during the run */
  movementNet: number;
  /** Σ over the unexplained wallets of (balance change − movement net) — 0 when only counters are unexplained */
  unexplainedAmount: number;
  unexplained: { walletId: string; detail: string }[];
}

function figureDeltas(before: WalletFigures, after: WalletFigures): Partial<WalletFigures> {
  const d: Partial<WalletFigures> = {};
  for (const f of V0_FIELDS) if (after[f] !== before[f]) d[f] = after[f] - before[f];
  return d;
}

const fmtDeltas = (d: Partial<WalletFigures>) =>
  Object.entries(d)
    .map(([k, v]) => `${k} ${v! > 0 ? '+' : ''}${v}`)
    .join(', ');

/**
 * Tenant reconciliation over per-wallet snapshots (backfill APPLY): every wallet's balance change must equal the net of
 * its movement rows committed between the snapshots, and a wallet whose figures changed must have new rows. A wallet
 * that disappeared, or lost rows, is unexplained too. The tenant identity Σ(after) − Σ(before) = Σ net is checked on top.
 */
export function reconcileV0Wallets(before: V0WalletRow[], after: V0WalletRow[]): V0Reconciliation {
  const b = new Map(before.map((w) => [w.id, w]));
  const a = new Map(after.map((w) => [w.id, w]));
  const unexplained: { walletId: string; detail: string }[] = [];
  const activity: LiveActivity = { wallets: 0, rows: 0, earned: 0, redeemed: 0, newWallets: 0, figureDeltas: {} };
  let unexplainedAmount = 0;
  let movementNet = 0;
  let identical = before.length === after.length;
  const zero: V0WalletRow = { id: '', ...zeroFigures(), txCount: 0, txIn: 0, txOut: 0 };
  for (const id of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const wb = b.get(id);
    const wa = a.get(id);
    if (!wa) {
      unexplained.push({ walletId: id, detail: 'wallet disappeared during the run' });
      identical = false;
      continue;
    }
    const from = wb ?? zero;
    const fd = figureDeltas(from, wa);
    const rows = wa.txCount - from.txCount;
    const dIn = wa.txIn - from.txIn;
    const dOut = wa.txOut - from.txOut;
    const net = dIn + dOut;
    const dB = wa.redeemablePoints - from.redeemablePoints;
    const changed = Object.keys(fd).length > 0 || rows !== 0 || dIn !== 0 || dOut !== 0;
    if (!wb) {
      identical = false;
      if (!changed) {
        activity.newWallets++;
        continue;
      }
    }
    if (!changed) continue;
    identical = false;
    if (rows < 0 || dIn < 0 || dOut > 0) {
      unexplained.push({ walletId: id, detail: `movement rows went from ${from.txCount} to ${wa.txCount} (Σ in ${from.txIn}→${wa.txIn}, Σ out ${from.txOut}→${wa.txOut}) — rows changed or removed` });
      unexplainedAmount += dB - net;
      continue;
    }
    if (rows === 0) {
      unexplained.push({ walletId: id, detail: `figures changed with no new movement row: ${fmtDeltas(fd)}` });
      unexplainedAmount += dB;
      continue;
    }
    if (dB !== net) {
      unexplained.push({ walletId: id, detail: `balance moved ${dB} but the ${rows} new movement row(s) net ${net} — unexplained ${dB - net}` });
      unexplainedAmount += dB - net;
      continue;
    }
    activity.wallets++;
    activity.rows += rows;
    activity.earned += dIn;
    activity.redeemed += -dOut;
    movementNet += net;
  }
  const sum = (ws: V0WalletRow[]) => ws.reduce((s, w) => s + w.redeemablePoints, 0);
  const tenantBalanceDelta = sum(after) - sum(before);
  const sb = computeV0('', before);
  const sa = computeV0('', after);
  activity.figureDeltas = figureDeltas(sb, sa);
  // The tenant identity: holds whenever every wallet is explained; checked independently so an arithmetic slip can't hide.
  if (unexplained.length === 0 && tenantBalanceDelta !== movementNet) {
    unexplained.push({ walletId: '(tenant)', detail: `Σ balance moved ${tenantBalanceDelta} but Σ new movement rows net ${movementNet}` });
    unexplainedAmount += tenantBalanceDelta - movementNet;
  }
  return { identical, explained: unexplained.length === 0, activity, tenantBalanceDelta, movementNet, unexplainedAmount, unexplained };
}

/**
 * Tenant-level reconciliation from two V0 SUMMARIES (verify job: the baseline is the "V0 before" line APPLY printed —
 * per-wallet rows are too large for an env var). Σ balance change must equal Σ net of the movement rows added since;
 * figures may only move when rows were added; rows / wallets may never disappear. The per-wallet proof that the
 * BACKFILL changed nothing is the APPLY run's own guard (exit 4); this is the tenant cross-check.
 */
export function reconcileV0Totals(before: V0Snapshot, after: V0Snapshot): V0Reconciliation {
  const fd = figureDeltas(before, after);
  const rows = after.txCount - before.txCount;
  const dIn = after.txIn - before.txIn;
  const dOut = after.txOut - before.txOut;
  const net = dIn + dOut;
  const dB = after.redeemablePoints - before.redeemablePoints;
  const unexplained: { walletId: string; detail: string }[] = [];
  const identical = before.balanceDigest === after.balanceDigest && rows === 0 && dIn === 0 && dOut === 0 && before.wallets === after.wallets;
  const hasMovementTotals = [before.txCount, before.txIn, before.txOut].every((v) => typeof v === 'number');
  if (!identical && !hasMovementTotals) {
    unexplained.push({ walletId: '(tenant)', detail: 'baseline has no movement totals (txCount / txIn / txOut) — re-capture it with this version' });
  } else if (!identical) {
    if (after.wallets < before.wallets) unexplained.push({ walletId: '(tenant)', detail: `wallet count fell ${before.wallets} → ${after.wallets}` });
    if (rows < 0 || dIn < 0 || dOut > 0) unexplained.push({ walletId: '(tenant)', detail: `movement rows went from ${before.txCount} to ${after.txCount} (Σ in ${before.txIn}→${after.txIn}, Σ out ${before.txOut}→${after.txOut}) — rows changed or removed` });
    else if (rows === 0 && Object.keys(fd).length > 0) unexplained.push({ walletId: '(tenant)', detail: `figures changed with no new movement row: ${fmtDeltas(fd)}` });
    else if (dB !== net) unexplained.push({ walletId: '(tenant)', detail: `Σ balance moved ${dB} but Σ new movement rows net ${net} — unexplained ${dB - net}` });
  }
  return {
    identical,
    explained: unexplained.length === 0,
    activity: { wallets: 0, rows: Math.max(rows, 0), earned: Math.max(dIn, 0), redeemed: Math.max(-dOut, 0), newWallets: Math.max(after.wallets - before.wallets, 0), figureDeltas: fd },
    tenantBalanceDelta: dB,
    movementNet: net,
    unexplainedAmount: dB - net,
    unexplained,
  };
}

/** "live activity during the run: +X earned / −Y redeemed — explained (…)" */
export function liveActivityLine(r: V0Reconciliation, window = 'during the run'): string {
  const a = r.activity;
  if (r.identical) return `no live activity ${window} — balances, counters and movement rows identical`;
  const where = a.wallets ? ` on ${a.wallets} wallet(s)` : '';
  const opened = a.newWallets ? `; ${a.newWallets} new empty wallet(s)` : '';
  const figs = Object.keys(a.figureDeltas).length ? `; tenant figures ${fmtDeltas(a.figureDeltas)}` : '';
  const head = `live activity ${window}: +${a.earned} earned / −${a.redeemed} redeemed (${a.rows} movement row(s)${where}${opened}; Σ balance ${r.tenantBalanceDelta >= 0 ? '+' : ''}${r.tenantBalanceDelta} = movements net ${r.movementNet >= 0 ? '+' : ''}${r.movementNet}${figs})`;
  if (r.explained) return `${head} — explained`;
  return `${head} — ‼ UNEXPLAINED ${r.unexplainedAmount} pts on ${r.unexplained.length} wallet(s): ${r.unexplained
    .slice(0, 50)
    .map((u) => `${u.walletId} (${u.detail})`)
    .join('; ')}`;
}

/** WARN = passes, but something needs GIFSY's attention (owner rule: never silent) — printed, counted, exit 0. */
export type CheckStatus = 'PASS' | 'FAIL' | 'INFO' | 'SKIP' | 'WARN';

export interface CheckResult {
  check: string;
  clientId: string;
  status: CheckStatus;
  detail: string;
  /** offending ids (capped) */
  ids: string[];
}

export interface VerifyOptions {
  /** V0 baseline captured BEFORE the backfill (the backfill job prints it); absent → V0 reported as INFO */
  v0Baseline?: V0Snapshot;
  /** V5 applies: tenants whose wallets must never carry debt (default: deoleo) */
  neverNegativeTenant: boolean;
  /** V6b: expected multiset of negative balances for this tenant (e.g. Bajaj prod's 8); absent → not checked */
  expectedNegativeBalances?: number[];
}

const CAP = 20;

function result(check: string, clientId: string, bad: string[], passDetail: string, failDetail: string): CheckResult {
  return {
    check,
    clientId,
    status: bad.length === 0 ? 'PASS' : 'FAIL',
    detail: bad.length === 0 ? passDetail : `${bad.length} ${failDetail}`,
    ids: bad.slice(0, CAP),
  };
}

export function isReversibleCreditTx(t: Pick<VTx, 'transactionType' | 'referenceType' | 'referenceId' | 'points'>): boolean {
  return t.transactionType === 'CREDIT_POINTS_EARNED' && t.referenceType === 'CREDIT_BATCH' && !!t.referenceId && t.points > 0;
}

export function runVerifyChecks(snap: VerifySnapshot, opts: VerifyOptions): CheckResult[] {
  const c = snap.clientId;
  const out: CheckResult[] = [];
  // Policy round A (Q1/Q2): a wallet the backfill BLOCKED (still un-sequenced) is not backfilled BY DESIGN — it keeps
  // today's rules and is listed by V10 with its reason; the sequencing checks V1/V2/V3/V7 run on every other wallet.
  const blocked = new Set(snap.wallets.filter((w) => w.backfillStatus === 'BLOCKED' && w.movementSeq === 0).map((w) => w.id));
  const txByWallet = new Map<string, VTx[]>();
  for (const t of snap.txs) {
    const g = txByWallet.get(t.walletId);
    if (g) g.push(t);
    else txByWallet.set(t.walletId, [t]);
  }
  for (const g of txByWallet.values()) g.sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));

  // V0 — vs the baseline APPLY printed: identical, or every change explained by movement rows added since (live
  // earn/redeem traffic is not paused). An unexplained change FAILS. The per-wallet proof that the backfill itself
  // changed nothing is the APPLY run's own in-transaction guard (exit 4).
  const v0 = computeV0(c, v0RowsOf(snap.wallets, snap.txs));
  if (opts.v0Baseline) {
    const r = reconcileV0Totals(opts.v0Baseline, v0);
    out.push({
      check: 'V0 balances/counters unchanged',
      clientId: c,
      status: r.explained ? 'PASS' : 'FAIL',
      detail: r.identical ? `identical (${v0.wallets} wallets, digest ${v0.balanceDigest.slice(0, 12)}…)` : liveActivityLine(r, 'since the APPLY baseline'),
      ids: [],
    });
  } else {
    out.push({ check: 'V0 balances/counters unchanged', clientId: c, status: 'INFO', detail: `no baseline given — snapshot ${JSON.stringify(v0)}`, ids: [] });
  }

  // V1 — seq contiguity: max(seq) = count(rows) = movementSeq; no NULL seq.
  const v1: string[] = [];
  for (const w of snap.wallets) {
    if (blocked.has(w.id)) continue;
    const ts = txByWallet.get(w.id) ?? [];
    const seqs = ts.map((t) => t.seq);
    const nulls = seqs.filter((s) => s === null).length;
    const max = ts.reduce((m, t) => Math.max(m, t.seq ?? 0), 0);
    const distinct = new Set(seqs.filter((s) => s !== null)).size;
    if (nulls > 0 || max !== ts.length || max !== w.movementSeq || distinct !== ts.length) v1.push(w.id);
  }
  out.push(result('V1 seq contiguity', c, v1, 'every wallet: seq 1..n contiguous and = movementSeq', 'wallet(s) with gaps / NULL seq / movementSeq mismatch'));

  // V2 — chain integrity: balanceAfter = previous balanceAfter (0 for the first) + pointsDelta.
  const v2: string[] = [];
  for (const [walletId, ts] of txByWallet) {
    if (blocked.has(walletId)) continue;
    let prev = 0;
    for (const t of ts) {
      if (t.pointsDelta === null || t.balanceAfter !== prev + t.pointsDelta) v2.push(t.id);
      prev = t.balanceAfter;
    }
  }
  out.push(result('V2 chain integrity', c, v2, 'balanceAfter = prev + pointsDelta on every row', 'row(s) break the chain'));

  // V3 — last row's balanceAfter = wallet balance (wallets with history).
  const v3: string[] = [];
  for (const w of snap.wallets) {
    if (blocked.has(w.id)) continue;
    const ts = txByWallet.get(w.id) ?? [];
    const last = ts[ts.length - 1];
    if (last ? last.balanceAfter !== w.redeemablePoints : w.redeemablePoints !== 0) v3.push(w.id);
  }
  out.push(result('V3 last row = wallet balance', c, v3, 'every wallet', 'wallet(s) whose last balanceAfter ≠ redeemablePoints'));

  // V4 — D ≥ 0 and H = B + D ≥ 0.
  const v4 = snap.wallets.filter((w) => w.debtPoints < 0 || w.redeemablePoints + w.debtPoints < 0).map((w) => w.id);
  out.push(result('V4 holdings non-negative', c, v4, 'D ≥ 0 and B + D ≥ 0 everywhere', 'wallet(s) with D < 0 or H < 0'));

  // V5 — never-negative tenant (Deoleo): D = 0, every O = 0, min balanceAfter ≥ 0.
  if (opts.neverNegativeTenant) {
    const bad: string[] = [];
    for (const w of snap.wallets) if (w.debtPoints !== 0 || w.redeemablePoints < 0) bad.push(w.id);
    for (const p of snap.positions) if (p.offsetPoints !== 0) bad.push(p.id);
    for (const t of snap.txs) if (t.balanceAfter < 0) bad.push(t.id);
    out.push(result('V5 never-negative tenant: D = 0, O = 0, min balance ≥ 0', c, bad, `${snap.wallets.length} wallets, ${snap.positions.length} positions all zero-debt`, 'wallet/position/row id(s) violate I5'));
  } else {
    out.push({ check: 'V5 never-negative tenant: D = 0, O = 0, min balance ≥ 0', clientId: c, status: 'SKIP', detail: 'tenant not configured as never-negative', ids: [] });
  }

  // V6 — negative wallets are covered by debt (H ≥ 0), + expected set (Bajaj prod: 8) when configured.
  const negatives = snap.wallets.filter((w) => w.redeemablePoints < 0);
  const uncovered = negatives.filter((w) => w.redeemablePoints + w.debtPoints < 0).map((w) => w.id);
  out.push({
    ...result('V6 negative wallets covered by debt', c, uncovered, '', 'negative wallet(s) with B + D < 0'),
    detail: uncovered.length
      ? `${uncovered.length} negative wallet(s) with B + D < 0`
      : `${negatives.length} negative wallet(s), Σ balance ${negatives.reduce((s, w) => s + w.redeemablePoints, 0)}, Σ debt ${negatives.reduce((s, w) => s + w.debtPoints, 0)}: ${negatives
          .map((w) => `${w.id} B ${w.redeemablePoints} D ${w.debtPoints}`)
          .join('; ')}`,
  });
  if (opts.expectedNegativeBalances) {
    const want = [...opts.expectedNegativeBalances].sort((a, b) => a - b);
    const got = negatives.map((w) => w.redeemablePoints).sort((a, b) => a - b);
    const same = want.length === got.length && want.every((v, i) => v === got[i]);
    out.push({
      check: 'V6b expected negative balances unchanged',
      clientId: c,
      status: same ? 'PASS' : 'FAIL',
      detail: `expected [${want.join(', ')}] (Σ ${want.reduce((s, v) => s + v, 0)}), found [${got.join(', ')}] (Σ ${got.reduce((s, v) => s + v, 0)})`,
      ids: negatives.map((w) => w.id).slice(0, CAP),
    });
  }

  // V7 — position coverage: every credit-batch POINTS credit has exactly one position on its own wallet; attribution counts.
  const posByCredit = new Map(snap.positions.map((p) => [p.creditTxId, p]));
  const txById = new Map(snap.txs.map((t) => [t.id, t]));
  const v7: string[] = [];
  for (const t of snap.txs) {
    if (!isReversibleCreditTx(t) || blocked.has(t.walletId)) continue;
    const p = posByCredit.get(t.id);
    if (!p || p.walletId !== t.walletId || p.amount !== t.points) v7.push(t.id);
  }
  for (const p of snap.positions) {
    const t = txById.get(p.creditTxId);
    if (!t || !isReversibleCreditTx(t)) v7.push(p.id);
  }
  const attr: Record<string, number> = {};
  for (const p of snap.positions) attr[p.attribution] = (attr[p.attribution] ?? 0) + 1;
  out.push({
    ...result('V7 position coverage', c, v7, '', 'credit(s)/position(s) without a matching counterpart (or wrong wallet/amount)'),
    detail: v7.length ? `${v7.length} credit(s)/position(s) without a matching counterpart (or wrong wallet/amount); attribution ${JSON.stringify(attr)}` : `every credit-batch credit has its position; attribution ${JSON.stringify(attr)}`,
  });

  // V8 — reversedPoints = Σ allocations.requested ≤ amount.
  const allocSum = new Map<string, number>();
  for (const a of snap.allocations) allocSum.set(a.positionId, (allocSum.get(a.positionId) ?? 0) + a.requested);
  const v8 = snap.positions.filter((p) => p.reversedPoints !== (allocSum.get(p.id) ?? 0) || p.reversedPoints > p.amount).map((p) => p.id);
  const owed = snap.allocations.reduce((s, a) => s + (a.overReversalDebt ? 0 : a.owed ?? 0), 0);
  const debtOwed = snap.allocations.reduce((s, a) => s + (a.overReversalDebt ? a.owed ?? 0 : 0), 0);
  const recovered = snap.allocations.reduce((s, a) => s + (a.recovered ?? 0), 0);
  out.push(
    result(
      'V8 reversedPoints = Σ allocations ≤ amount',
      c,
      v8,
      `${snap.allocations.length} allocation(s) reconcile; recovered ${recovered}, owed ${owed}${owed > 0 ? ' (historical clawbacks beyond holdings, booked as debt — not recovered)' : ''}` +
        (debtOwed > 0 ? `; ${debtOwed} booked as debt by V2 over-reversals (repaid from future earnings — not recovered, not written off)` : ''),
      'position(s) mismatch',
    ),
  );

  // V9 — no payout entry in two live reversals.
  const live = new Set(['RESERVED', 'APPLIED_CANCELLED', 'APPLIED_RECEIVABLE']);
  const cnt = new Map<string, number>();
  for (const a of snap.payoutAllocations) if (live.has(a.state)) cnt.set(a.payoutEntryId, (cnt.get(a.payoutEntryId) ?? 0) + 1);
  const v9 = [...cnt].filter(([, n]) => n > 1).map(([id]) => id);
  out.push(result('V9 payout entry in ≤ 1 live reversal', c, v9, `${snap.payoutAllocations.length} payout allocation(s)`, 'payout entr(y/ies) in two live reversals'));

  // V9b — the WP5 payout backfill planner, re-run read-only: an approved PAYOUT reversal it would STILL give rows (the
  // backfill was not applied for it — e.g. approved under LEGACY since) or that it flags (ambiguous / double
  // consumption / …) needs Gifsy. WARN, never silent.
  if (snap.payoutBackfill) {
    const pp = planPayoutAllocationBackfill(snap.payoutBackfill);
    const pendingRows = [...new Set(pp.allocations.map((a) => a.creditReversalId))];
    const flagged = pp.flags.filter((f) => f.severity !== 'INFO');
    const bad = [...pendingRows, ...flagged.map((f) => f.creditReversalId)];
    out.push({
      check: 'V9b payout reversal allocations backfilled',
      clientId: c,
      status: bad.length ? 'WARN' : 'PASS',
      detail: bad.length
        ? `${pendingRows.length} approved PAYOUT reversal(s) still without allocation rows (re-run the backfill); ${flagged.length} flag(s): ${flagged
            .map((f) => `${f.creditReversalId} ${f.severity} ${f.code} — ${f.detail}`)
            .join('; ')}`
        : `${snap.payoutBackfill.reversals.length} PAYOUT reversal(s): every approved one has its allocation rows`,
      ids: [...new Set(bad)].slice(0, CAP),
    });
  } else {
    out.push({ check: 'V9b payout reversal allocations backfilled', clientId: c, status: 'SKIP', detail: 'payout input not loaded', ids: [] });
  }

  // V10 — wallets needing Gifsy attention (Q1/Q2): BLOCKED by the backfill, with the reason. They keep today's rules;
  // POINTS reversals on them are refused until Gifsy fixes the history and re-runs the backfill.
  const blockedRows = snap.wallets.filter((w) => blocked.has(w.id));
  out.push({
    check: 'V10 wallets needing Gifsy attention',
    clientId: c,
    status: blockedRows.length ? 'WARN' : 'PASS',
    detail: blockedRows.length
      ? `${blockedRows.length} wallet(s) BLOCKED by the backfill — earn/redeem on today's rules, points reversals refused (reasons: GET /v1/admin/credits/reversal-engine/attention or the backfill ATTENTION block)`
      : 'none',
    ids: blockedRows.map((w) => w.id).slice(0, CAP),
  });

  return out;
}

/** The §9 queries, verbatim in spirit and tenant-scoped, for a manual psql cross-check (read-only; guard first). */
export const VERIFY_SQL = `
-- Guard every session first:  SELECT current_database();
-- V0 snapshot before AND after backfill: identical, or Δ sum(redeemable) = Δ (txIn + txOut) of the movement rows added
-- in between (live earn/redeem traffic is not paused); counters may only move when rows were added
SELECT cp."clientId", count(*), sum(w."redeemablePoints"), sum(w."earnedPoints"), sum(w."lifetimeEarned"),
       sum(w."redeemedPoints"), sum(w."expiredPoints"), sum(m.n) AS "txCount", sum(m.cin) AS "txIn", sum(m.cout) AS "txOut"
FROM wallets w JOIN channel_partners cp ON cp.id = w."partnerId"
LEFT JOIN LATERAL (SELECT count(*) n, coalesce(sum(greatest(t."balanceAfter" - t."balanceBefore", 0)), 0) cin,
  coalesce(sum(least(t."balanceAfter" - t."balanceBefore", 0)), 0) cout FROM wallet_transactions t WHERE t."walletId" = w.id) m ON true
GROUP BY 1 ORDER BY 1;
-- V1 seq contiguity (expect 0 rows)
SELECT w.id FROM wallets w LEFT JOIN wallet_transactions t ON t."walletId" = w.id
GROUP BY w.id, w."movementSeq" HAVING coalesce(max(t.seq),0) <> count(t.id) OR coalesce(max(t.seq),0) <> w."movementSeq"
   OR count(t.id) <> count(t.seq);
-- V2 chain integrity (expect 0 rows)
SELECT * FROM (SELECT id, "walletId", seq, "pointsDelta", "balanceAfter",
  lag("balanceAfter") OVER (PARTITION BY "walletId" ORDER BY seq) AS prev FROM wallet_transactions) x
WHERE "balanceAfter" <> coalesce(prev, 0) + "pointsDelta" OR "pointsDelta" IS NULL;
-- V3 last row == wallet balance (expect 0 rows)
SELECT w.id FROM wallets w JOIN LATERAL (SELECT "balanceAfter" FROM wallet_transactions t
  WHERE t."walletId" = w.id ORDER BY seq DESC LIMIT 1) l ON true WHERE l."balanceAfter" <> w."redeemablePoints";
-- V4 holdings non-negative (expect 0 rows)
SELECT id FROM wallets WHERE "debtPoints" < 0 OR "redeemablePoints" + "debtPoints" < 0;
-- V5 Deoleo zero debt / zero offsets / min balanceAfter >= 0 (expect 0 rows each)
SELECT w.id FROM wallets w JOIN channel_partners cp ON cp.id = w."partnerId" WHERE cp."clientId" = 'deoleo' AND (w."debtPoints" <> 0 OR w."redeemablePoints" < 0);
SELECT p.id FROM wallet_credit_positions p JOIN wallets w ON w.id = p."walletId" JOIN channel_partners cp ON cp.id = w."partnerId" WHERE cp."clientId" = 'deoleo' AND p."offsetPoints" <> 0;
SELECT t.id FROM wallet_transactions t JOIN wallets w ON w.id = t."walletId" JOIN channel_partners cp ON cp.id = w."partnerId" WHERE cp."clientId" = 'deoleo' AND t."balanceAfter" < 0;
-- V6 negative wallets (Bajaj prod expect 8: -840,-612,-520,-360,-360,-297,-280,-280) covered by debt
SELECT w.id, w."redeemablePoints", w."debtPoints", w."redeemablePoints" + w."debtPoints" AS holdings FROM wallets w WHERE w."redeemablePoints" < 0;
-- V7 position coverage (expect 0 rows) + attribution counts
SELECT t.id FROM wallet_transactions t LEFT JOIN wallet_credit_positions p ON p."creditTxId" = t.id
WHERE t."transactionType" = 'CREDIT_POINTS_EARNED' AND t."referenceType" = 'CREDIT_BATCH' AND t.points > 0 AND p.id IS NULL;
SELECT attribution, count(*) FROM wallet_credit_positions GROUP BY 1;
-- V8 reversedPoints == Σ allocations <= amount (expect 0 rows)
SELECT p.id FROM wallet_credit_positions p LEFT JOIN credit_reversal_allocations a ON a."positionId" = p.id
GROUP BY p.id, p."reversedPoints", p.amount HAVING p."reversedPoints" <> coalesce(sum(a.requested),0) OR p."reversedPoints" > p.amount;
-- V9 no payout entry in two live reversals (expect 0 rows)
SELECT "payoutEntryId" FROM payout_reversal_allocations WHERE state IN ('RESERVED','APPLIED_CANCELLED','APPLIED_RECEIVABLE')
GROUP BY 1 HAVING count(*) > 1;
`;
