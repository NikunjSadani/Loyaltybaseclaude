/**
 * TDD — Activations (schemes) entry card on the partner dashboard.
 *
 * The old single-scheme acceptance banner + bottom-sheet is retired (D27). The
 * dashboard now shows a lightweight "Activations" card that links to the full
 * /partner/schemes list whenever the outlet has ≥1 eligible activation it has NOT
 * yet enrolled in. The card keeps the "New Activation" label (not "New Scheme").
 *
 * AA1: the card shows "New Activation" (not "New Scheme")
 * AA2: the card links to /partner/schemes
 * AA3: the card is hidden when there are no un-enrolled activations
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

/* The dashboard card reads the REAL backend via schemeApi (listEligible +
 * getMyEnrollment, through portal-api). Mock the canonical client. */
vi.mock('@/lib/schemes', () => ({
  schemeApi: {
    listEligible: vi.fn(),
    getMyEnrollment: vi.fn(),
  },
}));
import { schemeApi } from '@/lib/schemes';

const activeScheme = {
  id: 'scm-test-01',
  clientId: 'c1',
  code: 'C1',
  name: 'Summer Push',
  description: 'Push summer targets',
  status: 'ACTIVE',
  startDate: '2026-07-01T00:00:00.000Z',
  endDate: '2026-09-30T23:59:59.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

import PartnerDashboardPage from '../page';

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/partner/targets')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { period: '2026-06', outlets: [{ outletCode: 'O1', outletName: 'O1', outletType: 'SSS', kpis: [] }] } }) });
    }
    if (url.includes('/api/auth/me') || url.includes('/api/partner/me')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { user: { channelPartner: { wallets: [] } } } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ banners: [], popups: [] }) });
  }));
}

describe('AA — Activations dashboard card', () => {
  beforeEach(() => {
    stubFetch();
    vi.mocked(schemeApi.listEligible).mockResolvedValue({ success: true, data: { schemes: [activeScheme] } } as never);
    // Not enrolled → the scheme counts as "available".
    vi.mocked(schemeApi.getMyEnrollment).mockResolvedValue({ success: false, error: 'not found' } as never);
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('AA1: card shows "New Activation" not "New Scheme"', async () => {
    render(<PartnerDashboardPage />);
    await waitFor(() => expect(screen.getByText('New Activation')).toBeInTheDocument());
    expect(screen.queryByText('New Scheme')).not.toBeInTheDocument();
  });

  it('AA2: card links to /partner/schemes', async () => {
    render(<PartnerDashboardPage />);
    await waitFor(() => expect(screen.getByText('New Activation')).toBeInTheDocument());
    const link = screen.getByText('New Activation').closest('a');
    expect(link).toHaveAttribute('href', '/partner/schemes');
  });

  it('AA3: card hidden when the only eligible scheme is already enrolled', async () => {
    vi.mocked(schemeApi.getMyEnrollment).mockResolvedValue({
      success: true,
      data: { schemeOutlet: { id: 'ro1', outletName: 'O1' }, enrollment: { id: 'e1', status: 'SUBMITTED' } },
    } as never);
    render(<PartnerDashboardPage />);
    // Let the async card resolve, then assert it stayed hidden.
    await waitFor(() => expect(schemeApi.getMyEnrollment).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('New Activation')).not.toBeInTheDocument());
  });
});
