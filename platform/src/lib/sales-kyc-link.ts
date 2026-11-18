/**
 * K2 (2026-11-18) — where a sales outlet row's KYC link goes.
 *
 * The KYC STATUS on an outlet row is the OWNER's (partner's) latest KYC — the owner's identity, shared by every
 * outlet of a multi-outlet owner. But the KYC DETAIL view is outlet-level (R5): a rep holding O2 may not open
 * the KYC filed via O1. For that case the API sends `kycId: ''` + `kycFiledViaOutletCode`, and the row shows
 * the status with the note "KYC filed via outlet <code>" — never a dead link, never a fake "Not started", and
 * never a "start KYC" link for an owner whose KYC is already in flight / approved.
 */
export interface KycLinkable {
  id: string;
  kycId?: string | null;
  kycFiledViaOutletCode?: string | null;
  outletCode?: string | null;
  name?: string | null;
}

/** The note shown instead of a link when the owner's KYC was filed via another outlet. */
export function kycFiledViaNote(o: KycLinkable): string | null {
  return o.kycFiledViaOutletCode ? `KYC filed via outlet ${o.kycFiledViaOutletCode}` : null;
}

/**
 * The KYC link for an outlet row: the submission detail when there is one, the START wizard only when the
 * owner has no KYC at all, and `null` when the owner's KYC was filed via another outlet this caller cannot
 * open (the row then shows `kycFiledViaNote` instead of navigating).
 */
export function kycHrefFor(o: KycLinkable): string | null {
  if (o.kycFiledViaOutletCode) return null;
  return o.kycId ? `/sales/kyc/${o.kycId}` : `/sales/kyc/new?outletId=${o.id}`;
}

/**
 * For task lists / search (which always need a destination): a row whose KYC was filed via another outlet goes
 * to that outlet's card on the Outlets screen (which shows the status + the note) instead of a dead detail link
 * or a wrong "start KYC" wizard.
 */
export function kycTaskHrefFor(o: KycLinkable): string {
  return kycHrefFor(o) ?? `/sales/outlets?q=${encodeURIComponent(o.outletCode || o.name || '')}`;
}
