/**
 * Sales KYC list — Team-Member filter uses the FILING-TIME branch for a removed rep's KYC (K1 follow-up,
 * 2026-11-19). The list scope + approval gate already place a REMOVED rep's KYC with the managers in its
 * `submitterManagerChain` snapshot; the member filter used today's reporting links, so a removed rep whose
 * original manager has since moved showed under the wrong member (or none).
 *
 * Tree (RSM viewer): rsm ← asm1 ; rsm ← asm2 ← M (SO, MOVED from asm1 to asm2 after the filing) ← isr1 (REMOVED)
 *   - isr1's KYC (snapshot chain [M, asm1, rsm]) → under ASM1 only (filingBranchKeys), never ASM2;
 *   - a LEGACY removed-rep KYC (no snapshot → no keys) → today's links (ASM2's submitterUserIds);
 *   - a LIVE rep's KYC → today's links, unchanged.
 *
 * Run: npx vitest run src/app/sales/kyc/__tests__/kyc-member-filter-filing-branch.test.tsx
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import KYCListPage from '../page';

const sub = (id: string, userId: string, store: string, code: string, filingBranchKeys?: string[]) => ({
  id, userId, status: 'PENDING_ASM_APPROVAL',
  createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
  user: { id: userId, name: 'Rep', phone: '' },
  partner: { id: `p-${id}`, businessName: store, outlets: [{ name: store, outletCode: code }] },
  ...(filingBranchKeys ? { filingBranchKeys } : {}),
});

const KYC = {
  success: true,
  data: {
    submissions: [
      // Removed rep, manager moved: snapshot says asm1's branch.
      sub('k-removed', 'u-isr1', 'Removed Rep Store', 'OUT-R', ['m-su', 'asm1-su', 'rsm-su', 'isr-su']),
      // Legacy removed-rep row (no snapshot) → current links (isr2 still hangs under M under asm2).
      sub('k-legacy', 'u-isr2', 'Legacy Store', 'OUT-L'),
      // Live rep → current links.
      sub('k-live', 'u-m1', 'Live Store', 'OUT-V'),
    ],
  },
};

const TEAM = {
  success: true,
  data: {
    members: [
      { id: 'asm1-su', name: 'Asm One', employeeCode: 'E1', submitterUserIds: ['u-asm1'], branchKeys: ['asm1-su'] },
      // Today's links put M + both removed reps (includeDeleted walk) under asm2.
      { id: 'asm2-su', name: 'Asm Two', employeeCode: 'E2', submitterUserIds: ['u-asm2', 'u-m1', 'u-isr1', 'u-isr2'], branchKeys: ['asm2-su'] },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('loyaltybase_sales_role', 'RSM');
  fetchMock.mockImplementation((url: string) => {
    const body = url.startsWith('/api/kyc')
      ? KYC
      : url.startsWith('/api/sales/team')
        ? TEAM
        : { success: true, data: { outlets: [] } };
    return Promise.resolve({ json: () => Promise.resolve(body) });
  });
});

afterEach(() => localStorage.clear());

async function renderLoaded() {
  render(<KYCListPage />);
  expect(await screen.findByText('Removed Rep Store')).toBeInTheDocument();
  return (await screen.findByLabelText('Team Member')) as HTMLSelectElement;
}

describe('Sales KYC list — member filter uses the filing-time branch', () => {
  it('rep REMOVED + manager MOVED: the KYC shows under the ORIGINAL member (ASM1), not where the manager sits now', async () => {
    const select = await renderLoaded();
    fireEvent.change(select, { target: { value: 'asm1-su' } });
    await waitFor(() => expect(screen.queryByText('Live Store')).not.toBeInTheDocument());
    expect(screen.getByText('Removed Rep Store')).toBeInTheDocument();
    expect(screen.queryByText('Legacy Store')).not.toBeInTheDocument();
  });

  it('the member the manager MOVED to (ASM2) does not get the removed rep\'s snapshot KYC; legacy + live rows follow today\'s links', async () => {
    const select = await renderLoaded();
    fireEvent.change(select, { target: { value: 'asm2-su' } });
    await waitFor(() => expect(screen.queryByText('Removed Rep Store')).not.toBeInTheDocument());
    // LEGACY row (no snapshot) → current links → ASM2.
    expect(screen.getByText('Legacy Store')).toBeInTheDocument();
    // LIVE rep → current links → ASM2 (unchanged).
    expect(screen.getByText('Live Store')).toBeInTheDocument();
  });

  it('"All" still lists every row', async () => {
    const select = await renderLoaded();
    fireEvent.change(select, { target: { value: 'asm1-su' } });
    fireEvent.change(select, { target: { value: '' } });
    expect(await screen.findByText('Live Store')).toBeInTheDocument();
    expect(screen.getByText('Legacy Store')).toBeInTheDocument();
    expect(screen.getByText('Removed Rep Store')).toBeInTheDocument();
  });
});
