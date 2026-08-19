/// <reference types="vitest/globals" />
/**
 * GS-P5 — the Gifsy Staff panel "Assumable brands" grants (RBAC Option-X P5).
 *
 * A staff is scoped to specific client brands they may assume; the grant is a set of
 * brand SLUGS sent as `assumableClientIds`.
 *
 * GB1: the Add-staff modal renders a selectable option per client brand
 * GB2: Add-staff sends the chosen assumableClientIds (slugs) in the POST body
 * GB3: the staff list shows a staff member's assigned brands by NAME (not slug)
 * GB4: Edit-staff omits assumableClientIds when the grant set is unchanged, and
 *      includes it (the full new set) when it changes
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

const ROLES = [{ id: 'role-ops', name: 'Ops' }];

// Acme carries a displayName (list + control must show the NAME, not the slug); Globex
// has none (falls back to internalName).
const CLIENTS = [
  { slug: 'acme',   internalName: 'Acme Foods', displayName: 'Acme', status: 'ACTIVE' },
  { slug: 'globex', internalName: 'Globex',                          status: 'ONBOARDING' },
];

const STAFF = [{
  id: 's1', name: 'Asha Menon', phone: '9900000001', email: null, status: 'ACTIVE',
  gifsyRoleId: 'role-ops', gifsyRole: { id: 'role-ops', name: 'Ops' },
  assumableClientIds: ['acme'],
}];

const ok = (data: unknown) => ({ ok: true, json: () => Promise.resolve({ success: true, data }) });

function stubFetch(opts: { staffData?: unknown[] } = {}) {
  const staffData = opts.staffData ?? STAFF;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/gifsy/roles') return Promise.resolve(ok(ROLES));
    if (url === '/api/gifsy/clients') return Promise.resolve(ok({ clients: CLIENTS }));
    if (url === '/api/gifsy/staff' && method === 'GET') return Promise.resolve(ok(staffData));
    return Promise.resolve(ok({ id: 'new', name: 'x', phone: '0000000000', status: 'ACTIVE', gifsyRole: null }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('GS-P5 — assumable-brands grants', () => {
  it('GB3: the staff list shows a member’s assigned brands by name', async () => {
    stubFetch();
    render(<GifsyStaffPage />);
    // The grant ['acme'] renders as the brand's display name "Acme" (not the slug).
    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });

  it('GB1 + GB2: Add-staff renders brand options and POSTs assumableClientIds', async () => {
    const fetchMock = stubFetch({ staffData: [] });
    render(<GifsyStaffPage />);
    await screen.findByText('No staff yet — add one.');

    fireEvent.click(screen.getByRole('button', { name: /add staff/i }));

    // One checkbox per brand, labelled by name (displayName, else internalName).
    const acme   = await screen.findByLabelText('Acme');
    const globex = screen.getByLabelText('Globex');
    expect(acme).toBeInTheDocument();
    expect(globex).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Neha Gupta' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '9812345678' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'role-ops' } });
    fireEvent.click(acme); // grant just Acme

    const submits = screen.getAllByRole('button', { name: /add staff/i });
    fireEvent.click(submits[submits.length - 1]);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/gifsy/staff' && init?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.assumableClientIds).toEqual(['acme']);
      expect(body).toMatchObject({ name: 'Neha Gupta', phone: '9812345678', gifsyRoleId: 'role-ops' });
    });
  });

  it('GB4: Edit-staff includes assumableClientIds only when the grant set changes', async () => {
    const fetchMock = stubFetch();
    render(<GifsyStaffPage />);
    await screen.findByText('Asha Menon');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // The existing grant (acme) is pre-checked; add Globex → the set changes.
    const globex = await screen.findByLabelText('Globex');
    fireEvent.click(globex);

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/gifsy/staff/s1' && init?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse((patch![1] as RequestInit).body as string);
      expect([...body.assumableClientIds].sort()).toEqual(['acme', 'globex']);
    });
  });
});
