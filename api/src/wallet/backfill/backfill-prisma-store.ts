/**
 * Wallet Reversal Engine — WP6 Prisma adapter for the backfill runner and the verify job.
 *
 * READS: wallets / wallet_transactions / points_ledger / outlets / credit_batches / credit_reversals / positions /
 * allocations of ONE tenant (wallet tenant = channel_partners.clientId).
 * WRITES (APPLY only): wallet_transactions.{seq, pointsDelta, pointsLedgerId, reversedCreditTxId, creditReversalId} on
 * rows whose seq IS NULL; INSERT wallet_credit_positions + credit_reversal_allocations; wallets.{debtPoints, movementSeq,
 * backfillStatus = DONE} guarded on (movementSeq = 0, debtPoints = 0, redeemablePoints = planned) — applyWalletPlan;
 * wallets.{backfillStatus = BLOCKED, backfillBlockedReason} on un-sequenced wallets — markWalletsBlocked; the tenant's
 * program_settings `pointsReversalApprovalsPaused` row — set/clear pause; INSERT payout_reversal_allocations
 * (APPLIED_* rows of the WP5 planner) — applyPayoutPlan; audit_logs rows for each of those steps.
 * NEVER writes redeemablePoints, any counter, any points_ledger row (lots), any payout entry or reversal — zero balance
 * change by construction.
 *
 * Lock order (design §5): advisory xact lock (job-wide, serialises concurrent backfill runs) → credit_batches (payout
 * plan, ascending id) → wallets row FOR UPDATE.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { BfLedgerRow, BfTenantContext, BfTxRow, BfWalletHistory, WalletPlan } from './backfill-plan';
import type { ApplyOutcome, BackfillStore, PausePriorState, PayoutBackfillInput } from './backfill-runner';
import { computeV0, V0Snapshot, VerifySnapshot } from './verify-checks';
import type { PlannedPayoutAllocation } from '../../credits/payout-reversal-v2';
import { parsePointsReversalPause, POINTS_REVERSAL_PAUSE_SETTING_KEY } from '../../tenant/tenant-settings.service';
import { pointsReversalLockKey } from '../reversal-policy';

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
  backfillStatus: true,
} as const;

function toTx(t: Prisma.WalletTransactionGetPayload<{ select: typeof TX_SELECT }>): BfTxRow {
  return { ...t, transactionType: String(t.transactionType), metadata: t.metadata as unknown };
}

function toLedger(l: Prisma.PointsLedgerGetPayload<{ select: typeof LEDGER_SELECT }>): BfLedgerRow {
  return { ...l, transactionType: String(l.transactionType) };
}

/**
 * Load wallet histories. A wallet already sequenced (movementSeq > 0 — done by an earlier run or tracked by the engine
 * since) is loaded as COUNTS ONLY (+ its clawback rows, for the tenant-level reversal attribution): a re-run right
 * before a V2 flip only reads full history for wallets that still need work (owner Q5 — cheap / idempotent re-run).
 */
async function loadHistories(db: Db, clientId: string, walletIds?: string[]): Promise<BfWalletHistory[]> {
  const walletWhere: Prisma.WalletWhereInput = { partner: { clientId }, ...(walletIds ? { id: { in: walletIds } } : {}) };
  const allWallets = await db.wallet.findMany({ where: walletWhere, select: WALLET_COUNTERS, orderBy: { id: 'asc' } });
  if (allWallets.length === 0) return [];
  const sequencedIds = allWallets.filter((w) => w.movementSeq > 0).map((w) => w.id);
  const summaries = new Map<string, { txCount: number; sequencedCount: number; maxSeq: number }>();
  const clawbacksBy = new Map<string, BfTxRow[]>();
  if (sequencedIds.length > 0) {
    const [groups, clawbacks] = await Promise.all([
      db.walletTransaction.groupBy({
        by: ['walletId'],
        where: { walletId: { in: sequencedIds } },
        _count: { _all: true, seq: true },
        _max: { seq: true },
      }),
      db.walletTransaction.findMany({
        where: {
          walletId: { in: sequencedIds },
          transactionType: 'DEBIT_ADJUSTMENT',
          referenceType: 'CREDIT_REVERSAL',
          points: { lt: 0 },
        },
        select: TX_SELECT,
      }),
    ]);
    for (const g of groups) {
      summaries.set(g.walletId, { txCount: g._count._all, sequencedCount: g._count.seq, maxSeq: g._max.seq ?? 0 });
    }
    for (const t of clawbacks) {
      const list = clawbacksBy.get(t.walletId) ?? [];
      list.push(toTx(t));
      clawbacksBy.set(t.walletId, list);
    }
  }
  const sequencedOut: BfWalletHistory[] = allWallets
    .filter((w) => w.movementSeq > 0)
    .map((w) => ({
      wallet: { id: w.id, partnerId: w.partnerId, clientId, redeemablePoints: w.redeemablePoints, debtPoints: w.debtPoints, movementSeq: w.movementSeq },
      txs: clawbacksBy.get(w.id) ?? [],
      ledgers: [],
      currentOutletCodes: [],
      existingPositionCount: 0,
      sequencedSummary: summaries.get(w.id) ?? { txCount: 0, sequencedCount: 0, maxSeq: 0 },
    }));
  const wallets = allWallets.filter((w) => w.movementSeq === 0);
  if (wallets.length === 0) return sequencedOut;
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
  const fullOut: BfWalletHistory[] = wallets.map((w) => ({
    wallet: { id: w.id, partnerId: w.partnerId, clientId, redeemablePoints: w.redeemablePoints, debtPoints: w.debtPoints, movementSeq: w.movementSeq },
    txs: txBy.get(w.id) ?? [],
    ledgers: lBy.get(w.id) ?? [],
    currentOutletCodes: (oBy.get(w.partnerId) ?? []).sort(),
    existingPositionCount: pBy.get(w.id) ?? 0,
  }));
  return [...sequencedOut, ...fullOut].sort((a, b) => (a.wallet.id < b.wallet.id ? -1 : a.wallet.id > b.wallet.id ? 1 : 0));
}

