/// <reference types="vitest/globals" />
/**
 * RBAC Option-X P6 — AdminRouteGuard page-level behaviour.
 *
 *   - owner (GIFSY_ADMIN) → always the page (never gated, no /me fetch)
 *   - staff WITH the mapped perm → the page
 *   - staff WITHOUT the mapped perm → <AccessDenied/> instead of the page
 *   - ungated route → the page even for staff lacking everything
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { __resetPermissionsForTests } from '@/lib/use-permissions';

// Control usePathname per test via a hoisted holder.
const nav = vi.hoisted(() => ({ pathname: '/admin/schemes' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

import { AdminRouteGuard } from '@/components/rbac/admin-route-guard';

function login(role: string) {
  localStorage.setItem('user', JSON.stringify({ id: 'u1', name: 'X', role, phone: '9' }));
}
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
const PAGE = <div>SECRET PAGE CONTENT</div>;

beforeEach(() => {
  localStorage.clear();
  __resetPermissionsForTests();
  vi.restoreAllMocks();
  nav.pathname = '/admin/schemes';
});
afterEach(() => vi.unstubAllGlobals());

describe('<AdminRouteGuard/>', () => {
  it('owner: always renders the page (no gating, no fetch)', async () => {
    login('GIFSY_ADMIN');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<AdminRouteGuard>{PAGE}</AdminRouteGuard>);
    expect(screen.getByText('SECRET PAGE CONTENT')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('staff WITH the mapped permission: renders the page', async () => {
    login('GIFSY_STAFF');
    installMe(['schemes:read']); // /admin/schemes → schemes:read
    render(<AdminRouteGuard>{PAGE}</AdminRouteGuard>);
    await waitFor(() => expect(screen.getByText('SECRET PAGE CONTENT')).toBeTruthy());
    expect(screen.queryByText("You don't have permission to access this")).toBeNull();
  });

  it('staff WITHOUT the mapped permission: renders AccessDenied, not the page', async () => {
    login('GIFSY_STAFF');
    installMe(['kyc:read']); // lacks schemes:read
    render(<AdminRouteGuard>{PAGE}</AdminRouteGuard>);
    await waitFor(() =>
      expect(screen.getByText("You don't have permission to access this")).toBeTruthy(),
    );
    expect(screen.queryByText('SECRET PAGE CONTENT')).toBeNull();
  });

  it('ungated route: renders the page even for a staff with no permissions', async () => {
    nav.pathname = '/admin/dashboard'; // intentionally ungated
    login('GIFSY_STAFF');
    installMe([]);
    render(<AdminRouteGuard>{PAGE}</AdminRouteGuard>);
    await waitFor(() => expect(screen.getByText('SECRET PAGE CONTENT')).toBeTruthy());
  });
});
