/// <reference types="vitest/globals" />
/**
 * VLP — Sales Visibility list with the sales photo view (tenant-scoped salesPhotoViewLevels).
 *
 * VLP1: photo chips All / Waiting / Approved / Needs re-take with counts; a chip filters the list client-side
 * VLP2: a row with a capture gets "Photos" → the on-demand sheet loads that capture's photos
 * VLP3: no photoView flag (feature off) → no chips, no Photos buttons (the list of before)
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { SalesEligibleResponse } from '@/lib/visibility-types';

vi.mock('@/lib/location-required', () => ({ isLocationRequired: () => false }));
vi.mock('@/lib/use-location-setting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-location-setting')>()),
  useLocationSetting: () => ({ lastKnown: false, gateEnabled: false, requireForForm: false, captureHold: false, settingsNote: false }),
}));
vi.mock('@/lib/gifsy-settings', () => ({
  useGifsySettings: () => ({ visibilityEnabled: true, visibilityCaptureMode: 'PHOTO_APPROVAL' }),
  useGifsySettingsReady: () => true,
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const getSalesEligible = vi.fn();
const getSalesCapturePhotos = vi.fn();
vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    getSalesEligible: () => getSalesEligible(),
    getSalesCapturePhotos: (id: string) => getSalesCapturePhotos(id),
    getForm: vi.fn(), getSalesForm: vi.fn(), submitCapture: vi.fn(), resubmitCapture: vi.fn(), uploadMedia: vi.fn(),
  },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
  rewriteMediaViewPath: (p: string) => p.replace(/^\/v1\//, '/api/'),
}));

// The capture sheet is stubbed: it just reports a finished capture (the list's reaction is what is tested here).
vi.mock('../VisibilityCaptureSheet', () => ({
  VisibilityCaptureSheet: ({ outlet, onCaptured, onClose }: {
    outlet: { outletId: string }; onCaptured: (id: string, s: string) => void; onClose: () => void;
  }) => (
    <button type="button" onClick={() => { onCaptured(outlet.outletId, 'awaiting'); onClose(); }}>Finish capture</button>
  ),
}));

import SalesVisibilityPage from '../page';

const row = (id: string, name: string, over: Record<string, unknown>) => ({
  outletId: id, outletCode: id.toUpperCase(), outletName: name, zone: null, state: null, outletType: null,
  captureId: null, status: null, currentVersion: null, rejectionReason: null, windowState: 'due', canCapture: false, ...over,
});

const BASE: SalesEligibleResponse = {
  windowKey: '2026-11-P1',
  window: { startDay: 1, endDay: 30 },
  levelAllowed: false,
  members: [],
  outlets: [
    row('o1', 'Due Store', {}),
    row('o2', 'Waiting Store', { captureId: 'c2', status: 'SUBMITTED', currentVersion: 1, windowState: 'awaiting' }),
    row('o3', 'Approved Store', { captureId: 'c3', status: 'APPROVED', currentVersion: 1, windowState: 'approved' }),
    row('o4', 'Retake Store', { captureId: 'c4', status: 'CHANGES_REQUESTED', currentVersion: 1, windowState: 'rejected' }),
    row('o5', 'Rejected Store', { captureId: 'c5', status: 'REJECTED', currentVersion: 1, windowState: 'rejected' }),
  ] as SalesEligibleResponse['outlets'],
};

beforeEach(() => {
  getSalesEligible.mockReset();
  getSalesCapturePhotos.mockReset();
});

describe('VLP — Visibility list photo view', () => {
  it('VLP1: chips with counts filter the list client-side', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: { ...BASE, photoView: true } });
    render(<SalesVisibilityPage />);
    await screen.findByText('Due Store');
    expect(screen.getByTestId('photo-chip-all')).toHaveTextContent('All (5)');
    expect(screen.getByTestId('photo-chip-waiting')).toHaveTextContent('Waiting (1)');
    expect(screen.getByTestId('photo-chip-approved')).toHaveTextContent('Approved (1)');
    expect(screen.getByTestId('photo-chip-retake')).toHaveTextContent('Needs re-take (2)');

    fireEvent.click(screen.getByTestId('photo-chip-retake'));
    expect(screen.getByTestId('photo-chip-retake')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Retake Store')).toBeInTheDocument();
    expect(screen.getByText('Rejected Store')).toBeInTheDocument();
    expect(screen.queryByText('Due Store')).toBeNull();
    expect(screen.queryByText('Approved Store')).toBeNull();

    fireEvent.click(screen.getByTestId('photo-chip-approved'));
    expect(screen.getByText('Approved Store')).toBeInTheDocument();
    expect(screen.queryByText('Retake Store')).toBeNull();

    fireEvent.click(screen.getByTestId('photo-chip-all'));
    expect(screen.getByText('Due Store')).toBeInTheDocument();
  });

  it('VLP2: "Photos" only on rows with a capture; it loads that capture on demand', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: { ...BASE, photoView: true } });
    getSalesCapturePhotos.mockResolvedValue({
      success: true,
      data: { captureId: 'c3', windowKey: '2026-11-P1', version: 1, status: 'APPROVED', submittedBy: 'Ravi', submittedAt: null,
        captureReason: null, windowClosed: false,
        photos: [{ fieldId: 'w1', label: 'Window 1', mediaKey: 'k', viewPath: '/v1/visibility/captures/media?key=k', status: 'approved', reason: null, capturedAt: null, takenBy: 'Ravi' }] },
    });
    render(<SalesVisibilityPage />);
    await screen.findByText('Due Store');
    expect(screen.queryByTestId('view-photos-o1')).toBeNull(); // no capture → no button
    expect(getSalesCapturePhotos).not.toHaveBeenCalled(); // nothing fetched for the list
    fireEvent.click(screen.getByTestId('view-photos-o3'));
    expect(getSalesCapturePhotos).toHaveBeenCalledWith('c3');
    expect(await screen.findByTestId('photos-sheet-strip')).toHaveTextContent('Approved ✓');
  });

  it('VLP4: on a phone the actions sit on their own line (Recapture + View photos never squeeze the name / badge)', async () => {
    const data = {
      ...BASE, photoView: true as const, levelAllowed: true,
      outlets: [row('o4', 'A Very Long Retake Store Name That Would Overflow', {
        captureId: 'c4', status: 'CHANGES_REQUESTED', currentVersion: 1, windowState: 'rejected', canCapture: true,
      })] as SalesEligibleResponse['outlets'],
    };
    getSalesEligible.mockResolvedValue({ success: true, data });
    render(<SalesVisibilityPage />);
    await screen.findByText(/A Very Long Retake Store/);
    const rowEl = screen.getByTestId('vis-row-o4');
    const actions = screen.getByTestId('vis-row-actions-o4');
    expect(rowEl.className).toContain('flex-wrap');
    expect(actions.className).toContain('w-full');
    expect(actions.className).toContain('sm:w-auto');
    expect(actions).toHaveTextContent('Recapture');
    expect(actions).toHaveTextContent('View photos');
    // The badge stays with the name, outside the actions line.
    expect(actions).not.toHaveTextContent('Needs re-take');
  });

  it('VLP5: the chip group is labelled; a chip whose count drops to 0 falls back to All', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: { ...BASE, photoView: true } });
    render(<SalesVisibilityPage />);
    await screen.findByText('Due Store');
    expect(screen.getByRole('group', { name: 'Outlets by photo status' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('photo-chip-waiting'));
    expect(screen.queryByText('Due Store')).toBeNull();
    // Search away the only Waiting outlet → Waiting has 0 → back to All.
    fireEvent.change(screen.getByPlaceholderText(/Search outlets/), { target: { value: 'Approved' } });
    expect(await screen.findByTestId('photo-chip-all')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Approved Store')).toBeInTheDocument();
  });

  it('VLP6: after a capture the list is re-read quietly, so the new capture shows its View photos button', async () => {
    const data = { ...BASE, photoView: true as const, levelAllowed: true,
      outlets: [row('o1', 'Due Store', { canCapture: true })] as SalesEligibleResponse['outlets'] };
    getSalesEligible.mockResolvedValueOnce({ success: true, data });
    getSalesEligible.mockResolvedValueOnce({
      success: true,
      data: { ...data, outlets: [row('o1', 'Due Store', { canCapture: true, captureId: 'cNew', status: 'SUBMITTED', currentVersion: 1, windowState: 'awaiting' })] },
    });
    render(<SalesVisibilityPage />);
    await screen.findByText('Due Store');
    expect(screen.queryByTestId('view-photos-o1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Capture$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish capture' }));
    expect(await screen.findByTestId('view-photos-o1')).toBeInTheDocument();
    expect(getSalesEligible).toHaveBeenCalledTimes(2);
  });

  it('VLP3: no photoView flag → no chips and no Photos buttons', async () => {
    getSalesEligible.mockResolvedValue({ success: true, data: BASE });
    render(<SalesVisibilityPage />);
    await screen.findByText('Due Store');
    expect(screen.queryByTestId('photo-chips')).toBeNull();
    expect(screen.queryByTestId('view-photos-o3')).toBeNull();
  });
});
