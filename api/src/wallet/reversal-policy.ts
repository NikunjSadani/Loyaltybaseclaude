/**
 * Wallet Reversal Engine — POLICY ROUND A (owner decisions 2026-11-15/16, WALLET-REVERSAL-ENGINE-DESIGN.md §12 P-A1..P-A5).
 *
 * The refusals a POINTS reversal can hit because something needs GIFSY's attention, with their exact owner-approved
 * wording, plus the per-tenant "approvals paused" gate. Owner rule: NO SILENT PASS-THROUGHS — every one of these is
 * (1) a clear API error naming the reason and what to do, (2) an audit row (CreditsService.auditReversalRefusal),
 * (3) listed by GET /v1/admin/credits/reversal-engine/attention, and (4) counted in the backfill / verify reports.
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PointsReversalPause, TenantSettingsService } from '../tenant/tenant-settings.service';

export type ReversalAttentionCode =
  | 'WALLET_NEEDS_ATTENTION'
  | 'WALLET_NOT_SEQUENCED'
  | 'RAISED_UNDER_OLD_ENGINE'
  | 'CREDIT_UNMAPPED'
  | 'APPROVALS_PAUSED';

/** A POINTS reversal refused because Gifsy must act first (409). `detail` goes to the audit row + the client. */
export class ReversalAttentionException extends ConflictException {
  constructor(
    public readonly code: ReversalAttentionCode,
    message: string,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Q3 (owner wording, verbatim). */
export function creditUnmappedMessage(outletCode: string): string {
  return `Can't reverse: the original credit for outlet ${outletCode} in this batch couldn't be identified — Gifsy must map it first.`;
}

/** Q1: the receiving wallet was not prepared by the backfill (BLOCKED with a reason, or never processed). */
export function walletNeedsAttentionMessage(outletCode: string, reason: string): string {
  return (
    `Can't reverse: the wallet that received this credit for outlet ${outletCode} needs Gifsy attention (${reason}). ` +
    `Gifsy must fix that wallet's points history and re-run the wallet backfill — earning and redeeming on it keep working meanwhile.`
  );
}

/** Reason text for a wallet the backfill has never processed (status NULL, history present). */
export const WALLET_NOT_YET_BACKFILLED_REASON = 'not yet prepared by the wallet backfill';

/** The exact next step for Gifsy when wallets are not prepared for reversals (refusal, banner, digest). */
export const BACKFILL_NEXT_STEP =
  'Gifsy: run the wallet backfill (dry run, then APPLY) for this client — see BAJAJ-PROD-FOLLOWUPS-RUNBOOK §C';

/**
 * The one-engine safety gate (2026-11-21): the receiving wallet has points history the wallet backfill has not
 * sequenced. Names the client (display name) and the outlet and says exactly what Gifsy must do. Nothing was changed.
 */
export function walletNotSequencedMessage(outletCode: string, clientName: string): string {
  return (
    `Can't reverse: the wallet of outlet ${outletCode} (${clientName}) has points history that has not been ` +
    `prepared for reversals yet. ${BACKFILL_NEXT_STEP}, then retry. Nothing was changed — earning and redeeming on ` +
    `this wallet keep working meanwhile.`
  );
}

/**
 * Audit A1: a POINTS reversal REQUESTED before the old engine was retired is refused at approve (never silently
 * switched to the new rules — e.g. an over-reversal now becomes debt instead of stopping at 0).
 */
export const RAISED_UNDER_OLD_ENGINE_MESSAGE =
  'This points reversal was raised under the old reversal engine (before it was retired) and the rules have changed ' +
  '— an over-reversal now becomes wallet debt instead of stopping at zero. Reject it and re-raise it so it follows ' +
  'the current rules. Nothing was changed.';

/** Readiness line (attention banner + daily ops digest) — plain words, both counts when present. */
export function walletsNotSequencedReadinessMessage(unsequenced: number, blocked: number): string {
  const parts: string[] = [];
  if (unsequenced > 0) {
    parts.push(
      `${unsequenced} ${unsequenced === 1 ? 'wallet with points history is' : 'wallets with points history are'} not yet ` +
        `prepared for reversals — ${BACKFILL_NEXT_STEP}`,
    );
  }
  if (blocked > 0) {
    parts.push(
      `${blocked} ${blocked === 1 ? 'wallet was' : 'wallets were'} blocked by the wallet backfill — Gifsy must fix ` +
        `${blocked === 1 ? 'its' : 'their'} history and re-run it`,
    );
  }
  return `${parts.join('; ')}. Points reversals on these wallets are refused until then.`;
}

/** Q5 (owner wording, verbatim + the start time). */
export function approvalsPausedMessage(p: PointsReversalPause): string {
  if (p.malformed) {
    return `Points reversal approvals are paused — the pause setting is unreadable (${p.reason ?? 'unknown'}); contact Gifsy`;
  }
  return `Points reversal approvals are paused — wallet maintenance in progress (started ${p.since ?? 'at an unknown time'})`;
}

/**
 * The advisory-lock key shared by every POINTS reversal create/approve (SHARED, per transaction) and the backfill's
 * drain step (EXCLUSIVE, momentary): after the backfill commits the pause, taking the exclusive lock waits until every
 * reversal transaction that read "not paused" has finished — so nothing that started before the pause can commit
 * during APPLY.
 */
export function pointsReversalLockKey(clientId: string): string {
  return `wallet-reversal-engine:points-reversal:${clientId}`;
}

/**
 * The Q5 gate, run FIRST inside every POINTS reversal create / approve transaction (every tenant — the backfill pauses
 * approvals for its APPLY window). Takes the shared advisory lock, then reads the switch through the SAME `tx`.
 */
export async function assertPointsReversalsNotPaused(
  tx: Prisma.TransactionClient,
  tenantSettings: Pick<TenantSettingsService, 'getPointsReversalPauseUncached'>,
  clientId: string,
): Promise<void> {
  const key = pointsReversalLockKey(clientId);
  await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))) AS l`;
  const pause = await tenantSettings.getPointsReversalPauseUncached(clientId, tx);
  if (pause.paused) {
    throw new ReversalAttentionException('APPROVALS_PAUSED', approvalsPausedMessage(pause), {
      since: pause.since,
      by: pause.by,
      reason: pause.reason,
      malformed: pause.malformed ?? false,
    });
  }
}

/**
 * Q3 narrowing (PURE): does an UNRESOLVED credit position of this batch possibly belong to the (outlet, field) line?
 *  - a position whose recorded outletCode / fieldId names ANOTHER outlet / field can't be this line's credit;
 *  - otherwise it could, UNLESS the line is already fully identified: the batch row(s) for (outlet, field) total
 *    exactly what the RESOLVED positions of the key total (each confirmed row produces one credit).
 * Returns the blocking positions (empty ⇒ the line is reversible on its resolved positions).
 */
export function unresolvedBlockingLine<P extends { outletCode: string | null; fieldId: string | null }>(
  unresolved: P[],
  key: { outletCode: string; fieldId: string },
  resolvedAmount: number,
  lineAmountFromBatch: number | null,
): P[] {
  const compatible = unresolved.filter(
    (u) => (u.outletCode === null || u.outletCode === key.outletCode) && (u.fieldId === null || u.fieldId === key.fieldId),
  );
  if (compatible.length === 0) return [];
  // An UNRESOLVED position carrying EXACTLY this key (backfill downgrade: an approved reversal of the key could not be
  // attributed) is this line's own credit — always blocking.
  if (compatible.some((u) => u.outletCode === key.outletCode && u.fieldId === key.fieldId)) return compatible;
  if (lineAmountFromBatch !== null && lineAmountFromBatch > 0 && resolvedAmount === lineAmountFromBatch) return [];
  return compatible;
}

/** Σ amount of the batch's POINTS / OK / amount > 0 rows for (outlet, field) — what confirm credited; null = unknown. */
export function batchLineAmount(rows: unknown, key: { outletCode: string; fieldId: string }): number | null {
  if (!Array.isArray(rows)) return null;
  let sum = 0;
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || r.awardType !== 'POINTS' || r.status !== 'OK') continue;
    if (r.outletId !== key.outletCode || r.fieldId !== key.fieldId) continue;
    if (typeof r.amount !== 'number' || !(r.amount > 0)) continue;
    sum += r.amount;
  }
  return sum;
}
