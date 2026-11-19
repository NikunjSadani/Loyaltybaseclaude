/**
 * Wallet Reversal Engine — PURE reference model (WP0, the oracle).
 *
 * Source of truth: platform/docs/plans/WALLET-REVERSAL-ENGINE-DESIGN.md §1.2 (transitions), §1.3 (the one rule),
 * §3.3 (backfill replay), §4 (lots). No Prisma, no I/O, no clock — every function is deterministic and returns a NEW
 * model (inputs are never mutated). WP2 (applyMovement v2), WP3 (reversal engine) and WP6 (backfill) are audited
 * against this file.
 *
 * Symbols (per wallet):
 *   B  balance (may be < 0)                         → wallets.redeemablePoints
 *   D  debt not offset by any credit, D ≥ 0         → wallets.debtPoints
 *   H  holdings = B + D ≥ 0                         → derived; = Σ lot remaining (§4)
 *   O_X how much of credit X currently pays off debt → wallet_credit_positions.offsetPoints
 *   a_X amount of credit X; ρ_X total reversed against X
 *
 * All quantities are integer points.
 */

// ───────────────────────────── types ─────────────────────────────

export interface WalletState {
  /** balance B (may be negative) */
  B: number;
  /** outstanding debt D ≥ 0 */
  D: number;
  /** last applied per-wallet movement sequence number (0 = none yet) */
  seq: number;
}

export interface CreditPosition {
  /** credit (wallet transaction) id; also the id of the credit's own lot */
  id: string;
  /** a_X */
  amount: number;
  /** O_X — how much of this credit currently pays off debt */
  offset: number;
  /** ρ_X — total reversal approved against this credit */
  reversed: number;
  /** mirror of the credit's own lot remainingPoints */
  lotRemaining: number;
  /**
   * E_X — points of THIS credit that EXPIRED from the balance (its own lot's expiries, e only — the part that
   * repaid debt went to O_X). Owner decision 2026-11-19: they count as already recovered. Absent = 0.
   */
  expired?: number;
  /** ε_X — how much of E_X earlier reversals of X already counted (never counted twice). Absent = 0. */
  expiredCounted?: number;
}

export interface Lot {
  id: string;
  /** owning reversible credit position id, or null for a non-reversible credit (manual / opening / refund …) */
  creditId: string | null;
  remaining: number;
}

export interface WalletModel {
  state: WalletState;
  positions: Record<string, CreditPosition>;
  /** FIFO order = array order (oldest first) */
  lots: Lot[];
}

export interface LotDraw {
  lotId: string;
  points: number;
}

export type MovementKind =
  | 'CREDIT'
  | 'SPEND'
  | 'EXPIRY'
  | 'LEGACY_DEBT_DEBIT'
  | 'REVERSAL';

export interface Movement {
  kind: MovementKind;
  seq: number;
  /** credit id for CREDIT / REVERSAL, lot id for EXPIRY */
  refId: string | null;
  /** what the movement asked for (credit a, spend s, lot remaining h, debit d, reversal r) */
  pointsRequested: number;
  /** actual change of B (signed) */
  pointsDelta: number;
  /** change of D (signed) */
  debtDelta: number;
  /** change of the affected position's O (signed; 0 when no position is affected) */
  offsetDelta: number;
  /** position whose O changed (credit itself, expiring lot's owner, reversed credit) */
  offsetPositionId: string | null;
  lotDraws: LotDraw[];
  /**
   * reversal only: points written off. ALWAYS 0 since owner decision 2026-11-19 (over-reversal becomes debt): the
   * part a wallet no longer holds is `owed` (booked as debt, repaid from future earnings), never written off.
   */
  shortfall: number;
  /** reversal only: s = r − p − q − c — the part the wallet no longer held (already spent), booked as debt D (owner 2026-11-19) */
  owed: number;
  /**
   * reversal only: q = min(r − p, E_X − ε_X) — X's own points that already EXPIRED: counted as already recovered,
   * nothing taken and no debt for them (owner decision 2026-11-19, expired points are not recovered twice).
   */
  alreadyExpired: number;
  /**
   * reversal only (fix round 3, 2026-11-19): the part of c that was backing EXISTING debt — how much further below zero
   * the balance went than p + s explain (B 60 / D 40, reverse 100 → c 100, B −40 → 40). Informational: c includes it.
   */
  debtExposed: number;
  /** reversal only: p (debt restored) */
  debtRestored: number;
  /** reversal only: c (recovered from holdings) */
  recovered: number;
}

