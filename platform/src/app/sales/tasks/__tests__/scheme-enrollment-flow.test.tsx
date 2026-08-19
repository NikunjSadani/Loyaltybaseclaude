/// <reference types="vitest/globals" />
/**
 * Sales-assisted scheme enrollment (D28 / §5.4) — the REAL roster-based flow.
 *
 * Asserts:
 *   - the Tasks page lists eligible schemes from schemeApi.listSalesEligible() (not the
 *     retired fetchAllSchemes shim),
 *   - opening a scheme loads the rep's REACHABLE TARGETS via schemeApi.getSalesTargets()
 *     (not guessing from /api/sales/outlets); the rep picks one and enrolls via
 *     schemeApi.enroll with mode SALES + the target's subject (targetOutletRef for a
 *     live-rule outlet) — no fake OTP, no saveSalesEnrollment,
 *   - the success state reflects the real backend enrollment (SUBMITTED).
 *
 * Run: npx vitest run src/app/sales/tasks/__tests__/scheme-enrollment-flow.test.tsx
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

let mockRole = 'XSR';
vi.mock('@/lib/sales-role', () => ({
  getRole: () => mockRole,
  canEnroll: (r: string) => ['XSR', 'SO', 'ASM'].includes(r),
}));
vi.mock('@/lib/gifsy-settings', () => ({ getGifsySettings: () => ({ visibilityEnabled: false }) }));

const listSalesEligible = vi.fn();
const getSalesTargets = vi.fn();
const enroll = vi.fn();
vi.mock('@/lib/schemes', () => ({
  schemeApi: {
    listSalesEligible: (...a: unknown[]) => listSalesEligible(...a),
    getSalesTargets: (...a: unknown[]) => getSalesTargets(...a),
    enroll: (...a: unknown[]) => enroll(...a),
  },
}));
vi.mock('@/lib/task-config', () => ({
  fetchTaskConfig: () => Promise.resolve({ customTaskLabel: 'HO', customTaskItems: [] }),
  DEFAULT_TASK_CONFIG: { customTaskLabel: 'HO', customTaskItems: [] },
}));
vi.mock('@/lib/visibility-upload', () => ({
  fetchOutletVisibilityStatuses: () => Promise.resolve({}),
  VISIBILITY_ELIGIBLE_OUTLET_TYPES: [] as string[],
}));
vi.mock('@/lib/api-client', () => ({ authHeader: () => ({}), api: { get: vi.fn() } }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import TasksPage from '../page';

// One APPROVED matched outlet (so no KYC task groups clutter the render) with a partner.
const OUTLETS = {
  success: true,
  data: {
    outlets: [
      {
        id: 'o1', kycId: 'k1', outletCode: 'OUT-001', name: 'Sharma Traders',
        location: 'Pune', type: 'SSS', kycStatus: 'APPROVED', partnerId: 'p1',
      },
    ],
  },
};

// A formless scheme (enrollmentForm null) → enroll goes straight through schemeApi.enroll.
const SCHEME = {
  id: 's1', clientId: 'c', code: 'C1', name: 'Summer Activation',
  status: 'ACTIVE', startDate: '2026-06-01', endDate: '2026-08-31',
  createdAt: '2026-05-01', updatedAt: '2026-05-01', enrollmentForm: null,
};

// A reachable LIVE-RULE target for the scheme (schemeOutletId null → targetOutletRef).
const TARGET = {
  schemeOutletId: null, targetOutletRef: 'o1', outletRef: 'o1', outletName: 'Sharma Traders',
  matched: true, standalone: false, status: 'NOT_ENROLLED',
  rejectionReason: null, enrollmentId: null, currentVersion: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockRole = 'XSR';
  listSalesEligible.mockResolvedValue({ success: true, data: { schemes: [SCHEME] } });
  getSalesTargets.mockResolvedValue({
    success: true,
    data: { targets: [TARGET], pagination: { page: 1, limit: 50, total: 1, pages: 1 } },
  });
  enroll.mockResolvedValue({
    success: true,
    data: { enrollment: { id: 'e1', status: 'SUBMITTED' }, submission: { id: 'sub1' } },
  });
  fetchMock.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/sales/outlets')) {
      return Promise.resolve({ json: () => Promise.resolve(OUTLETS) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ data: { kyc: [] } }) });
  });
});

describe('Sales Tasks — real sales-assisted scheme enrollment', () => {
  it('lists eligible schemes and enrolls a reachable target via schemeApi.enroll (mode SALES)', async () => {
    render(<TasksPage />);

    // The scheme group appears (from listSalesEligible, not fetchAllSchemes).
    const group = await screen.findByText('Activations / Tasks');
    fireEvent.click(group);
    expect(await screen.findByText('Summer Activation')).toBeInTheDocument();

    // Open the enrollment sheet for the scheme (the card button "Select" opens the picker).
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    // The target picker (getSalesTargets) opens.
    expect(await screen.findByText(/Pick the outlet/i)).toBeInTheDocument();
    expect(getSalesTargets).toHaveBeenCalledWith('s1');
    expect(screen.getByText('Sharma Traders')).toBeInTheDocument();

    // Choose the target → formless confirm → enroll (the row button "Select" picks the outlet).
    const enrollButtons = screen.getAllByRole('button', { name: 'Select' });
    fireEvent.click(enrollButtons[enrollButtons.length - 1]); // the target-row button

    const confirm = await screen.findByText('Confirm enrollment');
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(enroll).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ enrollmentMode: 'SALES', targetOutletRef: 'o1', formValues: {} }),
      ),
    );

    // Success state reflects the real backend enrollment.
    expect(await screen.findByText('Enrolled')).toBeInTheDocument();
  });

  it('renders the scheme group for a manager (RSM) — the backend scopes targets to their downline', async () => {
    // Fix: scheme "Activations / Tasks" is no longer gated to field roles. A manager
    // (RSM/ZNM/NSM) tagged on a roster row now sees the group and can Select→enroll; the
    // backend (getSalesTargets / assertSalesReachRoster) scopes visibility to their downline.
    mockRole = 'RSM';
    render(<TasksPage />);
    const group = await screen.findByText('Activations / Tasks');
    fireEvent.click(group);
    expect(await screen.findByText('Summer Activation')).toBeInTheDocument();
  });
});

describe('Sales Tasks — the reward-era mock OTP + shims are gone', () => {
  const page = readFileSync(resolve(__dirname, '../page.tsx'), 'utf-8');

  it('page no longer imports the retired shims', () => {
    expect(page).not.toMatch(/fetchAllSchemes/);
    expect(page).not.toMatch(/saveSalesEnrollment/);
    expect(page).not.toMatch(/formatDeadline/);
  });

  it('page no longer contains the mock OTP / WhatsApp-mock UI', () => {
    expect(page).not.toMatch(/Verify & Enroll/);
    expect(page).not.toMatch(/Deoleo Loyalty/); // the old WhatsApp mock header
  });

  it('page uses the roster-based client + the shared renderer sheet', () => {
    expect(page).toMatch(/schemeApi/);
    expect(page).toMatch(/SchemeEnrollSheet/);
  });
});
