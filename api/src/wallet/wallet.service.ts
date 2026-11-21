import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreditAttribution, Prisma, PointsLedgerType, Wallet, WalletTransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { POINTS_REVERSAL_PAUSE_SETTING_KEY, TenantSettingsService } from '../tenant/tenant-settings.service';
import {
  batchLineAmount,
  creditUnmappedMessage,
  ReversalAttentionException,
  unresolvedBlockingLine,
  WALLET_NOT_YET_BACKFILLED_REASON,
  walletNeedsAttentionMessage,
  walletNotSequencedMessage,
  walletsNotSequencedReadinessMessage,
} from './reversal-policy';
import {
  credit as modelCredit,
  CreditPosition,
  expire as modelExpire,
  legacyReversalDecrement,
  reverse as modelReverse,
  ReversalModelError,
  spend as modelSpend,
  Step,
  WalletModel,
  WalletState,
} from './reversal-model';
import { JwtPayload } from '../common/decorators/current-user.decorator';
import { resolveCreditFieldNames } from '../common/credit-field-name.helper';
import { resolveActivePartnerId } from '../common/partner-group.helper';
import { istMonthBounds } from '../common/ist-date';
import { AdjustType, AdjustWalletDto, ListTransactionsQueryDto, StatementQueryDto } from './dto/wallet.dto';
import { buildStatementResponse, defaultTxDescription, EMPTY_STATEMENT } from '../common/points-statement.helper';
import { negativeBalanceSignals } from './negative-balance.helper';
import { loadProgramCatalog, normalizeFilterParam, partnerProgramScope } from '../admin-core/dashboards/dashboard-program-filter';

/** A tracked wallet whose stored state breaks I1/I2 (D ≥ 0, B + D ≥ 0) — never written further. */
export const WALLET_STATE_INCONSISTENT_MESSAGE =
  'This wallet\'s points state is inconsistent (debt / holdings out of range) — contact Gifsy';


/** Synthetic lot / credit ids for the WP0 model when it is used for STATE math only (real lots are DB rows). */
const HOLDINGS_LOT_ID = '__holdings__';
const NEW_CREDIT_ID = '__new_credit__';

/** Parameters of one wallet movement (both the legacy and the v2 write path). */
interface MovementParams {
  /**
   * The caller's read of the wallet. A FULL row (movementSeq + figures present) lets an un-sequenced wallet take the
   * legacy path with no extra lock / partner / flag read (fix round A, L5 — see applyMovement).
   */
  wallet: { id: string; redeemablePoints: number } & Partial<Wallet>;
  walletTxType: WalletTransactionType;
  ledgerType: PointsLedgerType;
  points: number; // signed: + credit, - debit
  balanceType?: string;
  referenceType?: string | null;
  referenceId?: string | null;
  schemeId?: string | null;
  expiresAt?: Date | null;
  description?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  // When true on a DEBIT, decrement redeemablePoints ATOMICALLY via a guarded
  // conditional update (WHERE redeemablePoints >= magnitude) and reject if the
  // balance is insufficient — closing the read-then-write TOCTOU race (two
  // concurrent debits, or a debit racing a redemption, driving redeemable
  // negative). Opt-in so the existing floor-to-0 callers (expiry sweep) are
  // byte-unchanged; only the admin adjust DEBIT sets it today.
  requireSufficientRedeemable?: boolean;
  // Caller-specific message for the guarded-insufficient reject, so a redemption
  // race reads "for redemption" while an admin debit reads "for debit".
  insufficientMessage?: string;
  // Optional WalletTransaction.metadata (e.g. a credit-batch credit's { fieldId, outletCode },
  // so a later reversal can identify the EXACT credit it undoes). Omitted → column untouched.
  metadata?: Prisma.InputJsonValue;
  // v2 only (tracked wallets; ignored by the legacy path) ───────────────────────────
  /** A credit-batch POINTS credit: create its WalletCreditPosition (§5 step 5). */
  creditPosition?: { batchId: string; outletCode: string; fieldId: string } | null;
  /** A reversal clawback: the credit WalletTransaction it reverses / the CreditReversal that produced it. */
  reversedCreditTxId?: string | null;
  creditReversalId?: string | null;
}

/** The (batch, outlet, field) key a POINTS reversal targets. */
export interface CreditKey {
  batchId: string;
  outletCode: string;
  fieldId: string;
}

/** A WalletCreditPosition as the reversal engine reads it (with its credit's ordering keys). */
export interface ReversalPositionRow {
  id: string;
  walletId: string;
  creditTxId: string;
  lotId: string | null;
  amount: number;
  offsetPoints: number;
  reversedPoints: number;
  /** absent in pure-planner fixtures; UNRESOLVED rows are never drawn on (findPositions) */
  attribution?: CreditAttribution | string;
  /**
   * V2 only (owner decision 2026-11-19 — expired points are not recovered twice): E_X = points of this credit's own lot
   * that expired from the balance, and ε_X = how much of it earlier reversals already counted. Loaded by withExpiry;
   * absent (= 0) on the LEGACY tracked-wallet path, which keeps its floor-0 rule unchanged.
   */
  expired?: number;
  expiredCounted?: number;
  /** false ⇔ neither the position nor its credit row links the credit's own lot — expiry history unknown (item 1) */
  expiryKnown?: boolean;
  creditTx: { seq: number | null; createdAt: Date };
}

/** One planned per-position step of a v2 reversal (§6) — computed by WP0 reverse(), nothing re-derived. */
export interface PlannedReversalStep {
  position: ReversalPositionRow;
  requested: number;
  before: WalletState;
  after: WalletState;
  pointsDelta: number;
  debtRestored: number;
  recovered: number;
  /** s = r − p − q − c: the part the wallet no longer held — booked as debt (owner decision 2026-11-19) */
  owed: number;
  /** q: the credit's own points that already expired — counted as recovered, nothing taken (owner 2026-11-19) */
  alreadyExpired: number;
  /** part of `recovered` that was backing EXISTING debt — the balance went below zero by it (fix round 3, A4) */
  debtExposed: number;
  /** always 0 (WP0 reverse() never writes anything off since 2026-11-19) */
  shortfall: number;
  newOffset: number;
  newReversed: number;
}

function walletStateOf(w: Pick<Wallet, 'redeemablePoints'> & Partial<Wallet>): WalletState {
  return { B: w.redeemablePoints, D: w.debtPoints ?? 0, seq: w.movementSeq ?? 0 };
}

/**
 * A WP0 model carrying only what STATE math needs: B, D, seq, the given positions, and ONE synthetic lot holding
 * H = B + D. Real lots live in points_ledger (and may be out of sync on legacy-era wallets), so the model's lot
 * draws are never used for DB writes — only its state / offsets / p / c / shortfall are.
 */
function stateModel(s: WalletState, positions: Record<string, CreditPosition> = {}): WalletModel {
  const H = s.B + s.D;
  if (s.D < 0 || H < 0) throw new ConflictException(WALLET_STATE_INCONSISTENT_MESSAGE);
  return {
    state: { ...s },
    positions,
    lots: H > 0 ? [{ id: HOLDINGS_LOT_ID, creditId: null, remaining: H }] : [],
  };
}

/**
 * §6 planner (pure): split a POINTS reversal of r over the credit positions of one (batch, outlet, field),
 * oldest credit first; each step is WP0 reverse() on that position's wallet state (p = min(r_i, O), c = min(r_i − p,
 * H), owed s = r_i − p − c booked as debt — owner decision 2026-11-19; B −= r_i, D += p + s). `states` is updated in
 * place so two positions on one wallet chain correctly.
 * Throws BadRequest when r exceeds Σ(amount − reversed) (R5 cap).
 */
export function planV2Reversal(
  positions: ReversalPositionRow[],
  states: Map<string, WalletState>,
  r: number,
): PlannedReversalStep[] {
  if (!Number.isInteger(r) || r <= 0) throw new BadRequestException('Reversal amount must be a positive whole number of points');
  const cap = positions.reduce((s, p) => s + (p.amount - p.reversedPoints), 0);
  if (r > cap) {
    throw new BadRequestException(
      `Reversal exceeds what is still reversible for this outlet and field in this batch (reversible ${cap} pts, requested ${r} pts)`,
    );
  }
  const steps: PlannedReversalStep[] = [];
  let remaining = r;
  for (const pos of positions) {
    if (remaining <= 0) break;
    const ri = Math.min(remaining, pos.amount - pos.reversedPoints);
    if (ri <= 0) continue;
    const before = states.get(pos.walletId);
    if (!before) throw new Error(`planV2Reversal: no locked state for wallet ${pos.walletId}`);
    const m = stateModel(before, {
      [pos.id]: {
        id: pos.id, amount: pos.amount, offset: pos.offsetPoints, reversed: pos.reversedPoints, lotRemaining: 0,
        expired: pos.expired ?? 0, expiredCounted: pos.expiredCounted ?? 0,
      },
    });
    let step: Step;
    try {
      step = modelReverse(m, pos.id, ri);
    } catch (e) {
      if (e instanceof ReversalModelError) throw new BadRequestException(e.message);
      throw e;
    }
    // A6 (fix round 3): a reversal fully covered by the credit's own EXPIRED points moves nothing — no wallet row is
    // written for it (applyCreditReversal), so it does not consume a seq either.
    const after = step.movement.pointsDelta === 0 ? { ...step.model.state, seq: before.seq } : step.model.state;
    states.set(pos.walletId, after);
    steps.push({
      position: pos,
      requested: ri,
      before,
      after,
      pointsDelta: step.movement.pointsDelta,
      debtRestored: step.movement.debtRestored,
      recovered: step.movement.recovered,
      owed: step.movement.owed,
      alreadyExpired: step.movement.alreadyExpired,
      debtExposed: step.movement.debtExposed,
      shortfall: step.movement.shortfall,
      newOffset: step.model.positions[pos.id].offset,
      newReversed: step.model.positions[pos.id].reversed,
    });
    remaining -= ri;
  }
  return steps;
}

/**
 * Oldest credit first (§6 "ORDER BY creditTx.seq" — fix round A, L2): the per-wallet movement `seq` is the
 * authoritative order, so two credits on the SAME wallet that both carry a seq are ordered by it. `seq` is per wallet
 * (meaningless across wallets) and absent on un-sequenced rows, so otherwise fall back to the credit's createdAt
 * (stamped in app code under the wallet lock), then id — a total, deterministic order.
 */
