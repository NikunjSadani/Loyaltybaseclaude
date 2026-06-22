/**
 * KYC eligibility helpers — shared across ALL payment rails.
 *
 * Background / motivation:
 * Before this module the credit-bank-file build, confirmRedeem, confirmRedeemForOutlet,
 * and processBatch each maintained their own ad-hoc KYC-status read. Two problems:
 *
 *   1. STALE-APPROVAL RACE — the original `take:1 orderBy createdAt desc` relies on
 *      `createdAt` alone. When a re-KYC triggers a status mutation on the SAME row
 *      (kyc.service.ts reKyc() calls `tx.kycSubmission.update` in place — it never
 *      creates a new row), two rows with an identical createdAt timestamp (millisecond
 *      tie) have no deterministic winner. The post-reKYC status can lose to the old
 *      APPROVED value, surfacing a "stale APPROVED" result.
 *
 *   2. OPPOSITE DEFAULTS — the credit rail used `?? null` at the held-gate and
 *      `?? 'APPROVED'` at the payable-rows step; the payable-default could approve
 *      a partner with no submission at all.
 *
 * This module provides:
 *   - resolveEffectiveKycStatus — canonical, deterministic resolver.
 *   - isPartnerPayable            — single predicate used by all four rails.
 *
 * Relation notes (from schema.prisma):
 *   KycSubmission has both `userId` (non-nullable) and `partnerId` (nullable).
 *   ChannelPartner.kycSubmissions relates via `partnerId`. A submission can
 *   exist with `partnerId=null` but a matching `userId` (e.g. submitted before the
 *   partner record is created). Callers that use the Prisma include MUST therefore
 *   include BOTH partnerId- and userId-keyed candidates and pass ALL of them to
 *   resolveEffectiveKycStatus — the resolver will pick the most-recent decisive one.
 *
 * Re-KYC mutation model (from kyc.service.ts reKyc()):
 *   reKyc() calls `tx.kycSubmission.update({ where: { id }, data: { status: 'RE_KYC_REQUIRED' } })`
 *   on the SAME row, i.e. it mutates in place, NOT via a new row. The `updatedAt` column
 *   is automatically bumped by Prisma's @updatedAt, giving us a sub-millisecond tiebreak
 *   that createdAt alone cannot provide. Ordering by createdAt desc → updatedAt desc → id desc
 *   is therefore the correct canonical sort.
 */

/** Minimal shape of a KycSubmission row needed for resolution. */
export interface KycSubmissionCandidate {
  status: string;
  createdAt: Date;
  updatedAt: Date;
  id: string;
}

/**
 * Resolve the EFFECTIVE KYC status for a partner from a set of candidate submissions.
 *
 * DETERMINISTIC ordering to survive millisecond ties and in-place status mutations:
 *   1. createdAt DESC  — most-recently submitted first
 *   2. updatedAt DESC  — when createdAt ties (rare), prefer the row touched last
 *                        (e.g. the one mutated by reKyc())
 *   3. id DESC         — final tiebreak via cuid string ordering (lexicographically
 *                        newer cuid = later creation within the same millisecond)
 *
 * The first submission in sorted order is the "effective" one — we return its status.
 * Returns null when no submissions are supplied (= not yet submitted).
 *
 * No-submission default is intentionally null (NOT 'APPROVED'):
 *   Callers must treat null as ineligible, never as approved.
 */
export function resolveEffectiveKycStatus(
  submissions: KycSubmissionCandidate[],
): string | null {
  if (!submissions || submissions.length === 0) return null;

  // Sort a copy (never mutate caller's array).
  const sorted = [...submissions].sort((a, b) => {
    // Primary: createdAt descending
    const dt = b.createdAt.getTime() - a.createdAt.getTime();
    if (dt !== 0) return dt;
    // Secondary: updatedAt descending (catches in-place reKyc mutations)
    const du = b.updatedAt.getTime() - a.updatedAt.getTime();
    if (du !== 0) return du;
    // Tertiary: id descending (lexicographic — cuids are time-prefixed)
    return b.id.localeCompare(a.id);
  });

  return sorted[0].status;
}

/**
 * Single payability predicate used by every rail (credit bank-file, confirmRedeem,
 * confirmRedeemForOutlet, processBatch).
 *
 * A partner is payable if and only if:
 *   - isActive is not false (null/undefined treated as true — the Prisma default)
 *   - deletedAt is null (not soft-deleted)
 *   - effectiveKyc is exactly 'APPROVED'
 *
 * @param effectiveKyc  The value returned by resolveEffectiveKycStatus(). null means
 *                       no submission exists and is treated as NOT payable.
 */
export function isPartnerPayable({
  isActive,
  deletedAt,
  effectiveKyc,
}: {
  isActive: boolean | null | undefined;
  deletedAt: Date | null | undefined;
  effectiveKyc: string | null;
}): boolean {
  return isActive !== false && deletedAt == null && effectiveKyc === 'APPROVED';
}
