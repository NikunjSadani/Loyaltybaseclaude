/// <reference types="vitest/globals" />
/**
 * PW — Partner wallet page API wiring (live data only)
 *
 * The wallet page now renders purely from the live wallet + transactions
 * endpoints — the localStorage redemption-store merge was removed in P5 5.5a.
 * Tests use the REAL API response shapes from /api/wallet and
 * /api/wallet/transactions (not the internal WalletBalance/WalletTransaction
 * shapes) to catch field-name mismatches at the boundary.
 *
 * PW1: fetch is called with /api/wallet
 * PW2: fetch is called with /api/wallet/transactions
 * PW3: transactions rendered from real API shape (transactionType/points/date)
 * PW4: balance rendered from real API shape (earnedPoints/redeemablePoints)
 * PW5: graceful fallback when fetch fails — page still renders its controls
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

// ── Real API shapes (from /api/wallet and /api/wallet/transactions) ──

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

import WalletPage from '../page';

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

describe('PW — Partner wallet API wiring (live data)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // ── Endpoint wiring ──────────────────────────────────────────────────────────

  it('PW1: fetch is called with /api/wallet endpoint (authenticated)', async () => {
    stubFetch();
    await renderWallet();
    // P0.5 W1A: the call now carries Authorization headers via authHeader().
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
      '/api/wallet',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('PW2: fetch is called with /api/wallet/transactions endpoint (authenticated)', async () => {
    stubFetch();
    await renderWallet();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
      '/api/wallet/transactions',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  // ── Real API shape mapping ───────────────────────────────────────────────────

  it('PW3: transactions from real API shape (transactionType/points/date) appear in the statement list', async () => {
    stubFetch();
    await renderWallet();
    const matches = await screen.findAllByText('API Monthly Target — May 2026');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('PW4: balance from real API shape (earnedPoints/redeemablePoints) is applied — not raw undefined', async () => {
    stubFetch();
    await renderWallet();
    // REAL_API_BALANCE.redeemablePoints = 50,000 — the live figure should be shown.
    await waitFor(() => {
      const balanceText = screen.getAllByText(/50[,.]?000/);
      expect(balanceText.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });

  // ── Error fallback ───────────────────────────────────────────────────────────

  it('PW5: graceful fallback when fetch fails — page controls still render', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    await renderWallet();
    expect(screen.queryByTestId('wallet-kpi-filter')).toBeInTheDocument();
  });
});
