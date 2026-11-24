/// <reference types="vitest/globals" />
/**
 * Employee Hierarchy tab — edit affordance (reuses the shared /admin/users EditUserModal)
 *
 * HE1: an ACTIVE, named employee row shows the edit pencil; a PLACEHOLDER row does NOT
 * HE2: clicking edit fetches the user (by employeeCode) + the level/manager options, then opens the modal
 * HE3: saving a change PATCHes /api/admin/sales-users/:id (the employee endpoint) and refreshes the list
 * HE4: when the employee can't be loaded (404), an honest error toast is shown (no silent failure, no modal)
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/admin/hierarchy',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('xlsx', () => ({
  utils: { book_new: vi.fn(() => ({})), aoa_to_sheet: vi.fn(() => ({})), book_append_sheet: vi.fn() },
  writeFile: vi.fn(),
  write: vi.fn(() => new ArrayBuffer(8)),
}));
Object.defineProperty(globalThis, 'URL', {
  value: { createObjectURL: vi.fn(() => 'blob:test-url'), revokeObjectURL: vi.fn() },
  configurable: true,
});

import HierarchyPage from '../page';

// One ACTIVE named position (editable) + one PLACEHOLDER (no linked user → no edit).
const EMPLOYEES = [
  {
    id: 'Pune101', tenantId: 'deoleo', roleCode: 'XSR', roleLabel: 'XSR',
    reportsToId: 'Pune001', hierarchyPath: '/Pune001/Pune101/',
    name: 'Asha Patel', mobile: '9800000009', status: 'ACTIVE',
    hasOutlets: true, hasSubReports: false,
  },
  {
    id: 'Pune102', tenantId: 'deoleo', roleCode: 'XSR', roleLabel: 'XSR',
    reportsToId: 'Pune001', hierarchyPath: '/Pune001/Pune102/',
    name: null, mobile: null, status: 'PLACEHOLDER',
    hasOutlets: false, hasSubReports: false,
  },
];

const MATCHED_USER = {
  id: 'u1', name: 'Asha Patel', email: null, phone: '9800000009',
  role: 'SALES_SO', status: 'ACTIVE',
  salesUser: { id: 's1', employeeCode: 'Pune101', hierarchyLevelId: 'lvl1', reportingToId: null },
};

const OPTIONS = {
  levels: [
    { id: 'lvl1', code: 'XSR', name: 'XSR', level: 1 },
    { id: 'lvl2', code: 'SO', name: 'SO', level: 2 },
  ],
  managers: [
    { id: 's2', name: 'Boss Man', employeeCode: 'Pune001', hierarchyLevelId: 'lvl2' },
  ],
};

function jsonRes(ok: boolean, status: number, body: unknown) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

function installFetch(over?: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const custom = over?.(url, init);
    if (custom !== undefined) return custom as Promise<unknown>;

    if (url.startsWith('/api/admin/hierarchy-config')) {
      return jsonRes(true, 200, { success: true, data: { employees: EMPLOYEES } });
    }
    if (url.startsWith('/api/admin/sales-users/options')) {
      return jsonRes(true, 200, { success: true, data: OPTIONS });
    }
    if (url.startsWith('/api/admin/sales-users/by-code/') && (!init || !init.method || init.method === 'GET')) {
      return jsonRes(true, 200, { success: true, data: { user: MATCHED_USER } });
    }
    if (/\/api\/admin\/sales-users\/s1$/.test(url) && init?.method === 'PATCH') {
      return jsonRes(true, 200, { success: true, data: { user: { id: 'u1' } } });
    }
    return jsonRes(true, 200, { success: true, data: {} });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Employee Hierarchy — edit affordance', () => {
  beforeEach(() => { localStorage.clear(); });

  it('HE1: edit pencil shows for an ACTIVE named row, and a PLACEHOLDER row offers "Fill vacant position"', async () => {
    installFetch();
    render(<HierarchyPage />);
    // Wait for the list to load from hierarchy-config.
    expect(await screen.findByTestId('hierarchy-edit-Pune101')).toBeInTheDocument();
    // The pencil is labelled for the specific employee.
    expect(await screen.findByRole('button', { name: /edit asha patel/i })).toBeInTheDocument();
    // A vacant position can be opened to be filled with a new person.
    expect(screen.getByRole('button', { name: /fill vacant position pune102/i })).toBeInTheDocument();
  });

  it('HE5: clearing BOTH name and phone asks for confirmation (exact wording), then PATCHes name/phone blank', async () => {
    const { calls } = installFetch();
    render(<HierarchyPage />);
    await userEvent.click(await screen.findByTestId('hierarchy-edit-Pune101'));
    const scope = within(await screen.findByRole('dialog'));
    await waitFor(() => expect((scope.getByLabelText('Full name') as HTMLInputElement).value).toBe('Asha Patel'));

    // The hint tells the admin how to mark the position vacant.
    expect(scope.getByText('Leave name and phone blank to mark the position vacant (e.g. the employee left)')).toBeInTheDocument();

    await userEvent.clear(scope.getByLabelText('Full name'));
    await userEvent.clear(scope.getByLabelText('Phone (10 digits)'));
    await userEvent.click(scope.getByRole('button', { name: /^save changes$/i }));

    // Confirmation first — nothing sent yet.
    const confirm = await scope.findByTestId('confirm-vacate');
    expect(confirm).toHaveTextContent(
      'Mark XSR Pune101 as vacant? Asha Patel will be signed out and can no longer log in, and their phone number will be freed. The position keeps its place in the hierarchy.',
    );
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false);

    await userEvent.click(scope.getByRole('button', { name: /yes, mark vacant/i }));
    await waitFor(() => {
      const patch = calls.find((c) => /\/api\/admin\/sales-users\/s1$/.test(c.url) && c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch!.init!.body))).toEqual({ name: '', phone: '' });
    });
  });

  it('HE5b: "Back" on the confirmation sends nothing and returns to the form', async () => {
    const { calls } = installFetch();
    render(<HierarchyPage />);
    await userEvent.click(await screen.findByTestId('hierarchy-edit-Pune101'));
    const scope = within(await screen.findByRole('dialog'));
    await waitFor(() => expect((scope.getByLabelText('Full name') as HTMLInputElement).value).toBe('Asha Patel'));
    await userEvent.clear(scope.getByLabelText('Full name'));
    await userEvent.clear(scope.getByLabelText('Phone (10 digits)'));
    await userEvent.click(scope.getByRole('button', { name: /^save changes$/i }));
    await scope.findByTestId('confirm-vacate');
    await userEvent.click(scope.getByRole('button', { name: /^back$/i }));
    expect(scope.queryByTestId('confirm-vacate')).not.toBeInTheDocument();
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false);
  });

  it('HE6: clearing only ONE of name / phone shows the plain-words error and blocks Save', async () => {
    installFetch();
    render(<HierarchyPage />);
    await userEvent.click(await screen.findByTestId('hierarchy-edit-Pune101'));
    const scope = within(await screen.findByRole('dialog'));
    await waitFor(() => expect((scope.getByLabelText('Full name') as HTMLInputElement).value).toBe('Asha Patel'));

    await userEvent.clear(scope.getByLabelText('Phone (10 digits)'));
    expect(scope.getByRole('alert')).toHaveTextContent(
      'To mark this position vacant, clear both the name and the phone. Otherwise enter a 10-digit phone.',
    );
    expect(scope.getByRole('button', { name: /^save changes$/i })).toBeDisabled();
  });

  it('HE7: a vacant position opens blank and is filled by entering a new name + phone', async () => {
    const VACANT_USER = {
      id: 'u2', name: '(vacant) Pune102', email: null, phone: '__vacant__:Pune102',
      role: 'SALES_SO', status: 'INACTIVE',
      salesUser: { id: 's1', employeeCode: 'Pune102', hierarchyLevelId: 'lvl1', reportingToId: null },
    };
    const { calls } = installFetch((url, init) => {
      if (url.startsWith('/api/admin/sales-users/by-code/') && (!init || !init.method || init.method === 'GET')) {
        return jsonRes(true, 200, { success: true, data: { user: VACANT_USER } });
      }
      return undefined;
    });
    render(<HierarchyPage />);
    await userEvent.click(await screen.findByRole('button', { name: /fill vacant position pune102/i }));
    const scope = within(await screen.findByRole('dialog'));
    expect(scope.getByText(/this position is vacant/i)).toBeInTheDocument();
    // Synthetic placeholder values are never shown.
    expect((scope.getByLabelText('Full name') as HTMLInputElement).value).toBe('');
    expect((scope.getByLabelText('Phone (10 digits)') as HTMLInputElement).value).toBe('');

    await userEvent.type(scope.getByLabelText('Full name'), 'New Person');
    await userEvent.type(scope.getByLabelText('Phone (10 digits)'), '9833333333');
    await userEvent.click(scope.getByRole('button', { name: /^save changes$/i }));
    await waitFor(() => {
      const patch = calls.find((c) => /\/api\/admin\/sales-users\/s1$/.test(c.url) && c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch!.init!.body))).toEqual({ name: 'New Person', phone: '9833333333' });
    });
  });

  it('HE2/HE3: clicking edit fetches user + options, opens the modal, and saving PATCHes the employee endpoint', async () => {
    const { calls } = installFetch();
    render(<HierarchyPage />);
    await screen.findByTestId('hierarchy-edit-Pune101');

    await userEvent.click(await screen.findByTestId('hierarchy-edit-Pune101'));

    // Modal opens with the fetched user pre-filled.
    const dialog = await screen.findByRole('dialog');
    const scope = within(dialog);
    expect(scope.getByText('Edit User')).toBeInTheDocument();
    await waitFor(() =>
      expect((scope.getByPlaceholderText('e.g. Priya Sharma') as HTMLInputElement).value).toBe('Asha Patel'),
    );
    // Employee editor renders Level + Reports-to (not the raw role select) and the options loaded.
    expect(scope.getByLabelText('Level')).toBeInTheDocument();
    expect(scope.getByLabelText('Reports to')).toBeInTheDocument();

    // The user was fetched by the dedicated by-code endpoint and the options were fetched.
    expect(calls.some((c) => c.url.includes('/api/admin/sales-users/by-code/Pune101'))).toBe(true);
    expect(calls.some((c) => c.url.startsWith('/api/admin/sales-users/options'))).toBe(true);

    // Change the name and save → PATCH the dedicated employee endpoint.
    await userEvent.clear(scope.getByPlaceholderText('e.g. Priya Sharma'));
    await userEvent.type(scope.getByPlaceholderText('e.g. Priya Sharma'), 'Asha P');
    await userEvent.click(scope.getByRole('button', { name: /^save changes$/i }));

    await waitFor(() => {
      const patch = calls.find((c) => /\/api\/admin\/sales-users\/s1$/.test(c.url) && c.init?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch!.init!.body));
      expect(body.name).toBe('Asha P');
    });

    // Modal closes and the hierarchy list is re-fetched (>1 GET to hierarchy-config).
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const gets = calls.filter((c) => c.url.startsWith('/api/admin/hierarchy-config'));
      expect(gets.length).toBeGreaterThan(1);
    });
  });

  it('HE4: when the employee can\'t be loaded (404), an honest error is shown and no modal opens', async () => {
    // by-code returns 404 (e.g. the employee was since deactivated) → honest toast, no modal.
    installFetch((url, init) => {
      if (url.startsWith('/api/admin/sales-users/by-code/') && (!init || !init.method || init.method === 'GET')) {
        return jsonRes(false, 404, { success: false, error: 'Employee not found.' });
      }
      return undefined;
    });
    render(<HierarchyPage />);
    await screen.findByTestId('hierarchy-edit-Pune101');

    await userEvent.click(await screen.findByTestId('hierarchy-edit-Pune101'));

    expect(await screen.findByText(/couldn't load this employee to edit/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
