/// <reference types="vitest/globals" />
/**
 * DST — "Distance from outlet" instead of the phone's ±accuracy (owner 2026-11-28).
 *
 * Reps read "location captured · ±12m" as their distance from the outlet, then got "far from the outlet". The capture
 * form now shows NO accuracy figure; a FENCED photo (or the fenced GPS field of a GPS-point form) shows the server
 * fence's own distance (whole metres), "N m" under 1 km and "N.N km" from 1 km, with the at-the-radius rule.
 *
 * DST1: fenced photo inside → neutral "Distance from outlet: 120 m"; no ± / accuracy text anywhere; aria-live polite
 * DST1b: fenced photo outside → "Distance from outlet: 8.3 km — outside the 200 m limit", warning (red) style
 * DST2: at the radius: 200 → "200 m" inside; 201 → "201 m — outside the 200 m limit"
 * DST3: fence does not apply (no outlet coordinates) → no distance line, just "location captured"
 * DST3b: check in flight → "Checking distance…"
 * DST3c: check failed (429 / offline) → "Couldn't check the distance — it will be checked when you submit" (≠ no-coords)
 * DST3d: Retake while the check is in flight → the late answer never shows on the cleared / new photo
 * DST4: a geotag photo the server does NOT fence → never measured, no distance line
 * DST5: GPS-point form → the first GPS field shows coordinates + distance, no ±
 * DST6: the accuracy-cap refusal names no ±figure
 * DST7: the measure is called with the photo's own stored fix (the exact fix the submit sends)
 * DST8: formatter mirror of the api (fenceDisplayMeters / formatDistance / formatRadius)
 */

import React from 'react';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    uploadSalesMedia: vi.fn().mockResolvedValue({ success: true, data: { key: 'visibility-media/t1/x.jpg' } }),
  },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
}));

import {
  VisibilityCaptureForm,
  fenceMeasuredFieldIds,
  DISTANCE_CHECKING_MESSAGE,
  DISTANCE_CHECK_FAILED_MESSAGE,
  type FenceDistance,
} from '../VisibilityCaptureForm';
import type { VisibilityFormSchema } from '@/lib/visibility-types';
import { distanceFromOutletLabel, fenceDisplayMeters, formatDistance, formatRadius } from '@/lib/geo-distance';

const fencedSchema: VisibilityFormSchema = {
  captureGpsOnSubmit: false,
  fields: [{ id: 'w1', type: 'CAMERA', label: 'Window 1', required: true, order: 1, geotag: true, geoFenceRequired: true, noGallery: false }],
};

const realGeo = navigator.geolocation;
const getCurrentPosition = vi.fn();

function pos(accuracy: number) {
  return {
    coords: { latitude: 21.150509, longitude: 72.832284, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
    timestamp: Date.now(),
  } as GeolocationPosition;
}

const at = (distanceMeters: number | null, radiusMeters: number | null = 200): FenceDistance => ({ distanceMeters, radiusMeters });

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentPosition.mockImplementation((success: (p: GeolocationPosition) => void) => success(pos(13)));
  Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition, watchPosition: vi.fn(), clearWatch: vi.fn() }, configurable: true });
});
afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, 'geolocation', { value: realGeo, configurable: true });
});

function fireCapture(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], 'p.jpg', { type: '' })] } });
}

function expectNoAccuracyText(container: HTMLElement) {
  const text = container.textContent ?? '';
  expect(text).not.toMatch(/±/);
  expect(text).not.toMatch(/accura/i);
  expect(text).not.toMatch(/\b13\s?m\b/); // the phone's 13 m accuracy never appears
}

async function settledLine(findByTestId: (id: string) => Promise<HTMLElement>, id: string) {
  const el = await findByTestId(id);
  await waitFor(() => expect(el.textContent).not.toBe(DISTANCE_CHECKING_MESSAGE));
  return el;
}