export interface Step {
  model: WalletModel;
  movement: Movement;
}

export class ReversalModelError extends Error {}

// ───────────────────────────── helpers ─────────────────────────────

export function holdings(s: WalletState): number {
  return s.B + s.D;
}

/** −x without producing −0 (records are persisted / compared; −0 ≠ 0 under Object.is). */
function neg(x: number): number {
  return x === 0 ? 0 : -x;
}

export function emptyModel(): WalletModel {
  return { state: { B: 0, D: 0, seq: 0 }, positions: {}, lots: [] };
}

function clone(m: WalletModel): WalletModel {
  const positions: Record<string, CreditPosition> = {};
  for (const k of Object.keys(m.positions))
    positions[k] = { ...m.positions[k] };
  return {
    state: { ...m.state },
    positions,
    lots: m.lots.map((l) => ({ ...l })),
  };
}

function assertPosInt(n: number, what: string): void {
  if (!Number.isInteger(n) || n <= 0)
    throw new ReversalModelError(
      `${what} must be a positive integer (got ${n})`,
    );
}

function movement(
  kind: MovementKind,
  seq: number,
  refId: string | null,
  requested: number,
): Movement {
  return {
    kind,
    seq,
    refId,
    pointsRequested: requested,
    pointsDelta: 0,
    debtDelta: 0,
    offsetDelta: 0,
    offsetPositionId: null,
    lotDraws: [],
    shortfall: 0,
    owed: 0,
    alreadyExpired: 0,
    debtExposed: 0,
    debtRestored: 0,
    recovered: 0,
  };
}

/** Draw `amount` from one lot (bounded by its remaining). Mutates the (cloned) model. Returns the amount drawn. */
function drawFromLot(
  m: WalletModel,
  lot: Lot,
  amount: number,
  draws: LotDraw[],
): number {
  const take = Math.min(amount, lot.remaining);
  if (take <= 0) return 0;
  lot.remaining -= take;
  if (lot.creditId && m.positions[lot.creditId])
    m.positions[lot.creditId].lotRemaining = lot.remaining;
  const prev = draws.find((d) => d.lotId === lot.id);
  if (prev) prev.points += take;
  else draws.push({ lotId: lot.id, points: take });
  return take;
}

/** FIFO draw across lots (optionally starting with a preferred lot). Mutates the (cloned) model. */
function drawLots(
  m: WalletModel,
  amount: number,
  preferredLotId: string | null,
): LotDraw[] {
  const draws: LotDraw[] = [];
  let left = amount;
  if (preferredLotId) {
    const own = m.lots.find((l) => l.id === preferredLotId);
    if (own) left -= drawFromLot(m, own, left, draws);
  }
  for (const lot of m.lots) {
    if (left <= 0) break;
    left -= drawFromLot(m, lot, left, draws);
  }
  if (left !== 0) {
    // Σ lots == H is an invariant; every caller bounds `amount` by H, so this is a model bug.
    throw new ReversalModelError(
      `lot draw short by ${left} (lot mirror out of sync with holdings)`,
    );
  }
  return draws;
}

// ───────────────────────────── transitions (§1.2) ─────────────────────────────

export interface CreditInput {
  /** credit id (also the lot id, and the position id when reversible) */
  id: string;
  amount: number;
  /** reversible credit-batch POINTS credit → gets a WalletCreditPosition */
  reversible: boolean;
}

