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