describe('DST — Distance from outlet (no ±accuracy)', () => {
  it('DST1: fenced photo inside → neutral line, aria-live polite, no ± / accuracy anywhere', async () => {
    const { container, findByTestId } = render(
      <VisibilityCaptureForm schema={fencedSchema} onSubmit={vi.fn()} measureFenceDistance={vi.fn().mockResolvedValue(at(120))} />,
    );
    fireCapture(container);
    const line = await settledLine(findByTestId, 'camera-w1-distance');
    expect(line.textContent).toBe('Distance from outlet: 120 m');
    expect(line.getAttribute('aria-live')).toBe('polite');
    expect(line.getAttribute('data-outside')).toBe('false');
    expect(line.className).not.toMatch(/red/);
    expectNoAccuracyText(container);
  });

  it('DST1b: fenced photo outside → "… — outside the 200 m limit" in the warning style', async () => {
    const { container, findByTestId } = render(
      <VisibilityCaptureForm schema={fencedSchema} onSubmit={vi.fn()} measureFenceDistance={vi.fn().mockResolvedValue(at(8341))} />,
    );
    fireCapture(container);
    const line = await settledLine(findByTestId, 'camera-w1-distance');
    expect(line.textContent).toBe('Distance from outlet: 8.3 km — outside the 200 m limit');
    expect(line.getAttribute('data-outside')).toBe('true');
    expect(line.className).toMatch(/text-red-700/);
    expectNoAccuracyText(container);
  });

  it('DST2: at the radius — 200 m inside reads "200 m"; 201 m reads outside', async () => {
    const first = render(
      <VisibilityCaptureForm schema={fencedSchema} onSubmit={vi.fn()} measureFenceDistance={vi.fn().mockResolvedValue(at(200))} />,
    );
    fireCapture(first.container);
    expect((await settledLine(first.findByTestId, 'camera-w1-distance')).textContent).toBe('Distance from outlet: 200 m');
    cleanup();
    const second = render(
      <VisibilityCaptureForm schema={fencedSchema} onSubmit={vi.fn()} measureFenceDistance={vi.fn().mockResolvedValue(at(201))} />,
    );
    fireCapture(second.container);
    expect((await settledLine(second.findByTestId, 'camera-w1-distance')).textContent)
      .toBe('Distance from outlet: 201 m — outside the 200 m limit');
  });

  it('DST3: fence does not apply (no outlet coordinates) → no distance line, only "location captured"', async () => {
    const measure = vi.fn().mockResolvedValue(at(null, null));
    const { container, findByText, queryByTestId } = render(
      <VisibilityCaptureForm schema={fencedSchema} onSubmit={vi.fn()} measureFenceDistance={measure} />,
    );
    fireCapture(container);
    await waitFor(() => expect(measure).toHaveBeenCalled());
    expect(await findByText('location captured')).toBeTruthy();
    expect(queryByTestId('camera-w1-distance')).toBeNull();
    expect(container.textContent).not.toMatch(/Distance from outlet|Couldn't check/);
    expectNoAccuracyText(container);
  });

  it('DST3b: while the check is in flight → "Checking distance…"', async () => {
    const measure = vi.fn(() => new Promise<FenceDistance>(() => {})); // never settles
    const { container, findByTestId } = render(
      <VisibilityCaptureForm schema={fencedSchema} onSubmit={vi.fn()} measureFenceDistance={measure} />,
    );
    fireCapture(container);
    const line = await findByTestId('camera-w1-distance');
    expect(line.textContent).toBe(DISTANCE_CHECKING_MESSAGE);
    expect(line.getAttribute('aria-live')).toBe('polite');
  });

  it.each([
    ['429 (throttled)', () => Promise.reject(new Error('Too many requests'))],
    ['offline', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('DST3c: a failed check (%s) → the "couldn\'t check" line, never the no-coordinates text', async (_n, impl) => {
    const { container, findByTestId, queryByText } = render(
      <VisibilityCaptureForm schema={fencedSchema} onSubmit={vi.fn()} measureFenceDistance={vi.fn(impl)} />,
    );
    fireCapture(container);
    const line = await settledLine(findByTestId, 'camera-w1-distance');
    expect(line.textContent).toBe(DISTANCE_CHECK_FAILED_MESSAGE);
    expect(DISTANCE_CHECK_FAILED_MESSAGE).not.toBe('location captured');
    expect(queryByText('location captured')).toBeNull();
    expectNoAccuracyText(container);
  });

  it('DST3d: Retake while the check is in flight → the late answer never shows', async () => {
    const resolvers: Array<(r: FenceDistance) => void> = [];
    const measure = vi.fn(() => new Promise<FenceDistance>((r) => { resolvers.push(r); }));
    const { container, findByTestId, getByRole, queryByTestId } = render(
      <VisibilityCaptureForm schema={fencedSchema} onSubmit={vi.fn()} measureFenceDistance={measure} />,
    );
    fireCapture(container);
    expect((await findByTestId('camera-w1-distance')).textContent).toBe(DISTANCE_CHECKING_MESSAGE);
    // Gallery field: "Retake" re-opens the picker; the camera-only Retake clears. Use the clear path via a new capture
    // with a different fix — the old answer must not attach to it.
    getCurrentPosition.mockImplementation((success: (p: GeolocationPosition) => void) =>
      success({ ...pos(13), coords: { ...pos(13).coords, latitude: 21.2149, longitude: 72.7911 } } as GeolocationPosition));
    expect(getByRole('button', { name: 'Retake' })).toBeTruthy();
    fireCapture(container);
    await waitFor(() => expect(measure).toHaveBeenCalledTimes(2));
    // The FIRST (old-fix) answer arrives late — ignored (keyed on the fix).
    resolvers[0](at(8341));
    await new Promise((r) => setTimeout(r, 10));
    expect(queryByTestId('camera-w1-distance')?.textContent).toBe(DISTANCE_CHECKING_MESSAGE);
    expect(container.textContent).not.toMatch(/8\.3 km/);
    // The NEW fix's answer shows.
    resolvers[1](at(40));
    await waitFor(() => expect(queryByTestId('camera-w1-distance')?.textContent).toBe('Distance from outlet: 40 m'));
  });

  it('DST3e: camera-only Retake while in flight clears the line (late answer discarded)', async () => {
    let resolve!: (r: FenceDistance) => void;
    const measure = vi.fn(() => new Promise<FenceDistance>((r) => { resolve = r; }));
    const cameraOnly: VisibilityFormSchema = {
      captureGpsOnSubmit: false,
      fields: [{ id: 'w1', type: 'CAMERA', label: 'Window 1', required: true, order: 1, geotag: true, geoFenceRequired: true }],
    };
    const { container, findByTestId, getByRole, queryByTestId } = render(
      <VisibilityCaptureForm
        schema={cameraOnly}
        onSubmit={vi.fn()}
        measureFenceDistance={measure}
        initialValues={{ w1: { key: 'visibility-media/t1/x.jpg', geo: { lat: 21.15, lng: 72.83, accuracy: 13 } } }}
      />,
    );
    expect((await findByTestId('camera-w1-distance')).textContent).toBe(DISTANCE_CHECKING_MESSAGE);
    fireEvent.click(getByRole('button', { name: 'Retake' }));
    expect(queryByTestId('camera-w1-distance')).toBeNull();
    resolve(at(8341));
    await new Promise((r) => setTimeout(r, 10));
    expect(queryByTestId('camera-w1-distance')).toBeNull();
    expect(container.textContent).not.toMatch(/Distance from outlet/);
  });

  it('DST4: a geotag photo the server does not fence is never measured', async () => {
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: false,
      fields: [{ id: 'p', type: 'CAMERA', label: 'Shelf', required: false, order: 1, geotag: true, noGallery: false }],
    };
    const measure = vi.fn().mockResolvedValue(at(50));
    const { container, findByText } = render(<VisibilityCaptureForm schema={schema} onSubmit={vi.fn()} measureFenceDistance={measure} />);
    fireCapture(container);
    expect(await findByText('location captured')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    expect(measure).not.toHaveBeenCalled();
    expectNoAccuracyText(container);
  });

  it('DST5: GPS-point form → the first GPS field shows coordinates + distance, never ±', async () => {
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: false,
      fields: [
        { id: 'g1', type: 'GPS_POINT', label: 'Geo tag', required: false, order: 1 },
        { id: 'g2', type: 'GPS_POINT', label: 'Geo tag 2', required: false, order: 2 },
      ],
    };
    expect([...fenceMeasuredFieldIds(schema)]).toEqual(['g1']);
    const { container, getAllByRole, findByTestId } = render(
      <VisibilityCaptureForm schema={schema} onSubmit={vi.fn()} measureFenceDistance={vi.fn().mockResolvedValue(at(450))} />,
    );
    fireEvent.click(getAllByRole('button', { name: /capture location/i })[0]);
    expect((await settledLine(findByTestId, 'gps-g1-distance')).textContent).toBe('Distance from outlet: 450 m — outside the 200 m limit');
    expect(container.textContent).toMatch(/21\.150509, 72\.832284/);
    expectNoAccuracyText(container);
  });

  it('DST6: the accuracy-cap refusal names no ±figure', async () => {
    getCurrentPosition.mockImplementation((success: (p: GeolocationPosition) => void) => success(pos(80)));
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: false,
      fields: [{ ...fencedSchema.fields[0], gpsMaxAccuracy: 30 }],
    };
    const { container, findByText } = render(<VisibilityCaptureForm schema={schema} onSubmit={vi.fn()} />);
    fireCapture(container);
    expect(await findByText('Location not precise enough — move to open sky and re-capture.')).toBeTruthy();
    expect(container.textContent).not.toMatch(/±/);
    expect(container.textContent).not.toMatch(/\b80\s?m\b/);
  });

  it('DST7: the measure receives the photo’s own stored fix', async () => {
    const measure = vi.fn().mockResolvedValue(at(120));
    const { container, findByTestId } = render(
      <VisibilityCaptureForm schema={fencedSchema} onSubmit={vi.fn()} measureFenceDistance={measure} />,
    );
    fireCapture(container);
    await settledLine(findByTestId, 'camera-w1-distance');
    expect(measure).toHaveBeenCalledWith(expect.objectContaining({ lat: 21.150509, lng: 72.832284, accuracy: 13 }));
  });

  it('DST8: formatter mirror — same cases as the api spec', () => {
    // Plain.
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(12.4)).toBe('12 m');
    expect(formatDistance(999.4)).toBe('999 m');
    expect(formatDistance(999.6)).toBe('1.0 km');
    expect(formatDistance(8340.21)).toBe('8.3 km');
    // At the radius (199.6 / 200.0 / 200.3 at 200 m).
    expect(fenceDisplayMeters(199.6, 200)).toBe(200);
    expect(fenceDisplayMeters(200.0, 200)).toBe(200);
    expect(fenceDisplayMeters(200.3, 200)).toBe(201);
    expect(formatDistance(200.3, 200)).toBe('201 m');
    expect(fenceDisplayMeters(50.5, 50.5)).toBe(50);
    // km radius.
    expect(formatRadius(200)).toBe('200 m');
    expect(formatRadius(1000)).toBe('1.0 km');
    expect(formatRadius(1550)).toBe('1.5 km');
    expect(formatDistance(1000.3, 1000)).toBe('1.1 km');
    expect(formatDistance(1549, 1550)).toBe('1.5 km');
    // Labels.
    expect(distanceFromOutletLabel(200, 200)).toEqual({ text: 'Distance from outlet: 200 m', outside: false });
    expect(distanceFromOutletLabel(201, 200)).toEqual({ text: 'Distance from outlet: 201 m — outside the 200 m limit', outside: true });
    expect(distanceFromOutletLabel(1001, 1000)?.text).toBe('Distance from outlet: 1.1 km — outside the 1.0 km limit');
    expect(distanceFromOutletLabel(null)).toBeNull();
    expect(distanceFromOutletLabel(Number.NaN)).toBeNull();
  });
});
