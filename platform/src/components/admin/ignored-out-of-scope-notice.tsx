'use client';

/**
 * APPLIES-TO D1: target / achievement uploads IGNORE a value for a KPI that does not apply to that outlet (the rest
 * of the row is kept; the row's remarks name the ignored KPIs). OWNER DECISION: a re-upload never deletes a value
 * already stored for an out-of-scope KPI (the backend carries it over) — the copy says so. Renders nothing when the
 * count is absent or 0, so tenants without scoped KPIs see no change.
 */
import React from 'react';
import { AlertTriangle } from 'lucide-react';

export interface RemarkRow {
  rowIndex?: number;
  outletCode?: string;
  remarks?: string | null;
}

const MAX_ROWS = 10;

/**
 * `rows` = the SAVED rows (accepted / updated) that carry remarks — the rejected-rows list on these pages does not
 * show them, so they are listed here (first 10).
 */
export function IgnoredOutOfScopeNotice({ count, rows = [] }: { count?: number | null; rows?: RemarkRow[] }) {
  if (typeof count !== 'number' || count <= 0) return null;
  const withRemarks = rows.filter((r) => (r.remarks ?? '').trim());
  return (
    <div role="status" data-testid="ignored-out-of-scope"
      className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <div className="space-y-1 min-w-0">
        <p>
          <strong>{count.toLocaleString('en-IN')}</strong> value{count !== 1 ? 's' : ''} ignored because the KPI
          doesn&apos;t apply to that outlet. Any value already stored for {count !== 1 ? 'those cells' : 'that cell'} is
          unchanged (hidden on screens, kept in exports). Other values in the same rows were saved as usual.
        </p>
        {withRemarks.length > 0 && (
          <ul className="space-y-0.5" data-testid="ignored-out-of-scope-rows">
            {withRemarks.slice(0, MAX_ROWS).map((r, i) => (
              <li key={`${r.rowIndex ?? i}-${i}`}>
                <span className="font-mono font-semibold">
                  Row {r.rowIndex ?? i + 1}{r.outletCode ? ` — ${r.outletCode}` : ''}:
                </span>{' '}
                {r.remarks}
              </li>
            ))}
            {withRemarks.length > MAX_ROWS && <li className="text-amber-600">…{withRemarks.length - MAX_ROWS} more rows</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
