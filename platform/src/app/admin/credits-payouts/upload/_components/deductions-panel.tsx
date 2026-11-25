'use client';

import { MinusCircle } from 'lucide-react';
import type { CreditUploadRow } from '@/types';

// Negative POINTS rows become wallet DEDUCTIONS when the tenant setting
// `creditUploadNegativeDeductions` is ON (design: docs/plans/UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md).
// The panel renders only when the parse actually has deduction rows. The below-zero / repeat / not-applied
// warnings live in "Before you confirm" (before-you-confirm.tsx).

/** An OK POINTS row with a negative amount = a deduction. */
export function isDeductionRow(r: CreditUploadRow): boolean {
  return r.status === 'OK' && r.awardType === 'POINTS' && r.amount < 0;
}

/** "−1,200" for negatives, "1,200" otherwise (en-IN, Unicode minus). */
export function fmtSignedPts(n: number): string {
  return n < 0 ? `−${Math.abs(n).toLocaleString('en-IN')}` : n.toLocaleString('en-IN');
}

/** "−199.5 → −200 pts" when rounded, "−320 pts" otherwise. */
export function deductionAmountText(r: CreditUploadRow): string {
  const rounded = fmtSignedPts(r.amount);
  if (r.originalAmount === undefined) return `${rounded} pts`;
  return `−${Math.abs(r.originalAmount)} → ${rounded} pts`;
}

/** Every preview list (Will be deducted, Before you confirm) shows the same first-N rows. */
export const PANEL_LIMIT = 20;

/** "Will be deducted" — every OK deduction row (first 20). Renders nothing without deductions. */
export function DeductionsPanel({ rows }: { rows: CreditUploadRow[] }) {
  const deductions = rows.filter(isDeductionRow);
  if (deductions.length === 0) return null;
  const total = deductions.reduce((s, r) => s + Math.abs(r.amount), 0);
  return (
    <div className="bg-white rounded-xl border border-orange-200 overflow-hidden" data-testid="credits-deductions-panel">
      <div className="px-4 py-3 bg-orange-50 border-b border-orange-100">
        <p className="text-xs font-semibold text-orange-800 flex items-center gap-2">
          <MinusCircle className="w-3.5 h-3.5" aria-hidden="true" />
          Will be deducted — {deductions.length} row{deductions.length !== 1 ? 's' : ''} · {total.toLocaleString('en-IN')} pts
        </p>
        <p className="text-xs text-orange-700 mt-0.5">
          Negative points are taken out of the outlet&apos;s wallet on confirm (rounded to the nearest whole point, .5 goes
          away from zero).
        </p>
      </div>
      <div className="divide-y divide-gray-100 max-h-52 overflow-y-auto">
        {deductions.slice(0, PANEL_LIMIT).map((r) => (
          <div key={`${r.rowNum}|${r.fieldId}`} className="px-4 py-2.5 flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-gray-800">
              Row {r.rowNum} · {r.outletId} · {r.fieldName}
            </p>
            <p className="text-xs text-orange-700 tabular-nums whitespace-nowrap" data-testid="credits-deduction-row">
              {deductionAmountText(r)}
            </p>
          </div>
        ))}
        {deductions.length > PANEL_LIMIT && (
          <p className="px-4 py-2 text-xs text-orange-700">
            …and {deductions.length - PANEL_LIMIT} more — see the downloaded report.
          </p>
        )}
      </div>
    </div>
  );
}
