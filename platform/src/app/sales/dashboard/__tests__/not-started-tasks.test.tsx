/**
 * Regression: a field rep with un-KYC'd (NOT_STARTED) assigned outlets must see a
 * "KYC to be done" task — previously NOT_STARTED matched NO task group (the
 * "Pending KYC" group keys on PENDING = submitted), so the rep saw "no tasks".
 *
 * Run: npx vitest run src/app/sales/dashboard/__tests__/not-started-tasks.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import SalesDashboardPage from '../page';

const NOT_STARTED_OUTLETS = {
  success: true,
  data: { outlets: [
    { id: 'o1', name: 'Verma Traders', mobile: '9', city: 'Mumbai', type: 'SSS', kycStatus: 'NOT_STARTED' },
    { id: 'o2', name: 'Patel Kirana', mobile: '8', city: 'Mumbai', type: 'SSS', kycStatus: 'NOT_STARTED' },
  ] },
};

function mockOutlets(role: string) {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('loyaltybase_sales_role', role);
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve(NOT_STARTED_OUTLETS) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { period: null, outletCount: 2, kpis: [], trend: [] } }) });
  });
}

beforeEach(() => {
  // Enroll role (XSR) so the field-task groups are evaluated.
  mockOutlets('XSR');
});

describe('Sales dashboard — NOT_STARTED outlets surface a KYC task', () => {
  it('shows the "KYC to be done" group with a count of un-KYC\'d outlets', async () => {
    render(<SalesDashboardPage />);
    await waitFor(() => expect(screen.getByText('KYC to be done')).toBeInTheDocument());
    // No "no pending tasks" empty state when there ARE un-KYC'd outlets.
    expect(screen.queryByText(/No pending tasks/i)).not.toBeInTheDocument();
  });

  it('shows the "KYC to be done" group + New Enrollment for ASM (now an enroll role)', async () => {
    mockOutlets('ASM');
    render(<SalesDashboardPage />);
    await waitFor(() => expect(screen.getByText('KYC to be done')).toBeInTheDocument());
    // ASM sees the enroll CTA, mirroring XSR/SO.
    expect(screen.getByText('New Enrollment')).toBeInTheDocument();
    expect(screen.queryByText(/No pending tasks/i)).not.toBeInTheDocument();
  });

  it('does NOT show the "KYC to be done" group or New Enrollment for a non-enroll manager (RSM)', async () => {
    mockOutlets('RSM');
    render(<SalesDashboardPage />);
    // RSM is not in ENROLL_ROLES → no field/KYC-to-do tasks, no enroll CTA.
    await waitFor(() => expect(screen.getByText(/No pending tasks/i)).toBeInTheDocument());
    expect(screen.queryByText('KYC to be done')).not.toBeInTheDocument();
    expect(screen.queryByText('New Enrollment')).not.toBeInTheDocument();
  });

  it('does not show the task when all outlets are already APPROVED', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
        return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { outlets: [
          { id: 'o1', name: 'Done Outlet', mobile: '9', city: 'X', type: 'SSS', kycStatus: 'APPROVED' },
        ] } }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { period: null, outletCount: 1, kpis: [], trend: [] } }) });
    });
    render(<SalesDashboardPage />);
    await waitFor(() => expect(screen.getByText(/No pending tasks/i)).toBeInTheDocument());
    expect(screen.queryByText('KYC to be done')).not.toBeInTheDocument();
  });
});
