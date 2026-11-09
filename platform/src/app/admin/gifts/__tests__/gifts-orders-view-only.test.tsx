/// <reference types="vitest/globals" />
/**
 * GIFV — Fulfilment tab for a TENANT admin (owner decision: view-only list of its own orders).
 * The transition + bulk template/upload endpoints stay Gifsy-only, so a CLIENT_ADMIN sees the
 * list but no Advance / bulk controls, plus a "View only" note. A Gifsy admin keeps them.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AdminGiftsPage from '../page';

const session = vi.hoisted(() => ({ role: 'CLIENT_ADMIN' }));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: session.role }) }));

const ORDERS = [
  {
    id: 'o1', orderNumber: 'RDM-1',
    reward: { id: 'r1', name: 'Amazon Voucher 500', redemptionMode: 'GIFT_CARD' },
    partner: { id: 'p1', businessName: 'Store One' },
    status: 'CONFIRMED', redemptionMode: 'GIFT_CARD', totalPointsCost: 500,
    createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'o2', orderNumber: 'RDM-2',
    reward: { id: 'r1', name: 'Amazon Voucher 500', redemptionMode: 'GIFT_CARD' },
    partner: { id: 'p2', businessName: 'Store Two' },
    status: 'PENDING', redemptionMode: 'GIFT_CARD', totalPointsCost: 500,
    createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
  },
];

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
}

function installFetch() {
  const fn = vi.fn((url: string) => {
    if (url.startsWith('/api/rewards/orders')) {
      return jsonOk({ orders: ORDERS, pagination: { page: 1, limit: 100, total: 2, pages: 1 }, nextCursor: null });
    }
    if (url.startsWith('/api/admin/rewards/catalog')) {
      return jsonOk({ items: [], pagination: { page: 1, limit: 200, total: 0, pages: 0 } });
    }
    if (url.startsWith('/api/admin/rewards/categories')) return jsonOk({ categories: [] });
    return jsonOk({});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function openFulfilment() {
  render(<AdminGiftsPage />);
  await userEvent.click(await screen.findByRole('button', { name: /fulfilment/i }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); session.role = 'CLIENT_ADMIN'; });

describe('GIFV — view-only Fulfilment for a tenant admin', () => {
  it('GIFV1: CLIENT_ADMIN sees its orders + the server count, with NO Advance or bulk controls and a view-only note', async () => {
    const fetchMock = installFetch();
    await openFulfilment();

    expect(await screen.findByText('RDM-1')).toBeInTheDocument();
    expect(screen.getByText('Store Two')).toBeInTheDocument();
    expect(screen.getByTestId('orders-count')).toHaveTextContent('(2)');
    expect(screen.getByText(/View only — Gifsy updates order status/)).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /advance/i })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: /action/i })).toBeNull();
    expect(screen.queryByText(/Bulk fulfilment/)).toBeNull();
    expect(screen.queryByRole('button', { name: /download fulfilment sheet/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /upload filled sheet/i })).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    // Read-only filter + refresh still work.
    expect(screen.getByRole('button', { name: /refresh orders/i })).toBeInTheDocument();
    // Never calls a Gifsy-only fulfilment endpoint.
    expect((fetchMock.mock.calls as [string][]).some(([u]) => u.includes('/fulfilment/'))).toBe(false);
  });

  it('GIFV2: GIFSY_ADMIN keeps the Advance + bulk controls and sees no view-only note', async () => {
    session.role = 'GIFSY_ADMIN';
    installFetch();
    await openFulfilment();

    expect(await screen.findByText('RDM-1')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /advance/i }).length).toBe(2);
    expect(screen.getByRole('button', { name: /download fulfilment sheet/i })).toBeInTheDocument();
    expect(screen.queryByText(/View only/)).toBeNull();
  });

  it('GIFV3: a PENDING order offers ONLY Cancel (no console confirm — mirrors the backend edge-map)', async () => {
    session.role = 'GIFSY_ADMIN';
    installFetch();
    await openFulfilment();

    const row = (await screen.findByText('RDM-2')).closest('tr') as HTMLElement;
    await userEvent.click(row.querySelector('button') as HTMLButtonElement);
    const select = screen.getByDisplayValue('CANCELLED') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['CANCELLED']);
  });
});
