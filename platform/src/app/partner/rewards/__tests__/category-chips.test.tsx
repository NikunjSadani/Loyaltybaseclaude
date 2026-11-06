/// <reference types="vitest/globals" />
/**
 * CHIP — Partner Rewards catalogue category chip row (dynamic ordering)
 *
 * The chip row is driven entirely by the RewardCategory names the tenant's physical
 * rewards are tagged with — there is NO hard-coded frontend whitelist. Chips are ordered
 * by each category's admin-set `sortOrder` (ascending, delivered as `categorySort` on each
 * catalogue item), then by name. 'All' is always first.
 *
 *   CHIP1: two physical items [{Luggage, sort 2}, {Electronics, sort 1}]
 *          → chip row renders ['All', 'Electronics', 'Luggage'] (sorted by sortOrder)
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

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

/** Build a fetch mock serving a fixed set of catalogue items. */
function stubFetch(items: unknown[]) {
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
        json: () => Promise.resolve({ success: true, data: { features: { catalogueMrpSlash: false } } }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('CHIP — dynamic category chip row on the partner rewards catalogue', () => {
  it('CHIP1: orders chips by the category sortOrder (Electronics sort 1 before Luggage sort 2)', async () => {
    // Deliberately list Luggage (sort 2) BEFORE Electronics (sort 1) in the payload — the
    // chip row must reorder them by sortOrder, not by arrival order.
    stubFetch([
      { id: 'l1', name: 'Travel Bag', brand: 'VIP', category: 'Luggage', categorySort: 2,
        pointsCost: 400, redemptionMode: 'PHYSICAL_GIFT', available: true, isAffordable: true },
      { id: 'e1', name: 'Bluetooth Headphones', brand: 'Sony', category: 'Electronics', categorySort: 1,
        pointsCost: 500, redemptionMode: 'PHYSICAL_GIFT', available: true, isAffordable: true },
    ]);
    render(<RewardsPage />);

    // The 'All' chip is unique to the category pill row — anchor on it, then read the
    // ordered chip labels from its container (dropping the leading "Within my points" filter chip).
    const allChip = await screen.findByRole('button', { name: 'All' });
    const pillRow = allChip.parentElement as HTMLElement;
    const chipLabels = Array.from(pillRow.querySelectorAll('button'))
      .map(b => b.textContent?.trim())
      .filter((t): t is string => !!t && t !== 'Within my points');

    expect(chipLabels).toEqual(['All', 'Electronics', 'Luggage']);
  });

  it('CHIP2: skips null/empty/whitespace-only category names (no blank chip)', async () => {
    // A physical item whose category is whitespace-only must NOT produce a chip.
    stubFetch([
      { id: 'e1', name: 'Bluetooth Headphones', brand: 'Sony', category: 'Electronics', categorySort: 1,
        pointsCost: 500, redemptionMode: 'PHYSICAL_GIFT', available: true, isAffordable: true },
      { id: 'w1', name: 'Mystery Item', brand: '', category: '   ', categorySort: 0,
        pointsCost: 300, redemptionMode: 'PHYSICAL_GIFT', available: true, isAffordable: true },
      { id: 'l1', name: 'Travel Bag', brand: 'VIP', category: 'Luggage', categorySort: 2,
        pointsCost: 400, redemptionMode: 'PHYSICAL_GIFT', available: true, isAffordable: true },
    ]);
    render(<RewardsPage />);

    const allChip = await screen.findByRole('button', { name: 'All' });
    const pillRow = allChip.parentElement as HTMLElement;
    const chipLabels = Array.from(pillRow.querySelectorAll('button'))
      .map(b => b.textContent?.trim())
      .filter((t): t is string => !!t && t !== 'Within my points');

    // Only the two real categories survive — the whitespace name is dropped, no blank chip.
    expect(chipLabels).toEqual(['All', 'Electronics', 'Luggage']);
  });
});
