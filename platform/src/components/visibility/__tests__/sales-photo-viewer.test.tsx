/// <reference types="vitest/globals" />
/**
 * SPV — Sales photo view shared viewer (tenant-scoped salesPhotoViewLevels).
 *
 * SPV1: thumbnails render lazily with a badge each, the re-take reason, and who/when (IST)
 * SPV2: tapping a thumbnail opens the full-screen viewer; next / previous / swipe move; Esc + close button close
 * SPV3: a photo that fails to load shows a placeholder + "Photo couldn't load" (never a broken image)
 * SPV4: the on-demand sheet shows a loading skeleton, then the photos
 * SPV5: the sheet shows an error with Retry (retry refetches), and "No photos yet" for an empty capture
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
  capturedByLine,
} from '../SalesPhotoViewer';

const DATA: SalesCapturePhotos = {
  captureId: 'cap1',
  windowKey: '2026-11-P1',
  version: 2,
  status: 'CHANGES_REQUESTED',
  capturedBy: 'Ravi ISR',
  capturedAt: '2026-11-03T05:01:00.000Z', // 10:31 am IST
  photos: [
    { fieldId: 'w1', label: 'Window 1', mediaKey: 'k1', viewPath: '/v1/visibility/captures/media?key=k1', status: 'approved', reason: null, capturedAt: null, fenceStatus: 'inside' },
    { fieldId: 'w2', label: 'Counter', mediaKey: 'k2', viewPath: '/v1/visibility/captures/media?key=k2', status: 'needs_retake', reason: 'Photo is blurry / unclear', capturedAt: null },
    { fieldId: 'w3', label: 'Shelf', mediaKey: 'k3', viewPath: '/v1/visibility/captures/media?key=k3', status: 'pending', reason: null, capturedAt: null },
  ],
};

beforeEach(() => getSalesCapturePhotos.mockReset());

describe('SPV — sales photo viewer', () => {
  it('SPV1: thumbnails (lazy) with badges, the re-take reason and who/when in IST', () => {
    render(<SalesPhotoThumbStrip data={DATA} onOpen={() => {}} />);
    const img = screen.getByTestId('thumb-w1') as HTMLImageElement;
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('alt', 'Window 1');
    expect(img.getAttribute('src')).toBe('/api/visibility/captures/media?key=k1');
    expect(screen.getByTestId('photo-badge-approved')).toHaveTextContent('Approved ✓');
    expect(screen.getByTestId('photo-badge-needs_retake')).toHaveTextContent('Needs re-take');
    expect(screen.getByTestId('photo-badge-pending')).toHaveTextContent('Waiting');
    expect(screen.getByTestId('photo-reason-w2')).toHaveTextContent('Counter: Photo is blurry / unclear');
    expect(screen.getByTestId('photo-strip-by')).toHaveTextContent('Taken by Ravi ISR');
    expect(capturedByLine(DATA)).toMatch(/10:31/);
  });

  it('SPV2: opens the viewer; next / previous / swipe move between photos; Esc and the close button close', () => {
    function Harness() {
      const [i, setI] = React.useState<number | null>(null);
      return (
        <>
          <SalesPhotoThumbStrip data={DATA} onOpen={setI} />
          {i !== null && <SalesPhotoLightbox photos={DATA.photos} index={i} onIndexChange={setI} onClose={() => setI(null)} />}
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Open photo: Counter/ }));
    const dlg = screen.getByRole('dialog');
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('photo-lightbox-counter')).toHaveTextContent('2 / 3');
    expect(screen.getByTestId('photo-lightbox-img')).toHaveAttribute('alt', 'Counter');
    expect(screen.getByTestId('photo-lightbox-reason')).toHaveTextContent('Photo is blurry / unclear');
    // Focus starts on the close button (inside the dialog).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close photo' }));

    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }));
    expect(screen.getByTestId('photo-lightbox-counter')).toHaveTextContent('3 / 3');
    fireEvent.keyDown(dlg, { key: 'ArrowRight' }); // wraps
    expect(screen.getByTestId('photo-lightbox-counter')).toHaveTextContent('1 / 3');
    expect(screen.getByTestId('photo-lightbox-fence')).toHaveTextContent('At the outlet');
    // Swipe left → next.
    fireEvent.touchStart(dlg, { touches: [{ clientX: 300 }] });
    fireEvent.touchEnd(dlg, { changedTouches: [{ clientX: 100 }] });
    expect(screen.getByTestId('photo-lightbox-counter')).toHaveTextContent('2 / 3');
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }));
    expect(screen.getByTestId('photo-lightbox-counter')).toHaveTextContent('1 / 3');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Open photo: Window 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close photo' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("SPV3: a photo that fails to load shows a placeholder + \"Photo couldn't load\"", () => {
    render(<SalesPhotoThumbStrip data={DATA} onOpen={() => {}} />);
    fireEvent.error(screen.getByTestId('thumb-w2'));
    expect(screen.queryByTestId('thumb-w2')).toBeNull();
    expect(screen.getByTestId('thumb-w2-error')).toHaveTextContent("Photo couldn't load");
  });

  it('SPV4: the on-demand sheet shows a skeleton, then the photos (loaded for that capture only)', async () => {
    let resolve!: (v: unknown) => void;
    getSalesCapturePhotos.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<SalesCapturePhotosSheet captureId="cap1" outletName="Shop 1" onClose={() => {}} />);
    expect(screen.getByTestId('photos-sheet-loading')).toBeInTheDocument();
    resolve({ success: true, data: DATA });
    const strip = await screen.findByTestId('photos-sheet-strip');
    expect(within(strip).getAllByRole('img')).toHaveLength(3);
    expect(getSalesCapturePhotos).toHaveBeenCalledWith('cap1');
    // Tap → full-screen viewer over the sheet.
    fireEvent.click(screen.getByRole('button', { name: /Open photo: Shelf/ }));
    expect(screen.getByTestId('photo-lightbox')).toBeInTheDocument();
  });

  it('SPV5: error with Retry (refetches); an empty capture says "No photos yet"; Esc closes the sheet', async () => {
    getSalesCapturePhotos.mockResolvedValueOnce({ success: false, error: 'Network down' });
    getSalesCapturePhotos.mockResolvedValueOnce({ success: true, data: { ...DATA, photos: [] } });
    const onClose = vi.fn();
    render(<SalesCapturePhotosSheet captureId="cap1" outletName="Shop 1" onClose={onClose} />);
    expect(await screen.findByTestId('photos-sheet-error')).toHaveTextContent('Network down');
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByTestId('photos-sheet-empty')).toHaveTextContent('No photos yet');
    expect(getSalesCapturePhotos).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
