/// <reference types="vitest/globals" />
/**
 * User Accounts — vacant / former logins (audit L1 + UI 3).
 *  UV1: a vacant position's login shows "Vacant position <code>" and a former employee's closed login
 *       "Former employee <code>" — never the synthetic name/phone; a former login has no Edit button.
 *  UV2: "Reactivate" on a vacant login is refused with the plain pointer to "Fill vacant position"
 *       and sends nothing.
 *  UV3: a save that committed with a sign-out problem shows an amber WARNING toast — never "User updated."
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';

const mockSession = { role: 'GIFSY_ADMIN', name: 'Op', userId: 'self-op', canManageSchemes: true };
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => mockSession }));
vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: () => ({ branding: { displayName: 'Bajaj' } }),
}));
vi.mock('@/lib/auth-client', () => ({ getAssumedBrand: () => 'bajaj' }));

import AdminUsersPage from '../page';

const USERS = [
  {
    id: 'u-vac', name: '(vacant) Pune101', email: null, phone: '__vacant__:Pune101', role: 'SALES_SO', status: 'INACTIVE',
    salesUser: { id: 's1', employeeCode: 'Pune101', hierarchyLevelId: 'lvl1', reportingToId: null },
  },
  { id: 'u-old', name: '(former) Pune102', email: null, phone: '__vacant__:Pune102', role: 'SALES_SO', status: 'INACTIVE', salesUser: null },
  {
    id: 'u-emp', name: 'Asha Patel', email: null, phone: '9800000009', role: 'SALES_SO', status: 'ACTIVE',
    salesUser: { id: 's3', employeeCode: 'Pune103', hierarchyLevelId: 'lvl1', reportingToId: null },
  },
];

function jsonRes(ok: boolean, status: number, body: unknown) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

function installFetch(over?: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const custom = over?.(url, init);
    if (custom !== undefined) return custom as Promise<unknown>;
    if (url.startsWith('/api/admin/users') && (!init || !init.method || init.method === 'GET')) {
      return jsonRes(true, 200, {
        success: true,
        data: { users: USERS, pagination: { page: 1, limit: 20, total: 3, pages: 1, hasNextPage: false, hasPrevPage: false } },
      });
    }
    return jsonRes(true, 200, { success: true, data: { levels: [], managers: [] } });
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('User Accounts — vacant / former logins', () => {
  it('UV1: shows "Vacant position <code>" / "Former employee <code>", never the synthetic values', async () => {
    installFetch();
    render(<AdminUsersPage />);
    expect(await screen.findByText('Vacant position Pune101')).toBeInTheDocument();
    expect(screen.getByText('Former employee Pune102')).toBeInTheDocument();
    expect(screen.queryByText(/__vacant__/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\(vacant\)|\(former\)/)).not.toBeInTheDocument();
    // A former login is history — no Edit; the vacant position is still editable (to fill it).
    expect(screen.getByRole('button', { name: 'Edit Vacant position Pune101' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit Former employee/ })).not.toBeInTheDocument();
  });

  it('UV2: Reactivate on a vacant login is refused with a pointer to "Fill vacant position" — no request sent', async () => {
    const calls = installFetch();
    render(<AdminUsersPage />);
    const row = (await screen.findByText('Vacant position Pune101')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Fill vacant position.*Employee Hierarchy/);
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false);
  });

  it('UV3: a committed save with a sign-out problem shows a WARNING toast, not "User updated."', async () => {
    installFetch((url, init) =>
      url === '/api/admin/sales-users/s3' && init?.method === 'PATCH'
        ? jsonRes(true, 200, {
            success: true,
            data: { vacated: true, sessionRevokeFailures: [{ userId: 'u-emp' }], signOutUserId: 'u-emp',
              message: 'Position marked vacant, but the previous person could not be signed out yet.' },
          })
        : undefined,
    );
    render(<AdminUsersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Asha Patel' }));
    const dlg = within(await screen.findByRole('dialog'));
    await userEvent.clear(dlg.getByLabelText('Full name'));
    await userEvent.clear(dlg.getByLabelText('Phone (10 digits)'));
    await userEvent.click(dlg.getByRole('button', { name: /^save changes$/i }));
    const yes = await dlg.findByRole('button', { name: /yes, mark vacant/i });
    await waitFor(() => expect(yes).toBeEnabled(), { timeout: 2000 });
    await userEvent.click(yes);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => /could not be signed out/.test(a.textContent ?? ''))).toBe(true);
    expect(screen.queryByText('User updated.')).not.toBeInTheDocument();
  });
});
