/// <reference types="vitest/globals" />
/**
 * SP — Sales Profile page API wiring
 *
 * SP1: shows loading spinner on mount
 * SP2: renders user name from API response
 * SP3: renders employee code from API response
 * SP4: shows error message when fetch fails
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import SalesProfilePage from '../page';

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

const MOCK_USER = {
  id: 'u1',
  name: 'Rajesh Kumar',
  phone: '9876543210',
  email: 'rajesh@deoleo.com',
  role: 'SALES_SO',
  salesUser: {
    employeeCode: 'EMP-2023-0028',
    joinedAt: '2023-06-10T00:00:00.000Z',
    region: 'Mumbai West',
  },
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('SP — Sales Profile API wiring', () => {
  it('SP1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}), // never resolves — keeps spinner up
    }));
    render(<SalesProfilePage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('SP2: renders user name from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { user: MOCK_USER } }),
    }));
    render(<SalesProfilePage />);
    expect(await screen.findByText('Rajesh Kumar')).toBeInTheDocument();
  });

  it('SP3: renders employee code from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { user: MOCK_USER } }),
    }));
    render(<SalesProfilePage />);
    expect(await screen.findByText('EMP-2023-0028')).toBeInTheDocument();
  });

  it('SP4: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<SalesProfilePage />);
    expect(await screen.findByText(/failed to load profile/i)).toBeInTheDocument();
  });
});
