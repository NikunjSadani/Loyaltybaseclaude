/// <reference types="vitest/globals" />
/**
 * HFI — Hero variant is keyed off the AUTHORITATIVE /partner/me identity, NOT the
 * unreliable denormalized target-upload string.
 *
 * Live bug: outlet OUT-2026-005 is authoritatively WHOLESALER (from /partner/me) with
 * redeemable points, but its target-upload row says "SSS". The dashboard used to pick
 * the hero from the targets response → rendered RetailerHero → the wholesaler lost the
 * "Available" points wallet zone. The fix sources outletType from usePartnerIdentity().
 *
 * HFI1: when usePartnerIdentity() → outletType 'WHOLESALER', the dashboard renders the
 *       WholesalerHero (the "Available" wallet zone + real points) EVEN THOUGH the
 *       /api/partner/targets response's outlets[0].outletType is 'SSS'.
 * HFI2: when usePartnerIdentity() → outletType 'SSS_TOT', the MT hero is still detected.
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

// Schemes card stays hidden (no eligible activations) so it doesn't interfere.
vi.mock('@/app/partner/schemes/portal-api', () => ({
  loadPortalSchemes: () => Promise.resolve([]),
  statusOf:          () => 'NOT_ENROLLED',
}));

// The hook under test — mocked per-test via the shared ref below.
const identityRef: { current: unknown } = { current: null };
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => identityRef.current,
}));

import PartnerDashboardPage from '../page';

/** A fully-shaped PartnerIdentity with the given outletType, resolved (loading:false). */
function identity(outletType: string | null) {
  return {
    businessName: 'Test Firm',
    outletName: 'Test Outlet',
    ownerName: 'Test Owner',
    partnerCode: 'P-1',
    outletType,
    hasPointsActivity: true,
    hasPayoutActivity: false,
    loyaltyEnabled: true,
    features: {},
    activePartnerId: null,
    operableOutlets: [],
    groupOverviewAvailable: false,
    groupParent: null,
    activeSelectorInvalid: false,
    loading: false,
  };
}

/**
 * Targets response whose denormalized outlet string DISAGREES with identity (says 'SSS').
 * Wallet returns 500 redeemable points (the live OUT-2026-005 case).
 */
function stubFetch() {
  return vi.fn((url: string) => {
    if (url.includes('/api/partner/targets')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: {
            period: '2026-10',
            outlets: [{
              outletCode: 'OUT-2026-005', outletName: 'Outlet 005',
              outletType: 'SSS', // ← WRONG upload string; must be IGNORED for hero selection
              kpis: [{ code: 'SV', name: 'Secondary Volume', target: 800, achieved: 400, pace: null, unit: 'cases', isPrimary: true }],
            }],
          },
        }),
      });
    }
    if (url.includes('/api/auth/me')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { user: { channelPartner: { wallets: [{ redeemablePoints: 500 }] } } } }),
      });
    }
    // /api/partner/me is consumed by the mocked hook, not fetch; everything else is noise.
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ banners: [], popups: [] }) });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  identityRef.current = null;
});

describe('HFI — hero keyed off authoritative /partner/me identity', () => {
  it('HFI1: WHOLESALER identity → WholesalerHero + Available zone, even when targets says SSS', async () => {
    identityRef.current = identity('WHOLESALER');
    vi.stubGlobal('fetch', stubFetch());

    render(<PartnerDashboardPage />);

    // WholesalerHero is the only hero with the "Available" wallet zone + a "Redeem" CTA.
    expect(await screen.findByText('Available')).toBeInTheDocument();
    expect(await screen.findByText('Redeem')).toBeInTheDocument();
    // The REAL redeemable points (500) render in that zone.
    expect(await screen.findByText('500')).toBeInTheDocument();
  });

  it('HFI2: SSS_TOT identity → MT hero detected (SSS TOT · KPI Tracker)', async () => {
    identityRef.current = identity('SSS_TOT');
    vi.stubGlobal('fetch', stubFetch());

    render(<PartnerDashboardPage />);

    expect(await screen.findByText('SSS TOT · KPI Tracker')).toBeInTheDocument();
    // MT hero has NO Available wallet zone.
    expect(screen.queryByText('Available')).not.toBeInTheDocument();
  });

  it('owner decision 2 (2026-11-19): the hero shows a negative balance as it is, with the note', async () => {
    identityRef.current = identity('WHOLESALER');
    const base = stubFetch();
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      url.includes('/api/auth/me')
        ? Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: { user: { channelPartner: { wallets: [{ redeemablePoints: -2986 }] } } } }),
          })
        : base(url),
    ));
    render(<PartnerDashboardPage />);
    expect((await screen.findByTestId('hero-available')).textContent).toBe('−2,986pts');
    expect(screen.getByTestId('hero-negative-note').textContent).toBe("You owe 2,986 pts — it's repaid from your next earnings.");
  });

  it('fix round 4 item 6: the hero uses the same signal as the wallet page — "from a reversed credit"', async () => {
    identityRef.current = identity('WHOLESALER');
    const base = stubFetch();
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      url.includes('/api/auth/me')
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { user: { channelPartner: { wallets: [{ redeemablePoints: -2986 }] } } } }) })
        : url === '/api/wallet'
          ? Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { owedFromReversal: true } }) })
          : base(url),
    ));
    render(<PartnerDashboardPage />);
    await waitFor(() =>
      expect(screen.getByTestId('hero-negative-note').textContent).toBe(
        "You owe 2,986 pts from a reversed credit — it's repaid from your next earnings.",
      ),
    );
  });
});
