/**
 * Manager-only "Team Member" filter on the sales Outlets screen. Ports the KYC-list
 * member-filter pattern (sales/kyc/page.tsx): the dropdown is gated to managers (SO and
 * above) with at least one direct report, its options come from the /api/sales/outlets
 * payload (body.data.members, each carrying submitterUserIds = the member's own user id +
 * their whole downline), and selecting a member narrows the roster to the outlets whose
 * assignedUserId is in that member's sub-tree.
 *
 *  (1) the filter renders for a manager (role SO) when members are present;
 *  (2) it does NOT render for a plain rep (role XSR / no downline);
 *  (3) selecting a member narrows the visible outlets to that member's sub-tree.
 *
 * Uses the REAL sales-role module (getRole reads the role from localStorage in a non-prod
 * build, exactly like the KYC-list specs) so hasTeamView / childRoleLabelFor behave live.
 *
 * Run: npx vitest run src/app/sales/outlets/__tests__/member-filter.test.tsx
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/gifsy-settings', () => ({ getGifsySettings: () => ({ paceAmberThreshold: 10 }) }));
vi.mock('@/lib/visibility-upload', () => ({
  fetchOutletVisibilityStatuses: () => Promise.resolve({}),
  VISIBILITY_ELIGIBLE_OUTLET_TYPES: [] as string[],
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import OutletsPage from '../page';

// Two outlets assigned to two different members' branches (assignedUserId), plus the
// manager-only members list the backend now returns on the roster payload.
const OUTLETS = {
  success: true,
  data: {
    outlets: [
      {
        id: 'o-a', kycId: 'kyc-a', outletCode: 'OUT-A', name: 'Alpha Store',
        location: 'Mumbai', beat: 'B1', district: 'D', state: 'MH', type: 'SSS',
        kycStatus: 'APPROVED', assignedUserId: 'u-a',
      },
      {
        id: 'o-b', kycId: 'kyc-b', outletCode: 'OUT-B', name: 'Beta Store',
        location: 'Mumbai', beat: 'B1', district: 'D', state: 'MH', type: 'SSS',
        kycStatus: 'APPROVED', assignedUserId: 'u-b',
      },
    ],
    members: [
      { id: 'mA', name: 'Alpha Rep', employeeCode: 'EA', submitterUserIds: ['u-a'] },
      { id: 'mB', name: 'Beta Rep',  employeeCode: 'EB', submitterUserIds: ['u-b'] },
    ],
  },
};

const TARGETS = {
  success: true,
  data: {
    kpiColumns: [{ code: 'PRIMARY', name: 'Primary', unit: 'cs', isPrimary: true }],
    rows: [
      { outletCode: 'OUT-A', kpis: { PRIMARY: { target: 100, achieved: 90, pace: null } } },
      { outletCode: 'OUT-B', kpis: { PRIMARY: { target: 100, achieved: 50, pace: null } } },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('token', 't');
  // Force TABLE view (outlet names render in the sticky name cell).
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve(OUTLETS) });
    }
    return Promise.resolve({ json: () => Promise.resolve(TARGETS) });
  });
});

describe('Sales outlets — manager-only Team Member filter', () => {
  it('renders the Team Member filter for a manager (SO) when the payload carries members', async () => {
    localStorage.setItem('loyaltybase_sales_role', 'SO');
    render(<OutletsPage />);
    expect(await screen.findByText('Alpha Store')).toBeInTheDocument();
    expect(await screen.findByTestId('outlets-member-filter')).toBeInTheDocument();
  });

  it('does NOT render the filter for a plain rep (XSR) with no downline', async () => {
    localStorage.setItem('loyaltybase_sales_role', 'XSR');
    // A leaf rep gets no members from the backend.
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
        return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { outlets: OUTLETS.data.outlets, members: [] } }) });
      }
      return Promise.resolve({ json: () => Promise.resolve(TARGETS) });
    });
    render(<OutletsPage />);
    expect(await screen.findByText('Alpha Store')).toBeInTheDocument();
    expect(screen.queryByTestId('outlets-member-filter')).not.toBeInTheDocument();
  });

  it('narrows the roster to the selected member\'s sub-tree', async () => {
    localStorage.setItem('loyaltybase_sales_role', 'SO');
    render(<OutletsPage />);
    expect(await screen.findByText('Beta Store')).toBeInTheDocument();

    const memberFilter = await screen.findByTestId('outlets-member-filter') as HTMLSelectElement;
    fireEvent.change(memberFilter, { target: { value: 'mA' } });

    // Only Alpha Rep's outlet (assignedUserId u-a ∈ mA.submitterUserIds) stays visible.
    await waitFor(() => expect(screen.queryByText('Beta Store')).not.toBeInTheDocument());
    expect(await screen.findByText('Alpha Store')).toBeInTheDocument();
  });
});
