/// <reference types="vitest/globals" />
/**
 * VIS — Sales Visibility (POSM) list page (VISIBILITY-POSM-DESIGN.md §5 / D8 / D14).
 *
 * VIS1: renders in-scope outlets with their window-state badges from getSalesEligible
 * VIS2: Capture affordance is gated on canCapture + an unsatisfied window (D8)
 * VIS3: master Visibility switch OFF → "not enabled" surface
 * VIS4: header shows the "N due" badge (canCapture + due/rejected/late count)
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// requireLocation is DEFAULT ON since 2026-11-21 (LOCATION-GATE.md). These pre-gate cases model a tenant with the
// explicit emergency off (`requireLocation: false`) at the ONE shared seam, so their flows stay byte-identical.
// The default-ON / explicit-true paths are covered by the *location-gate* tests.
vi.mock('@/lib/location-required', () => ({ isLocationRequired: () => false }));
import type { SalesEligibleResponse } from '@/lib/visibility-types';

let mockSettings: { visibilityEnabled?: boolean; visibilityCaptureMode?: string } = {
  visibilityEnabled: true,
  visibilityCaptureMode: 'PHOTO_APPROVAL',
};
vi.mock('@/lib/gifsy-settings', () => ({
  useGifsySettings: () => mockSettings,
}));

// Hoisted so the vi.mock factory (itself hoisted) can reference them. `searchState.outletId`
// drives the ?outletId= deep-link; `mockPush` is the router spy for the return-to-outlet nav.
const { mockPush, searchState } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  searchState: { outletId: '' },
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () =>
    new URLSearchParams(searchState.outletId ? `outletId=${searchState.outletId}` : ''),
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const getSalesEligible = vi.fn();
vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    getSalesEligible: () => getSalesEligible(),
    getForm: vi.fn(),
    getSalesForm: vi.fn(),
    submitCapture: vi.fn(),
    resubmitCapture: vi.fn(),
    getOutletStatus: vi.fn(),
    uploadMedia: vi.fn(),
  },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
}));

import SalesVisibilityPage from '../page';
import { visibilityApi } from '@/lib/visibility';

const RESP: SalesEligibleResponse = {
  windowKey: '2026-07-P1',
  window: { startDay: 1, endDay: 15 },
  levelAllowed: true,
  // Leaf rep: no downline → no Team Member filter.
  members: [],
  outlets: [
    { outletId: 'o-due', outletCode: 'C-DUE', outletName: 'Due Store', zone: null, state: null,
      outletType: null, captureId: null, status: null, currentVersion: null, rejectionReason: null,
      windowState: 'due', canCapture: true },
    { outletId: 'o-appr', outletCode: 'C-APPR', outletName: 'Approved Store', zone: null, state: null,
      outletType: null, captureId: 'cap1', status: 'APPROVED', currentVersion: 1, rejectionReason: null,
      windowState: 'approved', canCapture: true },
    { outletId: 'o-view', outletCode: 'C-VIEW', outletName: 'Viewer Store', zone: null, state: null,
      outletType: null, captureId: null, status: null, currentVersion: null, rejectionReason: null,
      windowState: 'due', canCapture: false },
  ],
};

/**
 * Manager scenario: two direct reports, each with a submitter sub-tree (login-User ids).
 * Each outlet is assigned to a rep (assignedUserId) — the Team Member filter matches an
 * outlet whose assignedUserId is in the selected member's sub-tree.
 */
const MANAGER_RESP: SalesEligibleResponse = {
  windowKey: '2026-07-P1',
  window: { startDay: 1, endDay: 15 },
  levelAllowed: true,
  members: [
    { id: 'm-ann', name: 'Ann Rep', submitterUserIds: ['u-ann', 'u-ann-child'] },
    { id: 'm-bob', name: 'Bob Rep', submitterUserIds: ['u-bob'] },
  ],
  outlets: [
    { outletId: 'o-ann', outletCode: 'C-ANN', outletName: 'Ann Store', zone: null, state: null,
      outletType: null, assignedUserId: 'u-ann', captureId: null, status: null, currentVersion: null,
      rejectionReason: null, windowState: 'due', canCapture: true },
    { outletId: 'o-ann2', outletCode: 'C-ANN2', outletName: 'Ann Child Store', zone: null, state: null,
      outletType: null, assignedUserId: 'u-ann-child', captureId: null, status: null, currentVersion: null,
      rejectionReason: null, windowState: 'due', canCapture: true },
    { outletId: 'o-bob', outletCode: 'C-BOB', outletName: 'Bob Store', zone: null, state: null,
      outletType: null, assignedUserId: 'u-bob', captureId: null, status: null, currentVersion: null,
      rejectionReason: null, windowState: 'due', canCapture: true },
  ],
};

beforeEach(() => {
  mockSettings = { visibilityEnabled: true, visibilityCaptureMode: 'PHOTO_APPROVAL' };
  getSalesEligible.mockReset();
  mockPush.mockReset();
  searchState.outletId = '';
});

