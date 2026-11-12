/// <reference types="vitest/globals" />
/**
 * "This month's offers" placement on the partner dashboard (OFFER-TILES-PLAN F3), BOTH variants:
 *   v2 ON  → section after the Target Achievement card, before Quick actions.
 *   v2 OFF → section after the Target-vs-Achievement chart, before Quick actions.
 *   no tiles (either variant) → section absent.
 *   offerTiles flag OFF (Deoleo) → section never mounted, ZERO offers requests.
 * Run: npx vitest run src/app/partner/dashboard/__tests__/offers-placement.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import type { OfferTilePartner } from '@/lib/offers';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
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

const identityRef: { current: unknown } = { current: null };
vi.mock('@/lib/partner-identity', () => ({ usePartnerIdentity: () => identityRef.current }));

const offersRef: { current: OfferTilePartner[] } = { current: [] };
const fetchPartnerOffers = vi.fn(() => Promise.resolve(offersRef.current));
vi.mock('@/lib/offers', async (orig) => {
  const actual = await orig<typeof import('@/lib/offers')>();
  return { ...actual, fetchPartnerOffers: () => fetchPartnerOffers() };
});

import { istMonthKey } from '@/lib/ist-date';
import PartnerDashboardPage from '../page';

const CUR = istMonthKey(new Date());

function identity(v2: boolean, offerTiles = true) {
  return {
    businessName: 'Test Firm', outletName: 'Test Outlet', ownerName: 'Owner',
    partnerCode: 'P-1', outletType: 'WHOLESALER', hasPointsActivity: true,
    hasPayoutActivity: false, loyaltyEnabled: true,
    features: { partnerDashboardV2: v2, offerTiles },
    activePartnerId: null, operableOutlets: [], groupOverviewAvailable: false,
    groupParent: null, activeSelectorInvalid: false, loading: false,
  };
}

function stubFetch() {
  return vi.fn((url: string) => {
    if (url.includes('/api/partner/targets/trend')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {
        kpiName: 'Secondary Volume', unit: 'cases', trend: [{ month: CUR, target: 1000, achieved: 500 }] } }) });
    }
    if (url.includes('/api/partner/targets')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { period: CUR, outlets: [
        { outletCode: 'WS-1', outletName: 'Outlet 1', outletType: 'WHOLESALER',
          kpis: [{ code: 'SV', name: 'Secondary Volume', target: 1000, achieved: 500, unit: 'cases', pace: null, isPrimary: true }] },
      ] } }) });
    }
    if (url.includes('/api/wallet/points-credited')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { month: CUR, points: 0 } }) });
    }
    if (url.includes('/api/auth/me')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { user: { channelPartner: { wallets: [{ redeemablePoints: 10 }] } } } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ banners: [], popups: [] }) });
  });
}

const TILE: OfferTilePartner = {
  id: 't1', group: 'EXTRA_SCHEME', valueType: 'PERCENT', valueNumber: 2.5, valueText: null,
  unitLabel: 'extra margin', product: 'Olive Pomace 1 L', label: 'Festive bonus', details: null,
  validTo: '2026-11-30', progress: null,
};

const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
/** The Quick-actions "Support" link (last "Support" on the page). */
const quickActions = () => screen.getAllByRole('link', { name: /Support/ }).at(-1)!;

afterEach(() => {
  vi.unstubAllGlobals();
  identityRef.current = null;
  offersRef.current = [];
  fetchPartnerOffers.mockClear();
});

describe('Offers section placement', () => {
  it('v2 ON: renders after the Target Achievement card and before Quick actions', async () => {
    identityRef.current = identity(true);
    offersRef.current = [TILE];
    vi.stubGlobal('fetch', stubFetch());
    render(<PartnerDashboardPage />);

    const section = await screen.findByTestId('offers-section');
    const card = screen.getByTestId('target-achievement-card');
    expect(follows(card, section)).toBe(true);
    expect(follows(section, quickActions())).toBe(true);
  });

  it('v2 OFF: renders after the Target-vs-Achievement chart and before Quick actions', async () => {
    identityRef.current = identity(false);
    offersRef.current = [TILE];
    vi.stubGlobal('fetch', stubFetch());
    render(<PartnerDashboardPage />);

    const section = await screen.findByTestId('offers-section');
    const chart = screen.getByTestId('achievement-chart');
    expect(follows(chart, section)).toBe(true);
    expect(follows(section, quickActions())).toBe(true);
    expect(screen.queryByTestId('target-achievement-card')).not.toBeInTheDocument();
  });

  it.each([[true], [false]])('v2=%s with no tiles: section absent', async (v2) => {
    identityRef.current = identity(v2);
    offersRef.current = [];
    vi.stubGlobal('fetch', stubFetch());
    render(<PartnerDashboardPage />);
    await waitFor(() => expect(quickActions()).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('offers-section')).not.toBeInTheDocument();
  });

  it.each([[true], [false]])('v2=%s with offerTiles OFF: section never mounted, zero offers requests', async (v2) => {
    identityRef.current = identity(v2, false);
    offersRef.current = [TILE];
    const f = stubFetch();
    vi.stubGlobal('fetch', f);
    render(<PartnerDashboardPage />);
    await waitFor(() => expect(quickActions()).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('offers-section')).not.toBeInTheDocument();
    expect(fetchPartnerOffers).not.toHaveBeenCalled();
    for (const [url] of f.mock.calls) expect(String(url)).not.toContain('offers');
  });
});
