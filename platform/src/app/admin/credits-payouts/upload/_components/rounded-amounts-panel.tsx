'use client';

import { Info } from 'lucide-react';
import type { CreditUploadRow } from '@/types';

/** "199.5 → 200 pts" / "₹199.5 → ₹200" for a row the parser rounded to a whole unit. */
export function roundedAmountText(r: CreditUploadRow): string {
  if (r.awardType === 'PAYOUT') {
    // r.amount is integer paise (whole rupees × 100); originalAmount is rupees as typed.
    return `₹${r.originalAmount} → ₹${(r.amount / 100).toLocaleString('en-IN')}`;
  }
  // A deduction row (negative points; only with the tenant's negative-deductions setting ON).
  if (r.amount < 0) {
    return `−${Math.abs(r.originalAmount ?? 0)} → −${Math.abs(r.amount).toLocaleString('en-IN')} pts`;
  }
  return `${r.originalAmount} → ${r.amount.toLocaleString('en-IN')} pts`;
}

/**
 * Preview panel listing every OK row whose typed amount was rounded half-up to a whole
 * unit (owner rule 2026-11-12). Renders nothing when no amount was rounded, so a
 * whole-number upload's preview is unchanged.
 */
export function RoundedAmountsPanel({ rows }: { rows: CreditUploadRow[] }) {
  const rounded = rows.filter((r) => r.status === 'OK' && r.originalAmount !== undefined);
  if (rounded.length === 0) return null;
  return (
    <div className="bg-white rounded-xl border border-blue-200 overflow-hidden" data-testid="credits-rounded-panel">
      <div className="px-4 py-3 bg-blue-50 border-b border-blue-100">
        <p className="text-xs font-semibold text-blue-800 flex items-center gap-2">
          <Info className="w-3.5 h-3.5" aria-hidden="true" />
          {rounded.length} amount{rounded.length !== 1 ? 's' : ''} rounded to whole units
        </p>
        <p className="text-xs text-blue-700 mt-0.5">
          Points and ₹ payouts are credited in whole units, rounded half-up (.5 and above rounds up).
        </p>
      </div>
      <div className="divide-y divide-gray-100 max-h-52 overflow-y-auto">
        {rounded.map((r) => (
          <div key={`${r.rowNum}|${r.fieldId}`} className="px-4 py-2.5 flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-gray-800">
              Row {r.rowNum} · {r.outletId} · {r.fieldName}
            </p>
            <p className="text-xs text-gray-700 tabular-nums whitespace-nowrap" data-testid="credits-rounded-row">
              {roundedAmountText(r)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
