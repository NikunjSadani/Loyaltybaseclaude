/// <reference types="vitest/globals" />
/**
 * STK — Reward stock history (owner 2026-11-26, all clients)
 *
 * STK1: the panel shows the baseline opening (labelled "baseline at go-live of stock history"), redeemed / returned /
 *       adjusted / current, and every movement with who / when / order (order link for a Gifsy admin)
 * STK2: order numbers are plain text when the viewer cannot open the Gifsy order console
 * STK3: Download fetches the .xlsx export of THIS reward
 * STK4: an unreadable / failed reply shows an error with Try again — never a blank or a crash
 * STK5: open pre-release reviews are called out in the panel
 * STK6: the review banner lists orders whose stock was NOT auto-returned; Return posts RETURN
 * STK7: Keep as is requires a note, then posts KEEP with it
 * STK8: no open reviews → no banner
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { StockHistoryPanel, StockReviewBanner, type StockHistory } from '../stock-history';

function jsonRes(data: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, statusText: ok ? 'OK' : 'Error', json: () => Promise.resolve(ok ? { success: true, data } : { success: false, error: data }) });
}

const HISTORY: StockHistory = {
  reward: { id: 'r1', code: 'AMZ500', name: 'Amazon 500', status: 'ACTIVE', stockQuantity: 9, deleted: false },
  summary: {
    opening: 10, openingAt: '2026-11-26T04:30:00.000Z', openingIsBaseline: true,
    redeemed: 3, returned: 1, adjusted: 1, current: 9, historyStartedAt: '2026-11-26T04:30:00.000Z',
  },
  movements: [
    { id: 'm4', type: 'ADJUSTED', isBaseline: false, quantity: 1, balanceAfter: 9, orderId: null, orderNumber: null, reason: 'Stock changed 8 → 9 (catalogue edit)', actorId: 'u1', actorName: 'Asha Admin', createdAt: '2026-11-27T06:00:00.000Z' },
    { id: 'm3', type: 'RETURNED', isBaseline: false, quantity: 1, balanceAfter: 8, orderId: 'o2', orderNumber: 'BAJ-2', reason: 'Order BAJ-2 cancelled', actorId: 'u1', actorName: 'Asha Admin', createdAt: '2026-11-27T05:00:00.000Z' },
    { id: 'm2', type: 'REDEEMED', isBaseline: false, quantity: -3, balanceAfter: 7, orderId: 'o1', orderNumber: 'BAJ-1', reason: 'Redeemed on order BAJ-1', actorId: 'p1', actorName: 'Ravi Retailer', createdAt: '2026-11-27T04:00:00.000Z' },
    { id: 'm1', type: 'OPENING', isBaseline: true, quantity: 10, balanceAfter: 10, orderId: null, orderNumber: null, reason: 'Baseline at go-live of stock history', actorId: null, actorName: null, createdAt: '2026-11-26T04:30:00.000Z' },
  ],
  total: 4,
  truncated: false,
  canOpenOrder: true,
  pendingReviews: [],
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('STK — StockHistoryPanel', () => {
  it('STK1: summary + baseline label + every movement with who / when / order link', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonRes(HISTORY)));
    render(<StockHistoryPanel rewardId="r1" />);
    expect(await screen.findByText('Opening (baseline at go-live)')).toBeInTheDocument();
    expect(screen.getByText(/Stock history started on/)).toBeInTheDocument();
    // Tiles: opening 10 · redeemed 3 · returned 1 · adjusted +1 · current 9
    for (const [label, value] of [['Redeemed', '3'], ['Returned', '1'], ['Adjusted (net)', '+1'], ['Current', '9']]) {
      const tile = screen.getAllByText(label).find((el) => el.tagName === 'P')!.parentElement!;
      expect(within(tile).getByText(value)).toBeInTheDocument();
    }
    const table = screen.getByRole('table');
    expect(within(table).getByText('Opening (baseline at go-live of stock history)')).toBeInTheDocument();
    expect(within(table).getByText('System (go-live baseline)')).toBeInTheDocument();
    expect(within(table).getByText('−3')).toBeInTheDocument();
    expect(within(table).getAllByText('Asha Admin')).toHaveLength(2);
    expect(within(table).getByRole('link', { name: 'BAJ-1' })).toHaveAttribute('href', '/admin/gift-orders/o1');
  });

  it('STK2: order numbers are plain text when the viewer cannot open the order console', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonRes({ ...HISTORY, canOpenOrder: false })));
    render(<StockHistoryPanel rewardId="r1" />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('BAJ-1')).toBeInTheDocument();
    expect(within(table).queryByRole('link')).toBeNull();
  });

  it('STK3: Download fetches this reward’s .xlsx export', async () => {
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const fetchFn = vi.fn((url: string) =>
      url.endsWith('/export')
        ? Promise.resolve({ ok: true, status: 200, headers: { get: () => 'attachment; filename="stock-history-AMZ500.xlsx"' }, blob: () => Promise.resolve(new Blob(['x'])) })
        : jsonRes(HISTORY),
    );
    vi.stubGlobal('fetch', fetchFn);
    render(<StockHistoryPanel rewardId="r1" />);
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /Download/ }));
    await waitFor(() =>
      expect(fetchFn.mock.calls.some(([u]) => u === '/api/admin/rewards/catalog/r1/stock-history/export')).toBe(true),
    );
  });

  it('STK4: an unreadable reply shows an error with Try again', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonRes({ items: [] })));
    render(<StockHistoryPanel rewardId="r1" />);
    expect(await screen.findByText('The stock history could not be read.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('STK5: open pre-release reviews are called out', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonRes({
      ...HISTORY,
      pendingReviews: [{ id: 'rv1', orderId: 'old', orderNumber: 'BAJ-OLD', quantity: 1, orderStatus: 'CANCELLED', createdAt: '2026-11-27T00:00:00.000Z' }],
    })));
    render(<StockHistoryPanel rewardId="r1" />);
    expect(await screen.findByText(/BAJ-OLD/)).toBeInTheDocument();
    expect(screen.getByText(/was not\s+returned automatically/)).toBeInTheDocument();
  });
});

describe('STK — StockReviewBanner', () => {
  const REVIEWS = {
    total: 1,
    items: [{ id: 'rv1', rewardId: 'r1', rewardName: 'Amazon 500', rewardCode: 'AMZ500', currentStock: 4, orderId: 'old', orderNumber: 'BAJ-OLD', quantity: 2, orderStatus: 'FAILED', createdAt: '2026-11-27T00:00:00.000Z' }],
  };

  it('STK6: lists the order and Return posts RETURN', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'POST') return jsonRes({ status: 'RETURNED', stockAfter: 6, backInStock: false });
      return jsonRes(calls.filter((c) => c.init?.method === 'POST').length ? { total: 0, items: [] } : REVIEWS);
    }));
    render(<StockReviewBanner canDecide />);
    expect(await screen.findByText('Stock returns to review (1)')).toBeInTheDocument();
    expect(screen.getByText(/Their stock was NOT returned automatically/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Return 2 to stock' }));
    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === 'POST');
      expect(post?.url).toBe('/api/admin/rewards/stock-reviews/rv1/resolve');
      expect(JSON.parse(String(post?.init?.body))).toEqual({ action: 'RETURN' });
    });
    expect(await screen.findByText(/Order BAJ-OLD: 2 returned to stock \(now 6\)/)).toBeInTheDocument();
  });

  it('STK7: Keep as is needs a note, then posts KEEP with it', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'POST') return jsonRes({ status: 'KEPT' });
      return jsonRes(REVIEWS);
    }));
    render(<StockReviewBanner canDecide />);
    await userEvent.click(await screen.findByRole('button', { name: 'Keep as is' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm keep as is' }));
    expect(screen.getByText('Write why the stock stays as it is.')).toBeInTheDocument();
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    await userEvent.type(screen.getByLabelText('Reason to keep stock for BAJ-OLD'), 'Never physically stocked');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm keep as is' }));
    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === 'POST');
      expect(JSON.parse(String(post?.init?.body))).toEqual({ action: 'KEEP', note: 'Never physically stocked' });
    });
  });

  it('STK8: no open reviews → no banner', async () => {
    const fetchFn = vi.fn(() => jsonRes({ total: 0, items: [] }));
    vi.stubGlobal('fetch', fetchFn);
    const { container } = render(<StockReviewBanner canDecide />);
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(container.querySelector('[aria-label="Stock returns to review"]')).toBeNull();
  });
});
