/// <reference types="vitest/globals" />
/**
 * Gift-dispatch console list — filter auto-apply + pagination.
 *
 * CL1: a discrete select (status) auto-applies — no Apply click needed, resets to page 1
 * CL2: backend pagination meta drives Prev/Next + the "Page X of Y" count
 * CL3: clicking Next requests the next page
 * CL4: a full page with NO pagination meta warns that older orders may be unreachable
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: { get: (url: string) => get(url) },
  authHeader: () => ({}),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import GiftOrdersConsolePage from '../page';

function order(over: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    orderNumber: 'DEO-1',
    clientId: 'deoleo',
    tenantName: 'Deoleo',
    status: 'PENDING',
    rewardName: 'Speaker',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Gift-dispatch console list', () => {
  it('CL1: a status select auto-applies (fires a filtered request, page 1)', async () => {
    get.mockResolvedValue({ success: true, data: { items: [order()] } });
    render(<GiftOrdersConsolePage />);
    await screen.findAllByTestId('order-row');

    get.mockClear();
    fireEvent.change(screen.getByTestId('filter-status'), { target: { value: 'DISPATCHED' } });

    await waitFor(() => expect(get).toHaveBeenCalled());
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain('status=DISPATCHED');
    expect(url).toContain('page=1');
  });

  it('CL2: backend pagination meta drives Prev/Next + the page count', async () => {
    get.mockResolvedValue({
      success: true,
      data: { items: [order()], pagination: { page: 1, limit: 100, total: 250, pages: 3 } },
    });
    render(<GiftOrdersConsolePage />);

    expect(await screen.findByTestId('orders-count')).toHaveTextContent('Page 1 of 3');
    expect(screen.getByTestId('page-prev')).toBeDisabled();
    expect(screen.getByTestId('page-next')).not.toBeDisabled();
  });

  it('CL3: clicking Next requests the next page', async () => {
    get.mockResolvedValue({
      success: true,
      data: { items: [order()], pagination: { page: 1, limit: 100, total: 250, pages: 3 } },
    });
    render(<GiftOrdersConsolePage />);
    await screen.findByTestId('page-next');

    get.mockClear();
    fireEvent.click(screen.getByTestId('page-next'));
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get.mock.calls[0][0] as string).toContain('page=2');
  });

  it('CL4: a full page with no pagination meta warns older orders may be unreachable', async () => {
    const many = Array.from({ length: 100 }, (_, i) => order({ id: `o${i}`, orderNumber: `DEO-${i}` }));
    get.mockResolvedValue({ success: true, data: { items: many } });
    render(<GiftOrdersConsolePage />);

    expect(await screen.findByTestId('page-full-warning')).toBeInTheDocument();
  });
});
