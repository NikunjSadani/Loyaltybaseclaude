'use client';

/**
 * APPLIES-TO targeting UI (APPLIES-TO-TARGETING-PLAN §6): the three scope pickers used by the KPI form, plus the
 * live "N matching outlets" line (shared with the Visibility config editor).
 */
import React from 'react';
import { Button } from '@/components/ui/button';
import { ScopeMultiSelect } from '@/components/admin/scope-multi-select';
import type { AppliesTo } from '@/lib/applies-to';
import {
  typeOptions, valueOptions, useMatchingOutletCount, useScopeOptions, type ScopeOptionsResponse,
} from '@/lib/kpi-scope';

const fmt = (n: number) => n.toLocaleString('en-IN');

/**
 * Honest live preview of how many outlets a draft scope matches right now (attributes are evaluated live, D9/D10).
 * `unscopedText` lets the caller say what an empty scope means for it.
 */
export function MatchingOutletCount({
  scope, enabled = true, unscoped = false, testId = 'scope-matching-count',
}: { scope: AppliesTo; enabled?: boolean; unscoped?: boolean; testId?: string }) {
  const state = useMatchingOutletCount(scope, { enabled });
  if (state.status === 'idle') return null;
  return (
    <p role="status" aria-live="polite" data-testid={testId} className="text-[11px]">
      {state.status === 'loading' && <span className="text-gray-400">Counting matching outlets…</span>}
      {state.status === 'error' && <span className="text-red-600">Couldn&apos;t count matching outlets: {state.error}</span>}
      {state.status === 'ok' && (
        state.count === 0
          ? <span className="text-amber-700">No outlet matches this scope right now.</span>
          : <span className="text-gray-600">
              <strong>{fmt(state.count)}</strong> matching outlet{state.count !== 1 ? 's' : ''} right now
              {unscoped ? ' (every outlet)' : ''}.
            </span>
      )}
    </p>
  );
}

/** Options for the program / sub-program pickers with loading / error states shared by both editors. */
export function ScopeOptionsStatus({ loading, error, onRetry }: { loading: boolean; error: string | null; onRetry(): void }) {
  if (loading) return <p className="text-[11px] text-gray-400" role="status">Loading outlet types and programs…</p>;
  if (!error) return null;
  return (
    <div role="alert" className="flex items-center gap-2 text-[11px] text-red-600" data-testid="scope-options-error">
      Couldn&apos;t load the outlet type / program lists: {error}
      <Button size="sm" variant="outline" type="button" onClick={onRetry}>Retry</Button>
    </div>
  );
}

export function KpiAppliesToFields({
  value, onChange, fallbackTypes = [], disabled = false,
}: {
  value: AppliesTo;
  onChange(v: AppliesTo): void;
  /** Used for the outlet-type list when scope-options could not be loaded. */
  fallbackTypes?: ScopeOptionsResponse['outletTypes'];
  disabled?: boolean;
}) {
  const opts = useScopeOptions();
  const loaded = Boolean(opts.data);
  const types = typeOptions(opts.data?.outletTypes ?? fallbackTypes);
  const unscoped = value.outletTypes.length === 0 && value.programs.length === 0 && value.subPrograms.length === 0;
  // A selected value missing from a LOADED list is flagged; while the lists are unavailable it is just shown.
  const stale = loaded ? '(not offered now)' : '';
  return (
    <div className="space-y-2" data-testid="kpi-applies-to">
      <p className="text-xs font-semibold text-gray-500">Applies to</p>
      <ScopeOptionsStatus loading={opts.loading && !loaded} error={opts.error} onRetry={opts.retry} />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <ScopeMultiSelect label="Outlet types" options={types} values={value.outletTypes} disabled={disabled}
          staleSuffix={loaded || fallbackTypes.length ? '(not enabled)' : ''}
          emptyText={opts.loading ? 'Loading…' : 'No outlet types available.'}
          onChange={(v) => onChange({ ...value, outletTypes: v })} />
        <ScopeMultiSelect label="Programs" options={valueOptions(opts.data?.programs ?? [])} values={value.programs}
          disabled={disabled} staleSuffix={stale}
          emptyText={opts.loading ? 'Loading…' : opts.error ? 'List unavailable.' : 'No programs yet.'}
          onChange={(v) => onChange({ ...value, programs: v })} />
        <ScopeMultiSelect label="Sub-Programs" options={valueOptions(opts.data?.subPrograms ?? [])} values={value.subPrograms}
          disabled={disabled} staleSuffix={stale}
          emptyText={opts.loading ? 'Loading…' : opts.error ? 'List unavailable.' : 'No sub-programs yet.'}
          onChange={(v) => onChange({ ...value, subPrograms: v })} />
      </div>
      <p className="text-[11px] text-gray-400">
        Leave all empty = applies to every outlet. Within a list any value matches; across lists all must match.
      </p>
      <MatchingOutletCount scope={value} unscoped={unscoped} testId="kpi-scope-count" />
    </div>
  );
}
