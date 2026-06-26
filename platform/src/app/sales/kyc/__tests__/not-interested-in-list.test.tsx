/**
 * "Not Interested" outlets (Outlet.kycIntent = NOT_INTERESTED, set when a sales rep
 * marks an outlet not-interested) must show DISTINCTLY in the sales KYC list for the
 * rep AND their downline — for ALL sales roles (not just the field roles that enroll).
 *
 * They are NON-actionable for sales: the row is a plain (non-link) element, NOT a link
 * to /sales/kyc/new, because only an admin can re-open such an outlet for enrollment.
 *
 * Run: npx vitest run src/app/sales/kyc/__tests__/not-interested-in-list.test.tsx
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
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

const NOT_INTERESTED_OUTLETS = {
  success: true,
  data: { outlets: [
    { id: 'o1', name: 'Verma Traders', outletCode: 'OUT-2026-001', mobile: '9876543210', kycStatus: 'NOT_INTERESTED' },
  ] },
};

beforeEach(() => {
  vi.clearAllMocks();
  searchStr = '';
  localStorage.clear();
  // A non-enrolling manager role (RSM) — Not-Interested must still surface for the
  // rep + their downline, even though this role does NOT do enrollment (XSR/SO only).
  localStorage.setItem('loyaltybase_sales_role', 'RSM');
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve(NOT_INTERESTED_OUTLETS) });
    }
    if (typeof url === 'string' && url.includes('/api/kyc')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { submissions: [] } }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: {} }) });
  });
});

describe('KYC list — NOT_INTERESTED outlets surface distinctly and non-actionable', () => {
  it('shows the not-interested outlet with the "Not Interested" badge', async () => {
    render(<KYCListPage />);
    await waitFor(() => expect(screen.getByText('Verma Traders')).toBeInTheDocument());
    // Scope to the row so we target the BADGE, not the new "Not Interested" filter <option>.
    const row = screen.getByTestId('kyc-not-interested-row');
    expect(within(row).getByText('Not Interested')).toBeInTheDocument();
    expect(screen.queryByText('No KYC submissions')).not.toBeInTheDocument();
    // distinct, admin-re-open subtitle
    expect(screen.getByText(/Marked not interested/)).toBeInTheDocument();
  });

  it('renders the not-interested row as a NON-link (admin must re-open — no enrollment link)', async () => {
    render(<KYCListPage />);
    const name = await screen.findByText('Verma Traders');
    // The row is a plain element, not an <a> → no closest anchor.
    expect(name.closest('a')).toBeNull();
    // And there is definitely no enrollment link pointing at it.
    const enrollLinks = screen.queryAllByRole('link').filter(
      (el) => el.getAttribute('href') === '/sales/kyc/new',
    );
    expect(enrollLinks).toHaveLength(0);
  });
});
