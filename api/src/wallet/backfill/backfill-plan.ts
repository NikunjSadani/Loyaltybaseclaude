/**
 * Wallet Reversal Engine — WP6 one-off BACKFILL planner (PURE: no Prisma, no I/O, no clock).
 *
 * Source of truth: platform/docs/plans/WALLET-REVERSAL-ENGINE-DESIGN.md §9 (backfill steps 1–5), Q5 (unresolvable
 * credits refused until mapped), Q13 (historical clawbacks kept as recorded and only classified), §4 (data model).
 * All money math is delegated to the WP0 oracle `replay()` (../reversal-model) — never re-implemented here.
 *
 * Per wallet it:
 *   1. orders the wallet's WalletTransactions by CHAIN-FOLLOWING the recorded `balanceAfter` from 0
 *      (createdAt order first; ±10 s window search when it breaks; no unique continuation → BLOCKING anomaly),
 *   2. assigns seq 1..n + pointsDelta (= balanceAfter − previous balanceAfter) and pairs each row with its PointsLedger row,
 *   3. attributes every credit-batch POINTS credit (metadata → EXACT, offline legacy pairing → LEGACY_REPLAY,
 *      else UNRESOLVED) and every historical clawback (CREDIT_REVERSAL debit) to the credit it reversed,
 *   4. calls WP0 `replay()` to derive D (debtPoints), each credit's offset O_X and ρ_X, and classifies the clawbacks,
 *   5. asserts replayed B == redeemablePoints, D ≥ 0, H ≥ 0, 0 ≤ O ≤ a, ρ ≤ a, and I5 (never-negative ⇒ D = 0, O = 0).
 *
 * The output is a PLAN OF WRITES. It never contains a balance, counter or lot write → zero balance change by
 * construction. A wallet with any BLOCKING anomaly gets no writes at all. Planning is deterministic (same input →
 * byte-identical plan), so re-running is idempotent; a wallet whose `movementSeq > 0` and whose rows are all
 * sequenced is DONE and skipped (resume).
 */
import { HistoricalEvent, replay, ReplayAnomaly } from '../reversal-model';

// ───────────────────────────── input rows (what the job loads; mirrors the Prisma columns) ─────────────────────────────

export interface BfTxRow {
  id: string;
  walletId: string;
  transactionType: string;
  points: number;
  balanceBefore: number;
  balanceAfter: number;
  balanceType: string;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  metadata: unknown;
  createdAt: Date;
  seq: number | null;
  pointsDelta: number | null;
  reversedCreditTxId: string | null;
  creditReversalId: string | null;
  pointsLedgerId: string | null;
}

export interface BfLedgerRow {
  id: string;
  walletId: string;
  transactionType: string;
  points: number;
  isExpired: boolean;
  sourceType: string | null;
  sourceId: string | null;
  notes: string | null;
  createdAt: Date;
}

export interface BfWalletRow {
  id: string;
  partnerId: string;
  clientId: string;
  redeemablePoints: number;
  debtPoints: number;
  movementSeq: number;
}

export interface BfWalletHistory {
  wallet: BfWalletRow;
  txs: BfTxRow[];
  ledgers: BfLedgerRow[];
  /** outlet codes CURRENTLY linked to the wallet's partner (same tenant) — the legacy pairing input */
  currentOutletCodes: string[];
  /** wallet_credit_positions rows that already exist for this wallet */
  existingPositionCount: number;
  /**
   * Cheap re-run (owner Q5): for a wallet already sequenced (movementSeq > 0) the store may load only these counts
   * (plus its clawback rows in `txs`, for the tenant-level attribution) instead of the full history. The planner
   * then decides DONE / SEQ_STATE_MIXED from the counts.
   */
  sequencedSummary?: { txCount: number; sequencedCount: number; maxSeq: number };
}

export interface BfBatch {
  id: string;
  clientId: string;
  /** CreditBatch.rows JSON */
  rows: unknown;
}

export interface BfReversal {
  id: string;
  clientId: string;
  batchId: string;
  outletId: string;
  fieldId: string;
  awardType: string;
  status: string;
  /** whole points for POINTS reversals */
  approvedPaise: bigint | null;
}

export interface BfTenantContext {
  clientId: string;
  batches: Map<string, BfBatch>;
  /** POINTS CreditReversals of the tenant, by id */
  reversals: Map<string, BfReversal>;
  /** CreditReversal ids that already have a credit_reversal_allocations row (wallets backfilled in an earlier run) */
  alreadyAllocatedReversalIds: Set<string>;
}

// ───────────────────────────── output (the plan) ─────────────────────────────

export type Severity = 'BLOCKING' | 'WARNING';

export interface BfAnomaly {
  clientId: string;
  walletId: string | null;
  txId: string | null;
  code: string;
  severity: Severity;
  detail: string;
}

export type Attribution = 'EXACT' | 'LEGACY_REPLAY' | 'MANUAL' | 'UNRESOLVED';

export interface TxUpdate {
  txId: string;
  seq: number;
  pointsDelta: number;
  pointsLedgerId: string | null;
  reversedCreditTxId: string | null;
  creditReversalId: string | null;
}

export interface PositionInsert {
  walletId: string;
  creditTxId: string;
  lotId: string | null;
  batchId: string;
  outletCode: string | null;
  fieldId: string | null;
  amount: number;
  offsetPoints: number;
  reversedPoints: number;
  attribution: Attribution;
}

