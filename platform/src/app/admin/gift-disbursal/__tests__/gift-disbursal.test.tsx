/// <reference types="vitest/globals" />
/**
 * Gift Disbursal report — renders rows + totals, applies filters, and scopes by role:
 * a GIFSY_ADMIN sees the Tenant filter/column and can send clientId; a CLIENT_ADMIN
 * (tenant scope) never sees the Tenant filter and never sends clientId.
 *
 * Run: npx vitest run src/app/admin/gift-disbursal/__tests__/gift-disbursal.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const get = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: { get: (url: string) => get(url) },
  authHeader: () => ({}),
}));
vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }));

// Role drives the scope split. Mutable so each test picks the persona.
let mockRole = 'GIFSY_ADMIN';
vi.mock('@/lib/admin-session', () => ({
  useAdminSession: () => ({ role: mockRole, clientId: 'gifsy', name: 'T', userId: '', canManageSchemes: true }),
}));

import GiftDisbursalPage from '../page';
import type { DisbursalReport } from '@/lib/gift-disbursal';

const REPORT: DisbursalReport = {
  scope: 'GIFSY',
  rows: [
    {
      clientId: 'deoleo', clientName: 'Deoleo',
      vendorId: 'v1', vendorName: 'Acme',
      sourceType: 'VENDOR',
      orderCount: 10, deliveredCount: 7, deliveredValuePaise: 700000,
      statusBreakdown: { PLACED: 1, DISPATCHED: 2, DELIVERED: 7, CANCELLED: 0 },
    },
  ],
  totals: { orderCount: 10, deliveredCount: 7, deliveredValuePaise: 700000 },
  clients: [{ id: 'deoleo', name: 'Deoleo' }],
  vendors: [{ id: 'v1', name: 'Acme' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRole = 'GIFSY_ADMIN';
  get.mockResolvedValue({ success: true, data: REPORT });
});

describe('GiftDisbursalPage', () => {
  it('renders rows + the delivered-value total', async () => {
    render(<GiftDisbursalPage />);
    const row = await screen.findByTestId('disbursal-row');
    expect(row).toBeInTheDocument();
    // "Acme" also appears in the vendor filter <option>; scope to the row.
    expect(within(row).getByText('Acme')).toBeInTheDocument();
    expect(screen.getByTestId('disbursal-total-value')).toHaveTextContent('7,000');
  });

  it('names the value column "Delivered value (₹)" (parity with the Excel + DELIVERED-only basis)', async () => {
    render(<GiftDisbursalPage />);
    await screen.findByTestId('disbursal-row');
    expect(screen.getByRole('columnheader', { name: /delivered value \(₹\)/i })).toBeInTheDocument();
    // The old ambiguous "Value (₹)" header is gone.
    expect(screen.queryByRole('columnheader', { name: /^value \(₹\)$/i })).not.toBeInTheDocument();
  });

  it('GIFSY scope: shows the Tenant filter + column and can send clientId', async () => {
    render(<GiftDisbursalPage />);
    await screen.findByTestId('disbursal-row');
    expect(screen.getByTestId('filter-tenant')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('filter-tenant'), { target: { value: 'deoleo' } });
    fireEvent.change(screen.getByTestId('filter-vendor'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByTestId('apply-filters-btn'));

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(expect.stringContaining('clientId=deoleo')),
    );
    expect(get).toHaveBeenLastCalledWith(expect.stringContaining('vendorId=v1'));
  });

  it('TENANT scope (CLIENT_ADMIN): no Tenant filter, and clientId is never sent', async () => {
    mockRole = 'CLIENT_ADMIN';
    render(<GiftDisbursalPage />);
    await screen.findByTestId('disbursal-row');

    // No tenant filter for a tenant admin.
    expect(screen.queryByTestId('filter-tenant')).not.toBeInTheDocument();

    // Even if a vendor filter is applied, clientId must never appear in the query.
    fireEvent.change(screen.getByTestId('filter-vendor'), { target: { value: 'v1' } });
    fireEvent.click(screen.getByTestId('apply-filters-btn'));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.stringContaining('vendorId=v1')));
    for (const [url] of get.mock.calls) {
      expect(url).not.toContain('clientId=');
    }
  });

  it('shows an empty state when there are no disbursals', async () => {
    get.mockResolvedValue({ success: true, data: { rows: [] } });
    render(<GiftDisbursalPage />);
    expect(await screen.findByTestId('disbursal-empty')).toBeInTheDocument();
  });

  it('surfaces an error with a retry', async () => {
    get.mockResolvedValue({ success: false, error: 'Boom' });
    render(<GiftDisbursalPage />);
    const err = await screen.findByTestId('disbursal-error');
    expect(within(err).getByText('Boom')).toBeInTheDocument();
  });
});
