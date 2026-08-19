/// <reference types="vitest/globals" />
/**
 * GR — Gifsy Role Editor page (RBAC Option-X P3)
 *
 * GR1: renders the roles list from a mocked response (name + permission count + usersCount)
 * GR2: shows the loading spinner on mount
 * GR3: "New role" opens the editor and renders the permission-matrix groups
 * GR4: a reserved permission's checkbox is disabled until the "Allow granting reserved" ack
 * GR5: creating a role POSTs the selected permissions (+ allowReserved when a reserved key is checked)
 * GR6: a delete that returns 409 surfaces the "assigned to N staff" message
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import GifsyRolesPage from '../page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const MOCK_CATALOG = {
  groups: [
    {
      key: 'kyc',
      label: 'KYC',
      capabilityContext: 'kyc',
      permissions: [
        { key: 'kyc:view', reserved: false },
        { key: 'kyc:approve', reserved: false },
      ],
    },
    {
      key: 'finance',
      label: 'Finance',
      capabilityContext: 'finance',
      permissions: [
        { key: 'finance:view', reserved: false },
        { key: 'finance:adjust', reserved: true },
      ],
    },
  ],
  reserved: ['finance:adjust'],
};

const MOCK_ROLES = [
  {
    id: 'r1',
    name: 'Operations Manager',
    description: 'Runs day-to-day ops',
    permissions: ['kyc:view', 'kyc:approve', 'finance:view'],
    isSystem: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    usersCount: 7,
  },
];

function okJson(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
}

/** Default fetch mock: catalog + roles for the two mount fetches. */
function stubDefaultFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/gifsy/permissions')) return okJson(MOCK_CATALOG);
    if (u.includes('/api/gifsy/roles')) return okJson(MOCK_ROLES);
    return okJson({});
  }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('GR — Gifsy Role Editor', () => {
  it('GR1: renders the roles list from the API response', async () => {
    stubDefaultFetch();
    render(<GifsyRolesPage />);
    expect(await screen.findByText('Operations Manager')).toBeInTheDocument();
    expect(screen.getByText('3 permissions')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument(); // usersCount
  });

  it('GR2: shows the loading spinner on mount', () => {
    stubDefaultFetch();
    render(<GifsyRolesPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('GR3: "New role" opens the editor and renders the permission-matrix groups', async () => {
    stubDefaultFetch();
    render(<GifsyRolesPage />);
    // Wait for catalog load (New role button is disabled until then).
    await screen.findByText('Operations Manager');

    fireEvent.click(screen.getByRole('button', { name: /new role/i }));

    expect(await screen.findByText('KYC')).toBeInTheDocument();
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.getByLabelText('kyc:approve')).toBeInTheDocument();
  });

  it('GR4: reserved checkbox is disabled until the ack is toggled on', async () => {
    stubDefaultFetch();
    render(<GifsyRolesPage />);
    await screen.findByText('Operations Manager');
    fireEvent.click(screen.getByRole('button', { name: /new role/i }));

    const reserved = await screen.findByLabelText('finance:adjust');
    expect(reserved).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: /allow granting reserved/i }));
    expect(reserved).not.toBeDisabled();
  });

  it('GR5: creating a role POSTs the selected permissions with allowReserved', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/gifsy/permissions')) return okJson(MOCK_CATALOG);
      if (u.includes('/api/gifsy/roles') && method === 'POST') return okJson({ ...MOCK_ROLES[0], id: 'r2' });
      if (u.includes('/api/gifsy/roles')) return okJson(MOCK_ROLES);
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<GifsyRolesPage />);
    await screen.findByText('Operations Manager');
    fireEvent.click(screen.getByRole('button', { name: /new role/i }));

    await screen.findByLabelText('kyc:view');
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Auditor' } });
    fireEvent.click(screen.getByLabelText('kyc:view'));
    // Enable + check a reserved permission.
    fireEvent.click(screen.getByRole('checkbox', { name: /allow granting reserved/i }));
    fireEvent.click(screen.getByLabelText('finance:adjust'));

    fireEvent.click(screen.getByRole('button', { name: /create role/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/gifsy/roles'),
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.name).toBe('Auditor');
    expect(body.permissions).toEqual(expect.arrayContaining(['kyc:view', 'finance:adjust']));
    expect(body.allowReserved).toBe(true);
  });

  it('GR6: a delete returning 409 surfaces the assigned-staff message', async () => {
    const message = 'This role is assigned to 3 staff member(s). Reassign them before deleting.';
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/api/gifsy/permissions')) return okJson(MOCK_CATALOG);
      if (u.includes('/api/gifsy/roles') && method === 'DELETE') {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ success: false, error: message }) });
      }
      if (u.includes('/api/gifsy/roles')) return okJson(MOCK_ROLES);
      return okJson({});
    }));

    render(<GifsyRolesPage />);
    await screen.findByText('Operations Manager');

    fireEvent.click(screen.getByRole('button', { name: /delete operations manager/i }));

    // Confirm modal is up — click its destructive confirm.
    const confirm = await screen.findByRole('button', { name: /delete role/i });
    fireEvent.click(confirm);

    expect(await screen.findByText(message)).toBeInTheDocument();
  });
});
