/// <reference types="vitest/globals" />
/**
 * PINVD — Partner Invoice detail page API wiring
 *
 * PINVD1: shows loading spinner on mount
 * PINVD2: renders invoice number from real backend shape
 * PINVD3: shows error message when fetch fails
 * PINVD4: shows "Invoice not found" when API returns failure
 * PINVD5: displays subtotalPaise ÷ 100 as ₹ amount
 * PINVD6: renders CGST/SGST split (gstPaise ÷ 2 each) for CGST_SGST type
 * PINVD7: renders IGST line for IGST type
 * PINVD8: edit button is absent when status is PAID (locked)
 * PINVD9: recipient (Tech Gifsy) block is rendered from snapshot.recipient
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

/** Real backend shape — money is integer paise */
const MOCK_BACKEND_INVOICE_CGST = {
  id: 'inv001',
  invoiceNumber: 'TGSL-VIS-OUT001-202604-001',
  invoiceNumberEdited: false,
  partnerId: 'p1',
  outletCode: 'OUT001',
  period: '2026-04',
  invoiceDate: '2026-04-01T00:00:00.000Z',
  status: 'GENERATED',
  subtotalPaise: 500000,   // ₹5,000
  gstPaise: 90000,          // ₹900  (CGST ₹450 + SGST ₹450)
  gstType: 'CGST_SGST',
  totalPaise: 590000,       // ₹5,900
  createdAt: '2026-04-01T00:00:00.000Z',
  snapshot: {
    outletCode: 'OUT001',
    outletName: 'Sharma Kirana',
    firmName: 'Sharma Enterprises',
    partnerName: 'Rajesh Sharma',
    mobile: '9876543210',
    retailerState: 'West Bengal',
    retailerGstin: '19ABCPS1234D1Z5',
    panNumber: 'ABCPS1234D',
    entityType: 'INDIVIDUAL',
    gstRegistrationType: 'REGULAR',
    bankName: 'SBI',
    accountNumber: '1234567890',
    ifscCode: 'SBIN0001234',
    sacCode: '998361',
    description: 'Marketing visibility services — April 2026',
    recipient: {
      legalName: 'Tech Gifsy Solutions Limited',
      gstin: '19AABCT1234F1ZA',
      pan: 'AABCT1234F',
      state: 'West Bengal',
      address: '123, Tech Park, Kolkata, West Bengal - 700001',
      sacCode: '998361',
    },
  },
};

const MOCK_BACKEND_INVOICE_PAID = {
  ...MOCK_BACKEND_INVOICE_CGST,
  id: 'inv002',
  status: 'PAID',
};

const MOCK_BACKEND_INVOICE_IGST = {
  ...MOCK_BACKEND_INVOICE_CGST,
  id: 'inv003',
  gstType: 'IGST',
  snapshot: {
    ...MOCK_BACKEND_INVOICE_CGST.snapshot,
    retailerState: 'Maharashtra',
    retailerGstin: '27AABCM1234F1Z3',
  },
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

  it('PINVD2: renders invoice number from real backend shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, data: MOCK_BACKEND_INVOICE_CGST }),
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

  it('PINVD4: shows "Invoice not found" when API returns failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: false, error: 'Invoice not found' }),
    }));
    render(<PartnerInvoiceDetailPage params={Promise.resolve({ id: 'NOTFOUND' })} />);
    expect(await screen.findByText(/invoice not found/i)).toBeInTheDocument();
  });

  it('PINVD5: displays subtotalPaise ÷ 100 as ₹ formatted amount', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, data: MOCK_BACKEND_INVOICE_CGST }),
    }));
    render(<PartnerInvoiceDetailPage params={Promise.resolve({ id: 'inv001' })} />);
    // subtotalPaise = 500000 → ₹5,000.00
    expect(await screen.findByText(/₹5,000\.00/)).toBeInTheDocument();
  });

  it('PINVD6: renders CGST and SGST lines (gstPaise ÷ 2 each) for CGST_SGST type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, data: MOCK_BACKEND_INVOICE_CGST }),
    }));
    render(<PartnerInvoiceDetailPage params={Promise.resolve({ id: 'inv001' })} />);
    // gstPaise = 90000 → CGST = SGST = 45000 paise = ₹450.00 each
    expect(await screen.findByText(/CGST @ 9%/)).toBeInTheDocument();
    expect(await screen.findByText(/SGST @ 9%/)).toBeInTheDocument();
    const cgstAmounts = await screen.findAllByText(/₹450\.00/);
    expect(cgstAmounts.length).toBeGreaterThanOrEqual(2);
  });

  it('PINVD7: renders IGST line for IGST type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, data: MOCK_BACKEND_INVOICE_IGST }),
    }));
    render(<PartnerInvoiceDetailPage params={Promise.resolve({ id: 'inv003' })} />);
    expect(await screen.findByText(/IGST @ 18%/)).toBeInTheDocument();
  });

  it('PINVD8: edit button is absent when status is PAID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, data: MOCK_BACKEND_INVOICE_PAID }),
    }));
    render(<PartnerInvoiceDetailPage params={Promise.resolve({ id: 'inv002' })} />);
    // Wait for page to load
    await screen.findAllByText('TGSL-VIS-OUT001-202604-001');
    expect(screen.queryByText(/edit/i)).not.toBeInTheDocument();
    expect(screen.getByText(/locked after payment/i)).toBeInTheDocument();
  });

  it('PINVD9: recipient (Tech Gifsy) block rendered from snapshot.recipient', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, data: MOCK_BACKEND_INVOICE_CGST }),
    }));
    render(<PartnerInvoiceDetailPage params={Promise.resolve({ id: 'inv001' })} />);
    expect(await screen.findByText('Tech Gifsy Solutions Limited')).toBeInTheDocument();
  });
});
