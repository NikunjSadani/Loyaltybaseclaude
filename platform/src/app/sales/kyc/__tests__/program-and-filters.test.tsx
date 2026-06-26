/**
 * Surfaces Program Name + Category on the sales KYC list, and the new
 * Outlet-Type / Program filter dropdowns.
 *
 *  (1) a row shows its program name text (rendered from the API projection).
 *  (2) selecting the Program filter narrows the visible rows.
 *
 * Mirrors the not-started-in-list / filter-dropdown test pattern: mock
 * next/navigation + next/link, stub global fetch for /api/kyc and
 * /api/sales/outlets, role via localStorage (getRole reads it).
 *
 * Run: npx vitest run src/app/sales/kyc/__tests__/program-and-filters.test.tsx
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

let searchStr = '';
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchStr),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import KYCListPage from '../page';

// Two submitted KYCs (from /api/kyc) on different programs so the program
// filter has something to narrow. The list renders the OUTLET as identity.
const KYC_SUBMISSIONS = {
  success: true,
  data: {
    submissions: [
      {
        id: 'k1', status: 'APPROVED', createdAt: '2026-06-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z', userId: 'u1',
        user: { id: 'u1', name: 'Rep One', phone: '9000000001' },
        partner: {
          id: 'p1', businessName: 'Verma Traders', ownerName: 'Verma', phone: '9876543210',
          outlets: [{
            name: 'Verma Traders', outletCode: 'OUT-2026-001', phone: '9876543210',
            programName: 'Gold Programme', programCategory: 'Premium',
            outletType: { code: 'SSS' },
          }],
        },
      },
      {
        id: 'k2', status: 'APPROVED', createdAt: '2026-06-02T00:00:00Z',
        updatedAt: '2026-06-02T00:00:00Z', userId: 'u1',
        user: { id: 'u1', name: 'Rep One', phone: '9000000001' },
        partner: {
          id: 'p2', businessName: 'Patel Kirana', ownerName: 'Patel', phone: '9876500000',
          outlets: [{
            name: 'Patel Kirana', outletCode: 'OUT-2026-002', phone: '9876500000',
            programName: 'Silver Programme', programCategory: 'Standard',
            outletType: { code: 'WHOLESALER' },
          }],
        },
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  searchStr = '';
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'XSR'); // field role that enrolls
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { outlets: [] } }) });
    }
    if (typeof url === 'string' && url.includes('/api/kyc')) {
      return Promise.resolve({ json: () => Promise.resolve(KYC_SUBMISSIONS) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: {} }) });
  });
});

describe('KYC list — program surface + Outlet-Type/Program filters', () => {
  it('renders the program name on a row', async () => {
    render(<KYCListPage />);
    await waitFor(() => expect(screen.getByText('Verma Traders')).toBeInTheDocument());
    // The row badge renders "<programName> · <category>" — assert on the combined
    // text so it targets the ROW badge specifically, not the filter <option> (which
    // also contains the bare program name).
    expect(screen.getByText(/Gold Programme · Premium/)).toBeInTheDocument();
    expect(screen.getByText(/Silver Programme · Standard/)).toBeInTheDocument();
  });

  it('the Program filter narrows the visible rows', async () => {
    render(<KYCListPage />);
    await waitFor(() => expect(screen.getByText('Patel Kirana')).toBeInTheDocument());

    const programFilter = screen.getByTestId('kyc-program-filter') as HTMLSelectElement;
    fireEvent.change(programFilter, { target: { value: 'Gold Programme' } });

    await waitFor(() => expect(screen.queryByText('Patel Kirana')).not.toBeInTheDocument());
    expect(screen.getByText('Verma Traders')).toBeInTheDocument();
  });
});
