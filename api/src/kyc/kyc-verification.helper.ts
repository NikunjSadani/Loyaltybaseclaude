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

import { KycFieldKey, KycFieldDecision, KycStatus, KycVariant } from '@prisma/client';

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

/**
 * SO Declaration variant (Bajaj) — the fields that still GATE approval. The three
 * document/GST-centric keys (GST_VALIDATION, GST_DOCUMENT, ADDRESS_DOCUMENT) are
 * NON-BLOCKING for this variant: a missing one must never hold the submission at
 * PENDING_GIFSY. See platform/docs/plans/SO-DECLARATION-KYC.md §5.2.
 */
export const SO_DECLARATION_FIELD_KEYS: KycFieldKey[] = [
  'PAYMENT',
  'ADDRESS',
  'BOARD_PHOTO',
  'OWNER_PHOTO',
];

/** Minimal shape needed to decide a submission's required (blocking) field set. */
export interface RequiredFieldsLike {
  kycVariant?: KycVariant | null;
}

/**
 * The REQUIRED (blocking) verification field keys for a submission, by variant.
 *   - STANDARD (or omitted) → all 7 keys, UNCHANGED (Deoleo-safe).
 *   - SO_DECLARATION        → the 4 keys that still gate approval; the GST/doc keys
 *     are non-blocking (reviewable/approvable if evidence exists, but never block).
 * Centralizing this keeps the bridge (`evaluateSubmission`) and the approve()
 * fill-missing loop from ever diverging on which fields a variant requires.
 */
export function requiredFieldKeys(submission?: RequiredFieldsLike | null): KycFieldKey[] {
  return submission?.kycVariant === 'SO_DECLARATION'
    ? SO_DECLARATION_FIELD_KEYS
    : KYC_FIELD_KEYS;
}

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
export function evaluateSubmission(
  items: VerificationDecisionLike[],
  submission?: RequiredFieldsLike | null,
): BridgeResult {
  // Which keys GATE this submission. STANDARD (or omitted) → the 7 canonical keys,
  // so the Deoleo path is byte-identical. SO_DECLARATION → only the 4 required keys;
  // the non-required keys are ignored by the bridge entirely (never force PENDING, a
  // missing/rejected optional doc can neither block nor re-open the submission).
  const required = requiredFieldKeys(submission);
  const byKey = new Map<KycFieldKey, KycFieldDecision>();
  for (const it of items) byKey.set(it.fieldKey, it.decision);

  const decisions = required.map((k) => byKey.get(k) ?? 'PENDING');
  const approvedCount = decisions.filter((d) => d === 'APPROVED').length;
  const anyPending = decisions.some((d) => d === 'PENDING');

  if (anyPending) {
    // Grid still being worked — hold at PENDING_GIFSY regardless of any rejects so
    // far. NOTE (owner-confirm): rejects are intentionally NOT surfaced until all 7
    // fields are terminal — a partner learns of a re-upload only once the grid is
    // complete. Faithful to reconcile §5. Owner-confirmed 2026-06-16: KEEP this —
    // one consolidated re-upload after the grid is reviewed (early per-field re-share
    // was considered and declined).
    return { next: 'PENDING_GIFSY', rejectedFields: [], approvedCount };
  }

  const rejectedFields = required.filter((k) => byKey.get(k) === 'REJECTED');
  if (rejectedFields.length > 0) {
    return { next: 'RE_UPLOAD_REQUIRED', rejectedFields, approvedCount };
  }

  return { next: 'APPROVED', rejectedFields: [], approvedCount };
}
