/// <reference types="vitest/globals" />
/**
 * B2 (owner 2026-11-26): off-portal GIFT rows stay IN the Lifetime / Last-month payout figures, and each figure says
 * "includes ₹X Gift (off-portal)" so the rupee amount is never read as cash only. No gift → no line.
 * Run: npx vitest run src/components/wallet/__tests__/payout-summary-gift.test.tsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PayoutSummary } from '../outlet-wallet-view';
import type { PayoutLedgerEntry } from '@/types';

const cash: PayoutLedgerEntry = {
  id: 'c1', period: '2026-09', kpiLabel: 'Visibility', achievedPct: 100, payoutAmountPaise: 100_000,
  uploadedAt: '2026-09-05T00:00:00.000Z', paidAt: '2026-09-20T00:00:00.000Z', status: 'PAID', utr: 'U1',
};
const gift: PayoutLedgerEntry = {
  id: 'g1', period: '2026-10', kpiLabel: 'Gift (off-portal) — incentive', achievedPct: 100, payoutAmountPaise: 50_000,
  uploadedAt: '2026-10-25T00:00:00.000Z', paidAt: '2026-10-20T00:00:00.000Z', status: 'PAID', offPortal: true, gift: true,
};

describe('PayoutSummary — Gift (off-portal) stays in the totals, labelled', () => {
  it('lifetime includes the gift and says so; the latest (gift) month says so too', () => {
    render(<PayoutSummary payouts={[cash, gift]} />);
    expect(screen.getByText('₹1,500')).toBeInTheDocument(); // ₹1,000 cash + ₹500 gift — gift NOT removed
    expect(screen.getByTestId('payout-lifetime-gift')).toHaveTextContent('includes ₹500 Gift (off-portal)');
    expect(screen.getByTestId('payout-last-month-gift')).toHaveTextContent('includes ₹500 Gift (off-portal)');
  });

  it('latest month is cash → no last-month gift line; lifetime still names the gift', () => {
    render(<PayoutSummary payouts={[{ ...gift, period: '2026-08' }, cash]} />);
    expect(screen.getByTestId('payout-lifetime-gift')).toHaveTextContent('includes ₹500 Gift (off-portal)');
    expect(screen.queryByTestId('payout-last-month-gift')).toBeNull();
  });

  it('no gift rows → no gift lines', () => {
    render(<PayoutSummary payouts={[cash]} />);
    expect(screen.queryByTestId('payout-lifetime-gift')).toBeNull();
    expect(screen.queryByTestId('payout-last-month-gift')).toBeNull();
  });
});
