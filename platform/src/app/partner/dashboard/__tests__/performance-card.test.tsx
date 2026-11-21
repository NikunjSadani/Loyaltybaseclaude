/// <reference types="vitest/globals" />
/**
 * Performance card (partnerDashboardV2) — the MERGED card that replaced the former
 * "Achievement · This month vs last" and "Last Month" cards.
 *
 * One two-column card (NO charts):
 *   • THIS MONTH · so far — current-month achieved + "% of target" (or "No target")
 *   • LAST MONTH · <Mon>  — previous-month achieved + target verdict (✓ target met /
 *     below target / No target set) + reward CREDITED last month (points OR payout,
 *     BOTH when the outlet has both)
 *   • Change vs last month — TOTAL sales across all outlets when the v2 trend carries
 *     `achievedAll` ("Change in total sales vs last month" when it differs from the
 *     targeted-only figures), else the same delta the old comparison card showed
 *
 * Reuses the SAME /api/partner/targets/trend series (computeMonthComparison for achieved
 * + delta; lastMonthFromTrend by month KEY for targets) and the EXACT points-vs-payout
 * presence signals (hasPointsActivity / hasPayoutActivity). Points credited comes from
 * the SCALE-SAFE aggregate GET /api/wallet/points-credited (never the paginated passbook).
 *
 * v2-only: OFF (Deoleo) renders neither this nor a chart-comparison card.
 * Months are RELATIVE to `new Date()` (IST) so the test stays green in any month.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { istMonthKey } from '@/lib/ist-date';

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
  safeCtaUrl: (u?: string) => (u && /^https?:\/\//.test(u) ? u : null),
  toEmbedUrl:               (u: string) => u,
}));
vi.mock('@/app/partner/schemes/portal-api', () => ({
  loadPortalSchemes: () => Promise.resolve([]),
  statusOf:          () => 'NOT_ENROLLED',
}));

const identityRef: { current: unknown } = { current: null };
vi.mock('@/lib/partner-identity', () => ({ usePartnerIdentity: () => identityRef.current }));

import PartnerDashboardPage, {
  computeMonthComparison,
  computeSalesChange,
  lastMonthFromTrend,
  previousMonthKey,
  sumPayoutCreditedInMonth,
} from '../page';

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

type TrendRow = { month: string; target: number | null; achieved: number | null; achievedAll?: number | null };
type Payout = { id?: string; period: string; status: string; payoutAmountPaise: number; paidAt?: string };

// Date-relative month keys (IST), matching how the card derives them.
const CUR  = istMonthKey(new Date());
const PREV = previousMonthKey();
const LM_DATE  = `${PREV}-15T12:00:00+05:30`;
const CUR_DATE = `${CUR}-10T12:00:00+05:30`;

function stubFetch(opts: {
  trend?: TrendRow[];
  unit?: string;
  noPrimary?: boolean;        // force targets→empty so the page's `primary` is null
  pointsCredited?: number;
  transactions?: unknown[];
  payouts?: Payout[];
  walletPts?: number;
}) {
  return vi.fn((url: string) => {
    const ok = (data: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
    if (url.includes('/api/partner/targets/trend')) {
      return ok({ kpiName: 'Secondary Volume', unit: opts.unit ?? 'cases', trend: opts.trend ?? [] });
    }
    if (url.includes('/api/partner/targets')) {
      const outlets = (!opts.noPrimary && opts.trend && opts.trend.length)
        ? [{ outletCode: 'WS-1', outletName: 'Outlet 1', outletType: 'WHOLESALER',
             kpis: [{ code: 'SV', name: 'Secondary Volume', target: 1000, achieved: 500, pace: null, unit: opts.unit ?? 'cases', isPrimary: true }] }]
        : [];
      return ok({ period: CUR, outlets });
    }
    if (url.includes('/api/wallet/points-credited')) return ok({ month: PREV, points: opts.pointsCredited ?? 0 });
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
  { month: PREV, target: 1000, achieved: 800 },    // last month → 80% (below target)
  { month: CUR,  target: 1000, achieved: 1000 },   // this month (so far) → 100%
];

afterEach(() => { vi.unstubAllGlobals(); identityRef.current = null; });

/* ─── Pure helpers ──────────────────────────────────────────────────────────── */

