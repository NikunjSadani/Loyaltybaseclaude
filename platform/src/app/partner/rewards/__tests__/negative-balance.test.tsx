/// <reference types="vitest/globals" />
/**
 * Owner decision 2 (2026-11-19 — the retailer sees a negative balance as it is): the rewards page shows the balance
 * as it is ("−2,986 pts") with NO ₹ value and no negative "max" / "need N more" hints — "Not available while your
 * balance is negative" instead. A balance at 0 or above is unchanged.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Kumar Store', ownerName: 'Rajesh', partnerCode: 'P1',
    outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: false,
    loyaltyEnabled: true,
  }),
}));

vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => ({
    pointsConversionRate: 1,
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

const phys = (id: string, name: string, category: string, categorySort: number, pointsCost: number) => ({
  id, name, brand: 'B', category, categorySort, pointsCost,
  redemptionMode: 'PHYSICAL_GIFT', available: true, isAffordable: true,
});

const PHYSICAL = [
  phys('l1', 'Cabin Bag',      'Luggage',     2, 400),   // affordable
  phys('l2', 'Trolley Set',    'Luggage',     2, 1500),  // too dear
  phys('e1', 'Earbuds',        'Electronics', 1, 1000),  // exactly the balance → affordable
  phys('e2', 'Smart Phone',    'Electronics', 1, 5000),  // too dear
];

const VOUCHERS = [
  { id: 'v1', name: 'Coffee Voucher', brand: 'Cafe', category: 'Vouchers', pointsCost: 500,
    redemptionMode: 'GIFT_CARD', voucherType: 'FIXED', fixedAmount: 500, available: true, isAffordable: true },
  { id: 'v2', name: 'Flight Voucher', brand: 'Air', category: 'Vouchers', pointsCost: 2000,
    redemptionMode: 'GIFT_CARD', voucherType: 'FIXED', fixedAmount: 2000, available: true, isAffordable: true },
  // FREE_AMOUNT: pointsCost 0, but the ₹250 minimum needs 250 pts.
  { id: 'v3', name: 'Shopping Card', brand: 'Mall', category: 'Vouchers', pointsCost: 0,
    redemptionMode: 'GIFT_CARD', voucherType: 'FREE_AMOUNT', minRedemptionPoints: 250,
    maxRedemptionPoints: 10_000, available: true, isAffordable: true },
];

/** `liveRate` — the conversionRate served by /api/auth/me (the page's live effectiveRate). */
function stubFetch(items: unknown[], userBalance: number, liveRate?: number) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/auth/me') && liveRate !== undefined) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { conversionRate: liveRate } }),
      });
    }
    if (url.includes('/api/rewards/catalog')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { items, userBalance, pagination: { page: 1, limit: 20, total: items.length, pages: 1 } },
        }),
      });
    }
    if (url.includes('/api/partner/me')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { features: { catalogueMrpSlash: false } } }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('Rewards page — negative balance (owner decision 2, 2026-11-19)', () => {
  it('header shows "−2,986 pts" and "Not available while your balance is negative" — never a ₹ value', async () => {
    stubFetch(PHYSICAL, -2986, 1);
    render(<RewardsPage />);
    expect((await screen.findByTestId('rewards-balance')).textContent).toBe('−2,986 pts');
    expect(screen.getByTestId('rewards-balance-negative').textContent).toBe('Not available while your balance is negative');
    expect(document.body.textContent).not.toMatch(/₹-|₹−|-2,986|max ₹-/);
    // catalogue tiles say the same instead of "Need 3,386 more pts"
    expect((await screen.findAllByText('Not available while your balance is negative')).length).toBeGreaterThan(1);
    expect(screen.queryByText(/Need [\d,]+ more/)).not.toBeInTheDocument();
  });

  it('a balance at 0 or above is unchanged (₹ value shown, "Need N more" kept)', async () => {
    stubFetch(PHYSICAL, 1000, 1);
    render(<RewardsPage />);
    expect((await screen.findByTestId('rewards-balance')).textContent).toBe('1,000 pts');
    expect(screen.queryByTestId('rewards-balance-negative')).not.toBeInTheDocument();
    expect(await screen.findAllByText(/Need [\d,]+ more/)).not.toHaveLength(0);
  });
});
