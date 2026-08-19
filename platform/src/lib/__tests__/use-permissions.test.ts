/// <reference types="vitest/globals" />
/**
 * RBAC Option-X P6 — usePermissions() semantics.
 *
 * The load-bearing invariant: the feature is INERT for everyone except GIFSY_STAFF.
 *   - staff      → has(p) === permissions.includes(p)
 *   - owner      → has(p) === true (never gated)
 *   - any other  → has(p) === true (never gated)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  hasPermissionFor,
  usePermissions,
  __resetPermissionsForTests,
} from '@/lib/use-permissions';

function login(role: string) {
  localStorage.setItem('user', JSON.stringify({ id: 'u1', name: 'X', role, phone: '9' }));
}

/** Stub GET /api/auth/me → { success, data: { permissions } } (api-client envelope). */
function installMe(permissions: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ success: true, data: { permissions } }),
      }),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  __resetPermissionsForTests();
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hasPermissionFor() — pure semantic', () => {
  it('staff: gated to their granted keys', () => {
    expect(hasPermissionFor('GIFSY_STAFF', ['kyc:read'], 'kyc:read')).toBe(true);
    expect(hasPermissionFor('GIFSY_STAFF', ['kyc:read'], 'schemes:read')).toBe(false);
    expect(hasPermissionFor('GIFSY_STAFF', [], 'kyc:read')).toBe(false);
  });

  it('owner (GIFSY_ADMIN): always true regardless of the list', () => {
    expect(hasPermissionFor('GIFSY_ADMIN', [], 'kyc:read')).toBe(true);
    expect(hasPermissionFor('GIFSY_ADMIN', [], 'payouts:view_tds')).toBe(true);
  });

  it('every other role + null: always true (never gated)', () => {
    expect(hasPermissionFor('CLIENT_ADMIN', [], 'schemes:read')).toBe(true);
    expect(hasPermissionFor('MIS_USER', [], 'anything:at:all')).toBe(true);
    expect(hasPermissionFor(null, [], 'kyc:read')).toBe(true);
  });
});

describe('usePermissions() — hook', () => {
  it('owner: ready immediately, has() true, and NO /api/auth/me fetch', async () => {
    login('GIFSY_ADMIN');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePermissions());
    expect(result.current.ready).toBe(true);
    expect(result.current.has('payouts:view_tds')).toBe(true);
    // Feature is free for non-staff — it must never call /me.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('other role: ready immediately + always permitted, no fetch', async () => {
    login('CLIENT_ADMIN');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePermissions());
    expect(result.current.ready).toBe(true);
    expect(result.current.has('schemes:read')).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('staff: fetches /me and gates has() to the granted keys', async () => {
    login('GIFSY_STAFF');
    installMe(['kyc:read', 'kyc:gifsy_approve']);

    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.has('kyc:read')).toBe(true);
    expect(result.current.has('kyc:gifsy_approve')).toBe(true);
    expect(result.current.has('schemes:read')).toBe(false);
    expect(result.current.permissions).toEqual(['kyc:read', 'kyc:gifsy_approve']);
  });

  it('staff: fetches /me at most once across multiple hook mounts (cached)', async () => {
    login('GIFSY_STAFF');
    installMe(['kyc:read']);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

    const a = renderHook(() => usePermissions());
    await waitFor(() => expect(a.result.current.ready).toBe(true));
    renderHook(() => usePermissions());
    await new Promise((r) => setTimeout(r, 20));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
