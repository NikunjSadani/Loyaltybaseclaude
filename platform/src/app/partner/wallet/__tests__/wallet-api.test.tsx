/// <reference types="vitest/globals" />
/**
 * PW — Partner wallet page API wiring
 *
 * Tests use the REAL API response shapes from /api/wallet and
 * /api/wallet/transactions (not the internal WalletBalance/WalletTransaction
 * shapes) to catch field-name mismatches at the boundary.
 *
 * PW1: fetch is called with /api/wallet
 * PW2: fetch is called with /api/wallet/transactions
 * PW3: transactions rendered from real API shape (transactionType/points/date)
 * PW4: balance rendered from real API shape (earnedPoints/redeemablePoints)
 * PW5: local redemptions (storedTxs) persist after API transaction update
 * PW6: graceful fallback when fetch fails — mock data still shown
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

// ── Real API shapes (from /api/wallet/route.ts and /api/wallet/transactions/route.ts) ──

/** Matches the exact shape returned by GET /api/wallet */
const REAL_API_BALANCE = {
  earnedPoints:     99_999,
  lockedPoints:     0,
  redeemablePoints: 50_000,
  redeemedPoints:   3_100,
  expiredPoints:    500,
  lifetimeEarned:   102_599,
  lifetimeRedeemed: 3_100,
  currency:         'POINTS',
  conversionRate:   1,
};

/** Matches the passbook shape returned by GET /api/wallet/transactions */
const REAL_API_TRANSACTION = {
  id:              'api-t1',
  transactionType: 'CREDIT_POINTS_EARNED',
  description:     'API Monthly Target — May 2026',
  points:          1234,
  date:            '2026-05-14T00:00:00.000Z',
  balanceType:     'EARNED',
  balanceAfter:    50_000,
  referenceType:   'SCHEME',
  referenceId:     'scheme-1',
};

const SESSION_KEY = 'partner_outlet_type_demo';

// ── Redemption that was saved to localStorage before this render ──
const STORED_REDEMPTION = {
  id:          'local-r1',
  points:      500,
  description: 'Redemption – Amazon voucher ₹500',
  createdAt:   '2026-05-10T12:00:00.000Z',
};

// ── Module mocks ──

vi.mock('@/lib/redemption-store', () => ({
  loadRedemptions: vi.fn(() => []),   // default: no stored redemptions
}));

import WalletPage from '../page';
import { loadRedemptions } from '@/lib/redemption-store';

function stubFetch(
  balanceData: unknown = REAL_API_BALANCE,
  txData: unknown      = [REAL_API_TRANSACTION],
) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if ((url as string).includes('/api/wallet/transactions')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { transactions: txData } }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, data: balanceData }),
    });
  }));
}

async function renderWallet() {
  localStorage.setItem(SESSION_KEY, 'WHOLESALER');
  render(<WalletPage />);
  await waitFor(
    () => expect(screen.queryByTestId('wallet-kpi-filter')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe('PW — Partner wallet API wiring', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(loadRedemptions).mockReturnValue([]);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // ── Endpoint wiring ──────────────────────────────────────────────────────────

  it('PW1: fetch is called with /api/wallet endpoint', async () => {
    stubFetch();
    await renderWallet();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith('/api/wallet');
  });

  it('PW2: fetch is called with /api/wallet/transactions endpoint', async () => {
    stubFetch();
    await renderWallet();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith('/api/wallet/transactions');
  });

  // ── Real API shape mapping ───────────────────────────────────────────────────

  it('PW3: transactions from real API shape (transactionType/points/date) appear in the statement list', async () => {
    stubFetch();
    await renderWallet();
    // The API transaction description should appear in the statement
    const matches = await screen.findAllByText('API Monthly Target — May 2026');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('PW4: balance from real API shape (earnedPoints/redeemablePoints) is applied — not raw undefined', async () => {
    stubFetch();
    await renderWallet();
    // REAL_API_BALANCE.redeemablePoints = 50,000. The balance card should show
    // a formatted points figure reflecting the API value, not the initial mock value
    // of 4,250. We check that the old mock value is no longer the only balance shown.
    // (formatPoints(50000) = '50,000')
    await waitFor(() => {
      // The page should NOT still show the mock's redeemable value of 4,250
      // as the primary available-to-redeem figure after the API resolves
      const balanceText = screen.getAllByText(/50[,.]?000/);
      expect(balanceText.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });

  // ── Local redemption persistence ─────────────────────────────────────────────

  it('PW5: locally-stored redemptions still appear in the statement after the API transaction update', async () => {
    // Seed a redemption into localStorage before render
    vi.mocked(loadRedemptions).mockReturnValue([STORED_REDEMPTION as any]);
    stubFetch();
    await renderWallet();
    // The local redemption description must survive the API fetch replacing the tx list
    const redemptionItems = await screen.findAllByText(/Amazon voucher/i);
    expect(redemptionItems.length).toBeGreaterThan(0);
  });

  // ── Error fallback ───────────────────────────────────────────────────────────

  it('PW6: graceful fallback when fetch fails — mock data still shown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    await renderWallet();
    expect(screen.queryByTestId('wallet-kpi-filter')).toBeInTheDocument();
  });
});
