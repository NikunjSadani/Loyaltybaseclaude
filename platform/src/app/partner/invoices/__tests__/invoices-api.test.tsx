/// <reference types="vitest/globals" />
/**
 * PINV — Partner Invoice list page API wiring
 *
 * PINV1: shows loading spinner on mount
 * PINV2: renders invoice number from API response
 * PINV3: shows error message when fetch fails
 * PINV4: shows "No invoices yet" when API returns empty list
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import PartnerInvoiceListPage from '../page';

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

const MOCK_INVOICES = [
  {
    id: 'inv1',
    invoiceNumber: 'TGSL-VIS-OUT001-202604-001',
    invoiceDate: '2026-04-15T00:00:00.000Z',
    totalAmountPaise: 2200000,
    netAmountPaise: 1980000,
    processedAt: '2026-04-20T00:00:00.000Z',
    lineItems: [{ id: 'li1', quantity: 10, unitPricePaise: 220000 }],
  },
];

afterEach(() => { vi.unstubAllGlobals(); });

describe('PINV — Partner Invoice list API wiring', () => {
  it('PINV1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<PartnerInvoiceListPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('PINV2: renders invoice number from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: {
            invoices: MOCK_INVOICES,
            pagination: { page: 1, limit: 20, total: 1, pages: 1 },
          },
        }),
    }));
    render(<PartnerInvoiceListPage />);
    expect(await screen.findByText('TGSL-VIS-OUT001-202604-001')).toBeInTheDocument();
  });

  it('PINV3: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<PartnerInvoiceListPage />);
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });

  it('PINV4: shows "No invoices yet" when API returns empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { invoices: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } },
        }),
    }));
    render(<PartnerInvoiceListPage />);
    expect(await screen.findByText(/no invoices yet/i)).toBeInTheDocument();
  });
});
