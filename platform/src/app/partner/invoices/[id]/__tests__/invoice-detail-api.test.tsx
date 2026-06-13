/// <reference types="vitest/globals" />
/**
 * PINVD — Partner Invoice detail page API wiring
 *
 * PINVD1: shows loading spinner on mount
 * PINVD2: renders invoice number from API response
 * PINVD3: shows error message when fetch fails
 * PINVD4: shows "Invoice not found" when API returns 404
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

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

// Mock react `use` hook for params
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('react');
  return {
    ...actual,
    use: vi.fn((val: unknown) => {
      if (val && typeof val === 'object' && 'then' in val) {
        return { id: 'inv001' };
      }
      return actual.use(val as React.Context<unknown>);
    }),
  };
});

import PartnerInvoiceDetailPage from '../page';

const MOCK_INVOICE = {
  id: 'inv001',
  invoiceNumber: 'TGSL-VIS-OUT001-202604-001',
  invoiceDate: '2026-04-15T00:00:00.000Z',
  totalAmountPaise: 2200000,
  netAmountPaise: 1980000,
  processedAt: '2026-04-20T00:00:00.000Z',
  salesUploadId: 'su1',
  outletId: 'out1',
  lineItems: [{ id: 'li1', quantity: 10, unitPricePaise: 220000 }],
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('PINVD — Partner Invoice detail API wiring', () => {
  it('PINVD1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}),
    }));
    render(<PartnerInvoiceDetailPage params={Promise.resolve({ id: 'inv001' })} />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('PINVD2: renders invoice number from API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, data: { invoice: MOCK_INVOICE } }),
    }));
    render(<PartnerInvoiceDetailPage params={Promise.resolve({ id: 'inv001' })} />);
    const matches = await screen.findAllByText('TGSL-VIS-OUT001-202604-001');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('PINVD3: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<PartnerInvoiceDetailPage params={Promise.resolve({ id: 'inv001' })} />);
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });

  it('PINVD4: shows "Invoice not found" when API returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ success: false, error: 'Invoice not found' }),
    }));
    render(<PartnerInvoiceDetailPage params={Promise.resolve({ id: 'NOTFOUND' })} />);
    expect(await screen.findByText(/invoice not found/i)).toBeInTheDocument();
  });
});
