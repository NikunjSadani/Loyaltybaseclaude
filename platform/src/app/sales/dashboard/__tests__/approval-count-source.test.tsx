/**
 * Regression: the dashboard "Approval Required" count must derive from KYC SUBMISSIONS
 * (/api/kyc) — the same source as the KYC Submissions list — NOT from /api/sales/outlets.
 * A submission whose partner has no linked outlet (the "Anil Sharma" case) never appears
 * in the outlets list, so the old outlet-derived count silently dropped it (showed 1
 * when the list showed 2).
 *
 * Run: npx vitest run src/app/sales/dashboard/__tests__/approval-count-source.test.tsx
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/task-config', () => ({
  fetchTaskConfig: () => Promise.resolve({ customTaskItems: [], customTaskLabel: 'Reminders' }),
}));
vi.mock('@/lib/banner', () => ({
  fetchBanners: () => Promise.resolve({ banners: [] }),
  getActiveSalesBanners: () => [],
  getBgStyle: () => ({}),
}));
vi.mock('@/lib/schemes', () => ({ fetchAllSchemes: () => Promise.resolve([]) }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import SalesDashboardPage from '../page';

// Two submissions both awaiting SO approval: one linked to an outlet, one with NO outlet.
const KYC_SUBS = {
  success: true,
  data: { submissions: [
    { id: 'sub-patel', status: 'PENDING_SO_APPROVAL', updatedAt: '2026-06-25T00:00:00Z',
      user: { name: 'Rep A' }, partner: { businessName: 'Patel Kirana', outlets: [{ name: 'Patel Kirana', outletCode: 'OUT-2026-002111' }] } },
    { id: 'sub-anil',  status: 'PENDING_SO_APPROVAL', updatedAt: '2026-06-24T00:00:00Z',
      user: { name: 'Anil Sharma' }, partner: null }, // no linked outlet
  ] },
};

// The outlets list only has the ONE outlet (proves the old outlet-based count = 1).
const OUTLETS = {
  success: true,
  data: { outlets: [
    { id: 'o-patel', name: 'Patel Kirana', mobile: '7', city: 'Mumbai', type: 'SSS', kycStatus: 'PENDING_SO_APPROVAL', kycId: 'sub-patel' },
  ] },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'SO');
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/kyc')) {
      return Promise.resolve({ json: () => Promise.resolve(KYC_SUBS) });
    }
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve(OUTLETS) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { period: null, outletCount: 1, kpis: [], trend: [] } }) });
  });
});

describe('Sales dashboard — Approval Required count comes from submissions', () => {
  it('counts BOTH submissions awaiting SO, including the one with no linked outlet', async () => {
    render(<SalesDashboardPage />);
    const label = await screen.findByText('Approval Required');
    const row = label.closest('a')!;            // the group summary row
    expect(within(row).getByText('2')).toBeInTheDocument();   // 2, not 1
  });
});
