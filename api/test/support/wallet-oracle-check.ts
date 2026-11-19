/**
 * Replays a wallet's COMMITTED v2 history (wallet_transactions in seq order) through the WP0 oracle
 * (api/src/wallet/reversal-model.ts) and compares every figure the engine persisted with what the oracle derives:
 * per-row pointsDelta / balanceAfter, final B / D / movementSeq, every position's O_X / ρ_X, every credit lot's
 * remaining, every reversal allocation's (p, c, owed, shortfall) — WALLET-REVERSAL-ENGINE-DESIGN.md §13 WP7 / §15.
 *
 * Whatever order the race produced, the committed seq order is a serial history; the engine is correct iff that
 * history, replayed through the oracle, lands exactly on the stored state.
 */
import { PrismaClient } from '@prisma/client';
import {
  checkInvariants,
  credit as oCredit,
  emptyModel,
  expire as oExpire,
  legacyDebtDebit as oLegacyDebit,
  reverse as oReverse,
  spend as oSpend,
  Step,
  WalletModel,
} from '../../src/wallet/reversal-model';

/** referenceType of the synthetic "backfilled vendor-import debt" row the fixtures seed (see seedDebt). */
export const SEED_DEBT_REFERENCE = 'WRE_E2E_SEED_DEBT';

export interface OracleReport {
  model: WalletModel;
  /** kind of each committed row in seq order (for order assertions) */
  kinds: string[];
  /** wallet transaction ids in seq order */
  txIds: string[];
  mismatches: string[];
}

