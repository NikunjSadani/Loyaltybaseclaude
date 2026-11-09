/// <reference types="vitest/globals" />
/**
 * GIFP — Admin Fulfilment queue paging.
 *
 * Bug: the queue loaded `/api/rewards/orders?page=1&limit=100` once, so a tenant with >100
 * redemption orders could never see the older ones, and the header count was the LOADED rows.
 * Now: server-side status filter + keyset "Load more" (nextCursor) + the server total.
 */

import React from 'react';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AdminGiftsPage from '../page';

// The Fulfilment tab's Advance + bulk controls are Gifsy-operator only; these suites exercise
// them as GIFSY_ADMIN (the view-only CLIENT_ADMIN path is covered in gifts-orders-view-only).
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: 'GIFSY_ADMIN' }) }));

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

function installFetch(
  onOrders: OrdersHandler,
  extra?: (url: string, init?: RequestInit) => unknown,
) {
  const orderUrls: string[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const custom = extra?.(url, init);
    if (custom !== undefined) return custom as Promise<unknown>;
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

  it('GIFP5: a transition patches that row IN PLACE from the response — no orders refetch', async () => {
    const { orderUrls } = installFetch(
      (qs) => (qs.get('cursor') === 'c1'
        ? jsonOk({ orders: range(101, 200), pagination: { page: 1, limit: 100, total: 300, pages: 3 }, nextCursor: 'c2' })
        : jsonOk({ orders: range(1, 100), pagination: { page: 1, limit: 100, total: 300, pages: 3 }, nextCursor: 'c1' })),
      (url, init) => (url === '/api/rewards/orders/o150/transition' && init?.method === 'POST'
        ? jsonOk({ order: { id: 'o150', status: 'CANCELLED', updatedAt: '2026-05-02T00:00:00.000Z' } })
        : undefined),
    );
    await openFulfilment();
    await userEvent.click(await screen.findByRole('button', { name: /load more orders/i }));
    const row = (await screen.findByText('RDM-150')).closest('tr') as HTMLElement;
    const before = orderUrls.length;

    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    // PENDING's only console edge is CANCELLED (mirrors the backend table).
    await userEvent.click(screen.getByRole('button', { name: /confirm → CANCELLED/i }));

    const updated = (await screen.findByText('RDM-150')).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(updated).getByText('CANCELLED')).toBeInTheDocument());
    expect(orderUrls.length).toBe(before); // no window reload
    expect(screen.getByText('RDM-200')).toBeInTheDocument();
    expect(screen.getByTestId('orders-count')).toHaveTextContent('showing 200 of 300');
  });

  it('GIFP5b: under a status filter, a transitioned row that no longer matches leaves the view and the total drops by one', async () => {
    installFetch(
      () => jsonOk({ orders: range(1, 3, 'CONFIRMED'), pagination: { page: 1, limit: 100, total: 3, pages: 1 }, nextCursor: null }),
      (url, init) => (url === '/api/rewards/orders/o2/transition' && init?.method === 'POST'
        ? jsonOk({ order: { id: 'o2', status: 'PROCESSING' } })
        : undefined),
    );
    await openFulfilment();
    await userEvent.selectOptions(await screen.findByDisplayValue('All statuses'), 'CONFIRMED');
    const row = (await screen.findByText('RDM-2')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm → PROCESSING/i }));

    await waitFor(() => expect(screen.queryByText('RDM-2')).toBeNull());
    expect(screen.getByTestId('orders-count')).toHaveTextContent('(2)');
    expect(screen.queryByRole('button', { name: /new orders/i })).toBeNull();
  });

  it('GIFP7: a bulk upload that finishes AFTER a filter change refreshes the NEW filter (call-time values, not the stale closure)', async () => {
    let finishUpload: (() => void) | undefined;
    const { orderUrls } = installFetch(
      (qs) => (qs.get('status') === 'DELIVERED'
        ? jsonOk({ orders: range(501, 502, 'DELIVERED'), pagination: { page: 1, limit: 100, total: 2, pages: 1 }, nextCursor: null })
        : jsonOk({ orders: range(1, 100), pagination: { page: 1, limit: 100, total: 900, pages: 9 }, nextCursor: 'c1' })),
      (url, init) => (url.startsWith('/api/admin/rewards/fulfilment/upload') && init?.method === 'POST'
        ? new Promise((resolve) => {
            finishUpload = () => resolve({
              ok: true,
              json: () => Promise.resolve({ success: true, data: { processed: 1, succeeded: 1, skipped: 0, failed: 0, errors: [] } }),
            });
          })
        : undefined),
    );
    await openFulfilment();
    await screen.findByText('RDM-100');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(fileInput, new File(['x'], 'f.xlsx'));

    await userEvent.selectOptions(screen.getByDisplayValue('All statuses'), 'DELIVERED');
    await waitFor(() => expect(screen.getByTestId('orders-count')).toHaveTextContent('(2)'));

    finishUpload!();
    await screen.findByText(/All rows processed without errors/);
    await waitFor(() => {
      const last = new URLSearchParams(orderUrls[orderUrls.length - 1].split('?')[1]);
      expect(last.get('status')).toBe('DELIVERED');
      expect(last.get('limit')).toBe('100');
    });
    expect(screen.getByText('RDM-501')).toBeInTheDocument();
    expect(screen.queryByText('RDM-1')).toBeNull();
    expect(screen.getByTestId('orders-count')).toHaveTextContent('(2)');
  });

  it('GIFP8: a first-page failure on a filter change CLEARS the old rows/total/cursor and offers Retry', async () => {
    let failDispatched = true;
    installFetch((qs) => {
      if (qs.get('status') === 'DISPATCHED') {
        if (failDispatched) { failDispatched = false; return jsonErr(500, 'server down'); }
        return jsonOk({ orders: range(301, 302, 'DISPATCHED'), pagination: { page: 1, limit: 100, total: 2, pages: 1 }, nextCursor: null });
      }
      return jsonOk({ orders: range(1, 100), pagination: { page: 1, limit: 100, total: 900, pages: 9 }, nextCursor: 'c1' });
    });
    await openFulfilment();
    await screen.findByText('RDM-100');

    await userEvent.selectOptions(screen.getByDisplayValue('All statuses'), 'DISPATCHED');
    expect(await screen.findByRole('alert')).toHaveTextContent('server down');
    expect(screen.queryByText('RDM-1')).toBeNull();
    expect(screen.queryByRole('button', { name: /load more orders/i })).toBeNull();
    expect(screen.getByTestId('orders-count')).toHaveTextContent(/^$/);

    await userEvent.click(screen.getByRole('button', { name: /^retry$/i }));
    expect(await screen.findByText('RDM-302')).toBeInTheDocument();
    expect(screen.getByTestId('orders-count')).toHaveTextContent('(2)');
  });

  it('GIFP9: Refresh re-fetches the loaded window up to 500; deeper than 500 resets to the first page and says so', async () => {
    const { orderUrls } = installFetch((qs) => {
      const cursor = qs.get('cursor');
      const limit = Number(qs.get('limit'));
      if (cursor === 'c1') return jsonOk({ orders: range(101, 400), pagination: { page: 1, limit: 100, total: 2000, pages: 20 }, nextCursor: 'c2' });
      if (cursor) return jsonOk({ orders: range(401, 700), pagination: { page: 1, limit: 100, total: 2000, pages: 20 }, nextCursor: 'c3' });
      return jsonOk({ orders: range(1, limit), pagination: { page: 1, limit, total: 2000, pages: 20 }, nextCursor: limit === 100 ? 'c1' : 'cX' });
    });
    const lastLimit = () => new URLSearchParams(orderUrls[orderUrls.length - 1].split('?')[1]).get('limit');
    const count = () => screen.getByTestId('orders-count');
    // Cheap queries only (text/label/testid): role queries over a 700-row table are very slow in jsdom.
    await openFulfilment();
    await waitFor(() => expect(count()).toHaveTextContent('showing 100 of 2,000'));
    fireEvent.click(screen.getByText('Load more orders'));
    await waitFor(() => expect(count()).toHaveTextContent('showing 400 of 2,000'));

    // 400 loaded (<= 500) -> the same window in one request.
    fireEvent.click(screen.getByLabelText('Refresh orders'));
    await waitFor(() => expect(lastLimit()).toBe('400'));
    await waitFor(() => expect(count()).toHaveTextContent('showing 400 of 2,000'));
    expect(screen.queryByText(/use "Load more"/)).toBeNull();

    // Page to 700 (> 500) -> refresh resets to the first 100 and says so.
    await waitFor(() => expect(screen.getByText('Load more orders')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Load more orders'));
    await waitFor(() => expect(count()).toHaveTextContent('showing 700 of 2,000'));
    fireEvent.click(screen.getByLabelText('Refresh orders'));
    await waitFor(() => expect(lastLimit()).toBe('100'));
    await waitFor(() => expect(count()).toHaveTextContent('showing 100 of 2,000'));
    expect(screen.getByText(/Reloaded the first 100 orders/)).toBeInTheDocument();
  }, 30_000); // renders a 700-row table (needed to cross the 500 cap) — slow in jsdom, not async-flaky

  it('GIFP10: the count never shows a total below the visible rows; a grown total with no cursor offers "New orders — Refresh"', async () => {
    installFetch(() =>
      jsonOk({ orders: range(1, 5), pagination: { page: 1, limit: 100, total: 3, pages: 1 }, nextCursor: null }));
    await openFulfilment();
    await screen.findByText('RDM-5');
    // total 3 < 5 rows on screen → shows 5, never "5 of 3".
    expect(screen.getByTestId('orders-count')).toHaveTextContent('(5)');
    expect(screen.queryByRole('button', { name: /new orders/i })).toBeNull();
    expect(screen.getByTestId('orders-count')).toHaveAttribute('aria-live', 'polite');
  });

  it('GIFP11: "New orders — Refresh" appears when the server total exceeds the loaded rows with no cursor', async () => {
    installFetch((qs) => (qs.get('cursor')
      ? jsonOk({ orders: range(101, 150), pagination: { page: 1, limit: 100, total: 153, pages: 2 }, nextCursor: null })
      : jsonOk({ orders: range(1, 100), pagination: { page: 1, limit: 100, total: 150, pages: 2 }, nextCursor: 'c1' })));
    await openFulfilment();
    await userEvent.click(await screen.findByRole('button', { name: /load more orders/i }));
    await screen.findByText('RDM-150');
    // 3 orders landed above while paging: total 153, 150 loaded, no cursor.
    expect(screen.getByTestId('orders-count')).toHaveTextContent('showing 150 of 153');
    expect(screen.getByRole('button', { name: /new orders — refresh/i })).toBeInTheDocument();
    // a11y: focus moved to the first appended row once Load more unmounted.
    expect(document.activeElement?.getAttribute('data-order-id')).toBe('o101');
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
