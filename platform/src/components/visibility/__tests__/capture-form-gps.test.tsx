/// <reference types="vitest/globals" />
/**
 * CFG — VisibilityCaptureForm per-photo GPS gating at capture time.
 *
 * CFG1: preciseGps (geo-fence tenant) → a geotag photo capture uses the TIMED acquire
 *       (watchPosition), NOT the single getCurrentPosition call.
 * CFG2: preciseGps off (Deoleo / non-gated) → the capture uses the EXACT existing
 *       getCurrentPosition call, and never a watch (byte-identical).
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    uploadSalesMedia: vi.fn().mockResolvedValue({ success: true, data: { key: 'visibility-media/t1/x.jpg' } }),
  },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
}));

import { VisibilityCaptureForm } from '../VisibilityCaptureForm';
import type { VisibilityFormSchema } from '@/lib/visibility-types';

const schema: VisibilityFormSchema = {
  captureGpsOnSubmit: false,
  // noGallery:false → the gallery <input type=file> renders so we can fire a capture.
  // geotag:true → the capture path fetches a per-photo GPS fix via captureGps.
  fields: [{ id: 'photo', type: 'CAMERA', label: 'Shelf', required: false, order: 1, geotag: true, noGallery: false }],
};

const realGeo = navigator.geolocation;
const watchPosition = vi.fn();
const clearWatch = vi.fn();
const getCurrentPosition = vi.fn();

function goodPos() {
  return {
    coords: { latitude: 12.9, longitude: 77.5, accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
    timestamp: Date.now(),
  } as GeolocationPosition;
}

beforeEach(() => {
  vi.clearAllMocks();
  // watchPosition delivers a good fix synchronously → the timed acquire early-accepts.
  watchPosition.mockImplementation((success: (p: GeolocationPosition) => void) => { success(goodPos()); return 1; });
  getCurrentPosition.mockImplementation((success: (p: GeolocationPosition) => void) => success(goodPos()));
  Object.defineProperty(navigator, 'geolocation', {
    value: { watchPosition, clearWatch, getCurrentPosition },
    configurable: true,
  });
});
afterEach(() => {
  Object.defineProperty(navigator, 'geolocation', { value: realGeo, configurable: true });
});

function fireCapture(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['x'], 'p.jpg', { type: '' }); // empty type → compression returns it as-is
  fireEvent.change(input, { target: { files: [file] } });
}

describe('CFG — VisibilityCaptureForm GPS gating', () => {
  it('CFG1: preciseGps → capture uses the timed acquire (watchPosition), not getCurrentPosition', async () => {
    const { container } = render(<VisibilityCaptureForm schema={schema} onSubmit={vi.fn()} preciseGps />);
    fireCapture(container);
    await waitFor(() => expect(watchPosition).toHaveBeenCalled());
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('CFG2: non-gated → capture uses getCurrentPosition, never a watch (byte-identical)', async () => {
    const { container } = render(<VisibilityCaptureForm schema={schema} onSubmit={vi.fn()} preciseGps={false} />);
    fireCapture(container);
    await waitFor(() => expect(getCurrentPosition).toHaveBeenCalledTimes(1));
    expect(watchPosition).not.toHaveBeenCalled();
  });
});
