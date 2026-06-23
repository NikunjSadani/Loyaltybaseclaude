/// <reference types="vitest/globals" />
/**
 * ADVISC — Admin Visibility photo-approval consolidation
 *
 * The FE photo-approval workflow (Approval Queue + Fraud Log tabs) must agree with the
 * authoritative DB flag `visibilityCaptureMode` (enforced by the backend visibility.service),
 * not just the display-only `visibilityPhotoEnabled`. The backend REJECTS photo uploads when
 * the tenant is in AMOUNT_UPLOAD mode, so the gating rule is:
 *
 *   photoApprovalEnabled = visibilityCaptureMode === 'PHOTO_APPROVAL' && visibilityPhotoEnabled
 *
 * ADVISC1: AMOUNT_UPLOAD mode hides the Approval Queue / Fraud Log even if visibilityPhotoEnabled=true
 * ADVISC2: PHOTO_APPROVAL mode + visibilityPhotoEnabled=true shows the Approval Queue tab
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('@/lib/visibility-upload', () => ({
  generateVisibilityTemplate: vi.fn().mockReturnValue(new ArrayBuffer(0)),
}));
// Display flag is ON for both cases — the consolidation must still hide the queue in AMOUNT_UPLOAD.
vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => ({
    visibilityPhotoEnabled: true,
    redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
    creditsPayouts: { monthCutoffDay: 28, safetyCapPoints: 50000, safetyCapInr: 100000, fourEyesEnabled: false },
  }),
}));

import VisibilityPage from '../page';

const MOCK_SUBMISSIONS = [
  {
    id: 'VIS001',
    status: 'SUBMITTED',
    createdAt: '2026-04-30T08:42:00.000Z',
    imageUrls: ['https://placehold.co/600x400'],
    geoLat: 19.1234,
    geoLng: 72.8765,
    partner: { id: 'p1', businessName: 'Sharma General Store' },
    outlet: { id: 'out1', name: 'Sharma Outlet', city: 'Mumbai' },
  },
];

/**
 * Stub fetch so the page's two GETs resolve:
 *  - /api/admin/settings/config        → features.visibilityCaptureMode (capture mode)
 *  - /api/visibility/submissions?...    → queue items
 */
function stubFetch(captureMode: 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD') {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (typeof url === 'string' && url.includes('/api/admin/settings/config')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { features: { visibilityCaptureMode: captureMode } } }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          data: { submissions: MOCK_SUBMISSIONS, pagination: { page: 1, limit: 20, total: 1, pages: 1 } },
        }),
    });
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('ADVISC — Admin Visibility photo-approval consolidation', () => {
  it('ADVISC1: AMOUNT_UPLOAD hides Approval Queue / Fraud Log even when visibilityPhotoEnabled=true', async () => {
    stubFetch('AMOUNT_UPLOAD');
    render(<VisibilityPage />);
    // Bulk Upload tab is always present — wait for the page to settle.
    expect(await screen.findByText(/Bulk Upload/i)).toBeInTheDocument();
    // After the capture mode resolves to AMOUNT_UPLOAD, the photo-only tabs must NOT render.
    await waitFor(() => {
      expect(screen.queryByText(/Approval Queue/i)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/Fraud Log/i)).not.toBeInTheDocument();
  });

  it('ADVISC2: PHOTO_APPROVAL + visibilityPhotoEnabled=true shows the Approval Queue tab', async () => {
    stubFetch('PHOTO_APPROVAL');
    render(<VisibilityPage />);
    expect(await screen.findByText(/Approval Queue/i)).toBeInTheDocument();
    expect(screen.getByText(/Fraud Log/i)).toBeInTheDocument();
  });
});
