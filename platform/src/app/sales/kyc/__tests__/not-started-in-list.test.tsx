/**
 * Regression: the KYC Submissions list must include the rep's NOT_STARTED
 * (un-enrolled) outlets — they have no submission so they never come from
 * /api/kyc; they're pulled from /api/sales/outlets and shown under "Pending KYC",
 * linking to enrollment. This is the page the dashboard "KYC to be done" task
 * deep-links to (?status=NOT_STARTED).
 *
 * Run: npx vitest run src/app/sales/kyc/__tests__/not-started-in-list.test.tsx
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

const NOT_STARTED_OUTLETS = {
  success: true,
  data: { outlets: [
    { id: 'o1', name: 'Verma Traders', outletCode: 'OUT-2026-001', mobile: '9876543210', kycStatus: 'NOT_STARTED' },
    { id: 'o2', name: 'Patel Kirana',  outletCode: 'OUT-2026-002', mobile: '9876500000', kycStatus: 'NOT_STARTED' },
  ] },
};

beforeEach(() => {
  vi.clearAllMocks();
  searchStr = '';
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'XSR'); // field role that enrolls
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve(NOT_STARTED_OUTLETS) });
    }
    if (typeof url === 'string' && url.includes('/api/kyc')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { submissions: [] } }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: {} }) });
  });
});

describe('KYC list — NOT_STARTED outlets surface as actionable entries', () => {
  it('shows un-enrolled outlets (no submission) instead of an empty list', async () => {
    render(<KYCListPage />);
    await waitFor(() => expect(screen.getByText('Verma Traders')).toBeInTheDocument());
    expect(screen.getByText('Patel Kirana')).toBeInTheDocument();
    expect(screen.queryByText('No KYC submissions')).not.toBeInTheDocument();
    // outlet code chip is populated (not the old blank '')
    expect(screen.getByText('OUT-2026-001')).toBeInTheDocument();
  });

  it('links a NOT_STARTED entry to enrollment, deep-linking the outlet so the wizard pre-selects it', async () => {
    render(<KYCListPage />);
    const row = await screen.findByText('Verma Traders');
    const link = row.closest('a');
    // Deep-links ?outletId=<Outlet CUID> — the new-KYC wizard reads it and auto-selects
    // the outlet, so the rep doesn't have to pick it again on the next page.
    expect(link).toHaveAttribute('href', '/sales/kyc/new?outletId=o1');
    expect(screen.getAllByText('Tap to start enrollment').length).toBeGreaterThan(0);
  });

  it('the dashboard deep-link ?status=NOT_STARTED resolves to the Pending KYC filter and shows them', async () => {
    searchStr = 'status=NOT_STARTED';
    render(<KYCListPage />);
    await waitFor(() => expect(screen.getByText('Verma Traders')).toBeInTheDocument());
    // the status dropdown reflects the Pending KYC filter
    const select = screen.getByTestId('kyc-status-filter') as HTMLSelectElement;
    expect(select.value).toBe('PENDING_KYC');
  });

  it('ASM (now an enroll role) sees the New Enrollment button + NOT_STARTED rows', async () => {
    localStorage.setItem('loyaltybase_sales_role', 'ASM');
    render(<KYCListPage />);
    await waitFor(() => expect(screen.getByText('Verma Traders')).toBeInTheDocument());
    expect(screen.getByText('New Enrollment')).toBeInTheDocument();
    // NOT_STARTED rows are actionable (link to enrollment) for ASM too.
    expect(screen.getAllByText('Tap to start enrollment').length).toBeGreaterThan(0);
  });

  it('a non-enroll manager (RSM) sees neither the New Enrollment button nor NOT_STARTED rows', async () => {
    localStorage.setItem('loyaltybase_sales_role', 'RSM');
    render(<KYCListPage />);
    // No submissions + RSM does not enroll → no NOT_STARTED synthesis → empty list.
    await waitFor(() => expect(screen.getByText('No KYC submissions')).toBeInTheDocument());
    expect(screen.queryByText('New Enrollment')).not.toBeInTheDocument();
    expect(screen.queryByText('Verma Traders')).not.toBeInTheDocument();
  });
});
