/**
 * APPLIES-TO targeting (APPLIES-TO-TARGETING-PLAN §6) — FE data helpers shared by the KPI form and the Visibility
 * config editor:
 *   GET /api/admin/kpis/scope-options → { outletTypes:{code,label}[], programs:{value,inSettings}[], subPrograms:{value,inSettings}[] }
 *   GET /api/admin/kpis/scope-count?outletTypes=A,B&programs=..&subPrograms=.. → { count }
 * The backend is authoritative; these only drive pickers and a live "N matching outlets" preview.
 * Pure helpers (kpiScopeOf, scopeChipText, scopeMismatches, …) live in `@/lib/kpi-scope-core`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import type { AppliesTo } from '@/lib/applies-to';
import type { ScopeOption } from '@/components/admin/scope-multi-select';
import { scopeCountQuery } from '@/lib/kpi-scope-core';

export interface ScopeOptionsResponse {
  outletTypes: Array<{ code: string; label: string }>;
  programs: Array<{ value: string; inSettings: boolean }>;
  subPrograms: Array<{ value: string; inSettings: boolean }>;
}

export const NOT_IN_SETTINGS_NOTE = '(not in settings list)';

function isScopeOptions(d: unknown): d is ScopeOptionsResponse {
  const o = d as ScopeOptionsResponse | null;
  return !!o && Array.isArray(o.outletTypes) && Array.isArray(o.programs) && Array.isArray(o.subPrograms);
}

/** Program / sub-program rows → picker options, badging values that are not in the tenant settings list. */
export function valueOptions(rows: ScopeOptionsResponse['programs']): ScopeOption[] {
  return rows.map((r) => ({ value: r.value, label: r.value, ...(r.inSettings ? {} : { note: NOT_IN_SETTINGS_NOTE }) }));
}

export function typeOptions(rows: ScopeOptionsResponse['outletTypes']): ScopeOption[] {
  return rows.map((t) => ({ value: t.code, label: t.label && t.label !== t.code ? `${t.label} (${t.code})` : t.code }));
}

export function useScopeOptions(enabled = true) {
  const [data, setData] = useState<ScopeOptionsResponse | null>(null);
  // Starts "loading" so a not-yet-enabled consumer never flashes an empty-list message before the first request.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    const res = await api.get<ScopeOptionsResponse>('/api/admin/kpis/scope-options');
    if (my !== seq.current) return;
    if (res.success && isScopeOptions(res.data)) setData(res.data);
    else setError(res.success ? 'Unexpected response' : res.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (enabled) void load();
    return () => { seq.current++; };
  }, [enabled, load]);

  return { data, loading, error, retry: load };
}

export type MatchingCountState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; count: number }
  | { status: 'error'; error: string };

/**
 * Live "N matching outlets" for a draft scope. Debounced; a response for an older scope never overwrites a newer
 * one (sequence guard), and nothing is set after unmount. `enabled=false` → idle (no request).
 */
export function useMatchingOutletCount(scope: AppliesTo, { enabled = true, debounceMs = 350 } = {}): MatchingCountState {
  const [state, setState] = useState<MatchingCountState>({ status: 'idle' });
  const seq = useRef(0);
  // The scope object identity changes every render; drive the effect from the query string only.
  const query = scopeCountQuery(scope);

  useEffect(() => {
    const my = ++seq.current;
    if (!enabled) { setState({ status: 'idle' }); return; }
    setState({ status: 'loading' });
    const t = setTimeout(async () => {
      const res = await api.get<{ count: number }>(`/api/admin/kpis/scope-count${query}`);
      if (my !== seq.current) return; // stale (scope changed or unmounted)
      if (res.success && typeof res.data?.count === 'number') setState({ status: 'ok', count: res.data.count });
      else setState({ status: 'error', error: res.success ? 'Unexpected response' : res.error });
    }, debounceMs);
    return () => { clearTimeout(t); seq.current++; };
  }, [query, enabled, debounceMs]);

  return state;
}
