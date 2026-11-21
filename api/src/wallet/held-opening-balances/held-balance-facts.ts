/**
 * HELD OPENING BALANCES — shared read helpers: outlet-code normalisation, outlet/wallet facts, the explicit
 * per-row STATE shown on the console and in the Daily Ops Digest (owner rule: no silent waits), digest figures.
 */
import { Prisma } from '@prisma/client';

/** PrismaService / PrismaClient / an interactive transaction — all satisfy this. */
type Db = Prisma.TransactionClient;

/**
 * Outlet-code normalisation used on BOTH sides (held rows are stored normalised; outlets are compared normalised):
 * trim, upper-case, remove internal whitespace. Leading zeros are KEPT ("00123" ≠ "123" — an exact-code
 * non-match is reported as "Not on portal", never guessed).
 */
export function normOutletCode(code: string): string {
  return String(code).trim().toUpperCase().replace(/\s+/g, '');
}

export type HeldRowState =
  | 'NOT_ON_PORTAL'
  | 'AWAITING_KYC'
  | 'WALLET_EMPTY'
  | 'NEEDS_APPLY_NOW'
  | 'WALLET_NOT_PREPARED'
  | 'AMBIGUOUS_OUTLET'
  | 'FAILED'
  | 'APPLIED'
  | 'CANCELLED';

export const HELD_STATE_LABEL: Record<HeldRowState, string> = {
  NOT_ON_PORTAL: 'Not on portal (no outlet with this code)',
  AWAITING_KYC: 'On portal — awaiting first KYC',
  WALLET_EMPTY: 'Wallet exists and empty — will apply now / applying',
  NEEDS_APPLY_NOW: 'Wallet has activity — needs Apply now',
  WALLET_NOT_PREPARED: 'Wallet not prepared — run the wallet backfill, then Apply now',
  AMBIGUOUS_OUTLET: 'More than one outlet matches this code — Gifsy must fix the outlet codes',
  FAILED: 'Failed',
  APPLIED: 'Applied',
  CANCELLED: 'Cancelled',
};

/** Every wallet figure the ONE pristine/activity predicate looks at (selected by heldOutletFacts AND the apply). */
export const HELD_WALLET_SELECT = {
  id: true,
  partnerId: true,
  redeemablePoints: true,
  debtPoints: true,
  earnedPoints: true,
  lockedPoints: true,
  redeemedPoints: true,
  expiredPoints: true,
  lifetimeEarned: true,
  lifetimeRedeemed: true,
  lifetimeExpired: true,
  movementSeq: true,
  _count: { select: { transactions: true, pointsLedger: true } },
} as const;

export type HeldWalletFacts = {
  id: string;
  partnerId: string;
  redeemablePoints: number;
  debtPoints: number;
  earnedPoints: number;
  lockedPoints: number;
  redeemedPoints: number;
  expiredPoints: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  lifetimeExpired: number;
  movementSeq: number;
  _count: { transactions: number; pointsLedger: number };
};

export interface HeldOutletFacts {
  name: string;
  partnerId: string | null;
  wallet: HeldWalletFacts | null;
  /** more than one live outlet of the tenant normalises to this code */
  ambiguous: boolean;
}

/**
 * THE single "empty wallet" predicate (audit A4) — used by the console state, the digest, the sweep, the
 * credit-confirm pre-step, the loader AND the apply itself (re-read under the wallet row lock): every balance /
 * counter / lifetime figure is 0, movementSeq is 0, and there is no wallet_transactions row and no points_ledger row.
 */
export function walletIsPristine(w: HeldWalletFacts): boolean {
  const figures = [
    w.redeemablePoints, w.debtPoints, w.earnedPoints, w.lockedPoints, w.redeemedPoints, w.expiredPoints,
    w.lifetimeEarned, w.lifetimeRedeemed, w.lifetimeExpired, w.movementSeq,
  ];
  return figures.every((n) => (n ?? 0) === 0) && w._count.transactions === 0 && w._count.pointsLedger === 0;
}

export function walletHasActivity(w: HeldWalletFacts): boolean {
  return !walletIsPristine(w);
}

/** Outlet + wallet facts for a set of (normalised) outlet codes of ONE tenant, keyed by normalised code. */
export async function heldOutletFacts(db: Db, clientId: string, codes: string[]): Promise<Map<string, HeldOutletFacts>> {
  const out = new Map<string, HeldOutletFacts>();
  const wanted = [...new Set(codes.map(normOutletCode))];
  if (wanted.length === 0) return out;
  const outlets = await db.$queryRaw<Array<{ outletCode: string; name: string; partnerId: string | null }>>`
    SELECT "outletCode", "name", "partnerId" FROM outlets
     WHERE "clientId" = ${clientId} AND "deletedAt" IS NULL
       AND upper(regexp_replace("outletCode", '\\s', '', 'g')) = ANY(${wanted}::text[])`;
  const partnerIds = [...new Set(outlets.map((o) => o.partnerId).filter((p): p is string => !!p))];
  const wallets: HeldWalletFacts[] = partnerIds.length
    ? await db.wallet.findMany({
        where: { partnerId: { in: partnerIds } },
        select: HELD_WALLET_SELECT,
      })
    : [];
  const wBy = new Map(wallets.map((w) => [w.partnerId, w]));
  for (const o of outlets) {
    const k = normOutletCode(o.outletCode);
    const prev = out.get(k);
    if (prev) {
      prev.ambiguous = true;
      continue;
    }
    out.set(k, { name: o.name, partnerId: o.partnerId, wallet: o.partnerId ? (wBy.get(o.partnerId) ?? null) : null, ambiguous: false });
  }
  return out;
}

