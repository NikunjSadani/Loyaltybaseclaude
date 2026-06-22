/// <reference types="vitest/globals" />
/**
 * WLF — Wholesaler leaderboard card removed from the partner dashboard
 *
 * The old WholesalerLower "rank #12 of 248" card had no real data source
 * (fabricated leaderboard numbers) and was removed. The leaderboard feature
 * is separately flag-gated on its own page — it must NOT appear on the
 * dashboard hero area regardless of the client feature flag.
 *
 * WLF1: dashboard renders WITHOUT a /partner/leaderboard link (real WHOLESALER data).
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} data-href={href} {...props}>{children}</a>,
}));

vi.mock('@/components/charts/achievement-chart', () => ({
  AchievementChart: () => <div data-testid="achievement-chart" />,
}));

vi.mock('@/lib/banner', () => ({
  fetchBanners:             () => Promise.resolve({ banners: [], popups: [] }),
  saveBanners:              () => undefined,
  savePopups:               () => undefined,
  loadBanners:              () => [],
  getActiveBanners:         () => [],
  getActiveBannersFromList: () => [],
  getActivePopup:           () => null,
  shouldShowPopup:          () => false,
  markPopupSeen:            () => undefined,
  getBgStyle:               () => ({}),
  toEmbedUrl:               (u: string) => u,
}));

import PartnerDashboardPage from '../page';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WLF — leaderboard card removed from partner dashboard', () => {
  it('WLF1: dashboard renders without a /partner/leaderboard link', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/partner/targets')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: {
              period: '2026-06',
              outlets: [{
                outletCode: 'WS-1', outletName: 'Outlet 1', outletType: 'WHOLESALER',
                kpis: [{ code: 'SV', name: 'Secondary Volume', target: 800, achieved: 400, pace: null, unit: 'cases', isPrimary: true }],
              }],
            },
          }),
        });
      }
      if (url.includes('/api/auth/me')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { user: { channelPartner: { wallets: [{ redeemablePoints: 100 }] } } } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ banners: [], popups: [] }) });
    }));

    render(<PartnerDashboardPage />);
    await waitFor(() => expect(screen.getByText('My Targets')).toBeInTheDocument());

    const links = screen.queryAllByRole('link');
    const leaderboardLink = links.find(l => l.getAttribute('href') === '/partner/leaderboard');
    expect(leaderboardLink).toBeUndefined();
  });
});
