'use client';

/**
 * FOCUS-NAMES-FROM-KPI (owner 2026-11-25): a KPI that reads another KPI's focus names is NOT calculated in a month whose
 * target file has no focus names at all (left empty — no value, not 0). The rest of the month applies. Shown in red;
 * the admin must tick it before Apply / Recalculate (the server refuses without the acknowledgement).
 */
import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { FocusNotCalculated } from '@/lib/sales-import/types';

export function NotCalculatedAck({ month, label, items, checked, onChange, canAct = true }: {
  month: string;
  /** "November 2026". */
  label: string;
  items: FocusNotCalculated[] | undefined;
  checked: boolean;
  onChange(v: boolean): void;
  canAct?: boolean;
}) {
  if (!items || items.length === 0) return null;
  const codes = items.map((i) => i.kpiCode).join(', ');
  const removed = items.filter((i) => (i.existingOutlets ?? 0) > 0);
  const removedText = removed.map((i) => `existing ${i.kpiCode} values for ${i.existingOutlets} outlet${i.existingOutlets === 1 ? '' : 's'}`).join(' and ');
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 space-y-1.5"
      data-testid={`not-calculated-${month}`}>
      <ul className="space-y-0.5">
        {items.map((i) => (
          <li key={i.kpiCode} className="flex gap-1.5 font-semibold">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />{i.message}
          </li>
        ))}
      </ul>
      <p>
        {codes} {items.length === 1 ? 'is' : 'are'} left empty for {label} (no value, not 0); everything else is applied. Upload the
        target file with the focus names and recalculate {label} to fill {items.length === 1 ? 'it' : 'them'}.
      </p>
      {canAct && (
        <label className="flex items-start gap-2 text-red-900">
          <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)}
            aria-label={`I accept that ${codes} ${items.length === 1 ? 'is' : 'are'} not calculated for ${label}${removed.length > 0 ? ` and that the ${removedText} will be REMOVED` : ''}`} />
          <span>
            I accept that <strong>{codes}</strong> {items.length === 1 ? 'is' : 'are'} not calculated for {label}
            {removed.length > 0 && <> and that the <strong>{removedText}</strong> will be REMOVED</>}.
          </span>
        </label>
      )}
    </div>
  );
}

/** The months (of `months`, ticked in `selected`) that carry not-calculated KPIs. */
export function notCalculatedMonths(
  months: ReadonlyArray<{ month: string; reconciliation?: { notCalculated?: FocusNotCalculated[] } | null }>,
  selected: ReadonlySet<string>,
): string[] {
  return months.filter((m) => selected.has(m.month) && (m.reconciliation?.notCalculated?.length ?? 0) > 0).map((m) => m.month);
}
