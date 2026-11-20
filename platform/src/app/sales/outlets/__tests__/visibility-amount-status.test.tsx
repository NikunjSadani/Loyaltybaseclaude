/**
 * Sales outlets — AMOUNT_UPLOAD visibility badge honesty (2026-11-20).
 * Before: every non-Bajaj tenant called /api/visibility/outlet-statuses (a route that did not
 * exist) and a failure silently became "no badge / not captured".
 *   VAS1: a tenant NOT in AMOUNT_UPLOAD mode (or visibility OFF) never asks for the status.
 *   VAS2: AMOUNT_UPLOAD + ON → the badge shows the record status.
 *   VAS3: AMOUNT_UPLOAD + ON + load failure (null) → a visible "couldn't load" notice.
 *
 * Run: npx vitest run src/app/sales/outlets/__tests__/visibility-amount-status.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/sales-role', () => ({
  getRole: () => 'SO',
  hasTeamView: (role: string) => role !== 'XSR',
  childRoleLabelFor: () => 'XSR',
}));

let settings: Record<string, unknown> = {};
vi.mock('@/lib/gifsy-settings', () => ({ getGifsySettings: () => settings }));

const fetchStatuses = vi.fn();
vi.mock('@/lib/visibility-upload', () => ({
  fetchOutletVisibilityStatuses: (...a: unknown[]) => fetchStatuses(...a),
  VISIBILITY_ELIGIBLE_OUTLET_TYPES: ['SSS'],
  VISIBILITY_STATUS_LOAD_ERROR: "Couldn't load visibility status right now. Try again later.",
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import OutletsPage from '../page';

const OUTLETS = {
  success: true,
  data: {
    outlets: [
      { id: 'o1', kycId: 'k1', outletCode: 'OUT-001', name: 'Verma Traders', location: 'Mumbai', beat: 'B1', district: 'D', state: 'MH', type: 'SSS', kycStatus: 'NOT_STARTED' },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  settings = { paceAmberThreshold: 10 };
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 375 });
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve(OUTLETS) });
    }
    return Promise.resolve({
      json: () => Promise.resolve({ success: true, data: { kpiColumns: [{ code: 'PRIMARY', name: 'Primary', unit: 'cs', isPrimary: true }], rows: [] } }),
    });
  });
});

describe('Sales outlets — amount-upload visibility status', () => {
  it('VAS1: PHOTO_APPROVAL (default) or visibility OFF → never calls outlet-statuses', async () => {
    settings = { paceAmberThreshold: 10, visibilityEnabled: true }; // mode unset = PHOTO_APPROVAL
    const { unmount } = render(<OutletsPage />);
    await screen.findByText('Verma Traders');
    unmount();
    settings = { paceAmberThreshold: 10, visibilityEnabled: false, visibilityCaptureMode: 'AMOUNT_UPLOAD' };
    render(<OutletsPage />);
    await screen.findByText('Verma Traders');
    expect(fetchStatuses).not.toHaveBeenCalled();
    expect(screen.queryByTestId('visibility-status-error')).toBeNull();
  });

  it('VAS2: AMOUNT_UPLOAD + ON → shows the record status badge', async () => {
    settings = { paceAmberThreshold: 10, visibilityEnabled: true, visibilityCaptureMode: 'AMOUNT_UPLOAD' };
    fetchStatuses.mockResolvedValue({ 'OUT-001': { status: 'APPROVED', dateOfCapture: null, approvedBy: null, capturedByEmployeeName: null } });
    render(<OutletsPage />);
    await screen.findByText('Verma Traders');
    await waitFor(() => expect(fetchStatuses).toHaveBeenCalledWith(['OUT-001'], expect.any(String)));
    // KYC is NOT_STARTED, so the only "Approved" on the card is the visibility chip.
    expect(await screen.findByText(/Approved/)).toBeInTheDocument();
    expect(screen.queryByTestId('visibility-status-error')).toBeNull();
  });

  it('VAS3: AMOUNT_UPLOAD + ON + load failure → a visible notice (not a silent empty)', async () => {
    settings = { paceAmberThreshold: 10, visibilityEnabled: true, visibilityCaptureMode: 'AMOUNT_UPLOAD' };
    fetchStatuses.mockResolvedValue(null);
    render(<OutletsPage />);
    expect(await screen.findByTestId('visibility-status-error')).toHaveTextContent("Couldn't load visibility status");
  });
});
