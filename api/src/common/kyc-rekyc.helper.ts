import type { KycStatus } from '@prisma/client';

/**
 * True when an outlet's `reKycFlags` marks a re-KYC as pending.
 *
 * The admin re-KYC upload (admin-outlets) writes a NON-EMPTY map of the fields to
 * re-capture onto `Outlet.reKycFlags` WITHOUT flipping the latest submission status
 * (which stays APPROVED). An empty `{}` / `null` means nothing is pending.
 *
 * This is the SINGLE source of truth for the "re-KYC pending" signal, shared by the
 * admin (deriveKycStatus) and sales (buildOutlets + kyc.list) status derivations so a
 * re-KYC'd outlet reads as RE_KYC_REQUIRED everywhere. (It previously diverged: the
 * sales side ignored reKycFlags, so a re-KYC'd outlet showed as Approved to the rep
 * and never appeared under the Re-KYC filter/tasks.)
 */
export function isReKycPending(reKycFlags: unknown): boolean {
  return (
    reKycFlags !== null &&
    typeof reKycFlags === 'object' &&
    Object.keys(reKycFlags as Record<string, unknown>).length > 0
  );
}

/**
 * Raw KycStatus values where a submission is actively IN the approval pipeline — i.e. a
 * (re-)submission has been routed and is under review. Mirrors kyc.service's
 * IN_FLIGHT_STATUSES (the set that also blocks a duplicate resubmission).
 *
 * Why this matters for re-KYC: `Outlet.reKycFlags` STAYS SET from the admin request until
 * Gifsy approval clears it (the approvers need the flags to see which fields were flagged).
 * So once a rep resubmits, the outlet still carries flags WHILE its new submission is under
 * review. Displaying "Re-KYC Required" then is wrong — the re-KYC has been submitted. Every
 * DISPLAY/actionability derivation therefore treats re-KYC as pending only when the flags
 * are set AND the latest submission is NOT in-flight (see isReKycActionable).
 */
export const KYC_IN_FLIGHT_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'PENDING_SO_APPROVAL',
  'PENDING_ASM_APPROVAL',
  'PENDING_RSM_APPROVAL',
  'PENDING_GIFSY',
] as const;

const IN_FLIGHT_SET = new Set<string>(KYC_IN_FLIGHT_STATUSES);

/** True when the given (latest) submission status is an under-review pipeline state. */
export function isKycInFlight(status: unknown): boolean {
  return typeof status === 'string' && IN_FLIGHT_SET.has(status);
}

/**
 * The DISPLAY/actionability signal for re-KYC: flags are set AND no fresh submission is
 * currently under review. Use this (not bare isReKycPending) wherever a status is derived
 * or a resubmit affordance is shown; keep isReKycPending for the approver highlight, which
 * must persist through review.
 */
export function isReKycActionable(reKycFlags: unknown, latestStatus: unknown): boolean {
  return isReKycPending(reKycFlags) && !isKycInFlight(latestStatus);
}

// ── Canonical KYC-stage derivation (the KYC dashboard's per-outlet grouping) ──────────
//
// SINGLE source of truth for mapping an outlet's LATEST submission status to a
// dashboard-style KYC stage. Extracted from AdminCoreService.kycDashboard's inline
// grouping loop so the dashboard AND the KYC Status report can never diverge.

/**
 * Field-approval pending bucket: an addressable outlet whose latest submission sits in any
 * of the pre-Gifsy review states (the full SO/ASM/RSM chain + initial-review states).
 */
export const KYC_PENDING_FIELD_STATUSES: ReadonlySet<KycStatus> = new Set<KycStatus>([
  'SUBMITTED',
  'UNDER_REVIEW',
  'PENDING_PENNY_DROP',
  'PENDING_AGREEMENT',
  'PENDING_SO_APPROVAL',
  'PENDING_ASM_APPROVAL',
  'PENDING_RSM_APPROVAL',
]);

/** Rejected / re-upload / re-KYC / suspended → "not approved, needs action". */
export const KYC_REJECT_REUPLOAD_STATUSES: ReadonlySet<KycStatus> = new Set<KycStatus>([
  'REJECTED',
  'RE_UPLOAD_REQUIRED',
  'RESUBMISSION_REQUIRED',
  'RE_KYC_REQUIRED',
  'SUSPENDED',
]);

/** The dashboard-style per-outlet KYC stage labels. */
export type KycStageLabel =
  | 'Not Started'
  | 'In Progress'
  | 'Submitted (field approval)'
  | 'Pending Gifsy'
  | 'Approved'
  | 'Rejected'
  | 'Re-upload';

/**
 * Derive an outlet's dashboard-style KYC stage from its LATEST submission status
 * (null / undefined = the owner partner has no submission → "Not Started").
 *
 * This is a faithful 1:1 extraction of the kycDashboard grouping chain (same branch
 * order, same status sets) so the dashboard's bucket counts are unchanged when it calls
 * this. The report splits the dashboard's merged rejected/re-upload bucket into the two
 * distinct labels the status column shows: REJECTED → "Rejected", every other
 * reject/re-upload/re-KYC/suspended state → "Re-upload". A DRAFT (started, not yet
 * submitted) → "In Progress"; any status outside every set (e.g. NOT_INTERESTED as a
 * bare submission status) → "Not Started", exactly as the dashboard groups it.
 */
export function deriveKycStage(latestStatus: KycStatus | null | undefined): KycStageLabel {
  const status: KycStatus | 'NOT_STARTED' = latestStatus ?? 'NOT_STARTED';
  if (status === 'APPROVED') return 'Approved';
  if (status === 'PENDING_GIFSY') return 'Pending Gifsy';
  if (status !== 'NOT_STARTED' && KYC_PENDING_FIELD_STATUSES.has(status)) {
    return 'Submitted (field approval)';
  }
  if (status !== 'NOT_STARTED' && KYC_REJECT_REUPLOAD_STATUSES.has(status)) {
    return status === 'REJECTED' ? 'Rejected' : 'Re-upload';
  }
  if (status === 'DRAFT') return 'In Progress';
  return 'Not Started';
}
