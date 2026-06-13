/// <reference types="vitest/globals" />
/**
 * PAY — Admin Payouts page API wiring
 *
 * PAY1: shows loading spinner on mount
 * PAY2: renders batch code from API response
 * PAY3: renders transaction partner name from API response
 * PAY4: shows error message when fetch fails
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import PayoutsPage from '../page';

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

const MOCK_BATCHES = [
  {
    id: 'b1',
    batchCode: 'BAT-2026-05',
    status: 'DISBURSED',
    totalAmountPaise: 2840000,
    transactionCount: 10,
    payoutMode: 'BANK_TRANSFER',
    processedAt: '2026-05-02T00:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    _count: { transactions: 10 },
  },
];

const MOCK_TRANSACTIONS = [
  {
    id: 't1',
    payoutMode: 'BANK_TRANSFER',
    status: 'PROCESSED',
    amountPaise: 4850000,
    beneficiaryName: 'Test Partner',
    partner: { id: 'p1', businessName: 'K. Krishnamurthy & Sons' },
    batch: { id: 'b1', batchCode: 'BAT-2026-05' },
    providerRefId: 'ICIC325001234',
  },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('PAY — Admin Payouts API wiring', () => {
  it('PAY1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<PayoutsPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('PAY2: renders batch code from API response', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      const isFirst = callCount <= 1;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(
          isFirst
            ? { success: true, data: { batches: MOCK_BATCHES, pagination: { page: 1, limit: 20, total: 1, pages: 1 } } }
            : { success: true, data: { transactions: MOCK_TRANSACTIONS, pagination: { page: 1, limit: 20, total: 1, pages: 1 } } }
        ),
      });
    }));
    render(<PayoutsPage />);
    expect(await screen.findByText('BAT-2026-05')).toBeInTheDocument();
  });

  it('PAY3: renders transaction partner name from API response', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      callCount++;
      const isFirst = callCount <= 1;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(
          isFirst
            ? { success: true, data: { batches: MOCK_BATCHES, pagination: { page: 1, limit: 20, total: 1, pages: 1 } } }
            : { success: true, data: { transactions: MOCK_TRANSACTIONS, pagination: { page: 1, limit: 20, total: 1, pages: 1 } } }
        ),
      });
    }));
    render(<PayoutsPage />);
    expect(await screen.findByText('K. Krishnamurthy & Sons')).toBeInTheDocument();
  });

  it('PAY4: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<PayoutsPage />);
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });
});
