/// <reference types="vitest/globals" />
/**
 * Sales-assisted gift catalogue — FREE_AMOUNT vs FIXED points/cost copy.
 *
 * A FREE_AMOUNT reward (variable voucher / bank transfer) stores pointsCost === 0 by
 * design — the redeemer enters a ₹ amount and points are computed server-side at the
 * tenant conversion rate on confirm. The UI must NOT print that raw 0 as "0 pts".
 *
 * These tests prove, on the DETAIL sheet:
 *  - FA1: a FREE_AMOUNT gift shows "You choose the amount" and a plain "Redeem" button,
 *         and never "0 pts" / "Redeem for 0 pts".
 *  - FX1: a FIXED gift still shows "{points} pts" and "Redeem for {points} pts"
 *         (byte-identical to today).
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import CataloguePage from '../page';

// next/navigation useSearchParams — no outletId preselected.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}));

const FIXED_ITEM = {
  id: 'fixed-1',
  name: 'JBL Speaker',
  pointsCost: 2500,
  description: 'A fixed-cost gift',
  imageUrls: null,
  status: 'ACTIVE',
  stockQuantity: null,
  redemptionMode: 'PHYSICAL_GIFT',
  minRedemptionPoints: null,
  maxRedemptionPoints: null,
};

const FREE_AMOUNT_ITEM = {
  id: 'free-1',
  name: 'Amazon Voucher',
  pointsCost: 0, // FREE_AMOUNT marker (+ both band bounds set)
  description: 'A variable-amount voucher',
  imageUrls: null,
  status: 'ACTIVE',
  stockQuantity: null,
  redemptionMode: 'GIFT_CARD',
  minRedemptionPoints: 100,
  maxRedemptionPoints: 100000,
};

/** Route the global fetch: catalog → items, outlets → an outlet with a balance. */
function mockFetch(items: unknown[]) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/rewards/catalog')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, data: { items } }),
      });
    }
    if (url.includes('/api/sales/outlets')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          success: true,
          data: { outlets: [{ id: 'o1', partnerId: 'p1', kycId: 'k1', name: 'Shop One', mobile: '9830011252', balance: 50000 }] },
        }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: {} }) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('sales catalogue — FREE_AMOUNT vs FIXED copy', () => {
  it('FA1: a FREE_AMOUNT gift shows amount-based copy, never "0 pts"', async () => {
    mockFetch([FREE_AMOUNT_ITEM]);
    render(<CataloguePage />);

    // Open the detail sheet for the free-amount gift.
    const card = await screen.findByRole('button', { name: /Amazon Voucher/i });
    fireEvent.click(card);

    // Big headline + sub-line are amount-based, not "0 pts".
    expect(await screen.findByText('You choose the amount')).toBeInTheDocument();
    expect(screen.getByText('Redeemed as a ₹ amount')).toBeInTheDocument();

    // The sticky CTA is a plain "Redeem", NOT "Redeem for 0 pts".
    expect(screen.getByRole('button', { name: 'Redeem' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Redeem for/i })).not.toBeInTheDocument();

    // No "0 pts" anywhere on the sheet.
    expect(screen.queryByText(/\b0 pts\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Required to redeem/i)).not.toBeInTheDocument();
  });

  it('FX1: a FIXED gift still shows "{points} pts" and "Redeem for {points} pts"', async () => {
    mockFetch([FIXED_ITEM]);
    render(<CataloguePage />);

    const card = await screen.findByRole('button', { name: /JBL Speaker/i });
    fireEvent.click(card);

    // Big points figure + "Required to redeem" unchanged. "2,500 pts" appears on both
    // the catalogue card and the detail sheet, so assert the detail-sheet headline <p>.
    const detailPts = (await screen.findAllByText('2,500 pts')).find(
      (el) => el.className.includes('text-2xl'),
    );
    expect(detailPts).toBeTruthy();
    expect(screen.getByText('Required to redeem')).toBeInTheDocument();

    // CTA keeps the exact current copy.
    expect(screen.getByRole('button', { name: 'Redeem for 2,500 pts' })).toBeInTheDocument();
    expect(screen.queryByText('You choose the amount')).not.toBeInTheDocument();
  });
});
