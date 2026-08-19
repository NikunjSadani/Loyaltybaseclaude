/// <reference types="vitest/globals" />
/**
 * GS — Gifsy Staff panel (RBAC Option-X P3)
 *
 * GS1: renders the staff list incl. the role-name column and a status badge
 * GS2: shows the loading spinner on mount
 * GS3: Add-staff flow posts { name, phone, gifsyRoleId } to /api/gifsy/staff
 * GS4: client-side phone validation blocks a non-10-digit submit
 * GS5: Deactivate PATCHes { status: 'INACTIVE' } after the confirm
 * GS6: a backend error (phone-in-use 400) surfaces the message verbatim
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeAll, afterEach } from 'vitest';
import GifsyStaffPage from '../page';

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

// Radix Dialog (the shared Modal) touches a few browser APIs jsdom lacks.
beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  if (!globalThis.matchMedia) {
    globalThis.matchMedia = () => ({
      matches: false, media: '', onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    });
  }
  Element.prototype.hasPointerCapture ??= function () { return false; };
  Element.prototype.setPointerCapture ??= function () {};
  Element.prototype.releasePointerCapture ??= function () {};
});

const MOCK_ROLES = [
  { id: 'role-ops', name: 'Ops' },
  { id: 'role-pm',  name: 'Project Manager' },
];

const MOCK_STAFF = [
  {
    id: 's1',
    name: 'Asha Menon',
    phone: '9900000001',
    email: 'asha@gifsy.in',
    status: 'ACTIVE',
    gifsyRoleId: 'role-ops',
    gifsyRole: { id: 'role-ops', name: 'Ops' },
  },
  {
    id: 's2',
    name: 'Vikram Rao',
    phone: '9900000002',
    email: null,
    status: 'INACTIVE',
    gifsyRoleId: null,
    gifsyRole: null,
  },
];

const ok = (data: unknown) => ({ ok: true, json: () => Promise.resolve({ success: true, data }) });

/**
 * A fetch stub that branches on URL + method. `staffData` seeds the list load; the
 * `onMutate` hook lets a test tweak how POST/PATCH respond (e.g. return an error).
 */
function stubFetch(opts: {
  staffData?: unknown[];
  rolesData?: unknown[];
  mutate?: (url: string, init?: RequestInit) => unknown | null;
} = {}) {
  const staffData = opts.staffData ?? MOCK_STAFF;
  const rolesData = opts.rolesData ?? MOCK_ROLES;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/gifsy/roles') return Promise.resolve(ok(rolesData));
    if (url === '/api/gifsy/staff' && method === 'GET') return Promise.resolve(ok(staffData));
    // Mutations (POST /staff, PATCH /staff/:id)
    if (opts.mutate) {
      const custom = opts.mutate(url, init);
      if (custom) return Promise.resolve(custom);
    }
    return Promise.resolve(ok({ id: 'new', name: 'x', phone: '0000000000', status: 'ACTIVE', gifsyRole: null }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('GS — Gifsy Staff panel', () => {
  it('GS1: renders staff with the role-name column and a status badge', async () => {
    stubFetch();
    render(<GifsyStaffPage />);
    expect(await screen.findByText('Asha Menon')).toBeInTheDocument();
    // Role-name column
    expect(screen.getByText('Ops')).toBeInTheDocument();
    // The role-less staff renders the "— none —" placeholder
    expect(screen.getByText('— none —')).toBeInTheDocument();
    // Status badges
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('GS2: shows the loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) }));
    render(<GifsyStaffPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('GS3: Add-staff flow posts { name, phone, gifsyRoleId }', async () => {
    const fetchMock = stubFetch({ staffData: [] });
    render(<GifsyStaffPage />);
    // Wait for the initial load (empty state) so the roles select is populated.
    await screen.findByText('No staff yet — add one.');

    fireEvent.click(screen.getByRole('button', { name: /add staff/i }));

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Neha Gupta' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '9812345678' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'role-pm' } });

    const submits = screen.getAllByRole('button', { name: /add staff/i });
    fireEvent.click(submits[submits.length - 1]);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/gifsy/staff' && init?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body).toMatchObject({ name: 'Neha Gupta', phone: '9812345678', gifsyRoleId: 'role-pm' });
    });
  });

  it('GS4: client-side phone validation blocks a non-10-digit submit', async () => {
    const fetchMock = stubFetch({ staffData: [] });
    render(<GifsyStaffPage />);
    await screen.findByText('No staff yet — add one.');

    fireEvent.click(screen.getByRole('button', { name: /add staff/i }));
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Neha Gupta' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '123' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'role-pm' } });

    const submits = screen.getAllByRole('button', { name: /add staff/i });
    fireEvent.click(submits[submits.length - 1]);

    // The validation message shows…
    expect((await screen.findAllByText(/valid 10-digit phone number/i)).length).toBeGreaterThan(0);
    // …and NO POST was ever fired (only the two initial GET loads).
    const post = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/gifsy/staff' && init?.method === 'POST',
    );
    expect(post).toBeFalsy();
  });

  it('GS5: Deactivate PATCHes { status: INACTIVE } after the confirm', async () => {
    const fetchMock = stubFetch();
    render(<GifsyStaffPage />);
    await screen.findByText('Asha Menon');

    // Row action opens the confirm modal.
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    // Modal + row both now expose a "Deactivate" button — the confirm is the last.
    const buttons = screen.getAllByRole('button', { name: 'Deactivate' });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/gifsy/staff/s1' && init?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse((patch![1] as RequestInit).body as string);
      expect(body).toEqual({ status: 'INACTIVE' });
    });
  });

  it('GS6: a backend error surfaces the message verbatim', async () => {
    stubFetch({
      staffData: [],
      mutate: (url, init) => {
        if (url === '/api/gifsy/staff' && init?.method === 'POST') {
          return { ok: false, json: () => Promise.resolve({ success: false, error: 'Phone already in use.' }) };
        }
        return null;
      },
    });
    render(<GifsyStaffPage />);
    await screen.findByText('No staff yet — add one.');

    fireEvent.click(screen.getByRole('button', { name: /add staff/i }));
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Neha Gupta' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '9812345678' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'role-pm' } });

    const submits = screen.getAllByRole('button', { name: /add staff/i });
    fireEvent.click(submits[submits.length - 1]);

    expect(await screen.findByText('Phone already in use.')).toBeInTheDocument();
  });
});
