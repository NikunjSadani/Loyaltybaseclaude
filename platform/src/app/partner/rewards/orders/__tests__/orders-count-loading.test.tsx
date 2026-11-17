/// <reference types="vitest/globals" />
/**
 * My Orders header count while loading (Bajaj training-video finding): the header used to read
 * "0 orders" next to the spinner for several seconds before the list arrived.
 *
 * OC1: while GET /api/rewards/orders is in flight there is NO count ("Loading…" instead)
 * OC2: once it resolves the real count shows
 * OC3: a genuinely empty result shows "0 orders" + the empty state
 * OC4: a failed load shows no count (no fake "0 orders" next to the error)
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import OrdersPage from '../page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const order = {
  id: 'o1',
  orderNumber: 'BAJ-26-000001',
  reward: { id: 'r1', name: 'Amazon Voucher', imageUrls: [] },
  status: 'DELIVERED',
  redemptionMode: 'GIFT_CARD',
  totalPointsCost: 500,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-02T00:00:00.000Z',
};

const json = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('My Orders — header count waits for the list', () => {
  it('OC1+OC2: no "0 orders" while loading; the real count once resolved', async () => {
    let resolve!: (v: unknown) => void;
    const pending = new Promise((r) => { resolve = r; });
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/rewards/orders') return pending;
      return Promise.reject(new Error(`unexpected ${url}`));
    }));
    render(<OrdersPage />);

    expect(screen.getByTestId('orders-count-loading')).toHaveTextContent('Loading…');
    expect(screen.queryByTestId('orders-count')).toBeNull();
    expect(screen.queryByText(/0 orders/)).toBeNull();
    expect(screen.queryByText('No orders yet')).toBeNull();

    resolve(json({ success: true, data: { orders: [order], nextCursor: null, pagination: { total: 1 } } }));

    expect(await screen.findByTestId('orders-count')).toHaveTextContent('1 orders');
    expect(screen.queryByTestId('orders-count-loading')).toBeNull();
    expect(await screen.findByText('Amazon Voucher')).toBeInTheDocument();
  });

  it('OC3: an actual empty result shows "0 orders" and the empty state', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(json({ success: true, data: { orders: [], nextCursor: null, pagination: { total: 0 } } })),
    ));
    render(<OrdersPage />);
    expect(await screen.findByText('No orders yet')).toBeInTheDocument();
    expect(await screen.findByTestId('orders-count')).toHaveTextContent('0 orders');
  });

  it('OC4: a failed load shows the error + Retry and no count', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ success: false, error: 'Failed to load orders' }))));
    render(<OrdersPage />);
    expect(await screen.findByTestId('orders-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('orders-count')).toBeNull();
    expect(screen.queryByTestId('orders-count-loading')).toBeNull();
  });
});
