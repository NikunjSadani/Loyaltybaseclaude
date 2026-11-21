/**
 * HELD OPENING BALANCES — the PURE passbook model (no Prisma, no clock).
 *
 * A held row carries the outlet's dated vendor passbook in EXACTLY the shape the bulk Earn & Burn import posted for
 * the 2,281 Bajaj wallets (BAJAJ-PROD-OUTLET-IMPORT.md §9b; job `bajaj-prod-earnburn`):
 *   events = [{ d:'YYYY-MM-DD', t:'EARN'|'ADJUST'|'REDEEM'|'EXPIRE', p:<signed whole points>, l:<label> }]
 * and this module reproduces that job's posting plan byte-for-byte:
 *   - order: by date, then EARN < ADJUST < REDEEM < EXPIRE on the same day;
 *   - createdAt: day 00:00:00Z + seq seconds (distinct, strictly increasing — a same-day redeem never shows above
 *     its funding earn);
 *   - running balanceBefore/After from 0;
 *   - FIFO `remainingPoints` on the positive lots (oldest-first consumption; a debit beyond every lot becomes debt
 *     that later lots absorb) — invariant Σ remaining == max(net, 0);
 *   - counters: earned/lifetimeEarned = Σ EARN, redeemed = Σ REDEEM, expired = Σ EXPIRE (ADJUST moves the balance
 *     only), lastTransactionAt = the last event's timestamp;
 *   - PointsLedger sourceType 'VENDOR_IMPORT', sourceId `<outletCode>:tl:<seq>`, lots non-expiring (expiresAt NULL).
 * Validation REFUSES (never repairs) anything that would not tie out: a wrong sign, a non-integer, a bad date, an
 * unknown type, an empty passbook, Σp ≠ closingPoints, or declared totals that disagree with the events.
 */

export type HeldEventType = 'EARN' | 'ADJUST' | 'REDEEM' | 'EXPIRE';

export interface HeldEvent {
  d: string;
  t: HeldEventType;
  p: number;
  l: string;
}

export interface HeldEventTotals {
  earn: number;
  adjust: number;
  redeem: number;
  expire: number;
  net: number;
  count: number;
}

/** One planned movement (one WalletTransaction + one PointsLedger row). */
export interface PlannedHeldMovement {
  seq: number;
  type: HeldEventType;
  walletTxType: 'CREDIT_POINTS_EARNED' | 'DEBIT_ADJUSTMENT' | 'DEBIT_REDEMPTION' | 'DEBIT_EXPIRY';
  ledgerType: 'EARN' | 'ADJUST' | 'REDEEM' | 'EXPIRE';
  points: number;
  balanceBefore: number;
  balanceAfter: number;
  remainingPoints: number;
  label: string;
  createdAt: Date;
  sourceId: string;
}

export interface HeldPassbookPlan {
  movements: PlannedHeldMovement[];
  totals: HeldEventTotals;
  /** wallet counters after posting (from a pristine wallet) */
  counters: {
    redeemablePoints: number;
    earnedPoints: number;
    redeemedPoints: number;
    expiredPoints: number;
    lastTransactionAt: Date;
  };
  /** the balance chain dipped below 0 at some point (vendor's own sequencing) */
  minBalance: number;
}

export const HELD_SOURCE_TYPE = 'VENDOR_IMPORT';
export const HELD_METADATA_SRC = 'held-opening-balance';

const WT_BY: Record<HeldEventType, PlannedHeldMovement['walletTxType']> = {
  EARN: 'CREDIT_POINTS_EARNED',
  ADJUST: 'DEBIT_ADJUSTMENT',
  REDEEM: 'DEBIT_REDEMPTION',
  EXPIRE: 'DEBIT_EXPIRY',
};
const RANK: Record<HeldEventType, number> = { EARN: 0, ADJUST: 1, REDEEM: 2, EXPIRE: 3 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Totals of a passbook (no validation). */
export function totalsOf(events: HeldEvent[]): HeldEventTotals {
  const t: HeldEventTotals = { earn: 0, adjust: 0, redeem: 0, expire: 0, net: 0, count: events.length };
  for (const e of events) {
    if (e.t === 'EARN') t.earn += e.p;
    else if (e.t === 'ADJUST') t.adjust += e.p;
    else if (e.t === 'REDEEM') t.redeem += -e.p;
    else if (e.t === 'EXPIRE') t.expire += -e.p;
    t.net += e.p;
  }
  return t;
}

/** Shape check for ONE event; returns the problem in plain words, or null. */
function eventProblem(e: unknown, i: number): string | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return `event ${i + 1} is not an object`;
  const r = e as Record<string, unknown>;
  if (typeof r.d !== 'string' || !DATE_RE.test(r.d) || Number.isNaN(Date.parse(`${r.d}T00:00:00.000Z`))) {
    return `event ${i + 1} has an invalid date (${JSON.stringify(r.d)})`;
  }
  if (typeof r.t !== 'string' || !(r.t in WT_BY)) return `event ${i + 1} has an unknown type (${JSON.stringify(r.t)})`;
  if (typeof r.p !== 'number' || !Number.isInteger(r.p) || r.p === 0) {
    return `event ${i + 1} points must be a non-zero whole number (got ${JSON.stringify(r.p)})`;
  }
  if (r.t === 'EARN' && r.p <= 0) return `event ${i + 1} is an EARN with negative points`;
  if (r.t !== 'EARN' && r.p >= 0) return `event ${i + 1} is a ${r.t} with positive points (debits must be negative)`;
  if (typeof r.l !== 'string' || r.l.trim() === '') return `event ${i + 1} has no label`;
  return null;
}

