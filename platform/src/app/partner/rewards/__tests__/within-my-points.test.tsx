/// <reference types="vitest/globals" />
/**
 * WMP — "Within my points" affordability filter chip on the partner Rewards page
 * (Physical AND Vouchers tabs, platform-wide).
 *
 * Settings mock: minVoucherFreeAmount ₹250 × rate 1 → a FREE_AMOUNT voucher needs 250 pts.
 * Affordability uses the shared isWithinPoints rule, NOT the backend `isAffordable` flag
 * (every fixture below sets isAffordable: true on purpose, so a regression to the backend
 * flag would show items that must be hidden).
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

const chipName = 'Within my points';

describe('WMP — "Within my points" filter chip', () => {
  it('WMP1: on the Physical tab the chip renders first in the chip row, before "All", and starts off', async () => {
    stubFetch(PHYSICAL, 1000);
    render(<RewardsPage />);
    const chip = await screen.findByRole('button', { name: chipName });
    const row = chip.parentElement as HTMLElement;
    const buttons = within(row).getAllByRole('button');
    const allChip = within(row).getByRole('button', { name: 'All' });
    expect(buttons[0]).toBe(chip);
    expect(buttons.indexOf(allChip)).toBeGreaterThan(0);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  it('WMP2: tapping it shows only physical items within the balance (exact balance included); tapping again restores all', async () => {
    stubFetch(PHYSICAL, 1000);
    render(<RewardsPage />);
    const user = userEvent.setup();
    const chip = await screen.findByRole('button', { name: chipName });
    expect(await screen.findByText('Smart Phone')).toBeInTheDocument();

    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Cabin Bag')).toBeInTheDocument();
    expect(screen.getByText('Earbuds')).toBeInTheDocument();
    expect(screen.queryByText('Trolley Set')).not.toBeInTheDocument();
    expect(screen.queryByText('Smart Phone')).not.toBeInTheDocument();

    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Trolley Set')).toBeInTheDocument();
    expect(screen.getByText('Smart Phone')).toBeInTheDocument();
  });

  it('WMP3: it combines with a category — chip ON + "Luggage" shows only affordable Luggage items', async () => {
    stubFetch(PHYSICAL, 1000);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: chipName }));
    await user.click(screen.getByRole('button', { name: 'Luggage' }));

    expect(screen.getByText('Cabin Bag')).toBeInTheDocument();
    expect(screen.queryByText('Trolley Set')).not.toBeInTheDocument();
    expect(screen.queryByText('Earbuds')).not.toBeInTheDocument();
    expect(screen.queryByText('Smart Phone')).not.toBeInTheDocument();
  });

  it('WMP4: on the Vouchers tab the chip renders alone (no category chips) and filters vouchers', async () => {
    stubFetch([...PHYSICAL, ...VOUCHERS], 1000);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await screen.findByText('Cabin Bag');
    await user.click(screen.getByRole('button', { name: /vouchers/i }));

    const chip = await screen.findByRole('button', { name: chipName });
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
    expect(within(chip.parentElement as HTMLElement).getAllByRole('button')).toEqual([chip]);

    expect(screen.getByText('Flight Voucher')).toBeInTheDocument();
    await user.click(chip);
    expect(screen.getByText('Coffee Voucher')).toBeInTheDocument();
    expect(screen.getByText('Shopping Card')).toBeInTheDocument(); // 1000 ≥ 250 minimum
    expect(screen.queryByText('Flight Voucher')).not.toBeInTheDocument();
  });

  it('WMP5: a FREE_AMOUNT voucher whose minimum exceeds the balance is hidden when ON', async () => {
    stubFetch(VOUCHERS, 200); // 200 < 250-pt minimum, though pointsCost is 0
    render(<RewardsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /vouchers/i }));
    expect(await screen.findByText('Shopping Card')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: chipName }));
    expect(screen.queryByText('Shopping Card')).not.toBeInTheDocument();
  });

  it('WMP6: when nothing is within points, the empty state says so and how to see everything', async () => {
    stubFetch(PHYSICAL, 0);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: chipName }));
    expect(screen.getByText('No items found')).toBeInTheDocument();
    expect(screen.getByText('Nothing within your points yet — turn off "Within my points" to see all rewards')).toBeInTheDocument();
    expect(screen.queryByText('Try a different search or category')).not.toBeInTheDocument();
  });

  it('WMP7: card dimming uses the shared rule — a FREE_AMOUNT card whose item minimum exceeds the balance shows "Need … more"', async () => {
    // Floor is ₹250 × 1 = 250 pts (500 balance clears it), but the item's own minimum is 1000.
    stubFetch([
      { id: 'v9', name: 'Premium Card', brand: 'Mall', category: 'Vouchers', pointsCost: 0,
        redemptionMode: 'GIFT_CARD', voucherType: 'FREE_AMOUNT', minRedemptionPoints: 1000,
        maxRedemptionPoints: 10_000, available: true, isAffordable: true },
    ], 500);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /vouchers/i }));
    expect(await screen.findByText('Premium Card')).toBeInTheDocument();
    expect(screen.getByText('Need 500 more')).toBeInTheDocument();
  });

  it('WMP8: affordability uses the LIVE conversion rate from /api/auth/me, not the cached settings rate', async () => {
    // Settings rate 1 → floor 250 pts (400 balance would clear it); live rate 2 → floor 500 pts.
    stubFetch([VOUCHERS[2]], 400, 2);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /vouchers/i }));
    expect(await screen.findByText('Need 100 more')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: chipName }));
    expect(screen.queryByText('Shopping Card')).not.toBeInTheDocument();
  });
});
