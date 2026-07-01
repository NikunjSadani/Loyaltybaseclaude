/// <reference types="vitest/globals" />
/**
 * ADMI — Admin Invoice list page API wiring
 *
 * ADMI1: shows loading spinner on mount
 * ADMI2: renders invoice number from real backend shape (paise ÷ 100)
 * ADMI3: shows error message when fetch fails
 * ADMI4: shows "No invoices match your filters" when API returns empty list
 * ADMI5: calls /api/admin/invoices (not the old /api/sales/invoices)
 * ADMI6: displays totalPaise ÷ 100 as ₹ formatted amount
 * ADMI7: "Mark Paid" button is shown for GENERATED invoices
 * ADMI8: "Mark Paid" button is absent for PAID invoices
 * ADMI9: "Generate Invoices" button is present in the header
 * ADMI12: list request sends ?page&limit (server pagination)
 * ADMI13: Prev/Next controls render + Next advances the page (server refetch)
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AdminInvoiceListPage from '../page';

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
    status: 'GENERATED',
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
  {
    id: 'inv2',
    invoiceNumber: 'TGSL-VIS-OUT002-202604-001',
    invoiceNumberEdited: false,
    partnerId: 'p2',
    outletCode: 'OUT002',
    period: '2026-04',
    invoiceDate: '2026-04-01T00:00:00.000Z',
    status: 'PAID',
    subtotalPaise: 300000,   // ₹3,000
    gstPaise: 0,
    gstType: null,
    totalPaise: 300000,       // ₹3,000
    createdAt: '2026-04-01T00:00:00.000Z',
    snapshot: {
      outletCode: 'OUT002',
      outletName: 'Patel Store',
      firmName: 'Patel Enterprises',
      partnerName: 'Ankit Patel',
      retailerState: 'Gujarat',
      retailerGstin: null,
      sacCode: '998361',
      description: 'Marketing visibility services — April 2026',
    },
  },
];

/** Real backend list() shape: { invoices, pagination } (NOT a bare array). */
const wrap = (invoices: unknown[]) => ({
  invoices,
  pagination: { page: 1, limit: 20, total: invoices.length, pages: 1 },
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('ADMI — Admin Invoice list API wiring', () => {
  it('ADMI1: shows loading spinner on mount', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise(() => {}), // never resolves
    }));
    render(<AdminInvoiceListPage />);
    expect(screen.getByLabelText('Loading')).toBeInTheDocument();
  });

  it('ADMI2: renders invoice number from real backend shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: wrap(MOCK_BACKEND_INVOICES),
        }),
    }));
    render(<AdminInvoiceListPage />);
    expect(await screen.findByText('TGSL-VIS-OUT001-202604-001')).toBeInTheDocument();
  });

  it('ADMI3: shows error message when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    render(<AdminInvoiceListPage />);
    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });

  it('ADMI4: shows "No invoices match your filters" when API returns empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: wrap([]),
        }),
    }));
    render(<AdminInvoiceListPage />);
    expect(await screen.findByText(/no invoices match your filters/i)).toBeInTheDocument();
  });

  it('ADMI5: fetches from /api/admin/invoices', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: wrap([]) }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminInvoiceListPage />);
    await screen.findByText(/no invoices match your filters/i);
    const url: string = fetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(/\/api\/admin\/invoices/);
  });

  it('ADMI6: displays totalPaise ÷ 100 as ₹ formatted amount', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, data: wrap(MOCK_BACKEND_INVOICES) }),
    }));
    render(<AdminInvoiceListPage />);
    // totalPaise for inv1 = 590000 → ₹5,900.00
    expect(await screen.findByText(/₹5,900\.00/)).toBeInTheDocument();
  });

  it('ADMI7: "Mark Paid" button shown for GENERATED invoices', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, data: wrap(MOCK_BACKEND_INVOICES) }),
    }));
    render(<AdminInvoiceListPage />);
    const markPaidBtns = await screen.findAllByText(/mark paid/i);
    // Only inv1 is GENERATED, inv2 is PAID
    expect(markPaidBtns).toHaveLength(1);
  });

  it('ADMI8: "Mark Paid" button absent for PAID invoices (only 1 button total)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: wrap([{ ...MOCK_BACKEND_INVOICES[1] }]), // only the PAID one
        }),
    }));
    render(<AdminInvoiceListPage />);
    await screen.findByText('TGSL-VIS-OUT002-202604-001');
    expect(screen.queryByText(/mark paid/i)).not.toBeInTheDocument();
  });

  it('ADMI9: "Generate Invoices" button is visible in the header', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: wrap([]) }),
    }));
    render(<AdminInvoiceListPage />);
    await screen.findByText(/no invoices match your filters/i);
    expect(screen.getByText(/generate invoices/i)).toBeInTheDocument();
  });

  it('ADMI12: list request sends ?page&limit (server pagination)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: wrap([]) }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminInvoiceListPage />);
    await screen.findByText(/no invoices match your filters/i);
    // The main list call carries page + limit query params.
    const listCall = fetchMock.mock.calls
      .map((c) => c[0] as string)
      .find((u) => typeof u === 'string' && /\/api\/admin\/invoices\?/.test(u) && u.includes('limit=50'));
    expect(listCall).toBeDefined();
    expect(listCall).toMatch(/page=1/);
    expect(listCall).toMatch(/limit=50/);
  });

  it('ADMI13: Prev/Next render for multi-page results and Next advances the page', async () => {
    // page 1 of 2 → Next enabled, Prev disabled. Clicking Next refetches page 2.
    const page1 = {
      invoices: [MOCK_BACKEND_INVOICES[0]],
      pagination: { page: 1, limit: 50, total: 60, pages: 2 },
    };
    const page2 = {
      invoices: [MOCK_BACKEND_INVOICES[1]],
      pagination: { page: 2, limit: 50, total: 60, pages: 2 },
    };
    let listCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      // The period-options loader uses limit=100; main list uses limit=50.
      if (typeof url === 'string' && url.includes('limit=50')) {
        listCalls += 1;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: listCalls === 1 ? page1 : page2 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: wrap([]) }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AdminInvoiceListPage />);
    // Page-1 invoice visible + Next control present.
    await screen.findByText('TGSL-VIS-OUT001-202604-001');
    const nextBtn = screen.getByText('Next');
    expect(nextBtn).toBeInTheDocument();

    fireEvent.click(nextBtn);

    // Server refetch swaps to page-2 content.
    await screen.findByText('TGSL-VIS-OUT002-202604-001');
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });

  it('ADMI10: Generate panel is shown when "Generate Invoices" is clicked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: wrap([]) }),
    }));
    render(<AdminInvoiceListPage />);
    await screen.findByText(/no invoices match your filters/i);
    fireEvent.click(screen.getByText(/generate invoices/i));
    expect(screen.getByText(/generate invoices for a month/i)).toBeInTheDocument();
  });

  it('ADMI11: "Export Excel" button calls the backend export endpoint (#44)', async () => {
    // createObjectURL/revokeObjectURL are not in jsdom — stub them.
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/export')) {
        return Promise.resolve({
          ok: true,
          headers: { get: () => 'attachment; filename="visibility-invoices.xlsx"' },
          blob: () => Promise.resolve(new Blob(['x'])),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: wrap(MOCK_BACKEND_INVOICES) }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AdminInvoiceListPage />);
    await screen.findByText('TGSL-VIS-OUT001-202604-001');
    fireEvent.click(screen.getByText(/export excel/i));

    // The export endpoint must have been called.
    const calledExport = fetchMock.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('/api/admin/invoices/export'),
    );
    expect(calledExport).toBe(true);
  });
});