/**
 * Validate a held passbook against its declared closing (and optional declared totals) and build the exact posting
 * plan. `{ ok: false, reason }` on ANY inconsistency — the caller marks the row FAILED with that reason and writes
 * nothing.
 */
export function planHeldPassbook(
  outletCode: string,
  closingPoints: number,
  rawEvents: unknown,
  declaredTotals?: unknown,
): { ok: true; plan: HeldPassbookPlan } | { ok: false; reason: string } {
  if (!Number.isInteger(closingPoints)) return { ok: false, reason: `closing points ${closingPoints} is not a whole number` };
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) return { ok: false, reason: 'the passbook has no events' };
  for (let i = 0; i < rawEvents.length; i++) {
    const p = eventProblem(rawEvents[i], i);
    if (p) return { ok: false, reason: p };
  }
  const events = (rawEvents as HeldEvent[]).map((e) => ({ d: e.d, t: e.t, p: e.p, l: e.l }));
  const totals = totalsOf(events);
  if (totals.net !== closingPoints) {
    return { ok: false, reason: `the passbook adds up to ${totals.net} pts but the closing balance is ${closingPoints} pts` };
  }
  if (declaredTotals !== undefined && declaredTotals !== null) {
    const d = declaredTotals as Partial<HeldEventTotals>;
    for (const k of ['earn', 'adjust', 'redeem', 'expire', 'net', 'count'] as const) {
      if (d[k] !== undefined && d[k] !== totals[k]) {
        return { ok: false, reason: `declared total ${k}=${d[k]} disagrees with the events (${totals[k]})` };
      }
    }
  }

  // Same ordering as the bulk import (stable: equal keys keep manifest order).
  const evs = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.d < b.e.d ? -1 : a.e.d > b.e.d ? 1 : RANK[a.e.t] - RANK[b.e.t] || a.i - b.i))
    .map((x) => x.e);

  // FIFO lot mirror — identical algorithm to the import job.
  const rem = evs.map(() => 0);
  {
    const q: number[] = [];
    let debt = 0;
    evs.forEach((e, i) => {
      if (e.p > 0) {
        const take = Math.min(debt, e.p);
        debt -= take;
        rem[i] = e.p - take;
        if (rem[i] > 0) q.push(i);
      } else {
        let need = -e.p;
        while (need > 0 && q.length) {
          const k = q[0];
          const t = Math.min(rem[k], need);
          rem[k] -= t;
          need -= t;
          if (rem[k] === 0) q.shift();
        }
        debt += need;
      }
    });
  }

  let bal = 0;
  let minBalance = 0;
  let gross = 0;
  let redeem = 0;
  let expire = 0;
  let lastTs = new Date(0);
  const movements: PlannedHeldMovement[] = evs.map((e, i) => {
    const seq = i + 1;
    const before = bal;
    bal += e.p;
    minBalance = Math.min(minBalance, bal);
    if (e.t === 'EARN') gross += e.p;
    else if (e.t === 'REDEEM') redeem += -e.p;
    else if (e.t === 'EXPIRE') expire += -e.p;
    const createdAt = new Date(Date.parse(`${e.d}T00:00:00.000Z`) + seq * 1000);
    lastTs = createdAt;
    return {
      seq,
      type: e.t,
      walletTxType: WT_BY[e.t],
      ledgerType: e.t,
      points: e.p,
      balanceBefore: before,
      balanceAfter: bal,
      remainingPoints: rem[i],
      label: e.l,
      createdAt,
      sourceId: `${outletCode}:tl:${seq}`,
    };
  });

  const sumRem = rem.reduce((a, x) => a + x, 0);
  if (sumRem !== Math.max(bal, 0)) {
    return { ok: false, reason: `FIFO lots add up to ${sumRem} pts, expected ${Math.max(bal, 0)}` };
  }
  if (bal !== closingPoints) return { ok: false, reason: `running balance ${bal} ≠ closing ${closingPoints}` };

  return {
    ok: true,
    plan: {
      movements,
      totals,
      counters: { redeemablePoints: bal, earnedPoints: gross, redeemedPoints: redeem, expiredPoints: expire, lastTransactionAt: lastTs },
      minBalance,
    },
  };
}
