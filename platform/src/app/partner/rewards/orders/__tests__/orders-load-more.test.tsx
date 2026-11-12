/// <reference types="vitest/globals" />
/**
 * My Orders "Load more" (fix/list-caps) — the list used to fetch only the newest 20 orders, so
 * older orders were unreachable. The first page is unchanged (GET /api/rewards/orders); older
 * pages are appended via the keyset `nextCursor`.
 *
 * LM1: a nextCursor shows "Load more"; clicking it fetches ?cursor=… and APPENDS the older page
 * LM2: the button hides once the cursor is exhausted (nextCursor null)
 * LM3: no button at all when the first page is the only page
 * LM4: an APPENDED order's timeline loads /track on demand, exactly like a first-page order
 * LM5: a failed Load more keeps the loaded orders, shows a notice, and the button retries
 * LM6: a row repeated across pages is never rendered twice
 * LM7: the header count is the backend TOTAL, not just the loaded page
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import OrdersPage from '../page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const order = (n: number, name: string) => ({
  id: `o${n}`,
  orderNumber: `DEO-26-00000${n}`,
  reward: { id: `r${n}`, name, imageUrls: [] },
  status: 'PROCESSING',
  redemptionMode: 'PHYSICAL_GIFT',
  totalPointsCost: 1000,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-02T00:00:00.000Z',
});
const A = order(1, 'Alpha Speaker');
const B = order(2, 'Bravo Cookware');
const C = order(3, 'Charlie Mixer');

const ok = (data: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
const page = (orders: unknown[], nextCursor: string | null, total?: number) =>
  ok({ orders, nextCursor, pagination: { total: total ?? orders.length } });

const TRACK_OK = () => ok({
  tracking: {
    timeline: [{ fromStatus: 'PENDING', toStatus: 'CONFIRMED', createdAt: '2026-05-01T01:00:00.000Z' }],
    refundedAt: null,
  },
});

/** fetch routed by URL: first page, cursor pages (by cursor value), and /track. */
function stubFetch(routes: {
  first: () => Promise<unknown>;
  cursor?: Record<string, () => Promise<unknown>>;
  track?: () => Promise<unknown>;
}) {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/rewards/orders') return routes.first();
    const m = /^\/api\/rewards\/orders\?cursor=(.+)$/.exec(url);
    if (m) {
      const handler = routes.cursor?.[decodeURIComponent(m[1])];
      return handler ? handler() : Promise.reject(new Error(`unexpected cursor ${m[1]}`));
    }
    if (url.endsWith('/track')) return (routes.track ?? TRACK_OK)();
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const calls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map(([u]) => String(u));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('My Orders — Load more', () => {
  it('LM1: "Load more" fetches the cursor page and appends it after the first page', async () => {
    const fetchMock = stubFetch({
      first: () => page([A, B], 'cur/2+', 3),
      cursor: { 'cur/2+': () => page([C], null, 3) },
    });
    render(<OrdersPage />);
    await screen.findByText('Alpha Speaker');
    expect(screen.queryByText('Charlie Mixer')).toBeNull();

    fireEvent.click(screen.getByTestId('orders-load-more'));

    expect(await screen.findByText('Charlie Mixer')).toBeInTheDocument();
    // The cursor is URL-encoded verbatim (opaque to the client).
    expect(calls(fetchMock)).toContain(`/api/rewards/orders?cursor=${encodeURIComponent('cur/2+')}`);
    // Appended AFTER the existing cards, in server order.
    const names = screen.getAllByText(/Alpha Speaker|Bravo Cookware|Charlie Mixer/).map((n) => n.textContent);
    expect(names).toEqual(['Alpha Speaker', 'Bravo Cookware', 'Charlie Mixer']);
  });

  it('LM2: the button hides once the cursor is exhausted', async () => {
    stubFetch({
      first: () => page([A], 'c2', 3),
      cursor: { c2: () => page([B], 'c3', 3), c3: () => page([C], null, 3) },
    });
    render(<OrdersPage />);
    await screen.findByText('Alpha Speaker');
    fireEvent.click(screen.getByTestId('orders-load-more'));
    await screen.findByText('Bravo Cookware');
    expect(screen.getByTestId('orders-load-more')).toBeInTheDocument(); // still more
    fireEvent.click(screen.getByTestId('orders-load-more'));
    await screen.findByText('Charlie Mixer');
    await waitFor(() => expect(screen.queryByTestId('orders-load-more')).toBeNull());
  });

  it('LM3: no "Load more" when the first page is the only page', async () => {
    stubFetch({ first: () => page([A, B], null) });
    render(<OrdersPage />);
    await screen.findByText('Bravo Cookware');
    expect(screen.queryByTestId('orders-load-more')).toBeNull();
  });

  it('LM3b: an old backend without nextCursor in the envelope shows no button (no crash)', async () => {
    stubFetch({ first: () => ok({ orders: [A] }) });
    render(<OrdersPage />);
    await screen.findByText('Alpha Speaker');
    expect(screen.queryByTestId('orders-load-more')).toBeNull();
    expect(screen.getByTestId('orders-count')).toHaveTextContent('1 orders');
  });

  it('LM4: an appended order loads its timeline from /track on demand', async () => {
    const fetchMock = stubFetch({
      first: () => page([A], 'c2', 2),
      cursor: { c2: () => page([C], null, 2) },
    });
    render(<OrdersPage />);
    await screen.findByText('Alpha Speaker');
    fireEvent.click(screen.getByTestId('orders-load-more'));
    await screen.findByText('Charlie Mixer');
    // Nothing fetched for /track until a timeline is opened.
    expect(calls(fetchMock).filter((u) => u.endsWith('/track'))).toHaveLength(0);

    fireEvent.click(screen.getAllByText('View timeline')[1]); // the appended card
    await waitFor(() =>
      expect(calls(fetchMock).filter((u) => u.endsWith('/track'))).toEqual(['/api/rewards/orders/o3/track']),
    );
    expect(await screen.findByTestId('order-step-date-confirmed')).toBeInTheDocument();
  });

  it('LM5: a failed Load more keeps the list, shows a notice, and the button retries', async () => {
    let n = 0;
    stubFetch({
      first: () => page([A], 'c2', 2),
      cursor: { c2: () => (++n === 1 ? Promise.reject(new Error('network')) : page([B], null, 2)) },
    });
    render(<OrdersPage />);
    await screen.findByText('Alpha Speaker');
    fireEvent.click(screen.getByTestId('orders-load-more'));
    expect(await screen.findByTestId('orders-load-more-error')).toBeInTheDocument();
    expect(screen.getByText('Alpha Speaker')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('orders-load-more'));
    expect(await screen.findByText('Bravo Cookware')).toBeInTheDocument();
    expect(screen.queryByTestId('orders-load-more-error')).toBeNull();
    expect(screen.queryByTestId('orders-load-more')).toBeNull();
  });

  it('LM6: a row repeated across pages is rendered once', async () => {
    stubFetch({
      first: () => page([A, B], 'c2', 3),
      cursor: { c2: () => page([B, C], null, 3) },
    });
    render(<OrdersPage />);
    await screen.findByText('Bravo Cookware');
    fireEvent.click(screen.getByTestId('orders-load-more'));
    await screen.findByText('Charlie Mixer');
    expect(screen.getAllByText('Bravo Cookware')).toHaveLength(1);
  });

  it('LM7: the header shows the backend total, not just the loaded page', async () => {
    stubFetch({ first: () => page([A, B], 'c2', 57) });
    render(<OrdersPage />);
    await screen.findByText('Alpha Speaker');
    expect(screen.getByTestId('orders-count')).toHaveTextContent('57 orders');
  });
});
