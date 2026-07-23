/**
 * PIS — usePartnerIdentity self-heals a stale/foreign active-partner selection.
 *
 * GET /api/partner/me returns `activeSelectorInvalid: true` when the `active_partner_id`
 * cookie named a non-operable partner and the backend degraded to the login's OWN outlet.
 * The hook must then clear the cookie ONCE (setActivePartner(null)) so every other page/
 * request stops carrying the bad id — and must NOT loop.
 *
 * PIS1: activeSelectorInvalid:true → setActivePartner(null) called exactly once
 * PIS2: activeSelectorInvalid absent/false → setActivePartner is NOT called (byte-identical
 *        to today's single-outlet behaviour)
 */
import { renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const setActivePartnerMock = vi.fn().mockResolvedValue({ success: true });
vi.mock('@/lib/active-partner-actions', () => ({
  setActivePartner: (id: string | null) => setActivePartnerMock(id),
}));

import { usePartnerIdentity } from '@/lib/partner-identity';

function installFetch(data: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ data }) }),
  ));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('token', 'tok');
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('PIS — partner identity self-heal of a stale active-partner cookie', () => {
  it('PIS1: clears the cookie exactly once when activeSelectorInvalid is true', async () => {
    installFetch({ businessName: 'Kumar Store', activeSelectorInvalid: true });
    const { result } = renderHook(() => usePartnerIdentity());

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(setActivePartnerMock).toHaveBeenCalledTimes(1));
    expect(setActivePartnerMock).toHaveBeenCalledWith(null);
    // The invalid flag is surfaced on the identity for consumers that want it.
    expect(result.current.activeSelectorInvalid).toBe(true);

    // Give any stray re-render a chance — the heal must stay fire-once (no loop).
    await new Promise((r) => setTimeout(r, 20));
    expect(setActivePartnerMock).toHaveBeenCalledTimes(1);
  });

  it('PIS2: does NOT clear the cookie when activeSelectorInvalid is absent', async () => {
    installFetch({ businessName: 'Kumar Store' });
    const { result } = renderHook(() => usePartnerIdentity());

    await waitFor(() => expect(result.current.loading).toBe(false));
    await new Promise((r) => setTimeout(r, 20));
    expect(setActivePartnerMock).not.toHaveBeenCalled();
    expect(result.current.activeSelectorInvalid).toBe(false);
  });
});
