/**
 * TDD — Scheme card label on partner dashboard
 *
 * The banner card and the scheme detail sheet both showed "New Scheme".
 * The correct label for the partner-facing UI is "New Activation".
 *
 * AA1: the scheme card banner shows "New Activation" (not "New Scheme")
 * AA2: the scheme detail sheet header shows "New Activation" (not "New Scheme")
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/components/charts/achievement-chart', () => ({
  AchievementChart: () => <div data-testid="achievement-chart" />,
}));
vi.mock('@/lib/banner', () => ({
  fetchBanners:              () => Promise.resolve({ banners: [], popups: [] }),
  saveBanners:               () => undefined,
  savePopups:                () => undefined,
  loadBanners:               () => [],
  getActiveBanners:          () => [],
  getActiveBannersFromList:  () => [],
  getActivePopup:            () => null,
  shouldShowPopup:           () => false,
  markPopupSeen:             () => undefined,
  getBgStyle:                () => ({}),
  toEmbedUrl:                (u: string) => u,
}));

/* Inject a pending scheme into localStorage before the component reads it */
const SCHEME_KEY = 'loyaltybase_admin_schemes_v1';
const MOCK_SCHEME = {
  id: 'scm-test-01',
  name: 'Summer Push',
  description: 'Push summer targets',
  period: 'Jul 26 – Sept 26',
  startDate: '2026-07-01T00:00:00',
  endDate:   '2026-09-30T23:59:59',
  acceptDeadline: '2027-09-23T23:59:59',
  kpis: [{ label: 'Volume', unit: 'cases', target: 500 }],
  requiresSelfRegistration: true,
  publishedAt: new Date().toISOString(),
  status: 'PUBLISHED',
  enrolledOutlets: [],
};

import PartnerDashboardPage from '../page';

describe('AA — Scheme card label', () => {
  beforeEach(() => {
    localStorage.setItem(SCHEME_KEY, JSON.stringify([MOCK_SCHEME]));
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('AA1: scheme banner card shows "New Activation" not "New Scheme"', async () => {
    render(<PartnerDashboardPage />);
    await act(async () => { vi.advanceTimersByTime(500); });

    await waitFor(() =>
      expect(screen.getByText('New Activation')).toBeInTheDocument()
    );
    expect(screen.queryByText('New Scheme')).not.toBeInTheDocument();
  });

  it('AA2: scheme detail sheet shows "New Activation" not "New Scheme"', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    render(<PartnerDashboardPage />);
    await act(async () => { vi.advanceTimersByTime(500); });

    // Open the scheme sheet by clicking the card
    await waitFor(() => expect(screen.getByText('New Activation')).toBeInTheDocument());
    await user.click(screen.getByText('New Activation'));

    await waitFor(() => {
      // Sheet header also says New Activation
      const matches = screen.getAllByText(/new activation/i);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText('New Scheme')).not.toBeInTheDocument();
  });
});
