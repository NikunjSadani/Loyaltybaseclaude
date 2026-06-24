/**
 * Regression: an outlet that was rejected and then re-submitted has TWO KycSubmission
 * rows. The KYC Submissions list must show that outlet ONCE — with its latest (current)
 * status — not once per historical attempt.
 *
 * Run: npx vitest run src/app/sales/kyc/__tests__/dedupe-by-outlet.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

let searchStr = '';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(searchStr) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import KYCListPage from '../page';

function sub(id: string, status: string, updatedAt: string) {
  return {
    id, status, createdAt: updatedAt, updatedAt, userId: 'u1',
    user: { id: 'u1', name: 'Rep Anil', phone: '9000000003' },
    partner: {
      id: 'p1', businessName: 'Verma Traders', ownerName: 'Suresh', phone: '7766554433',
      outlets: [{ name: 'Verma Traders', outletCode: 'OUT-2026-001', phone: '7766554433' }],
    },
  };
}

// Same outlet (OUT-2026-001): an old REJECTED attempt + a newer PENDING_GIFSY resubmission.
const SUBMISSIONS = {
  success: true,
  data: { submissions: [
    sub('s-old', 'REJECTED',      '2026-06-23T10:00:00.000Z'),
    sub('s-new', 'PENDING_GIFSY', '2026-06-24T10:00:00.000Z'),
  ] },
};

beforeEach(() => {
  vi.clearAllMocks();
  searchStr = '';
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'SO');
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { outlets: [] } }) });
    }
    if (typeof url === 'string' && url.includes('/api/sales/team')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { members: [] } }) });
    }
    if (typeof url === 'string' && url.includes('/api/kyc')) {
      return Promise.resolve({ json: () => Promise.resolve(SUBMISSIONS) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: {} }) });
  });
});

describe('KYC list — one row per outlet, latest status', () => {
  it('collapses the rejected + resubmitted rows to a single current entry', async () => {
    render(<KYCListPage />);
    // The outlet appears exactly ONCE.
    await waitFor(() => expect(screen.getAllByText('Verma Traders').length).toBe(1));
    // …showing the LATEST status badge (Awaiting Gifsy). The superseded "Rejected"
    // attempt is gone from the rows — the only "Rejected" left is the filter <option>.
    expect(screen.getByText('Awaiting Gifsy')).toBeInTheDocument();
    const rejectedNodes = screen.queryAllByText('Rejected').filter((n) => n.tagName !== 'OPTION');
    expect(rejectedNodes).toHaveLength(0);
  });
});
