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

  it('HE1: edit pencil shows for an ACTIVE named row and is ABSENT for a PLACEHOLDER row', async () => {
    installFetch();
    render(<HierarchyPage />);
    // Wait for the list to load from hierarchy-config.
    expect(await screen.findByTestId('hierarchy-edit-Pune101')).toBeInTheDocument();
    expect(screen.queryByTestId('hierarchy-edit-Pune102')).not.toBeInTheDocument();
    // The pencil is labelled for the specific employee.
    expect(screen.getByRole('button', { name: /edit asha patel/i })).toBeInTheDocument();
  });

  it('HE2/HE3: clicking edit fetches user + options, opens the modal, and saving PATCHes the employee endpoint', async () => {
    const { calls } = installFetch();
    render(<HierarchyPage />);
    await screen.findByTestId('hierarchy-edit-Pune101');

    await userEvent.click(screen.getByTestId('hierarchy-edit-Pune101'));

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

    await userEvent.click(screen.getByTestId('hierarchy-edit-Pune101'));

    expect(await screen.findByText(/couldn't load this employee to edit/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
