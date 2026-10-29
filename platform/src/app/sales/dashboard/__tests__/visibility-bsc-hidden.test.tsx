/**
 * Sales dashboard — the Bajaj Visibility summary card is RLP-only (N/A for BSC).
 *
 * BT4: with the RLP/BSC toggle shown, Visibility renders for RLP (SSS, default) and is hidden once
 *      BSC (WHOLESALER) is selected. Needs the visibility pipeline enabled + a non-empty summary, so
 *      gifsy-settings / visibility / visibility-types / sales-tasks are mocked at module level.
 *
 * Run: npx vitest run src/app/sales/dashboard/__tests__/visibility-bsc-hidden.test.tsx
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
vi.mock('@/lib/schemes', () => ({
  schemeApi: { listSalesEligible: () => Promise.resolve({ success: true, data: { schemes: [] } }) },
}));
vi.mock('@/lib/platform/client-config-context', () => ({
  useClientConfig: () => ({ slug: 'bajaj' }),  // isBajaj → the visibility card is Bajaj-scoped.
}));
vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => ({ visibilityEnabled: true, visibilityCaptureMode: 'PHOTO_APPROVAL', outletPrograms: [], paceAmberThreshold: 10 }),
}));
vi.mock('@/lib/visibility', () => ({
  visibilityApi: { getSalesEligible: () => Promise.resolve({ success: true, data: { outlets: [{ outletCode: 'X' }] } }) },
}));
vi.mock('@/lib/visibility-types', () => ({
  summarizeVisibilityCaptures: () => ({ total: 5, approved: 2, partial: 0, in_review: 1, pending: 2, rejected: 0 }),
}));
vi.mock('@/lib/sales-tasks', () => ({
  buildKycSubRows: () => [],
  buildVisibilityTaskItems: () => [],
  buildPhotoCaptureTaskItems: () => [],
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import SalesDashboardPage from '../page';

const OUTLET_TYPES = { ok: true, json: () => Promise.resolve({ success: true, data: [
  { code: 'SSS', label: 'RLP', name: 'Retailer', displayName: 'RLP' },
  { code: 'WHOLESALER', label: 'BSC', name: 'Wholesaler', displayName: 'BSC' },
] }) };
const TARGETS = { success: true, data: { period: null, outletCount: 1, kpis: [{ code: 'P', name: 'Primary', unit: '', isPrimary: true, target: 100, achieved: 50, pace: 0.5 }], trend: [] } };
const TEAM_VIEW = { success: true, data: { mode: 'OVERVIEW', member: null, kpis: [], summary: { outlets: 0, kycDone: 0, kycPending: 0, avgScore: null }, members: [], filterOptions: { outletTypes: [], programs: [], kpis: [] } } };
const COMPARISON = { success: true, data: { outletType: 'SSS', program: null, kpiCode: 'P', kpiName: 'Primary', buckets: {
  current: { monthlySale: 10, targetMet: { achieved: 1, withTarget: 2, pct: 50 } },
  lastMonth: { monthlySale: 8, targetMet: { achieved: 1, withTarget: 2, pct: 50 } },
  last3Months: { monthlySale: 9, targetMet: { achieved: null, withTarget: null, pct: 50 } },
} } };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'SO');
  fetchMock.mockImplementation((url: string) => {
    const u = typeof url === 'string' ? url : '';
    if (u.includes('/api/sales/me'))              return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { features: { rlpBscView: true } } }) });
    if (u.includes('/api/settings/outlet-types')) return Promise.resolve(OUTLET_TYPES);
    if (u.includes('/api/sales/team-view'))        return Promise.resolve({ ok: true, json: () => Promise.resolve(TEAM_VIEW) });
    if (u.includes('/api/sales/trade-comparison'))  return Promise.resolve({ ok: true, json: () => Promise.resolve(COMPARISON) });
    if (u.includes('/api/sales/targets'))           return Promise.resolve({ ok: true, json: () => Promise.resolve(TARGETS) });
    if (u.includes('/api/sales/outlets'))           return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { outlets: [] } }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  });
});

describe('Sales dashboard — Visibility hidden on BSC', () => {
  it('BT4: Visibility shows for RLP and hides when BSC is selected', async () => {
    render(<SalesDashboardPage />);
    await screen.findByTestId('rlp-bsc-toggle');
    // RLP (default = SSS) → Visibility card present.
    expect(await screen.findByTestId('visibility-summary-card')).toBeInTheDocument();
    // Switch to BSC (WHOLESALER) → Visibility card gone (N/A for BSC).
    fireEvent.click(screen.getByRole('tab', { name: 'BSC' }));
    await waitFor(() => expect(screen.queryByTestId('visibility-summary-card')).not.toBeInTheDocument());
  });
});
