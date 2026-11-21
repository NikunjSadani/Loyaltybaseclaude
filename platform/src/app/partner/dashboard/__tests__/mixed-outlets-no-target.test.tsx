/// <reference types="vitest/globals" />
/**
 * Partner dashboard — multi-outlet aggregation + target-less KPIs (owner 2026-11-15).
 *
 * partnerDashboardV2 ON (Bajaj):
 *   MX1: mixed outlets — hero, Target Achievement card and the trend request all agree on the
 *        targeted-outlets-only figure (₹500 of ₹1,000 · 50%); untargeted sales shown apart.
 *   MX2: a KPI missing ENTIRELY at outlet B → counted from outlet A only, no "+X" line.
 *   MX3: a target-less FLAGGED primary is never the hero headline → first KPI with a target.
 *   MX4: no KPI has a target → neutral "₹2.8K so far" hero ("No targets set this month"), no %.
 *   MX5: MT (SSS_TOT) hero — target-less KPIs are neutral rows, excluded from met/allMet.
 * partnerDashboardV2 OFF (Deoleo — must render exactly as before):
 *   OFF1: mixed outlets → plain sums in the hero (₹2,500 of ₹1,000 · 250%), no "+X" line.
 *   OFF2: target-less flagged primary → the old "0 of 0 · 0%" + "No targets yet" hero.
 *   OFF3: MT hero scores the target-less KPI (0%) and so never says "All targets achieved".
 */

import React from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
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

import PartnerDashboardPage from '../page';

function identity(v2: boolean, outletType = 'WHOLESALER') {
  return {
    businessName: 'Test Firm', outletName: 'Test Outlet', ownerName: 'Owner',
    partnerCode: 'P-1', outletType,
    hasPointsActivity: false, hasPayoutActivity: false, loyaltyEnabled: true,
    features: { partnerDashboardV2: v2 },
    activePartnerId: null, operableOutlets: [], groupOverviewAvailable: false,
    groupParent: null, activeSelectorInvalid: false, loading: false,
  };
}

type ApiKpi = { code: string; name: string; target: number | null; achieved: number | null; unit: string; isPrimary: boolean };
const CUR = istMonthKey(new Date());

