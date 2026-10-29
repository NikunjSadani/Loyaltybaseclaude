/// <reference types="vitest/globals" />
/**
 * PDV2 — partnerDashboardV2 (Bajaj trade partner dashboard).
 *
 * Flag ON  → trend chart hidden, "to go" banner shown, this-month-vs-last-month
 *            comparison card present, wholesaler hero shows ENLARGED points (text-4xl).
 * Flag OFF → everything exactly as today (chart shown, no comparison card, no banner,
 *            points stay text-base).
 *
 * The flag is read from the SINGLE /partner/me identity source (usePartnerIdentity →
 * normalized `features.partnerDashboardV2`) — NOT a second hook. The identity hook is
 * mocked here (it does its own fetch in prod), so the page must not fetch /partner/me
 * itself; the no-duplicate-fetch test asserts exactly that.
 *
 * Comparison card unit + title come from the trend response (authoritative even when the
 * partner has history but no current-month target → primary null). Pure month-comparison
 * math is unit-tested at the bottom.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

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

vi.mock('@/app/partner/schemes/portal-api', () => ({
  loadPortalSchemes: () => Promise.resolve([]),
  statusOf:          () => 'NOT_ENROLLED',
}));

// Single identity source — set per-test via the shared ref. features.partnerDashboardV2
// is the ONLY flag source now (no second useTenantFeatures hook).
const identityRef: { current: unknown } = { current: null };
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => identityRef.current,
}));

import PartnerDashboardPage, { computeMonthComparison } from '../page';

/** A resolved identity with the given outletType + v2 flag (features normalized upstream). */
function identity(outletType: string, v2: boolean) {
  return {
    businessName: 'Test Firm', outletName: 'Test Outlet', ownerName: 'Owner',
    partnerCode: 'P-1', outletType, hasPointsActivity: true,
    hasPayoutActivity: false, loyaltyEnabled: true,
    features: { partnerDashboardV2: v2 },
    activePartnerId: null, operableOutlets: [], groupOverviewAvailable: false,
    groupParent: null, activeSelectorInvalid: false, loading: false,
  };
}

type Kpi = { code: string; name: string; target: number; achieved: number; unit: string };
type TrendResp = { kpiName: string | null; unit: string | null; trend: Array<{ month: string; target: number | null; achieved: number | null }> };

/** Fetch stub: targets + wallet + trend. NOTE: it intentionally has NO /partner/me branch —
 *  if the page ever fetches it, that is the duplicate-fetch regression we guard against. */
function stubFetch(opts: { kpi: Kpi | null; walletPts: number; trend: TrendResp }) {
  return vi.fn((url: string) => {
    if (url.includes('/api/partner/targets/trend')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: opts.trend }) });
    }
    if (url.includes('/api/partner/targets')) {
      const outlets = opts.kpi
        ? [{ outletCode: 'WS-1', outletName: 'Outlet 1', outletType: 'WHOLESALER',
             kpis: [{ ...opts.kpi, pace: null, isPrimary: true }] }]
        : [];
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { period: '2026-10', outlets } }) });
    }
    if (url.includes('/api/auth/me')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { user: { channelPartner: { wallets: [{ redeemablePoints: opts.walletPts }] } } } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ banners: [], popups: [] }) });
  });
}

const CASES_TREND: TrendResp = {
  kpiName: 'Secondary Volume', unit: 'cases',
  trend: [
    { month: '2026-09', target: 1000, achieved: 800 },   // last month
    { month: '2026-10', target: 1000, achieved: 1000 },  // this month
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  identityRef.current = null;
});

describe('PDV2 — partnerDashboardV2 ON', () => {
  it('hides the chart, shows the to-go banner + comparison card, enlarges points, and does NOT re-fetch /partner/me', async () => {
    identityRef.current = identity('WHOLESALER', true);
    const fetchMock = stubFetch({ kpi: { code: 'SV', name: 'Secondary Volume', target: 800, achieved: 400, unit: 'cases' }, walletPts: 500, trend: CASES_TREND });
    vi.stubGlobal('fetch', fetchMock);
    render(<PartnerDashboardPage />);

    // Comparison card present — wait on a trend-derived value (trend fetch settles after mount).
    await waitFor(() => expect(screen.getByText('1,000 cases')).toBeInTheDocument());
    expect(screen.getByText('Secondary Volume · This month vs last')).toBeInTheDocument();
    expect(screen.getByText('This month (so far)')).toBeInTheDocument();  // honest partial-month label
    expect(screen.getByText('Last month')).toBeInTheDocument();
    expect(screen.getByText('800 cases')).toBeInTheDocument();
    expect(screen.getByText(/\+25%/)).toBeInTheDocument();

    // Trend chart hidden.
    expect(screen.queryByTestId('achievement-chart')).not.toBeInTheDocument();
    expect(screen.queryByText('Target vs. Achievement')).not.toBeInTheDocument();

    // To-go banner from the hero's primary KPI (800 − 400 = 400 cases). Exact text so it
    // can't be confused with the OFF-mode chart footer ("… to go · N days left").
    expect(screen.getByText('400 cases to go')).toBeInTheDocument();

    // Enlarged wallet points (500 → the points <p> carries text-4xl).
    expect(screen.getByText('500').className).toContain('text-4xl');

    // SINGLE identity source — the page must NOT fetch /partner/me itself (the hook is mocked).
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('/api/partner/me'))).toBe(false);
  });

  it('Finding 2: primary null (no current-month target) → card title + unit come from the trend (INR formatted)', async () => {
    identityRef.current = identity('WHOLESALER', true);
    const inrTrend: TrendResp = {
      kpiName: 'Net Revenue', unit: 'INR',
      trend: [
        { month: '2026-09', target: 600000, achieved: 500000 },  // last month ₹5L
        { month: '2026-10', target: 600000, achieved: 580000 },  // this month ₹5.8L
      ],
    };
    vi.stubGlobal('fetch', stubFetch({ kpi: null, walletPts: 500, trend: inrTrend }));
    render(<PartnerDashboardPage />);

    // Title + values resolve from the trend even though `primary` is null.
    await waitFor(() => expect(screen.getByText('₹5.8L')).toBeInTheDocument());
    expect(screen.getByText('Net Revenue · This month vs last')).toBeInTheDocument();
    expect(screen.getByText('₹5L')).toBeInTheDocument();                 // last month, INR compact
    expect(screen.getByText(/\+16%/)).toBeInTheDocument();               // +₹80K → +16%
  });
});

