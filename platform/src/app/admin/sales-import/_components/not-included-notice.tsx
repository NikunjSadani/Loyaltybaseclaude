'use client';

/**
 * Roster-only aggregates (owner decision 2026-11-23, no silent pass-through): a processed file keeps product lines only
 * for the outlets that were in the programme when it was processed. Outlets added AFTER that get 0 from this file —
 * the preview (`rosterOutletsNotIncluded`), the apply confirm and each apply result (`outletsNotIncluded`, incl. the
 * background-job result cards) say so. This file is the ONE source of that wording.
 */
import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { formatCount } from '@/lib/sales-import/format';

/** "N outlets were not in the programme when this file was processed; any sales they have in this file are not included." */
export function notIncludedCountText(n: number): string {
  return n === 1
    ? '1 outlet was not in the programme when this file was processed; any sales it has in this file are not included.'
    : `${formatCount(n)} outlets were not in the programme when this file was processed; any sales they have in this file are not included.`;
}

/**
 * What to do about it — true for the import's state: not applied yet → Reprocess; already applied (Reprocess is refused)
 * → read it again as a new import, then apply the month again. Without upload rights: who has to do it.
 */
export function notIncludedActionText(n: number, s: { applied: boolean; canAct: boolean }): string {
  const them = n === 1 ? 'it' : 'them';
  if (s.canAct) {
    return s.applied
      ? `Read the file again as a new import, then apply the month again to include ${them}.`
      : `Reprocess the file to include ${them}.`;
  }
  return s.applied
    ? `Someone who can upload sales files needs to read the file again as a new import, then apply the month again.`
    : 'Someone who can upload sales files needs to reprocess the file.';
}

export function notIncludedText(n: number, s: { applied: boolean; canAct: boolean }): string {
  return `${notIncludedCountText(n)} ${notIncludedActionText(n, s)}`;
}

/**
 * Next to an apply result (the import is applied from then on): renders nothing when no outlet was left out (or the API
 * did not report it).
 */
export function NotIncludedNotice({ month, count, canAct }: { month: string; count?: number | null; canAct: boolean }) {
  if (!count || count <= 0) return null;
  return (
    <p role="status" data-testid={`not-included-${month}`}
      className="mt-2 flex gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
      <span>{notIncludedText(count, { applied: true, canAct })}</span>
    </p>
  );
}
