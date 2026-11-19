import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreditAttribution, Prisma, PointsLedgerType, Wallet, WalletTransactionType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  InvalidReversalEngineSettingException,
  isReversalEngineMode,
  POINTS_REVERSAL_PAUSE_SETTING_KEY,
  REVERSAL_ENGINE_MODES,
  REVERSAL_ENGINE_SETTING_KEY,
  ReversalEngineMode,
  reversalEngineInvalidWarning,
  SettingsReader,
  TenantSettingsService,
} from '../tenant/tenant-settings.service';
import {
  batchLineAmount,
  creditUnmappedMessage,
  pointsReversalLockKey,
  ReversalAttentionException,
  unresolvedBlockingLine,
  WALLET_NOT_YET_BACKFILLED_REASON,
  walletNeedsAttentionMessage,
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

/** Interim rule (WALLET-REVERSAL-ENGINE-DESIGN.md Q14): no POINTS reversal on a wallet with debt. */
export const DEBT_REVERSAL_PAUSED_MESSAGE =
  'This wallet carries debt; reversals on it are paused until the new reversal engine is live — contact Gifsy';

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
  /**
   * The wallet's tenant reversal-engine mode, when the CALLER already resolved it for this wallet's tenant
   * (e.g. confirmBatch: once per batch). Lets movementPath skip its per-movement partner + flag reads.
   * Omitted → movementPath resolves it itself (unchanged behaviour).
   */
  engineMode?: ReversalEngineMode;
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
 * H), shortfall = r_i − p − c). `states` is updated in place so two positions on one wallet chain correctly.
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
      [pos.id]: { id: pos.id, amount: pos.amount, offset: pos.offsetPoints, reversed: pos.reversedPoints, lotRemaining: 0 },
    });
    let step: Step;
    try {
      step = modelReverse(m, pos.id, ri);
    } catch (e) {
      if (e instanceof ReversalModelError) throw new BadRequestException(e.message);
      throw e;
    }
    const after = step.model.state;
    states.set(pos.walletId, after);
    steps.push({
      position: pos,
      requested: ri,
      before,
      after,
      pointsDelta: step.movement.pointsDelta,
      debtRestored: step.movement.debtRestored,
      recovered: step.movement.recovered,
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

/** A legacy-era wallet read shows history (any balance / counter ≠ 0) → it can never be pristine again. */
function hasVisibleHistory(w: Partial<Wallet>): boolean {
  return [
    w.redeemablePoints, w.debtPoints, w.earnedPoints, w.lockedPoints, w.redeemedPoints, w.expiredPoints,
    w.lifetimeEarned, w.lifetimeRedeemed, w.lifetimeExpired,
  ].some((n) => typeof n === 'number' && n !== 0);
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
/** Audit entityType of an expiry that only repaid debt (no balance change, no passbook row — fix round A, L1). */
export const POINTS_EXPIRY_DEBT_ONLY_ENTITY = 'POINTS_EXPIRY_DEBT_REPAID';
/** Audit entityType of a reversal-engine mode change via the dedicated GIFSY endpoint (fix round A, M2). */
export const REVERSAL_ENGINE_MODE_ENTITY = 'REVERSAL_ENGINE_MODE';

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
   */
  private async applyMovement(
    tx: Prisma.TransactionClient,
    params: MovementParams,
  ): Promise<{ transactionId: string; newRedeemable: number; ledgerId: string }> {
    // Fix round A, L5 — the pre-engine path, EXACTLY: an un-sequenced wallet (movementSeq 0 in the caller's read) that
    // is either on a tenant the caller KNOWS is LEGACY, or visibly has history (so movementPath's rule 2 or 3 answers
    // LEGACY whatever the flag says), takes today's write path with NO extra row lock, partner read or flag read —
    // the same statements as origin/main (Deoleo stays LEGACY with no backfill: every movement lands here). The one
    // difference is inside today's own wallet UPDATE: `AND movementSeq = 0` in its WHERE (atomic in the single UPDATE
    // statement). If a backfill sequenced the wallet after the caller's read, that UPDATE matches nothing → nothing was
    // written → fall through to the locked path below (never an un-sequenced row on a sequenced wallet).
    if (this.legacyFastPath(params.wallet, params.engineMode)) {
      const fast = await this.applyMovementLegacy(tx, params, { unsequencedGuard: true });
      if (fast) return fast;
    }
    // v2 step 1 (WALLET-REVERSAL-ENGINE-DESIGN.md §5): LOCK the wallet row first, then read B / D / movementSeq.
    // Callers that already locked (expiry sweep, clawback) re-acquire their own lock — a no-op in Postgres.
    const wallet = await this.lockWallet(tx, params.wallet.id);
    if ((await this.movementPath(tx, wallet, params.engineMode)) === 'LEGACY') {
      // LEGACY tenant on a never-sequenced wallet: today's write path, unchanged (no seq / D / positions).
      const res = await this.applyMovementLegacy(tx, { ...params, wallet });
      if (!res) throw new Error('applyMovementLegacy: unguarded write returned nothing');
      return res;
    }
    return this.applyMovementV2(tx, wallet, params);
  }

  /**
   * L5 fast-path decision — PURE, no I/O (see applyMovement). True only when the caller's wallet read carries
   * `movementSeq === 0` (a partial read → false → the locked path decides) and either the tenant is known LEGACY or
   * the read shows history (rule 3: a SHADOW/V2 tenant's un-backfilled wallet keeps today's rules). A wallet that
   * looks pristine on an unknown-mode request takes the locked path, which reads the flag once (its first movement
   * may need to be sequenced from seq 1 on a SHADOW/V2 tenant).
   */
  private legacyFastPath(w: MovementParams['wallet'], knownMode?: ReversalEngineMode): boolean {
    if (w.movementSeq !== 0) return false;
    if (knownMode === 'LEGACY') return true;
    if (!hasVisibleHistory(w)) return false;
    if (knownMode !== undefined) this.warnUnbackfilledMovement(w, knownMode);
    return true;
  }

  private warnUnbackfilledMovement(w: Partial<Wallet> & { id: string }, mode: ReversalEngineMode): void {
    this.logger.warn(
      `[reversal-engine] wallet ${w.id} (${mode} tenant) is not backfilled (${w.backfillStatus === 'BLOCKED' ? `BLOCKED: ${w.backfillBlockedReason ?? '?'}` : 'not yet processed'}) — movement takes the LEGACY path; reversals on it are refused until Gifsy fixes it`,
    );
  }

  /**
   * The tenant's reversal-engine mode for NORMAL points activity — earn, redeem, refund, adjust, expiry, batch
   * confirm (fix round A, M1). A malformed stored value must never stop that activity: it is treated as LEGACY
   * (today's rules — the safe default), logged, and reported LOUDLY by the attention endpoint / banner
   * (`modeWarning`). POINTS reversal create / approve keep the strict read and fail closed. A DB read error still
   * propagates (the caller's transaction fails as it would on any read error).
   */
  async movementEngineMode(
    clientId: string,
    db: SettingsReader = this.prisma,
  ): Promise<{ mode: ReversalEngineMode; invalid?: unknown }> {
    try {
      return { mode: await this.tenantSettings.getReversalEngineModeUncached(clientId, db) };
    } catch (e) {
      if (!(e instanceof InvalidReversalEngineSettingException)) throw e;
      this.logger.warn(`[reversal-engine] tenant ${clientId}: ${reversalEngineInvalidWarning(e.value)}`);
      return { mode: 'LEGACY', invalid: e.value };
    }
  }

  /**
   * Which write path a movement on this (locked) wallet takes — the WP2 rollout guard:
   *  1. movementSeq > 0 → 'V2' state maintenance, whatever the tenant flag. The wallet's history is already
   *     sequenced (WP6 backfill APPLY, or a tenant that ran SHADOW/V2); writing an un-sequenced row now would
   *     create a mixed history. B-neutral: balances/counters are those of the legacy path (D only moves where the
   *     backfill recorded debt). This also covers the window between a tenant's backfill APPLY and its flag flip,
   *     and a later V2 → LEGACY rollback.
   *  2. movementSeq = 0 and tenant flag LEGACY (the default — Deoleo, Bajaj today) → 'LEGACY': byte-identical
   *     to the pre-engine code, no v2 column or table is written.
   *  3. movementSeq = 0 and tenant SHADOW / V2 → 'V2' only for a pristine wallet (no row, every figure 0 — nothing
   *     for the backfill to sequence). A wallet WITH un-sequenced history (the backfill BLOCKED it — history doesn't
   *     add up, opening balance without a row, out-of-order rows, missing expiry rows on a once-negative wallet — or
   *     has not processed it yet) keeps TODAY's rules: 'LEGACY' for earn, redeem and expiry (owner Q1 2026-11-16;
   *     never a mixed history, never a blocked earn/redeem). Only POINTS reversals on it are refused, by
   *     v2PointsReversalCap (no position) with the wallet's reason; it is listed by reversalAttention().
   * Call under the wallet row lock (the backfill takes the same lock).
   * `knownMode`: the tenant's mode, already resolved by a caller that KNOWS this wallet's tenant (confirmBatch
   * resolves it once per batch) — skips the per-movement partner + flag reads; the decision is otherwise identical.
   * The flag is read through the caller's `tx` (never a second pool connection while the wallet lock is held).
   */
  async movementPath(
    tx: Prisma.TransactionClient,
    w: Pick<Wallet, 'id' | 'partnerId' | 'redeemablePoints'> & Partial<Wallet>,
    knownMode?: ReversalEngineMode,
  ): Promise<'LEGACY' | 'V2'> {
    if ((w.movementSeq ?? 0) > 0) return 'V2';
    let mode = knownMode;
    if (mode === undefined) {
      const partner = await tx.channelPartner.findFirst({ where: { id: w.partnerId }, select: { clientId: true } });
      if (!partner) throw new NotFoundException('Wallet owner not found');
      // M1: a malformed flag never blocks a movement — LEGACY (logged; attention banner says so).
      mode = (await this.movementEngineMode(partner.clientId, tx)).mode;
    }
    if (mode === 'LEGACY') return 'LEGACY';
    if (await this.isWalletPristine(tx, w)) return 'V2';
    this.warnUnbackfilledMovement(w, mode);
    return 'LEGACY';
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
   * The LEGACY write path (pre-engine, byte-identical to the code before WP2). Used for every wallet the WP6
   * backfill has not initialised yet, on a LEGACY tenant (see movementPath). Never writes seq / pointsDelta / D / positions.
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
      // The tenant's reversal-engine mode, resolved ONCE by a bulk caller (confirmBatch) for `clientId` — the
      // caller guarantees the partner belongs to that tenant. Saves movementPath's 2 reads per credit.
      reversalEngineMode?: ReversalEngineMode;
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
        ...(opts.reversalEngineMode !== undefined ? { engineMode: opts.reversalEngineMode } : {}),
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
   * Clawback previously-earned points on a credit-batch POINTS reversal (#16).
   * Writes DEBIT_ADJUSTMENT (WalletTransaction) + ADJUST (PointsLedger), inside the
   * supplied transaction so it is atomic with the reversal status update.
   *
   * INTERIM RULE (owner decision Q14, WALLET-REVERSAL-ENGINE-DESIGN.md — until the reversal engine
   * v2 is live): reversals are only executed on wallets WITHOUT debt.
   *  - The wallet row is locked (FOR UPDATE) and re-read first.
   *  - REFUSED (409, DEBT_REVERSAL_PAUSED_MESSAGE) when the wallet balance is negative, or when the
   *    reversed credit landed on a negative balance (its balanceBefore < 0).
   *  - REFUSED (400) when `originalCredit` is given and this wallet never received that credit, or
   *    the credit can't be attributed safely (see findOriginalBatchCredit) — never debit a wallet
   *    that didn't receive it.
   *  - Otherwise: redeemablePoints decremented by min(points, redeemablePoints) — floored at 0
   *    (the historical rule, byte-identical for every non-negative wallet, i.e. all of Deoleo).
   *    If the partner already redeemed part of the award the remainder is the shortfall, recorded
   *    in the ledger description for owner review (settled off-platform).
   *  - earnedPoints / lifetimeEarned / lifetimeRedeemed / lifetimeExpired: UNTOUCHED (monotonic).
   *
   * ⚠️  OWNER REVIEW FLAG — partial-redemption shortfall:
   *   When redeemablePoints < points only the available part is removed from the balance,
   *   but the PointsLedger/WalletTransaction row still records the FULL `-points` (with the
   *   `shortfall` appended to the description, so it is visible in the passbook). That is
   *   deliberate — it records the client's full reversal of points the partner had already
   *   spent — but it means the ledger row intentionally debits more than the scalar moved
   *   (the authoritative balance is always wallet.redeemablePoints).
   */
  async clawbackAward(
    partnerId: string,
    points: number,
    opts: {
      referenceType?: string | null;
      referenceId?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
      description?: string | null;
      // The ORIGINAL credit-batch credit being reversed: the batch id + the reversal's
      // (outletCode, fieldId). Used to refuse a clawback on a wallet that never received it and
      // one whose credit landed on a negative balance (interim rule).
      originalCredit?: { batchId: string; outletCode: string; fieldId: string } | null;
    } = {},
    tx: Prisma.TransactionClient,
  ): Promise<{ transactionId: string; newRedeemable: number; ledgerId: string; shortfall: number }> {
    if (points <= 0) throw new BadRequestException('Clawback amount must be positive');

    const found = await tx.wallet.findFirst({ where: { partnerId }, select: { id: true } });
    if (!found) throw new NotFoundException('Wallet not found for this partner');
    // LOCK THE WALLET ROW for the rest of the caller's transaction (same as expireDuePoints), then
    // re-read it: two concurrent clawbacks / a clawback racing a redemption serialise here, so the
    // decrement + shortfall below are computed from the balance the decrement actually applies to
    // and the recorded balanceBefore/After chain stays exact.
    await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${found.id} FOR UPDATE`;
    const wallet = await tx.wallet.findFirst({ where: { id: found.id } });
    if (!wallet) throw new NotFoundException('Wallet not found for this partner');

    let reversedCreditTxId: string | null = null;
    if (opts.originalCredit) {
      const credit = await this.requireReversibleCredit(tx, wallet.id, partnerId, opts.originalCredit);
      reversedCreditTxId = credit.id;
    }
    if (wallet.redeemablePoints < 0) throw new ConflictException(DEBT_REVERSAL_PAUSED_MESSAGE);
    // Q14 "carries debt" also covers recorded debt D (> 0 only once the WP6 backfill / v2 engine has run on this
    // wallet — always 0 today, so this adds no refusal to any existing wallet).
    if ((wallet.debtPoints ?? 0) > 0) throw new ConflictException(DEBT_REVERSAL_PAUSED_MESSAGE);

    // Tracked wallet (§5): the reversed credit's positions, so the LEGACY clawback keeps ρ_X + allocations in
    // step (B-neutral). A position that paid off debt (O_X > 0) is a "credit landed on debt" case → paused (Q14).
    // Tracked = sequenced (movementSeq > 0). Read from the locked row — no flag / partner read (fix round A, L5: a
    // pristine wallet has no credit, so requireReversibleCredit above already refused it).
    const tracked = (wallet.movementSeq ?? 0) > 0;
    const creditReversalId = opts.referenceType === 'CREDIT_REVERSAL' ? opts.referenceId ?? null : null;
    let positions: ReversalPositionRow[] = [];
    if (tracked && opts.originalCredit) {
      positions = await this.findPositions(tx, { ...opts.originalCredit, walletId: wallet.id });
      if (positions.some((p) => p.offsetPoints > 0)) throw new ConflictException(DEBT_REVERSAL_PAUSED_MESSAGE);
      // Fix round A, M3 — owner rule "no silent pass-through": on a SEQUENCED wallet every clawback must land on the
      // credit position(s) it reverses (ρ_X + allocation rows), else a later V2 reversal could take the same credit
      // back again. Refuse BEFORE any write when it can't: no resolved position for the line on this wallet, or less
      // reversible room than the clawback. 409 CREDIT_UNMAPPED (the caller audits it; attention endpoint lists it).
      const coverable = positions.reduce((s, p) => s + Math.max(0, p.amount - p.reversedPoints), 0);
      if (!creditReversalId || positions.length === 0 || coverable < points) {
        throw new ReversalAttentionException('CREDIT_UNMAPPED', creditUnmappedMessage(opts.originalCredit.outletCode), {
          ...opts.originalCredit,
          walletId: wallet.id,
          engine: 'LEGACY',
          reason:
            positions.length === 0
              ? 'sequenced wallet: no credit position records this credit'
              : !creditReversalId
                ? 'clawback without a reversal id'
                : `sequenced wallet: the credit positions hold ${coverable} reversible pts, clawback ${points} pts`,
          positionIds: positions.map((p) => p.id),
          coverable,
          requested: points,
        });
      }
    }

    // A clawback reduces ONLY the spendable balance (redeemablePoints) — exactly like a
    // DEBIT_ADJUSTMENT; applyMovement floors redeemable at 0 (mirrored here for the shortfall).
    const redeemableDecrement = Math.max(0, Math.min(points, wallet.redeemablePoints));
    const shortfall = points - redeemableDecrement;
    // Snapshot the locked pre-movement state (never re-read from the wallet object after the write).
    const stateBefore = walletStateOf(wallet);

    let desc = opts.description ?? `Clawback: credit batch POINTS reversal`;
    if (shortfall > 0) {
      desc += ` [SHORTFALL: ${shortfall} pts already redeemed — owner review required]`;
    }

    const movement = await this.applyMovement(tx, {
      wallet,
      walletTxType: 'DEBIT_ADJUSTMENT',
      ledgerType: PointsLedgerType.ADJUST,
      // passing -points is correct: applyMovement's internal decrement = max(0, min(magnitude, redeemableBefore))
      points: -points,
      referenceType: opts.referenceType ?? null,
      referenceId: opts.referenceId ?? null,
      sourceType: opts.sourceType ?? null,
      sourceId: opts.sourceId ?? null,
      description: desc,
      // Which credit this clawback reversed (input for the reversal-engine v2 backfill). Passing
      // metadata also makes applyMovement stamp createdAt under the wallet lock.
      ...(opts.originalCredit ? { metadata: { reversedCreditTxId } } : {}),
      // v2 columns (tracked wallets only; the legacy path ignores them).
      reversedCreditTxId,
      creditReversalId,
    });

    if (tracked && opts.originalCredit) {
      await this.recordLegacyReversalAllocations(tx, {
        walletId: wallet.id,
        stateBefore,
        positions,
        points,
        recovered: redeemableDecrement,
        creditReversalId,
      });
    }

    return { ...movement, shortfall };
  }

  /**
   * LEGACY clawback on a TRACKED wallet: keep the positions' ρ_X and the allocation rows in step with what the
   * floor-0 clawback did (B-neutral — the balance was already moved by applyMovement). The per-position split is
   * WP0 reverse() run in sequence (the caller guarantees D = 0 and every O_X = 0, where it reduces to exactly the
   * legacy floor: Σc = min(r, max(0, B))); a mismatch aborts the transaction rather than record a wrong split.
   * The caller (clawbackAward) has already REFUSED a clawback the positions can't fully cover (M3, fix round A), so
   * every point of it is allocated here — nothing is skipped or logged-only.
   */
  private async recordLegacyReversalAllocations(
    tx: Prisma.TransactionClient,
    a: {
      walletId: string;
      stateBefore: WalletState;
      positions: ReversalPositionRow[];
      points: number;
      recovered: number;
      creditReversalId: string | null;
    },
  ): Promise<void> {
    const coverable = a.positions.reduce((s, p) => s + Math.max(0, p.amount - p.reversedPoints), 0);
    if (!a.creditReversalId || a.positions.length === 0 || coverable < a.points) {
      // Unreachable (clawbackAward refuses first) — abort the transaction rather than record a partial allocation.
      throw new Error(`legacy clawback on tracked wallet ${a.walletId}: ${a.points} pts not coverable by its positions`);
    }
    const allocate = a.points;
    const states = new Map([[a.walletId, { ...a.stateBefore }]]);
    const plan = planV2Reversal(a.positions, states, allocate);
    const planned = plan.reduce((s, st) => s + st.debtRestored + st.recovered, 0);
    const expected = Math.min(allocate, a.recovered);
    if (plan.some((st) => st.debtRestored !== 0) || planned !== expected) {
      throw new Error(
        `legacy clawback allocation mismatch on wallet ${a.walletId}: WP0 split ${planned} vs legacy floor ${expected}`,
      );
    }
    for (const st of plan) {
      await this.updatePosition(tx, st);
      await tx.creditReversalAllocation.create({
        data: {
          creditReversalId: a.creditReversalId,
          positionId: st.position.id,
          requested: st.requested,
          debtRestored: 0,
          recovered: st.recovered,
          shortfall: st.shortfall,
        },
      });
    }
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
    const { positions: unlocked, unallocatedApproved } = await this.v2PointsReversalCap(tx, key, { excludeReversalId });
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
   * c (recovered from holdings) and the shortfall; the RECEIVING wallet (Q4 — never the outlet's current partner)
   * is debited p + c; c is drawn from the credit's OWN lot first, then FIFO (Q7); O_X −= p, ρ_X += r_i; one
   * CreditReversalAllocation per position (unique (reversal, position) → idempotent).
   */
  async applyCreditReversal(
    tx: Prisma.TransactionClient,
    a: CreditKey & { creditReversalId: string; points: number; description?: string | null },
  ): Promise<{
    shortfall: number;
    recovered: number;
    debtRestored: number;
    steps: PlannedReversalStep[];
    transactionIds: string[];
  }> {
    const { positions, states, unallocatedApproved } = await this.lockReversalTargets(tx, a, [], a.creditReversalId);
    this.assertRoomAfterUnallocated(positions, unallocatedApproved, a.points);
    const plan = planV2Reversal(positions, states, a.points);
    const transactionIds: string[] = [];
    for (const st of plan) {
      const removed = st.debtRestored + st.recovered;
      let desc = a.description ?? `Clawback: credit batch POINTS reversal`;
      if (st.shortfall > 0) desc += ` [SHORTFALL: ${st.shortfall} pts already redeemed — owner review required]`;
      const written = await this.writeTrackedMovement(tx, {
        walletId: st.position.walletId,
        before: st.before,
        after: st.after,
        pointsDelta: st.pointsDelta,
        counters: {},
        walletTxType: 'DEBIT_ADJUSTMENT',
        ledgerType: PointsLedgerType.ADJUST,
        points: -st.requested,
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
      transactionIds.push(written.transactionId);
      if (st.recovered > 0) await this.consumeLots(tx, st.position.walletId, st.recovered, st.position.lotId);
      await this.updatePosition(tx, st);
      await tx.creditReversalAllocation.create({
        data: {
          creditReversalId: a.creditReversalId,
          positionId: st.position.id,
          requested: st.requested,
          debtRestored: st.debtRestored,
          recovered: st.recovered,
          shortfall: st.shortfall,
        },
      });
      if (removed !== -st.pointsDelta) throw new Error('applyCreditReversal: p + c ≠ −pointsDelta');
    }
    return {
      shortfall: plan.reduce((s, st) => s + st.shortfall, 0),
      recovered: plan.reduce((s, st) => s + st.recovered, 0),
      debtRestored: plan.reduce((s, st) => s + st.debtRestored, 0),
      steps: plan,
      transactionIds,
    };
  }

  /**
   * Per-tenant dispatcher for an APPROVED credit-batch POINTS reversal (flag `reversalEngine`, default LEGACY):
   *  - LEGACY: exactly today's path — assertPointsReversalAllowed (outlet's current partner, exact credit, Q14
   *    debt refusal) then the floor-0 clawbackAward.
   *  - SHADOW: LEGACY is applied; the v2 plan is computed beforehand from the same locked state and the diff is
   *    written to audit_logs (entityType REVERSAL_ENGINE_SHADOW). A v2 refusal is recorded, never raised.
   *  - V2: applyCreditReversal.
   * The caller holds the credit_batches lock and has flipped the CreditReversal status (guarded).
   * `mode` / `legacyTarget`: already resolved by the caller in this transaction (credits approve resolves the
   * mode once per request and, for LEGACY/SHADOW, runs assertPointsReversalAllowed before the flip) — passed
   * so neither is read twice. Omitted → resolved here.
   */
  async reverseCreditBatchPoints(
    tx: Prisma.TransactionClient,
    a: CreditKey & {
      clientId: string;
      creditReversalId: string;
      points: number;
      actorId?: string | null;
      description?: string | null;
      mode?: ReversalEngineMode;
      legacyTarget?: { partnerId: string; walletId: string } | null;
    },
  ): Promise<{ mode: ReversalEngineMode; shortfall: number; walletIds: string[] }> {
    // Read through the caller's tx (it holds the credit_batches lock — never a second pool connection meanwhile).
    const mode = a.mode ?? (await this.tenantSettings.getReversalEngineModeUncached(a.clientId, tx));
    const description = a.description ?? `Clawback for reversal ${a.creditReversalId} — batch POINTS reversal`;

    if (mode === 'V2') {
      const res = await this.applyCreditReversal(tx, { ...a, description });
      return { mode, shortfall: res.shortfall, walletIds: [...new Set(res.steps.map((s) => s.position.walletId))] };
    }

    const legacy = async (target: { partnerId: string; walletId: string }) => {
      const cb = await this.clawbackAward(
        target.partnerId,
        a.points,
        {
          referenceType: 'CREDIT_REVERSAL',
          referenceId: a.creditReversalId,
          sourceType: 'CREDIT_FIELD',
          sourceId: a.fieldId,
          description,
          originalCredit: { batchId: a.batchId, outletCode: a.outletCode, fieldId: a.fieldId },
        },
        tx,
      );
      return cb;
    };

    const target = a.legacyTarget ?? (await this.assertPointsReversalAllowed(tx, a));
    if (mode === 'LEGACY') {
      const cb = await legacy(target);
      return { mode, shortfall: cb.shortfall, walletIds: [target.walletId] };
    }

    // SHADOW — compute v2 first (read-only plan on the locked state), then apply LEGACY, then record the diff.
    let v2: Record<string, unknown>;
    try {
      const { positions, states, unallocatedApproved } = await this.lockReversalTargets(
        tx, a, [target.walletId], a.creditReversalId,
      );
      this.assertRoomAfterUnallocated(positions, unallocatedApproved, a.points);
      const plan = planV2Reversal(positions, new Map(states), a.points);
      v2 = {
        steps: plan.map((st) => ({
          walletId: st.position.walletId,
          positionId: st.position.id,
          requested: st.requested,
          debtRestored: st.debtRestored,
          recovered: st.recovered,
          shortfall: st.shortfall,
          balanceBefore: st.before.B,
          balanceAfter: st.after.B,
        })),
        shortfall: plan.reduce((s, st) => s + st.shortfall, 0),
        removed: plan.reduce((s, st) => s + st.debtRestored + st.recovered, 0),
      };
    } catch (e) {
      if (!(e instanceof BadRequestException || e instanceof ConflictException)) throw e;
      v2 = { refused: e.message };
    }
    let cb: Awaited<ReturnType<typeof legacy>>;
    try {
      cb = await legacy(target);
    } catch (e) {
      this.logger.warn(
        `[reversal-shadow] ${a.creditReversalId}: LEGACY refused (${(e as Error).message}); v2 would have done ${JSON.stringify(v2)}`,
      );
      throw e;
    }
    const legacyResult = {
      walletId: target.walletId,
      removed: a.points - cb.shortfall,
      shortfall: cb.shortfall,
      balanceAfter: cb.newRedeemable,
    };
    const differs =
      'refused' in v2 ||
      v2.shortfall !== legacyResult.shortfall ||
      v2.removed !== legacyResult.removed ||
      (v2.steps as { walletId: string }[]).some((s) => s.walletId !== target.walletId);
    await tx.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'REVERSAL_ENGINE_SHADOW',
        entityId: a.creditReversalId,
        actorId: a.actorId ?? null,
        metadata: {
          batchId: a.batchId,
          outletCode: a.outletCode,
          fieldId: a.fieldId,
          requested: a.points,
          differs,
          legacy: legacyResult,
          v2,
        } as Prisma.InputJsonValue,
      },
    });
    return { mode, shortfall: cb.shortfall, walletIds: [target.walletId] };
  }

  /**
   * Interim-rule gate for a credit-batch POINTS reversal (create AND approve). Resolves the wallet
   * that would be debited — the outlet's CURRENT partner's wallet — and REFUSES unless that wallet
   * received the exact credit and carries no debt:
   *  - outlet / partner / wallet missing, or the credit is not on that wallet → 400
   *  - wallet balance < 0, or the credit landed on a negative balance → 409 (debt; paused until v2)
   * Read-only (no lock): the approve-time clawbackAward re-checks under the wallet row lock.
   */
  async assertPointsReversalAllowed(
    tx: Prisma.TransactionClient,
    a: { clientId: string; batchId: string; outletCode: string; fieldId: string },
  ): Promise<{ partnerId: string; walletId: string }> {
    const outlet = await tx.outlet.findFirst({
      where: { clientId: a.clientId, outletCode: a.outletCode },
      select: { partnerId: true },
    });
    const wallet = outlet?.partnerId
      ? await tx.wallet.findFirst({
          where: { partnerId: outlet.partnerId },
          select: { id: true, redeemablePoints: true, debtPoints: true, movementSeq: true },
        })
      : null;
    if (!outlet?.partnerId || !wallet) {
      throw new BadRequestException(
        `Cannot reverse: outlet ${a.outletCode} is not linked to a partner wallet that received this credit — settle it off-platform`,
      );
    }
    await this.requireReversibleCredit(tx, wallet.id, outlet.partnerId, {
      batchId: a.batchId, outletCode: a.outletCode, fieldId: a.fieldId,
    });
    if (wallet.redeemablePoints < 0) throw new ConflictException(DEBT_REVERSAL_PAUSED_MESSAGE);
    // Recorded debt D / a credit that paid off debt (O_X > 0) — both 0 on every wallet until the backfill or the
    // v2 engine runs on it, so this adds no refusal today (clawbackAward re-checks under the wallet lock).
    if ((wallet.debtPoints ?? 0) > 0) throw new ConflictException(DEBT_REVERSAL_PAUSED_MESSAGE);
    // Credit positions exist only on SEQUENCED wallets (movementSeq > 0); an un-sequenced wallet (every Deoleo wallet)
    // skips this read — today's query sequence (fix round A, L5).
    if ((wallet.movementSeq ?? 0) > 0) {
      const lines = await this.findPositions(tx, {
        batchId: a.batchId, outletCode: a.outletCode, fieldId: a.fieldId, walletId: wallet.id,
      });
      if (lines.some((p) => p.offsetPoints > 0)) throw new ConflictException(DEBT_REVERSAL_PAUSED_MESSAGE);
      // M3 at create (clawbackAward re-checks the amount at approve): a sequenced wallet whose credit has no
      // position can't be clawed back without leaving the position out of step → refuse now, with the reason.
      if (lines.length === 0) {
        throw new ReversalAttentionException('CREDIT_UNMAPPED', creditUnmappedMessage(a.outletCode), {
          batchId: a.batchId, outletCode: a.outletCode, fieldId: a.fieldId, walletId: wallet.id, engine: 'LEGACY',
          reason: 'sequenced wallet: no credit position records this credit',
        });
      }
    }
    return { partnerId: outlet.partnerId, walletId: wallet.id };
  }

  /**
   * The credit a reversal undoes, or a refusal: 400 when this wallet never received it or (legacy
   * batch) its receipt can't be confirmed, 409 when it landed on a negative balance.
   */
  private async requireReversibleCredit(
    tx: Prisma.TransactionClient,
    walletId: string,
    partnerId: string,
    ref: { batchId: string; outletCode: string; fieldId: string },
  ): Promise<{ id: string }> {
    const r = await this.findOriginalBatchCredit(tx, walletId, partnerId, ref);
    if (r === 'not found') {
      throw new BadRequestException(
        `Cannot claw back: this partner's wallet has no credit from batch ${ref.batchId} for outlet ${ref.outletCode} / field ${ref.fieldId} (outlet relinked or row not credited) — settle it off-platform and reject this reversal`,
      );
    }
    if (r === 'unconfirmed') throw new BadRequestException(this.unconfirmedLegacyCreditMessage(ref.batchId));
    if (r.minBalanceBefore < 0) throw new ConflictException(DEBT_REVERSAL_PAUSED_MESSAGE);
    return { id: r.id };
  }

  private unconfirmedLegacyCreditMessage(batchId: string): string {
    return `Cannot reverse: can't confirm this wallet received this credit (batch ${batchId} predates per-credit tracking and its credits don't line up with the partner's current outlets) — contact Gifsy`;
  }

  /**
   * The EXACT credit-batch credit a reversal undoes — the CREDIT_POINTS_EARNED WalletTransaction(s)
   * this wallet received from batch `batchId` for the reversal's (outletCode, fieldId).
   * Returns { id (first match), minBalanceBefore (lowest balanceBefore among the matches) },
   * 'not found' or 'unconfirmed' (the caller REFUSES both — never debit a wallet that didn't
   * provably receive the credit).
   *
   * Identification, in order:
   *  1. metadata — credits posted since 2026-11-12 carry { fieldId, outletCode } (confirmBatch).
   *  2. legacy rows (no metadata) — pairLegacyBatchCredits: an exact fit of this wallet's credits
   *     to the batch's POINTS rows of the partner's current outlets, else 'unconfirmed'.
   */
  private async findOriginalBatchCredit(
    tx: Prisma.TransactionClient,
    walletId: string,
    partnerId: string,
    ref: { batchId: string; outletCode: string; fieldId: string },
  ): Promise<{ id: string; minBalanceBefore: number } | 'not found' | 'unconfirmed'> {
    const credits = await this.walletBatchCredits(tx, walletId, ref.batchId);
    if (credits.length === 0) return 'not found';

    const summarise = (ms: typeof credits) => ({
      id: ms[0].id,
      minBalanceBefore: Math.min(...ms.map((c) => c.balanceBefore)),
    });
    const metaOf = (m: Prisma.JsonValue | null | undefined) =>
      m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null;

    if (credits.every((c) => typeof metaOf(c.metadata)?.fieldId === 'string')) {
      const matches = credits.filter((c) => {
        const m = metaOf(c.metadata)!;
        return m.fieldId === ref.fieldId && (m.outletCode == null || m.outletCode === ref.outletCode);
      });
      return matches.length === 0 ? 'not found' : summarise(matches);
    }

    const pairs = await this.pairLegacyBatchCredits(tx, partnerId, ref.batchId, credits);
    if (pairs === 'unconfirmed') return 'unconfirmed';
    const matches = pairs
      .filter((p) => p.row.fieldId === ref.fieldId && p.row.outletId === ref.outletCode)
      .map((p) => p.credit);
    return matches.length === 0 ? 'not found' : summarise(matches);
  }

  /** This wallet's CREDIT_POINTS_EARNED rows from credit batch `batchId`, in posting order. */
  private walletBatchCredits(tx: Prisma.TransactionClient, walletId: string, batchId: string) {
    return tx.walletTransaction.findMany({
      where: { walletId, transactionType: 'CREDIT_POINTS_EARNED', referenceType: 'CREDIT_BATCH', referenceId: batchId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, createdAt: true, balanceBefore: true, points: true, metadata: true },
    });
  }

  /**
   * Legacy credits (no metadata): pair a wallet's credits from a batch with the batch's stored
   * rows exactly as confirmBatch credited them — POINTS rows, status OK, amount > 0, for the
   * partner's CURRENT outlet codes, in row order; the k-th credit (createdAt, id order) is the k-th
   * row. Returned ONLY on an exact fit (same count, every amount equal); anything else — a row
   * skipped at confirm, an outlet linked to / away from this partner since, a missing batch — is
   * 'unconfirmed' and every caller refuses (e.g. rows O1 500 + O2 300, the partner received only
   * O2's 300, O1 linked to the partner later → 2 rows vs 1 credit → never debit them for O1).
   */
  private async pairLegacyBatchCredits<C extends { points: number }>(
    tx: Prisma.TransactionClient,
    partnerId: string,
    batchId: string,
    credits: C[],
  ): Promise<{ credit: C; row: { outletId: string; fieldId?: string } }[] | 'unconfirmed'> {
    const batch = await tx.creditBatch.findFirst({ where: { id: batchId }, select: { clientId: true, rows: true } });
    if (!batch || !Array.isArray(batch.rows)) return 'unconfirmed';
    const outlets = await tx.outlet.findMany({
      where: { clientId: batch.clientId, partnerId },
      select: { outletCode: true },
    });
    const codes = new Set(outlets.map((o) => o.outletCode));
    type Row = { outletId?: string; fieldId?: string; amount?: number; awardType?: string; status?: string };
    const credited = (batch.rows as Row[]).filter(
      (r): r is Row & { outletId: string } =>
        !!r &&
        r.awardType === 'POINTS' &&
        r.status === 'OK' &&
        typeof r.amount === 'number' &&
        r.amount > 0 &&
        typeof r.outletId === 'string' &&
        codes.has(r.outletId),
    );
    if (credited.length !== credits.length) return 'unconfirmed';
    if (credited.some((r, k) => r.amount !== credits[k].points)) return 'unconfirmed';
    return credits.map((credit, k) => ({ credit, row: credited[k] }));
  }

  /**
   * Points ACTUALLY credited to wallets by batch `batchId` for (outletCode, fieldId) — the cap
   * for POINTS reversals (never the stored row amount alone: a row skipped at confirm because its
   * outlet was unknown / unlinked credited nothing).
   *  - Batches confirmed since credit metadata exists: Σ points of the batch's CREDIT_POINTS_EARNED
   *    rows whose metadata is { fieldId, outletCode } (any wallet).
   *  - Legacy batches (no credit metadata): Σ of the outlet's CURRENT partner's credits paired to
   *    (outletCode, fieldId) by pairLegacyBatchCredits; 0 when that partner has no wallet / no
   *    credit from the batch; 400 when the pairing is not an exact fit (receipt unconfirmed) —
   *    the same rule the clawback applies, so cap and clawback always agree.
   */
  async creditedPointsForBatchRow(
    tx: Prisma.TransactionClient,
    a: { batchId: string; clientId: string; outletCode: string; fieldId: string },
  ): Promise<bigint> {
    const credits = await tx.walletTransaction.findMany({
      where: { transactionType: 'CREDIT_POINTS_EARNED', referenceType: 'CREDIT_BATCH', referenceId: a.batchId },
      select: { walletId: true, points: true, metadata: true },
    });
    if (credits.length === 0) return 0n;
    const metaOf = (m: Prisma.JsonValue | null | undefined) =>
      m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
    if (credits.some((c) => typeof metaOf(c.metadata)?.fieldId === 'string')) {
      return credits.reduce((s, c) => {
        const m = metaOf(c.metadata);
        return m?.fieldId === a.fieldId && m?.outletCode === a.outletCode ? s + BigInt(c.points) : s;
      }, 0n);
    }
    const outlet = await tx.outlet.findFirst({
      where: { clientId: a.clientId, outletCode: a.outletCode },
      select: { partnerId: true },
    });
    if (!outlet?.partnerId) return 0n;
    const wallet = await tx.wallet.findFirst({ where: { partnerId: outlet.partnerId }, select: { id: true } });
    if (!wallet) return 0n;
    const walletCredits = await this.walletBatchCredits(tx, wallet.id, a.batchId);
    if (walletCredits.length === 0) return 0n;
    const pairs = await this.pairLegacyBatchCredits(tx, outlet.partnerId, a.batchId, walletCredits);
    if (pairs === 'unconfirmed') throw new BadRequestException(this.unconfirmedLegacyCreditMessage(a.batchId));
    return pairs.reduce(
      (s, p) => (p.row.outletId === a.outletCode && p.row.fieldId === a.fieldId ? s + BigInt(p.credit.points) : s),
      0n,
    );
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
        // L5: an un-sequenced wallet with history (any wallet holding a due lot) is decided without a flag read; a
        // malformed flag never reaches here as an error (M1 — movementPath reads it leniently).
        if (!this.legacyFastPath(wallet) && (await this.movementPath(tx, wallet)) === 'V2') {
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

  // ─── Reversal engine call-outs (policy round A — owner rule "no silent pass-throughs") ─────────────────────

  /**
   * Everything about the tenant's POINTS reversals that needs GIFSY to act, with reasons — feeds
   * GET /v1/admin/credits/reversal-engine/attention and the banner on the credits reversal screen:
   *  - `pause`: the Q5 maintenance pause (+ when / who);
   *  - `wallets`: BLOCKED by the backfill (reason), and — on a SHADOW / V2 tenant — wallets with history the backfill
   *    has not processed yet (both keep today's earn/redeem rules; reversals on them are refused — Q1);
   *  - `unmappedCredits`: UNRESOLVED credit positions (reversals of their outlet line refused until mapped — Q3/Q5);
   *  - `owedClawbacks`: historical clawbacks that took more than the wallet held — "recovered X, owed Y" (Q4).
   * Lists are capped at `limit` (default 200); the totals are exact.
   */
  async reversalAttention(clientId: string, opts: { limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    let mode: ReversalEngineMode | 'INVALID';
    let modeError: string | null = null;
    // M1: what normal points activity actually runs on, and the LOUD warning when the stored value is malformed.
    let effectiveMode: ReversalEngineMode;
    let modeWarning: string | null = null;
    try {
      mode = await this.tenantSettings.getReversalEngineModeUncached(clientId);
      effectiveMode = mode;
    } catch (e) {
      mode = 'INVALID';
      modeError = (e as Error).message;
      effectiveMode = 'LEGACY';
      if (e instanceof InvalidReversalEngineSettingException) {
        modeWarning =
          `${reversalEngineInvalidWarning(e.value)}. Earning, redeeming, expiry and batch confirms run on today's (LEGACY) ` +
          `rules; points reversal requests and approvals are refused until a Gifsy Admin sets a valid engine mode ` +
          `(POST /v1/admin/credits/reversal-engine/mode).`;
      } else {
        modeWarning = `reversalEngine setting could not be read (${modeError}) — contact Gifsy`;
      }
    }
    const pause = await this.tenantSettings.getPointsReversalPauseUncached(clientId);

    const blockedWhere: Prisma.WalletWhereInput = { partner: { clientId }, movementSeq: 0, backfillStatus: 'BLOCKED' };
    // On a LEGACY tenant every wallet is "not backfilled" until the job runs — that is the normal state, not a problem.
    const pendingWhere: Prisma.WalletWhereInput | null =
      effectiveMode === 'LEGACY'
        ? null
        : {
            partner: { clientId },
            movementSeq: 0,
            backfillStatus: null,
            OR: [{ redeemablePoints: { not: 0 } }, { transactions: { some: {} } }],
          };
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
      pendingWhere ? this.prisma.wallet.count({ where: pendingWhere }) : Promise.resolve(0),
      pendingWhere
        ? this.prisma.wallet.findMany({ where: pendingWhere, select: walletSelect, orderBy: { id: 'asc' }, take: limit })
        : Promise.resolve([] as never[]),
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
        'Earning and redeeming keep working on today\'s rules; points reversals on this wallet are refused. Gifsy: fix the wallet history, then re-run the wallet backfill.',
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
    const owedWhere: Prisma.CreditReversalAllocationWhereInput = { owed: { gt: 0 }, creditReversal: { clientId } };
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
    return {
      clientId,
      mode,
      modeError,
      effectiveMode,
      modeWarning,
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

  /**
   * M2 (fix round A) — the ONLY way to change a tenant's `reversalEngine` (the generic settings upsert refuses the
   * key). GIFSY_ADMIN-only (controller), validated, audited (REVERSAL_ENGINE_MODE, old → new + reason), tenant per L6.
   * Runs under the EXCLUSIVE engine advisory lock: it waits for every in-flight POINTS reversal create / approve and
   * every POINTS batch confirm (they hold the shared lock and read the mode after taking it — L4), so no such
   * request runs half on the old mode and half on the new one.
   *  - → LEGACY: always allowed (the rollback).
   *  - → SHADOW / V2: refused while POINTS reversal approvals are paused (a backfill run is in progress).
   *  - → V2: refused while the tenant has wallets with points history that the wallet backfill has not prepared
   *    (movementSeq 0) and that are NOT listed as BLOCKED with a reason — run the backfill APPLY first. BLOCKED wallets
   *    are allowed (owner P-A1: they keep today's rules, reversals on them are refused, the attention banner lists
   *    them); their count is returned so the caller sees them.
   */
  async setReversalEngineMode(
    actor: { sub: string; clientId: string; role?: string; assumed?: boolean },
    a: { mode: unknown; reason?: string | null; clientId?: string | null },
  ) {
    if (!isReversalEngineMode(a.mode)) {
      throw new BadRequestException(
        `reversalEngine must be one of ${REVERSAL_ENGINE_MODES.join(' | ')} (got ${JSON.stringify(a.mode)}) — nothing was changed`,
      );
    }
    const mode = a.mode;
    const clientId = await this.resolveEngineAdminTenant(actor, a.clientId);
    const reason = a.reason?.trim() || null;

    const result = await this.prisma.$transaction(async (tx) => {
      const key = pointsReversalLockKey(clientId);
      await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))) AS l`;
      const row = await tx.programSetting.findUnique({
        where: { clientId_settingKey: { clientId, settingKey: REVERSAL_ENGINE_SETTING_KEY } },
        select: { settingValue: true },
      });
      const previous = row ? row.settingValue : null; // null = absent (= LEGACY)

      let blockedListed = 0;
      if (mode !== 'LEGACY') {
        const pause = await this.tenantSettings.getPointsReversalPauseUncached(clientId, tx);
        if (pause.paused) {
          throw new ConflictException(
            `Can't switch the reversal engine to ${mode} while points reversal approvals are paused (${pause.malformed ? 'the pause setting is unreadable' : `wallet maintenance started ${pause.since ?? 'at an unknown time'}`}) — let the wallet backfill run finish (or lift a stuck pause), then switch. Nothing was changed.`,
          );
        }
      }
      if (mode === 'V2') {
        const unprepared: Prisma.WalletWhereInput = {
          partner: { clientId },
          movementSeq: 0,
          OR: [{ redeemablePoints: { not: 0 } }, { transactions: { some: {} } }],
          NOT: { backfillStatus: 'BLOCKED', backfillBlockedReason: { not: null } },
        };
        const [count, sample] = await Promise.all([
          tx.wallet.count({ where: unprepared }),
          tx.wallet.findMany({ where: unprepared, select: { id: true }, orderBy: { id: 'asc' }, take: 5 }),
        ]);
        if (count > 0) {
          throw new ConflictException(
            `Can't switch the reversal engine to V2: ${count} wallet(s) with points history have not been prepared by the wallet backfill and are not listed as blocked (e.g. ${sample.map((w) => w.id).join(', ')}) — run the wallet backfill APPLY for this program first (WALLET-REVERSAL-ENGINE-DESIGN.md §9.1). Nothing was changed.`,
          );
        }
        blockedListed = await tx.wallet.count({
          where: { partner: { clientId }, movementSeq: 0, backfillStatus: 'BLOCKED' },
        });
      }

      await tx.programSetting.upsert({
        where: { clientId_settingKey: { clientId, settingKey: REVERSAL_ENGINE_SETTING_KEY } },
        create: {
          clientId,
          settingKey: REVERSAL_ENGINE_SETTING_KEY,
          settingValue: mode,
          category: 'reversal-engine',
          description: 'Points reversal engine mode (LEGACY | SHADOW | V2) — WALLET-REVERSAL-ENGINE-DESIGN.md §9',
          updatedById: actor.sub,
        },
        update: { settingValue: mode, updatedById: actor.sub },
      });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: REVERSAL_ENGINE_MODE_ENTITY,
          entityId: clientId,
          actorId: actor.sub,
          oldValues: { value: previous } as Prisma.InputJsonValue,
          newValues: { value: mode } as Prisma.InputJsonValue,
          metadata: { reason, blockedWalletsListed: blockedListed } as Prisma.InputJsonValue,
        },
      });
      return { previous, blockedListed };
    });
    this.tenantSettings.invalidate(clientId);
    return {
      clientId,
      mode,
      previous: result.previous,
      blockedWalletsListed: result.blockedListed,
      note:
        result.blockedListed > 0
          ? `${result.blockedListed} wallet(s) are BLOCKED by the wallet backfill: they keep today's rules and points reversals on them are refused until Gifsy fixes them (listed on the credits reversal screen).`
          : null,
    };
  }

  private getDefaultDescription(transactionType: string): string {
    // Shared with the statement builder so the passbook and statement can't drift.
    return defaultTxDescription(transactionType);
  }
}
