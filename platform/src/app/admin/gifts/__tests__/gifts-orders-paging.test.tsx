/// <reference types="vitest/globals" />
/**
 * GIFP — Admin Fulfilment queue paging.
 *
 * Bug: the queue loaded `/api/rewards/orders?page=1&limit=100` once, so a tenant with >100
 * redemption orders could never see the older ones, and the header count was the LOADED rows.
 * Now: server-side status filter + keyset "Load more" (nextCursor) + the server total.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AdminGiftsPage from '../page';

function order(i: number, status = 'PENDING') {
  return {
    id: `o${i}`,
    orderNumber: `RDM-${i}`,
    reward: { id: 'r1', name: 'Amazon Voucher 500', redemptionMode: 'GIFT_CARD' },
    partner: { id: 'p1', businessName: 'Test Store' },
    status,
    redemptionMode: 'GIFT_CARD',
    totalPointsCost: 500,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
}
function jsonErr(status: number, error: string) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({ success: false, error }) });
}

type OrdersHandler = (params: URLSearchParams) => unknown;

function installFetch(onOrders: OrdersHandler) {
  const orderUrls: string[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith('/api/rewards/orders') && !url.includes('/transition')) {
      orderUrls.push(url);
      const qs = new URLSearchParams(url.split('?')[1] ?? '');
      return onOrders(qs) as Promise<unknown>;
    }
    if (url.includes('/transition') && init?.method === 'POST') return jsonOk({});
    if (url.startsWith('/api/admin/rewards/catalog')) {
      return jsonOk({ items: [], pagination: { page: 1, limit: 200, total: 0, pages: 0 } });
    }
    if (url.startsWith('/api/admin/rewards/categories')) return jsonOk({ categories: [] });
    return jsonOk({});
  });
  vi.stubGlobal('fetch', fn);
  return { fn, orderUrls };
}

async function openFulfilment() {
  render(<AdminGiftsPage />);
  await userEvent.click(await screen.findByRole('button', { name: /fulfilment/i }));
}

const range = (from: number, to: number, status?: string) =>
  Array.from({ length: to - from + 1 }, (_, k) => order(from + k, status));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('GIFP — admin fulfilment queue paging', () => {
  it('GIFP1: first page uses limit=100 (no offset) and the count is the SERVER total, not the loaded rows', async () => {
    const { orderUrls } = installFetch(() =>
      jsonOk({ orders: range(1, 100), pagination: { page: 1, limit: 100, total: 250, pages: 3 }, nextCursor: 'c1' }),
    );
    await openFulfilment();

    expect(await screen.findByTestId('orders-count')).toHaveTextContent('showing 100 of 250');
    const qs = new URLSearchParams(orderUrls[0].split('?')[1]);
    expect(qs.get('limit')).toBe('100');
    expect(qs.has('cursor')).toBe(false);
    expect(qs.has('status')).toBe(false);
    expect(screen.getByRole('button', { name: /load more orders/i })).toBeInTheDocument();
  });

  it('GIFP2: Load more follows nextCursor, appends rows, and hides itself on the last page', async () => {
    const { orderUrls } = installFetch((qs) => {
      const cursor = qs.get('cursor');
      if (!cursor) return jsonOk({ orders: range(1, 100), pagination: { page: 1, limit: 100, total: 205, pages: 3 }, nextCursor: 'c1' });
      if (cursor === 'c1') return jsonOk({ orders: range(101, 200), pagination: { page: 1, limit: 100, total: 205, pages: 3 }, nextCursor: 'c2' });
      return jsonOk({ orders: range(201, 205), pagination: { page: 1, limit: 100, total: 205, pages: 3 }, nextCursor: null });
    });
    await openFulfilment();

    await userEvent.click(await screen.findByRole('button', { name: /load more orders/i }));
    expect(await screen.findByText('RDM-200')).toBeInTheDocument();
    expect(screen.getByTestId('orders-count')).toHaveTextContent('showing 200 of 205');

    await userEvent.click(screen.getByRole('button', { name: /load more orders/i }));
    // Every row is reachable — the oldest order renders.
    expect(await screen.findByText('RDM-205')).toBeInTheDocument();
    expect(screen.getByText('RDM-1')).toBeInTheDocument();
    expect(screen.getByTestId('orders-count')).toHaveTextContent('(205)');
    expect(screen.queryByRole('button', { name: /load more orders/i })).toBeNull();

    expect(new URLSearchParams(orderUrls[1].split('?')[1]).get('cursor')).toBe('c1');
    expect(new URLSearchParams(orderUrls[2].split('?')[1]).get('cursor')).toBe('c2');
  });

  it('GIFP3: the status filter is sent SERVER-side on the first page AND on load-more; total follows the filter', async () => {
    const { orderUrls } = installFetch((qs) => {
      const status = qs.get('status');
      if (status === 'DISPATCHED') {
        return qs.get('cursor')
          ? jsonOk({ orders: range(301, 302, 'DISPATCHED'), pagination: { page: 1, limit: 100, total: 102, pages: 2 }, nextCursor: null })
          : jsonOk({ orders: range(201, 300, 'DISPATCHED'), pagination: { page: 1, limit: 100, total: 102, pages: 2 }, nextCursor: 'd1' });
      }
      return jsonOk({ orders: range(1, 100), pagination: { page: 1, limit: 100, total: 900, pages: 9 }, nextCursor: 'c1' });
    });
    await openFulfilment();
    expect(await screen.findByTestId('orders-count')).toHaveTextContent('showing 100 of 900');

    await userEvent.selectOptions(screen.getByDisplayValue('All statuses'), 'DISPATCHED');
    await waitFor(() => expect(screen.getByTestId('orders-count')).toHaveTextContent('showing 100 of 102'));
    expect(screen.queryByText('RDM-1')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /load more orders/i }));
    expect(await screen.findByText('RDM-302')).toBeInTheDocument();
    expect(screen.getByTestId('orders-count')).toHaveTextContent('(102)');

    const last = new URLSearchParams(orderUrls[orderUrls.length - 1].split('?')[1]);
    expect(last.get('status')).toBe('DISPATCHED');
    expect(last.get('cursor')).toBe('d1');
  });

  it('GIFP4: a stale load-more response for the previous filter is discarded after a filter change', async () => {
    let releaseStale: (() => void) | undefined;
    installFetch((qs) => {
      if (qs.get('cursor') === 'c1') {
        return new Promise((resolve) => {
          releaseStale = () => resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: { orders: range(101, 200), pagination: { page: 1, limit: 100, total: 900, pages: 9 }, nextCursor: 'c2' } }),
          });
        });
      }
      if (qs.get('status') === 'DELIVERED') {
        return jsonOk({ orders: range(501, 503, 'DELIVERED'), pagination: { page: 1, limit: 100, total: 3, pages: 1 }, nextCursor: null });
      }
      return jsonOk({ orders: range(1, 100), pagination: { page: 1, limit: 100, total: 900, pages: 9 }, nextCursor: 'c1' });
    });
    await openFulfilment();

    await userEvent.click(await screen.findByRole('button', { name: /load more orders/i }));
    await userEvent.selectOptions(screen.getByDisplayValue('All statuses'), 'DELIVERED');
    await waitFor(() => expect(screen.getByTestId('orders-count')).toHaveTextContent('(3)'));

    releaseStale!();
    await new Promise((r) => setTimeout(r, 20));
    // The All-statuses page-2 rows never leak into the DELIVERED view; count stays honest.
    expect(screen.queryByText('RDM-150')).toBeNull();
    expect(screen.getByTestId('orders-count')).toHaveTextContent('(3)');
    expect(screen.queryByRole('button', { name: /load more orders/i })).toBeNull();
  });

  it('GIFP5: after a transition the SAME loaded window is re-fetched (limit = rows loaded), not reset to 100', async () => {
    const { orderUrls } = installFetch((qs) => {
      const limit = Number(qs.get('limit'));
      if (qs.get('cursor') === 'c1') return jsonOk({ orders: range(101, 200), pagination: { page: 1, limit: 100, total: 300, pages: 3 }, nextCursor: 'c2' });
      return jsonOk({ orders: range(1, limit), pagination: { page: 1, limit, total: 300, pages: 3 }, nextCursor: limit >= 200 ? 'c2' : 'c1' });
    });
    await openFulfilment();
    await userEvent.click(await screen.findByRole('button', { name: /load more orders/i }));
    expect(await screen.findByText('RDM-200')).toBeInTheDocument();

    // Advance an order → refresh.
    await userEvent.click(screen.getAllByRole('button', { name: /advance/i })[0]);
    await userEvent.click(screen.getByRole('button', { name: /confirm →/i }));

    await waitFor(() => {
      const last = new URLSearchParams(orderUrls[orderUrls.length - 1].split('?')[1]);
      expect(last.get('limit')).toBe('200');
      expect(last.has('cursor')).toBe(false);
    });
    expect(await screen.findByText('RDM-200')).toBeInTheDocument();
    expect(screen.getByTestId('orders-count')).toHaveTextContent('showing 200 of 300');
  });

  it('GIFP6: a failed load-more shows an error and keeps the loaded rows + a retry', async () => {
    let fail = true;
    installFetch((qs) => {
      if (qs.get('cursor')) {
        if (fail) { fail = false; return jsonErr(500, 'boom'); }
        return jsonOk({ orders: range(101, 110), pagination: { page: 1, limit: 100, total: 110, pages: 2 }, nextCursor: null });
      }
      return jsonOk({ orders: range(1, 100), pagination: { page: 1, limit: 100, total: 110, pages: 2 }, nextCursor: 'c1' });
    });
    await openFulfilment();
    await userEvent.click(await screen.findByRole('button', { name: /load more orders/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByText('RDM-100')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry load more/i }));
    expect(await screen.findByText('RDM-110')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
