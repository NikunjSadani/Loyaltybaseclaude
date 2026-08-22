/// <reference types="vitest/globals" />
/**
 * Member order-tracking — dispatch lifecycle + read-only + PII scope.
 *
 * MT1: a DISPATCHED order shows the member-safe courier (logisticsPartner) + tracking link
 * MT2: a RETURNED order renders the "Returned" status
 * MT3: the view is READ-ONLY — no fulfilment controls (no channel select, no status-advance)
 * MT4: ops-only fields are never exposed to the member (channel enum / supplier ref)
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import OrdersPage from '../page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const DISPATCHED = {
  id: 'o1',
  orderNumber: 'DEO-26-000123',
  reward: { id: 'r1', name: 'Bluetooth Speaker (JBL)', imageUrls: [] },
  status: 'DISPATCHED',
  redemptionMode: 'PHYSICAL_GIFT',
  totalPointsCost: 2500,
  trackingNumber: 'DEOLEO-5512',
  trackingUrl: 'https://track.example.com/DEOLEO-5512',
  logisticsPartner: 'Delhivery',
  createdAt: '2026-05-10T00:00:00.000Z',
  updatedAt: '2026-05-13T00:00:00.000Z',
  dispatchedAt: '2026-05-13T00:00:00.000Z',
};

const RETURNED = {
  id: 'o2',
  orderNumber: 'DEO-26-000200',
  reward: { id: 'r2', name: 'Cookware Set', imageUrls: [] },
  status: 'RETURNED',
  redemptionMode: 'PHYSICAL_GIFT',
  totalPointsCost: 4000,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-20T00:00:00.000Z',
  returnedAt: '2026-05-20T00:00:00.000Z',
};

function stubOrders(orders: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data: { orders } }),
  }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Member order-tracking', () => {
  it('MT1: shows the courier + tracking link for a dispatched order', async () => {
    stubOrders([DISPATCHED]);
    render(<OrdersPage />);
    expect(await screen.findByTestId('carrier')).toHaveTextContent('Delhivery');
    const link = screen.getByTestId('tracking-link');
    expect(link).toHaveAttribute('href', 'https://track.example.com/DEOLEO-5512');
  });

  it('MT2: renders the "Returned" status for a returned order', async () => {
    stubOrders([RETURNED]);
    render(<OrdersPage />);
    expect(await screen.findByText('Returned')).toBeInTheDocument();
  });

  it('MT3: is read-only — no fulfilment / status-advance controls', async () => {
    stubOrders([DISPATCHED]);
    render(<OrdersPage />);
    await screen.findByTestId('tracking-link');
    // No operator controls: no select boxes, no advance/save buttons.
    expect(document.querySelector('select')).toBeNull();
    expect(screen.queryByText(/advance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/save fulfilment/i)).not.toBeInTheDocument();
  });

  it('MT4: never exposes ops-only fields to the member', async () => {
    stubOrders([DISPATCHED]);
    render(<OrdersPage />);
    await screen.findByTestId('tracking-link');
    // Expand the timeline too, to be sure nothing ops-only surfaces there.
    fireEvent.click(screen.getByText('View timeline'));
    expect(screen.queryByText(/FULFILLED_BY_AMAZON|GIFSY_WAREHOUSE|Supplier ref|Fulfilled by/i)).not.toBeInTheDocument();
  });
});