describe('Performance — pure helpers', () => {
  it('lastMonthFromTrend matches by month KEY (rollover-safe)', () => {
    expect(lastMonthFromTrend(TREND, PREV)).toEqual({ target: 1000, achieved: 800 });
    expect(lastMonthFromTrend(TREND, CUR)).toEqual({ target: 1000, achieved: 1000 });
    expect(lastMonthFromTrend(TREND, '1999-01')).toEqual({ target: null, achieved: null });
    expect(lastMonthFromTrend([], PREV)).toEqual({ target: null, achieved: null });
  });
  it('previousMonthKey steps back one calendar month (Jan→Dec prev year)', () => {
    expect(previousMonthKey(new Date('2026-01-10T12:00:00+05:30'))).toBe('2025-12');
    expect(previousMonthKey(new Date('2026-11-10T12:00:00+05:30'))).toBe('2026-10');
  });
  it('sumPayoutCreditedInMonth sums only PAID entries paid in the month (paise→₹)', () => {
    const payouts: Payout[] = [
      { period: PREV, status: 'PAID',    payoutAmountPaise: 500000, paidAt: LM_DATE },  // ₹5,000
      { period: PREV, status: 'PENDING', payoutAmountPaise: 300000, paidAt: undefined },// not paid
      { period: PREV, status: 'PAID',    payoutAmountPaise: 100000, paidAt: CUR_DATE }, // paid this month → excluded
    ];
    expect(sumPayoutCreditedInMonth(payouts as never, PREV)).toBe(5000);
  });
  it('computeSalesChange — uses achievedAll when present (A/B → 0%, total-sales label)', () => {
    const ab = [
      { month: PREV, target: null, achieved: 2500, achievedAll: 2500 },
      { month: CUR,  target: 1000, achieved: 500,  achievedAll: 2500 },
    ];
    expect(computeSalesChange(ab)).toEqual({ current: 2500, previous: 2500, delta: 0, pctChange: 0, totalSalesLabel: true });
  });
  it('computeSalesChange — no achievedAll (flag OFF payload) → identical to computeMonthComparison, old label', () => {
    expect(computeSalesChange(TREND)).toEqual({ ...computeMonthComparison(TREND), totalSalesLabel: false });
    expect(computeSalesChange([])).toEqual({ current: null, previous: null, delta: null, pctChange: null, totalSalesLabel: false });
  });
});

/* ─── Rendering ───────────────────────────────────────────────────────────────── */

