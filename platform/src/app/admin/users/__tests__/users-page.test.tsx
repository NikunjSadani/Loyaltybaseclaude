/// <reference types="vitest/globals" />
/**
 * Admin User Accounts page — UI tests
 *
 * AU1: the list renders from the real {success,data:{users}} envelope
 * AU2: the Create modal POSTs the right body (name/phone/role[/email]) and refreshes the list
 * AU3: role options are gated by the CALLER role AND context
 *        - a CLIENT_ADMIN caller sees ONLY MIS_USER
 *        - a GIFSY_ADMIN caller in PLATFORM (gifsy) context sees all three (GIFSY_ADMIN, CLIENT_ADMIN, MIS_USER)
 *        - a GIFSY_ADMIN caller ASSUMED INTO A TENANT does NOT see GIFSY_ADMIN (footgun guard)
 * AU4: a 400 (phone exists) and a 403 (disallowed role) surface the backend error verbatim
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Mock the role source (admin session) — the page gates the form by session.role ──
// userId defaults to a value that matches NO row in USERS, so the Deactivate button
// renders for every row in the existing assertions. Individual tests override userId.
const mockSession = { role: 'GIFSY_ADMIN', clientId: 'gifsy', name: 'Op', userId: 'self-op', canManageSchemes: true };
vi.mock('@/lib/admin-session', () => ({
  useAdminSession: () => mockSession,
}));

// ── Mock tenant context sources ──
vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: () => ({ branding: { displayName: 'Deoleo India' } }),
}));
// getAssumedBrand is controllable per-test: null = platform (gifsy) context,
// a brand string = the GIFSY operator has assumed that tenant.
const mockGetAssumedBrand = vi.fn((): string | null => null);
vi.mock('@/lib/auth-client', () => ({
  getAssumedBrand: () => mockGetAssumedBrand(),
}));

import AdminUsersPage from '../page';

const USERS = [
  { id: 'u1', name: 'Priya Sharma', email: 'priya@deoleo.com', phone: '9830011252', role: 'CLIENT_ADMIN', status: 'ACTIVE',   createdAt: '2026-06-01T00:00:00.000Z' },
  { id: 'u2', name: 'Ravi Kumar',   email: null,               phone: '9900000041', role: 'MIS_USER',     status: 'INACTIVE', createdAt: '2026-06-02T00:00:00.000Z' },
];

function jsonRes(ok: boolean, status: number, body: unknown) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

function installFetch(over?: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const custom = over?.(url, init);
    if (custom !== undefined) return custom as Promise<unknown>;

    if (url.startsWith('/api/admin/users') && (!init || init.method === 'GET' || !init.method)) {
      return jsonRes(true, 200, {
        success: true,
        data: {
          users: USERS,
          pagination: { page: 1, limit: 20, total: USERS.length, pages: 1, hasNextPage: false, hasPrevPage: false },
        },
      });
    }
    if (url.startsWith('/api/admin/users') && init?.method === 'POST') {
      return jsonRes(true, 200, { success: true, data: { user: { id: 'u3' } } });
    }
    return jsonRes(true, 200, { success: true, data: {} });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

beforeEach(() => {
  mockSession.role = 'GIFSY_ADMIN';
  mockSession.userId = 'self-op';
  mockGetAssumedBrand.mockReturnValue(null); // default: platform (gifsy) context
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Admin User Accounts page', () => {
  it('AU1: renders the user list from the {success,data:{users}} envelope', async () => {
    installFetch();
    render(<AdminUsersPage />);
    expect(await screen.findByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Ravi Kumar')).toBeInTheDocument();
    expect(screen.getByText('9830011252')).toBeInTheDocument();
  });

  it('AU2: the Create modal POSTs name/phone/role/email and refreshes', async () => {
    const { calls } = installFetch();
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    await userEvent.click(screen.getByRole('button', { name: /create user/i }));
    const dialog = await screen.findByRole('dialog');
    const scope = within(dialog);

    await userEvent.type(scope.getByPlaceholderText('e.g. Priya Sharma'), 'New Admin');
    await userEvent.type(scope.getByPlaceholderText('9830011252'), '9123456780');
    await userEvent.type(scope.getByPlaceholderText('user@company.com'), 'new@deoleo.com');
    // GIFSY_ADMIN default role is the first option (GIFSY_ADMIN); pick CLIENT_ADMIN
    await userEvent.selectOptions(scope.getByLabelText('Role'), 'CLIENT_ADMIN');

    await userEvent.click(scope.getByRole('button', { name: /^create user$/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.url.startsWith('/api/admin/users') && c.init?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post!.init!.body));
      expect(body).toEqual({ name: 'New Admin', phone: '9123456780', role: 'CLIENT_ADMIN', email: 'new@deoleo.com' });
    });

    // modal closes + list re-fetched (>1 GET to /api/admin/users)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const gets = calls.filter((c) => c.url.startsWith('/api/admin/users') && (!c.init || !c.init.method || c.init.method === 'GET'));
      expect(gets.length).toBeGreaterThan(1);
    });
  });

  it('AU3a: a CLIENT_ADMIN caller sees ONLY MIS_USER in the role select', async () => {
    mockSession.role = 'CLIENT_ADMIN';
    installFetch();
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    await userEvent.click(screen.getByRole('button', { name: /create user/i }));
    const select = await within(await screen.findByRole('dialog')).findByLabelText('Role');
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['MIS_USER']);
  });

  it('AU3b: a GIFSY_ADMIN caller in PLATFORM (gifsy) context sees all three admin roles', async () => {
    mockSession.role = 'GIFSY_ADMIN';
    mockGetAssumedBrand.mockReturnValue(null); // platform context
    installFetch();
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    await userEvent.click(screen.getByRole('button', { name: /create user/i }));
    const select = await within(await screen.findByRole('dialog')).findByLabelText('Role');
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER']);
  });

  it('AU3c: a GIFSY_ADMIN caller ASSUMED INTO A TENANT does NOT see the GIFSY_ADMIN option', async () => {
    mockSession.role = 'GIFSY_ADMIN';
    mockGetAssumedBrand.mockReturnValue('Deoleo India'); // assumed into a tenant
    installFetch();
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    await userEvent.click(screen.getByRole('button', { name: /create user/i }));
    const select = await within(await screen.findByRole('dialog')).findByLabelText('Role');
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    // GIFSY_ADMIN is withheld in a tenant context — the footgun guard.
    expect(options).toEqual(['CLIENT_ADMIN', 'MIS_USER']);
    expect(options).not.toContain('GIFSY_ADMIN');
  });

  it('AU5: the Deactivate/Reactivate button is NOT rendered for the signed-in user own row', async () => {
    // The current operator IS u1 (Priya, ACTIVE) — their own row must not offer self-deactivation.
    mockSession.userId = 'u1';
    installFetch();
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    // u1 (self) row: no Deactivate button, a muted dash instead.
    const selfRow = screen.getByText('Priya Sharma').closest('tr')!;
    expect(within(selfRow).queryByRole('button', { name: /deactivate/i })).not.toBeInTheDocument();
    expect(within(selfRow).getByText('—')).toBeInTheDocument();

    // u2 (someone else, INACTIVE) row: the Reactivate button is still present.
    const otherRow = screen.getByText('Ravi Kumar').closest('tr')!;
    expect(within(otherRow).getByRole('button', { name: /reactivate/i })).toBeInTheDocument();
  });

  it('AU6: "Revoke sessions" opens a confirm modal and POSTs /api/admin/users/:id/revoke-sessions', async () => {
    // Operator is not any listed user → both rows show the Revoke sessions action.
    mockSession.userId = 'self-op';
    const { calls } = installFetch((url, init) => {
      if (url.includes('/revoke-sessions') && init?.method === 'POST') {
        return jsonRes(true, 200, { success: true, data: { revoked: 2 } });
      }
      return undefined;
    });
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    // Open the confirm modal from Ravi Kumar's (u2) row.
    const row = screen.getByText('Ravi Kumar').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: /revoke sessions/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/log this user out of all devices/i)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: /^revoke sessions$/i }));

    await waitFor(() => {
      const post = calls.find((c) => c.url === '/api/admin/users/u2/revoke-sessions' && c.init?.method === 'POST');
      expect(post).toBeTruthy();
    });
    // Modal closes after success.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('AU7: the Edit modal pre-fills, PATCHes /api/admin/users/:id with name/phone/role/email, and refreshes', async () => {
    mockSession.userId = 'self-op'; // not a listed user → every row shows the Edit action
    const { calls } = installFetch((url, init) => {
      if (/\/api\/admin\/users\/u1$/.test(url) && init?.method === 'PATCH') {
        return jsonRes(true, 200, { success: true, data: { user: { id: 'u1' } } });
      }
      return undefined;
    });
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    await userEvent.click(screen.getByRole('button', { name: /edit priya sharma/i }));
    const dialog = await screen.findByRole('dialog');
    const scope = within(dialog);

    // Pre-filled from the row.
    expect((scope.getByPlaceholderText('e.g. Priya Sharma') as HTMLInputElement).value).toBe('Priya Sharma');
    expect((scope.getByPlaceholderText('9830011252') as HTMLInputElement).value).toBe('9830011252');
    expect((scope.getByPlaceholderText('user@company.com') as HTMLInputElement).value).toBe('priya@deoleo.com');
    expect((scope.getByLabelText('Role') as HTMLSelectElement).value).toBe('CLIENT_ADMIN');

    // Rename and save.
    await userEvent.clear(scope.getByPlaceholderText('e.g. Priya Sharma'));
    await userEvent.type(scope.getByPlaceholderText('e.g. Priya Sharma'), 'Priya S');
    await userEvent.click(scope.getByRole('button', { name: /^save changes$/i }));

    await waitFor(() => {
      const patch = calls.find((c) => /\/api\/admin\/users\/u1$/.test(c.url) && c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch!.init!.body));
      // Rename only (role unchanged) → sends name/phone/email but NOT role (the backend runs its
      // role-assignable guard on presence, so sending an unchanged role would 403 a CLIENT_ADMIN
      // editing a fellow admin). Never status.
      expect(body).toEqual({ name: 'Priya S', phone: '9830011252', email: 'priya@deoleo.com' });
      expect(body).not.toHaveProperty('role');
      expect(body).not.toHaveProperty('status');
    });

    // Modal closes + list re-fetched (>1 GET).
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const gets = calls.filter((c) => c.url.startsWith('/api/admin/users') && (!c.init || !c.init.method || c.init.method === 'GET'));
      expect(gets.length).toBeGreaterThan(1);
    });
  });

  it('AU8: an Edit PATCH clearing the email sends email:null', async () => {
    mockSession.userId = 'self-op';
    const { calls } = installFetch((url, init) => {
      if (/\/api\/admin\/users\/u1$/.test(url) && init?.method === 'PATCH') {
        return jsonRes(true, 200, { success: true, data: { user: { id: 'u1' } } });
      }
      return undefined;
    });
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    await userEvent.click(screen.getByRole('button', { name: /edit priya sharma/i }));
    const scope = within(await screen.findByRole('dialog'));
    await userEvent.clear(scope.getByPlaceholderText('user@company.com'));
    await userEvent.click(scope.getByRole('button', { name: /^save changes$/i }));

    await waitFor(() => {
      const patch = calls.find((c) => /\/api\/admin\/users\/u1$/.test(c.url) && c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch!.init!.body));
      expect(body.email).toBeNull();
    });
  });

  it('AU9: the Edit role select always includes the user CURRENT role, even if the caller cannot assign it', async () => {
    // A CLIENT_ADMIN caller can only assign MIS_USER, but must still SEE + keep u1's CLIENT_ADMIN role.
    mockSession.role = 'CLIENT_ADMIN';
    mockSession.userId = 'self-op';
    installFetch();
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    await userEvent.click(screen.getByRole('button', { name: /edit priya sharma/i }));
    const select = await within(await screen.findByRole('dialog')).findByLabelText('Role');
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('MIS_USER');       // assignable
    expect(options).toContain('CLIENT_ADMIN');   // current role, kept even though not assignable
    expect((select as HTMLSelectElement).value).toBe('CLIENT_ADMIN'); // pre-selected to current
  });

  it('AU9b: a CLIENT_ADMIN editing a fellow CLIENT_ADMIN\'s name does NOT send role (would 403 on the backend)', async () => {
    // Regression lock: the backend runs assertRoleAssignable on dto.role PRESENCE. A CLIENT_ADMIN
    // caller cannot assign CLIENT_ADMIN, so if the modal echoed the unchanged current role the
    // save would 403 with a misleading role error. The body must omit role when it didn't change.
    mockSession.role = 'CLIENT_ADMIN';
    mockSession.userId = 'self-op';
    const { calls } = installFetch((url, init) => {
      if (/\/api\/admin\/users\/u1$/.test(url) && init?.method === 'PATCH') {
        return jsonRes(true, 200, { success: true, data: { user: { id: 'u1' } } });
      }
      return undefined;
    });
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    await userEvent.click(screen.getByRole('button', { name: /edit priya sharma/i }));
    const scope = within(await screen.findByRole('dialog'));
    await userEvent.clear(scope.getByPlaceholderText('e.g. Priya Sharma'));
    await userEvent.type(scope.getByPlaceholderText('e.g. Priya Sharma'), 'Priya S');
    await userEvent.click(scope.getByRole('button', { name: /^save changes$/i }));

    await waitFor(() => {
      const patch = calls.find((c) => /\/api\/admin\/users\/u1$/.test(c.url) && c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch!.init!.body));
      expect(body).not.toHaveProperty('role'); // unchanged role is NOT sent → no spurious 403
      expect(body.name).toBe('Priya S');
    });
  });

  it('AU9c: a GIFSY_ADMIN who CHANGES the role sends role in the PATCH body', async () => {
    mockSession.role = 'GIFSY_ADMIN';
    mockSession.userId = 'self-op';
    const { calls } = installFetch((url, init) => {
      if (/\/api\/admin\/users\/u1$/.test(url) && init?.method === 'PATCH') {
        return jsonRes(true, 200, { success: true, data: { user: { id: 'u1' } } });
      }
      return undefined;
    });
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    await userEvent.click(screen.getByRole('button', { name: /edit priya sharma/i }));
    const scope = within(await screen.findByRole('dialog'));
    await userEvent.selectOptions(scope.getByLabelText('Role'), 'MIS_USER');
    await userEvent.click(scope.getByRole('button', { name: /^save changes$/i }));

    await waitFor(() => {
      const patch = calls.find((c) => /\/api\/admin\/users\/u1$/.test(c.url) && c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch!.init!.body));
      expect(body.role).toBe('MIS_USER'); // changed role IS sent
    });
  });

  it('AU10: an Edit backend 409 (phone clash) surfaces verbatim and the modal stays open', async () => {
    mockSession.userId = 'self-op';
    installFetch((url, init) => {
      if (/\/api\/admin\/users\/u1$/.test(url) && init?.method === 'PATCH') {
        return jsonRes(false, 409, { success: false, error: 'Phone number already in use' });
      }
      return undefined;
    });
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    await userEvent.click(screen.getByRole('button', { name: /edit priya sharma/i }));
    const scope = within(await screen.findByRole('dialog'));
    await userEvent.clear(scope.getByPlaceholderText('9830011252'));
    await userEvent.type(scope.getByPlaceholderText('9830011252'), '9900000041');
    await userEvent.click(scope.getByRole('button', { name: /^save changes$/i }));

    expect(await screen.findByText('Phone number already in use')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument(); // stays open to correct
  });

  it('AU4: a backend 400/403 surfaces the error message inline (not swallowed)', async () => {
    installFetch((url, init) => {
      if (url.startsWith('/api/admin/users') && init?.method === 'POST') {
        return jsonRes(false, 400, { success: false, error: 'User with this phone already exists' });
      }
      return undefined;
    });
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    await userEvent.click(screen.getByRole('button', { name: /create user/i }));
    const dialog = await screen.findByRole('dialog');
    const scope = within(dialog);

    await userEvent.type(scope.getByPlaceholderText('e.g. Priya Sharma'), 'Dup User');
    await userEvent.type(scope.getByPlaceholderText('9830011252'), '9830011252');
    await userEvent.click(scope.getByRole('button', { name: /^create user$/i }));

    expect(await screen.findByText('User with this phone already exists')).toBeInTheDocument();
    // modal stays open so the operator can correct the input
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
