/// <reference types="vitest/globals" />
/**
 * WLF — WholesalerLower feature-flag gating (dashboard page)
 *
 * WLF1: renders a navigable link to /partner/leaderboard when showLeaderboard=true
 * WLF2: does NOT render a link to /partner/leaderboard when showLeaderboard=false
 *
 * Default session (usePartnerSession) returns WHOLESALER outlet so WholesalerLower renders.
 * Default client config (DEOLEO_CONFIG) has showLeaderboard=false.
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Shared mocks (same as chart-header.test.tsx) ─────────────────────────────

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

// Closure-captured flag: tests set it before rendering
let mockShowLeaderboard = false;

vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: () => ({
    features: {
      walletModule: true,
      partnerApp: {
        showSchemes: true, showInvoices: true, showWallet: true,
        showTeam: true, showLeaderboard: mockShowLeaderboard,
      },
    },
    branding: { displayName: 'Test', primaryColor: '#16a34a' },
  }),
  ClientConfigProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useFeatureFlag: () => true,
}));

import PartnerDashboardPage from '../page';

describe('WLF — WholesalerLower flag gate (partner dashboard)', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('WLF1: renders a link to /partner/leaderboard when showLeaderboard=true', async () => {
    mockShowLeaderboard = true;
    render(<PartnerDashboardPage />);
    await act(async () => { vi.advanceTimersByTime(500); });

    const links = screen.queryAllByRole('link');
    const leaderboardLink = links.find(l => l.getAttribute('href') === '/partner/leaderboard');
    expect(leaderboardLink).toBeTruthy();
  });

  it('WLF2: does NOT render a link to /partner/leaderboard when showLeaderboard=false', async () => {
    mockShowLeaderboard = false;
    render(<PartnerDashboardPage />);
    await act(async () => { vi.advanceTimersByTime(500); });

    const links = screen.queryAllByRole('link');
    const leaderboardLink = links.find(l => l.getAttribute('href') === '/partner/leaderboard');
    expect(leaderboardLink).toBeUndefined();
  });
});
