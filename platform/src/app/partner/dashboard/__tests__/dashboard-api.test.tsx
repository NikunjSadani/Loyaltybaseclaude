/// <reference types="vitest/globals" />
/**
 * PDB — Partner Dashboard page API wiring
 *
 * PDB1: dashboard renders after loading resolves (smoke test)
 * PDB2: fetch IS called to /api/partner/targets for real KPI data
 * PDB3: graceful fallback — dashboard shown when fetch fails
 * PDB4: primary KPI value updates when API returns higher achievedValue (> mock)
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

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

vi.mock('@/lib/partner-session', () => ({
  usePartnerSession: () => ({
    outletId: 'o1', outletType: 'WHOLESALER', firmName: 'Kumar General Store',
    partnerName: 'Rajesh Kumar', tier: 'Gold', mobile: '9876543210',
    track: 'POINTS',
    pointsBalance: 4250, pointsLifetime: 8550,
    leaderboardRank: 12, leaderboardTotal: 248,
    inrEarnedThisCycle: 0, pendingPayoutInr: 0,
  }),
  OUTLET_TYPE_LABELS: { SSS: 'SSS', WHOLESALER: 'Wholesaler', SUB_STOCKIST: 'Sub-Stockist', SSS_TOT: 'SSS TOT' },
  OUTLET_TYPE_COLORS: {
    WHOLESALER: { bg: 'bg-amber-100', text: 'text-amber-700' },
    SSS: { bg: 'bg-blue-100', text: 'text-blue-700' },
    SUB_STOCKIST: { bg: 'bg-purple-100', text: 'text-purple-700' },
    SSS_TOT: { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  },
}));

import PartnerDashboardPage from '../page';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PDB — Partner Dashboard API wiring', () => {

  it('PDB1: dashboard renders after loading resolves', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ banners: [], popups: [] }),
    }));

    render(<PartnerDashboardPage />);
    await act(async () => { vi.advanceTimersByTime(500); });

    // Page renders after 400ms loading timeout — should show "My Targets" link
    expect(screen.getByText('My Targets')).toBeInTheDocument();
  });

  it('PDB2: fetch IS called to /api/partner/targets for real KPI data', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { targets: [] } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    render(<PartnerDashboardPage />);
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    const calls = mockFetch.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calls.some((url: string) => url.includes('/api/partner/targets'))).toBe(true);
  });

  it('PDB3: graceful fallback — dashboard renders when fetch fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    render(<PartnerDashboardPage />);
    await act(async () => { vi.advanceTimersByTime(500); });

    // Dashboard should still render with mock data
    expect(screen.getByText('My Targets')).toBeInTheDocument();
  });

  it('PDB4: primary KPI value updates when API returns higher achievedValue', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // DEMO: o1 WHOLESALER, p_sv = 610/800 = 76%
    // API returns achievedValue=800 → 100%
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: {
          targets: [
            {
              id: 'st1', schemeId: 's1', schemeName: 'Volume Scheme',
              period: '2026-05', targetValue: 800, achievedValue: 800,
              percentage: 100, status: 'ACTIVE',
            },
          ],
        },
      }),
    }));

    render(<PartnerDashboardPage />);
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    // After API update, the KPI hero should show 100% (achieved = target)
    await waitFor(() => {
      expect(screen.getByText('100%')).toBeInTheDocument();
    }, { timeout: 2000 });
  });
});
