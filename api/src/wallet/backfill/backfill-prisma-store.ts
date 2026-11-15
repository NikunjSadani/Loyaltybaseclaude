/**
 * Wallet Reversal Engine — WP6 Prisma adapter for the backfill runner and the verify job.
 *
 * READS: wallets / wallet_transactions / points_ledger / outlets / credit_batches / credit_reversals / positions /
 * allocations of ONE tenant (wallet tenant = channel_partners.clientId).
 * WRITES (APPLY only, via applyWalletPlan): wallet_transactions.{seq, pointsDelta, pointsLedgerId, reversedCreditTxId,
 * creditReversalId} on rows whose seq IS NULL; INSERT wallet_credit_positions + credit_reversal_allocations;
 * wallets.{debtPoints, movementSeq} guarded on (movementSeq = 0, debtPoints = 0, redeemablePoints = planned).
 * NEVER writes redeemablePoints, any counter, or any points_ledger row (lots) — zero balance change by construction.
 *
 * Lock order (design §5): advisory xact lock (job-wide, serialises concurrent backfill runs) → wallets row FOR UPDATE.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { BfLedgerRow, BfTenantContext, BfTxRow, BfWalletHistory, WalletPlan } from './backfill-plan';
import type { ApplyOutcome, BackfillStore } from './backfill-runner';
import { computeV0, V0Snapshot, VerifySnapshot } from './verify-checks';

type Db = PrismaClient | Prisma.TransactionClient;

export const BACKFILL_ADVISORY_KEY = 'wallet-reversal-engine:wp6-backfill';

const TX_SELECT = {
  id: true,
  walletId: true,
  transactionType: true,
  points: true,
  balanceBefore: true,
  balanceAfter: true,
  balanceType: true,
  referenceType: true,
  referenceId: true,
  description: true,
  metadata: true,
  createdAt: true,
  seq: true,
  pointsDelta: true,
  reversedCreditTxId: true,
  creditReversalId: true,
  pointsLedgerId: true,
} as const;

const LEDGER_SELECT = {
  id: true,
  walletId: true,
  transactionType: true,
  points: true,
  isExpired: true,
  sourceType: true,
  sourceId: true,
  notes: true,
  createdAt: true,
} as const;

const WALLET_COUNTERS = {
  id: true,
  partnerId: true,
  redeemablePoints: true,
  debtPoints: true,
  movementSeq: true,
  earnedPoints: true,
  lifetimeEarned: true,
  redeemedPoints: true,
  expiredPoints: true,
  lifetimeRedeemed: true,
  lifetimeExpired: true,
  lockedPoints: true,
} as const;

function toTx(t: Prisma.WalletTransactionGetPayload<{ select: typeof TX_SELECT }>): BfTxRow {
  return { ...t, transactionType: String(t.transactionType), metadata: t.metadata as unknown };
}

function toLedger(l: Prisma.PointsLedgerGetPayload<{ select: typeof LEDGER_SELECT }>): BfLedgerRow {
  return { ...l, transactionType: String(l.transactionType) };
}

async function loadHistories(db: Db, clientId: string, walletIds?: string[]): Promise<BfWalletHistory[]> {
  const walletWhere: Prisma.WalletWhereInput = { partner: { clientId }, ...(walletIds ? { id: { in: walletIds } } : {}) };
  const wallets = await db.wallet.findMany({ where: walletWhere, select: WALLET_COUNTERS, orderBy: { id: 'asc' } });
  if (wallets.length === 0) return [];
  const ids = wallets.map((w) => w.id);
  const [txs, ledgers, outlets, positions] = await Promise.all([
    db.walletTransaction.findMany({ where: { walletId: { in: ids } }, select: TX_SELECT }),
    db.pointsLedger.findMany({ where: { walletId: { in: ids } }, select: LEDGER_SELECT }),
    db.outlet.findMany({
      where: { clientId, partnerId: { in: wallets.map((w) => w.partnerId) } },
      select: { partnerId: true, outletCode: true },
    }),
    db.walletCreditPosition.groupBy({ by: ['walletId'], where: { walletId: { in: ids } }, _count: { _all: true } }),
  ]);
  const txBy = new Map<string, BfTxRow[]>();
  for (const t of txs) {
    const g = txBy.get(t.walletId);
    if (g) g.push(toTx(t));
    else txBy.set(t.walletId, [toTx(t)]);
  }
  const lBy = new Map<string, BfLedgerRow[]>();
  for (const l of ledgers) {
    const g = lBy.get(l.walletId);
    if (g) g.push(toLedger(l));
    else lBy.set(l.walletId, [toLedger(l)]);
  }
  const oBy = new Map<string, string[]>();
  for (const o of outlets) {
    if (!o.partnerId) continue;
    const g = oBy.get(o.partnerId);
    if (g) g.push(o.outletCode);
    else oBy.set(o.partnerId, [o.outletCode]);
  }
  const pBy = new Map(positions.map((p) => [p.walletId, p._count._all]));
  return wallets.map((w) => ({
    wallet: { id: w.id, partnerId: w.partnerId, clientId, redeemablePoints: w.redeemablePoints, debtPoints: w.debtPoints, movementSeq: w.movementSeq },
    txs: txBy.get(w.id) ?? [],
    ledgers: lBy.get(w.id) ?? [],
    currentOutletCodes: (oBy.get(w.partnerId) ?? []).sort(),
    existingPositionCount: pBy.get(w.id) ?? 0,
  }));
}

export class PrismaBackfillStore implements BackfillStore {
  constructor(private readonly prisma: PrismaClient) {}

  async currentDatabase(): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
    return rows[0]?.db ?? '';
  }

  async listTenants(): Promise<string[]> {
    const rows = await this.prisma.channelPartner.findMany({
      where: { wallets: { some: {} } },
      select: { clientId: true },
      distinct: ['clientId'],
    });
    return rows.map((r) => r.clientId).sort();
  }

  async loadTenantContext(clientId: string): Promise<BfTenantContext> {
    // Only the batches referenced by this tenant's credit-batch credits (VENDOR_IMPORT payout batches can be large).
    const refs = await this.prisma.walletTransaction.findMany({
      where: { wallet: { partner: { clientId } }, referenceType: 'CREDIT_BATCH', referenceId: { not: null } },
      select: { referenceId: true },
      distinct: ['referenceId'],
    });
    const batchIds = refs.map((r) => r.referenceId!).filter(Boolean);
    const [batches, reversals, allocs] = await Promise.all([
      this.prisma.creditBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, clientId: true, rows: true } }),
      this.prisma.creditReversal.findMany({
        where: { clientId, awardType: 'POINTS' },
        select: { id: true, clientId: true, batchId: true, outletId: true, fieldId: true, awardType: true, status: true, approvedPaise: true },
      }),
      this.prisma.creditReversalAllocation.findMany({ where: { creditReversal: { clientId } }, select: { creditReversalId: true } }),
    ]);
    return {
      clientId,
      batches: new Map(batches.map((b) => [b.id, { id: b.id, clientId: b.clientId, rows: b.rows as unknown }])),
      reversals: new Map(reversals.map((r) => [r.id, { ...r, awardType: String(r.awardType), status: String(r.status) }])),
      alreadyAllocatedReversalIds: new Set(allocs.map((a) => a.creditReversalId)),
    };
  }

  loadTenantHistories(clientId: string): Promise<BfWalletHistory[]> {
    return loadHistories(this.prisma, clientId);
  }

  async snapshotV0(clientId: string): Promise<V0Snapshot> {
    const wallets = await this.prisma.wallet.findMany({ where: { partner: { clientId } }, select: WALLET_COUNTERS });
    return computeV0(clientId, wallets);
  }

  async applyWalletPlan(walletId: string, clientId: string, decide: (fresh: BfWalletHistory) => WalletPlan | null): Promise<ApplyOutcome> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${BACKFILL_ADVISORY_KEY}, 0))`;
        await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
        const [fresh] = await loadHistories(tx, clientId, [walletId]);
        if (!fresh) return 'CHANGED';
        if (fresh.wallet.movementSeq > 0) return 'ALREADY_DONE';
        const plan = decide(fresh);
        if (!plan) return 'CHANGED';
        await writePlan(tx, plan);
        return 'APPLIED';
      },
      { timeout: 120_000, maxWait: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  /** Read-only snapshot for the verify job. */
  async loadVerifySnapshot(clientId: string): Promise<VerifySnapshot> {
    const wallets = await this.prisma.wallet.findMany({ where: { partner: { clientId } }, select: WALLET_COUNTERS });
    const ids = wallets.map((w) => w.id);
    const [txs, positions, allocations, payoutAllocations] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where: { walletId: { in: ids } },
        select: { id: true, walletId: true, seq: true, pointsDelta: true, balanceAfter: true, transactionType: true, referenceType: true, referenceId: true, points: true },
      }),
      this.prisma.walletCreditPosition.findMany({
        where: { walletId: { in: ids } },
        select: { id: true, walletId: true, creditTxId: true, amount: true, offsetPoints: true, reversedPoints: true, attribution: true },
      }),
      this.prisma.creditReversalAllocation.findMany({
        where: { position: { walletId: { in: ids } } },
        select: { positionId: true, creditReversalId: true, requested: true },
      }),
      this.prisma.payoutReversalAllocation.findMany({
        where: { creditReversal: { clientId } },
        select: { payoutEntryId: true, creditReversalId: true, state: true },
      }),
    ]);
    return {
      clientId,
      wallets,
      txs: txs.map((t) => ({ ...t, transactionType: String(t.transactionType) })),
      positions: positions.map((p) => ({ ...p, attribution: String(p.attribution) })),
      allocations,
      payoutAllocations: payoutAllocations.map((a) => ({ ...a, state: String(a.state) })),
    };
  }
}