export function byCreditOrder(a: ReversalPositionRow, b: ReversalPositionRow): number {
  const sa = a.creditTx.seq;
  const sb = b.creditTx.seq;
  if (a.walletId === b.walletId && sa != null && sb != null && sa !== sb) return sa - sb;
  const t = a.creditTx.createdAt.getTime() - b.creditTx.createdAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Owner decision D1 (2026-11-19): "points owed" = how far below zero a balance is. What a V2 reversal added to it:
 * per receiving wallet, max(0, −B after its last step) − max(0, −B before its first step), summed.
 */
export function belowZeroBy(plan: Pick<PlannedReversalStep, 'position' | 'before' | 'after'>[]): number {
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  for (const st of plan) {
    if (!first.has(st.position.walletId)) first.set(st.position.walletId, st.before.B);
    last.set(st.position.walletId, st.after.B);
  }
  let n = 0;
  for (const [w, b0] of first) n += Math.max(0, Math.max(0, -(last.get(w) ?? b0)) - Math.max(0, -b0));
  return n;
}

const fmtPts = (n: number) => new Intl.NumberFormat('en-IN').format(n);

/**
 * Owner decision 2 (2026-11-19 — the retailer sees the negative balance as it is): the V2 reversal's passbook row
 * explains itself, e.g. "Credit reversed (Volume · 2026-10) −10,000 · 2,986 owed, repaid from future earnings".
 * Null without a label (callers that pass none keep their own description).
 */
export function passbookReversalText(
  st: Pick<PlannedReversalStep, 'requested' | 'alreadyExpired' | 'before' | 'after'>,
  label: string | null,
): string | null {
  if (!label) return null;
  // A5 (fix round 3): say only what the retailer's balance actually did. "Owed, repaid from future earnings" is the
  // amount by which THIS reversal took the balance (further) below zero — never debt that stays covered by a balance
  // ≥ 0; the credit's own expired points are named as such.
  let t = `Credit reversed (${label}) −${fmtPts(st.requested)}`;
  if (st.alreadyExpired > 0) t += ` · ${fmtPts(st.alreadyExpired)} had already expired`;
  const owedNow = Math.max(0, -st.after.B) - Math.max(0, -st.before.B);
  if (owedNow > 0) t += ` · ${fmtPts(owedNow)} owed, repaid from future earnings`;
  return t;
}

/** A legacy-era wallet read shows history (any balance / counter ≠ 0) → it can never be pristine again. */
function hasVisibleHistory(w: Partial<Wallet>): boolean {
  return [
    w.redeemablePoints, w.debtPoints, w.earnedPoints, w.lockedPoints, w.redeemedPoints, w.expiredPoints,
    w.lifetimeEarned, w.lifetimeRedeemed, w.lifetimeExpired,
  ].some((n) => typeof n === 'number' && n !== 0);
}

/** The balance / counter columns whose non-zero value means "this wallet has points history". */
const HISTORY_FIGURES = [
  'redeemablePoints', 'debtPoints', 'earnedPoints', 'lockedPoints', 'redeemedPoints', 'expiredPoints',
  'lifetimeEarned', 'lifetimeRedeemed', 'lifetimeExpired',
] as const;

/** Un-sequenced wallets the backfill BLOCKED (reason on the row) — reversals on them refused until Gifsy fixes them. */
export function blockedWalletsWhere(clientId: string): Prisma.WalletWhereInput {
  return { partner: { clientId }, movementSeq: 0, backfillStatus: 'BLOCKED' };
}

/**
 * The readiness predicate (engine retired 2026-11-21 — every tenant): wallets with points HISTORY (any figure ≠ 0 or
 * any transaction row) that are NOT sequenced (movementSeq 0) and NOT listed as BLOCKED. Each one refuses POINTS
 * reversals (WALLET_NOT_SEQUENCED) until the wallet backfill sequences it. A pristine wallet (no row, every figure 0)
 * is never counted: its first movement is sequenced from seq 1. NULL-safe: backfillStatus NULL or DONE (a Prisma
 * `{ not: 'BLOCKED' }` would silently drop the NULL rows).
 */
export function unsequencedWithHistoryWhere(clientId: string): Prisma.WalletWhereInput {
  return {
    partner: { clientId },
    movementSeq: 0,
    AND: [
      { OR: [{ backfillStatus: null }, { backfillStatus: 'DONE' }] },
      {
        OR: [
          ...HISTORY_FIGURES.map((f) => ({ [f]: { not: 0 } }) as Prisma.WalletWhereInput),
          { transactions: { some: {} } },
        ],
      },
    ],
  };
}

/** Per-tenant reversal readiness, plain words (attention banner + daily ops digest). */
export interface ReversalReadiness {
  /** wallets with points history not yet sequenced by the wallet backfill (not BLOCKED) */
  unsequencedWithHistory: number;
  /** un-sequenced wallets the backfill BLOCKED (each with its reason on the attention list) */
  blocked: number;
  /** true ⇔ both are 0: a points reversal can reach every wallet of the program */
  ready: boolean;
  message: string | null;
}

export function readinessOf(unsequencedWithHistory: number, blocked: number): ReversalReadiness {
  const ready = unsequencedWithHistory === 0 && blocked === 0;
  return {
    unsequencedWithHistory,
    blocked,
    ready,
    message: ready ? null : walletsNotSequencedReadinessMessage(unsequencedWithHistory, blocked),
  };
}

/** Prisma "record to update not found" — the extended-unique-where guard of the legacy fast path missed. */
function isRecordNotFound(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'P2025';
}

/** The attention endpoint lists expiry failures / reversal refusals of the last N days. */
const ATTENTION_WINDOW_DAYS = 30;
/** Audit entityType of a per-lot expiry-sweep failure (fix round A, M1) — entityId = the tenant's clientId. */
export const POINTS_EXPIRY_FAILURE_ENTITY = 'POINTS_EXPIRY_FAILURE';
/** Audit B8: an expiry repaid debt beyond the expired lot's credit-position room (legacy lot mirror drift). */
export const POINTS_EXPIRY_OFFSET_CAPPED_ENTITY = 'POINTS_EXPIRY_OFFSET_CAPPED';
/**
 * Fix round 3 (2026-11-19): a V2 reversal booked debt for a credit whose own lot is NOT linked (position.lotId null — a
 * backfilled credit without a lot): its expired points cannot be told apart, so part of that debt may be points that
 * EXPIRED (owner decision 1: those should not be owed). Never silent: an audit row + the attention banner.
 */
export const REVERSAL_EXPIRY_UNTRACKED_ENTITY = 'REVERSAL_EXPIRY_UNTRACKED';
/** Audit entityType of an expiry that only repaid debt (no balance change, no passbook row — fix round A, L1). */
export const POINTS_EXPIRY_DEBT_ONLY_ENTITY = 'POINTS_EXPIRY_DEBT_REPAID';

/**
 * Wallet & Points — ported from platform/src/app/api/wallet/* onto /v1.
 * Tenant-scoped by clientId (from the session-bound JWT). Admin adjustments are
 * GIFSY-only (enforced by @Roles on the controller; tenant scope re-checked here).
 * Business logic lives here; the controller is a thin HTTP adapter.
 *
 * ═══ THE CANONICAL WALLET INVARIANT (P5 — Stream W, locked) ═══════════════════
 * The wallet carries spendable balances AND monotonic lifetime accumulators. They
 * must never desync, and every mutation writes BOTH a WalletTransaction (passbook)
 * AND a PointsLedger row (the source-of-truth lots, e.g. for expiry), atomically.
 *
 *  - redeemablePoints : currently spendable balance (the only "live" balance in P5).
 *  - lockedPoints     : currently held — stays 0 in P5. Holding/lock is DEFERRED
 *                       (lost its config home when TierConfig was dropped in S2).
 *                       The fields + LOCK/UNLOCK enums survive for a future ~½-day
 *                       add (a symmetric unlock-sweep). We do NOT touch them here.
 *  - redeemedPoints   : running total consumed by redemptions (net of reversals).
 *  - expiredPoints    : running total expired.
 *  - earnedPoints, lifetimeEarned, lifetimeRedeemed, lifetimeExpired :
 *                       MONOTONIC lifetime accumulators — NEVER decremented.
 *
 * Therefore:
 *  - A CREDIT (earn/bonus/credit-adjust) increments earnedPoints + lifetimeEarned
 *    + redeemablePoints.
 *  - A REVERSAL re-credits redeemablePoints only (it is NOT new earning, so it does
 *    NOT bump earnedPoints/lifetimeEarned — documented on reverse()).
 *  - A DEBIT (redeem/expiry/debit-adjust) decrements redeemablePoints ONLY and
 *    increments the matching running/lifetime counter (redeemed+lifetimeRedeemed
 *    for a redemption; expired+lifetimeExpired for expiry). It NEVER decrements
 *    earnedPoints/lifetimeEarned. (The old adjust() decremented earnedPoints on a
 *    debit — bug #1, fixed here. Nothing wrote PointsLedger — bug #2 / Gap #28,
 *    fixed here by routing every path through applyMovement().)
 * ═════════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  // ─── Core ledger-aware primitive ────────────────────────────────────────────

  /**
   * The single wallet write-path. Updates the wallet aggregates per the canonical
   * invariant, then writes BOTH a WalletTransaction and a PointsLedger row inside
   * the supplied transaction client. Every public mutation routes through here so
   * the passbook and the ledger can never desync.
   *
   * `points` is SIGNED (positive on credit, negative on debit). `balanceType` is
   * the WalletTransaction balance dimension the before/after pair is computed on
   * (always 'REDEEMABLE' in P5 since that is the only live balance).
   *
   * One engine for every tenant (the per-tenant reversal-engine mode was retired 2026-11-21): a SEQUENCED wallet, or
   * a pristine one (whose first movement becomes seq 1), is always written by the tracked path (seq / D / positions).
   * Only a wallet that already has UN-sequenced history — the wallet backfill has not processed it yet, or BLOCKED it —
   * keeps the pre-engine write path (owner Q1 2026-11-16: never a mixed history, never a blocked earn / redeem); POINTS
   * reversals on such a wallet are refused (WALLET_NOT_SEQUENCED / WALLET_NEEDS_ATTENTION) and the wallet is counted
   * by reversalReadiness() until the backfill sequences it.
   */
  private async applyMovement(
    tx: Prisma.TransactionClient,
    params: MovementParams,
  ): Promise<{ transactionId: string; newRedeemable: number; ledgerId: string }> {
    // Fix round A, L5 — fast path for an un-sequenced wallet whose read VISIBLY has history: the pre-engine write path
    // with no extra row lock. Its wallet UPDATE carries `AND movementSeq = 0` (atomic in the one statement): if a
    // backfill sequenced the wallet after the caller's read, nothing was written → fall through to the locked path.
    if (this.unsequencedFastPath(params.wallet)) {
      const fast = await this.applyMovementLegacy(tx, params, { unsequencedGuard: true });
      if (fast) return fast;
    }
    // §5 step 1: LOCK the wallet row first, then read B / D / movementSeq. Callers that already locked (expiry sweep)
    // re-acquire their own lock — a no-op in Postgres.
    const wallet = await this.lockWallet(tx, params.wallet.id);
    if ((await this.movementPath(tx, wallet)) === 'UNSEQUENCED') {
      const res = await this.applyMovementLegacy(tx, { ...params, wallet });
      if (!res) throw new Error('applyMovementLegacy: unguarded write returned nothing');
      return res;
    }
    return this.applyMovementV2(tx, wallet, params);
  }

  /**
   * L5 fast-path decision — PURE, no I/O (see applyMovement). True only when the caller's wallet read carries
   * `movementSeq === 0` (a partial read → false → the locked path decides) AND shows history. A wallet that looks
   * pristine takes the locked path (its first movement is sequenced from seq 1 unless a transaction row exists).
   */
  private unsequencedFastPath(w: MovementParams['wallet']): boolean {
    if (w.movementSeq !== 0) return false;
    if (!hasVisibleHistory(w)) return false;
    this.warnUnsequencedMovement(w);
    return true;
  }

  private warnUnsequencedMovement(w: Partial<Wallet> & { id: string }): void {
    this.logger.warn(
      `[reversal-engine] wallet ${w.id} has points history that is not sequenced (${w.backfillStatus === 'BLOCKED' ? `BLOCKED: ${w.backfillBlockedReason ?? '?'}` : 'wallet backfill not yet run for it'}) — movement takes the pre-engine write path; points reversals on it are refused until Gifsy runs / fixes the wallet backfill`,
    );
  }

  /**
   * Which write path a movement on this (locked) wallet takes — no tenant setting involved:
   *  1. movementSeq > 0 → 'V2' (tracked: seq / pointsDelta / D / positions).
   *  2. movementSeq = 0 and the wallet is pristine (no row, every figure 0 — nothing for the backfill to sequence) →
   *     'V2': its first movement is seq 1. Every NEW wallet of every tenant lands here.
   *  3. movementSeq = 0 WITH history (the backfill has not processed the wallet yet, or BLOCKED it) → 'UNSEQUENCED':
   *     the pre-engine write path (owner Q1: never a mixed history, never a blocked earn / redeem). Logged LOUDLY;
   *     POINTS reversals on it are refused; counted by reversalReadiness() / the attention banner / the ops digest.
   * Call under the wallet row lock (the backfill takes the same lock). Reads only through the caller's `tx`.
   */
  async movementPath(
    tx: Prisma.TransactionClient,
    w: Pick<Wallet, 'id' | 'partnerId' | 'redeemablePoints'> & Partial<Wallet>,
  ): Promise<'UNSEQUENCED' | 'V2'> {
    if ((w.movementSeq ?? 0) > 0) return 'V2';
    if (await this.isWalletPristine(tx, w)) return 'V2';
    this.warnUnsequencedMovement(w);
    return 'UNSEQUENCED';
  }

  /**
   * Lock (SELECT … FOR UPDATE) and re-read a wallet inside the caller's transaction. Every v2 decision is
   * taken from THIS read, never from a caller's earlier snapshot (fixes the stale-balanceBefore class of bugs).
   */
  private async lockWallet(tx: Prisma.TransactionClient, walletId: string): Promise<Wallet> {
    await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
    const w = await tx.wallet.findFirst({ where: { id: walletId } });
    if (!w) throw new NotFoundException('Wallet not found');
    return w;
  }

  /**
   * A wallet with nothing to sequence: every balance/counter 0 and no WalletTransaction at all. Its first v2
   * movement becomes seq 1, and the backfill (which skips movementSeq > 0) never needs to touch it.
   */
  async isWalletPristine(
    tx: Prisma.TransactionClient,
    w: Pick<Wallet, 'id' | 'redeemablePoints'> & Partial<Wallet>,
  ): Promise<boolean> {
    if ((w.movementSeq ?? 0) > 0) return false;
    const figures = [
      w.redeemablePoints, w.debtPoints, w.earnedPoints, w.lockedPoints, w.redeemedPoints, w.expiredPoints,
      w.lifetimeEarned, w.lifetimeRedeemed, w.lifetimeExpired,
    ];
    if (figures.some((n) => (n ?? 0) !== 0)) return false;
    const anyRow = await tx.walletTransaction.findFirst({ where: { walletId: w.id }, select: { id: true } });
    return !anyRow;
  }

  /**
   * applyMovement v2 (§5) for a TRACKED wallet: the transition is computed by the WP0 oracle
   * (reversal-model.ts — credit / spend / legacyReversalDecrement), then written in ONE guarded wallet UPDATE
   * (B, D, movementSeq + the same counters as the legacy path), a PointsLedger row, and a WalletTransaction
   * carrying seq / pointsDelta / pointsLedgerId. Credit-batch POINTS credits also get their WalletCreditPosition.
   * B-neutral vs the legacy path: balances, counters and lots are identical whenever D = 0 (every Deoleo wallet).
   */
  private async applyMovementV2(
    tx: Prisma.TransactionClient,
    w: Wallet,
    params: MovementParams,
  ): Promise<{ transactionId: string; newRedeemable: number; ledgerId: string }> {
    const {
      walletTxType, ledgerType, points,
      requireSufficientRedeemable = false,
      insufficientMessage = 'Insufficient wallet balance for debit',
    } = params;
    if (!Number.isInteger(points) || points === 0) {
      throw new BadRequestException('Movement amount must be a non-zero whole number of points');
    }
    if (ledgerType === PointsLedgerType.EXPIRE) {
      // Expiry needs the lot (h) and its owning position — it goes through expireTrackedLot.
      throw new Error('applyMovementV2: EXPIRE movements must use expireTrackedLot');
    }
    const before = walletStateOf(w);
    const model = stateModel(before);
    const isCredit = points > 0;
    const magnitude = Math.abs(points);

    let after: WalletState;
    let pointsDelta: number;
    let lotRemaining = 0;
    let offset = 0;
    let lotDraw = 0;
    const counters: Prisma.WalletUpdateManyMutationInput = {};

    if (isCredit) {
      const step = modelCredit(model, { id: NEW_CREDIT_ID, amount: magnitude, reversible: !!params.creditPosition });
      after = step.model.state;
      pointsDelta = step.movement.pointsDelta;
      offset = -step.movement.debtDelta || 0; // o = min(a, D) — debt this credit repaid (Q12)
      lotRemaining = step.model.lots.find((l) => l.id === NEW_CREDIT_ID)!.remaining; // a − o
      if (ledgerType !== PointsLedgerType.REVERSE) {
        counters.earnedPoints = { increment: magnitude };
        counters.lifetimeEarned = { increment: magnitude };
      }
    } else if (requireSufficientRedeemable) {
      if (before.B < magnitude) throw new BadRequestException(insufficientMessage);
      const step = modelSpend(model, magnitude);
      after = step.model.state;
      pointsDelta = step.movement.pointsDelta;
      lotDraw = magnitude;
      if (ledgerType === PointsLedgerType.REDEEM) {
        counters.redeemedPoints = { increment: magnitude };
        counters.lifetimeRedeemed = { increment: magnitude };
      }
    } else {
      // Floored debit (the LEGACY clawback): decrement min(r, max(0, B)) — WP0's legacy reference.
      const dec = legacyReversalDecrement(before.B, magnitude);
      if (dec > 0) {
        const step = modelSpend(model, dec);
        after = step.model.state;
        pointsDelta = step.movement.pointsDelta;
      } else {
        after = { ...before, seq: before.seq + 1 };
        pointsDelta = 0;
      }
      lotDraw = dec;
      if (ledgerType === PointsLedgerType.REDEEM) {
        counters.redeemedPoints = { increment: magnitude };
        counters.lifetimeRedeemed = { increment: magnitude };
      }
    }

    const isSpendableCreditLot =
      isCredit &&
      (ledgerType === PointsLedgerType.EARN ||
        ledgerType === PointsLedgerType.REVERSE ||
        ledgerType === PointsLedgerType.ADJUST);

    const written = await this.writeTrackedMovement(tx, {
      walletId: w.id,
      before,
      after,
      pointsDelta,
      guardMinBalance: !isCredit && requireSufficientRedeemable ? magnitude : undefined,
      insufficientMessage,
      counters,
      walletTxType,
      ledgerType,
      points,
      balanceType: params.balanceType ?? 'REDEEMABLE',
      referenceType: params.referenceType ?? null,
      referenceId: params.referenceId ?? null,
      schemeId: params.schemeId ?? null,
      expiresAt: params.expiresAt ?? null,
      description: params.description ?? null,
      sourceType: params.sourceType ?? null,
      sourceId: params.sourceId ?? null,
      lotRemaining: isSpendableCreditLot ? lotRemaining : 0,
      metadata: params.metadata,
      reversedCreditTxId: params.reversedCreditTxId ?? null,
      creditReversalId: params.creditReversalId ?? null,
    });

    if (lotDraw > 0) await this.consumeFifoLots(tx, w.id, lotDraw);

    if (isCredit && params.creditPosition) {
      // §5 step 5: the credit's reversal position (O_X = o, its own lot, attribution EXACT).
      await tx.walletCreditPosition.create({
        data: {
          walletId: w.id,
          creditTxId: written.transactionId,
          lotId: isSpendableCreditLot ? written.ledgerId : null,
          batchId: params.creditPosition.batchId,
          outletCode: params.creditPosition.outletCode,
          fieldId: params.creditPosition.fieldId,
          amount: magnitude,
          offsetPoints: offset,
          reversedPoints: 0,
          attribution: CreditAttribution.EXACT,
        },
      });
    }
    return written;
  }

  /**
   * §5 steps 3–4 for one tracked movement: a single guarded wallet UPDATE (optimistic on movementSeq — we hold
   * the row lock, so a mismatch means a bug, and a guarded debit additionally keeps WHERE B ≥ s as defence in
   * depth), then the PointsLedger row and the WalletTransaction (seq, pointsDelta, exact balanceBefore, ledger link).
   */
  private async writeTrackedMovement(
    tx: Prisma.TransactionClient,
    a: {
      walletId: string;
      before: WalletState;
      after: WalletState;
      pointsDelta: number;
      guardMinBalance?: number;
      insufficientMessage?: string;
      counters: Prisma.WalletUpdateManyMutationInput;
      walletTxType: WalletTransactionType;
      ledgerType: PointsLedgerType;
      points: number;
      balanceType: string;
      referenceType: string | null;
      referenceId: string | null;
      schemeId: string | null;
      expiresAt: Date | null;
      description: string | null;
      sourceType: string | null;
      sourceId: string | null;
      lotRemaining: number;
      metadata?: Prisma.InputJsonValue;
      reversedCreditTxId?: string | null;
      creditReversalId?: string | null;
    },
  ): Promise<{ transactionId: string; newRedeemable: number; ledgerId: string }> {
    if (a.after.seq !== a.before.seq + 1) throw new Error('writeTrackedMovement: seq must advance by exactly 1');
    if (a.after.B - a.before.B !== a.pointsDelta) throw new Error('writeTrackedMovement: pointsDelta ≠ ΔB');
    if (a.after.D < 0 || a.after.B + a.after.D < 0) {
      throw new ConflictException(WALLET_STATE_INCONSISTENT_MESSAGE);
    }
    const upd = await tx.wallet.updateMany({
      where: {
        id: a.walletId,
        movementSeq: a.before.seq,
        ...(a.guardMinBalance !== undefined ? { redeemablePoints: { gte: a.guardMinBalance } } : {}),
      },
      data: {
        lastTransactionAt: new Date(),
        redeemablePoints: a.after.B,
        debtPoints: a.after.D,
        movementSeq: a.after.seq,
        ...a.counters,
      },
    });
    if (upd.count !== 1) {
      if (a.guardMinBalance !== undefined) throw new BadRequestException(a.insufficientMessage ?? 'Insufficient wallet balance');
      throw new ConflictException('The wallet changed while this movement was being applied — please retry');
    }

    const ledgerRow = await tx.pointsLedger.create({
      data: {
        walletId: a.walletId,
        schemeId: a.schemeId,
        transactionType: a.ledgerType,
        points: a.points,
        remainingPoints: a.lotRemaining,
        expiresAt: a.expiresAt,
        sourceType: a.sourceType,
        sourceId: a.sourceId,
        notes: a.description,
      },
    });

    const txRecord = await tx.walletTransaction.create({
      data: {
        walletId: a.walletId,
        transactionType: a.walletTxType,
        points: a.points,
        balanceBefore: a.after.B - a.pointsDelta,
        balanceAfter: a.after.B,
        balanceType: a.balanceType,
        referenceType: a.referenceType,
        referenceId: a.referenceId,
        description: a.description,
        seq: a.after.seq,
        pointsDelta: a.pointsDelta,
        pointsLedgerId: ledgerRow.id,
        ...(a.reversedCreditTxId ? { reversedCreditTxId: a.reversedCreditTxId } : {}),
        ...(a.creditReversalId ? { creditReversalId: a.creditReversalId } : {}),
        ...(a.metadata !== undefined ? { metadata: a.metadata, createdAt: new Date() } : {}),
      },
    });

    return { transactionId: txRecord.id, newRedeemable: a.after.B, ledgerId: ledgerRow.id };
  }

  /**
   * The pre-engine write path (byte-identical to the code before WP2). Used ONLY for a wallet that already has
   * UN-sequenced history (the WP6 backfill has not processed it, or BLOCKED it — see movementPath); never for a new or
   * sequenced wallet. Never writes seq / pointsDelta / D / positions.
   * `unsequencedGuard` (L5 fast path, no wallet lock held): the wallet UPDATE also requires `movementSeq = 0`; when it
   * matches nothing the wallet was sequenced meanwhile → returns null having written NOTHING (the wallet UPDATE is
   * this path's first write), and the caller takes the locked path.
   */
  private async applyMovementLegacy(
    tx: Prisma.TransactionClient,
    params: MovementParams,
    opts: { unsequencedGuard?: boolean } = {},
  ): Promise<{ transactionId: string; newRedeemable: number; ledgerId: string } | null> {
    const seqGuard = opts.unsequencedGuard ? { movementSeq: 0 } : {};
    const {
      wallet,
      walletTxType,
      ledgerType,
      points,
      balanceType = 'REDEEMABLE',
      referenceType = null,
      referenceId = null,
      schemeId = null,
      expiresAt = null,
      description = null,
      sourceType = null,
      sourceId = null,
      requireSufficientRedeemable = false,
      insufficientMessage = 'Insufficient wallet balance for debit',
      metadata,
    } = params;

    const isCredit = points > 0;
    const magnitude = Math.abs(points);
    let balanceBefore = wallet.redeemablePoints;

    // A "spendable lot" is a positive credit row of a type that represents available
    // balance (EARN / REVERSE / credit-ADJUST). Only these carry remainingPoints for
    // FIFO consume + expiry; every debit / lock row keeps the default 0.
    const isSpendableCreditLot =
      isCredit &&
      (ledgerType === PointsLedgerType.EARN ||
        ledgerType === PointsLedgerType.REVERSE ||
        ledgerType === PointsLedgerType.ADJUST);

    // Aggregate updates per the invariant. earnedPoints/lifetimeEarned are bumped
    // ONLY for true earning movements (EARN/credit-adjust/bonus), never on reversal
    // or any debit. redeemable floors at 0 on debit (never goes negative).
    const data: Prisma.WalletUpdateInput = { lastTransactionAt: new Date() };

    if (isCredit) {
      data.redeemablePoints = { increment: magnitude };
      // A REVERSE re-credits spendable balance but is NOT new earning.
      if (ledgerType !== PointsLedgerType.REVERSE) {
        data.earnedPoints = { increment: magnitude };
        data.lifetimeEarned = { increment: magnitude };
      }
    } else if (requireSufficientRedeemable) {
      // Atomic-guarded debit: decrement by the FULL magnitude (the guarded WHERE
      // below ensures redeemable >= magnitude, so this can never go negative even
      // under a concurrent debit). No flooring.
      data.redeemablePoints = { decrement: magnitude };
      if (ledgerType === PointsLedgerType.REDEEM) {
        data.redeemedPoints = { increment: magnitude };
        data.lifetimeRedeemed = { increment: magnitude };
      }
      // DEBIT_ADJUSTMENT (ledgerType ADJUST) only decrements redeemable.
    } else {
      // Floor redeemable at 0 — guards the expiry sweep against over-decrementing. The outer
      // Math.max(0, …) matters when the balance is already NEGATIVE (a migrated wallet):
      // min(magnitude, balance) would be a NEGATIVE decrement, which would ADD points on a debit.
      // Clamp to 0 → a debit never moves such a wallet up. For balanceBefore >= 0 this is
      // identical to the original min(magnitude, balance).
      const decrement = Math.max(0, Math.min(magnitude, balanceBefore));
      data.redeemablePoints = { decrement };
      if (ledgerType === PointsLedgerType.REDEEM) {
        data.redeemedPoints = { increment: magnitude };
        data.lifetimeRedeemed = { increment: magnitude };
      } else if (ledgerType === PointsLedgerType.EXPIRE) {
        data.expiredPoints = { increment: decrement };
        data.lifetimeExpired = { increment: decrement };
      }
      // DEBIT_ADJUSTMENT (ledgerType ADJUST, debit direction) only decrements
      // redeemable — it has no dedicated running counter.
    }

    let updatedWallet: Awaited<ReturnType<typeof tx.wallet.update>>;
    if (!isCredit && requireSufficientRedeemable) {
      // Conditional update: only decrements when the CURRENT balance still covers it.
      // count===0 means a concurrent debit consumed the balance between our read and
      // this write → reject cleanly instead of going negative.
      const guarded = await tx.wallet.updateMany({
        where: { id: wallet.id, redeemablePoints: { gte: magnitude }, ...seqGuard },
        data,
      });
      if (guarded.count !== 1) {
        if (opts.unsequencedGuard) {
          // Error path only: tell "insufficient" from "sequenced since the caller's read".
          const cur = await tx.wallet.findFirst({ where: { id: wallet.id }, select: { movementSeq: true } });
          if (cur && (cur.movementSeq ?? 0) > 0) return null;
        }
        throw new BadRequestException(insufficientMessage);
      }
      updatedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      // Keep the recorded before/after pair internally consistent under concurrency.
      balanceBefore = updatedWallet.redeemablePoints + magnitude;
    } else {
      try {
        // Extended unique where → ONE `UPDATE … WHERE id = $1 AND "movementSeq" = 0 RETURNING …` (verified on Prisma 7
        // + PGlite, fix round A); without the guard it is exactly today's `WHERE id = $1`.
        updatedWallet = await tx.wallet.update({ where: { id: wallet.id, ...seqGuard }, data });
      } catch (e) {
        if (opts.unsequencedGuard && isRecordNotFound(e)) return null;
        throw e;
      }
      // A CREDIT's increment is atomic, so the exact pre-movement balance is the post-update value
      // minus the credit — NOT the caller's earlier read, which is stale when another movement
      // committed in between (e.g. a confirm racing a redemption). Balance-neutral; it only makes
      // the recorded balanceBefore/After chain exact. Debits keep `balanceBefore` (the guarded
      // path re-derives it above; the floored callers lock + re-read the wallet first).
      if (isCredit) balanceBefore = updatedWallet.redeemablePoints - magnitude;
    }

    // Movement timestamp for ORDER-SENSITIVE rows (credit-batch credits + reversal clawbacks, i.e.
    // whenever `metadata` is passed): taken in app code HERE, after the wallet UPDATE above, i.e.
    // while this tx holds the wallet's row lock. Any later movement on this wallet must wait for
    // our commit before it can lock the row and take its own stamp, so per-wallet stamps follow
    // the true movement order (up to cross-instance clock skew, ~ms with NTP-synced hosts; ties
    // break on id). We do NOT rely on the column default: a DB-side now() is the TRANSACTION start
    // time, so a long confirm tx that began before a clawback but locked the wallet after it would
    // otherwise be stamped EARLIER than that clawback (the reversal-engine v2 backfill orders a
    // wallet's history by these stamps).
    const movedAt = metadata !== undefined ? new Date() : undefined;

    const txRecord = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        transactionType: walletTxType,
        points,
        balanceBefore,
        balanceAfter: updatedWallet.redeemablePoints,
        balanceType,
        referenceType,
        referenceId,
        description,
        ...(metadata !== undefined ? { metadata, createdAt: movedAt } : {}),
      },
    });

    const ledgerRow = await tx.pointsLedger.create({
      data: {
        walletId: wallet.id,
        schemeId,
        transactionType: ledgerType,
        points,
        // Spendable credit lots start fully-remaining; everything else (debits, locks) at 0.
        remainingPoints: isSpendableCreditLot ? magnitude : 0,
        expiresAt,
        sourceType,
        sourceId,
        notes: description,
      },
    });

    // FIFO bookkeeping: a SPENDING debit (redeem / debit-adjust / clawback) consumes the
    // oldest spendable lots' remainingPoints so the lot mirror tracks the scalar. The expiry
    // sweep is EXCLUDED — it decrements the specific due lot itself (see expireDuePoints).
    // This never touches redeemablePoints (already moved above) — pure lot bookkeeping.
    if (!isCredit && ledgerType !== PointsLedgerType.EXPIRE) {
      await this.consumeFifoLots(tx, wallet.id, magnitude);
    }

    return {
      transactionId: txRecord.id,
      newRedeemable: updatedWallet.redeemablePoints,
      ledgerId: ledgerRow.id,
    };
  }

  /**
   * FIFO-consume `amount` points from the oldest spendable lots of a wallet by decrementing
   * each lot's `remainingPoints` (oldest earn first: createdAt asc, id tiebreak). Each decrement
   * is guarded (`isExpired:false AND remainingPoints >= take`) so it can't race a concurrent
   * redeem or the expiry sweep (which fences a lot by flipping isExpired first) into negative.
   *
   * Bookkeeping ONLY — the caller (applyMovement) has already moved the authoritative
   * `wallet.redeemablePoints` scalar; this just keeps the lot mirror aligned. It is tolerant of a
   * shortfall: a pre-fix wallet whose lots predate this feature has remainingPoints 0, so there is
   * nothing to consume — the scalar (guarded elsewhere) remains the source of truth for
   * sufficiency, and the mirror re-converges as new lots are earned/spent. Returns the amount
   * actually consumed from lots.
   */
  private async consumeFifoLots(
    tx: Prisma.TransactionClient,
    walletId: string,
    amount: number,
  ): Promise<number> {
    let remaining = amount;
    const lots = await tx.pointsLedger.findMany({
      where: {
        walletId,
        isExpired: false,
        remainingPoints: { gt: 0 },
        points: { gt: 0 },
        transactionType: {
          in: [
            PointsLedgerType.EARN,
            PointsLedgerType.REVERSE,
            PointsLedgerType.ADJUST,
          ],
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(lot.remainingPoints, remaining);
      // Guarded decrement: only when the lot is still unexpired and still holds >= take.
      // count 0 ⇒ a concurrent movement changed it; skip and let the scalar guard govern.
      const res = await tx.pointsLedger.updateMany({
        where: { id: lot.id, isExpired: false, remainingPoints: { gte: take } },
        data: { remainingPoints: { decrement: take } },
      });
      if (res.count === 1) remaining -= take;
    }
    return amount - remaining;
  }

  /**
   * Q7 lot draw for a v2 reversal: take `amount` from the reversed credit's OWN lot first (so the reversed points
   * don't survive in it and extend their expiry), then FIFO. Same tolerant, guarded bookkeeping as
   * consumeFifoLots — the wallet scalar (already moved) stays the source of truth.
   */
  private async consumeLots(
    tx: Prisma.TransactionClient,
    walletId: string,
    amount: number,
    preferredLotId: string | null,
  ): Promise<number> {
    let consumed = 0;
    if (preferredLotId && amount > 0) {
      const own = await tx.pointsLedger.findFirst({
        where: { id: preferredLotId, walletId, isExpired: false, remainingPoints: { gt: 0 } },
      });
      if (own) {
        const take = Math.min(own.remainingPoints, amount);
        const res = await tx.pointsLedger.updateMany({
          where: { id: own.id, isExpired: false, remainingPoints: { gte: take } },
          data: { remainingPoints: { decrement: take } },
        });
        if (res.count === 1) consumed += take;
      }
    }
    if (amount - consumed > 0) consumed += await this.consumeFifoLots(tx, walletId, amount - consumed);
    return consumed;
  }

  /**
   * v2 expiry of one claimed lot on a TRACKED wallet (§3.2 Expiry, §7, Q6). The lot's remaining h is clamped to the
   * holdings H = B + D (a legacy-era lot mirror can exceed H; the clamp never changes the expired amount e) and WP0
   * expire() gives e = min(h, max(0, B)) — today's clamp — and the excess x = h − e, which was covering debt: D −= x
   * and the lot's owning position O += x (bounded by its room a − O, the WP0 replay() rule). Writes the DEBIT_EXPIRY
   * movement only when e > 0 (as today: nothing expired → no passbook row); an x-only change updates D / O alone.
   * The caller holds the wallet lock and has already claimed + zeroed the lot. Returns e.
   */
  private async expireTrackedLot(
    tx: Prisma.TransactionClient,
    w: Wallet,
    lot: { id: string; schemeId: string | null },
    h: number,
  ): Promise<number> {
    if (h <= 0) return 0;
    const before = walletStateOf(w);
    const H = before.B + before.D;
    if (before.D < 0 || H < 0) throw new ConflictException(WALLET_STATE_INCONSISTENT_MESSAGE);
    const hEff = Math.min(h, H);
    if (hEff < h) {
      this.logger.warn(`expiry: lot ${lot.id} remaining ${h} exceeds wallet ${w.id} holdings ${H}; clamped (lot mirror drift)`);
    }
    if (hEff <= 0) return 0;
    const pos = await tx.walletCreditPosition.findFirst({ where: { lotId: lot.id, walletId: w.id } });
    const model: WalletModel = {
      state: { ...before },
      positions: pos
        ? { [pos.id]: { id: pos.id, amount: pos.amount, offset: pos.offsetPoints, reversed: pos.reversedPoints, lotRemaining: hEff } }
        : {},
      lots: [
        { id: lot.id, creditId: pos ? pos.id : null, remaining: hEff },
        ...(H - hEff > 0 ? [{ id: HOLDINGS_LOT_ID, creditId: null, remaining: H - hEff }] : []),
      ],
    };
    const step = modelExpire(model, lot.id);
    const e = step.movement.pointsDelta === 0 ? 0 : -step.movement.pointsDelta;
    const x = step.movement.debtDelta === 0 ? 0 : -step.movement.debtDelta;

    if (e > 0) {
      await this.writeTrackedMovement(tx, {
        walletId: w.id,
        before,
        after: step.model.state,
        pointsDelta: step.movement.pointsDelta,
        counters: { expiredPoints: { increment: e }, lifetimeExpired: { increment: e } },
        walletTxType: 'DEBIT_EXPIRY',
        ledgerType: PointsLedgerType.EXPIRE,
        points: -e,
        balanceType: 'REDEEMABLE',
        referenceType: 'POINTS_LEDGER',
        referenceId: lot.id,
        schemeId: lot.schemeId,
        expiresAt: null,
        description: 'Points expired',
        sourceType: 'EXPIRY_SWEEP',
        sourceId: lot.id,
        lotRemaining: 0,
      });
    } else if (x > 0) {
      // Nothing left to expire from the balance, but the lot's points were covering debt: reclassify only.
      const upd = await tx.wallet.updateMany({
        where: { id: w.id, movementSeq: before.seq, debtPoints: before.D },
        data: { debtPoints: step.model.state.D },
      });
      if (upd.count !== 1) throw new ConflictException('The wallet changed during expiry — please retry');
      // Fix round A, L1 — never a silent state change: the lot expired, nothing left the balance, but the debt it
      // was covering is now repaid. Trace = an audit row (same tx). Deliberately NOT a zero-points passbook movement:
      // the partner would see a "Points expired 0" row about debt they are never shown (Q8), and every wallet row
      // must keep a non-zero `points` for the backfill / V2 chain checks — so no seq is consumed and no
      // WalletTransaction is written. The lot itself carries the rest of the trace (isExpired, remainingPoints 0).
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: POINTS_EXPIRY_DEBT_ONLY_ENTITY,
          entityId: w.id,
          actorId: null,
          metadata: {
            lotId: lot.id,
            lotRemaining: h,
            expiredFromBalance: 0,
            debtRepaid: x,
            debtBefore: before.D,
            debtAfter: step.model.state.D,
            balance: before.B,
            movementSeq: before.seq,
            positionId: pos?.id ?? null,
          } as Prisma.InputJsonValue,
        },
      });
    }

    if (pos && x > 0) {
      const add = Math.min(x, pos.amount - pos.offsetPoints);
      if (add < x) {
        // Audit B8: REACHABLE — the WP6 backfill never rewrites lots, so a backfilled wallet's legacy-era lot can hold
        // more than its position's room (a − O). Debt is still repaid in full (D above); only the position's offset is
        // capped, so a later reversal of that credit restores less debt than it repaid. Never log-only: an audit row
        // in this tx + the Gifsy attention endpoint / banner ("expiryOffsetCapped").
        this.logger.warn(`expiry: lot ${lot.id} excess ${x} exceeds position ${pos.id} room; offset +${add} only`);
        const owner = await tx.channelPartner.findFirst({ where: { id: w.partnerId }, select: { clientId: true } });
        await tx.auditLog.create({
          data: {
            action: 'UPDATE',
            entityType: POINTS_EXPIRY_OFFSET_CAPPED_ENTITY,
            entityId: w.id,
            actorId: null,
            metadata: {
              clientId: owner?.clientId ?? null,
              walletId: w.id,
              lotId: lot.id,
              positionId: pos.id,
              creditTxId: pos.creditTxId,
              batchId: pos.batchId,
              outletCode: pos.outletCode,
              debtRepaid: x,
              offsetAdded: add,
              offsetNotRecorded: x - add,
            } as Prisma.InputJsonValue,
          },
        });
      }
      if (add > 0) {
        const res = await tx.walletCreditPosition.updateMany({
          where: { id: pos.id, offsetPoints: pos.offsetPoints },
          data: { offsetPoints: pos.offsetPoints + add },
        });
        if (res.count !== 1) throw new ConflictException('The credit position changed during expiry — please retry');
      }
    }
    return e;
  }

  /** Run `fn` inside the supplied tx, or open a fresh $transaction if none given. */
  private withTx<T>(
    tx: Prisma.TransactionClient | undefined,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (tx) return fn(tx);
    return this.prisma.$transaction((inner) => fn(inner));
  }

  /** Load a partner's wallet inside a tx; throws NotFound if absent. */
  private async requireWallet(tx: Prisma.TransactionClient, partnerId: string) {
    const wallet = await tx.wallet.findFirst({ where: { partnerId } });
    if (!wallet) throw new NotFoundException('Wallet not found for this partner');
    return wallet;
  }

  /**
   * Resolve the active expiry config for a credit and compute its expiresAt.
   * Rule: prefer the scheme-specific active config when a schemeId is supplied and
   * a matching `{ schemeId, isActive: true }` row exists; otherwise fall back to the
   * client's `{ isDefault: true, isActive: true }` config. If neither exists →
   * null (no expiry). expiresAt = now + expiryDays.
   */
  private async resolveExpiresAt(
    tx: Prisma.TransactionClient,
    clientId: string,
    schemeId?: string | null,
  ): Promise<Date | null> {
    let config: Awaited<ReturnType<typeof tx.pointExpiryConfig.findFirst>> = null;
    if (schemeId) {
      config = await tx.pointExpiryConfig.findFirst({
        where: { clientId, schemeId, isActive: true },
      });
    }
    if (!config) {
      config = await tx.pointExpiryConfig.findFirst({
        where: { clientId, isDefault: true, isActive: true },
      });
    }
    if (!config) return null;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + config.expiryDays);
    return expiresAt;
  }

  // ─── Public read paths ──────────────────────────────────────────────────────

  /** The zeroed wallet summary (no partner / no wallet row yet). Carries the tenant rate. */
  private zeroedSummary(conversionRate: number) {
    return {
      earnedPoints: 0,
      lockedPoints: 0,
      redeemablePoints: 0,
      redeemedPoints: 0,
      expiredPoints: 0,
      lifetimeEarned: 0,
      lifetimeRedeemed: 0,
      lifetimeExpired: 0,
      currency: 'POINTS',
      conversionRate,
    };
  }

  /**
   * SHARED wallet-summary builder — the single source of truth for the summary shape,
   * used by BOTH the partner-facing getWallet and the GIFSY admin outlet route so the
   * two can never diverge. Resolves the per-tenant points→₹ rate, loads the partner's
   * wallet, and returns the summary (zeroed — but still rate-carrying — when absent).
   * Tenant scope / partner authorization is the CALLER's responsibility.
   */
  private async loadWalletSummary(partnerId: string, clientId: string) {
    const conversionRate = await this.tenantSettings.getConversionRate(clientId);
    const wallet = await this.prisma.wallet.findFirst({ where: { partnerId } });
    if (!wallet) return this.zeroedSummary(conversionRate);

    return {
      earnedPoints: wallet.earnedPoints,
      lockedPoints: wallet.lockedPoints,
      redeemablePoints: wallet.redeemablePoints,
      redeemedPoints: wallet.redeemedPoints,
      expiredPoints: wallet.expiredPoints,
      lifetimeEarned: wallet.lifetimeEarned,
      lifetimeRedeemed: wallet.lifetimeRedeemed,
      lifetimeExpired: wallet.lifetimeExpired,
      currency: 'POINTS',
      conversionRate,
      // Owner decision 2 (2026-11-19): a NEGATIVE wallet also says what is owed and whether a reversal caused it
      // (nothing added — and no query — for a wallet at 0 or above).
      ...(await negativeBalanceSignals(this.prisma, wallet)),
    };
  }

  /** GET /v1/wallet — the ACTIVE partner's wallet summary (zeros if no partner/wallet). */
  async getWallet(user: JwtPayload, requestedPartnerId?: string) {
    // Wave 3: resolve the ACTIVE partner (own, or an authorized switched-to sibling). The selector is
    // re-authorized here — a forged/foreign id can NEVER surface another partner's wallet balance.
    const { partnerId, forbidden } = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    if (!partnerId) {
      // No operable partner → graceful zeros (unchanged), still carrying the tenant rate.
      const conversionRate = await this.tenantSettings.getConversionRate(user.clientId);
      return this.zeroedSummary(conversionRate);
    }

    return this.loadWalletSummary(partnerId, user.clientId);
  }

  /**
   * SHARED passbook builder — the single source of truth for the paginated passbook,
   * used by BOTH the partner-facing listTransactions and the GIFSY admin outlet route
   * so the two can never diverge. Includes the CREDIT_BATCH field-name resolution.
   * Tenant scope / partner authorization is the CALLER's responsibility.
   */
  private async loadPassbook(
    partnerId: string,
    clientId: string,
    q: { page?: number; limit?: number; type?: WalletTransactionType },
    // When the caller already knows the exact outlet in context (the GIFSY admin route
    // resolves it by code), pass it so CREDIT_BATCH field-name resolution replays THAT
    // outlet's rows — not the partner's primary outlet. Omitted (partner path) → derive
    // the primary as before.
    knownOutletCode?: string,
  ) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const skip = (page - 1) * limit;

    const emptyResult = {
      transactions: [],
      pagination: { page, limit, total: 0, pages: 0 },
    };

    const wallet = await this.prisma.wallet.findFirst({
      where: { partnerId },
    });
    if (!wallet) return emptyResult;

    const where: Prisma.WalletTransactionWhereInput = { walletId: wallet.id };
    if (q.type) where.transactionType = q.type;

    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    // ── Resolve the credit FIELD NAME for CREDIT_BATCH rows on this page ──────────
    // WalletTransaction stores the batch id + narration, not the field name; the
    // shared resolver replays the batch `rows` JSON read-time. Because this endpoint
    // is PAGINATED, resolving over ONLY the page could mis-map when a batch straddles
    // a page boundary (consumption order would be wrong). So we resolve over ALL of
    // this wallet's CREDIT_BATCH txns (a separate lightweight query), then apply the
    // Map to the page → pagination-robust, page boundaries can never mis-map.
    let outletCode = knownOutletCode ?? '';
    if (!knownOutletCode) {
      const outlet = await this.prisma.outlet.findFirst({
        where: { clientId, partnerId, deletedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: { outletCode: true },
      });
      outletCode = outlet?.outletCode ?? '';
    }

    const allCreditTxns = await this.prisma.walletTransaction.findMany({
      where: { walletId: wallet.id, referenceType: 'CREDIT_BATCH' },
      select: {
        id: true,
        referenceType: true,
        referenceId: true,
        description: true,
        points: true,
        createdAt: true,
      },
    });
    const fieldNameByTxId = await resolveCreditFieldNames(
      this.prisma,
      clientId,
      outletCode,
      allCreditTxns,
    );

    const passbook = transactions.map((t) => ({
      id: t.id,
      transactionType: t.transactionType,
      description: t.description ?? this.getDefaultDescription(t.transactionType),
      points: t.points,
      date: t.createdAt,
      balanceType: t.balanceType,
      balanceAfter: t.balanceAfter,
      referenceType: t.referenceType,
      referenceId: t.referenceId,
      // Credit rows resolve to their batch field name; everything else is null.
      fieldName: fieldNameByTxId.get(t.id) ?? null,
      // RAW upload narration (BEFORE the getDefaultDescription fallback) — null/empty
      // when the upload carried no narration, so the FE only shows a real note.
      narration: t.description,
    }));

    return {
      transactions: passbook,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  /** GET /v1/wallet/transactions — paginated passbook for the caller's ACTIVE partner. */
  async listTransactions(user: JwtPayload, q: ListTransactionsQueryDto, requestedPartnerId?: string) {
    // Resolve the ACTIVE partner from the login-picker selector (own, or an authorized
    // same-group same-phone sibling), re-authorized so a forged header can't reach another passbook.
    const active = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (active.forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    if (!active.partnerId) {
      const page = q.page ?? 1;
      const limit = q.limit ?? 20;
      return { transactions: [], pagination: { page, limit, total: 0, pages: 0 } };
    }

    return this.loadPassbook(active.partnerId, user.clientId, q);
  }

  /**
   * GET /v1/wallet/statement — the caller's ACTIVE partner's FULL, UNPAGINATED points statement
   * (oldest first) for an optional IST month range, with the STORED per-row balances and the
   * opening/closing balance (owner decision D3). Built by the shared loader the sales ledger also
   * uses, so the two can never drift. Same access boundary as the passbook (forged selector →
   * 403). No partner / no wallet yet (pre-KYC) → an empty zero statement, not a 404.
   */
  async statement(user: JwtPayload, q: StatementQueryDto, requestedPartnerId?: string) {
    const active = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (active.forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    if (!active.partnerId) return { ...EMPTY_STATEMENT, outletName: null, rows: [] };

    // The statement's outlet — the SAME row supplies the code AND the name, so a downloaded
    // statement can never pair one outlet's name with another's code (the FE used to take the name
    // from the shell identity, which can lag the active-outlet selection). Resolved before the
    // wallet check so a no-wallet (payout-only / pre-KYC) statement carries the matching pair too.
    const outlet = await this.prisma.outlet.findFirst({
      where: { clientId: user.clientId, partnerId: active.partnerId, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { outletCode: true, name: true },
    });
    const outletCode = outlet?.outletCode ?? '';
    const outletName = outlet?.name ?? null;

    const wallet = await this.prisma.wallet.findFirst({ where: { partnerId: active.partnerId } });
    if (!wallet) return { ...EMPTY_STATEMENT, outletCode, outletName, rows: [] };

    const stmt = await buildStatementResponse(this.prisma, this.logger, {
      wallet,
      clientId: user.clientId,
      outletCode,
      from: q.from,
      to: q.to,
    });
    return { ...stmt, outletName };
  }

  /**
   * GET /v1/wallet/points-credited?month=YYYY-MM — total points CREDITED (earned) to the caller's
   * ACTIVE partner wallet during the IST calendar month `monthKey`.
   *
   * WHY a dedicated aggregate (not the passbook): /wallet/transactions is PAGINATED (page 1,
   * limit 20, newest-first). For an active wholesaler with months of credits + a daily expiry
   * sweep, last month's earn credit sits far past page 1, so summing the first page would under-
   * report (often to 0). This sums server-side over the WHOLE month window via a DB aggregate, so
   * it is correct at any scale and never fetches more than one row's worth of data to the client.
   *
   * WHAT counts as "credited": the genuine EARN credits — CREDIT_POINTS_EARNED, CREDIT_BONUS and
   * CREDIT_ADJUSTMENT (the credit types that bump lifetimeEarned per the wallet invariant above).
   * CREDIT_REVERSAL is EXCLUDED: it re-credits redeemable points from a reversed redemption but is
   * NOT new earning, so it must not inflate a "reward credited last month" figure.
   *
   * Tenant- + partner-scoped via the same login-picker access boundary as the passbook. Returns
   * { month, points } with points 0 when the caller has no operable partner / no wallet / no
   * credits in that month. Additive read-only — no existing behaviour changes.
   */
  async pointsCreditedInMonth(user: JwtPayload, monthKey: string, requestedPartnerId?: string) {
    if (!/^\d{4}-\d{2}$/.test(monthKey ?? '')) {
      throw new BadRequestException('month must be a YYYY-MM value');
    }

    const active = await resolveActivePartnerId(this.prisma, {
      clientId: user.clientId,
      userSub: user.sub,
      phone: user.phone,
      requestedPartnerId,
    });
    if (active.forbidden) throw new ForbiddenException('You cannot act on that outlet.');
    if (!active.partnerId) return { month: monthKey, points: 0 };

    const wallet = await this.prisma.wallet.findFirst({
      where: { partnerId: active.partnerId },
      select: { id: true },
    });
    if (!wallet) return { month: monthKey, points: 0 };

    const { start, endExclusive } = istMonthBounds(monthKey);
    const agg = await this.prisma.walletTransaction.aggregate({
      _sum: { points: true },
      where: {
        walletId: wallet.id,
        transactionType: {
          in: [
            WalletTransactionType.CREDIT_POINTS_EARNED,
            WalletTransactionType.CREDIT_BONUS,
            WalletTransactionType.CREDIT_ADJUSTMENT,
          ],
        },
        createdAt: { gte: start, lt: endExclusive },
      },
    });

    return { month: monthKey, points: agg._sum.points ?? 0 };
  }

  // ─── GIFSY-only admin: wallet BY OUTLET ─────────────────────────────────────
  //
  // Support/ops tooling: a GIFSY operator (optionally assumed into a tenant) inspects
  // ANY outlet's wallet by outlet CODE. Tenant scope is user.clientId — a foreign-tenant
  // outlet code 404s (never surfaces another tenant's wallet). `Outlet` has a
  // @@unique([clientId, outletCode]) so the (tenant, code) lookup is unique. A pre-KYC
  // outlet with no partner yet (partnerId null) has no wallet → zeroed summary / empty page.

  /**
   * Resolve an outlet by CODE within the operator's tenant. 404s a foreign-tenant /
   * missing / soft-deleted outlet — this tenant-scope invariant must not be widened.
   * `partnerId` may be null (an outlet created pre-KYC has no ChannelPartner / wallet yet).
   */
  private async resolveAdminOutlet(user: JwtPayload, outletCode: string) {
    const outlet = await this.prisma.outlet.findFirst({
      where: { clientId: user.clientId, outletCode, deletedAt: null },
      select: { outletCode: true, name: true, ownerName: true, partnerId: true },
    });
    if (!outlet) throw new NotFoundException('Outlet not found in this tenant.');
    return {
      outlet: { outletCode: outlet.outletCode, name: outlet.name, ownerName: outlet.ownerName },
      partnerId: outlet.partnerId,
    };
  }

  /** GET /v1/wallet/admin/outlet/:outletCode/summary — GIFSY-only wallet summary by outlet code. */
  async adminOutletWallet(user: JwtPayload, outletCode: string) {
    const { outlet, partnerId } = await this.resolveAdminOutlet(user, outletCode);
    if (!partnerId) {
      // Pre-KYC outlet: no partner/wallet yet → zeroed summary (still carries the tenant rate).
      const conversionRate = await this.tenantSettings.getConversionRate(user.clientId);
      return { outlet, partnerId: null, hasWallet: false, wallet: this.zeroedSummary(conversionRate) };
    }
    return {
      outlet,
      partnerId,
      hasWallet: true,
      wallet: await this.loadWalletSummary(partnerId, user.clientId),
    };
  }

  /** GET /v1/wallet/admin/outlet/:outletCode/transactions — GIFSY-only passbook by outlet code. */
  async adminOutletTransactions(
    user: JwtPayload,
    outletCode: string,
    q: { page?: number; limit?: number; type?: WalletTransactionType },
  ) {
    const { outlet, partnerId } = await this.resolveAdminOutlet(user, outletCode);
    if (!partnerId) {
      // Pre-KYC outlet: no partner/wallet yet → empty page.
      const page = q.page ?? 1;
      const limit = q.limit ?? 20;
      return { transactions: [], pagination: { page, limit, total: 0, pages: 0 } };
    }
    // Resolve credit field-names against THIS outlet's rows (the one the admin selected),
    // not the partner's primary outlet.
    return this.loadPassbook(partnerId, user.clientId, q, outlet.outletCode);
  }

  // ─── Core mutations (composable: pass `tx` to compose inside a caller's $transaction) ─

  /**
   * Credit earned points (CREDIT_POINTS_EARNED / ledger EARN). The primitive that
   * P6 credits + 5.4 refunds reuse. Stamps expiresAt from the active
   * PointExpiryConfig (see resolveExpiresAt). Points land directly in
   * redeemablePoints (holding deferred). `clientId` is needed to resolve the
   * tenant's expiry config.
   *
   * NOTE: tenant scope on `partnerId` is the CALLER's responsibility (this is an
   * internal primitive, not a user-facing route). adjust() does the wrong-tenant
   * check before delegating to applyMovement directly.
   */
  async creditEarn(
    partnerId: string,
    clientId: string,
    amount: number,
    opts: {
      schemeId?: string | null;
      referenceType?: string | null;
      referenceId?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
      description?: string | null;
      // Stored on the WalletTransaction (credit-batch confirm passes { fieldId, outletCode } so a
      // reversal can find the EXACT credit it undoes). Omitted → nothing stored.
      metadata?: Prisma.InputJsonValue;
    } = {},
    tx?: Prisma.TransactionClient,
  ) {
    if (amount <= 0) throw new BadRequestException('Credit amount must be positive');

    // A credit-batch POINTS credit (confirmBatch: referenceType CREDIT_BATCH + metadata { fieldId, outletCode })
    // is reversible → on a tracked wallet it gets its WalletCreditPosition (§5 step 5). Every other credit
    // (refund, manual, points-engine) is a plain, non-reversible credit.
    const meta =
      opts.metadata && typeof opts.metadata === 'object' && !Array.isArray(opts.metadata)
        ? (opts.metadata as Record<string, unknown>)
        : null;
    const creditPosition =
      opts.referenceType === 'CREDIT_BATCH' &&
      typeof opts.referenceId === 'string' &&
      typeof meta?.fieldId === 'string' &&
      typeof meta?.outletCode === 'string'
        ? { batchId: opts.referenceId, outletCode: meta.outletCode, fieldId: meta.fieldId }
        : null;

    return this.withTx(tx, async (t) => {
      const wallet = await this.requireWallet(t, partnerId);
      const expiresAt = await this.resolveExpiresAt(t, clientId, opts.schemeId ?? null);
      return this.applyMovement(t, {
        creditPosition,
        wallet,
        walletTxType: 'CREDIT_POINTS_EARNED',
        ledgerType: PointsLedgerType.EARN,
        points: amount,
        schemeId: opts.schemeId ?? null,
        expiresAt,
        referenceType: opts.referenceType ?? null,
        referenceId: opts.referenceId ?? null,
        sourceType: opts.sourceType ?? null,
        sourceId: opts.sourceId ?? null,
        description: opts.description ?? null,
        ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
      });
    });
  }

  /**
   * Debit redeemable points for a redemption (DEBIT_REDEMPTION / ledger REDEEM).
   * Throws BadRequest (400) when redeemablePoints < amount. Used by 5.4 redeem.
   *
   * The pre-check below is a fast reject; the actual decrement is ATOMICALLY GUARDED
   * (requireSufficientRedeemable) so two concurrent redemptions (or a redemption racing
   * an admin debit) on the same wallet can never both pass the check and drive the
   * balance negative — the loser's guarded update matches 0 rows and rejects cleanly.
   */
  async debitRedeem(
    partnerId: string,
    amount: number,
    opts: { referenceId?: string | null; description?: string | null } = {},
    tx?: Prisma.TransactionClient,
  ) {
    if (amount <= 0) throw new BadRequestException('Redeem amount must be positive');

    return this.withTx(tx, async (t) => {
      const wallet = await this.requireWallet(t, partnerId);
      if (wallet.redeemablePoints < amount) {
        throw new BadRequestException('Insufficient wallet balance for redemption');
      }
      return this.applyMovement(t, {
        wallet,
        walletTxType: 'DEBIT_REDEMPTION',
        ledgerType: PointsLedgerType.REDEEM,
        points: -amount,
        referenceType: 'REDEMPTION_ORDER',
        referenceId: opts.referenceId ?? null,
        description: opts.description ?? null,
        // Close the TOCTOU: decrement only if the CURRENT balance still covers it.
        requireSufficientRedeemable: true,
        insufficientMessage: 'Insufficient wallet balance for redemption',
      });
    });
  }

  /**
   * Re-credit points (CREDIT_REVERSAL / ledger REVERSE) — used by 5.4
   * refund-on-cancel/return and P6 reversal. Increments redeemablePoints but does
   * NOT bump earnedPoints/lifetimeEarned: a reversal restores previously-spent
   * points, it is not new earning (keeping lifetimeEarned monotonic + truthful).
   */
  async reverse(
    partnerId: string,
    amount: number,
    opts: { referenceId?: string | null; description?: string | null } = {},
    tx?: Prisma.TransactionClient,
  ) {
    if (amount <= 0) throw new BadRequestException('Reversal amount must be positive');

    return this.withTx(tx, async (t) => {
      const wallet = await this.requireWallet(t, partnerId);
      // A reversed/refunded redemption becomes a fresh spendable lot with a FRESH expiry
      // window (owner-confirmed): restored points are re-dated per the tenant's current
      // expiry config, so the REVERSE lot is expirable like any other credit lot.
      const partner = await t.channelPartner.findFirst({
        where: { id: partnerId },
        select: { clientId: true },
      });
      const expiresAt = partner
        ? await this.resolveExpiresAt(t, partner.clientId, null)
        : null;
      return this.applyMovement(t, {
        wallet,
        walletTxType: 'CREDIT_REVERSAL',
        ledgerType: PointsLedgerType.REVERSE,
        points: amount,
        expiresAt,
        referenceType: 'REDEMPTION_ORDER',
        referenceId: opts.referenceId ?? null,
        description: opts.description ?? null,
      });
    });
  }

  /** POST /v1/wallet/adjust — GIFSY-only manual credit/debit on a partner wallet. */
  async adjust(user: JwtPayload, dto: AdjustWalletDto) {
    // GIFSY-only is enforced by @Roles on the controller; tenant scope checked here.
    const wallet = await this.prisma.wallet.findFirst({
      where: { partnerId: dto.partnerId, partner: { user: { clientId: user.clientId } } },
    });
    if (!wallet) throw new NotFoundException('Wallet not found for this partner');

    const isCredit = dto.type === AdjustType.CREDIT;
    if (!isCredit && wallet.redeemablePoints < dto.amount) {
      throw new BadRequestException('Insufficient wallet balance for debit');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // A manual CREDIT is treated as earning → create an expirable spendable lot with a
      // fresh expiry window (like EARN). A DEBIT carries no expiry and FIFO-consumes lots.
      const expiresAt = isCredit
        ? await this.resolveExpiresAt(tx, user.clientId, null)
        : null;
      // Route through the single write-path: writes WalletTransaction AND
      // PointsLedger (ADJUST). On debit this decrements redeemablePoints ONLY —
      // it no longer decrements earnedPoints/lifetimeEarned (bug #1 fixed).
      const movement = await this.applyMovement(tx, {
        wallet,
        walletTxType: isCredit ? 'CREDIT_ADJUSTMENT' : 'DEBIT_ADJUSTMENT',
        ledgerType: PointsLedgerType.ADJUST,
        points: isCredit ? dto.amount : -dto.amount,
        expiresAt,
        description: `Manual ${dto.type.toLowerCase()} by admin. Reason: ${dto.reason}`,
        sourceType: 'ADMIN_ADJUSTMENT',
        sourceId: user.sub,
        // Atomic-guarded debit: the pre-tx check above is a fast UX reject; this closes
        // the TOCTOU so a concurrent redemption can't drive redeemable negative.
        requireSufficientRedeemable: !isCredit,
      });

      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'WALLET',
          entityId: wallet.id,
          actorId: user.sub,
          metadata: {
            partnerId: dto.partnerId,
            amount: dto.amount,
            type: dto.type,
            reason: dto.reason,
            approvedBy: dto.approvedBy,
            transactionId: movement.transactionId,
          },
        },
      });

      return movement;
    });

    return {
      transactionId: result.transactionId,
      newBalance: result.newRedeemable,
    };
  }

  /**
   * Owner decision 2026-11-19 (expired points are not recovered twice) — attach to each position E_X (points of its own
   * lot that EXPIRED from the balance: the lot's DEBIT_EXPIRY row, balanceBefore − balanceAfter — exact on both write
   * paths, and 0 for a debt-only expiry, whose excess already sits in O_X) and ε_X (Σ alreadyExpired of the position's
   * earlier allocations). Two indexed reads per reversal.
   */
  private async withExpiry(tx: Prisma.TransactionClient, positions: ReversalPositionRow[]): Promise<ReversalPositionRow[]> {
    if (positions.length === 0) return positions;
    // Fix round 4 (item 1): a position without `lotId` (backfilled credit) still finds its own lot through its CREDIT
    // ROW (wallet_transactions.pointsLedgerId — set for every sequenced credit). Only when neither link exists is the
    // credit's expiry history unknown (`expiryKnown` false) — the caller flags that loudly.
    const unlinked = positions.filter((p) => !p.lotId).map((p) => p.creditTxId);
    const viaCredit = unlinked.length
      ? await tx.walletTransaction.findMany({ where: { id: { in: unlinked } }, select: { id: true, pointsLedgerId: true } })
      : [];
    const lotOf = new Map<string, string | null>(
      positions.map((p) => [p.id, p.lotId ?? (viaCredit ?? []).find((t) => t.id === p.creditTxId)?.pointsLedgerId ?? null]),
    );
    const lotIds = [...new Set([...lotOf.values()].filter((x): x is string => !!x))];
    const [lotRows, expiries, counted] = await Promise.all([
      // Round 5 (A1): the lot only counts as the credit's own when it is a credit lot (points > 0) of THIS wallet.
      lotIds.length
        ? tx.pointsLedger.findMany({ where: { id: { in: lotIds }, points: { gt: 0 } }, select: { id: true, walletId: true } })
        : Promise.resolve([] as { id: string; walletId: string }[]),
      lotIds.length
        ? tx.walletTransaction.findMany({
            where: { transactionType: 'DEBIT_EXPIRY', referenceType: 'POINTS_LEDGER', referenceId: { in: lotIds } },
            select: { walletId: true, referenceId: true, balanceBefore: true, balanceAfter: true },
          })
        : Promise.resolve([] as { walletId: string; referenceId: string | null; balanceBefore: number; balanceAfter: number }[]),
      tx.creditReversalAllocation.findMany({
        where: { positionId: { in: positions.map((p) => p.id) } },
        select: { positionId: true, alreadyExpired: true },
      }),
    ]);
    return positions.map((p) => {
      const linked = lotOf.get(p.id) ?? null;
      const lot = linked && (lotRows ?? []).some((l) => l.id === linked && l.walletId === p.walletId) ? linked : null;
      const expired = (expiries ?? [])
        .filter((e) => !!lot && e.referenceId === lot && e.walletId === p.walletId)
        .reduce((s, e) => s + Math.max(0, e.balanceBefore - e.balanceAfter), 0);
      const expiredCounted = (counted ?? [])
        .filter((a) => a.positionId === p.id)
        .reduce((s, a) => s + (a.alreadyExpired ?? 0), 0);
      return { ...p, expired, expiredCounted, expiryKnown: !!lot };
    });
  }

  /** Guarded position update (optimistic on the values we planned from — we hold the wallet lock). */
  private async updatePosition(tx: Prisma.TransactionClient, st: PlannedReversalStep): Promise<void> {
    const res = await tx.walletCreditPosition.updateMany({
      where: {
        id: st.position.id,
        offsetPoints: st.position.offsetPoints,
        reversedPoints: st.position.reversedPoints,
      },
      data: { offsetPoints: st.newOffset, reversedPoints: st.newReversed },
    });
    if (res.count !== 1) {
      throw new ConflictException('The credit being reversed changed concurrently — please retry');
    }
  }

  /**
   * Positions of a (batch, outlet, field) — optionally on one wallet — oldest credit first. UNRESOLVED positions
   * (an unattributable credit that a backfill downgrade left on this exact key) are never drawn on — they are a
   * refusal reason (v2PointsReversalCap) — unless `includeUnresolved`.
   */
  private async findPositions(
    tx: Prisma.TransactionClient,
    key: CreditKey & { walletId?: string },
    opts: { includeUnresolved?: boolean } = {},
  ): Promise<ReversalPositionRow[]> {
    const rows = await tx.walletCreditPosition.findMany({
      where: {
        batchId: key.batchId,
        outletCode: key.outletCode,
        fieldId: key.fieldId,
        ...(key.walletId ? { walletId: key.walletId } : {}),
      },
      select: {
        id: true,
        walletId: true,
        creditTxId: true,
        lotId: true,
        amount: true,
        offsetPoints: true,
        reversedPoints: true,
        attribution: true,
        creditTx: { select: { seq: true, createdAt: true } },
      },
    });
    const kept = opts.includeUnresolved ? rows : rows.filter((p) => p.attribution !== CreditAttribution.UNRESOLVED);
    return [...kept].sort(byCreditOrder);
  }

  // ─── Reversal engine v2 (WP3 — WALLET-REVERSAL-ENGINE-DESIGN.md §6) ─────────────────────────

  /**
   * THE SAFETY GATE of the one-engine model (2026-11-21). A POINTS reversal (create AND approve) may only touch
   * SEQUENCED wallets. Every wallet that received this (batch, outlet, field)'s credit — per-credit metadata — and, when
   * `includeCurrentPartner` (no credit position exists), the outlet's current partner's wallet, is checked:
   *  - movementSeq > 0, or pristine (nothing to sequence) → fine;
   *  - BLOCKED by the backfill → WALLET_NEEDS_ATTENTION with the backfill's reason (Gifsy fixes the history);
   *  - history but not sequenced → WALLET_NOT_SEQUENCED naming the program and the outlet: Gifsy must run the wallet
   *    backfill for that program first.
   * Read-only; throws before anything is written (the caller's transaction rolls back), and the caller audits the
   * refusal (REVERSAL_ENGINE_REFUSAL → the attention banner lists it). Never a partial apply.
   */
  private async assertReceivingWalletsSequenced(
    tx: Prisma.TransactionClient,
    key: CreditKey,
    opts: { includeCurrentPartner?: boolean } = {},
  ): Promise<void> {
    const credits =
      (await tx.walletTransaction.findMany({
        where: {
          transactionType: 'CREDIT_POINTS_EARNED',
          referenceType: 'CREDIT_BATCH',
          referenceId: key.batchId,
          metadata: { path: ['outletCode'], equals: key.outletCode },
        },
        select: { walletId: true, metadata: true },
      })) ?? [];
    const ids = new Set<string>();
    for (const c of credits) {
      const m = c.metadata && typeof c.metadata === 'object' && !Array.isArray(c.metadata) ? (c.metadata as Record<string, unknown>) : null;
      if (m && m.outletCode === key.outletCode && m.fieldId === key.fieldId) ids.add(c.walletId);
    }
    if (opts.includeCurrentPartner) {
      const batch = await tx.creditBatch.findFirst({ where: { id: key.batchId }, select: { clientId: true } });
      const outlet = batch
        ? await tx.outlet.findFirst({ where: { clientId: batch.clientId, outletCode: key.outletCode }, select: { partnerId: true } })
        : null;
      const current = outlet?.partnerId
        ? await tx.wallet.findFirst({ where: { partnerId: outlet.partnerId }, select: { id: true } })
        : null;
      if (current) ids.add(current.id);
    }
    // Normally one or two wallets — read each (ascending id: a deterministic first refusal).
    for (const id of [...ids].sort()) {
      const w = await tx.wallet.findFirst({ where: { id } });
      if (!w || (w.movementSeq ?? 0) > 0) continue;
      if (!hasVisibleHistory(w) && (await this.isWalletPristine(tx, w))) continue;
      const partner = await tx.channelPartner.findFirst({ where: { id: w.partnerId }, select: { clientId: true } });
      const program = partner?.clientId ?? 'this program';
      if (w.backfillStatus === 'BLOCKED') {
        const reason = w.backfillBlockedReason ?? 'blocked by the wallet backfill';
        throw new ReversalAttentionException('WALLET_NEEDS_ATTENTION', walletNeedsAttentionMessage(key.outletCode, reason), {
          ...key,
          walletId: w.id,
          backfillStatus: 'BLOCKED',
          reason,
        });
      }
      throw new ReversalAttentionException('WALLET_NOT_SEQUENCED', walletNotSequencedMessage(key.outletCode, program), {
        ...key,
        walletId: w.id,
        program,
        backfillStatus: w.backfillStatus ?? null,
        reason: WALLET_NOT_YET_BACKFILLED_REASON,
      });
    }
  }

  /**
   * The v2 gate (read-only): the RESOLVED positions a POINTS reversal of (batch, outlet, field) would draw on and the
   * reversible cap Σ(amount − reversed). Refuses — always with the reason and what to do (owner rule: no silent
   * pass-throughs):
   *  - Q3 (owner 2026-11-16): an UNRESOLVED credit of the batch that could be THIS line's credit (recorded outlet /
   *    field don't exclude it, and the line isn't already fully identified by its resolved positions) → refuse ONLY
   *    this (batch, outlet, field) line — every other outlet of the batch stays reversible
   *    (ReversalAttentionException CREDIT_UNMAPPED, owner wording).
   *  - no position: the receiving wallet was BLOCKED / not processed by the backfill (Q1 — WALLET_NEEDS_ATTENTION
   *    with the wallet's reason), a pre-engine credit with no per-credit metadata (CREDIT_UNMAPPED), or nothing was
   *    credited at all (400 — settle off-platform).
   */
  async v2PointsReversalCap(
    tx: Prisma.TransactionClient,
    key: CreditKey,
    opts: { excludeReversalId?: string | null } = {},
  ): Promise<{ cap: number; positions: ReversalPositionRow[]; unallocatedApproved: number }> {
    // SAFETY GATE (engine retired 2026-11-21): a wallet that received this line's credit but whose history is not
    // sequenced is refused FIRST, loudly, before any figure is read — never a fall-back to "subtract from the balance".
    await this.assertReceivingWalletsSequenced(tx, key);
    const all = await this.findPositions(tx, key, { includeUnresolved: true });
    const positions = all.filter((p) => p.attribution !== CreditAttribution.UNRESOLVED);
    const unresolved = await tx.walletCreditPosition.findMany({
      where: { batchId: key.batchId, attribution: CreditAttribution.UNRESOLVED },
      select: { id: true, walletId: true, outletCode: true, fieldId: true, amount: true },
    });
    if (unresolved.length > 0) {
      const resolvedAmount = positions.reduce((s, p) => s + p.amount, 0);
      const exactKey = unresolved.some((u) => u.outletCode === key.outletCode && u.fieldId === key.fieldId);
      // The batch rows are read only when an unresolved credit is in play (normal path: no extra query).
      const lineAmount = exactKey
        ? null
        : batchLineAmount((await tx.creditBatch.findFirst({ where: { id: key.batchId }, select: { rows: true } }))?.rows, key);
      const blocking = unresolvedBlockingLine(unresolved, key, resolvedAmount, lineAmount);
      if (blocking.length > 0) {
        throw new ReversalAttentionException('CREDIT_UNMAPPED', creditUnmappedMessage(key.outletCode), {
          ...key,
          unresolvedPositionIds: blocking.map((u) => u.id),
          walletIds: [...new Set(blocking.map((u) => u.walletId))],
        });
      }
    }
    if (positions.length === 0) await this.explainNoPosition(tx, key);
    const unallocatedApproved = await this.unallocatedApprovedReversals(tx, key, opts.excludeReversalId ?? null);
    const cap = Math.max(0, positions.reduce((s, p) => s + (p.amount - p.reversedPoints), 0) - unallocatedApproved);
    return { cap, positions, unallocatedApproved };
  }

  /**
   * Fix round A, M3 — Σ approved points of APPROVED / PARTIAL POINTS reversals of this (batch, outlet, field) that have
   * NO allocation row, i.e. clawbacks whose amount is not reflected in any position's ρ_X (a LEGACY clawback approved
   * before the wallet was sequenced and not attributed by the backfill, or one the old log-only path skipped). The
   * V2 caps subtract it so the same credit can never be clawed back twice. Normally 0 (one indexed query).
   */
  private async unallocatedApprovedReversals(
    tx: Prisma.TransactionClient,
    key: CreditKey,
    excludeReversalId: string | null,
  ): Promise<number> {
    const rows = await tx.creditReversal.findMany({
      where: {
        // the reversal being applied right now (already flipped to APPROVED, allocations not yet written) is not "another"
        ...(excludeReversalId ? { id: { not: excludeReversalId } } : {}),
        batchId: key.batchId,
        outletId: key.outletCode,
        fieldId: key.fieldId,
        awardType: 'POINTS',
        status: { in: ['APPROVED', 'PARTIAL'] },
        creditAllocations: { none: {} },
      },
      select: { id: true, approvedPaise: true },
    });
    return rows.reduce((s, r) => s + Number(r.approvedPaise ?? 0n), 0);
  }

  /**
   * Error path only (v2PointsReversalCap found no position): ALWAYS throws, naming why. Finds the batch's credits for
   * the line (metadata match) or untracked legacy credits (no metadata), and the receiving wallets' backfill state.
   */
  private async explainNoPosition(tx: Prisma.TransactionClient, key: CreditKey): Promise<never> {
    // No position at all: the credit may sit on the outlet's CURRENT partner's wallet as an un-sequenced (pre-engine,
    // no per-credit metadata) row — if that wallet has history the backfill has not sequenced, say THAT (run the
    // backfill), not "unmapped".
    await this.assertReceivingWalletsSequenced(tx, key, { includeCurrentPartner: true });
    const credits = await tx.walletTransaction.findMany({
      where: { transactionType: 'CREDIT_POINTS_EARNED', referenceType: 'CREDIT_BATCH', referenceId: key.batchId },
      select: { walletId: true, metadata: true },
    });
    const meta = (m: Prisma.JsonValue | null | undefined) =>
      m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
    const line = credits.filter((c) => {
      const m = meta(c.metadata);
      return !!m && m.fieldId === key.fieldId && m.outletCode === key.outletCode;
    });
    const legacy = credits.filter((c) => {
      const m = meta(c.metadata);
      return !m || typeof m.fieldId !== 'string';
    });
    // The wallet(s) that received this line's credit: name the first one's backfill problem.
    for (const walletId of [...new Set(line.map((c) => c.walletId))].sort()) {
      const w = await tx.wallet.findFirst({
        where: { id: walletId },
        select: { id: true, movementSeq: true, backfillStatus: true, backfillBlockedReason: true },
      });
      if (!w || (w.movementSeq ?? 0) > 0) continue;
      const reason =
        w.backfillStatus === 'BLOCKED' ? w.backfillBlockedReason ?? 'blocked by the wallet backfill' : WALLET_NOT_YET_BACKFILLED_REASON;
      throw new ReversalAttentionException('WALLET_NEEDS_ATTENTION', walletNeedsAttentionMessage(key.outletCode, reason), {
        ...key,
        walletId: w.id,
        backfillStatus: w.backfillStatus ?? null,
        reason,
      });
    }
    if (line.length > 0 || legacy.length > 0) {
      // A credit exists but no position records it: an old credit without per-credit metadata (can't be told which
      // outlet it was) or a tracked wallet whose credit predates its position — Gifsy maps it.
      throw new ReversalAttentionException('CREDIT_UNMAPPED', creditUnmappedMessage(key.outletCode), {
        ...key,
        untrackedCredits: line.length + legacy.length,
      });
    }
    throw new BadRequestException(
      `Cannot reverse: no wallet received a credit from batch ${key.batchId} for outlet ${key.outletCode} / field ${key.fieldId} — settle it off-platform`,
    );
  }

  /**
   * Lock (ascending id — the §5 lock order) every wallet the positions live on, assert each is tracked, then lock
   * the positions and re-read them. Returns the locked positions + wallet states.
   */
  private async lockReversalTargets(
    tx: Prisma.TransactionClient,
    key: CreditKey,
    extraWalletIds: string[] = [],
    excludeReversalId: string | null = null,
  ): Promise<{
    positions: ReversalPositionRow[];
    states: Map<string, WalletState>;
    wallets: Map<string, Wallet>;
    unallocatedApproved: number;
  }> {
    // The pre-lock read only decides WHICH wallets to lock (§5 order). Its unallocatedApproved is NOT used: it was read
    // before a concurrent sibling reversal of the same credit committed, so it would still count that sibling as "never
    // attributed" while the positions re-read below (after the locks) already carry its ρ — the sibling counted twice
    // (WP7 F1, 2026-11-20). Both are re-read under the locks, in one consistent post-lock view.
    const { positions: unlocked } = await this.v2PointsReversalCap(tx, key, { excludeReversalId });
    const walletIds = [...new Set([...unlocked.map((p) => p.walletId), ...extraWalletIds])].sort();
    const wallets = new Map<string, Wallet>();
    const states = new Map<string, WalletState>();
    for (const id of walletIds) {
      const w = await this.lockWallet(tx, id);
      wallets.set(id, w);
      states.set(id, walletStateOf(w));
    }
    for (const p of unlocked) {
      if ((wallets.get(p.walletId)!.movementSeq ?? 0) <= 0) {
        // A position exists only on an initialised wallet; anything else is a broken backfill.
        throw new ConflictException(WALLET_STATE_INCONSISTENT_MESSAGE);
      }
    }
    await tx.$queryRaw`SELECT id FROM wallet_credit_positions WHERE "batchId" = ${key.batchId} AND "outletCode" = ${key.outletCode} AND "fieldId" = ${key.fieldId} ORDER BY id FOR UPDATE`;
    const positions = await this.findPositions(tx, key);
    if (positions.some((p) => !wallets.has(p.walletId))) {
      throw new ConflictException('The credits being reversed changed concurrently — please retry');
    }
    // Under the position locks: a sibling that applied first has committed its allocation rows AND its ρ together, so
    // it is counted once (in ρ); a sibling still waiting for these locks has no allocation yet and is counted as
    // unallocated (conservative — it will consume the credit when it applies).
    const unallocatedApproved = await this.unallocatedApprovedReversals(tx, key, excludeReversalId);
    return { positions, states, wallets, unallocatedApproved };
  }

  /** M3 room check: approved clawbacks of the line with no allocation row still count against the credit. */
  private assertRoomAfterUnallocated(positions: ReversalPositionRow[], unallocatedApproved: number, points: number): void {
    if (unallocatedApproved <= 0) return;
    const room = positions.reduce((s, p) => s + (p.amount - p.reversedPoints), 0) - unallocatedApproved;
    if (points > room) {
      throw new BadRequestException(
        `Reversal exceeds what is still reversible for this outlet and field in this batch (reversible ${Math.max(0, room)} pts after ${unallocatedApproved} pts of earlier approved reversals that were never attributed to the credit, requested ${points} pts)`,
      );
    }
  }

  /**
   * §6 — apply a POINTS reversal with the v2 engine. The CALLER holds the credit_batches row lock and has flipped
   * the CreditReversal PENDING_GIFSY → APPROVED/PARTIAL (guarded — never twice). For each position of the
   * (batch, outlet, field), oldest credit first: r_i = min(remaining, a − ρ); WP0 reverse() gives p (debt restored),
   * c (recovered from holdings) and s = r_i − p − c (owed); the RECEIVING wallet (Q4 — never the outlet's current
   * partner) is debited the WHOLE r_i and its debt grows by p + s (owner decision 2026-11-19: an over-reversal becomes
   * debt, repaid from future earnings — nothing is written off); c is drawn from the credit's OWN lot first, then FIFO
   * (Q7); O_X −= p, ρ_X += r_i; one CreditReversalAllocation per position (owed = s, overReversalDebt = s > 0,
   * shortfall 0; unique (reversal, position) → idempotent).
   */
  async applyCreditReversal(
    tx: Prisma.TransactionClient,
    a: CreditKey & {
      creditReversalId: string;
      points: number;
      description?: string | null;
      passbookLabel?: string | null;
      clientId?: string;
    },
  ): Promise<{
    shortfall: number;
    recovered: number;
    debtRestored: number;
    owed: number;
    alreadyExpired: number;
    debtExposed: number;
    /** how far below zero the reversal took the receiving wallet(s) — "points owed" (owner D1) added by it */
    balanceBelowZero: number;
    steps: PlannedReversalStep[];
    transactionIds: string[];
  }> {
    const locked = await this.lockReversalTargets(tx, a, [], a.creditReversalId);
    const { states, unallocatedApproved } = locked;
    const positions = await this.withExpiry(tx, locked.positions);
    this.assertRoomAfterUnallocated(positions, unallocatedApproved, a.points);
    const plan = planV2Reversal(positions, states, a.points);
    const transactionIds: string[] = [];
    const untracked: PlannedReversalStep[] = [];
    for (const st of plan) {
      const removed = st.debtRestored + st.alreadyExpired + st.recovered + st.owed;
      if (st.shortfall !== 0) throw new Error('applyCreditReversal: WP0 wrote points off (owner 2026-11-19: never)');
      // Owner decision 2 (2026-11-19): the partner's passbook row explains itself — what was reversed, what is owed.
      const desc = passbookReversalText(st, a.passbookLabel ?? null) ?? a.description ?? `Clawback: credit batch POINTS reversal`;
      // A6 (fix round 3): the stored points ARE the balance change (−(r − q)), so per-type ledger sums never count the
      // credit's already-expired points twice (they left with the expiry row). A reversal fully covered by expired
      // points (q = r) moves nothing → NO wallet row (no "−0" passbook line, no seq); the allocation (alreadyExpired = r)
      // and the approver's outcome ("… already expired — nothing to recover") carry it.
      const moved = st.pointsDelta !== 0;
      const written = !moved ? null : await this.writeTrackedMovement(tx, {
        walletId: st.position.walletId,
        before: st.before,
        after: st.after,
        pointsDelta: st.pointsDelta,
        counters: {},
        walletTxType: 'DEBIT_ADJUSTMENT',
        ledgerType: PointsLedgerType.ADJUST,
        points: st.pointsDelta,
        balanceType: 'REDEEMABLE',
        referenceType: 'CREDIT_REVERSAL',
        referenceId: a.creditReversalId,
        schemeId: null,
        expiresAt: null,
        description: desc,
        sourceType: 'CREDIT_FIELD',
        sourceId: a.fieldId,
        lotRemaining: 0,
        metadata: { reversedCreditTxId: st.position.creditTxId, positionId: st.position.id },
        reversedCreditTxId: st.position.creditTxId,
        creditReversalId: a.creditReversalId,
      });
      if (written) transactionIds.push(written.transactionId);
      if (st.recovered > 0) await this.consumeLots(tx, st.position.walletId, st.recovered, st.position.lotId);
      await this.updatePosition(tx, st);
      await tx.creditReversalAllocation.create({
        data: {
          creditReversalId: a.creditReversalId,
          positionId: st.position.id,
          requested: st.requested,
          debtRestored: st.debtRestored,
          recovered: st.recovered,
          owed: st.owed,
          overReversalDebt: st.owed > 0,
          alreadyExpired: st.alreadyExpired,
          debtExposed: st.debtExposed,
          engineSource: 'V2',
          shortfall: 0,
        },
      });
      if (st.position.expiryKnown === false && st.recovered + st.owed > 0) untracked.push(st);
      if (removed !== st.requested || st.requested - st.alreadyExpired !== -st.pointsDelta) {
        throw new Error('applyCreditReversal: p + q + c + owed ≠ r, or r − q ≠ −pointsDelta');
      }
    }
    if (untracked.length) {
      // Fix rounds 4–5 (A1): the credit's own lot can't be found (no credit lot of this wallet linked to it), so points
      // of it that EXPIRED can't be counted — what was taken or booked as debt for it may include them. Never silent:
      // ONE audit row per reversal (the banner counts reversals), listing every affected position.
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: REVERSAL_EXPIRY_UNTRACKED_ENTITY,
          entityId: a.creditReversalId,
          actorId: null,
          metadata: {
            clientId: a.clientId ?? null,
            walletId: untracked[0].position.walletId,
            batchId: a.batchId,
            outletCode: a.outletCode,
            owed: untracked.reduce((n, st) => n + st.owed, 0),
            recovered: untracked.reduce((n, st) => n + st.recovered, 0),
            positions: untracked.map((st) => ({
              positionId: st.position.id,
              walletId: st.position.walletId,
              creditTxId: st.position.creditTxId,
              owed: st.owed,
              recovered: st.recovered,
            })),
          } as Prisma.InputJsonValue,
        },
      });
    }
    return {
      shortfall: 0,
      recovered: plan.reduce((s, st) => s + st.recovered, 0),
      debtRestored: plan.reduce((s, st) => s + st.debtRestored, 0),
      owed: plan.reduce((s, st) => s + st.owed, 0),
      alreadyExpired: plan.reduce((s, st) => s + st.alreadyExpired, 0),
      debtExposed: plan.reduce((s, st) => s + st.debtExposed, 0),
      balanceBelowZero: belowZeroBy(plan),
      steps: plan,
      transactionIds,
    };
  }

  /**
   * An APPROVED credit-batch POINTS reversal — the ONE engine for every tenant (the per-tenant LEGACY / SHADOW modes
   * were retired 2026-11-21; an old `reversalEngine` settings row is ignored). applyCreditReversal: the RECEIVING
   * wallet(s) of the credit positions, oldest credit first; what the wallet no longer holds becomes debt, repaid from
   * future earnings (owner decision 2026-11-19 — nothing is written off). A wallet with points history that has not
   * been sequenced by the wallet backfill is REFUSED before anything is written (v2PointsReversalCap → the
   * WALLET_NOT_SEQUENCED gate) — never a fall-back to subtracting from the balance.
   * Returns the split for the approver's outcome summary: recovered (taken from the wallet), debtRestored (debt the
   * credit had repaid, back on the wallet), owed (booked as new debt), shortfall (always 0).
   * The caller holds the credit_batches lock and has flipped the CreditReversal status (guarded).
   */
  async reverseCreditBatchPoints(
    tx: Prisma.TransactionClient,
    a: CreditKey & {
      clientId: string;
      creditReversalId: string;
      points: number;
      actorId?: string | null;
      description?: string | null;
      /** passbook row label, e.g. "Volume · 2026-10" → "Credit reversed (Volume · 2026-10) −10,000 · …" */
      passbookLabel?: string | null;
    },
  ): Promise<{
    shortfall: number;
    recovered: number;
    debtRestored: number;
    owed: number;
    alreadyExpired: number;
    debtExposed: number;
    balanceBelowZero: number;
    walletIds: string[];
  }> {
    const description = a.description ?? `Clawback for reversal ${a.creditReversalId} — batch POINTS reversal`;
    const res = await this.applyCreditReversal(tx, { ...a, description });
    return {
      shortfall: res.shortfall,
      recovered: res.recovered,
      debtRestored: res.debtRestored,
      owed: res.owed,
      alreadyExpired: res.alreadyExpired,
      debtExposed: res.debtExposed,
      balanceBelowZero: res.balanceBelowZero,
      walletIds: [...new Set(res.steps.map((s) => s.position.walletId))],
    };
  }


  // ─── Expiry sweep ────────────────────────────────────────────────────────────

  /**
   * Expire due points. Finds SPENDABLE lots (EARN / REVERSE / credit-ADJUST) that are past
   * their expiresAt, still hold unspent `remainingPoints`, and are not yet expired. For each,
   * expires only the lot's REMAINING (unspent) points — never the lot's original amount — so
   * FIFO redemption of an older lot can never cause a newer lot's valid points to be destroyed.
   *
   * Per lot it: (1) claims the lot by flipping isExpired false→true (fencing it off from any
   * concurrent redeem FIFO-consume), (2) reads the now-frozen remainingPoints, (3) zeroes the
   * lot's remainingPoints and writes a DEBIT_EXPIRY / ledger EXPIRE movement for exactly that
   * amount (decrementing redeemablePoints, floored at 0; bumping expiredPoints + lifetimeExpired).
   *
   * Idempotent + concurrency-safe: the isExpired claim admits only one sweep; a fully-redeemed
   * lot (remainingPoints 0) is marked expired with no balance move and no EXPIRE row.
   *
   * @returns a summary of what was swept (counts + total points expired).
   */
  async expireDuePoints(opts: { now?: Date; limit?: number } = {}) {
    const now = opts.now ?? new Date();
    const take = opts.limit ?? 1000;

    const dueLots = await this.prisma.pointsLedger.findMany({
      where: {
        transactionType: {
          in: [
            PointsLedgerType.EARN,
            PointsLedgerType.REVERSE,
            PointsLedgerType.ADJUST,
          ],
        },
        isExpired: false,
        points: { gt: 0 },
        remainingPoints: { gt: 0 },
        expiresAt: { lte: now },
      },
      orderBy: { expiresAt: 'asc' },
      take,
    });

    if (dueLots.length === 0) {
      return { expiredLots: 0, expiredPoints: 0, failedLots: 0, failures: [] };
    }

    let expiredLots = 0;
    let totalExpired = 0;
    // Fix round A, M1: one lot's failure (any tenant) never stops the sweep — it is rolled back (its own tx), counted,
    // listed in the result, logged, and written as an audit row the tenant's attention endpoint / banner shows. The
    // lot stays due, so the next sweep retries it.
    const failures: { lotId: string; walletId: string; clientId: string | null; error: string }[] = [];

    for (const lot of dueLots) {
      try {
        await this.expireOneLot(lot, (e) => {
          expiredLots += 1;
          totalExpired += e;
        });
      } catch (err) {
        const error = (err as Error)?.message ?? String(err);
        const clientId = await this.prisma.wallet
          .findFirst({ where: { id: lot.walletId }, select: { partner: { select: { clientId: true } } } })
          .then((w) => w?.partner?.clientId ?? null)
          .catch(() => null);
        failures.push({ lotId: lot.id, walletId: lot.walletId, clientId, error });
        this.logger.error(`[expiry] lot ${lot.id} (wallet ${lot.walletId}, tenant ${clientId ?? '?'}) failed: ${error}`);
        await this.prisma.auditLog
          .create({
            data: {
              action: 'UPDATE',
              entityType: POINTS_EXPIRY_FAILURE_ENTITY,
              entityId: clientId ?? 'UNKNOWN_TENANT',
              actorId: null,
              metadata: { lotId: lot.id, walletId: lot.walletId, error, retried: 'next expiry sweep' } as Prisma.InputJsonValue,
            },
          })
          .catch((auditErr: unknown) =>
            this.logger.error(`[expiry] could not record the failure of lot ${lot.id}: ${(auditErr as Error)?.message}`),
          );
      }
    }

    return { expiredLots, expiredPoints: totalExpired, failedLots: failures.length, failures };
  }

  /** One due lot in its own transaction (see expireDuePoints). `onExpired(e)` is called when e > 0 points expired. */
  private async expireOneLot(
    lot: { id: string; walletId: string; schemeId: string | null },
    onExpired: (e: number) => void,
  ): Promise<void> {
    const expired = await this.prisma.$transaction(async (tx): Promise<number> => {
        // 0) LOCK THE WALLET ROW FIRST — before claiming the lot. A redeem locks the wallet
        //    (guarded scalar update) THEN its lots; by taking the wallet lock first the sweep
        //    acquires locks in the SAME order (wallet → lot), so the two can never deadlock.
        //    It also pins the scalar: nothing can change redeemablePoints between our read and
        //    our decrement below, so the floor is exact and the balance can never go negative.
        await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${lot.walletId} FOR UPDATE`;

        // 1) CLAIM the lot by flipping isExpired false→true. Makes re-runs concurrency-safe
        //    (a second sweep sees count 0 and skips) AND fences the lot from any concurrent
        //    redeem (consumeFifoLots only touches isExpired:false lots).
        const claim = await tx.pointsLedger.updateMany({
          where: { id: lot.id, isExpired: false },
          data: { isExpired: true },
        });
        if (claim.count === 0) return 0;

        // 2) Read the now-frozen remaining and the (locked) wallet.
        const fresh = await tx.pointsLedger.findUnique({ where: { id: lot.id } });
        const remaining = fresh?.remainingPoints ?? 0;
        if (remaining > 0) {
          // The lot is expired → zero its remaining regardless of how much is still backed.
          await tx.pointsLedger.update({ where: { id: lot.id }, data: { remainingPoints: 0 } });
        }
        const wallet = await tx.wallet.findFirst({ where: { id: lot.walletId } });
        if (!wallet) return 0;

        // v2 (tracked wallet, §7): same clamp; the excess that was covering debt is reclassified (D / O_X).
        // Same decision as movementPath (no tenant setting): sequenced, or pristine. An un-sequenced wallet with history
        // (any wallet holding a due lot) is decided from the read alone and takes the pre-engine path below.
        const tracked =
          (wallet.movementSeq ?? 0) > 0 || (!hasVisibleHistory(wallet) && (await this.isWalletPristine(tx, wallet)));
        if (tracked) {
          return this.expireTrackedLot(tx, wallet, lot, remaining);
        }

        // 3) Expire only what the locked scalar actually still backs for this lot — never
        //    more. Aligned wallet: remaining <= scalar → expire = remaining. Transiently
        //    drifted wallet (Σremaining > scalar from a concurrent-redeem race): clamp to the
        //    scalar so we neither go negative nor write a phantom EXPIRE row the balance can't
        //    back. applyMovement does NOT FIFO-consume on EXPIRE, so no other lot is touched.
        const expire = Math.min(remaining, wallet.redeemablePoints);
        if (expire <= 0) return 0; // fully redeemed before expiry — nothing to expire

        await this.applyMovement(tx, {
          wallet,
          walletTxType: 'DEBIT_EXPIRY',
          ledgerType: PointsLedgerType.EXPIRE,
          points: -expire,
          schemeId: lot.schemeId,
          referenceType: 'POINTS_LEDGER',
          referenceId: lot.id,
          sourceType: 'EXPIRY_SWEEP',
          sourceId: lot.id,
          description: 'Points expired',
        });
        return expire;
      });
    if (expired > 0) onExpired(expired);
  }

  // ─── Wallets in debt (audit item 9 + fix round 3 + owner decisions D1/D2, 2026-11-19) ─────────────────────────

  /**
   * Round 6 (items 2/4): "is ANY wallet of this tenant below zero?" — the cheap probe wallets-in-debt answers FIRST
   * and returns as `anyNegative`, so the screen stays quiet ONLY when the server said there is none. Raw SQL with a LITERAL
   * `< 0` so the planner can use the partial index wallets_negative_balance_idx (a bound parameter can defeat a partial
   * index under a generic plan).
   */
  async anyWalletBelowZero(clientId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ one: number }>>(
      Prisma.sql`SELECT 1 AS one FROM wallets w JOIN channel_partners cp ON cp.id = w."partnerId"
                 WHERE cp."clientId" = ${clientId} AND w."redeemablePoints" < 0 LIMIT 1`,
    );
    return (rows ?? []).length > 0;
  }

  /**
   * GET /v1/admin/credits/reversal-engine/wallets-in-debt — every wallet of the tenant whose balance is BELOW ZERO
   * (owner decision D1: "points owed" = how far below zero the balance is; a wallet at +60 owes nothing even with
   * internal debtPoints > 0, so it is not listed). Per wallet: outlet(s), balance, owedPoints, and the reversal(s)
   * behind its CURRENT negative stretch (approved after the last time its balance was ≥ 0): a V2 over-reversal, debt a
   * reversed credit had paid off, points taken that were covering earlier debt (A4), or a historical clawback — with
   * the outlet CODE from the credit position (A8) and the approval date. A negative wallet with no reversal behind it
   * says so ("from imported / earlier history"). `total`, `totalOwedPoints` come from full aggregates (B4) — never just
   * the rows returned; the list is capped at `limit` (≤ 5,000) and `truncated` says when it is cut.
   * Tenant-scoped by the caller's clientId (CLIENT_ADMIN reads are tenant-wide by design — tenant-scope.ts); the
   * optional `programName` applies the same program scope as the admin dashboards (partnerProgramScope).
   * Round 6: `anyNegative` = the tenant-wide probe answer, returned SEPARATELY so the screen is quiet ONLY when the
   * server said no wallet is below zero (a failed load is always loud).
   */
  async walletsInDebt(clientId: string, opts: { limit?: number; programName?: unknown } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
    const program = normalizeFilterParam(opts.programName, 'program');
    // Round 5 (B1): the cheap gate first — a tenant with no negative wallet (every Deoleo request) answers here.
    const anyNegative = await this.anyWalletBelowZero(clientId);
    if (!anyNegative && !program) {
      return { clientId, program, anyNegative, availablePrograms: [] as string[], total: 0, totalOwedPoints: 0, limit, truncated: false, wallets: [] };
    }
    const catalog = await loadProgramCatalog(this.prisma, clientId);
    const variants = program ? catalog.variantsOf(program) : null;
    const where: Prisma.WalletWhereInput = {
      partner: { clientId, ...partnerProgramScope(variants) },
      redeemablePoints: { lt: 0 },
    };
    // Rounds 5–6 (A2 / item 1): every read in ONE read-only REPEATABLE READ transaction (one snapshot), with explicit
    // timeouts sized for 5,000 wallets (Prisma's defaults — 5 s / 2 s — expire under load), and every heavy read CAPPED
    // to what the answer needs: only the listed wallets; per wallet only the max seq / time of its last row at or above
    // zero (an aggregate); reversal rows only AFTER that point; allocations only of those reversals.
    const snap = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const total = await tx.wallet.count({ where });
        const agg = await tx.wallet.aggregate({ where, _sum: { redeemablePoints: true } });
        const wallets = await tx.wallet.findMany({
          where,
          select: {
            id: true, partnerId: true, redeemablePoints: true, debtPoints: true, movementSeq: true,
            partner: { select: { businessName: true } },
          },
          orderBy: [{ redeemablePoints: 'asc' }, { id: 'asc' }],
          take: limit,
        });
        const walletIds = wallets.map((w) => w.id);
        if (walletIds.length === 0) {
          return { total, agg, wallets, outlets: [], allocations: [], lastNonNeg: [], reversalRows: [] };
        }
        const outlets = await tx.outlet.findMany({
          // B8: deleted outlets are not listed
          where: { clientId, partnerId: { in: wallets.map((w) => w.partnerId) }, deletedAt: null },
          select: { partnerId: true, outletCode: true },
        });
        // The last row that left each listed wallet at or above zero, by seq and by time — one aggregate.
        const lastNonNeg = await tx.walletTransaction.groupBy({
          by: ['walletId'],
          where: { walletId: { in: walletIds }, balanceAfter: { gte: 0 } },
          _max: { seq: true, createdAt: true },
        });
        const lastBy = new Map(lastNonNeg.map((g) => [g.walletId, g._max]));
        const seqOf = new Map(wallets.map((w) => [w.id, w.movementSeq ?? 0]));
        // Reversal rows ONLY after that point (seq on sequenced history, else time; no such row → all).
        const after: Prisma.WalletTransactionWhereInput[] = walletIds.map((id) => {
          const last = lastBy.get(id);
          if (last?.seq != null && (seqOf.get(id) ?? 0) > 0) return { walletId: id, seq: { gt: last.seq } };
          if (last?.createdAt) return { walletId: id, createdAt: { gt: last.createdAt } };
          return { walletId: id };
        });
        const reversalRows = await tx.walletTransaction.findMany({
          where: { creditReversalId: { not: null }, OR: after },
          select: { walletId: true, creditReversalId: true, seq: true, createdAt: true },
        });
        const reversalIds = [...new Set(reversalRows.map((r) => r.creditReversalId).filter((x): x is string => !!x))];
        const allocations = reversalIds.length
          ? await tx.creditReversalAllocation.findMany({
              where: {
                creditReversalId: { in: reversalIds },
                position: { walletId: { in: walletIds } },
                creditReversal: { clientId },
                OR: [{ owed: { gt: 0 } }, { debtRestored: { gt: 0 } }, { debtExposed: { gt: 0 } }],
              },
              select: {
                id: true,
                creditReversalId: true,
                owed: true,
                debtRestored: true,
                debtExposed: true,
                overReversalDebt: true,
                engineSource: true,
                position: { select: { walletId: true, outletCode: true } },
                creditReversal: { select: { approvedAt: true, fieldName: true, period: true } },
              },
            })
          : [];
        return { total, agg, wallets, outlets, allocations, lastNonNeg, reversalRows };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000, maxWait: 10_000 },
    );
    const { total, agg, wallets } = snap;
    const negSum = agg?._sum?.redeemablePoints ?? 0;
    type Alloc = (typeof snap.allocations)[number];
    type RevRow = { walletId: string; creditReversalId: string | null; seq: number | null; createdAt: Date };
    // A2: group every list by wallet ONCE (no wallets x rows loops).
    const outletsBy = new Map<string, string[]>();
    for (const o of snap.outlets as Array<{ partnerId: string | null; outletCode: string }>) {
      if (o.partnerId) outletsBy.set(o.partnerId, [...(outletsBy.get(o.partnerId) ?? []), o.outletCode]);
    }
    const allocBy = new Map<string, Alloc[]>();
    for (const a of snap.allocations as Alloc[]) allocBy.set(a.position.walletId, [...(allocBy.get(a.position.walletId) ?? []), a]);
    // The reversal rows were already read ONLY after each wallet's last row at or above zero → the current reversals.
    const currentBy = new Map<string, Set<string>>();
    for (const r of snap.reversalRows as RevRow[]) {
      if (!r.creditReversalId) continue;
      currentBy.set(r.walletId, (currentBy.get(r.walletId) ?? new Set<string>()).add(r.creditReversalId));
    }
    return {
      clientId,
      program,
      anyNegative,
      availablePrograms: catalog.available,
      total,
      totalOwedPoints: Math.max(0, -negSum),
      limit,
      truncated: total > wallets.length,
      wallets: wallets.map((w) => {
        const current = currentBy.get(w.id) ?? new Set<string>();
        const sources = (allocBy.get(w.id) ?? [])
          .filter((a) => current.has(a.creditReversalId))
          .map((a) => ({
            allocationId: a.id,
            creditReversalId: a.creditReversalId,
            kind:
              a.engineSource === 'BACKFILL' || (a.engineSource == null && a.owed > 0 && !a.overReversalDebt)
                ? 'HISTORICAL_CLAWBACK'
                : a.owed > 0
                  ? 'OVER_REVERSAL'
                  : a.debtRestored > 0
                    ? 'DEBT_RESTORED'
                    : 'DEBT_EXPOSED',
            owedPoints: a.owed,
            debtRestoredPoints: a.debtRestored,
            debtExposedPoints: a.debtExposed,
            approvedAt: a.creditReversal?.approvedAt ?? null,
            fieldName: a.creditReversal?.fieldName ?? null,
            period: a.creditReversal?.period ?? null,
            outletCode: a.position.outletCode ?? null,
          }))
          .sort((x, y) => (x.approvedAt?.getTime() ?? 0) - (y.approvedAt?.getTime() ?? 0));
        return {
          walletId: w.id,
          partnerId: w.partnerId,
          partnerName: w.partner?.businessName ?? null,
          outletCodes: [...(outletsBy.get(w.partnerId) ?? [])].sort(),
          balance: w.redeemablePoints,
          debtPoints: w.debtPoints,
          owedPoints: -w.redeemablePoints,
          sources,
          note: sources.length ? null : 'No reversal behind it — negative from imported / earlier history',
        };
      }),
    };
  }

  // ─── Reversal engine call-outs (policy round A — owner rule "no silent pass-throughs") ─────────────────────

  /**
   * Read-only per-tenant readiness (two counts): wallets with points history the wallet backfill has not sequenced
   * (each refuses POINTS reversals) and BLOCKED wallets. Feeds the attention banner (via reversalAttention) and the
   * daily ops digest. A tenant with no history at all (a fresh program, Deoleo today) is ready with nothing to do.
   */
  async reversalReadiness(clientId: string): Promise<ReversalReadiness> {
    const [unsequenced, blocked] = await Promise.all([
      this.prisma.wallet.count({ where: unsequencedWithHistoryWhere(clientId) }),
      this.prisma.wallet.count({ where: blockedWalletsWhere(clientId) }),
    ]);
    return readinessOf(unsequenced ?? 0, blocked ?? 0);
  }

  /**
   * Everything about the tenant's POINTS reversals that needs GIFSY to act, with reasons — feeds
   * GET /v1/admin/credits/reversal-engine/attention and the banner on the credits reversal screen:
   *  - `pause`: the Q5 maintenance pause (+ when / who);
   *  - `readiness`: how many wallets with points history are not sequenced yet (+ BLOCKED) — every tenant;
   *  - `wallets`: BLOCKED by the backfill (reason), and wallets with history the backfill has not sequenced yet (both
   *    keep today's earn/redeem rules; reversals on them are refused — Q1 / WALLET_NOT_SEQUENCED);
   *  - `unmappedCredits`: UNRESOLVED credit positions (reversals of their outlet line refused until mapped — Q3/Q5);
   *  - `owedClawbacks`: historical clawbacks that took more than the wallet held — "recovered X, owed Y" (Q4). A live V2
   *    over-reversal's debt (owner 2026-11-19, `overReversalDebt`) is the engine's normal outcome — said in the
   *    approver's outcome summary and the reversal report — not a Gifsy attention item, so it is not listed here.
   * Lists are capped at `limit` (default 200); the totals are exact.
   */
  async reversalAttention(clientId: string, opts: { limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const pause = await this.tenantSettings.getPointsReversalPauseUncached(clientId);

    const blockedWhere = blockedWalletsWhere(clientId);
    // Every tenant (the engine mode is retired): a wallet with un-sequenced history is a reversal blocker until the
    // wallet backfill sequences it — never the "normal state".
    const pendingWhere = unsequencedWithHistoryWhere(clientId);
    const walletSelect = {
      id: true,
      partnerId: true,
      backfillStatus: true,
      backfillBlockedReason: true,
      backfillCheckedAt: true,
      partner: { select: { businessName: true } },
    } as const;
    const [blockedTotal, blocked, pendingTotal, pending] = await Promise.all([
      this.prisma.wallet.count({ where: blockedWhere }),
      this.prisma.wallet.findMany({ where: blockedWhere, select: walletSelect, orderBy: { id: 'asc' }, take: limit }),
      this.prisma.wallet.count({ where: pendingWhere }),
      this.prisma.wallet.findMany({ where: pendingWhere, select: walletSelect, orderBy: { id: 'asc' }, take: limit }),
    ]);
    const listed = [...blocked, ...pending].slice(0, limit);
    const outlets = listed.length
      ? await this.prisma.outlet.findMany({
          where: { clientId, partnerId: { in: listed.map((w) => w.partnerId) } },
          select: { partnerId: true, outletCode: true },
        })
      : [];
    const codesOf = (partnerId: string) =>
      outlets.filter((o) => o.partnerId === partnerId).map((o) => o.outletCode).sort();
    const wallets = listed.map((w) => ({
      walletId: w.id,
      partnerId: w.partnerId,
      partnerName: w.partner?.businessName ?? null,
      outletCodes: codesOf(w.partnerId),
      status: w.backfillStatus === 'BLOCKED' ? ('BLOCKED' as const) : ('NOT_BACKFILLED' as const),
      reason: w.backfillStatus === 'BLOCKED' ? w.backfillBlockedReason ?? 'blocked by the wallet backfill' : WALLET_NOT_YET_BACKFILLED_REASON,
      checkedAt: w.backfillCheckedAt ?? null,
      action:
        w.backfillStatus === 'BLOCKED'
          ? 'Earning and redeeming keep working on today\'s rules; points reversals on this wallet are refused. Gifsy: fix the wallet history, then re-run the wallet backfill.'
          : 'Earning and redeeming keep working on today\'s rules; points reversals on this wallet are refused. Gifsy: run the wallet backfill for this program.',
    }));

    const unmappedWhere: Prisma.WalletCreditPositionWhereInput = {
      attribution: CreditAttribution.UNRESOLVED,
      wallet: { partner: { clientId } },
    };
    const [unmappedTotal, unmapped] = await Promise.all([
      this.prisma.walletCreditPosition.count({ where: unmappedWhere }),
      this.prisma.walletCreditPosition.findMany({
        where: unmappedWhere,
        select: { id: true, walletId: true, creditTxId: true, batchId: true, outletCode: true, fieldId: true, amount: true, reversedPoints: true },
        orderBy: [{ batchId: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
    ]);
    const owedWhere: Prisma.CreditReversalAllocationWhereInput = {
      owed: { gt: 0 },
      overReversalDebt: false,
      creditReversal: { clientId },
    };
    const [owedTotal, owed] = await Promise.all([
      this.prisma.creditReversalAllocation.count({ where: owedWhere }),
      this.prisma.creditReversalAllocation.findMany({
        where: owedWhere,
        select: {
          creditReversalId: true, requested: true, debtRestored: true, recovered: true, owed: true, shortfall: true,
          position: { select: { walletId: true, batchId: true, outletCode: true, fieldId: true } },
        },
        orderBy: { creditReversalId: 'asc' },
        take: limit,
      }),
    ]);

    const since = new Date(Date.now() - ATTENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const expiryWhere: Prisma.AuditLogWhereInput = {
      entityType: POINTS_EXPIRY_FAILURE_ENTITY,
      entityId: clientId,
      createdAt: { gte: since },
    };
    const refusalWhere: Prisma.AuditLogWhereInput = {
      entityType: 'REVERSAL_ENGINE_REFUSAL',
      createdAt: { gte: since },
      metadata: { path: ['clientId'], equals: clientId },
      NOT: { metadata: { path: ['code'], equals: 'APPROVALS_PAUSED' } }, // the pause has its own line
    };
    const auditSelect = { createdAt: true, entityId: true, metadata: true } as const;
    const [expiryFailuresTotal, expiryFailures, refusalsTotal, refusals] = await Promise.all([
      this.prisma.auditLog.count({ where: expiryWhere }),
      this.prisma.auditLog.findMany({ where: expiryWhere, select: auditSelect, orderBy: { createdAt: 'desc' }, take: limit }),
      this.prisma.auditLog.count({ where: refusalWhere }),
      this.prisma.auditLog.findMany({ where: refusalWhere, select: auditSelect, orderBy: { createdAt: 'desc' }, take: limit }),
    ]);

    // Audit B8: expiries whose debt repayment could not all be booked on the credit's position (last 30 days).
    const cappedWhere: Prisma.AuditLogWhereInput = {
      entityType: POINTS_EXPIRY_OFFSET_CAPPED_ENTITY,
      createdAt: { gte: since },
      metadata: { path: ['clientId'], equals: clientId },
    };
    const [cappedTotal, capped] = await Promise.all([
      this.prisma.auditLog.count({ where: cappedWhere }),
      this.prisma.auditLog.findMany({ where: cappedWhere, select: auditSelect, orderBy: { createdAt: 'desc' }, take: limit }),
    ]);
    // Fix round 3: V2 reversals that booked debt on a credit whose expiry history isn't linked (last 30 days).
    const untrackedWhere: Prisma.AuditLogWhereInput = {
      entityType: REVERSAL_EXPIRY_UNTRACKED_ENTITY,
      createdAt: { gte: since },
      metadata: { path: ['clientId'], equals: clientId },
    };
    const [untrackedTotal, untracked] = await Promise.all([
      this.prisma.auditLog.count({ where: untrackedWhere }),
      this.prisma.auditLog.findMany({ where: untrackedWhere, select: auditSelect, orderBy: { createdAt: 'desc' }, take: limit }),
    ]);
    return {
      clientId,
      readiness: readinessOf(pendingTotal ?? 0, blockedTotal ?? 0),
      pause,
      wallets,
      walletsTotal: blockedTotal + pendingTotal,
      walletsBlocked: blockedTotal,
      walletsNotBackfilled: pendingTotal,
      unmappedCredits: unmapped.map((p) => ({
        positionId: p.id,
        walletId: p.walletId,
        creditTxId: p.creditTxId,
        batchId: p.batchId,
        outletCode: p.outletCode,
        fieldId: p.fieldId,
        amount: p.amount,
        reason: p.outletCode
          ? `the credit of batch ${p.batchId} to outlet ${p.outletCode} could not be matched to its line (an approved reversal of it could not be attributed)`
          : `a credit of ${p.amount} pts in batch ${p.batchId} could not be matched to an outlet${p.fieldId ? '' : ' and field'}`,
        action: 'Reversals of the outlet line this credit could belong to are refused. Gifsy: map it to its outlet and field.',
      })),
      unmappedTotal,
      owedClawbacks: owed.map((a) => ({
        creditReversalId: a.creditReversalId,
        walletId: a.position.walletId,
        batchId: a.position.batchId,
        outletCode: a.position.outletCode,
        fieldId: a.position.fieldId,
        requested: a.requested,
        debtRestored: a.debtRestored,
        recovered: a.recovered,
        owed: a.owed,
        shortfall: a.shortfall,
        label: `recovered ${a.recovered}, owed ${a.owed}`,
      })),
      owedTotal,
      // M1: expiry-sweep lots that FAILED for this tenant in the last 30 days (each is retried by the next sweep).
      expiryFailures: expiryFailures.map((f) => {
        const m = (f.metadata ?? {}) as Record<string, unknown>;
        return {
          at: f.createdAt,
          lotId: typeof m.lotId === 'string' ? m.lotId : null,
          walletId: typeof m.walletId === 'string' ? m.walletId : null,
          error: typeof m.error === 'string' ? m.error : null,
          action: 'The lot stays due and is retried by the next expiry sweep. Gifsy: if it keeps failing, investigate the wallet.',
        };
      }),
      expiryFailuresTotal,
      expiryOffsetCapped: (capped ?? []).map((c) => {
        const m = (c.metadata ?? {}) as Record<string, unknown>;
        return {
          at: c.createdAt,
          walletId: typeof m.walletId === 'string' ? m.walletId : c.entityId,
          lotId: typeof m.lotId === 'string' ? m.lotId : null,
          batchId: typeof m.batchId === 'string' ? m.batchId : null,
          outletCode: typeof m.outletCode === 'string' ? m.outletCode : null,
          offsetNotRecorded: typeof m.offsetNotRecorded === 'number' ? m.offsetNotRecorded : null,
          action:
            "The wallet's debt was repaid in full, but this credit's record of it is short by the amount shown — a later " +
            'reversal of that credit restores that much less debt. Gifsy: check the wallet history (legacy lot drift).',
        };
      }),
      expiryOffsetCappedTotal: cappedTotal ?? 0,
      expiryUntracked: (untracked ?? []).map((u) => {
        const m = (u.metadata ?? {}) as Record<string, unknown>;
        return {
          at: u.createdAt,
          creditReversalId: u.entityId,
          walletId: typeof m.walletId === 'string' ? m.walletId : null,
          // round 6 (item 5): a reversal can span wallets — every affected wallet, not only the first
          walletIds: [
            ...new Set(
              (Array.isArray(m.positions) ? (m.positions as Array<{ walletId?: unknown }>) : [])
                .map((x) => (typeof x.walletId === 'string' ? x.walletId : null))
                .filter((x): x is string => !!x)
                .concat(typeof m.walletId === 'string' ? [m.walletId] : []),
            ),
          ].sort(),
          outletCode: typeof m.outletCode === 'string' ? m.outletCode : null,
          owed: typeof m.owed === 'number' ? m.owed : null,
          recovered: typeof m.recovered === 'number' ? m.recovered : null,
          action:
            "This credit's own points can't be linked to its expiry history, so points of it that had EXPIRED may have " +
            'been taken from the wallet again or booked as debt. Gifsy: check the wallet history; correct the balance by ' +
            'an adjustment if part of it had expired.',
        };
      }),
      expiryUntrackedTotal: untrackedTotal ?? 0,
      // M3 (+ every other Gifsy-must-act refusal): POINTS reversals refused in the last 30 days, with the reason.
      refusals: refusals.map((r) => {
        const m = (r.metadata ?? {}) as Record<string, unknown>;
        return {
          at: r.createdAt,
          entityId: r.entityId,
          phase: typeof m.phase === 'string' ? m.phase : null,
          code: typeof m.code === 'string' ? m.code : null,
          message: typeof m.message === 'string' ? m.message : null,
          outletCode: typeof m.outletCode === 'string' ? m.outletCode : typeof m.outletId === 'string' ? m.outletId : null,
          batchId: typeof m.batchId === 'string' ? m.batchId : null,
          reason: typeof m.reason === 'string' ? m.reason : null,
        };
      }),
      refusalsTotal,
    };
  }

  /**
   * GIFSY: turn the Q5 "POINTS reversal approvals paused" switch on / off by hand (the backfill job does it itself
   * for its APPLY window; this lifts a pause a crashed run left on, or holds one across a flag flip). Audited.
   */
  async setPointsReversalPause(
    actor: { sub: string; clientId: string; role?: string; assumed?: boolean },
    a: { paused: boolean; reason?: string | null; clientId?: string | null },
  ) {
    // L6 (fix round A): the tenant is the one being worked in (assumed) or an explicit clientId — never, silently,
    // an un-assumed Gifsy user's own home tenant.
    const clientId = await this.resolveEngineAdminTenant(actor, a.clientId);
    const before = await this.tenantSettings.getPointsReversalPauseUncached(clientId);
    const value = a.paused
      ? { paused: true, since: new Date().toISOString(), by: actor.sub, reason: a.reason?.trim() || 'paused by Gifsy' }
      : { paused: false, clearedAt: new Date().toISOString(), by: actor.sub, reason: a.reason?.trim() || null };
    await this.prisma.$transaction(async (tx) => {
      await tx.programSetting.upsert({
        where: { clientId_settingKey: { clientId, settingKey: POINTS_REVERSAL_PAUSE_SETTING_KEY } },
        create: {
          clientId,
          settingKey: POINTS_REVERSAL_PAUSE_SETTING_KEY,
          settingValue: value,
          category: 'reversal-engine',
          description: 'POINTS reversal create/approve paused (wallet maintenance) — WALLET-REVERSAL-ENGINE-DESIGN.md §9.1',
          updatedById: actor.sub,
        },
        update: { settingValue: value, updatedById: actor.sub },
      });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'POINTS_REVERSAL_PAUSE',
          entityId: clientId,
          actorId: actor.sub,
          oldValues: before as unknown as Prisma.InputJsonValue,
          newValues: value as Prisma.InputJsonValue,
        },
      });
    });
    this.tenantSettings.invalidate(clientId);
    return { clientId, ...(await this.tenantSettings.getPointsReversalPauseUncached(clientId)) };
  }

  /**
   * L6 (fix round A) — the tenant a GIFSY reversal-engine admin action (pause, engine mode) targets:
   *  - working inside a tenant (assume-tenant token, `assumed`): that tenant; an explicit clientId must match it;
   *  - NOT working inside a tenant (an un-assumed Gifsy session, whose clientId is Gifsy's own home tenant): an
   *    explicit clientId is REQUIRED and must exist — never a silent write to the home tenant.
   * Non-Gifsy callers (defence in depth — the endpoints are GIFSY_ADMIN-only) act on their own tenant only.
   */
  async resolveEngineAdminTenant(
    actor: { clientId: string; role?: string; assumed?: boolean },
    explicit?: string | null,
  ): Promise<string> {
    const wanted = explicit?.trim() || null;
    const gifsy = actor.role === 'GIFSY_ADMIN' || actor.role === 'GIFSY_STAFF';
    if (!gifsy || actor.assumed) {
      if (wanted && wanted !== actor.clientId) {
        throw new BadRequestException(
          `You are working in ${actor.clientId}; this action can only target that program (asked for ${wanted}).`,
        );
      }
      return actor.clientId;
    }
    if (!wanted) {
      throw new BadRequestException(
        'Choose the program: you are not working inside a client program — switch to it ("Work in <brand>") or pass its clientId explicitly. Nothing was changed.',
      );
    }
    const client = await this.prisma.client.findFirst({ where: { id: wanted }, select: { id: true } });
    if (!client) throw new NotFoundException(`No client program "${wanted}" — nothing was changed`);
    return client.id;
  }

  private getDefaultDescription(transactionType: string): string {
    // Shared with the statement builder so the passbook and statement can't drift.
    return defaultTxDescription(transactionType);
  }
}
