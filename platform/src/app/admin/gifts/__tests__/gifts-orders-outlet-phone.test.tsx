/// <reference types="vitest/globals" />
/**
 * GIFOP — Redemption orders table shows the redeeming partner's Outlet ID (under the partner
 * name) and registered Phone (own column), for both the operator and the view-only tenant admin.
 * Missing values show "—" (never "undefined" / "null"). Voucher masking is untouched.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AdminGiftsPage from '../page';

const session = vi.hoisted(() => ({ role: 'GIFSY_ADMIN' as string }));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: session.role }) }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({
    role: session.role, permissions: [], ready: true, error: false, has: () => true, retry: () => {},
  }),
}));

const ORDERS = [
  {
    id: 'o1', orderNumber: 'RDM-1',
    reward: { id: 'r1', name: 'Amazon Voucher 500', redemptionMode: 'GIFT_CARD' },
    partner: { id: 'p1', businessName: 'Store One', outletCode: 'BJ-0042', phone: '9811111111' },
    status: 'CONFIRMED', redemptionMode: 'GIFT_CARD', totalPointsCost: 500,
    createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'o2', orderNumber: 'RDM-2',
    reward: { id: 'r1', name: 'Amazon Voucher 500', redemptionMode: 'GIFT_CARD' },
    partner: { id: 'p2', businessName: 'Store Two', outletCode: null, phone: null },
    status: 'PENDING', redemptionMode: 'GIFT_CARD', totalPointsCost: 500,
    createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
  },
];

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
}

function installFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/rewards/orders')) {
      return jsonOk({ orders: ORDERS, pagination: { page: 1, limit: 100, total: 2, pages: 1 }, nextCursor: null });
    }
    if (url.startsWith('/api/admin/rewards/catalog')) {
      return jsonOk({ items: [], pagination: { page: 1, limit: 200, total: 0, pages: 0 } });
    }
    if (url.startsWith('/api/admin/rewards/categories')) return jsonOk({ categories: [] });
    return jsonOk({});
  }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); session.role = 'GIFSY_ADMIN'; });

describe.each(['GIFSY_ADMIN', 'CLIENT_ADMIN'])('GIFOP — Outlet ID + Phone (%s)', (role) => {
  it('shows the Partner · Outlet ID and Phone headers, the outlet code under the partner, and the phone', async () => {
    session.role = role;
    installFetch();
    render(<AdminGiftsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /fulfilment/i }));

    const row1 = (await screen.findByText('RDM-1')).closest('tr') as HTMLElement;
    expect(screen.getByRole('columnheader', { name: 'Partner · Outlet ID' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Phone' })).toBeInTheDocument();
    expect(within(row1).getByText('Store One')).toBeInTheDocument();
    expect(within(row1).getByTestId('order-outlet-id')).toHaveTextContent('BJ-0042');
    expect(within(row1).getByTestId('order-partner-phone')).toHaveTextContent('9811111111');

    // Not recorded → "—", never "null" / "undefined".
    const row2 = screen.getByText('RDM-2').closest('tr') as HTMLElement;
    expect(within(row2).getByTestId('order-outlet-id')).toHaveTextContent('—');
    expect(within(row2).getByTestId('order-partner-phone')).toHaveTextContent('—');
    expect(row2.textContent).not.toMatch(/null|undefined/);
  });
});