function stubFetch(outlets: ApiKpi[][]) {
  const fn = vi.fn((url: string) => {
    const ok = (data: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
    if (url.includes('/api/partner/targets/trend')) return ok({ kpiName: null, unit: null, trend: [] });
    if (url.includes('/api/partner/targets')) {
      return ok({
        period: CUR,
        outlets: outlets.map((kpis, i) => ({ outletCode: `O-${i + 1}`, outletName: `Outlet ${i + 1}`, outletType: 'SSS', kpis })),
      });
    }
    if (url.includes('/api/auth/me')) return ok({ user: { channelPartner: { wallets: [{ redeemablePoints: 1200 }] } } });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ banners: [], popups: [] }) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** The hero's KPI zone = the FIRST link to /partner/targets (Quick Actions' "My Targets" comes later). */
async function heroZone(): Promise<HTMLElement> {
  await screen.findAllByText('All targets', { exact: false }, { timeout: 15000 });
  return Array.from(document.querySelectorAll('a[href="/partner/targets"]'))[0] as HTMLElement;
}

// Shop A: ₹1,000 SALES target, ₹500 sales. Shop B: NO SALES target, ₹2,000 sales. LINES targeted at both.
const SHOP_A: ApiKpi[] = [
  { code: 'SALES', name: 'Monthly Sales', target: 1000, achieved: 500,  unit: 'INR', isPrimary: true  },
  { code: 'LINES', name: 'Lines',         target: 8,    achieved: 4,    unit: 'SKU', isPrimary: false },
];
const SHOP_B: ApiKpi[] = [
  { code: 'SALES', name: 'Monthly Sales', target: null, achieved: 2000, unit: 'INR', isPrimary: true  },
  { code: 'LINES', name: 'Lines',         target: 8,    achieved: 6,    unit: 'SKU', isPrimary: false },
];

afterEach(() => { vi.unstubAllGlobals(); identityRef.current = null; });

describe('partnerDashboardV2 ON', () => {
  it('MX1: mixed outlets — hero, card and trend request agree on the targeted-only figure', async () => {
    identityRef.current = identity(true);
    const fetchFn = stubFetch([SHOP_A, SHOP_B]);
    render(<PartnerDashboardPage />);

    const hero = await heroZone();
    expect(hero).toHaveTextContent('Monthly Sales');
    expect(hero).toHaveTextContent(/500\s*INR/);
    expect(hero).toHaveTextContent('of 1,000 INR');
    expect(hero).toHaveTextContent('50%');
    expect(hero).not.toHaveTextContent('250%');
    expect(await within(hero).findByTestId('hero-untargeted-SALES')).toHaveTextContent('+₹2K so far at outlets without this target');

    const card = await screen.findByTestId('target-achievement-card', {}, { timeout: 15000 });
    expect(await within(card).findByText('500/1K · 50%')).toBeInTheDocument();
    expect(await within(card).findByTestId('kpi-untargeted-SALES')).toHaveTextContent('+₹2K so far at outlets without this target');
    // The Performance card trends the SAME KPI (the API then applies the same targeted-only rule).
    await waitFor(() => expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/api/partner/targets/trend') && String(u).includes('kpi=SALES'))).toBe(true));
  }, 20000);

  it('MX2: a KPI missing ENTIRELY at outlet B is counted from outlet A only — no "+X" line', async () => {
    identityRef.current = identity(true);
    stubFetch([SHOP_A, [{ code: 'LINES', name: 'Lines', target: 8, achieved: 6, unit: 'SKU', isPrimary: false }]]);
    render(<PartnerDashboardPage />);

    const hero = await heroZone();
    expect(hero).toHaveTextContent('of 1,000 INR');
    expect(hero).toHaveTextContent('50%');
    expect(screen.queryByTestId('hero-untargeted-SALES')).not.toBeInTheDocument();
    const card = await screen.findByTestId('target-achievement-card', {}, { timeout: 15000 });
    expect(await within(card).findByText('500/1K · 50%')).toBeInTheDocument();
    expect(await within(card).findByText('10/16 SKU · 63%')).toBeInTheDocument();
    expect(within(card).queryByTestId('kpi-untargeted-SALES')).not.toBeInTheDocument();
  }, 20000);

  it('MX3: a target-less FLAGGED primary is never the hero headline — first KPI with a target is', async () => {
    identityRef.current = identity(true);
    stubFetch([[
      { code: 'NONADHO', name: 'NON ADHO', target: null, achieved: 2755.12, unit: 'INR', isPrimary: true  },
      { code: 'LINES',   name: 'Lines',    target: 8,    achieved: 4,       unit: 'SKU', isPrimary: false },
    ]]);
    render(<PartnerDashboardPage />);

    const hero = await heroZone();
    expect(hero).toHaveTextContent('Lines');
    expect(hero).toHaveTextContent('of 8 SKU');
    expect(hero).toHaveTextContent('50%');
    expect(hero).not.toHaveTextContent('NON ADHO');
    expect(hero).not.toHaveTextContent('of 0');
    const card = await screen.findByTestId('target-achievement-card', {}, { timeout: 15000 });
    expect(await within(card.querySelector('[data-testid="kpi-no-target-NONADHO"]') as HTMLElement).findByText('₹2.8K so far')).toBeInTheDocument();
  }, 20000);

  it('MX4: no KPI has a target → neutral "so far" hero, no %, bar or red', async () => {
    identityRef.current = identity(true, 'SSS');
    stubFetch([[
      { code: 'NONADHO', name: 'NON ADHO', target: 0,    achieved: 2755.12, unit: 'INR', isPrimary: true  },
      { code: 'FB',      name: 'Focus',    target: null, achieved: null,    unit: 'INR', isPrimary: false },
    ]]);
    render(<PartnerDashboardPage />);

    const hero = await screen.findByTestId('hero-no-target', {}, { timeout: 15000 });
    expect(hero).toHaveTextContent('NON ADHO');
    expect(hero).toHaveTextContent('₹2.8K so far');
    expect(hero).toHaveTextContent('No targets set this month');
    expect(hero.textContent).not.toMatch(/%|of 0|to go|remaining|days? left/);
    const card = await screen.findByTestId('target-achievement-card', {}, { timeout: 15000 });
    expect(await within(card).findByText('No targets set this month')).toBeInTheDocument();
  }, 20000);

  it('MX5: MT hero — target-less KPIs are neutral rows excluded from met/allMet; "+X" line for mixed outlets', async () => {
    identityRef.current = identity(true, 'SSS_TOT');
    stubFetch([
      [
        { code: 'LINES',   name: 'Lines',    target: 8,    achieved: 8,       unit: 'SKU', isPrimary: true  },
        { code: 'SALES',   name: 'Sales',    target: 1000, achieved: 1000,    unit: 'INR', isPrimary: false },
        { code: 'NONADHO', name: 'NON ADHO', target: null, achieved: 2755.12, unit: 'INR', isPrimary: false },
      ],
      [
        { code: 'SALES',   name: 'Sales',    target: null, achieved: 2000,    unit: 'INR', isPrimary: false },
      ],
    ]);
    render(<PartnerDashboardPage />);

    const row = await screen.findByTestId('mt-no-target-NONADHO', {}, { timeout: 15000 });
    expect(row).toHaveTextContent('₹2.8K so far');
    expect(row.textContent).not.toMatch(/%|Met|left/);
    expect(await screen.findByTestId('mt-untargeted-SALES')).toHaveTextContent('+₹2K so far at outlets without this target');
    // Both TARGETED KPIs are met (Sales on the targeted outlet only: 1,000/1,000) → all met.
    expect(await screen.findByText('All targets achieved 🎉')).toBeInTheDocument();
  }, 20000);
});

describe('partnerDashboardV2 OFF (Deoleo — unchanged)', () => {
  it('OFF1: mixed outlets → plain sums in the hero, no "+X" line, no card', async () => {
    identityRef.current = identity(false);
    const fetchFn = stubFetch([SHOP_A, SHOP_B]);
    render(<PartnerDashboardPage />);

    const hero = await heroZone();
    expect(hero).toHaveTextContent(/2,500\s*INR/);
    expect(hero).toHaveTextContent('of 1,000 INR');
    expect(hero).toHaveTextContent('250%');
    expect(document.body.textContent).not.toMatch(/outlets without this target|so far/);
    expect(screen.queryByTestId('target-achievement-card')).not.toBeInTheDocument();
    // The trend request fires in its own effect after the hero renders — wait for it (load flake 2026-11-16).
    await waitFor(() => expect(fetchFn.mock.calls.some(([u]) => String(u).includes('kpi=SALES'))).toBe(true));
  }, 20000);

  it('OFF2: target-less flagged primary → the old "0 of 0 · 0%" + "No targets yet" hero', async () => {
    identityRef.current = identity(false, 'SSS');
    stubFetch([[
      { code: 'NONADHO', name: 'NON ADHO', target: null, achieved: 2755, unit: 'INR', isPrimary: true  },
      { code: 'LINES',   name: 'Lines',    target: 8,    achieved: 4,    unit: 'SKU', isPrimary: false },
    ]]);
    render(<PartnerDashboardPage />);

    const hero = await heroZone();
    expect(hero).toHaveTextContent('NON ADHO');
    expect(hero).toHaveTextContent(/2,755\s*INR/);
    expect(hero).toHaveTextContent('of 0 INR');
    expect(hero).toHaveTextContent('0%');
    expect(hero).toHaveTextContent('No targets yet');
    expect(screen.queryByTestId('hero-no-target')).not.toBeInTheDocument();
  }, 20000);

  it('OFF3: MT hero scores the target-less KPI (0%) → never "All targets achieved"', async () => {
    identityRef.current = identity(false, 'SSS_TOT');
    stubFetch([[
      { code: 'LINES',   name: 'Lines',    target: 8,    achieved: 8,    unit: 'SKU', isPrimary: true  },
      { code: 'NONADHO', name: 'NON ADHO', target: null, achieved: 2755, unit: 'INR', isPrimary: false },
    ]]);
    render(<PartnerDashboardPage />);

    expect(await screen.findByText('2,755 of 0 INR', {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.queryByTestId('mt-no-target-NONADHO')).not.toBeInTheDocument();
    expect(screen.queryByText('All targets achieved 🎉')).not.toBeInTheDocument();
  }, 20000);
});
