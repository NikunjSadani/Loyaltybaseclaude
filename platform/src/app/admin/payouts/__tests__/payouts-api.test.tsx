/// <reference types="vitest/globals" />
/**
 * PAY — Admin Payouts page API wiring
 *
 * PAY1: shows loading spinner on mount
 * PAY2: renders batch code from API response
 * PAY3: renders transaction partner name from API response
 * PAY4: shows error message when fetch fails
 * PAY8/9: Fund card reads GET /api/fund/summary; a failed load shows an inline error, not numbers
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

/* GET /api/fund/summary (fund reconciliation) — only the fields the Fund card reads. */
const MOCK_FUND = {
  totals: {
    openingPaise:    2000000,
    receiptsPaise:   8000000,
    committedPaise:  1500000,
    paidPaise:       2500000,
    balancePaise:    6000000,
  },
  lowBalance: { isLow: false, thresholdPaise: null },
};

/* URL-aware fetch stub matching the rewritten page: load() fetches batches + fund,
 * and a separate effect fetches transactions for the selected batch (?batchId=). */
function stubPayoutFetch() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    let body: unknown = { success: true, data: {} };
    if (u.includes('/api/payouts/batches')) {
      body = { success: true, data: { batches: MOCK_BATCHES, pagination: { page: 1, limit: 20, total: 1, pages: 1 } } };
    } else if (u.includes('/api/fund/summary')) {
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

  it('PAY8: Fund card shows balance / committed / paid / advance received from /api/fund/summary', async () => {
    stubPayoutFetch();
    render(<PayoutsPage />);
    const card = await screen.findByTestId('fund-card');
    expect(within(card).getByText('₹60,000.00')).toBeInTheDocument();   // balance
    expect(within(card).getByText('₹15,000.00')).toBeInTheDocument();   // committed
    expect(within(card).getByText('₹25,000.00')).toBeInTheDocument();   // paid out
    expect(within(card).getByText('₹1,00,000.00')).toBeInTheDocument(); // opening + receipts
    expect(within(card).getByRole('link', { name: /open fund reconciliation/i })).toHaveAttribute('href', '/admin/fund');
    const urls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/api/payouts/fund'))).toBe(false);
  });

  it('PAY9: a failed fund load shows an inline error and no fund numbers (batches still render)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/api/fund/summary')) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ success: false, error: 'Fund engine down' }) });
      }
      let body: unknown = { success: true, data: {} };
      if (u.includes('/api/payouts/batches')) {
        body = { success: true, data: { batches: MOCK_BATCHES, pagination: { page: 1, limit: 20, total: 1, pages: 1 } } };
      } else if (u.includes('/api/payouts/transactions')) {
        body = { success: true, data: { transactions: MOCK_TRANSACTIONS, pagination: { page: 1, limit: 20, total: 1, pages: 1 } } };
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    }));
    render(<PayoutsPage />);
    expect(await screen.findByText(/Fund balance unavailable: Fund engine down/)).toBeInTheDocument();
    expect(screen.queryByTestId('fund-card')).not.toBeInTheDocument();
    expect((await screen.findAllByText('BAT-2026-05')).length).toBeGreaterThanOrEqual(1);
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
      } else if (u.includes('/api/fund/summary')) {
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

  it('PAY-DUP: lists rows for already-paid transactions (possible double payment) and ignored columns', async () => {
    stubUtrFlow({
      applied: true, paidCount: 0, failedCount: 0, reversedCount: 0, offPlatformCount: 0,
      skipped: [], blockedOrders: [],
      alreadyPaid: [{ rowNum: 4, txnId: 'txn-z', notice: 'Already marked paid on 2026-11-09 (bank) — check for a double payment' }],
      warnings: ['Ignored columns (not recognised): "Paid outside platfrom (Y/N)"'],
    });
    await uploadFile();
    const box = await screen.findByTestId('utr-already-paid');
    expect(await within(box).findByText(/Already marked paid on 2026-11-09 \(bank\) — check for a double payment/)).toBeInTheDocument();
    expect(await within(box).findByText('Ignored columns (not recognised): "Paid outside platfrom (Y/N)"')).toBeInTheDocument();
  });

  it('PAY-NOCHG: "already recorded as failed" rows are shown neutrally (role=status), never in the red alert', async () => {
    stubUtrFlow({
      applied: true, paidCount: 0, failedCount: 0, reversedCount: 0, offPlatformCount: 0,
      skipped: [], blockedOrders: [], alreadyPaid: [], warnings: [],
      noChange: [{ rowNum: 3, txnId: 'txn-f', notice: 'Already recorded as failed — no change' }],
    });
    await uploadFile();
    const box = await screen.findByTestId('utr-no-change');
    expect(box).toHaveAttribute('role', 'status');
    expect(box.className).not.toMatch(/red/);
    expect(await within(box).findByText('1 row already up to date — nothing changed')).toBeInTheDocument();
    expect(await within(box).findByText(/Already recorded as failed — no change/)).toBeInTheDocument();
    expect(screen.queryByTestId('utr-already-paid')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('PAY-NOCHG-2: an older API response without noChange renders no neutral panel', async () => {
    stubUtrFlow({
      applied: true, paidCount: 1, failedCount: 0, reversedCount: 0, skipped: [], blockedOrders: [],
    });
    await uploadFile();
    expect(screen.queryByTestId('utr-no-change')).not.toBeInTheDocument();
  });

  it('PAY-OFF: shows how many PAID rows were recorded as paid outside the platform', async () => {
    stubUtrFlow({
      applied: true, paidCount: 3, failedCount: 1, reversedCount: 0, offPlatformCount: 2,
      skipped: [], blockedOrders: [],
    });
    await uploadFile();
    expect(
      screen.getByText('UTR applied: 3 paid (2 recorded as paid outside the platform), 1 failed.'),
    ).toBeInTheDocument();
  });

  it('PAY5: lists each skipped row (row number + reason) alongside the applied counts', async () => {
    stubUtrFlow({
      applied: true, paidCount: 1, failedCount: 0, reversedCount: 0,
      skipped: [
        { rowNum: 3, txnId: 'txn-a', outcome: 'FAILED', reason: 'Payout already updated by another upload' },
        { rowNum: 5, txnId: 'txn-c', outcome: 'PAID', reason: 'Payout already updated by another upload' },
      ],
    });
    await uploadFile();
    expect(await screen.findByText(/UTR applied: 1 paid, 0 failed/)).toBeInTheDocument();
    const box = await screen.findByTestId('utr-skipped');
    expect(await within(box).findByText('2 rows not applied')).toBeInTheDocument();
    const items = within(box).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'Row 3 (txn-a): Payout already updated by another upload',
      'Row 5 (txn-c): Payout already updated by another upload',
    ]);
  });

  it('PAY7: FAILED rows whose order holds a voucher code are listed as "not refunded" (order left unchanged)', async () => {
    stubUtrFlow({
      applied: true, paidCount: 0, failedCount: 1, reversedCount: 0, skipped: [],
      blockedOrders: [
        { rowNum: 4, txnId: 'txn-b', orderId: 'o9', orderNumber: 'RDM-9',
          reason: 'A voucher code is on this order — points not refunded and order left unchanged; needs ops review' },
      ],
    });
    await uploadFile();
    const box = await screen.findByTestId('utr-blocked-orders');
    expect(await within(box).findByText('1 order not refunded (voucher code on the order)')).toBeInTheDocument();
    expect(within(box).getByRole('listitem').textContent).toBe(
      'Row 4 (RDM-9): A voucher code is on this order — points not refunded and order left unchanged; needs ops review',
    );
    // No "rows not applied" header when only blocked orders are present.
    expect(screen.queryByText(/rows? not applied/)).not.toBeInTheDocument();
  });

  it('PAY6: no skipped block when nothing was skipped (or an older API omits the field)', async () => {
    stubUtrFlow({ applied: true, paidCount: 2, failedCount: 1, reversedCount: 1 });
    await uploadFile();
    expect(await screen.findByText(/UTR applied: 2 paid, 1 failed/)).toBeInTheDocument();
    expect(screen.queryByTestId('utr-skipped')).not.toBeInTheDocument();
  });
});
