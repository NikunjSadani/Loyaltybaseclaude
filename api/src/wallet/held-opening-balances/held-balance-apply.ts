/**
 * HELD OPENING BALANCES — posting a held vendor passbook into a wallet, inside the CALLER's transaction.
 *
 * Owner-approved 2026-11-21 (platform-wide, dormant unless rows exist). Used by:
 *  - KYC approval (kyc.service, wallet birth / first approval) and the pre-KYC credit confirm (credits.service,
 *    wallet get-or-create) → `applyHeldOpeningBalancesForPartner` — AUTOMATIC, only into a PRISTINE wallet;
 *  - the Gifsy console "Apply now" (held-opening-balances.service) → `applyHeldRowToPristineWallet` with MANUAL.
 *
 * Guarantees (owner rule: no silent pass-through, never partial):
 *  - the passbook is validated first (planHeldPassbook) — a bad passbook → FAILED with the reason, nothing written;
 *  - every write runs inside a SAVEPOINT: any error, or a post-write verification miss (redeemable ≠ closing,
 *    counters, row counts, FIFO lots) → ROLLBACK TO SAVEPOINT (nothing of the passbook survives) → FAILED with the
 *    reason + a bell to every active Gifsy admin. The caller's transaction (the KYC approval) is NOT aborted;
 *  - idempotent: the row is claimed with a guarded status update (PENDING/FAILED → APPLIED) under the wallet row
 *    lock, and the wallet must still be pristine under that lock — a second run finds it APPLIED / non-pristine;
 *  - V2 compatibility: when the tenant is on SHADOW/V2, or its wallets were already prepared by the WP6 backfill
 *    (any sequenced wallet), the new wallet is sequenced IN THE SAME transaction by the backfill's own planner and
 *    guarded writes (sequenceWalletInTx) → backfillStatus DONE (or BLOCKED with the planner's reason, exactly like a
 *    bulk-imported wallet) so the V2 switch guard counts it. On a LEGACY tenant that was never backfilled the rows
 *    stay un-sequenced exactly like the 2,281 bulk-imported wallets, and the tenant's backfill sequences them.
 */
import { Prisma } from '@prisma/client';
import { blockedReasonOf, planWallet } from '../backfill/backfill-plan';
import { sequenceWalletInTx } from '../backfill/backfill-prisma-store';
import type { ReversalEngineMode } from '../../tenant/tenant-settings.service';
import { HELD_METADATA_SRC, HELD_SOURCE_TYPE, planHeldPassbook } from './held-balance-events';

export type HeldTrigger = 'KYC_APPROVAL' | 'CREDIT_CONFIRM' | 'MANUAL';
/** Reads the tenant's reversal-engine mode through `tx`; may throw on a malformed setting (treated as LEGACY). */
export type ReadEngineMode = (clientId: string, tx: Prisma.TransactionClient) => Promise<ReversalEngineMode>;

export const HELD_AUDIT_ENTITY = 'HELD_OPENING_BALANCE';
export const GIFSY_HOME_CLIENT_ID = 'gifsy';

export interface HeldApplyOutcome {
  heldId: string;
  outletCode: string;
  status: 'APPLIED' | 'FAILED' | 'NOT_PRISTINE' | 'SKIPPED';
  reason?: string;
  walletId?: string;
  sequencing?: string;
  balanceBefore?: number;
  balanceAfter?: number;
}

type HeldRow = {
  id: string;
  clientId: string;
  outletCode: string;
  source: string;
  closingPoints: number;
  events: Prisma.JsonValue;
  eventTotals: Prisma.JsonValue | null;
  status: string;
};

const HELD_SELECT = {
  id: true,
  clientId: true,
  outletCode: true,
  source: true,
  closingPoints: true,
  events: true,
  eventTotals: true,
  status: true,
} as const;

export const heldConsoleUrl = (clientId: string) => `/gifsy/held-opening-balances?clientId=${encodeURIComponent(clientId)}`;

