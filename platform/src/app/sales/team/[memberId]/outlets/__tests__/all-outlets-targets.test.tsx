/**
 * Regression (WS2 — show targets for ALL outlets): a manager's member-outlets
 * roster must render each outlet's real target/achieved numbers regardless of KYC
 * status. Previously the table gated per-row cells on `kycStatus === APPROVED`,
 * nulling the numbers and rendering a "–" dash for every non-approved outlet. That
 * gate is removed. This page has no Team Total row, so there is no footnote here.
 *
 * Run: npx vitest run "src/app/sales/team/[memberId]/outlets/__tests__/all-outlets-targets.test.tsx"
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useParams: () => ({ memberId: 'm-1' }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import MemberOutletsPage from '../page';

const MEMBER = { success: true, data: { member: { name: 'Rita Sen', role: 'SO', roleLabel: 'SO', territory: 'West' } } };

const OUTLETS = {
  success: true,
  data: {
    outlets: [
      {
        id: 'o-approved', kycId: 'kyc-1', outletCode: 'OUT-001', name: 'Verma Traders',
        location: 'Mumbai', type: 'SSS', kycStatus: 'APPROVED', beat: 'B1',
      },
      {
        id: 'o-fresh', kycId: '', outletCode: 'OUT-002', name: 'Patel Kirana',
        location: 'Mumbai', type: 'SSS', kycStatus: 'NOT_STARTED', beat: 'B1',
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
  // Force the TABLE view (width >= 768): the per-row gate lives in the table render.
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/outlet-targets')) {
      return Promise.resolve({ json: () => Promise.resolve(TARGETS) });
    }
    if (typeof url === 'string' && url.includes('/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve(OUTLETS) });
    }
    return Promise.resolve({ json: () => Promise.resolve(MEMBER) });
  });
});

describe('Member outlets — targets visible for ALL outlets (WS2)', () => {
  it('renders real target/achieved numbers for a NON-APPROVED (NOT_STARTED) outlet row', async () => {
    render(<MemberOutletsPage />);
    const nameCell = await screen.findByText('Patel Kirana');
    const row = nameCell.closest('tr');
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    // Real KPI numbers must render (achieved 25 / target 50 → 50%), NOT a "–".
    expect(cells.getByText('25')).toBeInTheDocument();
    expect(cells.getByText(/\/50/)).toBeInTheDocument();
    expect(cells.getByText('50%')).toBeInTheDocument();
  });

  it('still renders the APPROVED outlet numbers', async () => {
    render(<MemberOutletsPage />);
    const nameCell = await screen.findByText('Verma Traders');
    const row = nameCell.closest('tr');
    const cells = within(row as HTMLElement);
    expect(cells.getByText('90')).toBeInTheDocument();
    expect(cells.getByText(/\/100/)).toBeInTheDocument();
  });
});
