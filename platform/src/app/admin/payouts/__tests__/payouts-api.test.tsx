/// <reference types="vitest/globals" />
/**
 * PAY — Admin Payouts page API wiring
 *
 * PAY1: shows loading spinner on mount
 * PAY2: renders batch code from API response
 * PAY3: renders transaction partner name from API response
 * PAY4: shows error message when fetch fails
 * PAY5/6: UTR upload result lists rows skipped by an overlapping upload (row number + reason)
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

/* UTR upload result: rows skipped because an overlapping upload already updated the payout
 * (compare-and-set loser) are listed per row with the sheet row number + reason. */
describe('PAY — UTR upload skipped rows', () => {
  function stubUtrFlow(applyData: unknown) {
    const submitted = [{ ...MOCK_BATCHES[0], status: 'SUBMITTED' }];
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      let body: unknown = { success: true, data: {} };
      if (u.includes('/utr?apply=true')) {
        body = { success: true, data: applyData };
      } else if (u.includes('/api/payouts/batches')) {
        body = { success: true, data: { batches: submitted, pagination: { page: 1, limit: 20, total: 1, pages: 1 } } };
      } else if (u.includes('/api/payouts/fund')) {
        body = { success: true, data: MOCK_FUND };
      } else if (u.includes('/api/payouts/transactions')) {
        body = { success: true, data: { transactions: MOCK_TRANSACTIONS, pagination: { page: 1, limit: 20, total: 1, pages: 1 } } };
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    }));
  }

  async function uploadFile() {
    render(<PayoutsPage />);
    await screen.findByText('Upload Filled UTR');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'utr.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText(/UTR applied:/);
  }

  it('PAY5: lists each skipped row (row number + reason) alongside the applied counts', async () => {
    stubUtrFlow({
      applied: true, paidCount: 1, failedCount: 0, reversedCount: 0,
      skipped: [
        { rowNum: 3, txnId: 'txn-a', outcome: 'FAILED', reason: 'Payout already updated by another upload' },
        { rowNum: 5, txnId: 'txn-c', outcome: 'PAID', reason: 'Payout already updated by another upload' },
      ],
    });
    await uploadFile();
    expect(screen.getByText(/UTR applied: 1 paid, 0 failed/)).toBeInTheDocument();
    const box = await screen.findByTestId('utr-skipped');
    expect(within(box).getByText('2 rows not applied')).toBeInTheDocument();
    const items = within(box).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'Row 3 (txn-a): Payout already updated by another upload',
      'Row 5 (txn-c): Payout already updated by another upload',
    ]);
  });

  it('PAY6: no skipped block when nothing was skipped (or an older API omits the field)', async () => {
    stubUtrFlow({ applied: true, paidCount: 2, failedCount: 1, reversedCount: 1 });
    await uploadFile();
    expect(screen.getByText(/UTR applied: 2 paid, 1 failed/)).toBeInTheDocument();
    expect(screen.queryByTestId('utr-skipped')).not.toBeInTheDocument();
  });
});
