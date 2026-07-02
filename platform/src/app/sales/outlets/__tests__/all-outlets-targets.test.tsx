/**
 * Regression (WS2 — show targets for ALL outlets): the sales roster must render
 * each outlet's real target/achieved numbers regardless of KYC status. Previously
 * the table gated per-row cells on `kycStatus === APPROVED`, showing a "–" dash for
 * every non-approved outlet. That gate is removed.
 *
 * HOWEVER the aggregate "Team Total" row stays APPROVED-only, so it intentionally
 * will NOT equal the sum of the visible rows — a footnote explains this.
 *
 * Run: npx vitest run src/app/sales/outlets/__tests__/all-outlets-targets.test.tsx
 */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/sales-role', () => ({ getRole: () => 'SO' }));
vi.mock('@/lib/gifsy-settings', () => ({ getGifsySettings: () => ({ paceAmberThreshold: 10 }) }));
vi.mock('@/lib/visibility-upload', () => ({
  fetchOutletVisibilityStatuses: () => Promise.resolve({}),
  VISIBILITY_ELIGIBLE_OUTLET_TYPES: [] as string[],
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import OutletsPage from '../page';

// One APPROVED outlet, one NOT_STARTED outlet — both have real target rows.
const OUTLETS = {
  success: true,
  data: {
    outlets: [
      {
        id: 'o-approved', kycId: 'kyc-123', outletCode: 'OUT-001', name: 'Verma Traders',
        location: 'Mumbai', beat: 'B1', district: 'D', state: 'MH', type: 'SSS', kycStatus: 'APPROVED',
      },
      {
        id: 'o-fresh', kycId: '', outletCode: 'OUT-002', name: 'Patel Kirana',
        location: 'Mumbai', beat: 'B1', district: 'D', state: 'MH', type: 'SSS', kycStatus: 'NOT_STARTED',
      },
    ],
  },
};

const TARGETS = {
  success: true,
  data: {
    kpiColumns: [{ code: 'PRIMARY', name: 'Primary', unit: 'cs', isPrimary: true }],
    rows: [
      { outletCode: 'OUT-001', kpis: { PRIMARY: { target: 100, achieved: 90, pace: null } } },
      { outletCode: 'OUT-002', kpis: { PRIMARY: { target: 50, achieved: 25, pace: null } } },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('token', 't');
  // Force the TABLE view (width >= 768): the per-row gate + Team Total row live in
  // the table render. jsdom default (1024) already renders the table, but be explicit.
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve(OUTLETS) });
    }
    return Promise.resolve({ json: () => Promise.resolve(TARGETS) });
  });
});

describe('Sales outlets — targets visible for ALL outlets (WS2)', () => {
  it('renders real target/achieved numbers for a NON-APPROVED (NOT_STARTED) outlet row', async () => {
    render(<OutletsPage />);
    // Wait for the non-approved outlet's row to appear.
    const nameCell = await screen.findByText('Patel Kirana');
    const row = nameCell.closest('tr');
    expect(row).not.toBeNull();
    // Its real KPI numbers must render (achieved 25 / target 50 → 50%), NOT a "–".
    const cells = within(row as HTMLElement);
    expect(cells.getByText('25')).toBeInTheDocument();
    expect(cells.getByText(/\/50/)).toBeInTheDocument();
    expect(cells.getByText('50%')).toBeInTheDocument();
  });

  it('still renders the APPROVED outlet numbers', async () => {
    render(<OutletsPage />);
    const nameCell = await screen.findByText('Verma Traders');
    const row = nameCell.closest('tr');
    const cells = within(row as HTMLElement);
    expect(cells.getByText('90')).toBeInTheDocument();
    expect(cells.getByText(/\/100/)).toBeInTheDocument();
  });

  it('keeps the Team Total APPROVED-only (does not include the non-approved outlet)', async () => {
    render(<OutletsPage />);
    const totalLabel = await screen.findByText('Team Total');
    const row = totalLabel.closest('tr');
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    // Only the approved outlet (90/100) is summed — the NOT_STARTED 25/50 is excluded.
    // If the non-approved were counted the totals would be 115/150.
    expect(cells.getByText('90')).toBeInTheDocument();
    expect(cells.getByText(/\/100/)).toBeInTheDocument();
    expect(row?.textContent).toContain('1 approved outlets');
  });

  it('shows a footnote explaining the total counts approved & active outlets only', async () => {
    render(<OutletsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Team Total reflects approved & active outlets only\./i)).toBeInTheDocument();
    });
  });
});
