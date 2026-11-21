/** Staging round item 5: the sales dashboard never calls the partner banners endpoint (403 + console error). */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/schemes', () => ({
  schemeApi: { listSalesEligible: () => Promise.resolve({ success: true, data: { schemes: [] } }) },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import SalesDashboardPage from '../page';

beforeEach(() => {
  fetchMock.mockReset();
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'SO');
  fetchMock.mockImplementation(() => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({ success: true, data: { outlets: [], submissions: [], period: null, outletCount: 0, kpis: [], trend: [] } }),
  }));
});

describe('sales dashboard — no partner banners call', () => {
  it('loads with no request to /api/partner/banners', async () => {
    render(<SalesDashboardPage />);
    expect(await screen.findByText('View all')).toBeInTheDocument(); // the Tasks card rendered → all reads settled
    expect(fetchMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes('/api/partner/banners'))).toBe(false);
  });
});
