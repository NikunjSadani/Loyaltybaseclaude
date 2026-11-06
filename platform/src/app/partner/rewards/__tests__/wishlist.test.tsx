/// <reference types="vitest/globals" />
/**
 * WL — Partner Rewards persistent wishlist (backend-backed, all tenants, partner app)
 *
 * WL1: the wishlist Set is SEEDED from GET /api/rewards/wishlist `rewardIds` on load
 *      (the header "Wishlist (n)" pill reflects the seeded count).
 * WL2: toggling an item from the detail sheet calls POST (add) then DELETE (remove),
 *      applying the optimistic flip immediately.
 * WL2b: a REJECTED write reverts the optimistic flip and surfaces a toast.
 * WL3: there is NO Wishlist chip in the filter row — the header pill is the only Wishlist control.
 * WL4: the header "Wishlist (n)" pill shows the correct count; the first tap filters to wishlisted
 *      items, switches to the Physical tab and reads aria-pressed="true".
 * WL5: a second tap on the header pill turns the filter OFF (all items back, aria-pressed="false").
 *
 * Auth/header pattern: the page calls /api/rewards/* via the shared `api` helper (cookie
 * auth, no JS-readable token), exactly as the existing catalogue/redeem calls do — so the
 * fetch mock keys purely on URL + method.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

// ── Module mocks ──

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

// Toast: capture error() calls so we can assert the surfaced failure message.
const toastError = vi.fn();
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn(), toast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import RewardsPage from '../page';

// ── Two physical catalogue items (default "Physical" tab) ──
const PH1 = {
  id: 'ph1', name: 'Alpha Headphones', brand: 'Sony', category: 'Electronics',
  pointsCost: 500, redemptionMode: 'PHYSICAL_GIFT', available: true, isAffordable: true,
};
const PH2 = {
  id: 'ph2', name: 'Beta Speaker', brand: 'JBL', category: 'Electronics',
  pointsCost: 400, redemptionMode: 'PHYSICAL_GIFT', available: true, isAffordable: true,
};

/** Toggle: when true, every wishlist write (POST/DELETE) responds 500. */
let writeShouldFail = false;

/**
 * Build a fetch mock keyed on URL + method, and return the array of recorded
 * wishlist calls so a test can assert the method/body of each write.
 */
function stubFetch(rewardIds: string[] = []) {
  const wishlistCalls: Array<{ method: string; url: string; body?: string }> = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init: RequestInit = {}) => {
    const method = (init.method as string) ?? 'GET';
    // Order matters: the specific /wishlist path must be checked before /catalog.
    if (url.includes('/api/rewards/wishlist')) {
      wishlistCalls.push({ method, url, body: init.body as string | undefined });
      if (method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { items: [], rewardIds } }),
        });
      }
      // POST (add) / DELETE (remove)
      if (writeShouldFail) {
        return Promise.resolve({
          ok: false, status: 500,
          json: () => Promise.resolve({ success: false, error: 'Wishlist save failed' }),
        });
      }
      const rewardId = method === 'POST'
        ? JSON.parse(init.body as string).rewardId
        : url.split('/').pop();
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { success: true, wishlisted: method === 'POST', rewardId } }),
      });
    }
    if (url.includes('/api/rewards/catalog')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { items: [PH1, PH2], userBalance: 50_000, pagination: { page: 1, limit: 20, total: 2, pages: 1 } },
        }),
      });
    }
    if (url.includes('/api/partner/me')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { features: {} } }) });
    }
    // /api/auth/me and anything else.
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
  return wishlistCalls;
}

