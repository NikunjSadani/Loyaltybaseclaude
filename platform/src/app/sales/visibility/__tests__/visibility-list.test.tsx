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
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { SalesEligibleResponse } from '@/lib/visibility-types';

let mockSettings: { visibilityEnabled?: boolean; visibilityCaptureMode?: string } = {
  visibilityEnabled: true,
  visibilityCaptureMode: 'PHOTO_APPROVAL',
};
vi.mock('@/lib/gifsy-settings', () => ({
  useGifsySettings: () => mockSettings,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
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
    submitCapture: vi.fn(),
    resubmitCapture: vi.fn(),
    getOutletStatus: vi.fn(),
    uploadMedia: vi.fn(),
  },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
}));

import SalesVisibilityPage from '../page';

const RESP: SalesEligibleResponse = {
  windowKey: '2026-07-P1',
  window: { startDay: 1, endDay: 15 },
  levelAllowed: true,
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

beforeEach(() => {
  mockSettings = { visibilityEnabled: true, visibilityCaptureMode: 'PHOTO_APPROVAL' };
  getSalesEligible.mockReset();
});

describe('VIS — Sales Visibility list', () => {
  it('VIS1: renders outlets + window-state badges from getSalesEligible', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: RESP });
    render(<SalesVisibilityPage />);
    expect(await screen.findByText('Due Store')).toBeInTheDocument();
    expect(screen.getByText('Approved Store')).toBeInTheDocument();
    // Two outlets sit in the 'due' window state (o-due + the view-only o-view).
    expect(screen.getAllByText('Due')).toHaveLength(2);
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('VIS2: Capture button only for canCapture + unsatisfied window (D8)', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: RESP });
    render(<SalesVisibilityPage />);
    await screen.findByText('Due Store');
    // Exactly one capturable outlet (o-due). o-appr is satisfied; o-view is view-only.
    const captureButtons = screen.getAllByRole('button', { name: /capture/i });
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
});
