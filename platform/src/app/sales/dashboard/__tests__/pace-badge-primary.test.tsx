/**
 * The Target Achievement pace badge must read off the PRIMARY metric (owner):
 *   - text = "{remaining} {unit} to go · N days left" (not "On pace · % elapsed")
 *   - colour reflects how the PRIMARY KPI is pacing (red when behind), NOT the
 *     all-KPI average (which a 273%-achieved secondary KPI skews green).
 *
 * Primary "Monthly" 70/150 Litre (47%, behind) + secondary "Consistency" 273%.
 * Expect: "80 Litre to go", red badge. System date pinned to 25 Jun 2026.
 *
 * Run: npx vitest run src/app/sales/dashboard/__tests__/pace-badge-primary.test.tsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

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

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import SalesDashboardPage from '../page';

const TARGETS = {
  success: true,
  data: {
    period: '2026-06', outletCount: 3, trend: [],
    kpis: [
      { code: 'MONTH', name: 'Monthly', unit: 'Litre', isPrimary: true,  target: 150, achieved: 70, pace: 0.47 },
      { code: 'CONS',  name: 'Consistency', unit: 'Litre', isPrimary: false, target: 11, achieved: 30, pace: 2.73 },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', 'SO');
  vi.useFakeTimers({ toFake: ['Date'] });           // fake Date only — leave promises/timers real
  vi.setSystemTime(new Date('2026-06-25T00:00:00Z')); // 5 days left in June, 83% elapsed
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/targets')) {
      return Promise.resolve({ json: () => Promise.resolve(TARGETS) });
    }
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { outlets: [] } }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { submissions: [] } }) });
  });
});

afterEach(() => { vi.useRealTimers(); });

describe('Target Achievement pace badge — primary-metric driven', () => {
  it('shows "{remaining} {unit} to go" for the PRIMARY KPI, coloured red when behind', async () => {
    render(<SalesDashboardPage />);
    const badge = await screen.findByText(/80 Litre to go/);   // 150 - 70 = 80, primary unit
    expect(badge.textContent).toMatch(/80 Litre to go · 5 days left/);
    // Coloured by the PRIMARY KPI's pace (47% vs 83% elapsed → behind → red),
    // NOT the all-KPI average (which the 273% secondary would push green.)
    const box = badge.closest('div')!;
    expect(box.className).toContain('text-red-600');
    expect(box.className).toContain('bg-red-50');
    // The old "On pace / % elapsed" phrasing is gone.
    expect(screen.queryByText(/On pace/)).not.toBeInTheDocument();
    expect(screen.queryByText(/elapsed/)).not.toBeInTheDocument();
  });
});
