/**
 * HELD OPENING BALANCES — shared read helpers (console list/preview + the Daily Ops Digest runner, which calls
 * `heldDigestFigures` with its own PrismaService so the digest needs no new DI).
 */
import { HeldOpeningBalanceStatus, Prisma } from '@prisma/client';

/** PrismaService / PrismaClient / an interactive transaction — all satisfy this. */
type Db = Prisma.TransactionClient;

export interface HeldDigestFigures {
  totalRows: number;
  appliedInWindow: number;
  appliedInWindowPoints: number;
  waiting: number;
  waitingPoints: number;
  /** PENDING rows whose outlet already has a wallet with activity → need a Gifsy "Apply now" */
  waitingNeedsApplyNow: number;
  failed: number;
  failedPoints: number;
}

export type HeldWalletFacts = {
  id: string;
  partnerId: string;
  redeemablePoints: number;
  earnedPoints: number;
  redeemedPoints: number;
  movementSeq: number;
  _count: { transactions: number };
};

export function walletHasActivity(w: HeldWalletFacts): boolean {
  return w._count.transactions > 0 || w.redeemablePoints !== 0 || w.earnedPoints !== 0 || w.redeemedPoints !== 0 || w.movementSeq > 0;
}

/** Outlet + wallet facts for a set of outlet codes of ONE tenant (tenant-scoped outlet lookup). */
export async function heldOutletFacts(
  db: Db,
  clientId: string,
  codes: string[],
): Promise<Map<string, { name: string; partnerId: string | null; wallet: HeldWalletFacts | null }>> {
  const out = new Map<string, { name: string; partnerId: string | null; wallet: HeldWalletFacts | null }>();
  if (codes.length === 0) return out;
  const outlets = await db.outlet.findMany({
    where: { clientId, outletCode: { in: codes }, deletedAt: null },
    select: { outletCode: true, name: true, partnerId: true },
  });
  const partnerIds = [...new Set(outlets.map((o) => o.partnerId).filter((p): p is string => !!p))];
  const wallets: HeldWalletFacts[] = partnerIds.length
    ? await db.wallet.findMany({
        where: { partnerId: { in: partnerIds } },
        select: {
          id: true, partnerId: true, redeemablePoints: true, earnedPoints: true, redeemedPoints: true, movementSeq: true,
          _count: { select: { transactions: true } },
        },
      })
    : [];
  const wBy = new Map(wallets.map((w) => [w.partnerId, w]));
  for (const o of outlets) out.set(o.outletCode, { name: o.name, partnerId: o.partnerId, wallet: o.partnerId ? (wBy.get(o.partnerId) ?? null) : null });
  return out;
}

/** Daily Ops Digest figures for one tenant; null when the tenant has no held rows at all (section hidden). */
export async function heldDigestFigures(
  db: Db,
  clientId: string,
  window: { startMs: number; endMs: number },
): Promise<HeldDigestFigures | null> {
  const groups = await db.heldOpeningBalance.groupBy({
    by: ['status'],
    where: { clientId },
    _count: { _all: true },
    _sum: { closingPoints: true },
  });
  const totalRows = groups.reduce((n, g) => n + g._count._all, 0);
  if (totalRows === 0) return null;
  const by = (s: HeldOpeningBalanceStatus) => groups.find((g) => g.status === s);
  const applied = await db.heldOpeningBalance.aggregate({
    where: { clientId, status: 'APPLIED', appliedAt: { gte: new Date(window.startMs), lt: new Date(window.endMs) } },
    _count: { _all: true },
    _sum: { closingPoints: true },
  });
  const pending = await db.heldOpeningBalance.findMany({ where: { clientId, status: 'PENDING' }, select: { outletCode: true } });
  let needs = 0;
  for (let i = 0; i < pending.length; i += 1000) {
    const facts = await heldOutletFacts(db, clientId, pending.slice(i, i + 1000).map((p) => p.outletCode));
    for (const f of facts.values()) if (f.wallet && walletHasActivity(f.wallet)) needs += 1;
  }
  return {
    totalRows,
    appliedInWindow: applied._count._all,
    appliedInWindowPoints: applied._sum.closingPoints ?? 0,
    waiting: by('PENDING')?._count._all ?? 0,
    waitingPoints: by('PENDING')?._sum.closingPoints ?? 0,
    waitingNeedsApplyNow: needs,
    failed: by('FAILED')?._count._all ?? 0,
    failedPoints: by('FAILED')?._sum.closingPoints ?? 0,
  };
}
