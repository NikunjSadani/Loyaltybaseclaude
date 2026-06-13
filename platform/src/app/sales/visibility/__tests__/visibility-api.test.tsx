/// <reference types="vitest/globals" />
/**
 * VIS — Sales Visibility page API wiring
 *
 * VIS1: shows loading spinner on mount
 * VIS2: renders outlet name from API response
 * VIS3: renders approval badge from API status
 * VIS4: shows error message when fetch fails
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import SalesVisibilityPage from '../page';

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
    id: 'v1',
    status: 'APPROVED',
    submittedAt: '2026-05-14T00:00:00.000Z',
    imageUrls: ['img1.jpg', 'img2.jpg', 'img3.jpg'],
    pointsAwarded: 100,
    rejectionReason: null,
    outlet: { id: 'o1', name: 'Kumar General Store', city: 'Andheri, Mumbai' },
    partner: { id: 'p1', businessName: 'Test Store' },
  },
  {
    id: 'v2',
    status: 'REJECTED',
    submittedAt: '2026-05-13T00:00:00.000Z',
    imageUrls: ['img4.jpg', 'img5.jpg'],
    pointsAwarded: null,
    rejectionReason: 'Product display not clearly visible',
    outlet: { id: 'o2', name: 'Singh Supermart', city: 'Malad, Mumbai' },
    partner: { id: 'p1', businessName: 'Test Store' },
  },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('VIS — Sales Visibility API wiring', () => {
  it('VIS1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<SalesVisibilityPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('VIS2: renders outlet name from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            submissions: MOCK_SUBMISSIONS,
            pagination: { page: 1, limit: 20, total: 2, pages: 1 },
          },
        }),
    }));
    render(<SalesVisibilityPage />);
    expect(await screen.findByText('Kumar General Store')).toBeInTheDocument();
  });

  it('VIS3: renders approval badge from API status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            submissions: MOCK_SUBMISSIONS,
            pagination: { page: 1, limit: 20, total: 2, pages: 1 },
          },
        }),
    }));
    render(<SalesVisibilityPage />);
    expect(await screen.findByText('Approved')).toBeInTheDocument();
  });

  it('VIS4: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<SalesVisibilityPage />);
    expect(await screen.findByText(/failed to load submissions/i)).toBeInTheDocument();
  });
});
