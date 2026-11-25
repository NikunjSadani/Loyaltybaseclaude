/// <reference types="vitest/globals" />
/**
 * SPV — Sales photo view shared viewer (tenant-scoped salesPhotoViewLevels).
 *
 * SPV1: thumbnails render lazily with a badge each, the re-take reason, and "Submitted by X · time" (IST)
 * SPV2: tap opens the full-screen viewer; next / previous / one-finger swipe move; Esc + close button close
 * SPV3: a failed photo shows a placeholder + "Photo couldn't load · Tap to retry"; the retry re-requests (cache-bust)
 * SPV4: the on-demand sheet shows a loading skeleton, then the photos
 * SPV5: the sheet shows an error with Retry, and "No photos in this capture" for an empty capture; Esc closes
 * SPV6: a pinch (two fingers) never moves to another photo
 * SPV7: the viewer shows THIS photo's "Taken by" (a carried-forward photo keeps its own), a spinner while loading,
 *       a live counter, and locks page scroll while open
 * SPV8: whole-capture reject → the reason once; a closed never-reviewed window → "Not reviewed"
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { SalesCapturePhotos } from '@/lib/visibility-types';

const getSalesCapturePhotos = vi.fn();
vi.mock('@/lib/visibility', () => ({
  visibilityApi: { getSalesCapturePhotos: (id: string) => getSalesCapturePhotos(id) },
  rewriteMediaViewPath: (p: string) => p.replace(/^\/v1\//, '/api/'),
}));

import {
  SalesPhotoThumbStrip,
  SalesPhotoLightbox,
  SalesCapturePhotosSheet,
  submittedByLine,
} from '../SalesPhotoViewer';

const DATA: SalesCapturePhotos = {
  captureId: 'cap1',
  windowKey: '2026-11-P1',
  version: 2,
  status: 'CHANGES_REQUESTED',
  submittedBy: 'Ravi ISR',
  submittedAt: '2026-11-03T05:01:00.000Z', // 10:31 am IST
  captureReason: null,
  windowClosed: false,
  photos: [
    { fieldId: 'w1', label: 'Window 1', mediaKey: 'k1', viewPath: '/v1/visibility/captures/media?key=k1', status: 'approved', reason: null,
      capturedAt: '2026-11-02T04:00:00.000Z', takenBy: 'Asha SO', fenceStatus: 'unverifiable' },
    { fieldId: 'w2', label: 'Counter', mediaKey: 'k2', viewPath: '/v1/visibility/captures/media?key=k2', status: 'needs_retake', reason: 'Photo is blurry / unclear',
      capturedAt: '2026-11-03T05:01:00.000Z', takenBy: 'Ravi ISR' },
    { fieldId: 'w3', label: 'Shelf', mediaKey: 'k3', viewPath: '/v1/visibility/captures/media?key=k3', status: 'pending', reason: null,
      capturedAt: null, takenBy: 'Ravi ISR' },
  ],
};

function Harness({ data = DATA }: { data?: SalesCapturePhotos }) {
  const [i, setI] = React.useState<number | null>(null);
  return (
    <>
      <SalesPhotoThumbStrip data={data} onOpen={setI} />
      {i !== null && (
        <SalesPhotoLightbox photos={data.photos} index={i} onIndexChange={setI} onClose={() => setI(null)}
          windowClosed={data.windowClosed} captureReason={data.captureReason} />
      )}
    </>
  );
}

beforeEach(() => { getSalesCapturePhotos.mockReset(); document.body.style.overflow = ''; });

describe('SPV — sales photo viewer', () => {
  it('SPV1: thumbnails (lazy) with badges, the re-take reason and "Submitted by" in IST', () => {
    render(<SalesPhotoThumbStrip data={DATA} onOpen={() => {}} />);
    const img = screen.getByTestId('thumb-w1') as HTMLImageElement;
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('alt', 'Window 1');
    expect(img.getAttribute('src')).toBe('/api/visibility/captures/media?key=k1');
    expect(screen.getByTestId('photo-badge-approved')).toHaveTextContent('Approved ✓');
    expect(screen.getByTestId('photo-badge-needs_retake')).toHaveTextContent('Needs re-take');
    expect(screen.getByTestId('photo-badge-pending')).toHaveTextContent('Waiting');
    expect(screen.getByTestId('photo-reason-w2')).toHaveTextContent('Counter: Photo is blurry / unclear');
    expect(screen.getByTestId('photo-strip-by')).toHaveTextContent('Submitted by Ravi ISR');
    expect(submittedByLine(DATA)).toMatch(/10:31/);
  });

  it('SPV2: opens the viewer; next / previous / swipe move between photos; Esc and the close button close', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Open photo: Counter/ }));
    const dlg = screen.getByRole('dialog');
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('photo-lightbox-counter')).toHaveTextContent('2 / 3');
    expect(screen.getByTestId('photo-lightbox-img')).toHaveAttribute('alt', 'Counter');
    expect(screen.getByTestId('photo-lightbox-reason')).toHaveTextContent('Photo is blurry / unclear');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close photo' }));

    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
    expect(screen.getByTestId('photo-lightbox-counter')).toHaveTextContent('3 / 3');
    fireEvent.keyDown(dlg, { key: 'ArrowRight' }); // wraps
    expect(screen.getByTestId('photo-lightbox-counter')).toHaveTextContent('1 / 3');
    expect(screen.getByTestId('photo-lightbox-fence')).toHaveTextContent("Location couldn't be verified");
    // One-finger swipe left → next.
    fireEvent.touchStart(dlg, { touches: [{ clientX: 300 }] });
    fireEvent.touchEnd(dlg, { touches: [], changedTouches: [{ clientX: 100 }] });
    expect(screen.getByTestId('photo-lightbox-counter')).toHaveTextContent('2 / 3');
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }));
    expect(screen.getByTestId('photo-lightbox-counter')).toHaveTextContent('1 / 3');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Open photo: Window 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close photo' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("SPV3: a failed photo shows \"Photo couldn't load · Tap to retry\"; tapping retries with a cache-buster", () => {
    render(<SalesPhotoThumbStrip data={DATA} onOpen={() => {}} />);
    fireEvent.error(screen.getByTestId('thumb-w2'));
    expect(screen.queryByTestId('thumb-w2')).toBeNull();
    const ph = screen.getByTestId('thumb-w2-error');
    expect(ph).toHaveTextContent("Photo couldn't load");
    expect(ph).toHaveTextContent('Tap to retry');
    // The thumbnail button retries instead of opening (no button nested in a button).
    const btn = screen.getByRole('button', { name: /Counter — photo couldn't load. Tap to retry/ });
    expect(btn.querySelector('button')).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByTestId('thumb-w2').getAttribute('src')).toBe('/api/visibility/captures/media?key=k2&r=1');
  });

  it('SPV4: the on-demand sheet shows a skeleton, then the photos (loaded for that capture only)', async () => {
    let resolve!: (v: unknown) => void;
    getSalesCapturePhotos.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<SalesCapturePhotosSheet captureId="cap1" outletName="Shop 1" onClose={() => {}} />);
    expect(screen.getByTestId('photos-sheet-loading')).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');
    resolve({ success: true, data: DATA });
    const strip = await screen.findByTestId('photos-sheet-strip');
    expect(within(strip).getAllByRole('img')).toHaveLength(3);
    expect(getSalesCapturePhotos).toHaveBeenCalledWith('cap1');
    fireEvent.click(screen.getByRole('button', { name: /Open photo: Shelf/ }));
    expect(screen.getByTestId('photo-lightbox')).toBeInTheDocument();
  });

  it('SPV5: error with Retry (refetches); an empty capture says "No photos in this capture"; Esc closes', async () => {
    getSalesCapturePhotos.mockResolvedValueOnce({ success: false, error: 'Network down' });
    getSalesCapturePhotos.mockResolvedValueOnce({ success: true, data: { ...DATA, photos: [] } });
    const onClose = vi.fn();
    render(<SalesCapturePhotosSheet captureId="cap1" outletName="Shop 1" onClose={onClose} />);
    expect(await screen.findByTestId('photos-sheet-error')).toHaveTextContent('Network down');
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByTestId('photos-sheet-empty')).toHaveTextContent('No photos in this capture');
    expect(getSalesCapturePhotos).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('SPV6: a two-finger pinch never moves to another photo', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Open photo: Window 1/ }));
    const dlg = screen.getByRole('dialog');
    fireEvent.touchStart(dlg, { touches: [{ clientX: 300 }] });
    fireEvent.touchMove(dlg, { touches: [{ clientX: 300 }, { clientX: 100 }] });
    fireEvent.touchEnd(dlg, { touches: [{ clientX: 100 }], changedTouches: [{ clientX: 300 }] });
    fireEvent.touchEnd(dlg, { touches: [], changedTouches: [{ clientX: 50 }] });
    expect(screen.getByTestId('photo-lightbox-counter')).toHaveTextContent('1 / 3');
  });

  it('SPV7: per-photo "Taken by" + time, a loading spinner, a live counter, and page scroll locked while open', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Open photo: Window 1/ }));
    expect(screen.getByTestId('photo-lightbox-taken')).toHaveTextContent('Taken by Asha SO');
    expect(screen.getByTestId('photo-lightbox-taken')).toHaveTextContent(/9:30/);
    expect(screen.getByTestId('photo-lightbox-img-loading')).toBeInTheDocument();
    fireEvent.load(screen.getByTestId('photo-lightbox-img'));
    expect(screen.queryByTestId('photo-lightbox-img-loading')).toBeNull();
    expect(screen.getByTestId('photo-lightbox-counter')).toHaveAttribute('aria-live', 'polite');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Close photo' }));
    expect(document.body.style.overflow).toBe('');
  });

  it('SPV8: whole-capture reject shows the reason ONCE; a closed never-reviewed window reads "Not reviewed"', () => {
    const rejected: SalesCapturePhotos = {
      ...DATA, status: 'REJECTED', captureReason: 'Wrong outlet',
      photos: DATA.photos.map((p) => ({ ...p, status: 'needs_retake' as const, reason: null })),
    };
    const { unmount } = render(<SalesPhotoThumbStrip data={rejected} onOpen={() => {}} />);
    expect(screen.getAllByText(/Wrong outlet/)).toHaveLength(1);
    expect(screen.getByTestId('photo-strip-capture-reason')).toHaveTextContent('Re-take needed: Wrong outlet');
    unmount();
    const closed: SalesCapturePhotos = { ...DATA, windowClosed: true };
    render(<SalesPhotoThumbStrip data={closed} onOpen={() => {}} />);
    expect(screen.getByTestId('photo-badge-not_reviewed')).toHaveTextContent('Not reviewed');
    expect(screen.queryByTestId('photo-badge-pending')).toBeNull();
  });
});
