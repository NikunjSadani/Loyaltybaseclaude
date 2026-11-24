/// <reference types="vitest/globals" />
/**
 * VPP — the outlet page "Visibility — this period" card with the sales photo view (tenant-scoped
 * salesPhotoViewLevels).
 *
 * VPP1: a window whose capture carries photos → thumbnail strip with badges + who/when; tap opens the viewer
 * VPP2: no photo data (feature off for this tenant / level) → exactly the old card: no strip, no viewer
 */
import React, { Suspense, act } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
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
vi.mock('@/lib/sales-role', () => ({ getRole: () => 'ASM', hasTeamView: () => false }));

let mockSettings: GifsySettings = DEFAULT_SETTINGS;
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@/lib/gifsy-settings');
  return { ...actual, useGifsySettings: () => mockSettings };
});

const getOutletStatus = vi.fn();
vi.mock('@/lib/visibility', () => ({
  visibilityApi: { getOutletStatus: (id: string) => getOutletStatus(id) },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
  rewriteMediaViewPath: (p: string) => p.replace(/^\/v1\//, '/api/'),
}));

import SalesKYCDetailPage from '../page';

const SUBMISSION = {
  id: 'KYC42', status: 'APPROVED', submittedAt: '2026-05-01T00:00:00.000Z', rejectionReason: null,
  user: { id: 'u1', name: 'Anil XSR', phone: '9900000011', role: 'SALES_XSR' },
  partner: {
    id: 'p1', businessName: 'Mehta Distributors', ownerName: 'Mehta', address: '12 Market Rd', city: 'Pune', state: 'Maharashtra',
    outlets: [{ id: 'OUT9', name: 'Mehta Distributors', outletCode: 'W123', phone: '9900000011',
      city: 'Pune', state: 'Maharashtra', pincode: '411001', outletType: { code: 'SSS' } }],
  },
  documents: [], statusHistory: [],
};

const WINDOW = {
  windowKey: '2026-11-P1', startDay: 1, endDay: 30, closed: false, captureId: 'c1', status: 'CHANGES_REQUESTED' as const,
  currentVersion: 2, rejectionReason: null, state: 'rejected' as const,
};

function status(withPhotos: boolean): OutletStatusResponse {
  return {
    outlet: { outletId: 'OUT9', outletCode: 'W123', outletName: 'Mehta Distributors', outletType: { code: 'SSS', name: 'SSS' } },
    inScope: true,
    canCapture: false,
    ...(withPhotos ? { photoView: true as const } : {}),
    windows: [
      withPhotos
        ? {
            ...WINDOW,
            photos: {
              captureId: 'c1', windowKey: '2026-11-P1', version: 2, status: 'CHANGES_REQUESTED',
              capturedBy: 'Ravi ISR', capturedAt: '2026-11-03T05:01:00.000Z',
              photos: [
                { fieldId: 'w1', label: 'Window 1', mediaKey: 'k1', viewPath: '/v1/visibility/captures/media?key=k1', status: 'approved', reason: null, capturedAt: null },
                { fieldId: 'w2', label: 'Counter', mediaKey: 'k2', viewPath: '/v1/visibility/captures/media?key=k2', status: 'needs_retake', reason: 'Wrong outlet', capturedAt: null },
              ],
            },
          }
        : WINDOW,
    ],
  };
}

async function renderPage() {
  const params = Promise.resolve({ id: 'KYC42' });
  await act(async () => {
    render(<Suspense fallback={<div>Loading…</div>}><SalesKYCDetailPage params={params} /></Suspense>);
    await params;
  });
}

beforeEach(() => {
  mockSettings = { ...DEFAULT_SETTINGS, visibilityEnabled: true, visibilityCaptureMode: 'PHOTO_APPROVAL' };
  getOutletStatus.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: () => Promise.resolve({ success: true, data: { submission: SUBMISSION } }),
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('VPP — Visibility card photos', () => {
  it('VPP1: thumbnails with badges + who/when under the window; tap opens the full-screen viewer', async () => {
    getOutletStatus.mockResolvedValue({ success: true, data: status(true) });
    await renderPage();
    const strip = await screen.findByTestId('visibility-photos-2026-11-P1');
    expect(strip).toHaveTextContent('Approved ✓');
    expect(strip).toHaveTextContent('Needs re-take');
    expect(strip).toHaveTextContent('Counter: Wrong outlet');
    expect(strip).toHaveTextContent('Taken by Ravi ISR');
    fireEvent.click(screen.getByRole('button', { name: /Open photo: Counter/ }));
    expect(screen.getByTestId('photo-lightbox')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close photo' }));
    expect(screen.queryByTestId('photo-lightbox')).toBeNull();
  });

  it('VPP2: no photo data → no strip, no images (the card of before)', async () => {
    getOutletStatus.mockResolvedValue({ success: true, data: status(false) });
    await renderPage();
    const card = await screen.findByTestId('visibility-period-card');
    expect(screen.queryByTestId('visibility-photos-2026-11-P1')).toBeNull();
    expect(card.querySelectorAll('img')).toHaveLength(0);
  });
});