/** Credit a > 0: o = min(a, D); D −= o; B += a; reversible X: O_X = o; lot remaining a − o. */
export function credit(m0: WalletModel, input: CreditInput): Step {
  assertPosInt(input.amount, 'credit amount');
  if (m0.positions[input.id] || m0.lots.some((l) => l.id === input.id)) {
    throw new ReversalModelError(`duplicate credit id ${input.id}`);
  }
  const m = clone(m0);
  const a = input.amount;
  const o = Math.min(a, m.state.D);
  m.state.D -= o;
  m.state.B += a;
  m.state.seq += 1;
  const mv = movement('CREDIT', m.state.seq, input.id, a);
  mv.pointsDelta = a;
  mv.debtDelta = neg(o);
  if (input.reversible) {
    m.positions[input.id] = {
      id: input.id,
      amount: a,
      offset: o,
      reversed: 0,
      lotRemaining: a - o,
    };
    mv.offsetDelta = o;
    mv.offsetPositionId = input.id;
  }
  m.lots.push({
    id: input.id,
    creditId: input.reversible ? input.id : null,
    remaining: a - o,
  });
  return { model: m, movement: mv };
}

/** Spend s (redemption, admin debit) — guarded B ≥ s; B −= s; FIFO lots. */
export function spend(m0: WalletModel, s: number): Step {
  assertPosInt(s, 'spend amount');
  if (m0.state.B < s)
    throw new ReversalModelError(
      `insufficient balance: B=${m0.state.B} < s=${s}`,
    );
  const m = clone(m0);
  m.state.B -= s;
  m.state.seq += 1;
  const mv = movement('SPEND', m.state.seq, null, s);
  mv.pointsDelta = neg(s);
  mv.lotDraws = drawLots(m, s, null);
  return { model: m, movement: mv };
}

/**
 * Expiry of lot remaining h: e = min(h, max(0, B)) (today's clamp); B −= e; D −= (h − e); owner O += (h − e).
 * The non-expired excess is reclassified as debt repayment by the owning credit.
 */
export function expire(m0: WalletModel, lotId: string): Step {
  const lot0 = m0.lots.find((l) => l.id === lotId);
  if (!lot0) throw new ReversalModelError(`unknown lot ${lotId}`);
  const h = lot0.remaining;
  if (h <= 0)
    throw new ReversalModelError(`lot ${lotId} has nothing to expire`);
  const m = clone(m0);
  const lot = m.lots.find((l) => l.id === lotId)!;
  const e = Math.min(h, Math.max(0, m.state.B));
  const x = h - e;
  m.state.B -= e;
  m.state.D -= x;
  m.state.seq += 1;
  const mv = movement('EXPIRY', m.state.seq, lotId, h);
  mv.pointsDelta = neg(e);
  mv.debtDelta = neg(x);
  drawFromLot(m, lot, h, mv.lotDraws);
  if (lot.creditId && m.positions[lot.creditId]) {
    m.positions[lot.creditId].offset += x;
    // owner 2026-11-19: X's expired points count as already recovered by a later reversal of X
    m.positions[lot.creditId].expired = (m.positions[lot.creditId].expired ?? 0) + e;
    mv.offsetDelta = x;
    mv.offsetPositionId = lot.creditId;
  }
  return { model: m, movement: mv };
}

/** Legacy debt-creating debit d (vendor import only): B −= d; D += max(0, d − H); lots consume min(d, H) FIFO. */
export function legacyDebtDebit(m0: WalletModel, d: number): Step {
  assertPosInt(d, 'legacy debit amount');
  const m = clone(m0);
  const H = holdings(m.state);
  const debt = Math.max(0, d - H);
  m.state.B -= d;
  m.state.D += debt;
  m.state.seq += 1;
  const mv = movement('LEGACY_DEBT_DEBIT', m.state.seq, null, d);
  mv.pointsDelta = neg(d);
  mv.debtDelta = debt;
  mv.lotDraws = drawLots(m, Math.min(d, H), null);
  return { model: m, movement: mv };
}

