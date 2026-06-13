/// <reference types="vitest/globals" />
/**
 * OR — Partner Rewards Orders page API wiring
 *
 * OR1: shows loading spinner on mount
 * OR2: renders reward name from API response
 * OR3: renders order count in header
 * OR4: shows error message when fetch fails
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import OrdersPage from '../page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const MOCK_ORDERS = [
  {
    id: 'o1',
    reward: { id: 'r1', name: 'Amazon Gift Voucher ₹200', imageUrls: [] },
    partner: { id: 'p1', businessName: 'Test Store' },
    status: 'DELIVERED',
    totalPointsCost: 200,
    trackingNumber: 'AMZ-2024-001',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-05T00:00:00.000Z',
  },
  {
    id: 'o2',
    reward: { id: 'r2', name: 'Bluetooth Speaker (JBL)', imageUrls: [] },
    partner: { id: 'p1', businessName: 'Test Store' },
    status: 'DISPATCHED',
    totalPointsCost: 2500,
    trackingNumber: 'DEOLEO-5512',
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
  },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('OR — Orders API wiring', () => {
  it('OR1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<OrdersPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('OR2: renders reward name from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { orders: MOCK_ORDERS, pagination: { page: 1, limit: 20, total: 2, pages: 1 } },
        }),
    }));
    render(<OrdersPage />);
    expect(await screen.findByText('Amazon Gift Voucher ₹200')).toBeInTheDocument();
  });

  it('OR3: renders order count in header', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { orders: MOCK_ORDERS, pagination: { page: 1, limit: 20, total: 2, pages: 1 } },
        }),
    }));
    render(<OrdersPage />);
    expect(await screen.findByText('2 orders')).toBeInTheDocument();
  });

  it('OR4: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<OrdersPage />);
    expect(await screen.findByText(/failed to load orders/i)).toBeInTheDocument();
  });
});
