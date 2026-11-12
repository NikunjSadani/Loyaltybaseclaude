'use client';

/**
 * Checkbox multi-select over a tenant's real outlet types / programs / sub-programs (APPLIES-TO-TARGETING-PLAN §6).
 * Lifted from the Sales Import KPI editor so the KPI form, the Sales Import editor and the Visibility config share one
 * control. The backend matches scope trimmed + case-insensitively (D8), so selection is compared the same way.
 * A selected value that is no longer offered stays listed, ticked (with `staleSuffix`), so it can be removed.
 */
import React from 'react';

export interface ScopeOption {
  value: string;
  label: string;
  /** Optional muted note after the label, e.g. "(not in settings list)". */
  note?: string;
}

export const sameScopeValue = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

export function ScopeMultiSelect({
  label, options, values, onChange, staleSuffix = '(no outlets now)', hint, emptyText, disabled = false, testId,
}: {
  label: string;
  options: ScopeOption[];
  values: string[];
  onChange(v: string[]): void;
  /** Suffix for a selected value that is not among the options. */
  staleSuffix?: string;
  /** Muted helper text under the list (linked via aria-describedby). */
  hint?: string;
  /** Shown inside the box when there are no rows at all. */
  emptyText?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const id = React.useId();
  const stale = values.filter((v) => !options.some((o) => sameScopeValue(o.value, v)));
  const rows: ScopeOption[] = [...options, ...stale.map((v) => ({ value: v, label: `${v} ${staleSuffix}`.trim() }))];
  const isOn = (v: string) => values.some((x) => sameScopeValue(x, v));
  function toggle(v: string) {
    onChange(isOn(v) ? values.filter((x) => !sameScopeValue(x, v)) : [...values, v]);
  }
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <fieldset disabled={disabled} aria-describedby={hintId} data-testid={testId} className="min-w-0">
      <legend className="text-xs font-medium text-gray-700">{label}</legend>
      <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-gray-200 bg-white px-2 py-1.5 space-y-1">
        {rows.length === 0 && <p className="text-xs text-gray-400">{emptyText ?? 'Nothing to choose from.'}</p>}
        {rows.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-xs text-gray-800">
            <input type="checkbox" checked={isOn(o.value)} onChange={() => toggle(o.value)} />
            {o.label}
            {o.note && <span className="text-[11px] text-amber-700">{o.note}</span>}
          </label>
        ))}
      </div>
      {values.length > 0 && <p className="mt-1 text-[11px] text-gray-500">{values.length} selected</p>}
      {hint && <p id={hintId} className="mt-1 text-[11px] text-gray-500">{hint}</p>}
    </fieldset>
  );
}
