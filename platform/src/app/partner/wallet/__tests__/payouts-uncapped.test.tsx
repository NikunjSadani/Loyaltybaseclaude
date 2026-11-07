/// <reference types="vitest/globals" />
/**
 * fix/list-caps — the backend payout statement is no longer capped at 100 rows. The wallet must
 * render EVERY payout it receives and the Lifetime Payout card must sum ALL paid rows (it is
 * summed client-side from the list, so a capped list understated it).
 *
 * UC1: 130 payouts → the statement lists 130 entries (all rows reachable)
 * UC2: Lifetime Payout = Σ every PAID row (incl. the rows the old 100-cap dropped)
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Anil Traders', ownerName: 'Owner', partnerCode: 'P1',
    outletType: 'WHOLESALER', hasPointsActivity: false, hasPayoutActivity: true,
  }),
}));

import WalletPage from '../page';
import { statementPayload } from './statement-fixture';

// 130 PAID payouts of ₹100 each, newest-first, spread back one day apart from "now"
// (relative dates — never a hardcoded future date).
const N = 130;
const now = Date.now();
const PAYOUTS = Array.from({ length: N }, (_, i) => {
  const d = new Date(now - i * 86_400_000);
  const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return {
    id: `ce${i}`, status: 'PAID', period, kpiLabel: 'Monthly Scheme',
    payoutAmountPaise: 10_000, uploadedAt: d.toISOString(), paidAt: d.toISOString(), utr: `UTR${i}`,
  };
});

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/wallet/statement'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(statementPayload([])) });
    if (url.includes('/api/partner/payouts'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { payouts: PAYOUTS } }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('UC — wallet payouts are uncapped', () => {
  it('UC1: every payout row (more than 100) is listed in the statement', async () => {
    stubFetch();
    render(<WalletPage />);
    await waitFor(() => expect(screen.getByText(`${N} entries`)).toBeInTheDocument(), { timeout: 10_000 });
  }, 20_000);

  it('UC2: Lifetime Payout sums every PAID row (₹100 × 130 = ₹13,000)', async () => {
    stubFetch();
    render(<WalletPage />);
    const card = await screen.findByTestId('payout-summary', undefined, { timeout: 10_000 });
    expect(card.textContent).toContain('₹13,000');
  }, 20_000);
});
