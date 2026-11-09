/// <reference types="vitest/globals" />
/**
 * GIFV — Fulfilment tab access by role (owner decision: a TENANT admin gets a view-only list).
 *  - CLIENT_ADMIN: list + masked codes, no Advance / bulk, "View only — Gifsy updates…" note;
 *  - GIFSY_ADMIN: full controls; GIFSY_STAFF: controls only WITH rewards:manage_orders;
 *  - MIS_USER / others: no list (honest note, no orders fetch);
 *  - role unknown (pre-hydration): render nothing — never a premature "View only" note.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AdminGiftsPage from '../page';

const session = vi.hoisted(() => ({
  role: 'CLIENT_ADMIN' as string | null,
  ready: true,
  perms: [] as string[],
}));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: session.role ?? 'CLIENT_ADMIN' }) }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({
    role: session.role,
    permissions: session.perms,
    ready: session.ready,
    error: false,
    has: (p: string) => session.role !== 'GIFSY_STAFF' || session.perms.includes(p),
    retry: () => {},
  }),
}));

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

function installFetch(orders: unknown[] = ORDERS) {
  const fn = vi.fn((url: string) => {
    if (url.startsWith('/api/rewards/orders')) {
      return jsonOk({ orders, pagination: { page: 1, limit: 100, total: orders.length, pages: 1 }, nextCursor: null });
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
const orderCalls = (fn: ReturnType<typeof installFetch>) =>
  (fn.mock.calls as [string][]).filter(([u]) => u.startsWith('/api/rewards/orders'));

async function openFulfilment() {
  render(<AdminGiftsPage />);
  await userEvent.click(await screen.findByRole('button', { name: /fulfilment/i }));
}

afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  session.role = 'CLIENT_ADMIN'; session.ready = true; session.perms = [];
});

describe('GIFV — Fulfilment access by role', () => {
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
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /voucher cancelled with vendor/i })).toBeNull();
    expect(screen.getByRole('button', { name: /refresh orders/i })).toBeInTheDocument();
    expect((fetchMock.mock.calls as [string][]).some(([u]) => u.includes('/fulfilment/'))).toBe(false);
  });

  it('GIFV1b: CLIENT_ADMIN renders the server-MASKED voucher code as-is (flagged masked for screen readers)', async () => {
    installFetch([{ ...ORDERS[0], status: 'DELIVERED', voucherCode: '••••WXYZ', voucherCodeMasked: true }]);
    await openFulfilment();
    const code = await screen.findByTestId('order-voucher-code');
    expect(code).toHaveTextContent('••••WXYZ');
    expect(code).toHaveTextContent('(masked)');
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

  it('GIFV4: GIFSY_STAFF WITHOUT rewards:manage_orders gets a view-only list (honest note, no controls)', async () => {
    session.role = 'GIFSY_STAFF'; session.perms = ['rewards:read'];
    installFetch();
    await openFulfilment();
    expect(await screen.findByText('RDM-1')).toBeInTheDocument();
    expect(screen.getByText(/View only — your role can't update order status/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /advance/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /download fulfilment sheet/i })).toBeNull();
  });

  it('GIFV5: GIFSY_STAFF WITH rewards:manage_orders gets the controls', async () => {
    session.role = 'GIFSY_STAFF'; session.perms = ['rewards:read', 'rewards:manage_orders'];
    installFetch();
    await openFulfilment();
    expect(await screen.findByText('RDM-1')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /advance/i }).length).toBe(2);
    expect(screen.queryByText(/View only/)).toBeNull();
  });

  it('GIFV6: MIS_USER gets an honest "not available" note and NO orders request (never a fake empty list)', async () => {
    session.role = 'MIS_USER';
    const fetchMock = installFetch();
    await openFulfilment();
    expect(await screen.findByText(/aren't available for your role/)).toBeInTheDocument();
    expect(screen.queryByText('RDM-1')).toBeNull();
    expect(screen.queryByText(/No orders in this view/)).toBeNull();
    expect(orderCalls(fetchMock)).toHaveLength(0);
  });

  it('GIFV7: while the role is unknown (or staff perms load) nothing is decided — no note, no list, no fetch', async () => {
    session.role = null;
    const fetchMock = installFetch();
    await openFulfilment();
    await waitFor(() => expect(screen.getAllByLabelText('Loading').length).toBeGreaterThan(0));
    expect(screen.queryByText(/View only/)).toBeNull();
    expect(screen.queryByText(/aren't available/)).toBeNull();
    expect(orderCalls(fetchMock)).toHaveLength(0);
  });
});