/** Bell (IN_APP) rows to every active Gifsy owner — written in `tx` so they commit with the FAILED status. */
export async function bellGifsyAdmins(
  tx: Prisma.TransactionClient,
  a: { clientId: string; subject: string; body: string; heldIds: string[] },
): Promise<number> {
  const admins = await tx.user.findMany({
    where: { role: 'GIFSY_ADMIN', clientId: GIFSY_HOME_CLIENT_ID, status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  if (admins.length === 0) return 0;
  const now = new Date();
  const r = await tx.notificationQueue.createMany({
    data: admins.map((u) => ({
      userId: u.id,
      channel: 'IN_APP' as const,
      status: 'SENT' as const,
      processedAt: now,
      subject: a.subject,
      body: a.body,
      variables: { event: 'HELD_OPENING_BALANCE_FAILED', clientId: a.clientId, heldIds: a.heldIds, url: heldConsoleUrl(a.clientId) },
    })),
  });
  return r.count;
}

/** Mark rows FAILED (guarded on their current status), audit, and bell the Gifsy admins. */
export async function markHeldFailed(
  tx: Prisma.TransactionClient,
  rows: Array<Pick<HeldRow, 'id' | 'clientId' | 'outletCode' | 'closingPoints'>>,
  reason: string,
  a: { trigger: HeldTrigger; actorId?: string | null; allowedFrom: Array<'PENDING' | 'FAILED'> },
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date();
  const marked: typeof rows = [];
  for (const r of rows) {
    const u = await tx.heldOpeningBalance.updateMany({
      where: { id: r.id, status: { in: a.allowedFrom } },
      data: { status: 'FAILED', failureReason: reason, failedAt: now },
    });
    if (u.count === 1) marked.push(r);
  }
  if (marked.length === 0) return;
  for (const r of marked) {
    await tx.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: HELD_AUDIT_ENTITY,
        entityId: r.id,
        actorId: a.actorId ?? null,
        newValues: { status: 'FAILED', failureReason: reason } as Prisma.InputJsonValue,
        metadata: { clientId: r.clientId, outletCode: r.outletCode, closingPoints: r.closingPoints, trigger: a.trigger } as Prisma.InputJsonValue,
      },
    });
  }
  const codes = marked.map((r) => r.outletCode).join(', ');
  await bellGifsyAdmins(tx, {
    clientId: marked[0].clientId,
    subject: `Held opening balance FAILED — ${marked[0].clientId}`,
    body: `Could not post the held opening balance for outlet ${codes}: ${reason}. Nothing was posted. Open Gifsy → Held Balances to fix and Apply now, or cancel.`,
    heldIds: marked.map((r) => r.id),
  });
}

/** A wallet with nothing on it: every figure 0, no movement and no lot. */
async function isPristine(tx: Prisma.TransactionClient, walletId: string): Promise<{ pristine: boolean; redeemable: number }> {
  const w = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
  const figures = [
    w.redeemablePoints, w.debtPoints, w.earnedPoints, w.lockedPoints, w.redeemedPoints, w.expiredPoints,
    w.lifetimeEarned, w.lifetimeRedeemed, w.lifetimeExpired, w.movementSeq,
  ];
  if (figures.some((n) => (n ?? 0) !== 0)) return { pristine: false, redeemable: w.redeemablePoints };
  const [tx1, pl1] = await Promise.all([
    tx.walletTransaction.findFirst({ where: { walletId }, select: { id: true } }),
    tx.pointsLedger.findFirst({ where: { walletId }, select: { id: true } }),
  ]);
  return { pristine: !tx1 && !pl1, redeemable: w.redeemablePoints };
}

/** Should this tenant's new wallets be sequenced now (V2 movement tracking)? */
async function shouldSequence(
  tx: Prisma.TransactionClient,
  clientId: string,
  readMode: ReadEngineMode,
): Promise<{ sequence: boolean; note?: string }> {
  let mode: ReversalEngineMode = 'LEGACY';
  let note: string | undefined;
  try {
    mode = await readMode(clientId, tx);
  } catch (e) {
    // A malformed engine flag never blocks activity (wallet.service M1) — LEGACY, and say so on the row.
    note = `engine setting unreadable (${e instanceof Error ? e.message : String(e)}) — treated as LEGACY`;
  }
  if (mode !== 'LEGACY') return { sequence: true, note };
  const backfilled = await tx.wallet.findFirst({
    where: { partner: { clientId }, movementSeq: { gt: 0 } },
    select: { id: true },
  });
  return { sequence: !!backfilled, note };
}

let savepointCounter = 0;

/**
 * Post ONE held row's full dated passbook into a PRISTINE wallet (caller's tx). Locks the wallet, re-reads the row,
 * validates, posts under a SAVEPOINT, verifies, sequences when required, claims the row. Never throws for a
 * held-balance problem (returns FAILED / NOT_PRISTINE / SKIPPED); a DB error outside the savepoint still propagates.
 */
