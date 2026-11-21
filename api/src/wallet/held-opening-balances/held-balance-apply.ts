/**
 * HELD OPENING BALANCES — posting a held vendor passbook into a wallet. Owner-approved 2026-11-21 (platform-wide,
 * dormant unless rows exist). Fix round 2026-11-21 (dual audit): V2-only, OWN transactions, never inside the KYC
 * approval / credit confirm transaction.
 *
 * Triggers (all call `applyHeldRow` in its OWN transaction — a held-balance error or slowness can never fail or slow
 * the business transaction that triggered it):
 *  - KYC approval → kyc.service runs `runHeldForPartner` right AFTER the approval commits (post-commit, best effort);
 *  - credit confirm → credits.service runs `prepareHeldBeforeCredit` BEFORE its confirm transaction: a held row whose
 *    outlet has no wallet / an empty wallet is applied FIRST (wallet created if needed), so the dated history always
 *    sits UNDER the new credit. (The alternative — inserting a back-dated passbook below credits that already landed —
 *    would rewrite existing balance chains and is not done.) If that apply fails, the credit still lands and the row
 *    is FAILED with its reason (loud) → Gifsy fixes it and uses Apply now;
 *  - the periodic sweep (HeldOpeningBalancesSweepWorker) → every PENDING row whose wallet exists and is EMPTY
 *    (a missed post-commit trigger, a row loaded after approval, a transient error being retried);
 *  - Gifsy "Apply now" (held-opening-balances.service) → MANUAL, also onto a wallet with activity (adjustment).
 *
 * Guarantees:
 *  - ONE transaction per row: lock the wallet row, then the held row (FOR UPDATE); validate; post; verify (balance =
 *    closing, counters, row counts, FIFO); SEQUENCE the wallet with the WP6 backfill planner (V2 is the only engine —
 *    a BLOCKED plan is a failure); claim the row. Any problem → the whole transaction rolls back (nothing partial);
 *  - deterministic problems (HeldApplyError) → FAILED with the reason, audit + bell to every active Gifsy admin;
 *    transient errors (DB / timeout) → the row stays PENDING with `lastError`, retried by the sweep, and becomes
 *    FAILED after HELD_MAX_ATTEMPTS;
 *  - never twice: the DB allows ONE live (PENDING/FAILED/APPLIED) row per outlet, a wallet that already received a
 *    held balance is refused, and the wallet must be pristine under its row lock for the full passbook.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { blockedReasonOf, planWallet } from '../backfill/backfill-plan';
import { sequenceWalletInTx } from '../backfill/backfill-prisma-store';
import { HELD_METADATA_SRC, HELD_SOURCE_TYPE, planHeldPassbook } from './held-balance-events';
import { heldOutletFacts, normOutletCode, walletHasActivity } from './held-balance-facts';

export type HeldTrigger = 'KYC_APPROVAL' | 'CREDIT_CONFIRM' | 'SWEEP' | 'MANUAL';
type Db = PrismaClient | Prisma.TransactionClient;
type TxRunner = Pick<PrismaClient, '$transaction'> & Prisma.TransactionClient;

export const HELD_AUDIT_ENTITY = 'HELD_OPENING_BALANCE';
export const GIFSY_HOME_CLIENT_ID = 'gifsy';
export const HELD_MAX_ATTEMPTS = 5;
const TX_OPTS = { timeout: 60_000, maxWait: 15_000 };

/** A deterministic held-balance problem (the row becomes FAILED with this message). */
export class HeldApplyError extends Error {}

export interface HeldApplyOutcome {
  heldId: string;
  outletCode: string;
  status: 'APPLIED' | 'FAILED' | 'NEEDS_APPLY_NOW' | 'NO_WALLET' | 'RETRYING' | 'SKIPPED';
  reason?: string;
  walletId?: string;
  applyMode?: 'FULL_PASSBOOK' | 'OPENING_ADJUSTMENT';
  sequencing?: string;
  balanceBefore?: number;
  balanceAfter?: number;
}

