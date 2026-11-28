/// <reference types="vitest/globals" />
/**
 * Admin User Accounts page — Outlet ID column + outlet-ID search.
 *
 * OID1: an outlet/partner login shows its primary outlet code; a multi-outlet login shows " +N"
 * OID2: admin / MIS rows (no outletCode) show "—"; an older API response without the field also "—"
 * OID3: the column header sits right after Phone
 * OID4: typing an outlet ID sends it to the API as the `search` param (server-side match)
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockSession = { role: 'GIFSY_ADMIN', name: 'Op', userId: 'self-op', canManageSchemes: true };
vi.mock('@/lib/admin-session', () => ({
  useAdminSession: () => mockSession,
}));
vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: () => ({ branding: { displayName: 'Bajaj Consumer Care' } }),
}));
vi.mock('@/lib/auth-client', () => ({
  getAssumedBrand: () => 'Bajaj Consumer Care',
}));

import AdminUsersPage from '../page';

const USERS = [
  { id: 'u1', name: 'Priya Sharma', email: null, phone: '9830011252', role: 'CLIENT_ADMIN', status: 'ACTIVE', outletCode: null, additionalOutletCount: 0 },
  { id: 'u2', name: 'Shree Traders', email: null, phone: '9900000041', role: 'SSS', status: 'ACTIVE', outletCode: 'BJ10023', additionalOutletCount: 0 },
  { id: 'u3', name: 'Multi Mart', email: null, phone: '9900000042', role: 'WHOLESALER', status: 'ACTIVE', outletCode: 'BJ20001', additionalOutletCount: 2 },
  // Older API response shape — no outlet fields at all.
  { id: 'u4', name: 'Ravi Kumar', email: null, phone: '9900000043', role: 'MIS_USER', status: 'ACTIVE' },
];

function installFetch() {
  const calls: string[] = [];
  const fn = vi.fn((url: string) => {
    calls.push(url);
    if (url.startsWith('/api/admin/users')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          success: true,
          data: { users: USERS, pagination: { page: 1, limit: 20, total: USERS.length, pages: 1, hasNextPage: false, hasPrevPage: false } },
        }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: {} }) });
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

beforeEach(() => { mockSession.role = 'GIFSY_ADMIN'; });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('User Accounts — Outlet ID column', () => {
  it('OID1: shows the primary outlet code, with a spaced, accessible " +N" for a multi-outlet login', async () => {
    installFetch();
    render(<AdminUsersPage />);
    const single = await screen.findByTestId('outlet-id-u2');
    expect(single.textContent).toBe('BJ10023');
    const multi = screen.getByTestId('outlet-id-u3');
    // Never run together: a space separates the code from the "+N".
    expect(multi.textContent).toMatch(/^BJ20001 \+2/);
    expect(multi.textContent).not.toContain('BJ20001+2');
    // Assistive tech gets words, not "+2"; the control is a keyboard/touch-reachable button.
    const more = within(multi).getByRole('button', { name: 'and 2 more outlets' });
    expect(within(more).getByText('+2')).toHaveAttribute('aria-hidden', 'true');
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('OID1b: tapping / pressing "+N" reveals "and N more outlets" (touch + keyboard)', async () => {
    installFetch();
    render(<AdminUsersPage />);
    const multi = await screen.findByTestId('outlet-id-u3');
    const more = within(multi).getByRole('button', { name: 'and 2 more outlets' });
    await userEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(multi.textContent).toBe('BJ20001 and 2 more outlets');
    // Keyboard: focus + Enter toggles it back.
    more.focus();
    await userEvent.keyboard('{Enter}');
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('OID2: admin / MIS rows (and an older response without the field) show "—"', async () => {
    installFetch();
    render(<AdminUsersPage />);
    expect((await screen.findByTestId('outlet-id-u1')).textContent).toBe('—');
    expect(screen.getByTestId('outlet-id-u4').textContent).toBe('—');
  });

  it('OID3: the Outlet ID header comes right after Phone', async () => {
    installFetch();
    render(<AdminUsersPage />);
    await screen.findByTestId('outlet-id-u1');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(0, 4)).toEqual(['Name', 'Phone', 'Outlet ID', 'Role']);
  });

  it('OID4: typing an outlet ID searches server-side via the search param', async () => {
    const { calls } = installFetch();
    render(<AdminUsersPage />);
    await screen.findByTestId('outlet-id-u1');
    await userEvent.type(screen.getByPlaceholderText('Name, phone, email or outlet ID'), 'bj100');
    await waitFor(() => {
      const last = calls.filter((u) => u.startsWith('/api/admin/users')).at(-1)!;
      expect(new URL(last, 'http://x').searchParams.get('search')).toBe('bj100');
    }, { timeout: 3000 });
  });

  it('OID5: a search with no match explains that outlets without a login are not listed', async () => {
    let empty = false;
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(url.startsWith('/api/admin/users')
        ? { success: true, data: { users: empty ? [] : USERS, pagination: { page: 1, limit: 20, total: empty ? 0 : USERS.length, pages: empty ? 0 : 1, hasNextPage: false, hasPrevPage: false } } }
        : { success: true, data: {} }),
    })));
    render(<AdminUsersPage />);
    await screen.findByTestId('outlet-id-u1');
    empty = true;
    await userEvent.type(screen.getByPlaceholderText('Name, phone, email or outlet ID'), 'ZZ9');
    expect(await screen.findByText("No user matches 'ZZ9'. An outlet without a login won't appear here.", {}, { timeout: 3000 }))
      .toBeInTheDocument();
    expect(screen.queryByText('No users yet.')).not.toBeInTheDocument();
  });

  it('OID6: with no search active, an empty list still says "No users yet."', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ success: true, data: { users: [], pagination: { page: 1, limit: 20, total: 0, pages: 0, hasNextPage: false, hasPrevPage: false } } }),
    })));
    render(<AdminUsersPage />);
    expect(await screen.findByText('No users yet.')).toBeInTheDocument();
  });
});