export async function applyHeldRowToPristineWallet(
  tx: Prisma.TransactionClient,
  heldId: string,
  walletId: string,
  a: { trigger: HeldTrigger; actorId?: string | null; readMode: ReadEngineMode; allowedFrom: Array<'PENDING' | 'FAILED'> },
): Promise<HeldApplyOutcome> {
  await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
  const row = (await tx.heldOpeningBalance.findUnique({ where: { id: heldId }, select: HELD_SELECT })) as HeldRow | null;
  if (!row) return { heldId, outletCode: '?', status: 'SKIPPED', reason: 'held row not found' };
  if (!(a.allowedFrom as string[]).includes(row.status)) {
    return { heldId, outletCode: row.outletCode, status: 'SKIPPED', reason: `row is ${row.status}` };
  }
  const fail = async (reason: string): Promise<HeldApplyOutcome> => {
    await markHeldFailed(tx, [row], reason, { trigger: a.trigger, actorId: a.actorId, allowedFrom: a.allowedFrom });
    return { heldId, outletCode: row.outletCode, status: 'FAILED', reason, walletId };
  };

  const planned = planHeldPassbook(row.outletCode, row.closingPoints, row.events, row.eventTotals ?? undefined);
  if (!planned.ok) return fail(`the held passbook does not tie out — ${planned.reason}`);
  const plan = planned.plan;

  const state = await isPristine(tx, walletId);
  if (!state.pristine) {
    return {
      heldId,
      outletCode: row.outletCode,
      status: 'NOT_PRISTINE',
      reason: 'the wallet already has activity — use Apply now (one opening-balance adjustment)',
      walletId,
      balanceBefore: state.redeemable,
    };
  }

  const sp = `held_ob_${++savepointCounter}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
  try {
    const now = new Date();
    const meta = (sid: string) => ({ src: HELD_METADATA_SRC, batch: row.source, ref: sid, heldOpeningBalanceId: row.id });
    await tx.walletTransaction.createMany({
      data: plan.movements.map((m) => ({
        walletId,
        transactionType: m.walletTxType,
        points: m.points,
        balanceBefore: m.balanceBefore,
        balanceAfter: m.balanceAfter,
        balanceType: 'REDEEMABLE',
        referenceType: null,
        referenceId: null,
        description: m.label,
        metadata: meta(m.sourceId) as Prisma.InputJsonValue,
        createdAt: m.createdAt,
      })),
    });
    await tx.pointsLedger.createMany({
      data: plan.movements.map((m) => ({
        walletId,
        transactionType: m.ledgerType,
        points: m.points,
        remainingPoints: m.remainingPoints,
        expiresAt: null,
        isExpired: false,
        isClaimed: false,
        sourceType: HELD_SOURCE_TYPE,
        sourceId: m.sourceId,
        notes: m.label,
        createdAt: m.createdAt,
        updatedAt: m.createdAt,
      })),
    });
    const c = plan.counters;
    const upd = await tx.wallet.updateMany({
      where: { id: walletId, redeemablePoints: 0, earnedPoints: 0, redeemedPoints: 0, movementSeq: 0 },
      data: {
        redeemablePoints: c.redeemablePoints,
        earnedPoints: c.earnedPoints,
        lifetimeEarned: c.earnedPoints,
        redeemedPoints: c.redeemedPoints,
        lifetimeRedeemed: c.redeemedPoints,
        expiredPoints: c.expiredPoints,
        lifetimeExpired: c.expiredPoints,
        lastTransactionAt: c.lastTransactionAt,
      },
    });
    if (upd.count !== 1) throw new Error('the wallet changed while the passbook was being posted');

    // ── verify (non-tautological: re-read what the database now holds) ──
    const after = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
    if (after.redeemablePoints !== row.closingPoints) {
      throw new Error(`wallet balance after posting is ${after.redeemablePoints} pts, expected the closing ${row.closingPoints} pts`);
    }
    if (after.earnedPoints !== c.earnedPoints || after.redeemedPoints !== c.redeemedPoints || after.expiredPoints !== c.expiredPoints) {
      throw new Error('wallet counters after posting do not match the passbook totals');
    }
    const [txCount, plCount, lots] = await Promise.all([
      tx.walletTransaction.count({ where: { walletId } }),
      tx.pointsLedger.count({ where: { walletId } }),
      tx.pointsLedger.aggregate({ where: { walletId, isExpired: false, points: { gt: 0 } }, _sum: { remainingPoints: true } }),
    ]);
    if (txCount !== plan.movements.length || plCount !== plan.movements.length) {
      throw new Error(`posted ${txCount} passbook rows / ${plCount} ledger rows, expected ${plan.movements.length}`);
    }
    const remaining = lots._sum.remainingPoints ?? 0;
    if (remaining !== Math.max(row.closingPoints, 0)) {
      throw new Error(`FIFO lots hold ${remaining} pts, expected ${Math.max(row.closingPoints, 0)}`);
    }

    // ── V2 movement sequencing (same planner + guarded writes as the WP6 backfill) ──
    const seqDecision = await shouldSequence(tx, row.clientId, a.readMode);
    let sequencing = 'LEGACY_UNSEQUENCED';
    if (seqDecision.sequence) {
      const s = await sequenceWalletInTx(tx, walletId, row.clientId, planWallet, blockedReasonOf);
      sequencing = s.status === 'DONE' ? 'SEQUENCED' : s.status === 'BLOCKED' ? `BLOCKED: ${s.reason}` : 'NOOP';
      if (s.status === 'DONE') {
        const seqd = await tx.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { redeemablePoints: true, movementSeq: true } });
        if (seqd.redeemablePoints !== row.closingPoints || seqd.movementSeq !== plan.movements.length) {
          throw new Error('sequencing changed the wallet balance or left rows un-sequenced');
        }
      }
    }
    if (seqDecision.note) sequencing += ` (${seqDecision.note})`;

    // ── claim (idempotency: only from the allowed status) ──
    const claimed = await tx.heldOpeningBalance.updateMany({
      where: { id: row.id, status: { in: a.allowedFrom } },
      data: {
        status: 'APPLIED',
        appliedAt: now,
        appliedWalletId: walletId,
        applyMode: 'FULL_PASSBOOK',
        appliedBy: a.trigger === 'MANUAL' ? (a.actorId ?? 'MANUAL') : a.trigger,
        sequencing,
        failureReason: null,
        failedAt: null,
      },
    });
    if (claimed.count !== 1) throw new Error('the held row changed meanwhile (already applied or cancelled)');
    await tx.auditLog.create({
      data: {
        action: 'UPDATE',
        entityType: HELD_AUDIT_ENTITY,
        entityId: row.id,
        actorId: a.actorId ?? null,
        oldValues: { status: row.status } as Prisma.InputJsonValue,
        newValues: { status: 'APPLIED', walletId, applyMode: 'FULL_PASSBOOK', balanceAfter: row.closingPoints } as Prisma.InputJsonValue,
        metadata: {
          clientId: row.clientId,
          outletCode: row.outletCode,
          source: row.source,
          trigger: a.trigger,
          events: plan.movements.length,
          totals: plan.totals,
          sequencing,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    return { heldId, outletCode: row.outletCode, status: 'APPLIED', walletId, sequencing, balanceBefore: 0, balanceAfter: row.closingPoints };
  } catch (e) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
    return fail(`posting rolled back — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * AUTOMATIC apply at wallet birth / KYC approval: every PENDING row for the partner's outlets, into its wallet when
 * that wallet is pristine. Dormant (2 indexed reads) when the tenant has no rows. A wallet that already has activity
 * leaves the row PENDING (it needs an explicit Gifsy "Apply now" — listed on the console + digest).
 * More than one PENDING row for one partner (they would pool into one wallet) → all FAILED with the reason.
 */
export async function applyHeldOpeningBalancesForPartner(
  tx: Prisma.TransactionClient,
  a: { partnerId: string; clientId: string; trigger: Exclude<HeldTrigger, 'MANUAL'>; actorId?: string | null; readMode: ReadEngineMode },
): Promise<HeldApplyOutcome[]> {
  const outlets = await tx.outlet.findMany({
    where: { partnerId: a.partnerId, clientId: a.clientId, deletedAt: null },
    select: { outletCode: true },
  });
  if (outlets.length === 0) return [];
  const rows = await tx.heldOpeningBalance.findMany({
    where: { clientId: a.clientId, outletCode: { in: outlets.map((o) => o.outletCode) }, status: 'PENDING' },
    select: HELD_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (rows.length === 0) return [];
  const wallet = await tx.wallet.findFirst({ where: { partnerId: a.partnerId }, select: { id: true } });
  if (!wallet) return rows.map((r) => ({ heldId: r.id, outletCode: r.outletCode, status: 'SKIPPED' as const, reason: 'no wallet yet' }));
  if (rows.length > 1) {
    const reason =
      `the outlet owner has ${rows.length} held opening balances (${rows.map((r) => `${r.outletCode}/${r.source}`).join(', ')}) — ` +
      'they would pool into ONE wallet; Gifsy must cancel all but one (or merge them into one row) and then Apply now';
    await markHeldFailed(tx, rows, reason, { trigger: a.trigger, actorId: a.actorId, allowedFrom: ['PENDING'] });
    return rows.map((r) => ({ heldId: r.id, outletCode: r.outletCode, status: 'FAILED' as const, reason, walletId: wallet.id }));
  }
  return [
    await applyHeldRowToPristineWallet(tx, rows[0].id, wallet.id, {
      trigger: a.trigger,
      actorId: a.actorId,
      readMode: a.readMode,
      allowedFrom: ['PENDING'],
    }),
  ];
}