describe('VIS — Sales Visibility list', () => {
  it('VIS1: renders outlets + window-state badges from getSalesEligible', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: RESP });
    render(<SalesVisibilityPage />);
    expect(await screen.findByText('Due Store')).toBeInTheDocument();
    expect(await screen.findByText('Approved Store')).toBeInTheDocument();
    // Two outlets sit in the 'due' window state (o-due + the view-only o-view).
    // Scope to the badge <span>s so the status-filter <option>s of the same text don't count.
    // Plain status words (owner 2026-11-20): "due" reads "Not captured yet".
    expect(await screen.findAllByText('Not captured yet', { selector: 'span' })).toHaveLength(2);
    expect(await screen.findByText('Approved', { selector: 'span' })).toBeInTheDocument();
  });

  it('VIS5: status filter narrows the list', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: RESP });
    render(<SalesVisibilityPage />);
    await screen.findByText('Due Store');
    // Select the "Approved" status in the (first) status filter pill.
    fireEvent.change(screen.getByDisplayValue('All statuses'), { target: { value: 'approved' } });
    expect(screen.queryByText('Due Store')).not.toBeInTheDocument();
    expect(screen.getByText('Approved Store')).toBeInTheDocument();
  });

  it('VIS6: the outlet-type and action-needed/sort filters are no longer rendered', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: RESP });
    render(<SalesVisibilityPage />);
    await screen.findByText('Due Store');
    // "All types" (outlet-type) and the "Action needed"/"Name A–Z" sort select are removed.
    expect(screen.queryByText('All types')).not.toBeInTheDocument();
    expect(screen.queryByText('Action needed')).not.toBeInTheDocument();
    expect(screen.queryByText('Name A–Z')).not.toBeInTheDocument();
    // The kept status filter still renders.
    expect(await screen.findByDisplayValue('All statuses')).toBeInTheDocument();
  });

  it('VIS2: Capture button only for canCapture + unsatisfied window (D8)', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: RESP });
    render(<SalesVisibilityPage />);
    await screen.findByText('Due Store');
    // Exactly one capturable outlet (o-due). o-appr is satisfied; o-view is view-only.
    const captureButtons = await screen.findAllByRole('button', { name: /capture/i });
    expect(captureButtons).toHaveLength(1);
  });

  it('VIS3: master switch OFF → not-enabled surface, no fetch', async () => {
    mockSettings = { visibilityEnabled: false, visibilityCaptureMode: 'PHOTO_APPROVAL' };
    render(<SalesVisibilityPage />);
    expect(await screen.findByText(/not enabled for your organization/i)).toBeInTheDocument();
    expect(getSalesEligible).not.toHaveBeenCalled();
  });

  it('VIS4: header shows the N-due badge', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: RESP });
    render(<SalesVisibilityPage />);
    const badge = await screen.findByTestId('visibility-due-badge');
    expect(badge).toHaveTextContent('1 due');
  });

  it('VIS7: the Team Member filter is hidden for a plain rep (no downline → members empty)', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: RESP });
    render(<SalesVisibilityPage />);
    await screen.findByText('Due Store');
    expect(screen.queryByDisplayValue('All team')).not.toBeInTheDocument();
  });

  it('VIS8: the Team Member filter renders for a manager (members present)', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: MANAGER_RESP });
    render(<SalesVisibilityPage />);
    await screen.findByText('Ann Store');
    // The "All team" pill + both member options are present.
    expect(await screen.findByDisplayValue('All team')).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Ann Rep' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'Bob Rep' })).toBeInTheDocument();
  });

  it('VIS9: filtering by a member narrows the list to that member’s assignedUserId sub-tree', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: MANAGER_RESP });
    render(<SalesVisibilityPage />);
    await screen.findByText('Ann Store');
    // Select Ann (whose sub-tree = [u-ann, u-ann-child]).
    fireEvent.change(screen.getByDisplayValue('All team'), { target: { value: 'm-ann' } });
    // Ann's two outlets stay; Bob's outlet (u-bob, outside Ann's sub-tree) drops.
    expect(screen.getByText('Ann Store')).toBeInTheDocument();
    expect(screen.getByText('Ann Child Store')).toBeInTheDocument();
    expect(screen.queryByText('Bob Store')).not.toBeInTheDocument();
  });

  it('VIS5: a deep-linked (?outletId=) capture returns to the outlet detail on close', async () => {
    searchState.outletId = 'o-due';
    getSalesEligible.mockResolvedValue({ success: true, data: RESP });
    // The sheet loads a form on open; a null form resolves to the harmless "no form configured"
    // state that still renders the sheet shell (incl. the Close button) — all this nav test needs.
    (visibilityApi.getSalesForm as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: null,
    });
    render(<SalesVisibilityPage />);
    // The preselect effect auto-opens the capture sheet for the deep-linked actionable outlet.
    const closeBtn = await screen.findByLabelText('Close');
    fireEvent.click(closeBtn);
    expect(mockPush).toHaveBeenCalledWith('/sales/kyc/o-due');
  });
});
