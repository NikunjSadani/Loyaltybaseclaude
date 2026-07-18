/// <reference types="vitest/globals" />
/**
 * TDD — Credit payouts surface in the wallet from generation (pending → paid)
 *
 * The wallet-surfacing fix unions credit payouts (CreditPayoutEntry) into the partner
 * payout history and shows them from generation, not only once paid:
 *   - a PENDING payout renders a statement row WITH a "Payout pending" badge
 *     (data-testid="payout-pending-badge") and its amount muted;
 *   - the "Lifetime Payout Received" card still counts ONLY paid entries, so a pending
 *     payout does NOT inflate the lifetime figure.
 *
 * Both fixtures sit in the default 2026-05 statement window so no date-picker
 * interaction is needed.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// A payout-active partner so the payout card + payout rows render.
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Anil Traders', ownerName: 'Owner', partnerCode: 'P1',
    outletType: 'WHOLESALER', hasPointsActivity: false, hasPayoutActivity: true,
  }),
}));

import WalletPage from '../page';

// ₹800 PAID + ₹400 still-PENDING, both in the default 2026-05 window.
const PAID_PAYOUT = {
  id: 'ce-paid', status: 'PAID', period: '2026-05', kpiLabel: 'Monthly Scheme',
  payoutAmountPaise: 80_000, uploadedAt: '2026-05-05T00:00:00.000Z',
  paidAt: '2026-05-20T00:00:00.000Z', utr: 'UTR-PAID',
};
const PENDING_PAYOUT = {
  id: 'ce-pending', status: 'PENDING', period: '2026-05', kpiLabel: 'Monthly Scheme',
  payoutAmountPaise: 40_000, uploadedAt: '2026-05-06T00:00:00.000Z',
};

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = url as string;
    if (u.includes('/api/wallet/transactions'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { transactions: [] } }) });
    if (u.includes('/api/partner/payouts'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { payouts: [PAID_PAYOUT, PENDING_PAYOUT] } }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
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

describe('PP — Pending credit payouts surface in the wallet', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('PP1: a PENDING payout renders a row with a "Payout pending" badge', async () => {
    await renderAndWait();
    const badges = await screen.findAllByTestId('payout-pending-badge');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0].textContent?.toLowerCase()).toContain('pending');
  });

  it('PP2: the lifetime payout card counts ONLY paid entries (pending excluded)', async () => {
    await renderAndWait();
    const card = await screen.findByTestId('payout-summary');
    // ₹800 paid shows; the ₹1,200 (paid+pending) sum must NOT appear as the lifetime figure.
    expect(card.textContent).toContain('₹800');
    expect(card.textContent).not.toContain('₹1,200');
  });
});
