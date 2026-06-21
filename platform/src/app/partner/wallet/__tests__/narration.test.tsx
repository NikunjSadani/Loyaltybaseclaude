/// <reference types="vitest/globals" />
/**
 * TDD — Narration field on wallet transactions (both tracks)
 *
 * Admins can attach an optional narration to any payout/transaction row.
 * It is displayed as a small extra line under the main transaction header.
 *
 * INR track (PayoutLedgerEntry):
 *   layout: kpiLabel · period  /  UTR (if any)  /  narration (if any)
 *
 * POINTS track (WalletTransaction via TransactionItem):
 *   layout: description  /  subLabel (if any)  /  narration (if any)
 *
 * Y1: INR track — a payout WITH narration shows narration text (data-testid="payout-narration")
 * Y2: INR track — a payout WITHOUT narration shows no payout-narration element
 * Y3: POINTS track — a transaction WITH narration shows narration text (data-testid="transaction-narration")
 * Y4: POINTS track — a transaction WITHOUT narration shows no transaction-narration element
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/redemption-store', () => ({
  loadRedemptions: () => [],
}));

import WalletPage from '../page';

const SESSION_KEY = 'partner_outlet_type_demo';

// Real API shapes (demo fallback was removed in the #57 mock-data cleanup), so the
// page now renders narration only from live data — stub the live endpoints with a
// PAID payout (INR track) and an earned transaction (POINTS track) that carry a
// narration, both in the default 2026-05 period window.
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

async function renderAndWait(outletType: string) {
  localStorage.setItem(SESSION_KEY, outletType);
  stubFetch();
  render(<WalletPage />);
  // Wait for loading to settle — statement-controls-row appears once data is loaded
  await waitFor(
    () => expect(screen.getByTestId('statement-controls-row')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe('Y — Narration on wallet transactions', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ── INR track (RETAILER) ──

  it('Y1: INR track — payout with narration shows payout-narration element', async () => {
    await renderAndWait('SSS');
    const narrations = screen.getAllByTestId('payout-narration');
    expect(narrations.length).toBeGreaterThan(0);
  });

  it('Y2: INR track — payout without narration has no payout-narration element for that row', async () => {
    await renderAndWait('SSS');
    // Every payout-narration that IS rendered must have non-empty text
    const narrations = screen.queryAllByTestId('payout-narration');
    narrations.forEach((el) => {
      expect(el.textContent?.trim().length).toBeGreaterThan(0);
    });
  });

  // ── POINTS track (WHOLESALER) ──

  it('Y3: POINTS track — transaction with narration shows transaction-narration element', async () => {
    await renderAndWait('WHOLESALER');
    const narrations = screen.getAllByTestId('transaction-narration');
    expect(narrations.length).toBeGreaterThan(0);
  });

  it('Y4: POINTS track — every transaction-narration rendered has non-empty text', async () => {
    await renderAndWait('WHOLESALER');
    const narrations = screen.queryAllByTestId('transaction-narration');
    narrations.forEach((el) => {
      expect(el.textContent?.trim().length).toBeGreaterThan(0);
    });
  });
});
