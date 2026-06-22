/**
 * TDD — Performance chart header copy (outlet / partner dashboard)
 *
 * Z1: heading reads "Target vs. Achievement" (not "Sales vs Target")
 * Z2: the sub-line "Target vs Achieved" is NOT present
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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

import PartnerDashboardPage from '../page';

describe('Z — Partner dashboard chart header', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/api/partner/targets')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { period: '2026-06', outlets: [] } }) });
      }
      if (url.includes('/api/auth/me')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { user: { channelPartner: { wallets: [] } } } }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ banners: [], popups: [] }) });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Z1: heading reads "Target vs. Achievement"', async () => {
    render(<PartnerDashboardPage />);
    await waitFor(() =>
      expect(screen.getByText('Target vs. Achievement')).toBeInTheDocument()
    );
  });

  it('Z2: sub-line "Target vs Achieved" is not shown', async () => {
    render(<PartnerDashboardPage />);
    await waitFor(() =>
      expect(screen.getByText('Target vs. Achievement')).toBeInTheDocument()
    );
    expect(screen.queryByText(/target vs achieved/i)).not.toBeInTheDocument();
  });
});
