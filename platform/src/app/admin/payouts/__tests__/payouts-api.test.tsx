/// <reference types="vitest/globals" />
/**
 * PAY — Admin Payouts page API wiring
 *
 * PAY1: shows loading spinner on mount
 * PAY2: renders batch code from API response
 * PAY3: renders transaction partner name from API response
 * PAY4: shows error message when fetch fails
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import PayoutsPage from '../page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const MOCK_BATCHES = [
  {
    id: 'b1',
    batchCode: 'BAT-2026-05',
    status: 'DISBURSED',
    totalAmountPaise: 2840000,
    transactionCount: 10,
    payoutMode: 'BANK_TRANSFER',
    processedAt: '2026-05-02T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    _count: { transactions: 10 },
  },
];

const MOCK_TRANSACTIONS = [
  {
    id: 't1',
    payoutMode: 'BANK_TRANSFER',
    status: 'PROCESSED',
    amountPaise: 4850000,
    beneficiaryName: 'Test Partner',
    partner: { id: 'p1', businessName: 'K. Krishnamurthy & Sons' },
    batch: { id: 'b1', batchCode: 'BAT-2026-05' },
    providerRefId: 'ICIC325001234',
  },
];

const MOCK_FUND = {
  totalReceivedPaise:  10000000,
  totalUtilisedPaise:   4000000,
  closingBalancePaise:  6000000,
  availablePaise:       6000000,
};

/* URL-aware fetch stub matching the rewritten page: load() fetches batches + fund,
 * and a separate effect fetches transactions for the selected batch (?batchId=). */
function stubPayoutFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    let body: unknown = { success: true, data: {} };
    if (u.includes('/api/payouts/batches')) {
      body = { success: true, data: { batches: MOCK_BATCHES, pagination: { page: 1, limit: 20, total: 1, pages: 1 } } };
    } else if (u.includes('/api/payouts/fund')) {
      body = { success: true, data: MOCK_FUND };
    } else if (u.includes('/api/payouts/transactions')) {
      body = { success: true, data: { transactions: MOCK_TRANSACTIONS, pagination: { page: 1, limit: 20, total: 1, pages: 1 } } };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('PAY — Admin Payouts API wiring', () => {
  it('PAY1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<PayoutsPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('PAY2: renders batch code from API response', async () => {
    stubPayoutFetch();
    render(<PayoutsPage />);
    // The code legitimately renders in both the batch-list item and the selected
    // batch's detail header, so assert at least one occurrence.
    const matches = await screen.findAllByText('BAT-2026-05');
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('PAY3: renders transaction partner name from API response', async () => {
    stubPayoutFetch();
    render(<PayoutsPage />);
    expect(await screen.findByText('K. Krishnamurthy & Sons')).toBeInTheDocument();
  });

  it('PAY4: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<PayoutsPage />);
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });
});
