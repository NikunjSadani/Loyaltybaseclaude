/// <reference types="vitest/globals" />
/**
 * Target Achievement card (partner/outlet dashboard) — the multi-KPI breakdown placed
 * DIRECTLY BELOW the Performance card. Mirrors the SALES dashboard's "Target Achievement"
 * card, but scoped to THIS single outlet, built from the `aggKpis` the page already loads
 * (NO extra fetch).
 *
 * Asserts:
 *   • every aggKpi renders as its own row (name + "achieved/target unit · pct%");
 *   • the footer shows "{remaining} … to go · {N} days left" (reusing the hero's math);
 *   • the card sits BELOW the Performance card in document order;
 *   • it renders NOTHING when the outlet has no targets (empty aggKpis).
 *
 * Harness mirrors performance-card.test.tsx. Months are RELATIVE to new Date() (IST) so the
 * test stays green in any month. The identity hook is mocked (it fetches /partner/me in prod),
 * so the page must not fetch it.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
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

import PartnerDashboardPage, { previousMonthKey } from '../page';

function identity(opts: { outletType?: string } = {}) {
  return {
    businessName: 'Test Firm', outletName: 'Test Outlet', ownerName: 'Owner',
    partnerCode: 'P-1', outletType: opts.outletType ?? 'WHOLESALER',
    hasPointsActivity: true, hasPayoutActivity: false, loyaltyEnabled: true,
    features: { partnerDashboardV2: true },
    activePartnerId: null, operableOutlets: [], groupOverviewAvailable: false,
    groupParent: null, activeSelectorInvalid: false, loading: false,
  };
}

type ApiKpi = { code: string; name: string; target: number | null; achieved: number | null; unit: string; isPrimary: boolean };
type TrendRow = { month: string; target: number | null; achieved: number | null };

const CUR  = istMonthKey(new Date());
const PREV = previousMonthKey();

// A Performance-card trend so that card also renders (we assert ordering against it). Its
// numbers (800/1,000 cases) are deliberately distinct from the Target Achievement rows.
const TREND: TrendRow[] = [
  { month: PREV, target: 1000, achieved: 800 },
  { month: CUR,  target: 1000, achieved: 1000 },
];

function stubFetch(opts: { kpis: ApiKpi[]; trend?: TrendRow[]; extraOutlets?: ApiKpi[][] }) {
  return vi.fn((url: string) => {
    const ok = (data: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
    if (url.includes('/api/partner/targets/trend')) {
      return ok({ kpiName: 'Month Target', unit: 'cases', trend: opts.trend ?? [] });
    }
    if (url.includes('/api/partner/targets')) {
      const outlets = opts.kpis.length
        ? [
            { outletCode: 'WS-1', outletName: 'Outlet 1', outletType: 'WHOLESALER', kpis: opts.kpis },
            ...(opts.extraOutlets ?? []).map((kpis, i) => ({ outletCode: `WS-${i + 2}`, outletName: `Outlet ${i + 2}`, outletType: 'SSS', kpis })),
          ]
        : [];
      return ok({ period: CUR, outlets });
    }
    if (url.includes('/api/wallet/points-credited')) return ok({ month: PREV, points: 0 });
    if (url.includes('/api/partner/payouts'))         return ok({ payouts: [] });
    if (url.includes('/api/auth/me')) {
      return ok({ user: { channelPartner: { wallets: [{ redeemablePoints: 1200 }] } } });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ banners: [], popups: [] }) });
  });
}

// A realistic multi-KPI outlet. Percentages are all distinct (50/100/80/60/40) so each row's
// "… · pct%" is uniquely assertable.
const KPIS: ApiKpi[] = [
  { code: 'MONTH',    name: 'Month Target',    target: 1000, achieved: 500, unit: 'cases', isPrimary: true  },
  { code: 'ADHO',     name: 'ADHO TARGET',     target: 200,  achieved: 200, unit: 'cases', isPrimary: false },
  { code: 'NONADHO',  name: 'NON ADHO TARGET', target: 100,  achieved: 80,  unit: 'cases', isPrimary: false },
  { code: 'FOCUS',    name: 'FOCUS BRAND',     target: 50,   achieved: 30,  unit: 'cases', isPrimary: false },
  { code: 'LINES',    name: 'LINES',           target: 10,   achieved: 4,   unit: 'cases', isPrimary: false },
];

afterEach(() => { vi.unstubAllGlobals(); identityRef.current = null; });

describe('Target Achievement card', () => {
  it('renders one row per aggKpi (name + pct), below the Performance card, with the to-go footer', async () => {
    identityRef.current = identity();
    vi.stubGlobal('fetch', stubFetch({ kpis: KPIS, trend: TREND }));
    render(<PartnerDashboardPage />);

    // The card appears once the page's targets have loaded.
    const card = await screen.findByTestId('target-achievement-card');
    const inCard = within(card);

    // Every KPI renders as its own row: name + paired achieved/target + percentage. The
    // non-primary names are unique to this card; the primary name ("Month Target") also shows
    // in the hero, so we scope it to the card with `within`.
    expect(inCard.getByText('Month Target')).toBeInTheDocument();
    expect(inCard.getByText('ADHO TARGET')).toBeInTheDocument();
    expect(inCard.getByText('NON ADHO TARGET')).toBeInTheDocument();
    expect(inCard.getByText('FOCUS BRAND')).toBeInTheDocument();
    expect(inCard.getByText('LINES')).toBeInTheDocument();

    // Paired value + percentage per row (all five distinct).
    expect(inCard.getByText('500/1,000 cases · 50%')).toBeInTheDocument();
    expect(inCard.getByText('200/200 cases · 100%')).toBeInTheDocument();
    expect(inCard.getByText('80/100 cases · 80%')).toBeInTheDocument();
    expect(inCard.getByText('30/50 cases · 60%')).toBeInTheDocument();
    expect(inCard.getByText('4/10 cases · 40%')).toBeInTheDocument();

    // Footer — remaining on the PRIMARY KPI (1000 − 500 = 500 cases) + days-left. Reuses the
    // hero's remaining math + computePace().daysLeft, so it never disagrees with the hero.
    expect(inCard.getByText(/500 cases to go · \d+ days? left/)).toBeInTheDocument();

    // Placement: the card sits BELOW the Performance card in document order.
    const perf = await screen.findByText('Performance');
    // eslint-disable-next-line no-bitwise
    expect(perf.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a KPI with NO target shows a neutral "so far" figure — no %, no red "— · 0%", no NaN', async () => {
    identityRef.current = identity();
    const zeroKpis: ApiKpi[] = [
      { code: 'MONTH', name: 'Month Target', target: 1000, achieved: 500,     unit: 'cases', isPrimary: true },
      { code: 'ZERO',  name: 'No Target KPI', target: 0,   achieved: 0,       unit: 'cases', isPrimary: false },
      // Bajaj SAMT: NON ADHO has sales but no target (the gate KPI) → "₹2.8K so far".
      { code: 'NONADHO', name: 'NON ADHO',    target: 0,   achieved: 2755.12, unit: 'INR',   isPrimary: false },
      { code: 'NEG',   name: 'Returns KPI',   target: 0,   achieved: -1500,   unit: 'INR',   isPrimary: false },
    ];
    vi.stubGlobal('fetch', stubFetch({ kpis: zeroKpis, trend: TREND }));
    render(<PartnerDashboardPage />);

    const card = await screen.findByTestId('target-achievement-card', {}, { timeout: 15000 });
    const inCard = within(card);
    expect(inCard.getByText('No Target KPI')).toBeInTheDocument();
    expect(inCard.getByText('0 cases so far')).toBeInTheDocument();
    expect(inCard.getByText('NON ADHO')).toBeInTheDocument();
    expect(inCard.getByText('₹2.8K so far')).toBeInTheDocument();
    expect(inCard.getByText('-₹1.5K so far')).toBeInTheDocument();
    // No percentage / dash pairing for target-less rows, and no NaN/Infinity anywhere.
    expect(inCard.queryByText(/— · 0%/)).not.toBeInTheDocument();
    expect(within(inCard.getByTestId('kpi-no-target-NONADHO')).queryByText(/%/)).not.toBeInTheDocument();
    expect(card.textContent).not.toMatch(/NaN|Infinity/);
    // The targeted row is unchanged.
    expect(inCard.getByText('500/1,000 cases · 50%')).toBeInTheDocument();
  }, 20000);

  it('footer never says "target met" for a KPI without a target — falls back to the first targeted KPI', async () => {
    identityRef.current = identity();
    const kpis: ApiKpi[] = [
      // Primary KPI has NO target (sales only) → must not produce "NON ADHO target met 🎉".
      { code: 'NONADHO', name: 'NON ADHO', target: 0,  achieved: 2755.12, unit: 'INR', isPrimary: true  },
      { code: 'LINES',   name: 'Lines',    target: 8,  achieved: 7,       unit: 'SKU', isPrimary: false },
      // No sales data at all (null) → "—", not a stated zero.
      { code: 'FB',      name: 'Focus Brand 1', target: 0, achieved: null as unknown as number, unit: 'INR', isPrimary: false },
    ];
    vi.stubGlobal('fetch', stubFetch({ kpis, trend: TREND }));
    render(<PartnerDashboardPage />);

    const card = await screen.findByTestId('target-achievement-card', {}, { timeout: 15000 });
    const inCard = within(card);
    expect(inCard.queryByText(/NON ADHO target met/)).not.toBeInTheDocument();
    expect(inCard.getByText(/1 SKU to go · \d+ days? left/)).toBeInTheDocument();
    expect(await within(inCard.getByTestId('kpi-no-target-FB')).findByText('—')).toBeInTheDocument();
  }, 20000);

  it('multi-outlet: sales at an outlet WITHOUT the target never fill another outlet\'s target', async () => {
    identityRef.current = identity();
    // Shop A has a ₹1,000 NON ADHO target with ₹500 sales; shop B has no NON ADHO target but ₹2,000 sales.
    const shopA: ApiKpi[] = [
      { code: 'LINES',   name: 'Lines',    target: 8,    achieved: 4,   unit: 'SKU', isPrimary: true  },
      { code: 'NONADHO', name: 'NON ADHO', target: 1000, achieved: 500, unit: 'INR', isPrimary: false },
      { code: 'GATE',    name: 'Gate KPI', target: 0,    achieved: 300, unit: 'INR', isPrimary: false },
    ];
    const shopB: ApiKpi[] = [
      { code: 'LINES',   name: 'Lines',    target: 8,    achieved: 6,    unit: 'SKU', isPrimary: true  },
      { code: 'NONADHO', name: 'NON ADHO', target: 0,    achieved: 2000, unit: 'INR', isPrimary: false },
      { code: 'GATE',    name: 'Gate KPI', target: 0,    achieved: 100,  unit: 'INR', isPrimary: false },
    ];
    vi.stubGlobal('fetch', stubFetch({ kpis: shopA, trend: TREND, extraOutlets: [shopB] }));
    render(<PartnerDashboardPage />);

    const card = await screen.findByTestId('target-achievement-card', {}, { timeout: 15000 });
    const inCard = within(card);
    // Targeted-only: 500/1,000 = 50% — NOT (500+2,000)/1,000 = 250%.
    expect(inCard.getByText('500/1K · 50%')).toBeInTheDocument();
    expect(inCard.queryByText(/250%/)).not.toBeInTheDocument();
    expect(await within(inCard.getByTestId('kpi-untargeted-NONADHO')).findByText(/\+₹2K\s+so far at outlets without this target/)).toBeInTheDocument();
    // Both shops have the Lines target → summed exactly as before (4+6 of 8+8).
    expect(inCard.getByText('10/16 SKU · 63%')).toBeInTheDocument();
    expect(inCard.queryByTestId('kpi-untargeted-LINES')).not.toBeInTheDocument();
    // No outlet has a target → all sales summed as "so far".
    expect(inCard.getByText('₹400 so far')).toBeInTheDocument();
  }, 20000);

  it('footer is a neutral note when NO KPI has a target', async () => {
    identityRef.current = identity();
    const kpis: ApiKpi[] = [
      { code: 'NONADHO', name: 'NON ADHO', target: 0, achieved: 400, unit: 'INR', isPrimary: true },
    ];
    vi.stubGlobal('fetch', stubFetch({ kpis, trend: TREND }));
    render(<PartnerDashboardPage />);

    const card = await screen.findByTestId('target-achievement-card', {}, { timeout: 15000 });
    expect(await within(card).findByText('No targets set this month')).toBeInTheDocument();
    expect(within(card).queryByText(/target met/)).not.toBeInTheDocument();
  }, 20000);

  it('renders NOTHING when the outlet has no targets (empty aggKpis)', async () => {
    identityRef.current = identity();
    vi.stubGlobal('fetch', stubFetch({ kpis: [], trend: [] }));
    render(<PartnerDashboardPage />);

    // Wait until the page has settled past its loading spinner (Quick Actions always renders).
    expect(await screen.findByText('My Targets')).toBeInTheDocument();
    expect(screen.queryByTestId('target-achievement-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Target Achievement')).not.toBeInTheDocument();
  });
});