/** The engine adjustment used by Apply now on a wallet with activity (WalletService.postHeldOpeningAdjustment). */
export type HeldAdjust = (
  tx: Prisma.TransactionClient,
  a: { partnerId: string; points: number; description: string; sourceId: string; metadata: Prisma.InputJsonValue },
) => Promise<{ transactionId: string; newRedeemable: number }>;

export const heldConsoleUrl = (clientId: string) => `/gifsy/held-opening-balances?clientId=${encodeURIComponent(clientId)}`;

/** Retailer-facing wording of the Apply-now adjustment: plain, with the vendor closing's as-of date (never the slug). */
export function heldAdjustmentLabel(asOfDate: Date | null): string {
  if (!asOfDate) return 'Opening balance from previous programme';
  const d = new Date(asOfDate);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `Opening balance from previous programme (as of ${d.getUTCDate()} ${mon} ${d.getUTCFullYear()})`;
}

/** Bell (IN_APP) rows to every active Gifsy owner. */
async function bellGifsyAdmins(db: Db, a: { clientId: string; subject: string; body: string; heldIds: string[] }): Promise<void> {
  const admins = await db.user.findMany({
    where: { role: 'GIFSY_ADMIN', clientId: GIFSY_HOME_CLIENT_ID, status: 'ACTIVE', deletedAt: null },
    select: { id: true },
  });
  if (admins.length === 0) return;
  const now = new Date();
  await db.notificationQueue.createMany({
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
}

/** Mark rows FAILED (guarded on their current status) in ONE transaction, with audit rows + a bell. */
export async function markHeldFailed(
  prisma: TxRunner,
  rows: Array<{ id: string; clientId: string; outletCode: string; closingPoints: number }>,
  reason: string,
  a: { trigger: HeldTrigger; actorId?: string | null; allowedFrom: Array<'PENDING' | 'FAILED'> },
): Promise<void> {
  if (rows.length === 0) return;
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const marked: typeof rows = [];
    for (const r of rows) {
      const u = await tx.heldOpeningBalance.updateMany({
        where: { id: r.id, status: { in: a.allowedFrom } },
        data: { status: 'FAILED', failureReason: reason, failedAt: now, lastAttemptAt: now },
      });
      if (u.count === 1) marked.push(r);
    }
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
    if (marked.length > 0) {
      await bellGifsyAdmins(tx, {
        clientId: marked[0].clientId,
        subject: `Held opening balance FAILED — ${marked[0].clientId}`,
        body: `Could not post the held opening balance for outlet ${marked.map((r) => r.outletCode).join(', ')}: ${reason}. Nothing was posted. Open Gifsy → Held Balances.`,
        heldIds: marked.map((r) => r.id),
      });
    }
  }, TX_OPTS);
}

/** A transient error: keep PENDING (retried by the sweep) until HELD_MAX_ATTEMPTS, then FAILED. */
async function recordTransient(prisma: TxRunner, row: { id: string; clientId: string; outletCode: string; closingPoints: number; status: string }, err: string, trigger: HeldTrigger, actorId?: string | null) {
  const cur = await prisma.heldOpeningBalance.findUnique({ where: { id: row.id }, select: { attempts: true, status: true } });
  if (!cur || (cur.status !== 'PENDING' && cur.status !== 'FAILED')) return 'SKIPPED' as const;
  const attempts = cur.attempts + 1;
  if (attempts >= HELD_MAX_ATTEMPTS) {
    await prisma.heldOpeningBalance.updateMany({ where: { id: row.id }, data: { attempts } });
    await markHeldFailed(prisma, [row], `gave up after ${attempts} attempts — last error: ${err}`, { trigger, actorId, allowedFrom: ['PENDING', 'FAILED'] });
    return 'FAILED' as const;
  }
  await prisma.heldOpeningBalance.updateMany({
    where: { id: row.id, status: { in: ['PENDING', 'FAILED'] } },
    data: { attempts, lastAttemptAt: new Date(), lastError: err },
  });
  return 'RETRYING' as const;
}

