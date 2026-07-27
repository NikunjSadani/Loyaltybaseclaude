/// <reference types="vitest/globals" />
/**
 * VPC — Sales outlet-detail "Visibility — this period" card (VISIBILITY-POSM-DESIGN.md D13).
 *
 * VPC1: renders each window's status + a Capture CTA (redirect ?outletId=) when a
 *       current window is due / missing / rejected
 * VPC2: no Capture CTA when the current window is satisfied (approved) or the rep
 *       may not capture (canCapture:false)
 * VPC3: an out-of-scope outlet hides the card entirely
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { GifsySettings } from '@/types';
import { DEFAULT_SETTINGS } from '@/lib/gifsy-settings';
import type { OutletStatusResponse } from '@/lib/visibility-types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('@/lib/sales-role', () => ({ getRole: () => 'XSR' }));

let mockSettings: GifsySettings = DEFAULT_SETTINGS;
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@/lib/gifsy-settings');
  return { ...actual, useGifsySettings: () => mockSettings };
});

const getOutletStatus = vi.fn();
vi.mock('@/lib/visibility', () => ({
  visibilityApi: { getOutletStatus: (id: string) => getOutletStatus(id) },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
}));

import SalesKYCDetailPage from '../page';

const SUBMISSION = {
  id: 'KYC42',
  status: 'APPROVED',
  submittedAt: '2026-05-01T00:00:00.000Z',
  rejectionReason: null,
  user: { id: 'u1', name: 'Anil XSR', phone: '9900000011', role: 'SALES_XSR' },
  partner: {
    id: 'p1', businessName: 'Mehta Distributors', ownerName: 'Mehta',
    address: '12 Market Rd', city: 'Pune', state: 'Maharashtra',
    outlets: [{ id: 'OUT9', name: 'Mehta Distributors', outletCode: 'W123', phone: '9900000011',
      city: 'Pune', state: 'Maharashtra', pincode: '411001', outletType: { code: 'SSS' } }],
  },
  documents: [],
  statusHistory: [],
};

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data: { submission: SUBMISSION } }),
  }));
}

function status(over: Partial<OutletStatusResponse>): OutletStatusResponse {
  return {
    outlet: { outletId: 'OUT9', outletCode: 'W123', outletName: 'Mehta Distributors', outletType: { code: 'SSS', name: 'SSS' } },
    inScope: true,
    canCapture: true,
    windows: [
      { windowKey: '2026-07-P1', startDay: 1, endDay: 15, closed: true, captureId: 'c1', status: 'APPROVED', currentVersion: 1, rejectionReason: null, state: 'approved' },
      { windowKey: '2026-07-P2', startDay: 16, endDay: 31, closed: false, captureId: null, status: null, currentVersion: null, rejectionReason: null, state: 'due' },
    ],
    ...over,
  };
}

async function renderPage() {
  const params = Promise.resolve({ id: 'KYC42' });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <SalesKYCDetailPage params={params} />
      </Suspense>,
    );
    await params;
  });
}

beforeEach(() => {
  mockSettings = { ...DEFAULT_SETTINGS, visibilityEnabled: true, visibilityCaptureMode: 'PHOTO_APPROVAL' };
  getOutletStatus.mockReset();
  stubFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('VPC — Visibility — this period card', () => {
  it('VPC1: renders windows + Capture CTA (redirect ?outletId=) for a due current window', async () => {
    getOutletStatus.mockResolvedValue({ success: true, data: status({}) });
    await renderPage();
    const card = await screen.findByTestId('visibility-period-card');
    expect(card).toBeInTheDocument();
    const cta = await screen.findByTestId('visibility-capture-cta');
    expect(cta.closest('a')).toHaveAttribute('href', '/sales/visibility?outletId=OUT9');
    expect(getOutletStatus).toHaveBeenCalledWith('OUT9');
  });

  it('VPC2: no Capture CTA when the current window is satisfied / not capturable', async () => {
    // All windows approved (closed) → nothing to capture.
    getOutletStatus.mockResolvedValue({
      success: true,
      data: status({
        windows: [
          { windowKey: '2026-07-P1', startDay: 1, endDay: 15, closed: true, captureId: 'c1', status: 'APPROVED', currentVersion: 1, rejectionReason: null, state: 'approved' },
          { windowKey: '2026-07-P2', startDay: 16, endDay: 31, closed: false, captureId: 'c2', status: 'APPROVED', currentVersion: 1, rejectionReason: null, state: 'approved' },
        ],
      }),
    });
    await renderPage();
    await screen.findByTestId('visibility-period-card');
    expect(screen.queryByTestId('visibility-capture-cta')).toBeNull();
  });

  it('VPC3: out-of-scope outlet hides the card', async () => {
    getOutletStatus.mockResolvedValue({ success: true, data: status({ inScope: false, windows: [] }) });
    await renderPage();
    await waitFor(() => expect(getOutletStatus).toHaveBeenCalled());
    await screen.findAllByText('Mehta Distributors'); // page hydrated
    expect(screen.queryByTestId('visibility-period-card')).toBeNull();
  });
});
