/// <reference types="vitest/globals" />
/**
 * GU — Gifsy Users page API wiring
 *
 * GU1: shows loading spinner on mount
 * GU2: renders user name from API response
 * GU3: renders role badge from API response
 * GU4: shows error message when fetch fails
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import GifsyUsersPage from '../page';

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

const MOCK_API_USERS = [
  {
    id: 'u1',
    name: 'Rahul Agarwal',
    email: 'rahul@deoleo.in',
    phone: '9900000001',
    role: 'CLIENT_ADMIN',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    salesUser: null,
  },
  {
    id: 'u2',
    name: 'Platform Ops',
    email: 'ops@gifsy.in',
    phone: '9900000002',
    role: 'GIFSY_ADMIN',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    salesUser: null,
  },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('GU — Gifsy Users API wiring', () => {
  it('GU1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<GifsyUsersPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('GU2: renders user name from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { users: MOCK_API_USERS, pagination: { page: 1, limit: 20, total: 2, pages: 1 } },
        }),
    }));
    render(<GifsyUsersPage />);
    expect(await screen.findByText('Rahul Agarwal')).toBeInTheDocument();
  });

  it('GU3: renders role badge from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { users: MOCK_API_USERS, pagination: { page: 1, limit: 20, total: 2, pages: 1 } },
        }),
    }));
    render(<GifsyUsersPage />);
    expect(await screen.findByText('Gifsy Admin')).toBeInTheDocument();
  });

  it('GU4: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<GifsyUsersPage />);
    expect(await screen.findByText(/failed to load users/i)).toBeInTheDocument();
  });
});
