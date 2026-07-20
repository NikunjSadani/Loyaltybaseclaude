/// <reference types="vitest/globals" />
/**
 * PL — Sales outlet ledger: unified with the partner wallet (payout details + running
 * balance). The ledger now surfaces the outlet owner's ₹ payouts (amount + UTR + status)
 * interleaved with the points transactions, from the SAME shared backend builder.
 *
 *   PL1: a PAID payout row renders its ₹ amount, UTR and "kpiLabel · Month" header
 *   PL2: a non-PAID payout row shows the "Payout pending" badge
 *   PL3: the KPI filter lists both points field names AND payout KPI labels
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import OutletLedgerPage from '../page';

const TXS = [
  { id: 't1', date: '2026-05-05', description: 'Q1 push', type: 'credit', points: 300, balance: 300, ref: 'r1', fieldName: 'Monthly Scheme' },
];
const PAYOUTS = [
  // PAID credit payout — ₹5,000 with a UTR
  { id: 'p1', period: '2026-05', kpiLabel: 'Visibility', achievedPct: 100, payoutAmountPaise: 500000,
    uploadedAt: '2026-05-02T00:00:00.000Z', utr: 'UTR9', paidAt: '2026-05-10T00:00:00.000Z', status: 'PAID', narration: 'bank note' },
  // PENDING payout — no UTR yet
  { id: 'p2', period: '2026-05', kpiLabel: 'Incentive', achievedPct: 100, payoutAmountPaise: 250000,
    uploadedAt: '2026-05-03T00:00:00.000Z', status: 'PENDING' },
];

function stubLedger() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: () => Promise.resolve({
      success: true,
      data: {
        meta: { name: 'Verma Traders', outletCode: 'OUT-2026-00111', mobile: '9876543210', balance: 300, lifetime: 300, redeemed: 0 },
        transactions: TXS,
        payouts: PAYOUTS,
      },
    }),
  }));
}

async function renderLedger(id: string) {
  const params = Promise.resolve({ id });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <OutletLedgerPage params={params} />
      </Suspense>,
    );
    await params;
  });
  await waitFor(() => expect(screen.getByText('Verma Traders')).toBeInTheDocument());
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('PL — sales outlet ledger payout rows', () => {
  it('PL1: a PAID payout row renders its ₹ amount, UTR and header', async () => {
    stubLedger();
    await renderLedger('k1');
    expect(screen.getByText('Visibility · May 2026')).toBeInTheDocument();
    expect(screen.getByText('₹5,000')).toBeInTheDocument();
    expect(screen.getByText(/UTR9/)).toBeInTheDocument();
  });

  it('PL2: a non-PAID payout row shows the "Payout pending" badge', async () => {
    stubLedger();
    await renderLedger('k1');
    const badges = screen.getAllByTestId('payout-pending-badge');
    expect(badges.length).toBeGreaterThanOrEqual(1);
    // the pending ₹2,500 row is present
    expect(screen.getByText('₹2,500')).toBeInTheDocument();
  });

  it('PL3: the KPI filter lists points field names AND payout KPI labels', async () => {
    stubLedger();
    await renderLedger('k1');
    const select = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
    expect(options).toContain('Monthly Scheme'); // points field name
    expect(options).toContain('Visibility');       // payout KPI label
    expect(options).toContain('Incentive');        // payout KPI label
  });
});