beforeEach(() => { pushMock.mockClear(); toastError.mockClear(); writeShouldFail = false; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('WL — persistent partner wishlist', () => {
  it('WL1: seeds the Set from GET /api/rewards/wishlist rewardIds on load', async () => {
    stubFetch(['ph1']);
    render(<RewardsPage />);
    // The header pill reflects the seeded count (aria-label carries the number).
    expect(await screen.findByRole('button', { name: /wishlist, 1 item/i })).toBeInTheDocument();
    // And the seeded item's detail-sheet heart reads as already wishlisted.
    const user = userEvent.setup();
    await user.click(await screen.findByText('Alpha Headphones'));
    expect(await screen.findByRole('button', { name: /remove from wishlist/i })).toBeInTheDocument();
  });

  it('WL2: toggling calls POST (add) then DELETE (remove) with the optimistic flip applied', async () => {
    const calls = stubFetch([]); // nothing wishlisted at start
    render(<RewardsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByText('Alpha Headphones'));

    // Add → optimistic flip to "Remove from wishlist" + a POST with the rewardId.
    await user.click(await screen.findByRole('button', { name: /add to wishlist/i }));
    expect(await screen.findByRole('button', { name: /remove from wishlist/i })).toBeInTheDocument();
    await waitFor(() => {
      const post = calls.find(c => c.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(post!.body as string)).toEqual({ rewardId: 'ph1' });
    });

    // Remove → optimistic flip back to "Add to wishlist" + a DELETE on /wishlist/ph1.
    await user.click(await screen.findByRole('button', { name: /remove from wishlist/i }));
    expect(await screen.findByRole('button', { name: /add to wishlist/i })).toBeInTheDocument();
    await waitFor(() => {
      const del = calls.find(c => c.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(del!.url).toMatch(/\/api\/rewards\/wishlist\/ph1$/);
    });
  });

  it('WL2b: a rejected write reverts the optimistic flip and surfaces a toast', async () => {
    writeShouldFail = true;
    stubFetch([]);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByText('Alpha Headphones'));

    await user.click(await screen.findByRole('button', { name: /add to wishlist/i }));
    // The failed POST reverts the Set → the heart is back to "Add to wishlist" and a toast fired.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Wishlist save failed'));
    expect(await screen.findByRole('button', { name: /add to wishlist/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove from wishlist/i })).not.toBeInTheDocument();
  });

  it('WL3: the filter row has no Wishlist chip — only the header pill carries the Wishlist name', async () => {
    stubFetch(['ph1']);
    render(<RewardsPage />);
    expect(await screen.findByText('Alpha Headphones')).toBeInTheDocument();
    // Exactly one control whose accessible name starts with "Wishlist": the header pill.
    const wishlistButtons = screen.getAllByRole('button', { name: /^wishlist/i });
    expect(wishlistButtons).toHaveLength(1);
    expect(wishlistButtons[0]).toHaveAccessibleName(/wishlist, 1 item/i);
  });

  it('WL4: the header Wishlist (n) pill shows the count; first tap filters, switches to Physical and is pressed', async () => {
    stubFetch(['ph1']); // only ph1 wishlisted → count 1
    render(<RewardsPage />);
    const user = userEvent.setup();
    expect(await screen.findByText('Beta Speaker')).toBeInTheDocument();
    // Start from the Vouchers tab so we can see the pill switch back to Physical.
    await user.click(screen.getByRole('button', { name: /vouchers/i }));
    expect(screen.queryByText('Beta Speaker')).not.toBeInTheDocument();

    // The pill carries the seeded count and starts un-pressed.
    const pill = screen.getByRole('button', { name: /wishlist, 1 item/i });
    expect(pill).toHaveAttribute('aria-pressed', 'false');
    await user.click(pill);

    // Activating the pill filters to wishlisted-only on the Physical (catalogue) tab.
    expect(pill).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByPlaceholderText('Search rewards…')).toBeInTheDocument();
    expect(screen.getByText('Alpha Headphones')).toBeInTheDocument();
    expect(screen.queryByText('Beta Speaker')).not.toBeInTheDocument();
  });

  it('WL5: a second tap on the header pill turns the filter off and brings every item back', async () => {
    stubFetch(['ph1']);
    render(<RewardsPage />);
    const user = userEvent.setup();
    expect(await screen.findByText('Beta Speaker')).toBeInTheDocument();
    const pill = await screen.findByRole('button', { name: /wishlist, 1 item/i });

    await user.click(pill);
    expect(screen.queryByText('Beta Speaker')).not.toBeInTheDocument();

    await user.click(pill);
    expect(pill).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Alpha Headphones')).toBeInTheDocument();
    expect(screen.getByText('Beta Speaker')).toBeInTheDocument();
  });
});
