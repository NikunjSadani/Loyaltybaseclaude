/// <reference types="vitest/globals" />
/**
 * PDB — Partner Dashboard page real-data wiring
 *
 * PDB1: dashboard renders after loading resolves (smoke test)
 * PDB2: fetch IS called to /api/partner/targets for real KPI data
 * PDB3: graceful fallback — dashboard shown when fetch fails (honest empty state)
 * PDB4: hero shows the REAL aggregated primary-KPI target (summed across outlets)
 *       and the REAL wallet points — NOT the old demo numbers (800 / 4250).
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({
    href, children, ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
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

/** Builds a fetch stub routing /api/partner/targets and /api/auth/me. */
function stubFetch({
  targets,
  me,
  targetsReject = false,
}: {
  targets?: unknown;
  me?: unknown;
  targetsReject?: boolean;
}) {
  return vi.fn((url: string) => {
    if (url.includes('/api/partner/targets')) {
      if (targetsReject) return Promise.reject(new Error('Network error'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(targets) });
    }
    if (url.includes('/api/auth/me')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(me) });
    }
    // banners etc.
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ banners: [], popups: [] }) });
  });
}

const EMPTY_TARGETS = { success: true, data: { period: '2026-06', outlets: [] } };
const EMPTY_ME      = { success: true, data: { user: { channelPartner: { wallets: [] } } } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PDB — Partner Dashboard real-data wiring', () => {

  it('PDB1: dashboard renders after loading resolves', async () => {
    vi.stubGlobal('fetch', stubFetch({ targets: EMPTY_TARGETS, me: EMPTY_ME }));

    render(<PartnerDashboardPage />);
    await waitFor(() => expect(screen.getByText('My Targets')).toBeInTheDocument());
  });

  it('PDB2: fetch IS called to /api/partner/targets for real KPI data', async () => {
    const mockFetch = stubFetch({ targets: EMPTY_TARGETS, me: EMPTY_ME });
    vi.stubGlobal('fetch', mockFetch);

    render(<PartnerDashboardPage />);
    await waitFor(() => expect(screen.getByText('My Targets')).toBeInTheDocument());

    const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((url: string) => url.includes('/api/partner/targets'))).toBe(true);
  });

  it('PDB3: graceful fallback — dashboard renders when fetch fails', async () => {
    vi.stubGlobal('fetch', stubFetch({ targetsReject: true, me: EMPTY_ME }));

    render(<PartnerDashboardPage />);
    await waitFor(() => expect(screen.getByText('My Targets')).toBeInTheDocument());
  });

  it('PDB4: hero shows REAL aggregated primary-KPI target + REAL wallet points', async () => {
    // Two WHOLESALER outlets, each with a primary KPI target 400 / achieved 200
    // → aggregated target 800, achieved 400 (50%). Wallet redeemablePoints = 1234.
    const targets = {
      success: true,
      data: {
        period: '2026-06',
        outlets: [
          {
            outletCode: 'WS-1', outletName: 'Outlet 1', outletType: 'WHOLESALER',
            kpis: [{ code: 'SV', name: 'Secondary Volume', target: 400, achieved: 200, pace: null, unit: 'cases', isPrimary: true }],
          },
          {
            outletCode: 'WS-2', outletName: 'Outlet 2', outletType: 'WHOLESALER',
            kpis: [{ code: 'SV', name: 'Secondary Volume', target: 400, achieved: 200, pace: null, unit: 'cases', isPrimary: true }],
          },
        ],
      },
    };
    const me = {
      success: true,
      data: { user: { channelPartner: { wallets: [{ redeemablePoints: 1234 }] } } },
    };
    vi.stubGlobal('fetch', stubFetch({ targets, me }));

    render(<PartnerDashboardPage />);

    // Summed target (800) appears, summed achieved + percentage shown.
    await waitFor(() => expect(screen.getByText(/of 800 cases/)).toBeInTheDocument());
    expect(screen.getByText('50%')).toBeInTheDocument();

    // REAL wallet points (1,234) — NOT the old demo 4,250.
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.queryByText('4,250')).not.toBeInTheDocument();
  });
});
