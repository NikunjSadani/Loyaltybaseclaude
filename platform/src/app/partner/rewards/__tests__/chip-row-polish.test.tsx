/// <reference types="vitest/globals" />
/**
 * POLISH — partner Rewards chip row on narrow screens (platform-wide).
 *
 * POLISH1: the horizontally-scrolling chip row sits in a `relative` wrapper with a decorative
 *          right-edge fade (data-testid="chip-row-fade", aria-hidden) hinting there is more to scroll.
 * POLISH2: selecting a category scrolls THAT chip into view with block/inline 'nearest'
 *          ('nearest' block so the page itself does not jump vertically).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

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

const ITEMS = [
  { id: 'l1', name: 'Travel Bag', brand: 'VIP', category: 'Luggage', categorySort: 2,
    pointsCost: 400, redemptionMode: 'PHYSICAL_GIFT', available: true, isAffordable: true },
  { id: 'e1', name: 'Bluetooth Headphones', brand: 'Sony', category: 'Electronics', categorySort: 1,
    pointsCost: 500, redemptionMode: 'PHYSICAL_GIFT', available: true, isAffordable: true },
];

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/rewards/catalog')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { items: ITEMS, userBalance: 50_000, pagination: { page: 1, limit: 20, total: ITEMS.length, pages: 1 } },
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

// jsdom does not implement scrollIntoView — install a mock we can inspect.
const originalScrollIntoView = Element.prototype.scrollIntoView;
let scrollIntoView: ReturnType<typeof vi.fn>;
beforeEach(() => {
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
});
afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

describe('POLISH — rewards chip row edge fade + keep the selected chip in view', () => {
  it('POLISH1: the chip row is wrapped in a relative container with a decorative right-edge fade', async () => {
    stubFetch();
    render(<RewardsPage />);
    const allChip = await screen.findByRole('button', { name: 'All' });

    const fade = screen.getByTestId('chip-row-fade');
    expect(fade).toHaveAttribute('aria-hidden', 'true');
    const wrapper = fade.parentElement as HTMLElement;
    expect(wrapper).toHaveClass('relative');
    // The scrolling chip row is the fade's sibling inside that same wrapper.
    expect(wrapper).toContainElement(allChip);
  });

  it('POLISH2: selecting a category scrolls that chip into view with block/inline "nearest"', async () => {
    stubFetch();
    render(<RewardsPage />);
    const user = userEvent.setup();
    const luggage = await screen.findByRole('button', { name: 'Luggage' });
    scrollIntoView.mockClear();

    await user.click(luggage);

    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest', inline: 'nearest' }));
    // The element scrolled is the chip the partner just selected.
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(luggage);
  });
});
