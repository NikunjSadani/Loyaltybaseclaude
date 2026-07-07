/// <reference types="vitest/globals" />
/**
 * TDD — Narration field on wallet transactions (combined statement)
 *
 * Admins can attach an optional narration to any payout/transaction row. It is
 * displayed as a small extra line under the main row. The wallet now renders a
 * single COMBINED statement, so both a payout row and a points row appear together.
 *
 * Payout row (PayoutLedgerEntry):
 *   layout: kpiLabel · period  /  UTR (if any)  /  narration (data-testid="payout-narration")
 * Points row (WalletTransaction via TransactionItem):
 *   layout: description  /  subLabel (if any)  /  narration (data-testid="transaction-narration")
 *
 * Y1: a payout WITH narration shows a payout-narration element
 * Y2: every payout-narration rendered has non-empty text
 * Y3: a transaction WITH narration shows a transaction-narration element
 * Y4: every transaction-narration rendered has non-empty text
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// A BOTH-active partner so the combined statement shows points + payout rows together.
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Anil Traders', ownerName: 'Owner', partnerCode: 'P1',
    outletType: 'SSS', hasPointsActivity: true, hasPayoutActivity: true,
  }),
}));

import WalletPage from '../page';

// Real API shapes — the page renders narration only from live data. Stub the live
// endpoints with a PAID payout (payout row) and an earned transaction (points row)
// that both carry a narration, both in the default 2026-05 period window.
const PAYOUT_WITH_NARRATION = {
  id: 'p1', status: 'PAID', period: '2026-05', kpiLabel: 'Visibility Drive',
  payoutAmountPaise: 500_000, paidAt: '2026-05-10T00:00:00.000Z', utr: 'UTR123',
  narration: 'Store branding bonus',
};
const TX_WITH_NARRATION = {
  id: 'tx1', transactionType: 'CREDIT_POINTS_EARNED', description: 'Monthly Target — May 2026',
  points: 1000, date: '2026-05-10T00:00:00.000Z', balanceType: 'EARNED', balanceAfter: 1000,
  referenceType: 'SCHEME', referenceId: 's1', kpiLabel: 'Monthly Target',
  narration: 'Q1 performance bonus',
};
const BALANCE = {
  earnedPoints: 1000, lockedPoints: 0, redeemablePoints: 1000, redeemedPoints: 0,
  expiredPoints: 0, lifetimeEarned: 1000, lifetimeRedeemed: 0, currency: 'POINTS', conversionRate: 1,
};

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = url as string;
    if (u.includes('/api/wallet/transactions'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { transactions: [TX_WITH_NARRATION] } }) });
    if (u.includes('/api/partner/payouts'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { payouts: [PAYOUT_WITH_NARRATION] } }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: BALANCE }) });
  }));
}

async function renderAndWait() {
  stubFetch();
  render(<WalletPage />);
  await waitFor(
    () => expect(screen.getByTestId('statement-controls-row')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe('Y — Narration on the combined wallet statement', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('Y1: payout with narration shows a payout-narration element', async () => {
    await renderAndWait();
    const narrations = await screen.findAllByTestId('payout-narration');
    expect(narrations.length).toBeGreaterThan(0);
  });

  it('Y2: every payout-narration rendered has non-empty text', async () => {
    await renderAndWait();
    const narrations = screen.queryAllByTestId('payout-narration');
    narrations.forEach((el) => {
      expect(el.textContent?.trim().length).toBeGreaterThan(0);
    });
  });

  it('Y3: transaction with narration shows a transaction-narration element', async () => {
    await renderAndWait();
    const narrations = await screen.findAllByTestId('transaction-narration');
    expect(narrations.length).toBeGreaterThan(0);
  });

  it('Y4: every transaction-narration rendered has non-empty text', async () => {
    await renderAndWait();
    const narrations = screen.queryAllByTestId('transaction-narration');
    narrations.forEach((el) => {
      expect(el.textContent?.trim().length).toBeGreaterThan(0);
    });
  });
});
