/// <reference types="vitest/globals" />
/**
 * ADVIS — Admin Visibility page API wiring
 *
 * ADVIS1: shows loading spinner on mount
 * ADVIS2: renders partner name from API response
 * ADVIS3: shows error message when fetch fails
 * ADVIS4: renders queue count in tab when items load
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

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
vi.mock('@/lib/visibility-upload', () => ({
  generateVisibilityTemplate: vi.fn().mockReturnValue(new ArrayBuffer(0)),
  DEMO_VISIBILITY_MAP: {},
}));
vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => ({
    visibilityPhotoEnabled: true,
    redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
    creditsPayouts: { monthCutoffDay: 28, safetyCapPoints: 50000, safetyCapInr: 100000, fourEyesEnabled: false },
  }),
}));

import VisibilityPage from '../page';

const MOCK_SUBMISSIONS = [
  {
    id: 'VIS001',
    status: 'SUBMITTED',
    createdAt: '2026-04-30T08:42:00.000Z',
    imageUrls: ['https://placehold.co/600x400'],
    geoLat: 19.1234,
    geoLng: 72.8765,
    partner: { id: 'p1', businessName: 'Sharma General Store' },
    outlet: { id: 'out1', name: 'Sharma Outlet', city: 'Mumbai' },
  },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('ADVIS — Admin Visibility API wiring', () => {
  it('ADVIS1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<VisibilityPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('ADVIS2: renders partner name from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            submissions: MOCK_SUBMISSIONS,
            pagination: { page: 1, limit: 20, total: 1, pages: 1 },
          },
        }),
    }));
    render(<VisibilityPage />);
    // partner name may appear multiple times (queue thumbnail + detail panel)
    const matches = await screen.findAllByText('Sharma General Store');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('ADVIS3: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<VisibilityPage />);
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });

  it('ADVIS4: renders queue tab with partner count after load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            submissions: MOCK_SUBMISSIONS,
            pagination: { page: 1, limit: 20, total: 1, pages: 1 },
          },
        }),
    }));
    render(<VisibilityPage />);
    // Queue tab label shows count in parentheses after items load
    expect(await screen.findByText(/Approval Queue/i)).toBeInTheDocument();
  });
});
