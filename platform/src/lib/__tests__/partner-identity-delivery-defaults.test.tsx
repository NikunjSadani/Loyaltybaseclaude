/**
 * PIDD — usePartnerIdentity carries the ACTIVE outlet's delivery-address pre-fill
 * (`deliveryDefaults` on GET /api/partner/me; PLATFORM-WIDE, outlet address only).
 */
import { renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/active-partner-actions', () => ({
  setActivePartner: vi.fn().mockResolvedValue({ success: true }),
}));

import { usePartnerIdentity } from '@/lib/partner-identity';

function installFetch(data: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ data }) }),
  ));
}

const FULL = { line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' };

beforeEach(() => { localStorage.setItem('token', 'tok'); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('PIDD — usePartnerIdentity deliveryDefaults', () => {
  it('starts null while /partner/me is loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { result } = renderHook(() => usePartnerIdentity());
    expect(result.current.deliveryDefaults).toBeNull();
  });

  it('exposes the outlet address returned by /partner/me', async () => {
    installFetch({ businessName: 'Kumar Store', deliveryDefaults: FULL });
    const { result } = renderHook(() => usePartnerIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.deliveryDefaults).toEqual(FULL);
  });

  it('keeps null fields as null (partial address on file)', async () => {
    const partial = { line1: null, city: 'Pune', state: 'Maharashtra', pincode: null };
    installFetch({ deliveryDefaults: partial });
    const { result } = renderHook(() => usePartnerIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.deliveryDefaults).toEqual(partial);
  });

  it('is null when the response has no deliveryDefaults key (older backend)', async () => {
    installFetch({ businessName: 'Kumar Store' });
    const { result } = renderHook(() => usePartnerIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.deliveryDefaults).toBeNull();
  });

  it.each([
    ['a string', '12 MG Road'],
    ['an array', ['12 MG Road']],
    ['a non-string field', { line1: 12, city: 'Pune', state: null, pincode: null }],
  ])('is null when deliveryDefaults is malformed (%s)', async (_label, value) => {
    installFetch({ deliveryDefaults: value });
    const { result } = renderHook(() => usePartnerIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.deliveryDefaults).toBeNull();
  });

  it('is null and loading settles when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network'))));
    const { result } = renderHook(() => usePartnerIdentity());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.deliveryDefaults).toBeNull();
  });
});
