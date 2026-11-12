/// <reference types="vitest/globals" />
/**
 * APPLIES-TO §6 — KPI scope FE helpers + the live matching-outlet count hook (stale-response race).
 * Run: npx vitest run src/lib/__tests__/kpi-scope.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const getMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => getMock(...a) } }));

import {
  kpiScopeOf, scopeChipText, scopeDescription, scopeMismatches, scopeKey, scopeCountQuery,
} from '@/lib/kpi-scope-core';
import { useMatchingOutletCount, useScopeOptions, valueOptions } from '@/lib/kpi-scope';
import type { AppliesTo } from '@/lib/applies-to';

const S = (o: Partial<AppliesTo>): AppliesTo => ({ outletTypes: [], programs: [], subPrograms: [], ...o });

describe('kpi-scope-core', () => {
  it('kpiScopeOf: arrays win; a legacy single outletType reads as a one-type scope; nothing = unscoped', () => {
    expect(kpiScopeOf({ outletType: 'sss' })).toEqual(S({ outletTypes: ['SSS'] }));
    expect(kpiScopeOf({ outletType: 'SSS', outletTypes: ['WHOLESALER'], programs: ['Unnati'] }))
      .toEqual(S({ outletTypes: ['WHOLESALER'], programs: ['Unnati'] }));
    expect(kpiScopeOf({ outletType: null })).toEqual(S({}));
    expect(kpiScopeOf(undefined)).toEqual(S({}));
  });

  it('scopeChipText: "RLP · Unnati · Lite", multi-value facets comma-joined, "All outlets" when unscoped', () => {
    const label = (c: string) => (c === 'SSS' ? 'RLP' : c);
    expect(scopeChipText(S({ outletTypes: ['SSS'], programs: ['Unnati'], subPrograms: ['Lite'] }), label)).toBe('RLP · Unnati · Lite');
    expect(scopeChipText(S({ outletTypes: ['SSS', 'WS'] }), label)).toBe('RLP, WS');
    expect(scopeChipText(S({}))).toBe('All outlets');
    expect(scopeDescription(S({ programs: ['Unnati'] }))).toBe('Programs: Unnati');
  });

  it('scopeMismatches: only compares facets restricted on BOTH sides; ci; flags disjoint vs partial', () => {
    const kpi = S({ programs: ['Unnati'], subPrograms: ['Lite'] });
    expect(scopeMismatches(kpi, { programs: [null], subPrograms: [undefined] })).toEqual([]);
    expect(scopeMismatches(kpi, { programs: [' unnati '] })).toEqual([]);
    expect(scopeMismatches(S({}), { programs: ['X'] })).toEqual([]);
    expect(scopeMismatches(kpi, { programs: ['Pragati'] }))
      .toEqual([{ facet: 'programs', outside: ['Pragati'], disjoint: true, kpiValues: ['Unnati'] }]);
    const partial = scopeMismatches(kpi, { programs: ['Unnati', 'Pragati'] });
    expect(partial[0]).toMatchObject({ outside: ['Pragati'], disjoint: false });
  });

  it('scopeKey is order/case-insensitive; scopeCountQuery omits empty facets and REPEATS each value', () => {
    expect(scopeKey(S({ programs: ['b', 'A'] }))).toBe(scopeKey(S({ programs: ['a', 'B'] })));
    expect(scopeKey(S({}))).not.toBe(scopeKey(S({ programs: ['A'] })));
    expect(scopeCountQuery(S({}))).toBe('');
    expect(scopeCountQuery(S({ outletTypes: ['sss', 'ws'], subPrograms: ['Lite & Co'] })))
      .toBe('?outletTypes=SSS&outletTypes=WS&subPrograms=Lite%20%26%20Co');
  });

  it('scopeCountQuery keeps a value containing a comma as ONE param (no comma-joining)', () => {
    const q = scopeCountQuery(S({ programs: ['Gold, Plus', 'Silver'] }));
    expect(q).toBe('?programs=Gold%2C%20Plus&programs=Silver');
    expect(new URLSearchParams(q.slice(1)).getAll('programs')).toEqual(['Gold, Plus', 'Silver']);
  });

  it('valueOptions badges values not in the settings list', () => {
    expect(valueOptions([{ value: 'A', inSettings: true }, { value: 'B', inSettings: false }])).toEqual([
      { value: 'A', label: 'A' },
      { value: 'B', label: 'B', note: '(not in settings list)' },
    ]);
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('useMatchingOutletCount', () => {
  beforeEach(() => getMock.mockReset());

  it('a stale (older-scope) response never overwrites the newer one', async () => {
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    getMock.mockImplementation((url?: string) => (String(url).includes('programs=A') ? a.promise : b.promise));
    const { result, rerender } = renderHook(({ s }) => useMatchingOutletCount(s, { debounceMs: 0 }), {
      initialProps: { s: S({ programs: ['A'] }) },
    });
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1)); // A in flight
    rerender({ s: S({ programs: ['B'] }) });
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2)); // B in flight
    expect(getMock.mock.calls[1][0]).toBe('/api/admin/kpis/scope-count?programs=B');
    await act(async () => { b.resolve({ success: true, data: { count: 5 } }); });
    await waitFor(() => expect(result.current).toEqual({ status: 'ok', count: 5 }));
    await act(async () => { a.resolve({ success: true, data: { count: 99 } }); });
    expect(result.current).toEqual({ status: 'ok', count: 5 });
  });

  it('debounces rapid changes into one request; surfaces an error honestly; idle when disabled', async () => {
    getMock.mockResolvedValue({ success: false, error: 'Forbidden' });
    const { result, rerender } = renderHook(({ s, enabled }) => useMatchingOutletCount(s, { debounceMs: 30, enabled }), {
      initialProps: { s: S({ programs: ['A'] }), enabled: true },
    });
    expect(result.current.status).toBe('loading');
    rerender({ s: S({ programs: ['A', 'B'] }), enabled: true });
    await waitFor(() => expect(result.current).toEqual({ status: 'error', error: 'Forbidden' }));
    expect(getMock).toHaveBeenCalledTimes(1);
    rerender({ s: S({ programs: ['A', 'B'] }), enabled: false });
    expect(result.current.status).toBe('idle');
  });
});

describe('useScopeOptions', () => {
  beforeEach(() => getMock.mockReset());

  it('loads options; a malformed payload is an error, not an empty list', async () => {
    getMock.mockResolvedValueOnce({ success: true, data: [{ code: 'K' }] });
    const { result } = renderHook(() => useScopeOptions());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Unexpected response');
    expect(result.current.data).toBeNull();
    getMock.mockResolvedValueOnce({ success: true, data: { outletTypes: [], programs: [{ value: 'U', inSettings: true }], subPrograms: [] } });
    await act(async () => { await result.current.retry(); });
    expect(result.current.error).toBeNull();
    expect(result.current.data?.programs).toHaveLength(1);
  });
});