describe('PDV2 — partnerDashboardV2 OFF (byte-identical to today)', () => {
  it('shows the trend chart, no comparison card, no to-go banner, points stay text-base', async () => {
    identityRef.current = identity('WHOLESALER', false);
    vi.stubGlobal('fetch', stubFetch({ kpi: { code: 'SV', name: 'Secondary Volume', target: 800, achieved: 400, unit: 'cases' }, walletPts: 500, trend: CASES_TREND }));
    render(<PartnerDashboardPage />);

    await waitFor(() => expect(screen.getByTestId('achievement-chart')).toBeInTheDocument());

    // No comparison card, no hero to-go banner (the chart's own footer still reads
    // "… to go · N days left" as today — that is a DIFFERENT, non-exact string).
    expect(screen.queryByText(/This month vs last/)).not.toBeInTheDocument();
    expect(screen.queryByText('400 cases to go')).not.toBeInTheDocument();

    // Points stay small.
    const ptsEl = screen.getByText('500');
    expect(ptsEl.className).toContain('text-base');
    expect(ptsEl.className).not.toContain('text-4xl');
  });
});

describe('PDV2 — to-go banner uses the SAME exact remaining>0 condition in all heroes (Finding 3)', () => {
  // 996/1000 rounds to 100% (isMet), but raw remaining is 4 → every hero must still show "4 to go".
  const boundaryTrend: TrendResp = { kpiName: 'Secondary Volume', unit: 'cases', trend: [{ month: '2026-10', target: 1000, achieved: 996 }] };

  it.each([
    ['WHOLESALER'],
    ['SSS'],        // RetailerHero
    ['SSS_TOT'],    // MTHero
  ])('%s hero shows "4 cases to go" at the 996/1000 rounding boundary', async (outletType) => {
    identityRef.current = identity(outletType, true);
    vi.stubGlobal('fetch', stubFetch({ kpi: { code: 'SV', name: 'Secondary Volume', target: 1000, achieved: 996, unit: 'cases' }, walletPts: 100, trend: boundaryTrend }));
    render(<PartnerDashboardPage />);

    await waitFor(() => expect(screen.getByText('4 cases to go')).toBeInTheDocument());
  });
});

describe('PDV2 — computeMonthComparison (pure math)', () => {
  it('current vs last month with delta + %-change', () => {
    const cmp = computeMonthComparison([
      { month: '2026-09', target: 1000, achieved: 800 },
      { month: '2026-10', target: 1000, achieved: 1000 },
    ]);
    expect(cmp).toEqual({ current: 1000, previous: 800, delta: 200, pctChange: 25 });
  });

  it('negative change rounds the %-drop', () => {
    const cmp = computeMonthComparison([
      { month: '2026-09', target: 1000, achieved: 1000 },
      { month: '2026-10', target: 1000, achieved: 750 },
    ]);
    expect(cmp).toEqual({ current: 750, previous: 1000, delta: -250, pctChange: -25 });
  });

  it('no previous month → previous/delta/pctChange null (no NaN)', () => {
    const cmp = computeMonthComparison([{ month: '2026-10', target: 1000, achieved: 500 }]);
    expect(cmp).toEqual({ current: 500, previous: null, delta: null, pctChange: null });
  });

  it('previous month zero → delta kept, pctChange null (no Infinity)', () => {
    const cmp = computeMonthComparison([
      { month: '2026-09', target: 1000, achieved: 0 },
      { month: '2026-10', target: 1000, achieved: 300 },
    ]);
    expect(cmp).toEqual({ current: 300, previous: 0, delta: 300, pctChange: null });
  });

  it('null achieved coerces to 0; empty series → current null', () => {
    expect(computeMonthComparison([]).current).toBeNull();
    const cmp = computeMonthComparison([
      { month: '2026-09', target: 1000, achieved: null },
      { month: '2026-10', target: 1000, achieved: null },
    ]);
    expect(cmp).toEqual({ current: 0, previous: 0, delta: 0, pctChange: null });
  });
});
