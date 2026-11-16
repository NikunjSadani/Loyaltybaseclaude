/// <reference types="vitest/globals" />
/**
 * PW — Partner wallet page API wiring (live data only)
 *
 * The wallet page now renders purely from the live wallet + statement
 * endpoints — the localStorage redemption-store merge was removed in P5 5.5a.
 * Tests use the REAL API response shapes from /api/wallet and
 * /api/wallet/statement (not the internal WalletBalance/WalletTransaction
 * shapes) to catch field-name mismatches at the boundary.
 *
 * The statement endpoint REPLACED the paginated /api/wallet/transactions (whose default
 * page was the newest 20 rows, so the screen + download were silently truncated).
 *
 * PW1: fetch is called with /api/wallet
 * PW2: fetch is called with /api/wallet/statement (and NOT /api/wallet/transactions)
 * PW3: transactions rendered from real API shape (transactionType/points/date)
 * PW4: balance rendered from real API shape (earnedPoints/redeemablePoints)
 * PW5: graceful fallback when fetch fails — page still renders its controls
 * PW7: a 25-row statement shows all 25 points rows (regression: the old 20-row page)
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

/** Matches a row of GET /api/wallet/statement (via the shared fixture builder). */
const REAL_API_TRANSACTION = {
  id:              'api-t1',
  transactionType: 'CREDIT_POINTS_EARNED',
  description:     'API Monthly Target — May 2026',
  points:          1234,
  date:            '2026-05-14T00:00:00.000Z',
  balanceAfter:    50_000,
  referenceType:   'SCHEME',
  referenceId:     'scheme-1',
};

// The wallet page reads the REAL points/payout presence signals from usePartnerIdentity
// (replaces the demo session). A points-active partner shows the points balance card;
// the combined statement below always renders regardless.
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Anil Traders', ownerName: 'Owner', partnerCode: 'P1',
    outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: false,
  }),
}));

import WalletPage from '../page';
import { statementPayload } from './statement-fixture';

function stubFetch(
  balanceData: unknown = REAL_API_BALANCE,
  txData: unknown      = [REAL_API_TRANSACTION],
) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if ((url as string).includes('/api/wallet/statement')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(statementPayload(txData as Parameters<typeof statementPayload>[0])),
      });
    }
    if ((url as string).includes('/api/partner/payouts')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { payouts: [] } }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, data: balanceData }),
    });
  }));
}

async function renderWallet() {
  render(<WalletPage />);
  expect(await screen.findByTestId('wallet-kpi-filter', {}, { timeout: 15_000 })).toBeInTheDocument();
}

describe('PW — Partner wallet API wiring (live data)', () => {
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

  it('PW2: fetch is called with /api/wallet/statement (authenticated), never the paginated /api/wallet/transactions', async () => {
    stubFetch();
    await renderWallet();
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
      '/api/wallet/statement',
      expect.objectContaining({ headers: expect.anything() }),
    );
    const urls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/api/wallet/transactions'))).toBe(false);
  });

  it('PW7: a 25-row statement shows all 25 points rows (the old passbook page stopped at 20)', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `t${i}`,
      transactionType: 'CREDIT_POINTS_EARNED',
      description: `Credit ${i}`,
      points: 10,
      date: new Date(Date.UTC(2026, 4, 1 + i, 6)).toISOString(),
      balanceAfter: (i + 1) * 10,
    }));
    stubFetch(REAL_API_BALANCE, rows);
    await renderWallet();
    await waitFor(() => expect(screen.getAllByTestId('transaction-item')).toHaveLength(25));
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
    }, { timeout: 15_000 });
  });

  // ── Error fallback ───────────────────────────────────────────────────────────

  it('PW5: graceful fallback when fetch fails — page controls still render, and the statement says it failed to load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    await renderWallet();
    expect(screen.queryByTestId('wallet-kpi-filter')).toBeInTheDocument();
    expect(await screen.findByTestId('statement-load-error')).toHaveTextContent(/couldn.t load your statement/i);
  });

  it('PW8: a statement error response shows an error state, never a silently empty statement', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/wallet/statement'))
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false, error: 'boom' }) });
      if (String(url).includes('/api/partner/payouts'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { payouts: [] } }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: REAL_API_BALANCE }) });
    }));
    await renderWallet();
    expect(await screen.findByTestId('statement-load-error')).toBeInTheDocument();
    expect(screen.queryByText(/No transactions for this period/i)).toBeNull();
  });

  it('PW9: a successful statement shows no load error', async () => {
    stubFetch();
    await renderWallet();
    expect(screen.queryByTestId('statement-load-error')).toBeNull();
  });

  // ── No mock/demo scaffolding (#57 mock-data removal) ──────────────────────────

  it('PW6: page source no longer imports demo-wallet-data or demo fallbacks', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.resolve(__dirname, '..', 'page.tsx'), 'utf8');
    expect(src).not.toMatch(/demo-wallet-data/);
    expect(src).not.toMatch(/isDemoSession|DEMO_WALLET_BALANCE|DEMO_POINTS_TRANSACTIONS|DEMO_INR_PAYOUTS/);
  });
});
