/**
 * TDD — Member detail page changes
 *
 * AC1: Profile card shows employeeId but NOT the territory/beat name
 * AC2: Outlet rows show outletCode below the name (not the location string)
 * AC3: Each outlet row is a clickable link to /sales/kyc/{kycId}
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useParams:  () => ({ memberId: 'xsr4' }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import MemberDetailPage from '../page';

describe('AC — Member detail page', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function renderAndSettle() {
    render(<MemberDetailPage />);
    await act(async () => { vi.advanceTimersByTime(500); });
    await waitFor(() => expect(screen.getByText('Meena Joshi')).toBeInTheDocument());
  }

  it('AC1: profile card shows employeeId but NOT the territory/beat', async () => {
    await renderAndSettle();
    expect(screen.getByText('EMP-2024-0063')).toBeInTheDocument();
    expect(screen.queryByText(/DN Nagar Beat/)).not.toBeInTheDocument();
  });

  it('AC2: outlet rows show outletCode below the outlet name', async () => {
    await renderAndSettle();
    // outletCodes should be visible in the outlets section
    expect(screen.getByText('OUT-MH-2861')).toBeInTheDocument(); // Nagar General
    expect(screen.getByText('OUT-MH-2862')).toBeInTheDocument(); // Sunrise Provisions
    expect(screen.getByText('OUT-MH-2863')).toBeInTheDocument(); // Regal Stores
    // location strings should NOT be shown
    expect(screen.queryByText('DN Nagar')).not.toBeInTheDocument();
    expect(screen.queryByText('Amboli')).not.toBeInTheDocument();
  });

  it('AC3: each outlet row links to /sales/kyc/{kycId}', async () => {
    await renderAndSettle();
    const links = screen.getAllByRole('link');
    const kycLinks = links.filter((l) => l.getAttribute('href')?.startsWith('/sales/kyc/'));
    // xsr4 has 3 outlets → 3 KYC links
    expect(kycLinks.length).toBeGreaterThanOrEqual(3);
  });
});
