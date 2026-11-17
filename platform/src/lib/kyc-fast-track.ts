/**
 * GIFSY-reject fast-track (Bajaj, tenant flag `gifsyRejectFastTrack`).
 *
 * When GIFSY rejected the previous KYC AFTER the managers had approved it, the rep's corrected
 * resubmission goes straight to GIFSY (PENDING_GIFSY), skipping manager approval. The backend marks
 * such a submission with `fastTrack: { previousSubmissionId, previousRejectedAt }` on the KYC detail
 * (GET /kyc/:id) and on each GIFSY review-queue entry; every other submission carries `null` (or,
 * on an older API, no field at all). Every surface that shows such a KYC must make the skip visible
 * ("no silent pass-through") — this module is the single parser + copy source so they never drift.
 */

export interface KycFastTrack {
  previousSubmissionId: string;
  /** ISO timestamp of the GIFSY rejection of the previous submission. */
  previousRejectedAt: string;
}

/** Shared copy (admin detail banner + timeline). */
export const FAST_TRACK_HEADLINE =
  'Resubmitted after GIFSY rejection — sent straight to GIFSY (manager approval skipped)';
/** GIFSY review-queue badge. */
export const FAST_TRACK_QUEUE_BADGE = 'Resubmission · managers skipped';
/** Sales KYC detail note while the KYC is with GIFSY. */
export const FAST_TRACK_SALES_NOTE =
  'Sent straight to GIFSY (resubmission after GIFSY rejection) — no manager approval needed';
/** Sales KYC detail note once GIFSY has decided (the skip stays on record). */
export const FAST_TRACK_SALES_NOTE_DECIDED =
  'This was a resubmission after a GIFSY rejection, so it went straight to GIFSY — manager approval was skipped';

/**
 * Coerce the raw API value into a KycFastTrack, or null. Missing / null / malformed → null, so a
 * tenant without the flag (Deoleo) and an older API render exactly as before.
 */
export function parseFastTrack(raw: unknown): KycFastTrack | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.previousSubmissionId !== 'string' || r.previousSubmissionId.length === 0) return null;
  return {
    previousSubmissionId: r.previousSubmissionId,
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
