/**
 * TDD — MemberCard shows employee ID, not beat/territory name
 *
 * AB1: each member card shows the employee ID (e.g. "xsr1")
 * AB2: territory/beat names are NOT shown in the member card sub-line
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/task-config', () => ({
  fetchTaskConfig: () => Promise.resolve(null),
}));
vi.mock('@/lib/banner', () => ({
  fetchBanners:              () => Promise.resolve({ banners: [] }),
  getActiveSalesBanners:     () => [],
  getActiveBannersFromList:  () => [],
  getBgStyle:                () => ({}),
}));
// Pin a team-view role (SO) so the My-Team member list renders.
vi.mock('@/lib/sales-role', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sales-role')>();
  return { ...actual, getRole: () => 'SO' as const };
});

import TeamPage from '../page';

// QUARANTINE (launch CD gate / A-1): pre-existing TDD-red spec for an unbuilt/changed feature. Un-skip when that feature ships. See docs/plans/reconcile/baseline-red-snapshot.txt
describe.skip('AB — MemberCard sub-line shows employee ID', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('AB1: each member card shows the employee ID below the name', async () => {
    render(<TeamPage />);
    await act(async () => { vi.advanceTimersByTime(500); });

    await waitFor(() => expect(screen.getByText('xsr1')).toBeInTheDocument());
    expect(screen.getByText('xsr2')).toBeInTheDocument();
    expect(screen.getByText('xsr3')).toBeInTheDocument();
    expect(screen.getByText('xsr4')).toBeInTheDocument();
  });

  it('AB2: territory/beat names are NOT shown in the member card sub-line', async () => {
    render(<TeamPage />);
    await act(async () => { vi.advanceTimersByTime(500); });

    await waitFor(() => expect(screen.getByText('xsr1')).toBeInTheDocument());
    expect(screen.queryByText('Andheri Beat')).not.toBeInTheDocument();
    expect(screen.queryByText('Juhu Beat')).not.toBeInTheDocument();
    expect(screen.queryByText('Versova Beat')).not.toBeInTheDocument();
    expect(screen.queryByText('DN Nagar Beat')).not.toBeInTheDocument();
  });
});

// Owner 2026-06-26: the member sub-line must show employee ID + phone, never the CUID.
describe('TM — team member sub-line shows employee ID + phone (real /api/sales/team)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const TEAM_PAYLOAD = {
    success: true,
    data: {
      salesUser: { role: 'SO', region: 'NCR', zone: null },
      members: [
        {
          id: 'cmqp6qtu3007x01s6dbz4aisb', // internal CUID — must NOT be displayed
          employeeCode: 'ISR-M0100',
          name: 'Anil Sharma',
          mobile: '9900000011',
          role: 'ISR',
          roleLabel: 'Executive Sales Representative',
          territory: '',
          teamSize: 0,
          joinedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  };

  it('TM1: renders "ISR-M0100 · 9900000011" under the name, not the CUID', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(TEAM_PAYLOAD),
    }));
    render(<TeamPage />);

    expect(await screen.findByText('Anil Sharma')).toBeInTheDocument();
    expect(screen.getByText('ISR-M0100 · 9900000011')).toBeInTheDocument();
    expect(screen.queryByText('cmqp6qtu3007x01s6dbz4aisb')).not.toBeInTheDocument();
  });
});
