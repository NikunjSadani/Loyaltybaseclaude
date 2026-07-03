/// <reference types="vitest/globals" />
/**
 * Regression (owner UAT — DAMD0555): a re-KYC'd outlet is ASSIGNMENT-scoped. The admin
 * re-KYC upload sets Outlet.reKycFlags; buildOutlets (/api/sales/outlets) returns
 * kycStatus RE_KYC_REQUIRED. But the outlet's ORIGINAL submission may have been filed by
 * a DIFFERENT rep (e.g. the assignee's SO), so it never comes back from the
 * submitter-scoped /api/kyc for a leaf rep. The KYC list must surface the re-KYC outlet
 * from /api/sales/outlets so it appears under the Re-KYC filter + tasks.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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

const REKYC_OUTLET = {
  success: true,
  data: { outlets: [
    { id: 'o1', kycId: 'kyc-1', name: 'Verma Traders', outletCode: 'DAMD0555', mobile: '9000000001', kycStatus: 'RE_KYC_REQUIRED', type: 'SSS' },
  ] },
};

beforeEach(() => {
  vi.clearAllMocks();
  searchStr = '';
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'XSR');
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve(REKYC_OUTLET) });
    }
    // Submitter-scoped /api/kyc returns NOTHING for this leaf rep (his SO submitted it).
    if (typeof url === 'string' && url.includes('/api/kyc')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { submissions: [] } }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: {} }) });
  });
});

describe('KYC list — re-KYC outlets surface (assignment-scoped)', () => {
  it('shows a RE_KYC_REQUIRED outlet from /api/sales/outlets even when /api/kyc has no submission for it', async () => {
    render(<KYCListPage />);
    await waitFor(() => expect(screen.getByText('Verma Traders')).toBeInTheDocument());
    expect(screen.getByText('DAMD0555')).toBeInTheDocument();
    expect(screen.queryByText('No KYC submissions')).not.toBeInTheDocument();
  });

  it('deep-links the re-KYC entry to the submission detail (kycId), whose getOne is assignee-aware', async () => {
    render(<KYCListPage />);
    const row = await screen.findByText('Verma Traders');
    expect(row.closest('a')).toHaveAttribute('href', '/sales/kyc/kyc-1');
  });

  it('is present under the ?status=RE_KYC_REQUIRED deep-link filter', async () => {
    searchStr = 'status=RE_KYC_REQUIRED';
    render(<KYCListPage />);
    await waitFor(() => expect(screen.getByText('Verma Traders')).toBeInTheDocument());
  });
});