export interface AllocationInsert {
  creditReversalId: string;
  /** the position is identified by its credit tx (positions are inserted in the same transaction) */
  creditTxId: string;
  requested: number;
  debtRestored: number;
  /** points actually taken from what the wallet HELD (never the part that went beyond holdings — Q4) */
  recovered: number;
  /** Q4: the part of a historical clawback that went beyond holdings and was booked as debt ("owed") */
  owed: number;
  shortfall: number;
}

export type WalletPlanStatus = 'PLANNED' | 'NOOP' | 'DONE' | 'BLOCKED';

export interface WalletPlan {
  walletId: string;
  clientId: string;
  status: WalletPlanStatus;
  /** optimistic-concurrency fingerprint: the apply step re-reads the wallet under its row lock and re-plans */
  fingerprint: { redeemablePoints: number; txCount: number; maxCreatedAt: string | null };
  redeemablePoints: number;
  debtPoints: number;
  movementSeq: number;
  /** the wallet's balanceAfter chain never went below 0 (Deoleo-style; I5 asserted) */
  neverNegative: boolean;
  minBalance: number;
  txUpdates: TxUpdate[];
  positions: PositionInsert[];
  allocations: AllocationInsert[];
  anomalies: BfAnomaly[];
}

export interface TenantAdjustments {
  /** `${batchId}|${outletCode}|${fieldId}` keys whose positions must be UNRESOLVED (an approved reversal of that key
   *  could not be attributed to any credit position → its cap is unknown → reversals refused until Gifsy maps it). */
  downgradeKeys: Set<string>;
}

export interface TenantPlan {
  clientId: string;
  wallets: WalletPlan[];
  adjustments: TenantAdjustments;
  /** tenant-level anomalies (not tied to one wallet) */
  anomalies: BfAnomaly[];
}

// ───────────────────────────── constants ─────────────────────────────

export const CHAIN_WINDOW_MS = 10_000;
export const APPROVED_REVERSAL_STATUSES = new Set(['APPROVED', 'PARTIAL']);
const UNSUPPORTED_TX_TYPES = new Set(['LOCK_HOLDING', 'UNLOCK_HOLDING']);

/** WP0 replay anomaly → severity (blocking = the wallet gets no writes until the owner resolves it). */
const REPLAY_SEVERITY: Record<ReplayAnomaly['code'], Severity> = {
  CLAWBACK_UNKNOWN_CREDIT: 'WARNING', // T-h2 — kept as recorded, classified as a debit, flagged
  CLAWBACK_BEYOND_HOLDINGS: 'WARNING', // Q13 — excess booked as debt, flagged
  CLAWBACK_OVER_CAP: 'BLOCKING',
  EXPIRY_EXCESS_EXCEEDS_DEBT: 'BLOCKING',
  EXPIRY_LOT_LESS_THAN_EXPIRED: 'BLOCKING',
  BAD_DELTA_SIGN: 'BLOCKING',
  DUPLICATE_CREDIT: 'BLOCKING',
  FINAL_BALANCE_MISMATCH: 'BLOCKING',
};

// ───────────────────────────── helpers ─────────────────────────────

export function metaOf(m: unknown): Record<string, unknown> | null {
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
}

