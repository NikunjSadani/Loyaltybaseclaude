/// <reference types="vitest/globals" />
/**
 * MRP — Partner Rewards catalogue MRP-slash (per-tenant `catalogueMrpSlash`)
 *
 * The struck-through "list price" is now computed SERVER-SIDE (rate-INDEPENDENT:
 * pointsCost × mrpPaise ÷ sellingValuePaise) and delivered on each item as `slashPoints`.
 * The FE renders it when the flag is ON and the server sent a value — it NO LONGER derives
 * it from the conversion rate:
 *   MRP1: flag ON + server slashPoints present  → struck price shows (the server value)
 *   MRP2: flag OFF                              → no struck price (byte-identical to today)
 *   MRP3: slashPoints null                      → no struck price
 *   MRP4: server suppressed an inverted slash (slashPoints null) → no struck price
 *   MRP5: FREE_AMOUNT item (server slashPoints null) → no struck price
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

// A physical gift (default "Physical" tab): 500-pt redeem price with a server-computed
// slashPoints of 800 (rate-independent — the FE just renders it struck-through).
const PHYSICAL = {
  id: 'ph1',
  name: 'Bluetooth Headphones',
  brand: 'Sony',
  category: 'Electronics',
  pointsCost: 500,
  slashPoints: 800,          // computed + flag-gated server-side; member never receives mrpPaise
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
  it('MRP1: flag ON + server slashPoints present → shows the struck-through list price', async () => {
    stubFetch([PHYSICAL], true);
    render(<RewardsPage />);
    const card = await cardFor('Bluetooth Headphones');
    // The redeem price is always present…
    expect(card).toHaveTextContent('500 pts');
    // …and the server slashPoints (800) renders struck-through above it.
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

  it('MRP3: flag ON but server slashPoints null → no struck list price', async () => {
    stubFetch([{ ...PHYSICAL, slashPoints: null }], true);
    render(<RewardsPage />);
    const card = await cardFor('Bluetooth Headphones');
    expect(card).toHaveTextContent('500 pts');
    expect(screen.queryByText('800 pts')).not.toBeInTheDocument();
  });

  it('MRP4: flag ON but the server suppressed an inverted slash (slashPoints null) → no struck list price', async () => {
    // The server only returns slashPoints when strictly greater than the redeem price; an
    // inverted/equal pair comes back as null, so the FE shows nothing.
    stubFetch([{ ...PHYSICAL, slashPoints: null }], true);
    render(<RewardsPage />);
    const card = await cardFor('Bluetooth Headphones');
    expect(card).toHaveTextContent('500 pts');
    expect(screen.queryByText('800 pts')).not.toBeInTheDocument();
  });

  it('MRP5: flag ON but a FREE_AMOUNT item (server slashPoints null) → no struck list price', async () => {
    // A FREE_AMOUNT voucher (pointsCost 0) has NO fixed redeem anchor, so the server returns
    // slashPoints null for it.
    const freeAmount = {
      id: 'fa1',
      name: 'Flexi Voucher',
      brand: 'Flipkart',
      category: 'Vouchers',
      pointsCost: 0,
      slashPoints: null,
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
