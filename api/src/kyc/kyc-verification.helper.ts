/**
 * kyc-verification.helper.ts
 *
 * Pure, side-effect-free logic for the Stage-2 field-level verification grid.
 * No Prisma, no I/O — shared by BOTH the bulk-commit path (Lane A) and the
 * single-record portal path (Lane B) so they can never diverge (reconcile §5).
 *
 * The 7-field grid begins when a submission reaches PENDING_GIFSY. The submission
 * `status` stays PENDING_GIFSY for the entire time the grid is worked; "n of 7"
 * progress is DERIVED from these items, never encoded in the status enum.
 *
 * Bridge rule:
 *   - any field still PENDING  → stay PENDING_GIFSY (grid not finished)
 *   - all 7 terminal, ≥1 REJECTED → RE_UPLOAD_REQUIRED (re-open only the rejected)
 *   - all 7 terminal, all APPROVED → APPROVED (→ activate user + wallet + notify)
 */

import { KycFieldKey, KycFieldDecision, KycStatus } from '@prisma/client';

/** The 7 verification fields, in canonical order. */
export const KYC_FIELD_KEYS: KycFieldKey[] = [
  'PAYMENT',
  'GST_VALIDATION',
  'GST_DOCUMENT',
  'ADDRESS',
  'ADDRESS_DOCUMENT',
  'BOARD_PHOTO',
  'OWNER_PHOTO',
];

export const KYC_FIELD_COUNT = KYC_FIELD_KEYS.length; // 7

/** Minimal shape the bridge needs from a KycVerificationItem (keeps it testable). */
export interface VerificationDecisionLike {
  fieldKey: KycFieldKey;
  decision: KycFieldDecision;
}

export interface BridgeResult {
  /** The submission status the bridge implies. */
  next: Extract<KycStatus, 'PENDING_GIFSY' | 'APPROVED' | 'RE_UPLOAD_REQUIRED'>;
  /** Fields to re-open (only when next === RE_UPLOAD_REQUIRED). */
  rejectedFields: KycFieldKey[];
  /** Derived progress — how many of the 7 are APPROVED (for the "n of 7" chip). */
  approvedCount: number;
}

/**
 * Evaluate a submission's Stage-1 status from its Stage-2 verification items.
 * Robust to missing rows — a field with no item is treated as PENDING (so a
 * partially-created grid correctly stays PENDING_GIFSY). The DB's
 * @@unique([kycSubmissionId, fieldKey]) guarantees at most one row per field;
 * if duplicates were ever passed, the last one wins.
 */
export function evaluateSubmission(items: VerificationDecisionLike[]): BridgeResult {
  const byKey = new Map<KycFieldKey, KycFieldDecision>();
  for (const it of items) byKey.set(it.fieldKey, it.decision);

  const decisions = KYC_FIELD_KEYS.map((k) => byKey.get(k) ?? 'PENDING');
  const approvedCount = decisions.filter((d) => d === 'APPROVED').length;
  const anyPending = decisions.some((d) => d === 'PENDING');

  if (anyPending) {
    // Grid still being worked — hold at PENDING_GIFSY regardless of any rejects so far.
    return { next: 'PENDING_GIFSY', rejectedFields: [], approvedCount };
  }

  const rejectedFields = KYC_FIELD_KEYS.filter((k) => byKey.get(k) === 'REJECTED');
  if (rejectedFields.length > 0) {
    return { next: 'RE_UPLOAD_REQUIRED', rejectedFields, approvedCount };
  }

  return { next: 'APPROVED', rejectedFields: [], approvedCount };
}
