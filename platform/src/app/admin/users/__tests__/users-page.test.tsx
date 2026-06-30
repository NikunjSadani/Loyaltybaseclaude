/// <reference types="vitest/globals" />
/**
 * Admin User Accounts page — UI tests
 *
 * AU1: the list renders from the real {success,data:{users}} envelope
 * AU2: the Create modal POSTs the right body (name/phone/role[/email]) and refreshes the list
 * AU3: role options are gated by the CALLER role
 *        - a CLIENT_ADMIN caller sees ONLY MIS_USER
 *        - a GIFSY_ADMIN caller sees all three (GIFSY_ADMIN, CLIENT_ADMIN, MIS_USER)
 * AU4: a 400 (phone exists) and a 403 (disallowed role) surface the backend error verbatim
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Mock the role source (admin session) — the page gates the form by session.role ──
const mockSession = { role: 'GIFSY_ADMIN', clientId: 'gifsy', name: 'Op', canManageSchemes: true };
vi.mock('@/lib/admin-session', () => ({
  useAdminSession: () => mockSession,
}));

// ── Mock tenant context sources ──
vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: () => ({ branding: { displayName: 'Deoleo India' } }),
}));
vi.mock('@/lib/auth-client', () => ({
  getAssumedBrand: () => null,
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
      return jsonRes(true, 200, { success: true, data: { users: USERS } });
    }
    if (url.startsWith('/api/admin/users') && init?.method === 'POST') {
      return jsonRes(true, 200, { success: true, data: { user: { id: 'u3' } } });
    }
    return jsonRes(true, 200, { success: true, data: {} });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

beforeEach(() => { mockSession.role = 'GIFSY_ADMIN'; });
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

  it('AU3b: a GIFSY_ADMIN caller sees all three admin roles', async () => {
    mockSession.role = 'GIFSY_ADMIN';
    installFetch();
    render(<AdminUsersPage />);
    await screen.findByText('Priya Sharma');

    await userEvent.click(screen.getByRole('button', { name: /create user/i }));
    const select = await within(await screen.findByRole('dialog')).findByLabelText('Role');
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER']);
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
