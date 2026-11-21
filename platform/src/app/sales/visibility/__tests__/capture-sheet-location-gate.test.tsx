/// <reference types="vitest/globals" />
/**
 * VCS-LG — VisibilityCaptureSheet location gate (features.requireLocation; docs/plans/LOCATION-GATE.md).
 *
 * VCSLG1: ON + location blocked → the guide shows, the form is HIDDEN but still mounted (photos are kept), and the
 *         form is told requireLocation; "Test again" with a fix reveals the form.
 * VCSLG2: ON + a fix → the form shows; a submit whose fresh check fails is NOT sent to the API.
 * VCSLG3: explicit false (emergency off) → no guide, no location check at all, requireLocation=false.
 * VCSLG4: DEFAULT ON (owner 2026-11-21) — no stored key → gated.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalesEligibleOutlet } from '@/lib/visibility-types';

// The raw stored value (undefined = key ABSENT) goes through the REAL normalizeFeatures → isLocationRequired.
let REQUIRE_LOCATION: boolean | undefined = false;
let FEATURES_STATE: 'ok' | 'error' | 'loading' = 'ok';
vi.mock('@/lib/tenant-features', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tenant-features')>();
  return {
    ...actual,
    useTenantFeatures: () => ({
      features: actual.normalizeFeatures(
        FEATURES_STATE !== 'ok' ? undefined : REQUIRE_LOCATION === undefined ? { outletMasterGeo: false } : { outletMasterGeo: false, requireLocation: REQUIRE_LOCATION },
      ),
      loading: FEATURES_STATE === 'loading',
      error: FEATURES_STATE === 'error',
    }),
  };
});

const getSalesForm = vi.fn();
const submitCapture = vi.fn();
vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    getSalesForm: () => getSalesForm(),
    submitCapture: (...a: unknown[]) => submitCapture(...a),
    resubmitCapture: vi.fn(),
  },
  mediaViewUrl: (k: string) => k,
}));

// The form is mocked: it exposes requireLocation and lets the test trigger the sheet's submit handler.
vi.mock('@/components/visibility/VisibilityCaptureForm', () => ({
  VisibilityCaptureForm: ({ requireLocation, cameraPaused, captureHold, onSubmit }: { requireLocation?: boolean; cameraPaused?: boolean; captureHold?: boolean; onSubmit: (v: unknown) => Promise<void> }) => (
    <div data-testid="form" data-require={String(!!requireLocation)} data-camera-paused={String(!!cameraPaused)} data-hold={String(!!captureHold)}>
      <button onClick={() => onSubmit({ photo: 'k' }).catch(() => undefined)}>do-submit</button>
    </div>
  ),
}));

import { VisibilityCaptureSheet } from '../VisibilityCaptureSheet';

const SCHEMA = {
  success: true,
  data: { formSchema: { fields: [{ id: 'photo', type: 'CAMERA', label: 'Photo', required: true, order: 0 }] } },
};
const outlet: SalesEligibleOutlet = {
  outletId: 'o1', outletCode: 'C1', outletName: 'Test Store', zone: null, state: null,
  outletType: null, captureId: null, status: null, currentVersion: null, rejectionReason: null,
  windowState: 'due', canCapture: true,
};

const realGeo = navigator.geolocation;
const getCurrentPosition = vi.fn();
const fix = (cb: PositionCallback) => cb({ coords: { latitude: 12.9, longitude: 77.5, accuracy: 9 } } as GeolocationPosition);
const denied = (_c: PositionCallback, e: PositionErrorCallback) => e({ code: 1 } as GeolocationPositionError);

beforeEach(() => {
  vi.clearAllMocks();
  getSalesForm.mockResolvedValue(SCHEMA);
  submitCapture.mockResolvedValue({ success: true, data: { flags: [], duplicatePhoto: false } });
  Object.defineProperty(navigator, 'geolocation', {
    value: { getCurrentPosition, watchPosition: vi.fn(), clearWatch: vi.fn() },
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(navigator, 'geolocation', { value: realGeo, configurable: true });
});

describe('VCS-LG — capture sheet location gate', () => {
  it('VCSLG1: ON + blocked → guide shown, form hidden but mounted; Test again with a fix reveals it', async () => {
    REQUIRE_LOCATION = true;
    getCurrentPosition.mockImplementation(denied);
    render(<VisibilityCaptureSheet outlet={outlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    const panel = await screen.findByTestId('location-gate-blocked');
    expect(panel.getAttribute('data-reason')).toBe('denied');
    expect(screen.getByText(/Location is required to capture visibility/)).toBeTruthy();
    const area = screen.getByTestId('visibility-form-area');
    expect(area.hidden).toBe(true);
    expect((await screen.findByTestId('form')).getAttribute('data-require')).toBe('true'); // mounted while hidden
    expect(screen.getByTestId('form').getAttribute('data-camera-paused')).toBe('true'); // no hidden camera stream

    getCurrentPosition.mockImplementation(fix);
    fireEvent.click(screen.getByTestId('location-gate-test-again'));
    await waitFor(() => expect(screen.getByTestId('visibility-form-area').hidden).toBe(false));
    expect(screen.queryByTestId('location-gate-blocked')).toBeNull();
  });

  it('REVIEW: ON + fix → the submit carries the fresh fix as captureGeo', async () => {
    REQUIRE_LOCATION = true;
    getCurrentPosition.mockImplementation(fix);
    render(<VisibilityCaptureSheet outlet={outlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('visibility-form-area').hidden).toBe(false));
    fireEvent.click(await screen.findByText('do-submit'));
    await waitFor(() => expect(submitCapture).toHaveBeenCalledTimes(1));
    expect(submitCapture.mock.calls[0][0]).toMatchObject({ outletId: 'o1', captureGeo: { lat: 12.9, lng: 77.5, accuracy: 9 } });
  });

  it('VCSLG2: ON + fix → form shown; a submit whose fresh check fails is not sent', async () => {
    REQUIRE_LOCATION = true;
    getCurrentPosition.mockImplementation(fix);
    render(<VisibilityCaptureSheet outlet={outlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('visibility-form-area').hidden).toBe(false));
    getCurrentPosition.mockImplementation(denied);
    fireEvent.click(await screen.findByText('do-submit'));
    expect(await screen.findByTestId('location-gate-blocked')).toBeTruthy();
    expect(submitCapture).not.toHaveBeenCalled();
  });

  it('VCSLG4: DEFAULT ON — key ABSENT + blocked → guide shown, form told requireLocation', async () => {
    REQUIRE_LOCATION = undefined;
    getCurrentPosition.mockImplementation(denied);
    render(<VisibilityCaptureSheet outlet={outlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByTestId('location-gate-blocked')).toBeTruthy();
    expect((await screen.findByTestId('form')).getAttribute('data-require')).toBe('true');
  });

  it('VCSLG5: settings load FAILED → gate ON (guide), form told requireLocation, "may be required" note', async () => {
    FEATURES_STATE = 'error';
    getCurrentPosition.mockImplementation(denied);
    try {
      render(<VisibilityCaptureSheet outlet={outlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
      expect(await screen.findByTestId('location-gate-blocked')).toBeTruthy();
      expect((await screen.findByTestId('form')).getAttribute('data-require')).toBe('true');
      expect(screen.getByTestId('location-settings-note')).toBeTruthy();
    } finally {
      FEATURES_STATE = 'ok';
    }
  });

  it('VCSLG6: settings still LOADING (never seen) → form told requireLocation + camera held (never requireLocation=false)', async () => {
    FEATURES_STATE = 'loading';
    getCurrentPosition.mockImplementation(fix);
    try {
      render(<VisibilityCaptureSheet outlet={outlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
      const form = await screen.findByTestId('form');
      expect(form.getAttribute('data-require')).toBe('true');
      expect(form.getAttribute('data-hold')).toBe('true');
    } finally {
      FEATURES_STATE = 'ok';
    }
  });

  it('VCSLG3: explicit false (emergency off) → no guide, no location check, requireLocation=false (unchanged)', async () => {
    REQUIRE_LOCATION = false;
    render(<VisibilityCaptureSheet outlet={outlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    expect((await screen.findByTestId('form')).getAttribute('data-require')).toBe('false');
    expect(screen.getByTestId('form').getAttribute('data-hold')).toBe('false'); // round-3 #4: never held for Deoleo
    expect(screen.queryByTestId('location-settings-note')).toBeNull();
    expect(screen.queryByTestId('location-gate-blocked')).toBeNull();
    expect(screen.queryByTestId('location-gate-checking')).toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('do-submit'));
    await waitFor(() => expect(submitCapture).toHaveBeenCalledTimes(1));
    expect(submitCapture.mock.calls[0][0]).not.toHaveProperty('captureGeo'); // Deoleo request unchanged
  });
});
