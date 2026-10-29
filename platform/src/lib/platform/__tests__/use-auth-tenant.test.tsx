/// <reference types="vitest/globals" />
/**
 * useAuthClientId — the authoritative tenant slug from /auth/me (JWT clientId), used to fix the
 * SSR host-slug degrading to 'default' for DB-provisioned tenants (Bajaj ISR headers → XSR bug).
 *
 * UAT1: resolves to the authenticated clientId when /auth/me returns one (→ page picks BAJAJ config)
 * UAT2: stays null when /auth/me fails / is unauthenticated (→ caller falls back to the SSR slug)
 */
import { renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { useAuthClientId } from '../use-auth-tenant';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('useAuthClientId', () => {
  it('UAT1: returns the authenticated clientId from /auth/me', async () => {
    // FAITHFUL to the real endpoint: /auth/me returns the global { success, data } envelope,
    // so clientId is at data.clientId (a flat mock here would mask the envelope bug the audit caught).
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { clientId: 'bajaj', assumed: false } }),
    }));
    const { result } = renderHook(() => useAuthClientId());
    await waitFor(() => expect(result.current).toBe('bajaj'));
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', { credentials: 'include' });
  });

  it('UAT2: stays null when /auth/me is unauthorized (caller falls back to the SSR slug)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    const { result } = renderHook(() => useAuthClientId());
    // give the effect a tick; it must not throw and must leave the value null
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current).toBeNull();
  });
});
