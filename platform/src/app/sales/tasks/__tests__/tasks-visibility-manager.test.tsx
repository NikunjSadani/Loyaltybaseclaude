/// <reference types="vitest/globals" />
/**
 * TVM — Tasks page Visibility nudge for MANAGERS (VISIBILITY-POSM-DESIGN.md D8/D14 / M1).
 *
 * In PHOTO_APPROVAL mode the Visibility task group is driven by the backend's `canCapture`
 * (from getSalesEligible), NOT by the field-role gate (ENROLL_ROLES = XSR/SO/ASM). A manager
 * level (RSM/ZNM/NSM) whose level ∈ allowedSalesLevels — or who owns the outlet's downline —
 * must therefore still get the "N captures due" nudge.
 *
 * TVM1: an RSM (non-enroll role) with a canCapture outlet sees the Visibility group + badge.
 * TVM2: an RSM whose eligible outlets are all view-only (canCapture:false) sees no group.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { SalesEligibleResponse } from '@/lib/visibility-types';

// Manager role — canEnroll is the REAL predicate (RSM → false).
vi.mock('@/lib/sales-role', async (orig) => {
  const actual = await orig<typeof import('@/lib/sales-role')>();
  return { ...actual, getRole: () => 'RSM' as const };
});

vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => ({ visibilityEnabled: true, visibilityCaptureMode: 'PHOTO_APPROVAL' }),
}));

vi.mock('@/lib/task-config', () => ({
  DEFAULT_TASK_CONFIG: { customTaskLabel: 'HO Notifications', customTaskItems: [] },
  fetchTaskConfig: () => Promise.resolve({ customTaskLabel: 'HO Notifications', customTaskItems: [] }),
}));

vi.mock('@/lib/schemes', () => ({
  schemeApi: { listSalesEligible: () => Promise.resolve({ success: true, data: { schemes: [] } }) },
}));

vi.mock('@/lib/visibility-upload', () => ({
  fetchOutletVisibilityStatuses: () => Promise.resolve({}),
  VISIBILITY_ELIGIBLE_OUTLET_TYPES: ['SSS', 'SSS_TOT'],
}));

vi.mock('@/lib/api-client', () => ({ authHeader: () => ({}) }));

vi.mock('./SchemeEnrollSheet', () => ({
  SchemeEnrollSheet: () => null,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const getSalesEligible = vi.fn();
vi.mock('@/lib/visibility', () => ({
  visibilityApi: { getSalesEligible: () => getSalesEligible() },
}));

const managerOutlet = (canCapture: boolean): SalesEligibleResponse => ({
  windowKey: '2026-07-P1',
  window: { startDay: 1, endDay: 15 },
  levelAllowed: canCapture,
  outlets: [
    { outletId: 'o1', outletCode: 'C1', outletName: 'Downline Store', zone: null, state: null,
      outletType: null, captureId: null, status: null, currentVersion: null, rejectionReason: null,
      windowState: 'due', canCapture },
  ],
});

beforeEach(() => {
  getSalesEligible.mockReset();
  // /api/sales/outlets + /api/kyc
  global.fetch = vi.fn((url: string) => {
    if (String(url).includes('/api/kyc')) {
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { submissions: [] } }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { outlets: [] } }) });
  }) as unknown as typeof fetch;
});

import TasksPage from '../page';

describe('TVM — Tasks Visibility nudge for managers (M1)', () => {
  it('TVM1: an RSM with a canCapture outlet sees the Visibility group', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: managerOutlet(true) });
    render(<TasksPage />);
    // The manager gets the Visibility nudge despite not being an enroll role.
    expect(await screen.findByText('Visibility')).toBeInTheDocument();
    expect(getSalesEligible).toHaveBeenCalled();
  });

  it('TVM2: an RSM whose outlets are all view-only sees no Visibility group', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: managerOutlet(false) });
    render(<TasksPage />);
    await waitFor(() => expect(getSalesEligible).toHaveBeenCalled());
    // canCapture:false → buildPhotoCaptureTaskItems yields nothing → no group.
    await waitFor(() => expect(screen.queryByText('Visibility')).not.toBeInTheDocument());
  });
});
