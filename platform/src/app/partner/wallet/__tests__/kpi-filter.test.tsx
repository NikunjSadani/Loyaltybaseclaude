/// <reference types="vitest/globals" />
/**
 * TDD — KPI filter in partner wallet (POINTS track)
 *
 * Outlets want to filter their transaction history by a specific KPI
 * (e.g. "Monthly Sales Target" credits only, or "Visibility" credits only).
 *
 * Rules:
 *  - Filter is a <select> with data-testid="wallet-kpi-filter"
 *  - Options are derived from the kpiLabel values on transactions
 *    for the selected period (plus "All KPIs" as default)
 *  - Visibility KPI option appears only for RETAILER/MT outlets
 *    (those types are eligible for visibility incentives)
 *  - Selecting a KPI hides transactions with a different / null kpiLabel
 *  - Selecting "All KPIs" shows everything again
 *
 * W1: POINTS-track wallet has a data-testid="wallet-kpi-filter" select
 * W2: Dropdown has "All Parameters" + at least one KPI from transactions
 * W3: Selecting a KPI hides transactions with a different kpiLabel
 * W4: Selecting "All Parameters" restores all transactions
 * W5: WHOLESALER session has NO Visibility KPI option (not eligible)
 * W6: RETAILER session DOES have a Visibility KPI option
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/redemption-store', () => ({
  loadRedemptions: () => [],
}));

import WalletPage from '../page';

const SESSION_KEY = 'partner_outlet_type_demo';

// Real API data (the demo fallback was removed in the #57 cleanup). Provide, in the
// default 2026-05 window: a CREDIT with a kpiLabel (POINTS dropdown option, W2), a
// DEBIT redemption with no kpiLabel (W3 hide / W4 restore), and a PAID INR payout with
// a Visibility kpiLabel (RETAILER-only Visibility option, W6).
const POINTS_TXNS = [
  { id: 'tx1', transactionType: 'CREDIT_POINTS_EARNED', description: 'Monthly Target — May 2026',
    points: 1000, date: '2026-05-10T00:00:00.000Z', balanceType: 'EARNED', balanceAfter: 1000,
    referenceType: 'SCHEME', referenceId: 's1', kpiLabel: 'Monthly Target' },
  { id: 'tx2', transactionType: 'DEBIT_REDEMPTION', description: 'Redemption — Amazon Voucher',
    points: 500, date: '2026-05-12T00:00:00.000Z', balanceType: 'REDEEMED', balanceAfter: 500,
    referenceType: 'REDEMPTION', referenceId: 'r1', kpiLabel: null },
];
const INR_PAYOUTS = [
  { id: 'p1', status: 'PAID', period: '2026-05', kpiLabel: 'Visibility Drive',
    payoutAmountPaise: 500_000, paidAt: '2026-05-10T00:00:00.000Z', utr: 'UTR123', narration: null },
];
const BALANCE = {
  earnedPoints: 1000, lockedPoints: 0, redeemablePoints: 500, redeemedPoints: 500,
  expiredPoints: 0, lifetimeEarned: 1000, lifetimeRedeemed: 500, currency: 'POINTS', conversionRate: 1,
};

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = url as string;
    if (u.includes('/api/wallet/transactions'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { transactions: POINTS_TXNS } }) });
    if (u.includes('/api/partner/payouts'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { payouts: INR_PAYOUTS } }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: BALANCE }) });
  }));
}

describe('W — KPI filter in partner wallet (POINTS track)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Helper: render wallet and wait for spinner to clear (500ms load delay in page)
  async function renderWallet() {
    stubFetch();
    render(<WalletPage />);
    // The wallet has a 350-500ms load delay; wait for content
    await waitFor(
      () => expect(screen.queryByTestId('wallet-kpi-filter')).toBeInTheDocument(),
      { timeout: 3000 },
    );
  }

  it('W1: POINTS-track wallet shows a kpi-filter select', async () => {
    localStorage.setItem(SESSION_KEY, 'WHOLESALER');
    await renderWallet();
    const select = screen.getByTestId('wallet-kpi-filter');
    expect(select.tagName.toLowerCase()).toBe('select');
  });

  it('W2: dropdown has "All Parameters" + at least one KPI from transactions', async () => {
    localStorage.setItem(SESSION_KEY, 'WHOLESALER');
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '');
    expect(options.some(t => /all parameters/i.test(t))).toBe(true);
    expect(options.length).toBeGreaterThan(1);
  });

  it('W3: selecting a KPI hides transactions with a different kpiLabel', async () => {
    localStorage.setItem(SESSION_KEY, 'WHOLESALER');
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option'));
    const kpiOpt  = options.find(o => !/all parameters/i.test(o.textContent ?? ''));
    if (!kpiOpt) return;

    fireEvent.change(select, { target: { value: kpiOpt.value } });

    // Redemption entries have no kpiLabel — they should be hidden
    await waitFor(() => {
      const redemptions = screen
        .queryAllByText(/redemption.*amazon voucher/i)
        .filter(el => el.closest('[data-testid="transaction-item"]'));
      expect(redemptions.length).toBe(0);
    });
  });

  it('W4: selecting "All Parameters" restores all transactions', async () => {
    localStorage.setItem(SESSION_KEY, 'WHOLESALER');
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option'));
    const kpiOpt  = options.find(o => !/all parameters/i.test(o.textContent ?? ''));
    if (!kpiOpt) return;

    fireEvent.change(select, { target: { value: kpiOpt.value } });
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getByText(/redemption.*amazon voucher/i)).toBeInTheDocument();
    });
  });

  it('W5: WHOLESALER session has NO Visibility KPI option', async () => {
    localStorage.setItem(SESSION_KEY, 'WHOLESALER');
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '');
    expect(options.some(t => /visibility/i.test(t))).toBe(false);
  });

  it('W6: RETAILER session DOES have a Visibility KPI option', async () => {
    localStorage.setItem(SESSION_KEY, 'SSS');
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '');
    expect(options.some(t => /visibility/i.test(t))).toBe(true);
  });
});
