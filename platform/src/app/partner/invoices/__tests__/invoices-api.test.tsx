/// <reference types="vitest/globals" />
/**
 * PINV — Partner Invoice list page API wiring
 *
 * PINV1: shows loading spinner on mount
 * PINV2: renders invoice number from real backend shape (paise ÷ 100)
 * PINV3: shows error message when fetch fails
 * PINV4: shows "No invoices yet" when API returns empty list
 * PINV5: displays total paise ÷ 100 as ₹ amount
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

/** Real backend shape — money is integer paise */
const MOCK_BACKEND_INVOICES = [
  {
    id: 'inv1',
    invoiceNumber: 'TGSL-VIS-OUT001-202604-001',
    invoiceNumberEdited: false,
    partnerId: 'p1',
    outletCode: 'OUT001',
    period: '2026-04',
    invoiceDate: '2026-04-01T00:00:00.000Z',
    status: 'PAID',
    subtotalPaise: 500000,   // ₹5,000
    gstPaise: 90000,          // ₹900
    gstType: 'CGST_SGST',
    totalPaise: 590000,       // ₹5,900
    createdAt: '2026-04-01T00:00:00.000Z',
    snapshot: {
      outletCode: 'OUT001',
      outletName: 'Sharma Kirana',
      firmName: 'Sharma Enterprises',
      partnerName: 'Rajesh Sharma',
      retailerState: 'West Bengal',
      retailerGstin: '19ABCPS1234D1Z5',
      sacCode: '998361',
      description: 'Marketing visibility services — April 2026',
    },
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

  it('PINV2: renders invoice number from real backend shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: MOCK_BACKEND_INVOICES,
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
          data: [],
        }),
    }));
    render(<PartnerInvoiceListPage />);
    expect(await screen.findByText(/no invoices yet/i)).toBeInTheDocument();
  });

  it('PINV5: displays totalPaise ÷ 100 as ₹ formatted amount', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: MOCK_BACKEND_INVOICES,
        }),
    }));
    render(<PartnerInvoiceListPage />);
    // totalPaise = 590000 → ₹5,900.00
    expect(await screen.findByText(/₹5,900\.00/)).toBeInTheDocument();
  });
});