/** The explicit state of a held row (PENDING rows are split by what they are waiting for). */
export function heldRowState(status: string, f: HeldOutletFacts | undefined): HeldRowState {
  if (status === 'APPLIED' || status === 'CANCELLED' || status === 'FAILED') return status;
  if (!f) return 'NOT_ON_PORTAL';
  if (f.ambiguous) return 'AMBIGUOUS_OUTLET';
  if (!f.partnerId || !f.wallet) return 'AWAITING_KYC';
  if (walletIsPristine(f.wallet)) return 'WALLET_EMPTY';
  return f.wallet.movementSeq === 0 ? 'WALLET_NOT_PREPARED' : 'NEEDS_APPLY_NOW';
}

/** Plain next step for a row (FAILED rows: depends on whether the wallet exists yet). */
export function heldNextStep(state: HeldRowState, f: HeldOutletFacts | undefined): string | null {
  switch (state) {
    case 'NOT_ON_PORTAL':
      return 'Applied automatically once the outlet is on the portal and its KYC is approved. Check the outlet code if it should already be there.';
    case 'AWAITING_KYC':
      return 'Applied automatically when the outlet’s KYC is approved (or its first credit is confirmed).';
    case 'WALLET_EMPTY':
      return 'Applied automatically within minutes (sweep) — or Apply now.';
    case 'NEEDS_APPLY_NOW':
      return 'Gifsy: Apply now (one opening-balance adjustment) or Cancel.';
    case 'WALLET_NOT_PREPARED':
      return 'The wallet has history the wallet backfill has not sequenced yet — run the wallet backfill for this program, then Apply now.';
    case 'AMBIGUOUS_OUTLET':
      return 'Fix the duplicate outlet codes, then Apply now.';
    case 'FAILED':
      return f?.wallet
        ? 'Fix the cause shown, then Apply now (or Cancel).'
        : 'Fix the cause shown (re-load the row if the passbook is wrong); it is not applied automatically again — once the wallet exists use Apply now, or Cancel.';
    default:
      return null;
  }
}

export interface HeldDigestFigures {
  totalRows: number;
  appliedInWindow: number;
  appliedInWindowPoints: number;
  waiting: number;
  waitingPoints: number;
  /** of `waiting`, by what they are waiting for */
  waitingByState: Record<'NOT_ON_PORTAL' | 'AWAITING_KYC' | 'WALLET_EMPTY' | 'NEEDS_APPLY_NOW' | 'WALLET_NOT_PREPARED' | 'AMBIGUOUS_OUTLET', number>;
  /** = waitingByState.NEEDS_APPLY_NOW (kept for the attention item) */
  waitingNeedsApplyNow: number;
  /** PENDING rows whose last automatic attempt hit a transient error (being retried) */
  retrying: number;
  failed: number;
  failedPoints: number;
  /** the digest window, for the "since the last report" wording */
  windowLabel?: string;
}

/** Daily Ops Digest figures for one tenant; null when the tenant has no held rows at all (section hidden). */
export async function heldDigestFigures(
  db: Db,
  clientId: string,
  window: { startMs: number; endMs: number; label?: string },
): Promise<HeldDigestFigures | null> {
  const groups = await db.heldOpeningBalance.groupBy({
    by: ['status'],
    where: { clientId },
    _count: { _all: true },
    _sum: { closingPoints: true },
  });
  const totalRows = groups.reduce((n, g) => n + g._count._all, 0);
  if (totalRows === 0) return null;
  const by = (s: string) => groups.find((g) => g.status === s);
  const applied = await db.heldOpeningBalance.aggregate({
    where: { clientId, status: 'APPLIED', appliedAt: { gte: new Date(window.startMs), lt: new Date(window.endMs) } },
    _count: { _all: true },
    _sum: { closingPoints: true },
  });
  const pending = await db.heldOpeningBalance.findMany({ where: { clientId, status: 'PENDING' }, select: { outletCode: true, lastError: true } });
  const waitingByState = { NOT_ON_PORTAL: 0, AWAITING_KYC: 0, WALLET_EMPTY: 0, NEEDS_APPLY_NOW: 0, WALLET_NOT_PREPARED: 0, AMBIGUOUS_OUTLET: 0 };
  for (let i = 0; i < pending.length; i += 1000) {
    const chunk = pending.slice(i, i + 1000);
    const facts = await heldOutletFacts(db, clientId, chunk.map((p) => p.outletCode));
    for (const p of chunk) {
      const s = heldRowState('PENDING', facts.get(normOutletCode(p.outletCode)));
      if (s in waitingByState) waitingByState[s as keyof typeof waitingByState] += 1;
    }
  }
  return {
    totalRows,
    appliedInWindow: applied._count._all,
    appliedInWindowPoints: applied._sum.closingPoints ?? 0,
    waiting: by('PENDING')?._count._all ?? 0,
    waitingPoints: by('PENDING')?._sum.closingPoints ?? 0,
    waitingByState,
    waitingNeedsApplyNow: waitingByState.NEEDS_APPLY_NOW,
    retrying: pending.filter((p) => !!p.lastError).length,
    failed: by('FAILED')?._count._all ?? 0,
    failedPoints: by('FAILED')?._sum.closingPoints ?? 0,
    ...(window.label ? { windowLabel: window.label } : {}),
  };
}
