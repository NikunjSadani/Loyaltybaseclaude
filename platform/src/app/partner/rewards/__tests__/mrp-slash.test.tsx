/// <reference types="vitest/globals" />
/**
 * MRP — Partner Rewards catalogue MRP-slash (per-tenant `catalogueMrpSlash`)
 *
 * The item's MRP (converted to points at the tenant rate, POINTS-PER-₹) renders as a
 * struck-through "list price" above the redeem price — but ONLY when it is honest:
 *   MRP1: flag ON + MRP-in-points > redeem price  → struck price shows
 *   MRP2: flag OFF                                 → no struck price (byte-identical to today)
 *   MRP3: mrpPaise null                            → no struck price
 *   MRP4: MRP-in-points <= redeem price (inverted) → no struck price (never equal/inverted)
 *   MRP5: FREE_AMOUNT / cash item (pointsCost 0)   → no struck price (no fixed redeem anchor)
 *
 * The redeem price (pointsCost) derives from the ₹ SELLING value, not MRP, so MRP-in-points is a
 * genuinely higher real anchor — the slash is truthful. effectiveRate falls back to the mocked
 * gifsy-settings pointsConversionRate (1) since /api/auth/me carries no conversionRate here.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

// Loyalty-enabled, points-active partner → reaches the catalogue.
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Kumar Store', ownerName: 'Rajesh', partnerCode: 'P1',
    outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: false,
    loyaltyEnabled: true,
  }),
}));

vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => ({
    pointsConversionRate: 1,            // POINTS-PER-₹ → ₹800 MRP = 800 pts
    minBankTransferAmount: 250,
    minVoucherFreeAmount: 250,
    redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
  }),
}));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), toast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import RewardsPage from '../page';

// A physical gift (default "Physical" tab): ₹800 MRP, 500-pt redeem price.
// At rate 1 → MRP-in-points = 800 > 500 → an honest slash.
const PHYSICAL = {
  id: 'ph1',
  name: 'Bluetooth Headphones',
  brand: 'Sony',
  category: 'Electronics',
  pointsCost: 500,
  mrpPaise: 80_000,          // ₹800
  redemptionMode: 'PHYSICAL_GIFT',
  available: true,
  isAffordable: true,
};

/** Build a fetch mock: catalogue items + a catalogueMrpSlash feature flag value. */
function stubFetch(items: unknown[], catalogueMrpSlash: boolean) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/rewards/catalog')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { items, userBalance: 50_000, pagination: { page: 1, limit: 20, total: items.length, pages: 1 } },
        }),
      });
    }
    if (url.includes('/api/partner/me')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { features: { catalogueMrpSlash } } }),
      });
    }
    // /api/auth/me and everything else: no conversionRate → effectiveRate falls back to 1.
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

/** The card element for a named item (the grid cell is a role="button"). */
async function cardFor(name: string) {
  const el = (await screen.findByText(name)).closest('[role="button"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

beforeEach(() => { pushMock.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('MRP — catalogue MRP-slash on the partner rewards grid card', () => {
  it('MRP1: flag ON + MRP-in-points > redeem price → shows the struck-through list price', async () => {
    stubFetch([PHYSICAL], true);
    render(<RewardsPage />);
    const card = await cardFor('Bluetooth Headphones');
    // The redeem price is always present…
    expect(card).toHaveTextContent('500 pts');
    // …and the MRP-in-points (₹800 × rate 1 = 800) renders struck-through above it.
    const struck = await screen.findByText('800 pts');
    expect(struck.className).toContain('line-through');
  });

  it('MRP2: flag OFF → no struck list price (unchanged from today)', async () => {
    stubFetch([PHYSICAL], false);
    render(<RewardsPage />);
    const card = await cardFor('Bluetooth Headphones');
    expect(card).toHaveTextContent('500 pts');
    expect(screen.queryByText('800 pts')).not.toBeInTheDocument();
  });

  it('MRP3: flag ON but mrpPaise null → no struck list price', async () => {
    stubFetch([{ ...PHYSICAL, mrpPaise: null }], true);
    render(<RewardsPage />);
    const card = await cardFor('Bluetooth Headphones');
    expect(card).toHaveTextContent('500 pts');
    expect(screen.queryByText('800 pts')).not.toBeInTheDocument();
  });

  it('MRP4: flag ON but MRP-in-points <= redeem price (inverted) → no struck list price', async () => {
    // ₹400 MRP at rate 1 = 400 pts, which is NOT strictly greater than the 500-pt redeem price.
    stubFetch([{ ...PHYSICAL, mrpPaise: 40_000 }], true);
    render(<RewardsPage />);
    const card = await cardFor('Bluetooth Headphones');
    expect(card).toHaveTextContent('500 pts');
    expect(screen.queryByText('400 pts')).not.toBeInTheDocument();
  });

  it('MRP5: flag ON but a FREE_AMOUNT / cash item (pointsCost 0) → no struck list price', async () => {
    // A FREE_AMOUNT voucher carries a (nonsensical) MRP but has NO fixed redeem anchor.
    const freeAmount = {
      id: 'fa1',
      name: 'Flexi Voucher',
      brand: 'Flipkart',
      category: 'Vouchers',
      pointsCost: 0,
      mrpPaise: 80_000,
      redemptionMode: 'GIFT_CARD',
      voucherType: 'FREE_AMOUNT',
      minRedemptionPoints: 250,
      maxRedemptionPoints: 10_000,
      available: true,
      isAffordable: true,
    };
    stubFetch([freeAmount], true);
    render(<RewardsPage />);
    const user = userEvent.setup();
    // FREE_AMOUNT vouchers live under the Vouchers tab.
    await user.click(await screen.findByRole('button', { name: /vouchers/i }));
    const card = await cardFor('Flexi Voucher');
    expect(card).toHaveTextContent('You set the amount');
    // No struck MRP anywhere on the card.
    expect(screen.queryByText('800 pts')).not.toBeInTheDocument();
  });
});
