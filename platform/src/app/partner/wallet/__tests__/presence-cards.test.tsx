/// <reference types="vitest/globals" />
/**
 * TDD — Presence-based summary cards on the wallet (real data, not demo track)
 *
 * The wallet shows a summary card per REAL value type the partner holds:
 *   - hasPointsActivity → the POINTS balance card (data-testid via BalanceCard's copy)
 *   - hasPayoutActivity → the PAYOUT (INR) card (data-testid="payout-summary")
 *   - BOTH             → both cards
 * The combined statement below always renders regardless of the mix.
 *
 * PC1: a POINTS-only partner shows the points card, NOT the payout card
 * PC2: a PAYOUT-only partner shows the payout card, NOT the points card
 * PC3: a BOTH-active partner shows BOTH cards
 * PC4: the combined statement renders in every mix
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

let mockIdentity = {
  businessName: 'Anil Traders', ownerName: 'Owner', partnerCode: 'P1',
  outletType: 'WHOLESALER' as string | null, hasPointsActivity: true, hasPayoutActivity: false,
};
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => mockIdentity,
}));

import WalletPage from '../page';

const BALANCE = {
  earnedPoints: 4250, lockedPoints: 0, redeemablePoints: 4250, redeemedPoints: 0,
  expiredPoints: 0, lifetimeEarned: 8550, lifetimeRedeemed: 0, currency: 'POINTS', conversionRate: 1,
};
const TXNS = [
  { id: 'tx1', transactionType: 'CREDIT_POINTS_EARNED', description: 'Monthly Target — May 2026',
    points: 1000, date: '2026-05-10T00:00:00.000Z', balanceType: 'EARNED', balanceAfter: 1000,
    referenceType: 'SCHEME', referenceId: 's1', kpiLabel: 'Monthly Target' },
];
const PAYOUTS = [
  { id: 'p1', status: 'PAID', period: '2026-05', kpiLabel: 'Incentive',
    payoutAmountPaise: 1_200_000, paidAt: '2026-05-10T00:00:00.000Z', utr: 'UTR9', narration: null },
];

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = url as string;
    if (u.includes('/api/wallet/transactions'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { transactions: TXNS } }) });
    if (u.includes('/api/partner/payouts'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { payouts: PAYOUTS } }) });
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

describe('PC — presence-based summary cards', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('PC1: a POINTS-only partner shows the points card, not the payout card', async () => {
    mockIdentity = { ...mockIdentity, hasPointsActivity: true, hasPayoutActivity: false };
    await renderAndWait();
    // Points balance card copy is present; the payout summary card is not.
    expect(screen.getByText(/lifetime earned/i)).toBeInTheDocument();
    expect(screen.queryByTestId('payout-summary')).not.toBeInTheDocument();
  });

  it('PC2: a PAYOUT-only partner shows the payout card, not the points card', async () => {
    mockIdentity = { ...mockIdentity, outletType: 'SSS', hasPointsActivity: false, hasPayoutActivity: true };
    await renderAndWait();
    expect(screen.getByTestId('payout-summary')).toBeInTheDocument();
    expect(screen.queryByText(/lifetime earned/i)).not.toBeInTheDocument();
  });

  it('PC3: a BOTH-active partner shows both cards', async () => {
    mockIdentity = { ...mockIdentity, outletType: 'SSS', hasPointsActivity: true, hasPayoutActivity: true };
    await renderAndWait();
    expect(screen.getByText(/lifetime earned/i)).toBeInTheDocument();
    expect(screen.getByTestId('payout-summary')).toBeInTheDocument();
  });

  it('PC4: the combined statement renders in every mix', async () => {
    mockIdentity = { ...mockIdentity, hasPointsActivity: false, hasPayoutActivity: true };
    await renderAndWait();
    expect(screen.getByTestId('statement-controls-row')).toBeInTheDocument();
  });
});
