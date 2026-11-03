/// <reference types="vitest/globals" />
/**
 * Last Month card (partnerDashboardV2).
 *
 * ONE card summarising the PREVIOUS calendar month:
 *   • Target achievement — last month's target vs achieved + % (matched by month KEY
 *     from the SAME /api/partner/targets/trend series the comparison card uses).
 *   • Reward credited last month — POINTS for a points outlet, ₹ PAYOUT for a payout
 *     outlet (both lines when the outlet has both). The points-vs-payout choice reuses
 *     the EXACT presence signals that drive the wallet page (identity.hasPointsActivity /
 *     hasPayoutActivity from /partner/me).
 *
 * Points credited comes from a SCALE-SAFE server aggregate
 * (GET /api/wallet/points-credited?month=YYYY-MM), NOT the paginated passbook — the
 * pagination-aware test below would FAIL against the old page-1-sum approach.
 *
 * v2-only: when partnerDashboardV2 is OFF (Deoleo) the card must not render.
 * Dates are RELATIVE to `new Date()` (never hardcoded) so the test stays green any month.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/components/charts/achievement-chart', () => ({ AchievementChart: () => <div data-testid="achievement-chart" /> }));
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

const identityRef: { current: unknown } = { current: null };
vi.mock('@/lib/partner-identity', () => ({ usePartnerIdentity: () => identityRef.current }));

import PartnerDashboardPage, {
  lastMonthFromTrend,
  previousMonthKey,
  sumPayoutCreditedInMonth,
} from '../page';

/** Resolved identity with the given points/payout presence + v2 flag. */
function identity(opts: { points: boolean; payout: boolean; v2?: boolean; outletType?: string }) {
  return {
    businessName: 'Test Firm', outletName: 'Test Outlet', ownerName: 'Owner',
    partnerCode: 'P-1', outletType: opts.outletType ?? 'WHOLESALER',
    hasPointsActivity: opts.points, hasPayoutActivity: opts.payout, loyaltyEnabled: true,
    features: { partnerDashboardV2: opts.v2 ?? true },
    activePartnerId: null, operableOutlets: [], groupOverviewAvailable: false,
    groupParent: null, activeSelectorInvalid: false, loading: false,
  };
}

type TrendRow = { month: string; target: number | null; achieved: number | null };
type Payout = { id?: string; period: string; status: string; payoutAmountPaise: number; paidAt?: string };

/** The previous-calendar-month key, and a mid-month IST timestamp inside it (safe from TZ edges). */
const LM_KEY = previousMonthKey();
const LM_DATE = `${LM_KEY}-15T12:00:00+05:30`;
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const CUR_DATE = `${currentMonthKey()}-10T12:00:00+05:30`;

function stubFetch(opts: {
  trend?: TrendRow[];
  pointsCredited?: number;        // what /api/wallet/points-credited returns for LM_KEY
  transactions?: unknown[];       // page-1 passbook rows (the card must NOT depend on these)
  payouts?: Payout[];
  walletPts?: number;
}) {
  return vi.fn((url: string) => {
    const ok = (data: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
    if (url.includes('/api/partner/targets/trend')) {
      return ok({ kpiName: 'Secondary Volume', unit: 'cases', trend: opts.trend ?? [] });
    }
    if (url.includes('/api/partner/targets')) {
      const outlets = (opts.trend && opts.trend.length)
        ? [{ outletCode: 'WS-1', outletName: 'Outlet 1', outletType: 'WHOLESALER',
             kpis: [{ code: 'SV', name: 'Secondary Volume', target: 1000, achieved: 500, pace: null, unit: 'cases', isPrimary: true }] }]
        : [];
      return ok({ period: currentMonthKey(), outlets });
    }
    if (url.includes('/api/wallet/points-credited')) return ok({ month: LM_KEY, points: opts.pointsCredited ?? 0 });
    if (url.includes('/api/wallet/transactions'))     return ok({ transactions: opts.transactions ?? [] });
    if (url.includes('/api/wallet'))                  return ok({ earnedPoints: 0 });
    if (url.includes('/api/partner/payouts'))         return ok({ payouts: opts.payouts ?? [] });
    if (url.includes('/api/auth/me')) {
      return ok({ user: { channelPartner: { wallets: [{ redeemablePoints: opts.walletPts ?? 0 }] } } });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ banners: [], popups: [] }) });
  });
}

const TREND: TrendRow[] = [
  { month: LM_KEY, target: 1000, achieved: 800 },               // last month → 80%
  { month: currentMonthKey(), target: 1000, achieved: 500 },    // this month (so far)
];

afterEach(() => { vi.unstubAllGlobals(); identityRef.current = null; });

/* ─── Pure helpers ──────────────────────────────────────────────────────────── */

