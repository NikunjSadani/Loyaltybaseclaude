import { KYCStatus } from '@/types';

/**
 * Priority rank for ordering outlets in the sales Outlets lists (rep's own +
 * the manager's team-member view). Owner-specified order (2026-07-03):
 *
 *   Approved → Re-KYC → Rejected → Pending → Not Interested
 *
 * The KYC enum has more states than the five named buckets, so the "extra"
 * states fold in to match the rep-facing badges:
 *   - Rejected bucket: REJECTED + RE_UPLOAD_REQUIRED + RESUBMISSION_REQUIRED
 *     (all three badge as "Rejected" to reps — see the rep KYC list).
 *   - Pending bucket: everything still in flight or not yet started —
 *     NOT_STARTED, PENDING, DRAFT, SUBMITTED, UNDER_REVIEW, and every
 *     PENDING_*_APPROVAL / PENDING_GIFSY state.
 *
 * This is ORDERING ONLY — it does not group the list into visual sections.
 */
export function kycOrderRank(status: KYCStatus): number {
  switch (status) {
    case KYCStatus.APPROVED:
      return 0;
    case KYCStatus.RE_KYC_REQUIRED:
      return 1;
    case KYCStatus.REJECTED:
    case KYCStatus.RE_UPLOAD_REQUIRED:
    case KYCStatus.RESUBMISSION_REQUIRED:
      return 2;
    case KYCStatus.NOT_INTERESTED:
      return 4;
    // NOT_STARTED / PENDING / DRAFT / SUBMITTED / UNDER_REVIEW / PENDING_* → Pending
    default:
      return 3;
  }
}
