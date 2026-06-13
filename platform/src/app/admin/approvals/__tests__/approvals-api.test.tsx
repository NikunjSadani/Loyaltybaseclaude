/// <reference types="vitest/globals" />
/**
 * AP — Admin Approvals page API wiring
 *
 * AP1: shows loading spinner on mount
 * AP2: renders firm name from API response
 * AP3: shows error message when fetch fails
 * AP4: shows "All clear" when API returns empty queue
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AdminApprovalsPage from '../page';

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
    id: 'k5',
    status: 'PENDING_GIFSY',
    submittedAt: '2026-05-14T00:00:00.000Z',
    user: { id: 'u1', name: 'Rajesh Kumar', phone: '9432109876' },
    partner: { id: 'p1', businessName: 'Mehta Provisions' },
    documents: [
      { id: 'd1', documentType: 'GST Certificate', status: 'SUBMITTED' },
      { id: 'd2', documentType: 'PAN Card',        status: 'SUBMITTED' },
    ],
  },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('AP — Admin Approvals API wiring', () => {
  it('AP1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<AdminApprovalsPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('AP2: renders firm name from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            submissions: MOCK_SUBMISSIONS,
            pagination: { page: 1, limit: 20, total: 1, pages: 1 },
            statusCounts: {},
          },
        }),
    }));
    render(<AdminApprovalsPage />);
    expect(await screen.findByText('Mehta Provisions')).toBeInTheDocument();
  });

  it('AP3: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<AdminApprovalsPage />);
    expect(await screen.findByText(/failed to load approvals/i)).toBeInTheDocument();
  });

  it('AP4: shows "All clear" when API returns empty queue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { submissions: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 }, statusCounts: {} },
        }),
    }));
    render(<AdminApprovalsPage />);
    expect(await screen.findByText(/all clear/i)).toBeInTheDocument();
  });
});