describe('Last Month — pure helpers', () => {
  it('lastMonthFromTrend matches the row by month KEY (not position)', () => {
    expect(lastMonthFromTrend(TREND, LM_KEY)).toEqual({ target: 1000, achieved: 800 });
  });
  it('lastMonthFromTrend returns nulls when no row for that month (new outlet)', () => {
    expect(lastMonthFromTrend([{ month: currentMonthKey(), target: 1000, achieved: 100 }], LM_KEY))
      .toEqual({ target: null, achieved: null });
    expect(lastMonthFromTrend([], LM_KEY)).toEqual({ target: null, achieved: null });
  });
  it('previousMonthKey steps back exactly one calendar month (Jan→Dec prev year)', () => {
    expect(previousMonthKey(new Date('2026-01-10T12:00:00+05:30'))).toBe('2025-12');
    expect(previousMonthKey(new Date('2026-11-10T12:00:00+05:30'))).toBe('2026-10');
  });
  it('sumPayoutCreditedInMonth sums only PAID entries paid in the month (paise→₹)', () => {
    const payouts: Payout[] = [
      { period: LM_KEY, status: 'PAID',    payoutAmountPaise: 500000, paidAt: LM_DATE },  // ₹5,000
      { period: LM_KEY, status: 'PENDING', payoutAmountPaise: 300000, paidAt: undefined },// not paid
      { period: LM_KEY, status: 'PAID',    payoutAmountPaise: 100000, paidAt: CUR_DATE }, // paid this month
    ];
    expect(sumPayoutCreditedInMonth(payouts as never, LM_KEY)).toBe(5000);
  });
});

/* ─── Rendering ───────────────────────────────────────────────────────────────── */

describe('Last Month card — rendering', () => {
  it('points outlet → "Points credited" from the server aggregate + target %', async () => {
    identityRef.current = identity({ points: true, payout: false });
    vi.stubGlobal('fetch', stubFetch({ trend: TREND, pointsCredited: 750, walletPts: 1200 }));
    render(<PartnerDashboardPage />);

    await waitFor(() => expect(screen.getByText('Last Month')).toBeInTheDocument());
    expect(screen.getByText('Points credited')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('750')).toBeInTheDocument());
    expect(screen.getByText('80%')).toBeInTheDocument();                       // 800/1000
    expect(screen.getByText('800 cases of 1,000 cases')).toBeInTheDocument();
    expect(screen.queryByText('Payout credited')).not.toBeInTheDocument();
  });

  it('BLOCKER regression — uses the month aggregate, NOT page-1 of the paginated passbook', async () => {
    // The passbook page 1 carries only current-month rows (last month is on page 2+). The OLD
    // approach summed these → "0". The card must show the server aggregate (55,000) and must not
    // read the paginated passbook at all.
    identityRef.current = identity({ points: true, payout: false });
    const fetchMock = stubFetch({
      trend: TREND,
      pointsCredited: 55_000,
      transactions: [{ transactionType: 'CREDIT_POINTS_EARNED', points: 10, date: CUR_DATE }], // page-1, current month only
      walletPts: 1200,
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PartnerDashboardPage />);

    await waitFor(() => expect(screen.getByText('55,000')).toBeInTheDocument());
    expect(screen.queryByText('0')).not.toBeInTheDocument(); // the old page-1 sum would have shown 0
    // The card never touches the paginated passbook → correct at any scale.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/wallet/transactions'))).toBe(false);
  });

  it('both-activity outlet → BOTH "Points credited" and "Payout credited" lines render', async () => {
    identityRef.current = identity({ points: true, payout: true });
    vi.stubGlobal('fetch', stubFetch({
      trend: TREND,
      pointsCredited: 320,
      payouts: [{ period: LM_KEY, status: 'PAID', payoutAmountPaise: 500000, paidAt: LM_DATE }], // ₹5,000
      walletPts: 1200,
    }));
    render(<PartnerDashboardPage />);

    await waitFor(() => expect(screen.getByText('Points credited')).toBeInTheDocument());
    expect(screen.getByText('Payout credited')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('320')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('₹5K')).toBeInTheDocument());
  });

  it('payout outlet → "Payout credited" ₹ total, no points line', async () => {
    identityRef.current = identity({ points: false, payout: true, outletType: 'SSS' });
    vi.stubGlobal('fetch', stubFetch({
      trend: TREND,
      payouts: [
        { period: LM_KEY, status: 'PAID', payoutAmountPaise: 500000, paidAt: LM_DATE },  // ₹5,000
        { period: LM_KEY, status: 'PAID', payoutAmountPaise: 200000, paidAt: CUR_DATE }, // excluded
      ],
    }));
    render(<PartnerDashboardPage />);

    await waitFor(() => expect(screen.getByText('Payout credited')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('₹5K')).toBeInTheDocument());
    expect(screen.queryByText('Points credited')).not.toBeInTheDocument();
  });

  it('zero state → new outlet, no target history + no reward reality → "No activity last month"', async () => {
    identityRef.current = identity({ points: false, payout: false });
    vi.stubGlobal('fetch', stubFetch({ trend: [] }));
    render(<PartnerDashboardPage />);

    await waitFor(() => expect(screen.getByText('No activity last month')).toBeInTheDocument());
  });

  it('points outlet with ZERO credits last month → honest "0 pts"', async () => {
    identityRef.current = identity({ points: true, payout: false });
    // walletPts distinct from 0 so the hero wallet ("1,200") can't collide with the card's "0".
    vi.stubGlobal('fetch', stubFetch({ trend: TREND, pointsCredited: 0, walletPts: 1200 }));
    render(<PartnerDashboardPage />);

    await waitFor(() => expect(screen.getByText('Points credited')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('0')).toBeInTheDocument());
  });

  it('v2 OFF (Deoleo) → the Last Month card does NOT render', async () => {
    identityRef.current = identity({ points: true, payout: false, v2: false });
    vi.stubGlobal('fetch', stubFetch({ trend: TREND, pointsCredited: 750 }));
    render(<PartnerDashboardPage />);

    await waitFor(() => expect(screen.getByTestId('achievement-chart')).toBeInTheDocument());
    expect(screen.queryByText('Last Month')).not.toBeInTheDocument();
  });
});