/**
 * Reversal of X by r ≤ a_X − ρ_X (owner decisions 2026-11-19 — over-reversal becomes debt; expired points are not
 * recovered twice):
 *   p = min(r, O_X)                 debt X had repaid comes back
 *   q = min(r − p, E_X − ε_X)       X's own points that already EXPIRED — already recovered: nothing taken, no debt
 *   c = min(r − p − q, H)           taken from what the wallet holds (X's OWN lot first, then FIFO — §4 / Q7)
 *   s = r − p − q − c               already spent → owed, booked as debt, repaid from future earnings
 *   B −= r − q; D += p + s; O_X −= p; ε_X += q; ρ_X += r; shortfall 0 (nothing is written off).
 * p, q and s touch no lot (H drops by exactly c). p and q are private to X, so R3 (order independence) still holds.
 */
export function reverse(m0: WalletModel, creditId: string, r: number): Step {
  assertPosInt(r, 'reversal amount');
  const pos0 = m0.positions[creditId];
  if (!pos0)
    throw new ReversalModelError(`unknown / non-reversible credit ${creditId}`);
  if (r > pos0.amount - pos0.reversed) {
    throw new ReversalModelError(
      `reversal cap exceeded: r=${r} > a−ρ=${pos0.amount - pos0.reversed} for credit ${creditId}`,
    );
  }
  const m = clone(m0);
  const pos = m.positions[creditId];
  const H = holdings(m.state);
  const p = Math.min(r, pos.offset);
  const q = Math.min(r - p, Math.max(0, (pos.expired ?? 0) - (pos.expiredCounted ?? 0)));
  const c = Math.min(r - p - q, H);
  const s = r - p - q - c;
  const negBefore = Math.max(0, -m.state.B);
  m.state.B -= r - q;
  const exposed = Math.max(0, Math.max(0, -m.state.B) - negBefore - p - s);
  m.state.D += p + s;
  pos.offset -= p;
  pos.reversed += r;
  if (q > 0) pos.expiredCounted = (pos.expiredCounted ?? 0) + q;
  m.state.seq += 1;
  const mv = movement('REVERSAL', m.state.seq, creditId, r);
  mv.pointsDelta = neg(r - q);
  mv.debtDelta = p + s;
  mv.offsetDelta = neg(p);
  mv.offsetPositionId = creditId;
  mv.debtRestored = p;
  mv.alreadyExpired = q;
  mv.recovered = c;
  mv.owed = s;
  mv.debtExposed = exposed;
  mv.shortfall = 0;
  mv.lotDraws = drawLots(m, c, creditId);
  return { model: m, movement: mv };
}

/**
 * Floor a reversal of X can push the wallet to WITHOUT creating new debt: −(D + O_X) (§1.3). Since owner decision
 * 2026-11-19 a reversal may go below it — the part beyond is the owed debt s (repaid from future earnings).
 */
export function reversalFloor(m: WalletModel, creditId: string): number {
  const pos = m.positions[creditId];
  return -(m.state.D + (pos ? pos.offset : 0));
}

/** The LEGACY reversal decrement (floor 0, remainder written off as shortfall): min(r, max(0, B)). LEGACY path only. */
export function legacyReversalDecrement(B: number, r: number): number {
  return Math.min(r, Math.max(0, B));
}

// ───────────────────────────── invariants (§1.1) ─────────────────────────────

export interface InvariantOptions {
  /** I5 — the wallet has never been < 0 (Deoleo-style) → D = 0 and all O_X = 0 */
  neverNegative?: boolean;
}

