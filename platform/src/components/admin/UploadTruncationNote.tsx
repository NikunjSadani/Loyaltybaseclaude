/**
 * Shown ABOVE an upload's problem-row list (never inside its short scroll box, where it would be hidden)
 * when the API capped the list (memory-safety 2026-11-13: uploads echo only problem rows, at most 500).
 * Renders nothing when the list is complete.
 *
 * `next` says what to do about the rest, and MUST match how the screen saves (M3):
 *  - TRUNCATION_NEXT.PREVIEW       — nothing saved yet: fix the file and upload it again.
 *  - TRUNCATION_NEXT.PARTIAL_SAVE  — good rows are already saved: re-upload ONLY the failed rows
 *                                    (re-uploading the whole file would repeat the saved rows).
 *  - or a screen-specific sentence.
 */
export const TRUNCATION_NEXT = {
  PREVIEW: 'Fix these in your file and upload it again to see the rest.',
  PARTIAL_SAVE:
    'All other rows were saved. Fix these, then re-upload only the failed rows (not the whole file) — that upload will list any that are left.',
} as const

export function truncationText(shown: number, total: number | undefined, noun: string): string {
  const t = typeof total === 'number' ? total : shown
  return `Showing the first ${shown.toLocaleString('en-IN')} of ${t.toLocaleString('en-IN')} ${noun}.`
}

export function UploadTruncationNote({
  shown,
  total,
  truncated,
  noun = 'problem rows',
  next = TRUNCATION_NEXT.PREVIEW,
}: {
  shown: number
  total: number | undefined
  truncated: boolean | undefined
  noun?: string
  next?: string
}) {
  if (!truncated) return null
  return (
    <p role="status" data-testid="upload-truncation-note" className="text-xs text-amber-700">
      {truncationText(shown, total, noun)} {next}
    </p>
  )
}