describe('Performance card — rendering', () => {
  it('points outlet → this-month, last-month, verdict, delta, and the points line', async () => {
    identityRef.current = identity({ points: true, payout: false });
    vi.stubGlobal('fetch', stubFetch({ trend: TREND, pointsCredited: 750, walletPts: 1200 }));
    render(<PartnerDashboardPage />);

    expect(await screen.findByText('Performance')).toBeInTheDocument();
    // This month · so far
    expect(await screen.findByText('This month · so far')).toBeInTheDocument();
    expect(await screen.findByText('1,000 cases')).toBeInTheDocument();
    expect(await screen.findByText('100% of 1,000 cases target')).toBeInTheDocument();
    // Last month · <Mon>  (header carries "· " → distinct from "Change vs last month")
    expect(await screen.findByText(/^Last month · /)).toBeInTheDocument();
    expect(await screen.findByText('800 cases')).toBeInTheDocument();
    expect(await screen.findByText('below target')).toBeInTheDocument();
    // Reward credited (points outlet only). The points line comes from the SEPARATE
    // /wallet/points-credited effect (setPointsCr), not the trend fetch awaited above — so await
    // it independently; a sync getByText here raced that cross-source commit under suite load.
    expect(await screen.findByText('+750 pts credited')).toBeInTheDocument();
    expect(screen.queryByText(/payout/)).not.toBeInTheDocument();
    // Change vs last month: 1000 − 800 = +200 (+25%)
    expect(await screen.findByText('Change vs last month')).toBeInTheDocument();
    expect(await screen.findByText(/\+25%/)).toBeInTheDocument();
    // No achievedAll in the payload → old label, old delta.
    expect(screen.queryByText('Change in total sales vs last month')).not.toBeInTheDocument();
  });

  it('A/B example — targeted set changes month to month → change uses ALL-outlet sales (0%, no red), honest label', async () => {
    // Last month: no targets → 2,500 across A+B. This month: only A targeted → targeted-only 500,
    // but total sales still 2,500. Old behaviour showed −80%; the change line must read 0%.
    identityRef.current = identity({ points: true, payout: false });
    const ab = [
      { month: PREV, target: null, achieved: 2500, achievedAll: 2500 },
      { month: CUR,  target: 1000, achieved: 500,  achievedAll: 2500 },
    ];
    vi.stubGlobal('fetch', stubFetch({ trend: ab as TrendRow[], pointsCredited: 0, walletPts: 1200 }));
    render(<PartnerDashboardPage />);

    // Await a trend-driven element first (the card shell renders before the trend fetch lands).
    expect(await screen.findByText('Change in total sales vs last month')).toBeInTheDocument();
    // The "so far" / target figures stay targeted-only.
    expect(await screen.findByText('50% of 1,000 cases target')).toBeInTheDocument();
    expect(await screen.findByText('2,500 cases')).toBeInTheDocument();
    // Change line = total sales comparison, labelled as such.
    expect(await screen.findByText('Change in total sales vs last month')).toBeInTheDocument();
    expect(screen.queryByText('Change vs last month')).not.toBeInTheDocument();
    const pctEl = await screen.findByText(/\+0%/);
    expect(screen.queryByText(/-80%/)).not.toBeInTheDocument();
    expect(pctEl.closest('.text-red-600')).toBeNull();
    expect(pctEl.closest('.text-emerald-600')).not.toBeNull();
  });

  it('achievedAll equals the targeted figure in both months → old label kept', async () => {
    identityRef.current = identity({ points: true, payout: false });
    const same = [
      { month: PREV, target: 1000, achieved: 800,  achievedAll: 800 },
      { month: CUR,  target: 1000, achieved: 1000, achievedAll: 1000 },
    ];
    vi.stubGlobal('fetch', stubFetch({ trend: same as TrendRow[], pointsCredited: 0, walletPts: 1200 }));
    render(<PartnerDashboardPage />);

    // Await the trend-driven delta (the label alone renders before the trend fetch lands).
    expect(await screen.findByText(/\+25%/)).toBeInTheDocument();
    expect(await screen.findByText('Change vs last month')).toBeInTheDocument();
    expect(screen.queryByText('Change in total sales vs last month')).not.toBeInTheDocument();
  });

  it('BLOCKER regression — points come from the month aggregate, NOT page-1 of the passbook', async () => {
    identityRef.current = identity({ points: true, payout: false });
    const fetchMock = stubFetch({
      trend: TREND,
      pointsCredited: 55_000,
      transactions: [{ transactionType: 'CREDIT_POINTS_EARNED', points: 10, date: CUR_DATE }], // page-1, current month only
      walletPts: 1200,
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PartnerDashboardPage />);

    expect(await screen.findByText('+55,000 pts credited')).toBeInTheDocument();
    // The card never touches the paginated passbook → correct at any scale.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/wallet/transactions'))).toBe(false);
  });

  it('payout outlet → the payout line (date-based, last month), no points line', async () => {
    identityRef.current = identity({ points: false, payout: true, outletType: 'SSS' });
    vi.stubGlobal('fetch', stubFetch({
      trend: TREND,
      payouts: [
        { period: PREV, status: 'PAID', payoutAmountPaise: 500000, paidAt: LM_DATE },  // ₹5,000
        { period: PREV, status: 'PAID', payoutAmountPaise: 200000, paidAt: CUR_DATE }, // paid this month → excluded
      ],
    }));
    render(<PartnerDashboardPage />);

    expect(await screen.findByText('₹5K payout')).toBeInTheDocument();
    expect(screen.queryByText(/pts credited/)).not.toBeInTheDocument();
  });

  it('both-activity outlet → BOTH the points line and the payout line render', async () => {
    identityRef.current = identity({ points: true, payout: true });
    vi.stubGlobal('fetch', stubFetch({
      trend: TREND,
      pointsCredited: 320,
      payouts: [{ period: PREV, status: 'PAID', payoutAmountPaise: 500000, paidAt: LM_DATE }], // ₹5,000
      walletPts: 1200,
    }));
    render(<PartnerDashboardPage />);

    expect(await screen.findByText('+320 pts credited')).toBeInTheDocument();
    // The payout line comes from the SEPARATE /partner/payouts effect (setPayoutCr), a different
    // async source than the points line awaited above → await it too (was a sync cross-source race).
    expect(await screen.findByText('₹5K payout')).toBeInTheDocument();
  });

  it('INR unit + no primary (no current-month target row) → ₹ formatting from the trend', async () => {
    identityRef.current = identity({ points: true, payout: false });
    const inr: TrendRow[] = [
      { month: PREV, target: 600000, achieved: 500000 },  // last month ₹5L → below target
      { month: CUR,  target: 600000, achieved: 580000 },  // this month ₹5.8L
    ];
    vi.stubGlobal('fetch', stubFetch({ trend: inr, unit: 'INR', noPrimary: true, pointsCredited: 0, walletPts: 1200 }));
    render(<PartnerDashboardPage />);

    expect(await screen.findByText('₹5.8L')).toBeInTheDocument(); // this month
    expect(await screen.findByText('₹5L')).toBeInTheDocument();                         // last month
    expect(await screen.findByText(/\+16%/)).toBeInTheDocument();                       // +₹80K → +16%
  });

  it('no-target state → "No target" (this month) and "No target set" (last month)', async () => {
    identityRef.current = identity({ points: true, payout: false });
    const noTargetTrend: TrendRow[] = [
      { month: PREV, target: null, achieved: 300 },
      { month: CUR,  target: null, achieved: 400 },
    ];
    vi.stubGlobal('fetch', stubFetch({ trend: noTargetTrend, noPrimary: true, pointsCredited: 90, walletPts: 1200 }));
    render(<PartnerDashboardPage />);

    expect(await screen.findByText('Performance')).toBeInTheDocument();
    expect(await screen.findByText('No target')).toBeInTheDocument();       // this-month sub-line
    expect(await screen.findByText('No target set')).toBeInTheDocument();   // last-month verdict
  });

  it('zero points last month → honest "0 pts credited"', async () => {
    identityRef.current = identity({ points: true, payout: false });
    vi.stubGlobal('fetch', stubFetch({ trend: TREND, pointsCredited: 0, walletPts: 1200 }));
    render(<PartnerDashboardPage />);

    expect(await screen.findByText('0 pts credited')).toBeInTheDocument();
  });

  it('new-outlet empty state → "No activity last month"', async () => {
    identityRef.current = identity({ points: false, payout: false });
    vi.stubGlobal('fetch', stubFetch({ trend: [] }));
    render(<PartnerDashboardPage />);

    expect(await screen.findByText('No activity last month')).toBeInTheDocument();
  });

  it('v2 OFF (Deoleo) → the Performance card does NOT render (chart shown instead)', async () => {
    identityRef.current = identity({ points: true, payout: false, v2: false });
    vi.stubGlobal('fetch', stubFetch({ trend: TREND, pointsCredited: 750 }));
    render(<PartnerDashboardPage />);

    expect(await screen.findByTestId('achievement-chart')).toBeInTheDocument();
    expect(screen.queryByText('Performance')).not.toBeInTheDocument();
  });
});
