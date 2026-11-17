/// <reference types="vitest/globals" />
/**
 * OH — "View timeline" loads real step dates (+ refund) from GET /api/rewards/orders/:id/track
 * (owner D1 / D5). The list stays status-only; /track is fetched once per order, on first expand.
 *
 * OH1: expanding o1 calls /track once; collapse + re-expand does not refetch
 * OH2: nothing is fetched before expanding, and never for other orders
 * OH3: a CONFIRMED history row dates the Confirmed step
 * OH4: while /track is loading the status-only stepper stays rendered
 * OH5: /track failure (ok:false / success:false / rejected / malformed) keeps the status-only stepper + a muted notice, no auto-refetch
 * OH7: a later expand retries a failed /track
 * OH8: the list Retry starts with a clean /track cache
 * OH9: the toggle exposes aria-expanded
 * OH6: refund copy appears only when /track reports refundedAt
 */
import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import OrdersPage from '../page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PROCESSING = {
  id: 'o1',
  orderNumber: 'DEO-26-000001',
  reward: { id: 'r1', name: 'Bluetooth Speaker (JBL)', imageUrls: [] },
  status: 'PROCESSING',
  redemptionMode: 'PHYSICAL_GIFT',
  totalPointsCost: 2500,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-03T00:00:00.000Z',
};
const OTHER = { ...PROCESSING, id: 'o2', orderNumber: 'DEO-26-000002', reward: { id: 'r2', name: 'Cookware Set', imageUrls: [] } };
const CANCELLED = {
  ...PROCESSING, id: 'o3', orderNumber: 'DEO-26-000003', status: 'CANCELLED', cancelledAt: '2026-05-02T00:00:00.000Z',
};

const TRACK_OK = (over: Record<string, unknown> = {}) => ({
  ok: true,
  json: () => Promise.resolve({
    success: true,
    data: {
      tracking: {
        timeline: [
          { fromStatus: 'PENDING', toStatus: 'CONFIRMED', createdAt: '2026-05-01T01:00:00.000Z' },
          { fromStatus: 'CONFIRMED', toStatus: 'PROCESSING', createdAt: '2026-05-02T10:00:00.000Z' },
        ],
        refundedAt: null,
        ...over,
      },
    },
  }),
});

/** fetch routed by URL: the list returns `orders`; /track uses `track` (a response or a factory). */
function stubFetch(orders: unknown[], track: () => Promise<unknown>) {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/rewards/orders') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { orders } }) });
    }
    return track();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const trackCalls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter(([u]) => String(u).includes('/track'));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function expandFirst(name = 'Bluetooth Speaker (JBL)') {
  await screen.findByText(name);
  fireEvent.click(screen.getAllByText('View timeline')[0]);
}

