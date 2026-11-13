/**
 * Shown under an upload's problem-row table when the API capped the list
 * (memory-safety 2026-11-13: uploads echo only problem rows, at most 500).
 * Renders nothing when the list is complete.
 */
export function UploadTruncationNote({
  shown,
  total,
  truncated,
  noun = 'problem rows',
}: {
  shown: number
  total: number | undefined
  truncated: boolean | undefined
  noun?: string
}) {
  if (!truncated) return null
  const t = typeof total === 'number' ? total : shown
  return (
    <p role="status" className="text-xs text-amber-700">
      Showing the first {shown.toLocaleString('en-IN')} of {t.toLocaleString('en-IN')} {noun}. Fix these and
      re-upload to see the rest.
    </p>
  )
}
