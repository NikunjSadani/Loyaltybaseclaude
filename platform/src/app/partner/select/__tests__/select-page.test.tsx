/// <reference types="vitest/globals" />
/**
 * PS — Wave 3 outlet picker (/partner/select)
 *
 * PS1: a single-outlet login (<=1 operable, no group overview) is auto-forwarded to
 *      /partner/dashboard and NEVER sees the picker (today's behaviour preserved).
 * PS2: a multi-outlet login renders one entry per operable outlet + a Group Overview
 *      entry when the overview is available.
 * PS3: selecting an operable outlet writes the cookie via setActivePartner(partnerId)
 *      and navigates to /partner/dashboard.
 * PS4: selecting Group Overview CLEARS the cookie via setActivePartner(null) and
 *      navigates to /partner/group.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { PartnerIdentity } from '@/lib/partner-identity';

// ── Module mocks ──
const replaceMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
}));

const setActivePartnerMock = vi.fn().mockResolvedValue({ success: true });
vi.mock('@/lib/active-partner-actions', () => ({
  setActivePartner: (id: string | null) => setActivePartnerMock(id),
}));

// The picker reads identity via usePartnerIdentity (which fetches /partner/me).
let mockIdentity: PartnerIdentity;
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => mockIdentity,
}));

import PartnerSelectPage from '../page';

/** Build a minimal PartnerIdentity — only the fields the picker reads matter. */
function makeIdentity(over: Partial<PartnerIdentity>): PartnerIdentity {
  return {
    businessName: 'Login Outlet',
    ownerName: 'Owner',
    partnerCode: 'P1',
    outletType: 'WHOLESALER',
    hasPointsActivity: false,
    hasPayoutActivity: true,
    // features unused by the picker — a loose stub keeps the type happy.
    features: {} as PartnerIdentity['features'],
    activePartnerId: null,
    operableOutlets: [],
    groupOverviewAvailable: false,
    groupParent: null,
    activeSelectorInvalid: false,
    loading: false,
    ...over,
  };
}

const OWN = {
  partnerId: 'p-own', outletId: 'o-own', outletCode: 'OUT-001',
  businessName: 'Kumar General Store', ownerName: 'Rajesh', isOwnLogin: true,
};
const SIB = {
  partnerId: 'p-sib', outletId: 'o-sib', outletCode: 'OUT-002',
  businessName: 'Kumar Wholesale', ownerName: 'Rajesh', isOwnLogin: false,
};

beforeEach(() => {
  replaceMock.mockClear();
  pushMock.mockClear();
  setActivePartnerMock.mockClear();
});

describe('PS — outlet picker', () => {
  it('PS1: a single-outlet login is forwarded to the dashboard, never sees the picker', () => {
    mockIdentity = makeIdentity({ operableOutlets: [OWN], groupOverviewAvailable: false });
    render(<PartnerSelectPage />);
    expect(replaceMock).toHaveBeenCalledWith('/partner/dashboard');
    expect(screen.queryByText(/choose an outlet/i)).not.toBeInTheDocument();
  });

  it('PS1b: a login with NO channel-partner row (0 operable) is also forwarded', () => {
    mockIdentity = makeIdentity({ operableOutlets: [], groupOverviewAvailable: false });
    render(<PartnerSelectPage />);
    expect(replaceMock).toHaveBeenCalledWith('/partner/dashboard');
  });

  it('PS2: a multi-outlet login renders each operable outlet + a Group Overview entry', () => {
    mockIdentity = makeIdentity({
      operableOutlets: [OWN, SIB],
      groupOverviewAvailable: true,
    });
    render(<PartnerSelectPage />);
    expect(screen.getByText('Kumar General Store')).toBeInTheDocument();
    expect(screen.getByText('Kumar Wholesale')).toBeInTheDocument();
    expect(screen.getByText(/group overview/i)).toBeInTheDocument();
    // The own outlet is marked; not forwarded.
    expect(screen.getByText(/your outlet/i)).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('PS2b: no Group Overview entry when the overview is unavailable', () => {
    mockIdentity = makeIdentity({ operableOutlets: [OWN, SIB], groupOverviewAvailable: false });
    render(<PartnerSelectPage />);
    expect(screen.queryByText(/group overview/i)).not.toBeInTheDocument();
  });

  it('PS3: selecting an operable outlet sets the cookie and navigates to the dashboard', async () => {
    mockIdentity = makeIdentity({ operableOutlets: [OWN, SIB], groupOverviewAvailable: true });
    render(<PartnerSelectPage />);
    const user = userEvent.setup();
    await user.click(screen.getByText('Kumar Wholesale'));
    await waitFor(() => expect(setActivePartnerMock).toHaveBeenCalledWith('p-sib'));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/partner/dashboard'));
  });

  it('PS4: selecting Group Overview clears the cookie and navigates to /partner/group', async () => {
    mockIdentity = makeIdentity({ operableOutlets: [OWN, SIB], groupOverviewAvailable: true });
    render(<PartnerSelectPage />);
    const user = userEvent.setup();
    await user.click(screen.getByText(/group overview/i));
    await waitFor(() => expect(setActivePartnerMock).toHaveBeenCalledWith(null));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/partner/group'));
  });

  it('PS5: while /partner/me is loading, the picker is not shown (no flash)', () => {
    mockIdentity = makeIdentity({ operableOutlets: [OWN, SIB], groupOverviewAvailable: true, loading: true });
    render(<PartnerSelectPage />);
    expect(screen.queryByText(/choose an outlet/i)).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