describe('OH — dated timeline from /track', () => {
  it('OH1: expanding calls /track once; collapsing and re-expanding does not refetch', async () => {
    const fetchMock = stubFetch([PROCESSING], () => Promise.resolve(TRACK_OK()));
    render(<OrdersPage />);
    await expandFirst();
    await waitFor(() => expect(trackCalls(fetchMock)).toHaveLength(1));
    expect(trackCalls(fetchMock)[0][0]).toBe('/api/rewards/orders/o1/track');
    await screen.findByTestId('order-step-date-confirmed');
    fireEvent.click(screen.getByText('Hide timeline'));
    fireEvent.click(screen.getByText('View timeline'));
    await screen.findByTestId('order-step-date-confirmed');
    expect(trackCalls(fetchMock)).toHaveLength(1);
  });

  it('OH2: /track is not called before expanding, nor for orders that were not expanded', async () => {
    const fetchMock = stubFetch([PROCESSING, OTHER], () => Promise.resolve(TRACK_OK()));
    render(<OrdersPage />);
    await screen.findByText('Cookware Set');
    expect(trackCalls(fetchMock)).toHaveLength(0);
    fireEvent.click(screen.getAllByText('View timeline')[0]);
    await waitFor(() => expect(trackCalls(fetchMock)).toHaveLength(1));
    expect(trackCalls(fetchMock).every(([u]) => u === '/api/rewards/orders/o1/track')).toBe(true);
  });

  it('OH3: a CONFIRMED history row dates the Confirmed step', async () => {
    stubFetch([PROCESSING], () => Promise.resolve(TRACK_OK()));
    render(<OrdersPage />);
    await expandFirst();
    const detail = await screen.findByTestId('order-stepper-detail');
    expect(await within(detail).findByTestId('order-step-date-confirmed')).toBeInTheDocument();
    expect(await within(detail).findByTestId('order-step-date-processing')).toBeInTheDocument();
  });

  it('OH4: while /track is loading, the status-only stepper stays rendered', async () => {
    stubFetch([PROCESSING], () => new Promise(() => {})); // never resolves
    render(<OrdersPage />);
    await expandFirst();
    const detail = await screen.findByTestId('order-stepper-detail');
    expect(await within(detail).findByTestId('order-step-processing')).toHaveAttribute('data-state', 'current');
    expect(within(detail).queryByTestId('order-step-date-confirmed')).toBeNull();
  });

  it.each([
    ['ok:false', () => Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false, error: 'x' }) })],
    ['success:false', () => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: false, error: 'x' }) })],
    ['rejected', () => Promise.reject(new Error('network'))],
    ['malformed', () => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) })],
  ])('OH5: /track failure (%s) keeps the status-only stepper, says dates could not be loaded, and never auto-refetches', async (_n, track) => {
    const fetchMock = stubFetch([PROCESSING], track as () => Promise<unknown>);
    render(<OrdersPage />);
    await expandFirst();
    await waitFor(() => expect(trackCalls(fetchMock)).toHaveLength(1));
    const detail = screen.getByTestId('order-stepper-detail');
    expect(within(detail).getByTestId('order-step-processing')).toHaveAttribute('data-state', 'current');
    expect(await screen.findByTestId('order-timeline-dates-failed')).toHaveTextContent("Dates couldn't be loaded");
    expect(screen.getByText('Bluetooth Speaker (JBL)')).toBeInTheDocument(); // card intact
    await new Promise((r) => setTimeout(r, 20));
    expect(trackCalls(fetchMock)).toHaveLength(1); // no loop
  });

  it('OH7: after a failure, collapsing and re-expanding retries /track; a successful retry shows dates and clears the notice', async () => {
    let n = 0;
    const fetchMock = stubFetch([PROCESSING], () => (++n === 1 ? Promise.reject(new Error('network')) : Promise.resolve(TRACK_OK())));
    render(<OrdersPage />);
    await expandFirst();
    await screen.findByTestId('order-timeline-dates-failed');
    fireEvent.click(screen.getByText('Hide timeline'));
    fireEvent.click(screen.getByText('View timeline'));
    await waitFor(() => expect(trackCalls(fetchMock)).toHaveLength(2));
    expect(await screen.findByTestId('order-step-date-confirmed')).toBeInTheDocument();
    expect(screen.queryByTestId('order-timeline-dates-failed')).toBeNull();
    // success is cached: a further re-expand does not refetch
    fireEvent.click(screen.getByText('Hide timeline'));
    fireEvent.click(screen.getByText('View timeline'));
    expect(trackCalls(fetchMock)).toHaveLength(2);
  });

  it('OH8: the list Retry reload starts with a clean /track cache (expanding afterwards fetches /track)', async () => {
    let listCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/rewards/orders') {
        listCalls++;
        return listCalls === 1
          ? Promise.reject(new Error('Network error'))
          : Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { orders: [PROCESSING] } }) });
      }
      return Promise.resolve(TRACK_OK());
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<OrdersPage />);
    fireEvent.click(await screen.findByTestId('orders-retry'));
    await expandFirst();
    await waitFor(() => expect(trackCalls(fetchMock)).toHaveLength(1));
    expect(await screen.findByTestId('order-step-date-confirmed')).toBeInTheDocument();
  });

  it('OH9: the "View timeline" toggle exposes aria-expanded', async () => {
    stubFetch([PROCESSING], () => Promise.resolve(TRACK_OK()));
    render(<OrdersPage />);
    await screen.findByText('Bluetooth Speaker (JBL)');
    const btn = await screen.findByText('View timeline');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(screen.getByText('Hide timeline')).toHaveAttribute('aria-expanded', 'true');
  });

  it('OH6: "Points refunded" shows only when /track reports a recorded refund', async () => {
    stubFetch([CANCELLED], () => Promise.resolve(TRACK_OK({
      timeline: [
        { fromStatus: 'PENDING', toStatus: 'CONFIRMED', createdAt: '2026-05-01T01:00:00.000Z' },
        { fromStatus: 'CONFIRMED', toStatus: 'CANCELLED', createdAt: '2026-05-02T00:00:00.000Z' },
      ],
      refundedAt: '2026-05-02T00:00:00.500Z',
    })));
    render(<OrdersPage />);
    // Compact bar (no /track) never claims a refund.
    await screen.findByTestId('order-stepper-compact');
    expect(screen.queryByText('Points refunded to your wallet')).toBeNull();
    await expandFirst();
    expect(await screen.findByText('Points refunded to your wallet')).toBeInTheDocument();
  });

  it('OH6b: no refund line when /track reports refundedAt null', async () => {
    const fetchMock = stubFetch([CANCELLED], () => Promise.resolve(TRACK_OK({ refundedAt: null })));
    render(<OrdersPage />);
    await expandFirst();
    await waitFor(() => expect(trackCalls(fetchMock)).toHaveLength(1));
    await screen.findByTestId('order-step-date-confirmed');
    expect(screen.queryByText('Points refunded to your wallet')).toBeNull();
  });
});
