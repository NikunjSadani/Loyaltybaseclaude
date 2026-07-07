/// <reference types="vitest/globals" />
/**
 * TDD — KPI filter in the combined partner wallet statement
 *
 * The wallet renders ONE combined statement (points + payouts). Partners can filter
 * its history by a specific KPI/parameter label.
 *
 * Rules:
 *  - Filter is a <select> with data-testid="wallet-kpi-filter"
 *  - Options are derived from the kpiLabel values on the period's rows
 *    (points transactions AND payout entries), plus "All Parameters" as default
 *  - A KPI named exactly "Visibility" appears only for RETAILER/MT outlet types
 *    (SSS / SSS_TOT — those eligible for visibility incentives)
 *  - Selecting a KPI hides rows with a different / null kpiLabel
 *  - Selecting "All Parameters" shows everything again
 *
 * W1: the wallet shows a data-testid="wallet-kpi-filter" select
 * W2: dropdown has "All Parameters" + at least one KPI from the rows
 * W3: selecting a KPI hides rows with a different kpiLabel
 * W4: selecting "All Parameters" restores all rows
 * W5: a WHOLESALER outlet has NO exact "Visibility" KPI option (not eligible)
 * W6: an SSS outlet DOES have the "Visibility" KPI option
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// The Visibility-option gating keys off the REAL outlet type from usePartnerIdentity.
// `mockIdentity` is mutable so W5/W6 can flip the outlet type.
let mockIdentity = {
  businessName: 'Anil Traders', ownerName: 'Owner', partnerCode: 'P1',
  outletType: 'WHOLESALER' as string | null, hasPointsActivity: true, hasPayoutActivity: true,
};
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => mockIdentity,
}));

import WalletPage from '../page';

// Real API data. In the default 2026-05 window: a CREDIT with a kpiLabel (dropdown
// option, W2), a DEBIT redemption with no kpiLabel (W3 hide / W4 restore), and a PAID
// payout whose label is exactly "Visibility" (RETAILER-only option, W6).
const POINTS_TXNS = [
  // A credit row: the KPI filter keys on the resolved FIELD NAME (not the dead kpiLabel).
  { id: 'tx1', transactionType: 'CREDIT_POINTS_EARNED', description: 'Monthly Target — May 2026',
    points: 1000, date: '2026-05-10T00:00:00.000Z', balanceType: 'EARNED', balanceAfter: 1000,
    referenceType: 'CREDIT_BATCH', referenceId: 'b1', fieldName: 'Monthly Target' },
  // A redemption (non-credit) row: no field name → keeps its own header, no filter option.
  { id: 'tx2', transactionType: 'DEBIT_REDEMPTION', description: 'Redemption — Amazon Voucher',
    points: 500, date: '2026-05-12T00:00:00.000Z', balanceType: 'REDEEMED', balanceAfter: 500,
    referenceType: 'REDEMPTION', referenceId: 'r1', fieldName: null },
];
const INR_PAYOUTS = [
  { id: 'p1', status: 'PAID', period: '2026-05', kpiLabel: 'Visibility',
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

describe('W — KPI filter in the combined partner wallet statement', () => {
  beforeEach(() => {
    mockIdentity = {
      businessName: 'Anil Traders', ownerName: 'Owner', partnerCode: 'P1',
      outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: true,
    };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderWallet() {
    stubFetch();
    render(<WalletPage />);
    await waitFor(
      () => expect(screen.queryByTestId('wallet-kpi-filter')).toBeInTheDocument(),
      { timeout: 3000 },
    );
  }

  it('W1: the wallet shows a kpi-filter select', async () => {
    await renderWallet();
    const select = screen.getByTestId('wallet-kpi-filter');
    expect(select.tagName.toLowerCase()).toBe('select');
  });

  it('W2: dropdown has "All Parameters" + at least one KPI from the rows', async () => {
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '');
    expect(options.some(t => /all parameters/i.test(t))).toBe(true);
    expect(options.length).toBeGreaterThan(1);
  });

  it('W3: selecting a KPI hides rows with a different kpiLabel', async () => {
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    // Filter to "Monthly Target" — the redemption row (null label) must disappear.
    fireEvent.change(select, { target: { value: 'Monthly Target' } });

    await waitFor(() => {
      const redemptions = screen
        .queryAllByText(/redemption.*amazon voucher/i)
        .filter(el => el.closest('[data-testid="transaction-item"]'));
      expect(redemptions.length).toBe(0);
    });
  });

  it('W4: selecting "All Parameters" restores all rows', async () => {
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    fireEvent.change(select, { target: { value: 'Monthly Target' } });
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getByText(/redemption.*amazon voucher/i)).toBeInTheDocument();
    });
  });

  it('W5: WHOLESALER outlet has NO exact "Visibility" KPI option', async () => {
    mockIdentity = { ...mockIdentity, outletType: 'WHOLESALER' };
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '');
    expect(options.includes('Visibility')).toBe(false);
  });

  it('W6: SSS outlet DOES have the "Visibility" KPI option', async () => {
    mockIdentity = { ...mockIdentity, outletType: 'SSS' };
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '');
    expect(options.includes('Visibility')).toBe(true);
  });
});
