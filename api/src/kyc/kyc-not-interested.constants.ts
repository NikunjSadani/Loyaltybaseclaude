import type { KycStatus } from '@prisma/client';

/**
 * G1 (PLATFORM-WIDE, owner-approved 2026-11-17) — "Not interested" deactivates the outlet, so it is refused for an
 * outlet whose KYC is APPROVED or in flight. Single source of truth for the server refusal
 * (KycService.notInterested) and the sales outlet payload's `notInterestedBlock` (SalesService.buildOutlets),
 * so the FE hides the button exactly where the server would refuse it.
 *
 * In flight = submitted / under review / any PENDING_* stage. DRAFT (the owner never consented), REJECTED and the
 * re-entry statuses (RE_UPLOAD_REQUIRED / RESUBMISSION_REQUIRED / RE_KYC_REQUIRED) do NOT block.
 */
export const NOT_INTERESTED_IN_FLIGHT_KYC_STATUSES = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'PENDING_PENNY_DROP',
  'PENDING_AGREEMENT',
  'PENDING_SO_APPROVAL',
  'PENDING_ASM_APPROVAL',
  'PENDING_RSM_APPROVAL',
  'PENDING_GIFSY',
] as const satisfies readonly KycStatus[];

/** Every status that blocks "Not interested": APPROVED + the in-flight ones. */
export const NOT_INTERESTED_BLOCKING_KYC_STATUSES = [
  'APPROVED',
  ...NOT_INTERESTED_IN_FLIGHT_KYC_STATUSES,
] as const satisfies readonly KycStatus[];

export const NOT_INTERESTED_IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(NOT_INTERESTED_IN_FLIGHT_KYC_STATUSES);

/** The plain-words refusals (the sales FE shows the same text next to the hidden button). */
export const NOT_INTERESTED_REFUSAL = {
  // R4: "was … before" — the block also covers an outlet approved once whose LATEST re-KYC was rejected, so
  // "is already approved" would be false for it. The rule is unchanged (any APPROVED KYC ever blocks).
  APPROVED: "This outlet was KYC-approved before — it can't be marked Not interested.",
  IN_REVIEW: "This outlet's KYC is under review — it can't be marked Not interested now.",
  PARKED: 'This outlet is parked by the admin.',
} as const;