/** WP5 payout planner input for one tenant (PAYOUT reversals, the entries of their batches, existing allocations). */
async function loadPayoutInput(db: Db, clientId: string): Promise<PayoutBackfillInput> {
  const reversals = await db.creditReversal.findMany({
    where: { clientId, awardType: 'PAYOUT' },
    select: {
      id: true,
      clientId: true,
      batchId: true,
      outletId: true,
      fieldId: true,
      status: true,
      awardType: true,
      approvedPaise: true,
      shortfallPaise: true,
      approvedAt: true,
      consumedPayoutEntryIds: true,
    },
    orderBy: { id: 'asc' },
  });
  if (reversals.length === 0) return { reversals: [], entries: [], existingAllocations: [] };
  const batchIds = [...new Set(reversals.map((r) => r.batchId))].sort();
  const [entries, existing] = await Promise.all([
    db.creditPayoutEntry.findMany({
      where: { clientId, batchId: { in: batchIds } },
      select: { id: true, clientId: true, batchId: true, outletId: true, fieldId: true, amountPaise: true, status: true, createdAt: true },
      orderBy: { id: 'asc' },
    }),
    db.payoutReversalAllocation.findMany({
      where: { creditReversal: { clientId } },
      select: { creditReversalId: true, payoutEntryId: true, state: true },
    }),
  ]);
  return {
    reversals: reversals.map((r) => ({
      ...r,
      status: String(r.status),
      awardType: String(r.awardType),
      shortfallPaise: r.shortfallPaise ?? 0n,
      consumedPayoutEntryIds: r.consumedPayoutEntryIds as unknown,
    })),
    entries: entries.map((e) => ({ ...e, status: String(e.status) })),
    existingAllocations: existing.map((a) => ({ ...a, state: String(a.state) })),
  };
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

  async markWalletsBlocked(clientId: string, items: { walletId: string; reason: string }[]): Promise<number> {
    if (items.length === 0) return 0;
    const at = new Date();
    let marked = 0;
    for (const it of items) {
      // Only a wallet that is still un-sequenced: a wallet the engine started tracking since is not blocked.
      const r = await this.prisma.wallet.updateMany({
        where: { id: it.walletId, movementSeq: 0, partner: { clientId } },
        data: { backfillStatus: 'BLOCKED', backfillBlockedReason: it.reason, backfillCheckedAt: at },
      });
      marked += r.count;
    }
    await this.prisma.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: 'WALLET_BACKFILL_BLOCKED',
        entityId: clientId,
        metadata: { marked, wallets: items.slice(0, 500) } as Prisma.InputJsonValue,
      },
    });
    return marked;
  }

  async getPointsReversalPause(clientId: string): Promise<PausePriorState> {
    const row = await this.prisma.programSetting.findUnique({
      where: { clientId_settingKey: { clientId, settingKey: POINTS_REVERSAL_PAUSE_SETTING_KEY } },
      select: { settingValue: true },
    });
    const p = parsePointsReversalPause(row ? row.settingValue : undefined);
    return { paused: p.paused, since: p.since };
  }

  async setPointsReversalPause(clientId: string, paused: boolean, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const value = paused
      ? { paused: true, since: now, by: 'wallet-backfill', reason }
      : { paused: false, clearedAt: now, by: 'wallet-backfill', reason };
    await this.prisma.$transaction(async (tx) => {
      await tx.programSetting.upsert({
        where: { clientId_settingKey: { clientId, settingKey: POINTS_REVERSAL_PAUSE_SETTING_KEY } },
        create: {
          clientId,
          settingKey: POINTS_REVERSAL_PAUSE_SETTING_KEY,
          settingValue: value,
          category: 'reversal-engine',
          description: 'POINTS reversal create/approve paused (wallet maintenance) — WALLET-REVERSAL-ENGINE-DESIGN.md §9.1',
        },
        update: { settingValue: value },
      });
      await tx.auditLog.create({
        data: { action: 'UPDATE', entityType: 'POINTS_REVERSAL_PAUSE', entityId: clientId, newValues: value as Prisma.InputJsonValue },
      });
    });
  }

  async drainPointsReversals(clientId: string): Promise<void> {
    const key = pointsReversalLockKey(clientId);
    // EXCLUSIVE vs the SHARED lock every POINTS reversal create/approve transaction takes before it reads the pause:
    // granted only once every reversal transaction that may have read "not paused" has committed / rolled back.
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  }

  loadPayoutBackfillInput(clientId: string): Promise<PayoutBackfillInput> {
    return loadPayoutInput(this.prisma, clientId);
  }

  async applyPayoutPlan(
    clientId: string,
    decide: (fresh: PayoutBackfillInput) => PlannedPayoutAllocation[] | null,
  ): Promise<{ outcome: 'APPLIED' | 'CHANGED'; inserted: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${BACKFILL_ADVISORY_KEY}, 0))`;
        // The same batch row locks every reversal create/approve takes (§5 lock order) → no reversal moves meanwhile.
        const revs = await tx.creditReversal.findMany({ where: { clientId, awardType: 'PAYOUT' }, select: { batchId: true } });
        const batchIds = [...new Set(revs.map((r) => r.batchId))].sort();
        if (batchIds.length > 0) {
          await tx.$queryRaw`SELECT id FROM credit_batches WHERE id IN (${Prisma.join(batchIds)}) ORDER BY id FOR UPDATE`;
        }
        const rows = decide(await loadPayoutInput(tx, clientId));
        if (!rows) return { outcome: 'CHANGED' as const, inserted: 0 };
        if (rows.length === 0) return { outcome: 'APPLIED' as const, inserted: 0 };
        // Every column the WP5 planner emits is passed through as-is (PlannedPayoutAllocation mirrors the allocation
        // columns) — a column the planner adds later (e.g. a receivable figure) is written without touching this file.
        const r = await tx.payoutReversalAllocation.createMany({
          data: rows.map((a) => ({ ...a })),
        });
        await tx.auditLog.create({
          data: {
            action: 'CREATE',
            entityType: 'PAYOUT_REVERSAL_ALLOCATION',
            entityId: clientId,
            metadata: JSON.parse(
              JSON.stringify({ step: 'BACKFILL', inserted: r.count, rows }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
            ) as Prisma.InputJsonValue,
          },
        });
        return { outcome: 'APPLIED' as const, inserted: r.count };
      },
      { timeout: 120_000, maxWait: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
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
    const payoutBackfill = await loadPayoutInput(this.prisma, clientId);
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
        select: { positionId: true, creditReversalId: true, requested: true, recovered: true, owed: true },
      }),
      this.prisma.payoutReversalAllocation.findMany({
        where: { creditReversal: { clientId } },
        select: { payoutEntryId: true, creditReversalId: true, state: true },
      }),
    ]);
    return {
      clientId,
      wallets: wallets.map((w) => ({ ...w, backfillStatus: w.backfillStatus ? String(w.backfillStatus) : null })),
      payoutBackfill,
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
        owed: a.owed,
        shortfall: a.shortfall,
      },
    });
  }
  const w = await tx.wallet.updateMany({
    where: { id: plan.walletId, movementSeq: 0, debtPoints: 0, redeemablePoints: plan.redeemablePoints },
    // DONE also clears a BLOCKED reason from an earlier run (Gifsy fixed the history and re-ran the backfill).
    data: {
      debtPoints: plan.debtPoints,
      movementSeq: plan.movementSeq,
      backfillStatus: 'DONE',
      backfillBlockedReason: null,
      backfillCheckedAt: new Date(),
    },
  });
  if (w.count !== 1) throw new Error(`backfill guard: wallet ${plan.walletId} state changed (movementSeq/debt/balance)`);
}
