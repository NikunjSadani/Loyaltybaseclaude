/**
 * Regression (dashboard ⟂ Tasks parity): the Tasks "View all" page MUST surface
 * the "KYC to be done" group for NOT_STARTED outlets, exactly like the dashboard.
 * Previously the Tasks page omitted the group entirely, so the dashboard showed
 * "KYC to be done" (n) while the Tasks page dropped it — the two counts disagreed.
 *
 * Run: npx vitest run src/app/sales/tasks/__tests__/kyc-to-be-done-parity.test.tsx
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
let mockRole = 'XSR';
vi.mock('@/lib/sales-role', () => ({
  getRole: () => mockRole,
  // Real gate: XSR / SO / ASM can enroll.
  canEnroll: (r: string) => ['XSR', 'SO', 'ASM'].includes(r),
}));
vi.mock('@/lib/gifsy-settings', () => ({ getGifsySettings: () => ({ visibilityEnabled: false }) }));
vi.mock('@/lib/schemes', () => ({
  // New roster-based client (§13.4). No eligible schemes here so the KYC groups
  // are what's asserted; the retired mock-OTP/saveSalesEnrollment shims are gone.
  schemeApi: { listSalesEligible: () => Promise.resolve({ success: true, data: { schemes: [] } }) },
}));
vi.mock('@/lib/task-config', () => ({
  fetchTaskConfig: () => Promise.resolve({ customTaskLabel: 'HO', customTaskItems: [] }),
  DEFAULT_TASK_CONFIG: { customTaskLabel: 'HO', customTaskItems: [] },
}));
vi.mock('@/lib/visibility-upload', () => ({
  fetchOutletVisibilityStatuses: () => Promise.resolve({}),
  VISIBILITY_ELIGIBLE_OUTLET_TYPES: [] as string[],
}));
vi.mock('@/lib/api-client', () => ({ authHeader: () => ({ Authorization: 'Bearer t' }) }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import TasksPage from '../page';

const OUTLETS = {
  success: true,
  data: {
    outlets: [
      {
        id: 'o-fresh', kycId: '', outletCode: 'OUT-002', name: 'Patel Kirana',
        location: 'Mumbai', type: 'SSS', kycStatus: 'NOT_STARTED', partnerId: 'p1',
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('token', 't');
  mockRole = 'XSR';
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve(OUTLETS) });
    }
    // /api/kyc → no submissions (NOT_STARTED outlets have none).
    return Promise.resolve({ json: () => Promise.resolve({ data: { kyc: [] } }) });
  });
});

describe('Sales Tasks — KYC-to-be-done parity with the dashboard', () => {
  it('renders a "KYC to be done" group linking to the NOT_STARTED list', async () => {
    render(<TasksPage />);
    const label = await screen.findByText('KYC to be done');
    const row = label.closest('a');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute('href', '/sales/kyc?status=NOT_STARTED');
  });

  it('renders the "KYC to be done" group for ASM too (now an enroll role)', async () => {
    mockRole = 'ASM';
    render(<TasksPage />);
    const label = await screen.findByText('KYC to be done');
    expect(label.closest('a')).toHaveAttribute('href', '/sales/kyc?status=NOT_STARTED');
  });

  it('does NOT render the "KYC to be done" group for a non-enroll manager (RSM)', async () => {
    mockRole = 'RSM';
    render(<TasksPage />);
    // RSM is not in ENROLL_ROLES → the field/KYC-to-do group is omitted; the page
    // settles into the "All clear!" empty state (no schemes, no field tasks).
    await screen.findByText('All clear!');
    expect(screen.queryByText('KYC to be done')).not.toBeInTheDocument();
  });
});
