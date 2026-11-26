/**
 * Credits upload — the ONE place deciding which "Before you confirm" acknowledgements a client must give and whether a
 * row marked OK with amount 0 is refused (owner rule 2026-11-25 "no silent failure"; UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md
 * §11). The confirm (server check), the upload preview (`ackCategories` — the screen shows / requires exactly these) and
 * the row guard all read it, so the scope changes here and nowhere else.
 *
 * Owner decision 2026-11-25: EVERY client (Deoleo included) — the preview, the rounded / not-applied ticks and the
 * zero-row refusal apply to all. To limit it to clients with upload deductions, set ALL_CLIENTS to false.
 */

/** Preview categories the admin must acknowledge before Confirm. */
export const UPLOAD_ACK_CATEGORIES = ['SKIPPED', 'ROUNDED', 'NOT_APPLIED', 'BELOW_ZERO', 'REPEAT_DEDUCTION', 'OFF_PORTAL_DUPLICATE'] as const;
export type UploadAckCategory = (typeof UPLOAD_ACK_CATEGORIES)[number];

export const UPLOAD_ACK_LABELS: Record<UploadAckCategory, string> = {
  SKIPPED: 'rows that will not be credited (blank or zero)',
  ROUNDED: 'rows rounded to whole units',
  NOT_APPLIED: 'rows that will not be applied (outlet not found or not linked)',
  BELOW_ZERO: 'wallets that will go below zero',
  REPEAT_DEDUCTION: 'deductions that may be a repeat',
  // Off-portal payments register (2026-11-26): the same outlet + amount was already paid OUTSIDE the portal for this
  // month (or within 3 days of it) — paying it again on the portal would pay twice.
  OFF_PORTAL_DUPLICATE: 'payouts that may already have been paid outside the portal (off-portal payments register)',
};

/** Owner 2026-11-25: true = every client. The one switch. */
const ALL_CLIENTS = true;

export function uploadAckScope(client: { deductionsEnabled: boolean }): {
  categories: UploadAckCategory[];
  refuseZeroRows: boolean;
} {
  if (ALL_CLIENTS || client.deductionsEnabled) return { categories: [...UPLOAD_ACK_CATEGORIES], refuseZeroRows: true };
  return { categories: [], refuseZeroRows: false };
}
