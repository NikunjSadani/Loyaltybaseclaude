'use client';

/**
 * Roster-only aggregates (owner decision 2026-11-23, no silent pass-through): a processed file keeps product lines only
 * for the outlets that were in the programme when it was processed. Outlets added AFTER that get 0 from this file —
 * the preview (`rosterOutletsNotIncluded`) and each apply result (`outletsNotIncluded`) say so plainly.
 */
import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { formatCount } from '@/lib/sales-import/format';

/** The one wording, shared by the preview banner and the apply result cards. */
export function notIncludedText(n: number): string {
  return `${formatCount(n)} outlet${n === 1 ? ' was' : 's were'} added to the programme after this file was processed — ` +
    `${n === 1 ? 'its' : 'their'} sales in this file are not included (${n === 1 ? 'it gets' : 'they get'} 0). ` +
    'Reprocess the file (or upload the next file) to include them.';
}

/** Next to an apply result: renders nothing when no outlet was left out (or the API did not report it). */
export function NotIncludedNotice({ month, count }: { month: string; count?: number | null }) {
  if (!count || count <= 0) return null;
  return (
    <p role="alert" data-testid={`not-included-${month}`}
      className="mt-2 flex gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
      <span>{notIncludedText(count)}</span>
    </p>
  );
}