/** Returns the list of violated invariants (empty = OK). Also checks the §4 lot mirror Σ remaining = H. */
export function checkInvariants(
  m: WalletModel,
  opts: InvariantOptions = {},
): string[] {
  const v: string[] = [];
  const { B, D } = m.state;
  if (!Number.isInteger(B) || !Number.isInteger(D))
    v.push(`non-integer state B=${B} D=${D}`);
  if (D < 0) v.push(`I1 D ≥ 0 violated: D=${D}`);
  if (B + D < 0) v.push(`I2 H ≥ 0 violated: H=${B + D}`);
  for (const p of Object.values(m.positions)) {
    if (p.offset < 0 || p.offset > p.amount)
      v.push(`I3 0 ≤ O ≤ a violated for ${p.id}: O=${p.offset} a=${p.amount}`);
    if (p.reversed < 0 || p.reversed > p.amount)
      v.push(`I4 ρ ≤ a violated for ${p.id}: ρ=${p.reversed} a=${p.amount}`);
    const lot = m.lots.find((l) => l.id === p.id);
    if (lot && lot.remaining !== p.lotRemaining)
      v.push(`position ${p.id} lotRemaining mirror out of sync`);
  }
  if (opts.neverNegative) {
    if (D !== 0) v.push(`I5 never-negative wallet has D=${D}`);
    for (const p of Object.values(m.positions)) {
      if (p.offset !== 0)
        v.push(`I5 never-negative wallet has O=${p.offset} on ${p.id}`);
    }
  }
  let lotSum = 0;
  for (const l of m.lots) {
    if (l.remaining < 0) v.push(`lot ${l.id} remaining < 0`);
    lotSum += l.remaining;
  }
  if (lotSum !== B + D) v.push(`lot mirror Σremaining=${lotSum} ≠ H=${B + D}`);
  return v;
}

// ───────────────────────────── event runner ─────────────────────────────

export type ModelEvent =
  | { type: 'credit'; id: string; amount: number; reversible?: boolean }
  | { type: 'spend'; amount: number }
  | { type: 'expire'; lotId: string }
  | { type: 'legacyDebit'; amount: number }
  | { type: 'reverse'; creditId: string; amount: number };

/** Apply a list of live (v2) events through the transitions. */
export function run(
  events: ModelEvent[],
  start: WalletModel = emptyModel(),
): { model: WalletModel; movements: Movement[] } {
  let m = start;
  const movements: Movement[] = [];
  for (const ev of events) {
    let s: Step;
    switch (ev.type) {
      case 'credit':
        s = credit(m, {
          id: ev.id,
          amount: ev.amount,
          reversible: ev.reversible ?? true,
        });
        break;
      case 'spend':
        s = spend(m, ev.amount);
        break;
      case 'expire':
        s = expire(m, ev.lotId);
        break;
      case 'legacyDebit':
        s = legacyDebtDebit(m, ev.amount);
        break;
      case 'reverse':
        s = reverse(m, ev.creditId, ev.amount);
        break;
    }
    m = s.model;
    movements.push(s.movement);
  }
  return { model: m, movements };
}

// ───────────────────────────── backfill replay (§3 "Backfill") ─────────────────────────────

/**
 * A HISTORICAL movement, in per-wallet seq order, with its RECORDED balance change.
 * The replay never re-decides an amount — it only derives D and O_X (and classifies historical clawbacks).
 */
export type HistoricalEvent =
  /** any positive movement. reversible ⇒ a credit-batch POINTS credit that gets a position */
  | { type: 'credit'; id: string; delta: number; reversible: boolean }
  /** any non-reversal debit (redemption, admin debit, vendor-import debit): delta < 0 */
  | { type: 'debit'; id: string; delta: number }
  /**
   * expiry: delta = −e (may be 0). `lotRemaining` = the lot's remaining h at expiry, when known (h ≥ e);
   * the excess h − e is reclassified as debt repayment by `ownerCreditId`. Omitted ⇒ h = e.
   */
  | {
      type: 'expiry';
      id: string;
      delta: number;
      lotRemaining?: number;
      ownerCreditId?: string | null;
    }
  /** historical clawback of credit `creditId`: delta < 0 as recorded; `requested` defaults to |delta| */
  | {
      type: 'clawback';
      id: string;
      creditId: string;
      delta: number;
      requested?: number;
    };

