/**
 * Audit fix 3: a dashboard part is cached only when it succeeded; a failed part with nothing good to keep is called
 * out (role=alert + Retry) — never a silent 0 — and Retry re-asks only for what failed.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/task-config', () => ({
  fetchTaskConfigResult: () => Promise.resolve({ config: { customTaskItems: [], customTaskLabel: 'Reminders' }, ok: true }),
}));
vi.mock('@/lib/banner', () => ({
  fetchBannersResult: () => Promise.resolve({ banners: [], popups: [], ok: true }),
  fetchSalesBannersResult: () => Promise.resolve({ banners: [], ok: true }),
  SALES_BANNERS_TTL_MS: 60_000,
  getActiveSalesBanners: () => [],
  getBgStyle: () => ({}),
  safeCtaUrl: (u?: string) => (u && /^https?:\/\//.test(u) ? u : null),
}));
vi.mock('@/lib/schemes', () => ({
  schemeApi: { listSalesEligible: () => Promise.resolve({ success: true, data: { schemes: [] } }) },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import SalesDashboardPage from '../page';
import { peekCached } from '@/lib/session-cache';

const OUTLETS = { success: true, data: { outlets: [
  { id: 'o1', name: 'Patel Kirana', mobile: '7', city: 'Mumbai', type: 'SSS', kycStatus: 'APPROVED', kycId: 'k1' },
] } };
let kycOk = false;

beforeEach(() => {
  kycOk = false;
  fetchMock.mockReset();
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'SO');
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/api/kyc')) {
      return kycOk
        ? Promise.resolve({ json: () => Promise.resolve({ success: true, data: { submissions: [] } }) })
        : Promise.reject(new Error('network'));
    }
    if (url.includes('/api/sales/outlets')) return Promise.resolve({ json: () => Promise.resolve(OUTLETS) });
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { period: null, outletCount: 1, kpis: [], trend: [] } }) });
  });
});

describe('dashboard partial failure', () => {
  it('a failed /api/kyc is NOT cached, is called out with Retry, and Retry re-fetches only it', async () => {
    render(<SalesDashboardPage />);
    const alert = await screen.findByTestId('dashboard-core-error');
    expect(alert).toHaveTextContent('KYC submissions');
    expect(peekCached('dash:kyc')).toBeUndefined();
    expect(peekCached('dash:outlets')).toBeDefined();

    const outletCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/sales/outlets')).length;
    const before = outletCalls();
    kycOk = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('dashboard-core-error')).toBeNull());
    expect(peekCached('dash:kyc')).toBeDefined();
    expect(outletCalls()).toBe(before); // the good part came from the cache
  });
});
