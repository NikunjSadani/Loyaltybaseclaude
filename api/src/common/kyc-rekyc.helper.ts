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
