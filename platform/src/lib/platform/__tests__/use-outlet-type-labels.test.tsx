/// <reference types="vitest/globals" />
/**
 * useOutletTypeLabels — config-driven outlet-type display labels from GET /api/settings/outlet-types.
 *
 * The CRITICAL property is the byte-identical fallback: the override map is empty until the fetch
 * resolves, on failure, and for a tenant with no overrides — so `label(code, current)` returns the
 * caller's current literal in every one of those cases (Deoleo stays identical, no label flash).
 */
import { renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { useOutletTypeLabels } from '../use-outlet-type-labels';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const envelope = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });

describe('useOutletTypeLabels', () => {
  it('UAT1: BAJAJ overrides surface in the map + label(); unset code falls back to the caller literal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope([
      { code: 'SSS', label: 'RLP', name: 'SSS', displayName: 'RLP' },
      { code: 'WHOLESALER', label: 'BSC', name: 'Wholesaler', displayName: 'BSC' },
      { code: 'SUB_STOCKIST', label: 'Sub-Stockist', name: 'Sub-Stockist', displayName: null },
    ])));
    const { result } = renderHook(() => useOutletTypeLabels());
    await waitFor(() => expect(result.current.overrides.size).toBe(2));
    expect(fetch).toHaveBeenCalledWith('/api/settings/outlet-types', { credentials: 'include' });
    expect(result.current.label('SSS', 'SSS')).toBe('RLP');
    expect(result.current.label('WHOLESALER', 'Wholesaler')).toBe('BSC');
    // No override for SUB_STOCKIST ⇒ caller's current literal is preserved exactly.
    expect(result.current.label('SUB_STOCKIST', 'Sub-Stockist')).toBe('Sub-Stockist');
    expect(result.current.loading).toBe(false);
  });

  it('UAT2: DEOLEO (all displayName null) → empty overrides, label() returns the caller literal (byte-identical)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope([
      { code: 'SSS', label: 'SSS', name: 'SSS', displayName: null },
      { code: 'WHOLESALER', label: 'Wholesaler', name: 'Wholesaler', displayName: null },
    ])));
    const { result } = renderHook(() => useOutletTypeLabels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.overrides.size).toBe(0);
    expect(result.current.label('SSS', 'SSS')).toBe('SSS');
    expect(result.current.label('WHOLESALER', 'Wholesaler')).toBe('Wholesaler');
  });

  it('UAT3: before resolve (and on failure) overrides is empty ⇒ fallbacks win, no label flash', async () => {
    // A never-resolving fetch keeps loading true: label() must already return the fallback.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    const { result } = renderHook(() => useOutletTypeLabels());
    expect(result.current.overrides.size).toBe(0);
    expect(result.current.label('SSS', 'SSS')).toBe('SSS');
    expect(result.current.loading).toBe(true);
  });

  it('UAT4: a rejected fetch leaves empty overrides and clears loading (never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const { result } = renderHook(() => useOutletTypeLabels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.overrides.size).toBe(0);
    expect(result.current.label('WHOLESALER', 'Wholesaler')).toBe('Wholesaler');
  });

  it('UAT5: a blank/whitespace displayName is ignored (trimmed → fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope([
      { code: 'SSS', label: 'SSS', name: 'SSS', displayName: '   ' },
    ])));
    const { result } = renderHook(() => useOutletTypeLabels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.overrides.size).toBe(0);
    expect(result.current.label('SSS', 'SSS')).toBe('SSS');
  });
});
