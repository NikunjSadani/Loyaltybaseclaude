/**
 * GIFSY-reject fast-track (Bajaj, tenant flag `gifsyRejectFastTrack`).
 *
 * When GIFSY rejected the previous KYC AFTER the managers had approved it, the rep's corrected
 * resubmission goes straight to GIFSY (PENDING_GIFSY), skipping manager approval. The backend marks
 * such a submission with `fastTrack: { previousSubmissionId, previousRejectedAt }` on the KYC detail
 * (GET /kyc/:id), the KYC list and each GIFSY review-queue entry; a normally-routed submission of a
 * flag-on tenant carries `null`, and a flag-off tenant's response (Deoleo) has no key at all. Every
 * surface that shows such a KYC must make the skip visible ("no silent pass-through") — this module
 * is the single parser + copy source so they never drift.
 */

export interface KycFastTrack {
  /** '' when the backend could not name the previous submission (the marker still shows; the link hides). */
  previousSubmissionId: string;
  /** ISO timestamp of the GIFSY rejection of the previous submission ('' when unknown). */
  previousRejectedAt: string;
}

/** Admin detail banner + GIFSY approvals note (matches the backend status-history note). */
export const FAST_TRACK_HEADLINE =
  'Resubmitted after a GIFSY rejection — sent directly to GIFSY; managers did not re-approve.';
/** GIFSY review-queue badge. */
export const FAST_TRACK_QUEUE_BADGE = 'Resubmission · no manager re-approval';
/** Sales KYC detail: ONE line inside the existing PENDING_GIFSY box (sales surfaces say "Gifsy"). */
export const FAST_TRACK_SALES_NOTE = 'Sent directly to Gifsy. Your manager does not need to approve it again.';
/** Sales timeline: the skipped manager step's sublabel (stays after Gifsy decides). */
export const FAST_TRACK_SKIPPED_SUBLABEL = 'Not needed — resent after Gifsy rejection';
/** Admin banner + approvals note when the rejection date is missing / unreadable. */
export const FAST_TRACK_PREVIOUS_FALLBACK = 'Previous KYC was rejected by GIFSY';

/**
 * Coerce the raw API value into a KycFastTrack, or null. null / absent / non-object → null, so a
 * flag-off tenant (Deoleo, key omitted) and a normal submission render exactly as before. Any OBJECT
 * is the backend's marker: a missing/empty previousSubmissionId KEEPS it (the skip notice is never
 * silently dropped) — callers just hide the "View previous submission" link.
 */
export function parseFastTrack(raw: unknown): KycFastTrack | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    previousSubmissionId: typeof r.previousSubmissionId === 'string' ? r.previousSubmissionId : '',
    previousRejectedAt: typeof r.previousRejectedAt === 'string' ? r.previousRejectedAt : '',
  };
}

/** "17 Nov 2026" in IST, or null when the timestamp is missing/unparseable (caller words around it). */
export function formatFastTrackDate(iso: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
}

/** The previous-rejection line: "Previous KYC rejected on <date>", or the fallback when the date is unreadable. */
export function fastTrackPreviousText(fastTrack: KycFastTrack): string {
  const on = formatFastTrackDate(fastTrack.previousRejectedAt);
  return on ? `Previous KYC rejected on ${on}` : FAST_TRACK_PREVIOUS_FALLBACK;
}
