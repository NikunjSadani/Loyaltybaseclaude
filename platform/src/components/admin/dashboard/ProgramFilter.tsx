'use client';

/**
 * The shared "Program" dropdown for the admin Overview / Program Health / KYC dashboards (and the Overview's
 * Monthly billing progress card). Pair with `useDashboardProgram()` (src/lib/dashboard-program.ts).
 *
 *  - Options come from the endpoint's `availablePrograms` (real distinct Outlet.programName values).
 *  - Hidden unless there are at least 2 programs — a single-program tenant sees exactly today's page —
 *    EXCEPT while a program is active: then it always shows (even with no list, e.g. the load failed), so the
 *    person can see what the screen is filtered by and switch back to All programs.
 *  - '' = "All programs".
 *  - `droppedProgram` → a visible notice that a program from a link / an earlier page isn't available
 *    here and All programs is shown instead (never a silent reset).
 */
import React from 'react';
import { Info, X } from 'lucide-react';
import { ALL_PROGRAMS, MIN_PROGRAMS_FOR_FILTER } from '@/lib/dashboard-program';

export interface ProgramFilterProps {
  programs: readonly string[] | null | undefined;
  value: string;
  onChange: (program: string) => void;
  /** DOM id of the <select> (label target). */
  id: string;
  testId?: string;
  label?: string;
  disabled?: boolean;
  droppedProgram?: string | null;
  onDismissDropped?: () => void;
  className?: string;
}

export function ProgramFilter({
  programs,
  value,
  onChange,
  id,
  testId,
  label = 'Program',
  disabled,
  droppedProgram,
  onDismissDropped,
  className = '',
}: ProgramFilterProps) {
  const listed = programs ?? [];
  // The active program is always an option (it may be missing from a failed / stale list).
  const options = value && !listed.includes(value) ? [value, ...listed] : listed;
  const showSelect = listed.length >= MIN_PROGRAMS_FOR_FILTER || !!value;
  if (!showSelect && !droppedProgram) return null;

  return (
    <div className={`flex flex-col items-start sm:items-end gap-1 min-w-0 ${className}`}>
      {showSelect && (
        <div className="flex items-center gap-2 min-w-0 max-w-full">
          <label htmlFor={id} className="text-xs font-medium text-gray-500 shrink-0">
            {label}
          </label>
          <select
            id={id}
            data-testid={testId}
            aria-label={label}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="min-w-0 max-w-full sm:max-w-[16rem] border border-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-800 bg-white focus:outline-none focus:border-[var(--brand-primary)] disabled:opacity-60"
          >
            <option value={ALL_PROGRAMS}>All programs</option>
            {options.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      )}
      {droppedProgram && (
        <p
          role="status"
          data-testid="program-filter-dropped"
          className="flex items-start gap-1.5 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 max-w-full"
        >
          <Info className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">
            Program “{droppedProgram}” isn&apos;t available here — showing all programs.
          </span>
          {onDismissDropped && (
            <button
              type="button"
              onClick={onDismissDropped}
              aria-label="Dismiss program notice"
              className="shrink-0 opacity-60 hover:opacity-100"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/** Small visible note on a tile whose number stays tenant-wide while a program is selected. */
export function TenantWideNote({ className = '' }: { className?: string }) {
  return (
    <p
      data-testid="tenant-wide-note"
      className={`text-[10px] font-medium text-amber-700 ${className}`}
    >
      Tenant-wide — not split by program
    </p>
  );
}