export interface ReplayAnomaly {
  eventId: string;
  seq: number;
  code:
    | 'CLAWBACK_UNKNOWN_CREDIT'
    | 'CLAWBACK_BEYOND_HOLDINGS'
    | 'CLAWBACK_OVER_CAP'
    | 'EXPIRY_EXCESS_EXCEEDS_DEBT'
    | 'EXPIRY_LOT_LESS_THAN_EXPIRED'
    | 'BAD_DELTA_SIGN'
    | 'DUPLICATE_CREDIT'
    | 'FINAL_BALANCE_MISMATCH';
  detail: string;
}

export interface ReplayClassification {
  eventId: string;
  seq: number;
  pointsDelta: number;
  debtDelta: number;
  /** clawback: p (debt restored) / c (recovered from holdings) */
  debtRestored: number;
  recovered: number;
  offsetPositionId: string | null;
  offsetDelta: number;
}

export interface ReplayResult {
  state: WalletState;
  positions: Record<string, CreditPosition>;
  classifications: ReplayClassification[];
  anomalies: ReplayAnomaly[];
}

/**
 * §3 backfill replay. Starting from B = D = 0, applies each historical movement's RECORDED delta to B and derives D,
 * O_X and ρ_X per §1.2:
 *  - credit: o = min(δ, D) repays debt first; reversible ⇒ position with O = o.
 *  - debit (spend / admin / legacy import): D += max(0, |δ| − H) — a spend that was affordable creates no debt.
 *  - expiry: B −= e; excess (h − e) repays debt, credited to the owning position's O.
 *  - clawback (Q13 keep as recorded): p = min(|δ|, O_X) restores debt, c = |δ| − p from holdings; a recorded c > H
 *    (a legacy floor pushed past holdings) is booked as extra debt and flagged CLAWBACK_BEYOND_HOLDINGS.
 * Lots are NOT modelled (the backfill writes no lots); `lotRemaining` of returned positions is meaningless (−1).
 * Pass `expectedBalance` (wallets.redeemablePoints) to get a FINAL_BALANCE_MISMATCH anomaly when it differs.
 */
