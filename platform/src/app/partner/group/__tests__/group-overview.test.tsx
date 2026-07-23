/// <reference types="vitest/globals" />
/**
 * GO — Partner Group Overview page (Wave 3, READ-ONLY)
 *
 * The page renders a consolidated, read-only wallet roll-up for a login that is the
 * group PARENT. It fetches GET /api/partner/group/wallet (envelope { success, data })
 * where data is either { available: false } or the full roll-up.
 *
 * GO1: available:true → parent header + consolidated totals render
 * GO2: available:true → ₹ equivalent of redeemable (points ÷ conversionRate) shown
 * GO3: available:true → a per-outlet row renders for each outlet (code, points)
 * GO4: available:true → read-only badge + helper note present; NO redeem/payout control
 * GO5: available:false → friendly empty state (no crash), link back to dashboard
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

// next/link → plain anchor for jsdom.
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import GroupOverviewPage from '../page';

/** Full available:true roll-up. conversionRate 2 → ₹ = points ÷ 2. */
const AVAILABLE_PAYLOAD = {
  available: true,
  parent: { businessName: 'Sunrise Group', ownerName: 'Meera Shah' },
  totals: {
    redeemablePoints: 20_000,
    earnedPoints:     50_000,
    redeemedPoints:   8_000,
    expiredPoints:    500,
    lockedPoints:     1_000,
    lifetimeEarned:   58_500,
    lifetimeRedeemed: 8_000,
  },
  conversionRate: 2,
  outlets: [
    {
      outletCode: 'OUT-001', businessName: 'Sunrise Central', ownerName: 'Meera Shah',
      isActive: true, redeemablePoints: 12_000, earnedPoints: 30_000,
      redeemedPoints: 5_000, expiredPoints: 200, lockedPoints: 600,
    },
    {
      outletCode: 'OUT-002', businessName: 'Sunrise North', ownerName: 'Anil Shah',
      isActive: false, redeemablePoints: 8_000, earnedPoints: 20_000,
      redeemedPoints: 3_000, expiredPoints: 300, lockedPoints: 400,
    },
  ],
};

function stubFetch(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data: payload }),
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('GO — Partner Group Overview (read-only)', () => {
  it('GO1: available:true renders the parent header + consolidated totals', async () => {
    stubFetch(AVAILABLE_PAYLOAD);
    render(<GroupOverviewPage />);

    await waitFor(() =>
      expect(screen.getByText(/Group Overview — Sunrise Group/)).toBeInTheDocument(),
    );
    // Consolidated redeemable total (20,000 pts).
    const card = screen.getByTestId('group-totals-card');
    expect(card).toHaveTextContent('20,000');
    // Lifetime figures rolled up.
    expect(card).toHaveTextContent('58,500');
  });

  it('GO2: shows the ₹ equivalent of redeemable using conversionRate (points ÷ rate)', async () => {
    stubFetch(AVAILABLE_PAYLOAD);
    render(<GroupOverviewPage />);

    // 20,000 pts ÷ rate 2 = ₹10,000.
    await waitFor(() =>
      expect(screen.getByTestId('group-redeemable-inr')).toHaveTextContent('₹10,000'),
    );
  });

  it('GO3: renders a per-outlet row for every outlet with code + points', async () => {
    stubFetch(AVAILABLE_PAYLOAD);
    render(<GroupOverviewPage />);

    await waitFor(() =>
      expect(screen.getAllByTestId('group-outlet-row')).toHaveLength(2),
    );
    expect(screen.getByText('Sunrise Central')).toBeInTheDocument();
    expect(screen.getByText('Sunrise North')).toBeInTheDocument();
    expect(screen.getByText(/OUT-001/)).toBeInTheDocument();
    // Inactive outlet flagged.
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('GO4: read-only badge + helper note present, and NO redeem/payout controls', async () => {
    stubFetch(AVAILABLE_PAYLOAD);
    render(<GroupOverviewPage />);

    await waitFor(() =>
      expect(screen.getByTestId('read-only-badge')).toBeInTheDocument(),
    );
    expect(screen.getByText(/redemption happens per outlet/i)).toBeInTheDocument();
    // Never any action controls on this read-only view.
    expect(screen.queryByRole('button', { name: /redeem/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /payout|withdraw/i })).not.toBeInTheDocument();
  });

  it('GO5: available:false renders the friendly empty state with a dashboard link', async () => {
    stubFetch({ available: false });
    render(<GroupOverviewPage />);

    await waitFor(() =>
      expect(screen.getByTestId('group-empty-state')).toBeInTheDocument(),
    );
    expect(screen.getByText(/No group overview available/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /back to dashboard/i });
    expect(link).toHaveAttribute('href', '/partner/dashboard');
    // No totals card / outlet rows when there's no group.
    expect(screen.queryByTestId('group-totals-card')).not.toBeInTheDocument();
  });
});