function byCreatedAtThenId(a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }): number {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function positionKey(batchId: string, outletCode: string | null, fieldId: string | null): string {
  return `${batchId}|${outletCode ?? ''}|${fieldId ?? ''}`;
}

/** A credit-batch POINTS credit — the only reversible credit (gets a WalletCreditPosition). */
export function isBatchCredit(t: { transactionType: string; referenceType: string | null; referenceId: string | null; points: number }): boolean {
  return t.transactionType === 'CREDIT_POINTS_EARNED' && t.referenceType === 'CREDIT_BATCH' && !!t.referenceId && t.points > 0;
}

/** A historical clawback (credit-batch POINTS reversal) written by clawbackAward. */
export function isClawback(t: { transactionType: string; referenceType: string | null; points: number }): boolean {
  return t.points < 0 && t.transactionType === 'DEBIT_ADJUSTMENT' && t.referenceType === 'CREDIT_REVERSAL';
}

/**
 * Allowed recorded balance change δ for a row: credits are never clamped (δ = points); debits may have been floored
 * by the legacy write path (points ≤ δ ≤ 0 — guarded debits / vendor rows have δ = points, which is inside the range).
 */
function fits(t: BfTxRow, cur: number): boolean {
  const delta = t.balanceAfter - cur;
  if (t.points > 0) return delta === t.points;
  if (t.points < 0) return delta >= t.points && delta <= 0;
  return delta === 0;
}

// ───────────────────────────── step 1: chain-following order ─────────────────────────────

export type ChainResult =
  | { ok: true; ordered: BfTxRow[]; warnings: { txId: string; code: string; detail: string }[] }
  | { ok: false; txId: string | null; code: 'CHAIN_BROKEN' | 'CHAIN_AMBIGUOUS'; detail: string; orderedSoFar: number };

/**
 * Order a wallet's rows by following the exact recorded balanceAfter chain from 0. The next row in (createdAt, id)
 * order is taken when it continues the chain; otherwise every not-yet-used row within ±windowMs of it is searched.
 * Exactly one fitting candidate (or several that are indistinguishable on the balance path: same points and
 * balanceAfter → earliest by time) continues the chain; none or several distinct → anomaly (the caller writes nothing).
 */
export function orderChain(txs: BfTxRow[], windowMs: number = CHAIN_WINDOW_MS): ChainResult {
  const sorted = [...txs].sort(byCreatedAtThenId);
  const used = new Array<boolean>(sorted.length).fill(false);
  const ordered: BfTxRow[] = [];
  const warnings: { txId: string; code: string; detail: string }[] = [];
  let cur = 0;
  let firstFree = 0;
  for (let step = 0; step < sorted.length; step++) {
    while (used[firstFree]) firstFree++;
    const head = sorted[firstFree];
    let pick = -1;
    if (fits(head, cur)) {
      pick = firstFree;
    } else {
      const cands: number[] = [];
      for (let i = 0; i < sorted.length; i++) {
        if (used[i]) continue;
        if (Math.abs(sorted[i].createdAt.getTime() - head.createdAt.getTime()) > windowMs) continue;
        if (fits(sorted[i], cur)) cands.push(i);
      }
      if (cands.length === 0) {
        return {
          ok: false,
          txId: head.id,
          code: 'CHAIN_BROKEN',
          detail: `no row within ±${windowMs / 1000}s continues the balance chain from ${cur} (next by time: ${head.id} ${head.transactionType} points ${head.points} balanceAfter ${head.balanceAfter})`,
          orderedSoFar: ordered.length,
        };
      }
      const c0 = sorted[cands[0]];
      const equivalent = cands.every((i) => sorted[i].points === c0.points && sorted[i].balanceAfter === c0.balanceAfter);
      if (cands.length > 1 && !equivalent) {
        return {
          ok: false,
          txId: head.id,
          code: 'CHAIN_AMBIGUOUS',
          detail: `${cands.length} rows could continue the balance chain from ${cur}: ${cands.map((i) => sorted[i].id).join(', ')}`,
          orderedSoFar: ordered.length,
        };
      }
      pick = cands[0]; // sorted ⇒ earliest by (createdAt, id)
      if (cands.length > 1 && new Set(cands.map((i) => sorted[i].referenceId ?? '')).size > 1) {
        warnings.push({
          txId: sorted[pick].id,
          code: 'CHAIN_TIE_BROKEN_BY_TIME',
          detail: `indistinguishable rows ${cands.map((i) => sorted[i].id).join(', ')} (different references) ordered by createdAt`,
        });
      }
      warnings.push({
        txId: sorted[pick].id,
        code: 'CHAIN_REORDERED',
        detail: `createdAt order broken at ${head.id}; continued with ${sorted[pick].id}`,
      });
    }
    used[pick] = true;
    ordered.push(sorted[pick]);
    cur = sorted[pick].balanceAfter;
  }
  return { ok: true, ordered, warnings };
}

// ───────────────────────────── step 2: PointsLedger pairing ─────────────────────────────

/**
 * Pair each WalletTransaction with the PointsLedger row applyMovement (or the vendor import) wrote with it: same wallet,
 * same signed points, same text (ledger.notes = tx.description), and — when the tx carries a credit field — the same
 * ledger sourceId. Among candidates the closest createdAt wins (both default to the transaction start; credit-batch
 * rows stamp the tx later), ties by (createdAt, id). A tx already linked keeps its link. Unpaired → null (+ warning).
 */
export function pairLedgers(ordered: BfTxRow[], ledgers: BfLedgerRow[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const taken = new Set<string>();
  for (const t of ordered) if (t.pointsLedgerId) taken.add(t.pointsLedgerId);
  const groups = new Map<string, BfLedgerRow[]>();
  const keyOf = (points: number, text: string | null) => `${points}|${text ?? ''}`;
  for (const l of [...ledgers].sort(byCreatedAtThenId)) {
    if (taken.has(l.id)) continue;
    const k = keyOf(l.points, l.notes);
    const g = groups.get(k);
    if (g) g.push(l);
    else groups.set(k, [l]);
  }
  for (const t of ordered) {
    if (t.pointsLedgerId) {
      out.set(t.id, t.pointsLedgerId);
      continue;
    }
    const g = groups.get(keyOf(t.points, t.description)) ?? [];
    const fieldId = metaOf(t.metadata)?.fieldId;
    let best = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < g.length; i++) {
      const l = g[i];
      if (taken.has(l.id)) continue;
      if (typeof fieldId === 'string' && l.sourceType === 'CREDIT_FIELD' && l.sourceId !== fieldId) continue;
      const diff = Math.abs(l.createdAt.getTime() - t.createdAt.getTime());
      if (diff < bestDiff) {
        best = i;
        bestDiff = diff;
      }
    }
    if (best >= 0) {
      taken.add(g[best].id);
      out.set(t.id, g[best].id);
    } else {
      out.set(t.id, null);
    }
  }
  return out;
}

// ───────────────────────────── step 3: credit attribution ─────────────────────────────

interface CreditAttr {
  batchId: string;
  outletCode: string | null;
  fieldId: string | null;
  attribution: Attribution;
}

interface BatchRow {
  outletId?: unknown;
  fieldId?: unknown;
  amount?: unknown;
  awardType?: unknown;
  status?: unknown;
}

/**
 * Attribute a wallet's credit-batch credits (in chain order). Per batch:
 *  - credits with metadata { fieldId, outletCode } (confirmBatch since 2026-11-12) → EXACT (Q4: the receiving wallet,
 *    whatever the outlet's current owner);
 *  - legacy credits (no metadata) → offline port of WalletService.pairLegacyBatchCredits: the batch's POINTS / OK /
 *    amount > 0 rows for the partner's CURRENT outlets, in row order, must fit the credits exactly (same count, every
 *    amount equal) → LEGACY_REPLAY; anything else (outlet relinked since, row skipped at confirm, batch missing, a
 *    batch mixing both kinds) → UNRESOLVED (Q5: reversals refused until Gifsy maps it).
 */
export function attributeCredits(
  credits: BfTxRow[],
  currentOutletCodes: string[],
  batches: Map<string, BfBatch>,
): { attrs: Map<string, CreditAttr>; warnings: { txId: string; code: string; detail: string }[] } {
  const attrs = new Map<string, CreditAttr>();
  const warnings: { txId: string; code: string; detail: string }[] = [];
  const byBatch = new Map<string, BfTxRow[]>();
  for (const c of credits) {
    const b = c.referenceId!;
    const g = byBatch.get(b);
    if (g) g.push(c);
    else byBatch.set(b, [c]);
  }
  const codes = new Set(currentOutletCodes);
  for (const [batchId, cs] of byBatch) {
    const withMeta = cs.filter((c) => typeof metaOf(c.metadata)?.fieldId === 'string');
    const legacy = cs.filter((c) => typeof metaOf(c.metadata)?.fieldId !== 'string');
    for (const c of withMeta) {
      const m = metaOf(c.metadata)!;
      const outletCode = typeof m.outletCode === 'string' ? m.outletCode : null;
      if (outletCode) {
        attrs.set(c.id, { batchId, outletCode, fieldId: m.fieldId as string, attribution: 'EXACT' });
      } else {
        attrs.set(c.id, { batchId, outletCode: null, fieldId: m.fieldId as string, attribution: 'UNRESOLVED' });
        warnings.push({ txId: c.id, code: 'UNRESOLVED_CREDIT', detail: `credit metadata has fieldId but no outletCode (batch ${batchId})` });
      }
    }
    if (legacy.length === 0) continue;
    const unresolved = (why: string) => {
      for (const c of legacy) {
        attrs.set(c.id, { batchId, outletCode: null, fieldId: null, attribution: 'UNRESOLVED' });
        warnings.push({ txId: c.id, code: 'UNRESOLVED_CREDIT', detail: `legacy credit of batch ${batchId}: ${why}` });
      }
    };
    if (withMeta.length > 0) {
      unresolved('batch mixes credits with and without metadata');
      continue;
    }
    const batch = batches.get(batchId);
    if (!batch || !Array.isArray(batch.rows)) {
      unresolved('batch rows unavailable');
      continue;
    }
    const rows = (batch.rows as BatchRow[]).filter(
      (r) =>
        !!r &&
        r.awardType === 'POINTS' &&
        r.status === 'OK' &&
        typeof r.amount === 'number' &&
        r.amount > 0 &&
        typeof r.outletId === 'string' &&
        codes.has(r.outletId),
    );
    if (rows.length !== legacy.length) {
      unresolved(`${legacy.length} credit(s) vs ${rows.length} POINTS row(s) for the partner's current outlets (outlet relinked or row skipped)`);
      continue;
    }
    if (rows.some((r, k) => r.amount !== legacy[k].points)) {
      unresolved('credit amounts do not match the batch rows in order');
      continue;
    }
    legacy.forEach((c, k) => {
      const r = rows[k];
      const fieldId = typeof r.fieldId === 'string' ? r.fieldId : null;
      attrs.set(c.id, {
        batchId,
        outletCode: r.outletId as string,
        fieldId,
        attribution: fieldId ? 'LEGACY_REPLAY' : 'UNRESOLVED',
      });
      if (!fieldId) warnings.push({ txId: c.id, code: 'UNRESOLVED_CREDIT', detail: `batch ${batchId} row has no fieldId` });
    });
  }
  return { attrs, warnings };
}

// ───────────────────────────── step 3–5: one wallet ─────────────────────────────

function emptyPlan(h: BfWalletHistory, status: WalletPlanStatus): WalletPlan {
  const maxCreatedAt = h.txs.length ? new Date(Math.max(...h.txs.map((t) => t.createdAt.getTime()))).toISOString() : null;
  return {
    walletId: h.wallet.id,
    clientId: h.wallet.clientId,
    status,
    fingerprint: { redeemablePoints: h.wallet.redeemablePoints, txCount: h.txs.length, maxCreatedAt },
    redeemablePoints: h.wallet.redeemablePoints,
    debtPoints: h.wallet.debtPoints,
    movementSeq: h.wallet.movementSeq,
    neverNegative: true,
    minBalance: 0,
    txUpdates: [],
    positions: [],
    allocations: [],
    anomalies: [],
  };
}

/**
 * Plan one wallet. `adj` carries the tenant-level downgrades (computed by planTenant from every wallet); passing the
 * same adjustments always yields the same plan, which is how the apply step re-validates a wallet under its lock.
 */
export function planWallet(h: BfWalletHistory, ctx: BfTenantContext, adj?: TenantAdjustments): WalletPlan {
  const plan = emptyPlan(h, 'PLANNED');
  const w = h.wallet;
  const add = (code: string, severity: Severity, detail: string, txId: string | null = null) =>
    plan.anomalies.push({ clientId: w.clientId, walletId: w.id, txId, code, severity, detail });
  const block = () => {
    plan.status = 'BLOCKED';
    plan.txUpdates = [];
    plan.positions = [];
    plan.allocations = [];
    plan.debtPoints = w.debtPoints;
    plan.movementSeq = w.movementSeq;
    return plan;
  };

  // ── resume / pre-state ──
  const sequenced = h.txs.filter((t) => t.seq !== null);
  if (w.movementSeq > 0) {
    const sum = h.sequencedSummary ?? {
      txCount: h.txs.length,
      sequencedCount: sequenced.length,
      maxSeq: sequenced.reduce((m, t) => Math.max(m, t.seq!), 0),
    };
    if (sum.sequencedCount === sum.txCount && sum.maxSeq === sum.txCount && sum.maxSeq === w.movementSeq) {
      plan.status = 'DONE';
      return plan;
    }
    add('SEQ_STATE_MIXED', 'BLOCKING', `movementSeq ${w.movementSeq} but ${sum.sequencedCount}/${sum.txCount} rows sequenced (max seq ${sum.maxSeq})`);
    return block();
  }
  if (sequenced.length > 0) {
    add('SEQ_STATE_MIXED', 'BLOCKING', `movementSeq 0 but ${sequenced.length} row(s) already carry a seq`);
    return block();
  }
  if (w.debtPoints !== 0) {
    add('DEBT_PREEXISTS', 'BLOCKING', `debtPoints ${w.debtPoints} on a wallet not yet backfilled`);
    return block();
  }
  if (h.existingPositionCount > 0) {
    add('POSITIONS_PREEXIST', 'BLOCKING', `${h.existingPositionCount} wallet_credit_positions row(s) exist before the backfill`);
    return block();
  }
  if (h.txs.length === 0) {
    if (w.redeemablePoints !== 0) {
      add('BALANCE_WITHOUT_HISTORY', 'BLOCKING', `redeemablePoints ${w.redeemablePoints} with no wallet_transactions`);
      return block();
    }
    plan.status = 'NOOP';
    return plan;
  }
  for (const t of h.txs) {
    if (UNSUPPORTED_TX_TYPES.has(t.transactionType) || t.balanceType !== 'REDEEMABLE') {
      add('UNSUPPORTED_ROW', 'BLOCKING', `${t.transactionType} / balanceType ${t.balanceType} — not on the redeemable chain`, t.id);
    } else if (t.points === 0) {
      add('ZERO_POINTS_ROW', 'BLOCKING', `${t.transactionType} with points 0`, t.id);
    }
  }
  if (plan.anomalies.some((a) => a.severity === 'BLOCKING')) return block();

  // ── 1. chain order ──
  const chain = orderChain(h.txs);
  if (!chain.ok) {
    add(chain.code, 'BLOCKING', `${chain.detail} (ordered ${chain.orderedSoFar}/${h.txs.length})`, chain.txId);
    return block();
  }
  for (const wn of chain.warnings) add(wn.code, 'WARNING', wn.detail, wn.txId);
  const ordered = chain.ordered;

  // ── 3a. credit attribution ──
  const credits: BfTxRow[] = [];
  for (const t of ordered) {
    if (!isBatchCredit(t)) continue;
    const batch = ctx.batches.get(t.referenceId!);
    if (batch && batch.clientId !== w.clientId) {
      add('TENANT_MISMATCH', 'BLOCKING', `credit from batch ${batch.id} of tenant ${batch.clientId}`, t.id);
      continue;
    }
    if (!batch) {
      // Position needs a CreditBatch FK; without it the credit cannot be a position → it is never reversible.
      add('POSITION_BATCH_MISSING', 'WARNING', `credit batch ${t.referenceId} not found — credit treated as non-reversible`, t.id);
      continue;
    }
    credits.push(t);
  }
  if (plan.anomalies.some((a) => a.severity === 'BLOCKING')) return block();
  const { attrs, warnings: attrWarnings } = attributeCredits(credits, h.currentOutletCodes, ctx.batches);
  for (const wn of attrWarnings) add(wn.code, 'WARNING', wn.detail, wn.txId);
  if (adj) {
    for (const [txId, a] of attrs) {
      if (a.attribution !== 'UNRESOLVED' && adj.downgradeKeys.has(positionKey(a.batchId, a.outletCode, a.fieldId))) {
        attrs.set(txId, { ...a, attribution: 'UNRESOLVED' });
        add('UNRESOLVED_BY_UNATTRIBUTED_REVERSAL', 'WARNING', `an approved reversal of ${positionKey(a.batchId, a.outletCode, a.fieldId)} could not be attributed to a credit — position left UNRESOLVED`, txId);
      }
    }
  }

  // ── 3b. clawback attribution (chain order; cap tracked per position) ──
  const reversedSoFar = new Map<string, number>();
  const amountOf = new Map(credits.map((c) => [c.id, c.points]));
  const clawCredit = new Map<string, { creditTxId: string; reversal: BfReversal } | null>();
  const allocatedPairs = new Set<string>();
  for (const t of ordered) {
    if (!isClawback(t)) continue;
    const requested = -t.points;
    const reversal = t.referenceId ? ctx.reversals.get(t.referenceId) : undefined;
    if (!reversal || reversal.clientId !== w.clientId || reversal.awardType !== 'POINTS' || !APPROVED_REVERSAL_STATUSES.has(reversal.status)) {
      clawCredit.set(t.id, null);
      add('CLAWBACK_REVERSAL_NOT_FOUND', 'WARNING', `clawback references reversal ${t.referenceId} which is not an approved POINTS reversal of this tenant`, t.id);
      continue;
    }
    if (reversal.approvedPaise !== null && Number(reversal.approvedPaise) !== requested) {
      add('CLAWBACK_AMOUNT_MISMATCH', 'WARNING', `clawback requested ${requested} ≠ reversal approved ${reversal.approvedPaise}`, t.id);
    }
    const room = (id: string) => (amountOf.get(id) ?? 0) - (reversedSoFar.get(id) ?? 0);
    let target: string | null = null;
    const metaCredit = metaOf(t.metadata)?.reversedCreditTxId;
    if (typeof metaCredit === 'string' && attrs.has(metaCredit)) {
      target = metaCredit;
    } else {
      const key = positionKey(reversal.batchId, reversal.outletId, reversal.fieldId);
      for (const c of credits) {
        const a = attrs.get(c.id)!;
        if (a.attribution === 'UNRESOLVED') continue;
        if (positionKey(a.batchId, a.outletCode, a.fieldId) !== key) continue;
        if (room(c.id) >= requested) {
          target = c.id;
          break;
        }
      }
    }
    if (!target) {
      clawCredit.set(t.id, null);
      // The replay flags CLAWBACK_UNKNOWN_CREDIT (T-h2): kept as recorded, classified as a debit.
      continue;
    }
    const pair = `${reversal.id}|${target}`;
    if (allocatedPairs.has(pair)) {
      add('DUPLICATE_ALLOCATION', 'BLOCKING', `reversal ${reversal.id} clawed back credit ${target} twice`, t.id);
      continue;
    }
    allocatedPairs.add(pair);
    reversedSoFar.set(target, (reversedSoFar.get(target) ?? 0) + requested);
    clawCredit.set(t.id, { creditTxId: target, reversal });
  }
  if (plan.anomalies.some((a) => a.severity === 'BLOCKING')) return block();

  // ── 4. WP0 replay ──
  const positionIds = new Set(credits.map((c) => c.id));
  const events: HistoricalEvent[] = [];
  let prev = 0;
  let minBalance = 0;
  const deltas: number[] = [];
  for (const t of ordered) {
    const delta = t.balanceAfter - prev;
    prev = t.balanceAfter;
    minBalance = Math.min(minBalance, t.balanceAfter);
    deltas.push(delta);
    if (t.points > 0) {
      events.push({ type: 'credit', id: t.id, delta, reversible: positionIds.has(t.id) });
    } else if (t.transactionType === 'DEBIT_EXPIRY') {
      // The legacy sweep records only the clamped amount; the lot's pre-expiry remaining is not recoverable → h = e.
      events.push({ type: 'expiry', id: t.id, delta });
    } else if (isClawback(t)) {
      const target = clawCredit.get(t.id);
      events.push({
        type: 'clawback',
        id: t.id,
        creditId: target ? target.creditTxId : `unattributed:${t.id}`,
        delta,
        requested: -t.points,
      });
    } else if (delta === 0) {
      // A floored legacy debit that moved nothing (e.g. on a 0 / negative balance) — history, no effect on B or D.
      add('ZERO_DELTA_DEBIT', 'WARNING', `${t.transactionType} points ${t.points} recorded a 0 balance change`, t.id);
      events.push({ type: 'expiry', id: t.id, delta: 0 });
    } else {
      events.push({ type: 'debit', id: t.id, delta });
    }
  }
  const r = replay(events, w.redeemablePoints);
  for (const a of r.anomalies) {
    add(a.code, REPLAY_SEVERITY[a.code], a.detail, a.eventId || null);
  }

  // ── 5. assertions ──
  if (r.state.B !== w.redeemablePoints) add('FINAL_BALANCE_MISMATCH', 'BLOCKING', `replayed B ${r.state.B} ≠ ${w.redeemablePoints}`);
  if (r.state.D < 0) add('NEGATIVE_DEBT', 'BLOCKING', `D ${r.state.D}`);
  if (r.state.B + r.state.D < 0) add('NEGATIVE_HOLDINGS', 'BLOCKING', `H ${r.state.B + r.state.D}`);
  for (const p of Object.values(r.positions)) {
    if (p.offset < 0 || p.offset > p.amount) add('OFFSET_OUT_OF_BOUNDS', 'BLOCKING', `O ${p.offset} a ${p.amount}`, p.id);
    if (p.reversed < 0 || p.reversed > p.amount) add('REVERSED_OUT_OF_BOUNDS', 'BLOCKING', `ρ ${p.reversed} a ${p.amount}`, p.id);
  }
  const neverNegative = minBalance >= 0;
  plan.neverNegative = neverNegative;
  plan.minBalance = minBalance;
  if (neverNegative) {
    // I5 — every Deoleo wallet: D = 0 and every O = 0.
    if (r.state.D !== 0) add('I5_VIOLATION', 'BLOCKING', `never-negative wallet replayed D ${r.state.D}`);
    for (const p of Object.values(r.positions)) if (p.offset !== 0) add('I5_VIOLATION', 'BLOCKING', `never-negative wallet has O ${p.offset}`, p.id);
  }
  // A lot that expired while the wallet carried debt may have repaid debt (§3.2 expiry) without leaving a row: the
  // legacy sweep writes nothing when the balance is ≤ 0, and zeroes the lot's remaining → D is not reconstructable.
  let cumD = 0;
  let everDebt = false;
  for (const c of r.classifications) {
    cumD += c.debtDelta;
    if (cumD > 0) everDebt = true;
  }
  if (everDebt) {
    const expiredWithRow = new Set(
      ordered.filter((t) => t.transactionType === 'DEBIT_EXPIRY' && t.referenceType === 'POINTS_LEDGER' && t.referenceId).map((t) => t.referenceId!),
    );
    const silent = h.ledgers.filter((l) => l.isExpired && l.points > 0 && !expiredWithRow.has(l.id));
    if (silent.length > 0) {
      add('EXPIRY_UNRECORDED_ON_DEBT_WALLET', 'BLOCKING', `${silent.length} lot(s) expired with no expiry row on a wallet that carried debt — D cannot be reconstructed (${silent.slice(0, 5).map((l) => l.id).join(', ')})`);
    }
  }
  if (plan.anomalies.some((a) => a.severity === 'BLOCKING')) return block();

  // ── 2. ledger pairing ──
  const pairs = pairLedgers(ordered, h.ledgers);
  const unpaired = ordered.filter((t) => !pairs.get(t.id));
  if (unpaired.length > 0) {
    add('LEDGER_UNPAIRED', 'WARNING', `${unpaired.length} row(s) without a matching points_ledger row (${unpaired.slice(0, 5).map((t) => t.id).join(', ')})`);
  }
  const ledgerById = new Map(h.ledgers.map((l) => [l.id, l]));

  // ── writes ──
  const clsById = new Map(r.classifications.map((c) => [c.eventId, c]));
  ordered.forEach((t, i) => {
    const target = isClawback(t) ? clawCredit.get(t.id) ?? null : null;
    const reversalId = isClawback(t) && t.referenceId && ctx.reversals.has(t.referenceId) ? t.referenceId : null;
    plan.txUpdates.push({
      txId: t.id,
      seq: i + 1,
      pointsDelta: deltas[i],
      pointsLedgerId: pairs.get(t.id) ?? null,
      reversedCreditTxId: target ? target.creditTxId : null,
      creditReversalId: reversalId,
    });
  });
  for (const c of credits) {
    const p = r.positions[c.id];
    const a = attrs.get(c.id)!;
    const lotId = pairs.get(c.id) ?? null;
    const lot = lotId ? ledgerById.get(lotId) : undefined;
    plan.positions.push({
      walletId: w.id,
      creditTxId: c.id,
      lotId: lot && lot.points > 0 ? lot.id : null,
      batchId: a.batchId,
      outletCode: a.outletCode,
      fieldId: a.fieldId,
      amount: p.amount,
      offsetPoints: p.offset,
      reversedPoints: p.reversed,
      attribution: a.attribution,
    });
  }
  for (const t of ordered) {
    const target = isClawback(t) ? clawCredit.get(t.id) : null;
    if (!target) continue;
    const cl = clsById.get(t.id)!;
    const requested = -t.points;
    const moved = Math.abs(cl.pointsDelta); // |δ| = p + c + owed; abs ⇒ never −0
    // Q4 (owner 2026-11-16): c is what the wallet actually HELD (WP0 caps it at holdings); anything the recorded
    // clawback took beyond that was booked as debt — "owed", never counted as recovered.
    const recovered = cl.recovered;
    const owed = moved - cl.debtRestored - recovered;
    const shortfall = requested - moved;
    if (requested <= 0 || recovered < 0 || owed < 0 || shortfall < 0) {
      add('ALLOCATION_INVALID', 'BLOCKING', `requested ${requested} moved ${moved} restored ${cl.debtRestored} recovered ${recovered}`, t.id);
      continue;
    }
    if (owed > 0) {
      add(
        'CLAWBACK_OWED',
        'WARNING',
        `historical clawback for reversal ${target.reversal.id}: recovered ${recovered}, owed ${owed} (booked as debt), debt restored ${cl.debtRestored}, shortfall ${shortfall}`,
        t.id,
      );
    }
    plan.allocations.push({
      creditReversalId: target.reversal.id,
      creditTxId: target.creditTxId,
      requested,
      debtRestored: cl.debtRestored,
      recovered,
      owed,
      shortfall,
    });
  }
  if (plan.anomalies.some((a) => a.severity === 'BLOCKING')) return block();

  plan.debtPoints = z(r.state.D);
  plan.movementSeq = ordered.length;
  // Persisted / compared records must never carry −0 (Object.is(−0, 0) is false; WP0 follows the same rule).
  for (const u of plan.txUpdates) u.pointsDelta = z(u.pointsDelta);
  for (const p of plan.positions) {
    p.offsetPoints = z(p.offsetPoints);
    p.reversedPoints = z(p.reversedPoints);
  }
  for (const a of plan.allocations) {
    a.debtRestored = z(a.debtRestored);
    a.recovered = z(a.recovered);
    a.owed = z(a.owed);
    a.shortfall = z(a.shortfall);
  }
  return plan;
}

function z(x: number): number {
  return x === 0 ? 0 : x;
}

// ───────────────────────────── tenant ─────────────────────────────

/**
 * Plan every wallet of a tenant, then apply the cross-wallet rule: an APPROVED/PARTIAL POINTS reversal that no wallet's
 * clawback could be attributed to (e.g. a legacy clawback that debited the outlet's NEW owner after a relink, T-f1) leaves
 * the cap of its (batch, outlet, field) unknown → every position with that key is UNRESOLVED (refused until mapped).
 * Wallets are re-planned with those downgrades, so the plan is a fixed point of planWallet(h, ctx, adjustments).
 */
export function planTenant(ctx: BfTenantContext, histories: BfWalletHistory[]): TenantPlan {
  const sortedH = [...histories].sort((a, b) => (a.wallet.id < b.wallet.id ? -1 : a.wallet.id > b.wallet.id ? 1 : 0));
  const first = sortedH.map((h) => planWallet(h, ctx));
  const attributed = new Set<string>(ctx.alreadyAllocatedReversalIds);
  for (const p of first) for (const a of p.allocations) attributed.add(a.creditReversalId);
  // A blocked wallet's clawbacks are unknown until it is resolved — don't let it downgrade others' positions.
  const blockedWallets = new Set(first.filter((p) => p.status === 'BLOCKED').map((p) => p.walletId));
  const clawbackWalletOf = new Map<string, string>();
  for (const h of sortedH) for (const t of h.txs) if (isClawback(t) && t.referenceId) clawbackWalletOf.set(t.referenceId, h.wallet.id);

  const adjustments: TenantAdjustments = { downgradeKeys: new Set() };
  const anomalies: BfAnomaly[] = [];
  const reversals = [...ctx.reversals.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const rv of reversals) {
    if (rv.awardType !== 'POINTS' || !APPROVED_REVERSAL_STATUSES.has(rv.status)) continue;
    if (!rv.approvedPaise || rv.approvedPaise <= 0n) continue;
    if (attributed.has(rv.id)) continue;
    const w = clawbackWalletOf.get(rv.id);
    if (w && blockedWallets.has(w)) continue;
    const key = positionKey(rv.batchId, rv.outletId, rv.fieldId);
    adjustments.downgradeKeys.add(key);
    anomalies.push({
      clientId: ctx.clientId,
      walletId: w ?? null,
      txId: null,
      code: 'REVERSAL_UNATTRIBUTED',
      severity: 'WARNING',
      detail: `approved POINTS reversal ${rv.id} (${rv.approvedPaise} pts, ${key}) ${w ? `debited wallet ${w} which holds no matching credit` : 'has no clawback row'} — positions of this key left UNRESOLVED`,
    });
  }
  const wallets = adjustments.downgradeKeys.size === 0 ? first : sortedH.map((h) => planWallet(h, ctx, adjustments));
  return { clientId: ctx.clientId, wallets, adjustments, anomalies };
}

// ───────────────────────────── summary + plan identity ─────────────────────────────

export interface TenantSummary {
  clientId: string;
  wallets: { total: number; planned: number; noop: number; done: number; blocked: number };
  rowsToSequence: number;
  positions: Record<Attribution, number>;
  allocations: number;
  debtWallets: { walletId: string; redeemablePoints: number; debtPoints: number; holdings: number }[];
  totalDebt: number;
  neverNegativeWallets: number;
  anomalies: { BLOCKING: Record<string, number>; WARNING: Record<string, number> };
  /** Q2: every BLOCKED wallet with its reason (persisted to wallets.backfillBlockedReason on APPLY) */
  blockedWallets: { walletId: string; reason: string }[];
  /** Q4: historical clawbacks classified in this run — "recovered X, owed Y" (owed never counted as recovered) */
  historicalClawbacks: { count: number; requested: number; debtRestored: number; recovered: number; owed: number; shortfall: number };
}

/** The reason a BLOCKED wallet carries (wallets.backfillBlockedReason + the reversal refusal + the attention list). */
export function blockedReasonOf(p: WalletPlan): string {
  const parts = p.anomalies
    .filter((a) => a.severity === 'BLOCKING')
    .map((a) => `${a.code}: ${a.detail}${a.txId ? ` (tx ${a.txId})` : ''}`);
  const text = parts.length ? parts.join('; ') : 'blocked by the wallet backfill';
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

export function summarizeTenant(tp: TenantPlan): TenantSummary {
  const s: TenantSummary = {
    clientId: tp.clientId,
    wallets: { total: tp.wallets.length, planned: 0, noop: 0, done: 0, blocked: 0 },
    rowsToSequence: 0,
    positions: { EXACT: 0, LEGACY_REPLAY: 0, MANUAL: 0, UNRESOLVED: 0 },
    allocations: 0,
    debtWallets: [],
    totalDebt: 0,
    neverNegativeWallets: 0,
    anomalies: { BLOCKING: {}, WARNING: {} },
    blockedWallets: [],
    historicalClawbacks: { count: 0, requested: 0, debtRestored: 0, recovered: 0, owed: 0, shortfall: 0 },
  };
  for (const p of tp.wallets) {
    if (p.status === 'PLANNED') s.wallets.planned++;
    else if (p.status === 'NOOP') s.wallets.noop++;
    else if (p.status === 'DONE') s.wallets.done++;
    else {
      s.wallets.blocked++;
      s.blockedWallets.push({ walletId: p.walletId, reason: blockedReasonOf(p) });
    }
    if (p.status === 'PLANNED') {
      s.rowsToSequence += p.txUpdates.length;
      for (const pos of p.positions) s.positions[pos.attribution]++;
      s.allocations += p.allocations.length;
      for (const a of p.allocations) {
        const h = s.historicalClawbacks;
        h.count++;
        h.requested += a.requested;
        h.debtRestored += a.debtRestored;
        h.recovered += a.recovered;
        h.owed += a.owed;
        h.shortfall += a.shortfall;
      }
      if (p.debtPoints > 0 || p.redeemablePoints < 0) {
        s.debtWallets.push({ walletId: p.walletId, redeemablePoints: p.redeemablePoints, debtPoints: p.debtPoints, holdings: p.redeemablePoints + p.debtPoints });
      }
      s.totalDebt += p.debtPoints;
      if (p.neverNegative) s.neverNegativeWallets++;
    }
    for (const a of p.anomalies) s.anomalies[a.severity][a.code] = (s.anomalies[a.severity][a.code] ?? 0) + 1;
  }
  for (const a of tp.anomalies) s.anomalies[a.severity][a.code] = (s.anomalies[a.severity][a.code] ?? 0) + 1;
  return s;
}

/** Canonical write-set of a plan — two plans with equal identities write exactly the same rows. */
export function planIdentity(p: WalletPlan): string {
  return JSON.stringify({
    w: p.walletId,
    s: p.status,
    f: p.fingerprint,
    d: p.debtPoints,
    m: p.movementSeq,
    t: p.txUpdates,
    p: p.positions,
    a: p.allocations,
  });
}
