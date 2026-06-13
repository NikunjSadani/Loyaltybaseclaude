/// <reference types="vitest/globals" />
/**
 * KYC — Admin KYC list page API wiring
 *
 * KYC1: shows loading spinner on mount
 * KYC2: renders outlet name from API response
 * KYC3: shows error message when fetch fails
 * KYC4: renders total count in footer
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import KYCPage from '../page';

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

const MOCK_SUBMISSIONS = [
  {
    id: 'KYC001',
    status: 'PENDING_SO_APPROVAL',
    submittedAt: '2026-05-01T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    user: { id: 'u1', name: 'Rohit Verma', phone: '9820184321' },
    partner: { id: 'p1', businessName: 'Sharma General Store' },
    documents: [{ id: 'd1', documentType: 'GST Certificate', status: 'SUBMITTED' }],
  },
  {
    id: 'KYC002',
    status: 'APPROVED',
    submittedAt: '2026-04-28T00:00:00.000Z',
    createdAt: '2026-04-28T00:00:00.000Z',
    user: { id: 'u2', name: 'Sanjay Kumar', phone: '9811034021' },
    partner: { id: 'p2', businessName: 'Ramesh Traders' },
    documents: [],
  },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('KYC — Admin KYC list API wiring', () => {
  it('KYC1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<KYCPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('KYC2: renders outlet name from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            submissions: MOCK_SUBMISSIONS,
            pagination: { page: 1, limit: 20, total: 2, pages: 1 },
            statusCounts: {},
          },
        }),
    }));
    render(<KYCPage />);
    expect(await screen.findByText('Sharma General Store')).toBeInTheDocument();
  });

  it('KYC3: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<KYCPage />);
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });

  it('KYC4: renders total count in footer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            submissions: MOCK_SUBMISSIONS,
            pagination: { page: 1, limit: 20, total: 2, pages: 1 },
            statusCounts: {},
          },
        }),
    }));
    render(<KYCPage />);
    // Footer shows "Showing X of Y KYC submissions"
    expect(await screen.findByText(/showing 2 of 2/i)).toBeInTheDocument();
  });
});
