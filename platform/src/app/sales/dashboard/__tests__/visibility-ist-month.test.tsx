/**
 * Sales dashboard — the AMOUNT_UPLOAD visibility month is the IST calendar month, never UTC (L6).
 *
 * At 2026-11-30T19:00Z it is already 1 Dec 00:30 IST, so the dashboard must ask for "2026-12"
 * (the old `toISOString().slice(0, 7)` asked for "2026-11"). Time is computed from a fixed instant
 * on purpose: the point is the UTC/IST month boundary, not a date in the future.
 *
 * Run: npx vitest run src/app/sales/dashboard/__tests__/visibility-ist-month.test.tsx
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/task-config', () => ({
  fetchTaskConfig: () => Promise.resolve({ customTaskItems: [], customTaskLabel: 'Reminders' }),
  fetchTaskConfigResult: () => Promise.resolve({ config: { customTaskItems: [], customTaskLabel: 'Reminders' }, ok: true }),
}));
vi.mock('@/lib/banner', () => ({
  fetchBanners: () => Promise.resolve({ banners: [] }),
  fetchBannersResult: () => Promise.resolve({ banners: [], popups: [], ok: true }),
  fetchSalesBannersResult: () => Promise.resolve({ banners: [], ok: true }),
  SALES_BANNERS_TTL_MS: 60_000,
  getActiveSalesBanners: () => [],
  getBgStyle: () => ({}),
}));
vi.mock('@/lib/schemes', () => ({
  schemeApi: { listSalesEligible: () => Promise.resolve({ success: true, data: { schemes: [] } }) },
}));
vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: () => ({ slug: 'deoleo' }),
}));
vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => ({ visibilityEnabled: true, visibilityCaptureMode: 'AMOUNT_UPLOAD', outletPrograms: [], paceAmberThreshold: 10 }),
}));
const fetchStatuses = vi.fn((..._args: unknown[]) => Promise.resolve({}));
vi.mock('@/lib/visibility-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/visibility-upload')>()),
  fetchOutletVisibilityStatuses: (...args: unknown[]) => fetchStatuses(...args),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import SalesDashboardPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-30T19:00:00.000Z')); // = 1 Dec 2026, 00:30 IST
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'SO');
  fetchMock.mockImplementation((url: string) => {
    const u = typeof url === 'string' ? url : '';
    if (u.includes('/api/sales/outlets')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { outlets: [
        { id: 'o1', outletCode: 'OUT-1', name: 'Shop 1', type: 'SSS', kycStatus: 'APPROVED' },
      ] } }) });
    }
    if (u.includes('/api/sales/targets')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { period: null, outletCount: 1, kpis: [], trend: [] } }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  });
});

afterEach(() => { vi.useRealTimers(); });

describe('Sales dashboard — visibility month in IST', () => {
  it('asks for the IST month (2026-12) just after IST midnight on the 1st, not the UTC month', async () => {
    render(<SalesDashboardPage />);
    await waitFor(() => expect(fetchStatuses).toHaveBeenCalled());
    expect(fetchStatuses.mock.calls[0][1]).toBe('2026-12');
  });
});