async function isPristine(tx: Prisma.TransactionClient, walletId: string): Promise<{ pristine: boolean; redeemable: number }> {
  const w = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
  const figures = [
    w.redeemablePoints, w.debtPoints, w.earnedPoints, w.lockedPoints, w.redeemedPoints, w.expiredPoints,
    w.lifetimeEarned, w.lifetimeRedeemed, w.lifetimeExpired, w.movementSeq,
  ];
  if (figures.some((n) => (n ?? 0) !== 0)) return { pristine: false, redeemable: w.redeemablePoints };
  const [t, l] = await Promise.all([
    tx.walletTransaction.findFirst({ where: { walletId }, select: { id: true } }),
    tx.pointsLedger.findFirst({ where: { walletId }, select: { id: true } }),
  ]);
  return { pristine: !t && !l, redeemable: w.redeemablePoints };
}

type LiveRow = { id: string; clientId: string; outletCode: string; source: string; closingPoints: number; events: Prisma.JsonValue; eventTotals: Prisma.JsonValue | null; status: string; asOfDate: Date | null };

/** Post the full dated passbook into a pristine (locked) wallet, verify, sequence (V2). Throws HeldApplyError. */
async function postFullPassbook(tx: Prisma.TransactionClient, row: LiveRow, walletId: string): Promise<string> {
  const planned = planHeldPassbook(row.outletCode, row.closingPoints, row.events, row.eventTotals ?? undefined);
  if (!planned.ok) throw new HeldApplyError(`the held passbook does not tie out — ${planned.reason}`);
  const plan = planned.plan;
  const meta = (sid: string) => ({ src: HELD_METADATA_SRC, batch: row.source, ref: sid, heldOpeningBalanceId: row.id });
  await tx.walletTransaction.createMany({
    data: plan.movements.map((m) => ({
      walletId,
      transactionType: m.walletTxType,
      points: m.points,
      balanceBefore: m.balanceBefore,
      balanceAfter: m.balanceAfter,
      balanceType: 'REDEEMABLE',
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
  if (upd.count !== 1) throw new HeldApplyError('the wallet changed while the passbook was being posted');

  // verify against what the database now holds (non-tautological)
  const after = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
  if (after.redeemablePoints !== row.closingPoints) {
    throw new HeldApplyError(`wallet balance after posting is ${after.redeemablePoints} pts, expected the closing ${row.closingPoints} pts`);
  }
  if (after.earnedPoints !== c.earnedPoints || after.redeemedPoints !== c.redeemedPoints || after.expiredPoints !== c.expiredPoints) {
    throw new HeldApplyError('wallet counters after posting do not match the passbook totals');
  }
  const [txCount, plCount, lots] = await Promise.all([
    tx.walletTransaction.count({ where: { walletId } }),
    tx.pointsLedger.count({ where: { walletId } }),
    tx.pointsLedger.aggregate({ where: { walletId, isExpired: false, points: { gt: 0 } }, _sum: { remainingPoints: true } }),
  ]);
  if (txCount !== plan.movements.length || plCount !== plan.movements.length) {
    throw new HeldApplyError(`posted ${txCount} passbook rows / ${plCount} ledger rows, expected ${plan.movements.length}`);
  }
  const remaining = lots._sum.remainingPoints ?? 0;
  if (remaining !== Math.max(row.closingPoints, 0)) throw new HeldApplyError(`FIFO lots hold ${remaining} pts, expected ${Math.max(row.closingPoints, 0)}`);

  // V2 is the only engine: the wallet MUST be sequenced (same planner + guarded writes as the WP6 backfill).
  const s = await sequenceWalletInTx(tx, walletId, row.clientId, planWallet, blockedReasonOf);
  if (s.status !== 'DONE') {
    throw new HeldApplyError(`the wallet could not be sequenced for the V2 engine (${s.status === 'BLOCKED' ? s.reason : 'nothing to sequence'})`);
  }
  const seqd = await tx.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { redeemablePoints: true, movementSeq: true, backfillStatus: true } });
  if (seqd.redeemablePoints !== row.closingPoints || seqd.movementSeq !== plan.movements.length || seqd.backfillStatus !== 'DONE') {
    throw new HeldApplyError('sequencing changed the wallet balance or left rows un-sequenced');
  }
  return 'SEQUENCED';
}

/**
 * Apply ONE held row, in its OWN transaction. AUTO triggers never touch a wallet with activity (→ NEEDS_APPLY_NOW);
 * MANUAL (Apply now) posts one engine adjustment there via `adjust`. Never throws for a held-balance problem.
 */
export async function applyHeldRow(
  prisma: TxRunner,
  heldId: string,
  a: { trigger: HeldTrigger; actorId?: string | null; allowedFrom: Array<'PENDING' | 'FAILED'>; adjust?: HeldAdjust; note?: string | null },
): Promise<HeldApplyOutcome> {
  const row0 = await prisma.heldOpeningBalance.findUnique({ where: { id: heldId } });
  if (!row0) return { heldId, outletCode: '?', status: 'SKIPPED', reason: 'held row not found' };
  try {
    return await prisma.$transaction(async (tx) => {
      const f = (await heldOutletFacts(tx, row0.clientId, [row0.outletCode])).get(normOutletCode(row0.outletCode));
      if (f?.ambiguous) throw new HeldApplyError('more than one live outlet of this program matches the outlet code');
      if (!f?.partnerId || !f.wallet) {
        return { heldId, outletCode: row0.outletCode, status: 'NO_WALLET' as const, reason: f ? 'no wallet yet (awaiting KYC)' : 'no outlet with this code on the portal' };
      }
      const walletId = f.wallet.id;
      // lock order: wallet row, then the held row (every path uses it — no deadlock)
      await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${walletId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM held_opening_balances WHERE id = ${heldId} FOR UPDATE`;
      const row = (await tx.heldOpeningBalance.findUniqueOrThrow({ where: { id: heldId } })) as LiveRow;
      if (!(a.allowedFrom as string[]).includes(row.status)) {
        return { heldId, outletCode: row.outletCode, status: 'SKIPPED' as const, reason: `row is ${row.status}` };
      }
      // never twice: this wallet already received a held balance (any outlet / source)
      const prior = await tx.heldOpeningBalance.findFirst({
        where: { appliedWalletId: walletId, status: 'APPLIED', id: { not: row.id } },
        select: { outletCode: true, source: true },
      });
      if (prior) throw new HeldApplyError(`this wallet already received a held opening balance (${prior.outletCode} / ${prior.source})`);
      // pooling: another LIVE row for an outlet of the same owner would land in the same wallet
      const ownerOutlets = await tx.outlet.findMany({ where: { partnerId: f.partnerId, clientId: row.clientId, deletedAt: null }, select: { outletCode: true } });
      const siblings = await tx.heldOpeningBalance.findMany({
        where: { clientId: row.clientId, id: { not: row.id }, status: { in: ['PENDING', 'FAILED'] }, outletCode: { in: ownerOutlets.map((o) => normOutletCode(o.outletCode)) } },
        select: { outletCode: true },
      });
      if (siblings.length) {
        throw new HeldApplyError(`the outlet owner has other held opening balances (${siblings.map((s) => s.outletCode).join(', ')}) that would pool into ONE wallet — cancel all but one (or merge them), then Apply now`);
      }

      const now = new Date();
      const state = await isPristine(tx, walletId);
      let applyMode: 'FULL_PASSBOOK' | 'OPENING_ADJUSTMENT';
      let sequencing: string;
      const before = state.redeemable;
      if (state.pristine) {
        sequencing = await postFullPassbook(tx, row, walletId);
        applyMode = 'FULL_PASSBOOK';
      } else {
        if (a.trigger !== 'MANUAL' || !a.adjust) {
          return { heldId, outletCode: row.outletCode, status: 'NEEDS_APPLY_NOW' as const, walletId, balanceBefore: before, reason: 'the wallet already has activity — needs a Gifsy "Apply now"' };
        }
        const planned = planHeldPassbook(row.outletCode, row.closingPoints, row.events, row.eventTotals ?? undefined);
        if (!planned.ok) throw new HeldApplyError(`the held passbook does not tie out — ${planned.reason}`);
        const sid = `${row.outletCode}:held-open:${row.id}`;
        let mv: { newRedeemable: number };
        try {
          mv = await a.adjust(tx, {
            partnerId: f.partnerId,
            points: row.closingPoints,
            description: heldAdjustmentLabel(row.asOfDate),
            sourceId: sid,
            metadata: { src: HELD_METADATA_SRC, batch: row.source, ref: sid, heldOpeningBalanceId: row.id, mode: 'OPENING_ADJUSTMENT' },
          });
        } catch (e) {
          throw new HeldApplyError(e instanceof Error ? e.message : String(e));
        }
        const w = await tx.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { redeemablePoints: true, movementSeq: true } });
        if (w.redeemablePoints !== before + row.closingPoints || mv.newRedeemable !== w.redeemablePoints) {
          throw new HeldApplyError(`the balance moved from ${before} to ${w.redeemablePoints} pts, expected ${before + row.closingPoints} (wallet debt or a floor absorbed part of it)`);
        }
        if (w.movementSeq === 0) {
          throw new HeldApplyError('the wallet is not sequenced for the V2 engine (not prepared by the wallet backfill) — run the backfill, then Apply now');
        }
        applyMode = 'OPENING_ADJUSTMENT';
        sequencing = 'SEQUENCED (engine movement)';
      }
      const after = (await tx.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { redeemablePoints: true } })).redeemablePoints;
      const claimed = await tx.heldOpeningBalance.updateMany({
        where: { id: row.id, status: { in: a.allowedFrom } },
        data: {
          status: 'APPLIED',
          appliedAt: now,
          appliedWalletId: walletId,
          applyMode,
          appliedBy: a.trigger === 'MANUAL' ? (a.actorId ?? 'MANUAL') : a.trigger,
          sequencing,
          failureReason: null,
          failedAt: null,
          lastError: null,
          lastAttemptAt: now,
        },
      });
      if (claimed.count !== 1) throw new HeldApplyError('the held row changed meanwhile (already applied or cancelled)');
      await tx.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: HELD_AUDIT_ENTITY,
          entityId: row.id,
          actorId: a.actorId ?? null,
          oldValues: { status: row.status, balance: before } as Prisma.InputJsonValue,
          newValues: { status: 'APPLIED', walletId, applyMode, balance: after } as Prisma.InputJsonValue,
          metadata: { clientId: row.clientId, outletCode: row.outletCode, source: row.source, trigger: a.trigger, sequencing, ...(a.note ? { reason: a.note } : {}) } as Prisma.InputJsonValue,
        },
      });
      return { heldId, outletCode: row.outletCode, status: 'APPLIED' as const, walletId, applyMode, sequencing, balanceBefore: before, balanceAfter: after };
    }, TX_OPTS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof HeldApplyError) {
      await markHeldFailed(prisma, [row0], msg, { trigger: a.trigger, actorId: a.actorId, allowedFrom: a.allowedFrom });
      return { heldId, outletCode: row0.outletCode, status: 'FAILED', reason: msg };
    }
    const r = await recordTransient(prisma, row0, msg, a.trigger, a.actorId).catch(() => 'RETRYING' as const);
    return { heldId, outletCode: row0.outletCode, status: r === 'FAILED' ? 'FAILED' : r === 'SKIPPED' ? 'SKIPPED' : 'RETRYING', reason: msg };
  }
}

/**
 * AUTO apply for one partner (post-commit KYC approval, credit confirm pre-step): the partner's PENDING rows.
 * More than one (would pool into one wallet) → all FAILED. Never throws.
 */
export async function runHeldForPartner(
  prisma: TxRunner,
  a: { partnerId: string; clientId: string; trigger: Exclude<HeldTrigger, 'MANUAL'>; actorId?: string | null },
): Promise<HeldApplyOutcome[]> {
  const outlets = await prisma.outlet.findMany({ where: { partnerId: a.partnerId, clientId: a.clientId, deletedAt: null }, select: { outletCode: true } });
  if (outlets.length === 0) return [];
  const rows = await prisma.heldOpeningBalance.findMany({
    where: { clientId: a.clientId, outletCode: { in: [...new Set(outlets.map((o) => normOutletCode(o.outletCode)))] }, status: 'PENDING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (rows.length === 0) return [];
  if (rows.length > 1) {
    const reason = `the outlet owner has ${rows.length} held opening balances (${rows.map((r) => r.outletCode).join(', ')}) — they would pool into ONE wallet; cancel all but one (or merge them), then Apply now`;
    await markHeldFailed(prisma, rows, reason, { trigger: a.trigger, actorId: a.actorId, allowedFrom: ['PENDING'] });
    return rows.map((r) => ({ heldId: r.id, outletCode: r.outletCode, status: 'FAILED' as const, reason }));
  }
  return [await applyHeldRow(prisma, rows[0].id, { trigger: a.trigger, actorId: a.actorId, allowedFrom: ['PENDING'] })];
}

/** Credit-confirm PRE-STEP: for the batch's target partners, make sure a live held balance lands BEFORE the credit. */
export async function prepareHeldBeforeCredit(
  prisma: TxRunner,
  a: { clientId: string; outletCodes: string[]; actorId?: string | null; ensureWallet: (partnerId: string) => Promise<void> },
): Promise<HeldApplyOutcome[]> {
  const pendingAny = await prisma.heldOpeningBalance.count({ where: { clientId: a.clientId, status: 'PENDING' } });
  if (pendingAny === 0 || a.outletCodes.length === 0) return []; // dormant
  const out: HeldApplyOutcome[] = [];
  const facts = await heldOutletFacts(prisma, a.clientId, a.outletCodes);
  const partners = [...new Set([...facts.values()].map((f) => f.partnerId).filter((p): p is string => !!p))].sort();
  for (const partnerId of partners) {
    const f = [...facts.values()].find((x) => x.partnerId === partnerId)!;
    if (f.wallet && walletHasActivity(f.wallet)) continue; // nothing to protect: history can't go under prior activity
    const outlets = await prisma.outlet.findMany({ where: { partnerId, clientId: a.clientId, deletedAt: null }, select: { outletCode: true } });
    const live = await prisma.heldOpeningBalance.count({
      where: { clientId: a.clientId, status: 'PENDING', outletCode: { in: outlets.map((o) => normOutletCode(o.outletCode)) } },
    });
    if (live === 0) continue;
    if (!f.wallet) await a.ensureWallet(partnerId);
    out.push(...(await runHeldForPartner(prisma, { partnerId, clientId: a.clientId, trigger: 'CREDIT_CONFIRM', actorId: a.actorId })));
  }
  return out;
}

/** Periodic sweep: every PENDING row whose wallet exists and is EMPTY is applied now. Returns per-row outcomes. */
export async function sweepHeldOpeningBalances(prisma: TxRunner, opts: { limit?: number } = {}): Promise<HeldApplyOutcome[]> {
  const rows = await prisma.heldOpeningBalance.findMany({
    where: { status: 'PENDING' },
    orderBy: [{ lastAttemptAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    take: opts.limit ?? 500,
    select: { id: true, clientId: true, outletCode: true },
  });
  const out: HeldApplyOutcome[] = [];
  const byTenant = new Map<string, typeof rows>();
  for (const r of rows) byTenant.set(r.clientId, [...(byTenant.get(r.clientId) ?? []), r]);
  for (const [clientId, list] of byTenant) {
    const facts = await heldOutletFacts(prisma, clientId, list.map((r) => r.outletCode));
    for (const r of list) {
      const f = facts.get(normOutletCode(r.outletCode));
      if (!f?.wallet || f.ambiguous || walletHasActivity(f.wallet)) continue;
      out.push(await applyHeldRow(prisma, r.id, { trigger: 'SWEEP', allowedFrom: ['PENDING'] }));
    }
  }
  return out;
}