export async function replayWalletThroughOracle(
  prisma: PrismaClient,
  walletId: string,
): Promise<OracleReport> {
  const wallet = await prisma.wallet.findUniqueOrThrow({
    where: { id: walletId },
  });
  const rows = await prisma.walletTransaction.findMany({
    where: { walletId },
    orderBy: { seq: 'asc' },
  });
  const positions = await prisma.walletCreditPosition.findMany({
    where: { walletId },
  });
  const posByCredit = new Map(positions.map((p) => [p.creditTxId, p]));
  const lots = await prisma.pointsLedger.findMany({ where: { walletId } });
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const txByLedger = new Map(
    rows.filter((r) => r.pointsLedgerId).map((r) => [r.pointsLedgerId!, r]),
  );
  const allocations = await prisma.creditReversalAllocation.findMany({
    where: { position: { walletId } },
  });

  const mismatches: string[] = [];
  const kinds: string[] = [];
  let m = emptyModel();

  rows.forEach((r, i) => {
    if (r.seq !== i + 1)
      mismatches.push(
        `row ${r.id}: seq ${r.seq} at position ${i + 1} (gap / duplicate / NULL)`,
      );
    let step: Step;
    try {
      if (r.referenceType === SEED_DEBT_REFERENCE) {
        kinds.push('SEED_DEBT');
        step = oLegacyDebit(m, -r.points);
      } else if (r.points > 0) {
        kinds.push(
          r.transactionType === 'CREDIT_POINTS_EARNED'
            ? 'CREDIT'
            : `CREDIT:${r.transactionType}`,
        );
        step = oCredit(m, {
          id: r.id,
          amount: r.points,
          reversible: posByCredit.has(r.id),
        });
      } else if (r.reversedCreditTxId) {
        kinds.push('REVERSAL');
        step = oReverse(m, r.reversedCreditTxId, -r.points);
      } else if (r.transactionType === 'DEBIT_EXPIRY') {
        kinds.push('EXPIRY');
        const owner = txByLedger.get(r.referenceId ?? '');
        if (!owner)
          throw new Error(
            `expiry row ${r.id}: lot ${r.referenceId} has no credit row`,
          );
        step = oExpire(m, owner.id);
      } else {
        kinds.push(
          r.transactionType === 'DEBIT_REDEMPTION'
            ? 'REDEEM'
            : `SPEND:${r.transactionType}`,
        );
        step = oSpend(m, -r.points);
      }
    } catch (e) {
      mismatches.push(
        `row ${r.id} (seq ${r.seq}): oracle refused the committed movement — ${(e as Error).message}`,
      );
      return;
    }
    if (step.movement.pointsDelta !== r.pointsDelta) {
      mismatches.push(
        `row seq ${r.seq}: pointsDelta db=${r.pointsDelta} oracle=${step.movement.pointsDelta}`,
      );
    }
    if (step.model.state.B !== r.balanceAfter) {
      mismatches.push(
        `row seq ${r.seq}: balanceAfter db=${r.balanceAfter} oracle=${step.model.state.B}`,
      );
    }
    if (r.balanceBefore !== m.state.B) {
      mismatches.push(
        `row seq ${r.seq}: balanceBefore db=${r.balanceBefore} oracle=${m.state.B}`,
      );
    }
    if (step.movement.kind === 'REVERSAL' && r.creditReversalId) {
      const pos = posByCredit.get(r.reversedCreditTxId!);
      const alloc = allocations.find(
        (a) =>
          a.creditReversalId === r.creditReversalId && a.positionId === pos?.id,
      );
      if (!alloc)
        mismatches.push(
          `row seq ${r.seq}: no allocation for reversal ${r.creditReversalId}`,
        );
      else {
        const mv = step.movement;
        if (
          alloc.requested !== mv.pointsRequested ||
          alloc.debtRestored !== mv.debtRestored ||
          alloc.recovered !== mv.recovered ||
          alloc.owed !== mv.owed ||
          alloc.shortfall !== mv.shortfall
        ) {
          mismatches.push(
            `allocation ${alloc.id}: db (r ${alloc.requested}, p ${alloc.debtRestored}, c ${alloc.recovered}, owed ${alloc.owed}, sf ${alloc.shortfall}) ` +
              `oracle (r ${mv.pointsRequested}, p ${mv.debtRestored}, c ${mv.recovered}, owed ${mv.owed}, sf ${mv.shortfall})`,
          );
        }
      }
    }
    m = step.model;
  });

  if (wallet.redeemablePoints !== m.state.B)
    mismatches.push(
      `wallet B db=${wallet.redeemablePoints} oracle=${m.state.B}`,
    );
  if (wallet.debtPoints !== m.state.D)
    mismatches.push(`wallet D db=${wallet.debtPoints} oracle=${m.state.D}`);
  if (wallet.movementSeq !== m.state.seq)
    mismatches.push(
      `wallet movementSeq db=${wallet.movementSeq} oracle=${m.state.seq}`,
    );
  for (const p of positions) {
    const o = m.positions[p.creditTxId];
    if (!o) {
      mismatches.push(`position ${p.id}: unknown to the oracle`);
      continue;
    }
    if (o.offset !== p.offsetPoints)
      mismatches.push(
        `position ${p.id}: O db=${p.offsetPoints} oracle=${o.offset}`,
      );
    if (o.reversed !== p.reversedPoints)
      mismatches.push(
        `position ${p.id}: ρ db=${p.reversedPoints} oracle=${o.reversed}`,
      );
    const alloc = allocations
      .filter((a) => a.positionId === p.id)
      .reduce((s, a) => s + a.requested, 0);
    if (alloc !== p.reversedPoints)
      mismatches.push(
        `position ${p.id}: Σ allocations ${alloc} ≠ ρ ${p.reversedPoints} (V8)`,
      );
  }
  for (const lot of m.lots) {
    const tx = rows.find((r) => r.id === lot.id);
    const dbLot = tx?.pointsLedgerId
      ? lotById.get(tx.pointsLedgerId)
      : undefined;
    if (!dbLot) {
      mismatches.push(`lot of credit ${lot.id}: no points_ledger row`);
      continue;
    }
    if (dbLot.remainingPoints !== lot.remaining) {
      mismatches.push(
        `lot of credit ${lot.id}: remaining db=${dbLot.remainingPoints} oracle=${lot.remaining}`,
      );
    }
  }
  mismatches.push(...checkInvariants(m).map((v) => `oracle invariant: ${v}`));
  return { model: m, kinds, txIds: rows.map((r) => r.id), mismatches };
}
