/// <reference types="vitest/globals" />
/**
 * Redemption orders — a PHYSICAL_GIFT order shows its delivery block (name, phone, address, PIN)
 * with a "Copy address" button. The server only sends delivery fields to an operator who manages
 * orders; when they are absent (voucher rows, or a viewer the server withheld them from) no block
 * renders.
 */

import React from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
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

const BASE = {
  status: 'CONFIRMED', totalPointsCost: 500,
  createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
};
const ORDERS = [
  {
    ...BASE, id: 'o1', orderNumber: 'RDM-PHY',
    reward: { id: 'r1', name: 'Pressure Cooker', redemptionMode: 'PHYSICAL_GIFT' },
    partner: { id: 'p1', businessName: 'Store One', outletCode: 'BJ-0042', phone: '9811111111' },
    redemptionMode: 'PHYSICAL_GIFT',
    deliveryName: 'Ravi Kumar', deliveryPhone: '9822222222',
    deliveryAddressLine1: '12 MG Road', deliveryAddressLine2: 'Near Clock Tower',
    deliveryCity: 'Pune', deliveryState: 'Maharashtra', deliveryPincode: '011001',
  },
  {
    ...BASE, id: 'o2', orderNumber: 'RDM-GC',
    reward: { id: 'r2', name: 'Amazon Voucher 500', redemptionMode: 'GIFT_CARD' },
    partner: { id: 'p2', businessName: 'Store Two', outletCode: 'BJ-0043', phone: null },
    redemptionMode: 'GIFT_CARD',
  },
  {
    // Physical, but the server withheld the address (viewer can't manage orders) → no block.
    ...BASE, id: 'o3', orderNumber: 'RDM-PHY-HIDDEN',
    reward: { id: 'r1', name: 'Pressure Cooker', redemptionMode: 'PHYSICAL_GIFT' },
    partner: { id: 'p3', businessName: 'Store Three', outletCode: 'BJ-0044', phone: null },
    redemptionMode: 'PHYSICAL_GIFT',
  },
];

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
}

function installFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/rewards/orders')) {
      return jsonOk({ orders: ORDERS, pagination: { page: 1, limit: 100, total: 3, pages: 1 }, nextCursor: null });
    }
    if (url.startsWith('/api/admin/rewards/catalog')) {
      return jsonOk({ items: [], pagination: { page: 1, limit: 200, total: 0, pages: 0 } });
    }
    if (url.startsWith('/api/admin/rewards/categories')) return jsonOk({ categories: [] });
    return jsonOk({});
  }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); session.role = 'GIFSY_ADMIN'; });

describe('Redemption orders — delivery address block', () => {
  it('renders name, phone, address and PIN for a physical gift, and copies the address', async () => {
    installFetch();
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<AdminGiftsPage />);
    await user.click(await screen.findByRole('button', { name: /fulfilment/i }));

    const row = (await screen.findByText('RDM-PHY')).closest('tr') as HTMLElement;
    const block = within(row).getByTestId('order-delivery');
    expect(block).toHaveTextContent('Ravi Kumar');
    expect(block).toHaveTextContent('9822222222');
    expect(block).toHaveTextContent('12 MG Road');
    expect(block).toHaveTextContent('Near Clock Tower');
    expect(block).toHaveTextContent('Pune, Maharashtra');
    expect(block).toHaveTextContent('011001');

    await user.click(within(block).getByRole('button', { name: /copy delivery address/i }));
    expect(writeText).toHaveBeenCalledWith(
      'Ravi Kumar\n9822222222\n12 MG Road\nNear Clock Tower\nPune, Maharashtra - 011001',
    );
    await waitFor(() => expect(within(block).getByRole('button')).toHaveTextContent('Copied'));
  });

  it('shows no delivery block on a voucher row or when the server sent no address', async () => {
    installFetch();
    render(<AdminGiftsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /fulfilment/i }));

    const gc = (await screen.findByText('RDM-GC')).closest('tr') as HTMLElement;
    expect(within(gc).queryByTestId('order-delivery')).toBeNull();
    const hidden = screen.getByText('RDM-PHY-HIDDEN').closest('tr') as HTMLElement;
    expect(within(hidden).queryByTestId('order-delivery')).toBeNull();
    expect(hidden.textContent).not.toMatch(/null|undefined/);
  });
});
