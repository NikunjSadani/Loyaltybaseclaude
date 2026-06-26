/**
 * Shared KYC rejection-reason presets — used by BOTH the sales senior-reject
 * modal and the Gifsy admin reviewer so the two lists never drift. Selecting
 * reasons (instead of free typing) is the point: minimal open text entry.
 *
 * The presets are joined into ONE string for the existing `{ reason }` reject
 * payload; an optional free-text note is appended as `Others: <text>`.
 */
export const KYC_REJECTION_REASONS: readonly string[] = [
  'Document image is blurry or unreadable',
  'Document is expired',
  'Name mismatch between documents',
  'GST number does not match PAN',
  'Bank account details mismatch',
  'Address proof does not match registered address',
  'Photo ID is incomplete or damaged',
  'Signed agreement is missing',
];

/** Label for the admin reviewer's single-select "other" sentinel (kept verbatim
 *  so the admin dropdown's existing behaviour is unchanged). */
export const KYC_REJECTION_OTHER_OPTION = 'Other (specify below)';

/**
 * Build the final reason string sent to POST /api/kyc/:id/reject.
 * @param selected  preset reasons the user ticked (from KYC_REJECTION_REASONS)
 * @param otherText free-text typed under "Others" (optional)
 * Joins with "; "; appends "Others: <trimmed text>" when otherText is non-empty.
 */
export function buildRejectionReason(selected: readonly string[], otherText: string): string {
  const parts = [...selected];
  const t = otherText.trim();
  if (t) parts.push(`Others: ${t}`);
  return parts.join('; ');
}
