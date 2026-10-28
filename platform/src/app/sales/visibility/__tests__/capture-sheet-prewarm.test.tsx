/// <reference types="vitest/globals" />
/**
 * VCS-PW — VisibilityCaptureSheet GPS pre-warm + precise-acquire wiring.
 *
 * VCSPW1: geo-fence tenant (features.outletMasterGeo) → the sheet starts the GPS watch on open
 *         (pre-warm) AND passes preciseGps=true + a gpsWatch handle to the capture form.
 * VCSPW2: non-gated tenant (Deoleo) → NO watch is started and preciseGps=false (byte-identical).
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SalesEligibleOutlet } from '@/lib/visibility-types';

// useTenantFeatures returns a per-test feature value.
let OUTLET_MASTER_GEO = false;
vi.mock('@/lib/tenant-features', () => ({
  useTenantFeatures: () => ({ features: { outletMasterGeo: OUTLET_MASTER_GEO }, loading: false }),
}));

const getSalesForm = vi.fn();
vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    getSalesForm: () => getSalesForm(),
    submitCapture: vi.fn(),
    resubmitCapture: vi.fn(),
    uploadMedia: vi.fn(),
  },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
}));

// The form is mocked to surface the props the sheet passes (preciseGps + whether a watch handle
// arrived) so we can assert the wiring without driving a real camera capture.
vi.mock('@/components/visibility/VisibilityCaptureForm', () => ({
  VisibilityCaptureForm: ({ preciseGps, gpsWatch }: { preciseGps?: boolean; gpsWatch?: unknown }) => (
    <div data-testid="form" data-precise={String(!!preciseGps)} data-haswatch={String(!!gpsWatch)}>
      form
    </div>
  ),
}));

import { VisibilityCaptureSheet } from '../VisibilityCaptureSheet';

const SCHEMA = {
  success: true,
  data: {
    id: 'f1', clientId: 'c1', version: 1, createdAt: '', updatedAt: '',
    formSchema: { captureGpsOnSubmit: false, fields: [{ id: 'photo', type: 'CAMERA', label: 'Photo', required: true, order: 0 }] },
  },
};

const dueOutlet: SalesEligibleOutlet = {
  outletId: 'o1', outletCode: 'C1', outletName: 'Test Store', zone: null, state: null,
  outletType: null, captureId: null, status: null, currentVersion: null, rejectionReason: null,
  windowState: 'due', canCapture: true,
};

const realGeo = navigator.geolocation;
const watchPosition = vi.fn().mockReturnValue(5);
const clearWatch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  watchPosition.mockReturnValue(5);
  getSalesForm.mockResolvedValue(SCHEMA);
  Object.defineProperty(navigator, 'geolocation', {
    value: { watchPosition, clearWatch, getCurrentPosition: vi.fn() },
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(navigator, 'geolocation', { value: realGeo, configurable: true });
});

describe('VCS-PW — capture sheet GPS pre-warm wiring', () => {
  it('VCSPW1: geo-fence tenant → pre-warms the watch on open + passes preciseGps/gpsWatch', async () => {
    OUTLET_MASTER_GEO = true;
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    // The pre-warm watch starts as soon as the sheet mounts (before any capture).
    expect(watchPosition).toHaveBeenCalledTimes(1);
    const form = await screen.findByTestId('form');
    expect(form.getAttribute('data-precise')).toBe('true');
    expect(form.getAttribute('data-haswatch')).toBe('true');
  });

  it('VCSPW2: non-gated tenant → no watch started, preciseGps false (Deoleo byte-identical)', async () => {
    OUTLET_MASTER_GEO = false;
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    const form = await screen.findByTestId('form');
    expect(watchPosition).not.toHaveBeenCalled();
    expect(form.getAttribute('data-precise')).toBe('false');
    expect(form.getAttribute('data-haswatch')).toBe('false');
  });
});