/** Guarded writes for ONE planned wallet (caller holds the wallet row lock). Any guard miss throws → rollback. */
async function writePlan(tx: Prisma.TransactionClient, plan: WalletPlan): Promise<void> {
  for (const u of plan.txUpdates) {
    const r = await tx.walletTransaction.updateMany({
      where: { id: u.txId, walletId: plan.walletId, seq: null },
      data: {
        seq: u.seq,
        pointsDelta: u.pointsDelta,
        ...(u.pointsLedgerId ? { pointsLedgerId: u.pointsLedgerId } : {}),
        ...(u.reversedCreditTxId ? { reversedCreditTxId: u.reversedCreditTxId } : {}),
        ...(u.creditReversalId ? { creditReversalId: u.creditReversalId } : {}),
      },
    });
    if (r.count !== 1) throw new Error(`backfill guard: wallet_transactions ${u.txId} not updatable (seq already set?)`);
  }
  const positionIdByCredit = new Map<string, string>();
  for (const p of plan.positions) {
    const row = await tx.walletCreditPosition.create({
      data: {
        walletId: p.walletId,
        creditTxId: p.creditTxId,
        lotId: p.lotId,
        batchId: p.batchId,
        outletCode: p.outletCode,
        fieldId: p.fieldId,
        amount: p.amount,
        offsetPoints: p.offsetPoints,
        reversedPoints: p.reversedPoints,
        attribution: p.attribution,
      },
      select: { id: true },
    });
    positionIdByCredit.set(p.creditTxId, row.id);
  }
  for (const a of plan.allocations) {
    const positionId = positionIdByCredit.get(a.creditTxId);
    if (!positionId) throw new Error(`backfill guard: allocation for unknown position (credit ${a.creditTxId})`);
    await tx.creditReversalAllocation.create({
      data: {
        creditReversalId: a.creditReversalId,
        positionId,
        requested: a.requested,
        debtRestored: a.debtRestored,
        recovered: a.recovered,
        shortfall: a.shortfall,
      },
    });
  }
  const w = await tx.wallet.updateMany({
    where: { id: plan.walletId, movementSeq: 0, debtPoints: 0, redeemablePoints: plan.redeemablePoints },
    data: { debtPoints: plan.debtPoints, movementSeq: plan.movementSeq },
  });
  if (w.count !== 1) throw new Error(`backfill guard: wallet ${plan.walletId} state changed (movementSeq/debt/balance)`);
}