export function replay(
  events: HistoricalEvent[],
  expectedBalance?: number,
): ReplayResult {
  let B = 0;
  let D = 0;
  let seq = 0;
  const positions: Record<string, CreditPosition> = {};
  const classifications: ReplayClassification[] = [];
  const anomalies: ReplayAnomaly[] = [];

  for (const ev of events) {
    seq += 1;
    const cl: ReplayClassification = {
      eventId: ev.id,
      seq,
      pointsDelta: ev.delta,
      debtDelta: 0,
      debtRestored: 0,
      recovered: 0,
      offsetPositionId: null,
      offsetDelta: 0,
    };
    const H = B + D;
    switch (ev.type) {
      case 'credit': {
        if (!(ev.delta > 0)) {
          anomalies.push({
            eventId: ev.id,
            seq,
            code: 'BAD_DELTA_SIGN',
            detail: `credit delta ${ev.delta}`,
          });
          B += ev.delta;
          break;
        }
        const o = Math.min(ev.delta, D);
        D -= o;
        B += ev.delta;
        cl.debtDelta = neg(o);
        if (ev.reversible) {
          if (positions[ev.id]) {
            anomalies.push({
              eventId: ev.id,
              seq,
              code: 'DUPLICATE_CREDIT',
              detail: `credit ${ev.id} seen twice`,
            });
          } else {
            positions[ev.id] = {
              id: ev.id,
              amount: ev.delta,
              offset: o,
              reversed: 0,
              lotRemaining: -1,
            };
            cl.offsetPositionId = ev.id;
            cl.offsetDelta = o;
          }
        }
        break;
      }
      case 'debit': {
        if (!(ev.delta < 0)) {
          anomalies.push({
            eventId: ev.id,
            seq,
            code: 'BAD_DELTA_SIGN',
            detail: `debit delta ${ev.delta}`,
          });
        }
        const d = Math.max(0, -ev.delta);
        const debt = Math.max(0, d - H);
        B -= d;
        D += debt;
        cl.pointsDelta = neg(d);
        cl.debtDelta = debt;
        break;
      }
      case 'expiry': {
        if (ev.delta > 0) {
          anomalies.push({
            eventId: ev.id,
            seq,
            code: 'BAD_DELTA_SIGN',
            detail: `expiry delta ${ev.delta}`,
          });
        }
        const e = Math.max(0, -ev.delta);
        let h = ev.lotRemaining ?? e;
        if (h < e) {
          anomalies.push({
            eventId: ev.id,
            seq,
            code: 'EXPIRY_LOT_LESS_THAN_EXPIRED',
            detail: `lotRemaining ${h} < expired ${e}`,
          });
          h = e;
        }
        let x = h - e;
        if (x > D) {
          anomalies.push({
            eventId: ev.id,
            seq,
            code: 'EXPIRY_EXCESS_EXCEEDS_DEBT',
            detail: `excess ${x} > D ${D}; reclassified only ${D}`,
          });
          x = D;
        }
        // An expiry that removed more than holdings (cannot happen under the clamp) is booked as debt.
        const debt = Math.max(0, e - H);
        B -= e;
        D += debt - x;
        cl.pointsDelta = neg(e);
        cl.debtDelta = debt - x;
        const owner = ev.ownerCreditId
          ? positions[ev.ownerCreditId]
          : undefined;
        if (owner && x > 0) {
          const room = owner.amount - owner.offset;
          const add = Math.min(x, room);
          owner.offset += add;
          cl.offsetPositionId = owner.id;
          cl.offsetDelta = add;
        }
        break;
      }
      case 'clawback': {
        if (ev.delta > 0) {
          anomalies.push({
            eventId: ev.id,
            seq,
            code: 'BAD_DELTA_SIGN',
            detail: `clawback delta ${ev.delta}`,
          });
        }
        const amt = Math.max(0, -ev.delta);
        const pos = positions[ev.creditId];
        if (!pos) {
          // Unresolvable credit (T-h2): keep as recorded, treat like a debit, flag for the owner.
          anomalies.push({
            eventId: ev.id,
            seq,
            code: 'CLAWBACK_UNKNOWN_CREDIT',
            detail: `clawback of unknown credit ${ev.creditId}`,
          });
          const debt = Math.max(0, amt - H);
          B -= amt;
          D += debt;
          cl.pointsDelta = neg(amt);
          cl.debtDelta = debt;
          break;
        }
        const requested = ev.requested ?? amt;
        const p = Math.min(amt, pos.offset);
        let c = amt - p;
        let extraDebt = 0;
        if (c > H) {
          extraDebt = c - H;
          anomalies.push({
            eventId: ev.id,
            seq,
            code: 'CLAWBACK_BEYOND_HOLDINGS',
            // Q4 wording (owner 2026-11-16): never call the excess "recovered" — it is owed (booked as debt).
            detail: `clawback took ${c} pts from a wallet holding ${H}: recovered ${H}, owed ${extraDebt} (booked as debt)`,
          });
          c = H;
        }
        if (pos.reversed + requested > pos.amount) {
          anomalies.push({
            eventId: ev.id,
            seq,
            code: 'CLAWBACK_OVER_CAP',
            detail: `ρ ${pos.reversed} + ${requested} > a ${pos.amount}`,
          });
        }
        B -= amt;
        D += p + extraDebt;
        pos.offset -= p;
        pos.reversed = Math.min(pos.amount, pos.reversed + requested);
        cl.pointsDelta = neg(amt);
        cl.debtDelta = p + extraDebt;
        cl.debtRestored = p;
        cl.recovered = c;
        cl.offsetPositionId = pos.id;
        cl.offsetDelta = neg(p);
        break;
      }
    }
    classifications.push(cl);
  }

  if (expectedBalance !== undefined && expectedBalance !== B) {
    anomalies.push({
      eventId: '',
      seq,
      code: 'FINAL_BALANCE_MISMATCH',
      detail: `replayed B ${B} ≠ redeemablePoints ${expectedBalance}`,
    });
  }
  return { state: { B, D, seq }, positions, classifications, anomalies };
}
