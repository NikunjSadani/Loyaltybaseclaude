/// <reference types="vitest/globals" />
/**
 * VISQ — VisibilityCaptureQueue (the real approve/reject queue)
 *
 * VISQ1: renders a capture row + its geo-fence badge ("Outside" for geoFenceOk=false).
 * VISQ2: opening a capture shows duplicate-photo matches + the media grid.
 * VISQ3: Approve calls visibilityApi.approveCapture.
 * VISQ4: Reject-with-reason calls rejectCapture with the controlled reason code.
 * VISQ5: a CHANGES_REQUESTED row renders the "Changes requested" label.
 * VISQ6: a multi-photo capture renders per-photo Approve/Reject → calls reviewPhoto.
 * VISQ7: the whole-capture Approve is disabled while any photo is rejected.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const listCaptures = vi.fn();
const getCapture = vi.fn();
const approveCapture = vi.fn();
const rejectCapture = vi.fn();
const reviewPhoto = vi.fn();

vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    listCaptures: (...a: unknown[]) => listCaptures(...a),
    getCapture: (...a: unknown[]) => getCapture(...a),
    approveCapture: (...a: unknown[]) => approveCapture(...a),
    rejectCapture: (...a: unknown[]) => rejectCapture(...a),
    reviewPhoto: (...a: unknown[]) => reviewPhoto(...a),
  },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
  rewriteMediaViewPath: (p: string) => p.replace(/^\/v1\//, '/api/'),
}));

import { VisibilityCaptureQueue } from '../VisibilityCaptureQueue';

const ROW = {
  id: 'cap-1',
  outletId: 'o1',
  outletCode: 'OUT-1',
  outletName: 'Sharma Store',
  windowKey: '2026-07-P2',
  status: 'SUBMITTED' as const,
  currentVersion: 1,
  geoFenceOk: false,
  distanceMeters: 1200,
  captureAccuracy: 12,
  capturedAt: null,
  receivedAt: '2026-07-20T08:00:00.000Z',
  rejectionReasonCode: null,
  submittedBy: { id: 'u1', employeeCode: 'XSR-9' },
};

const DETAIL = {
  ...ROW,
  clientId: 'c1',
  formVersion: 1,
  formValues: { notes: 'cooler branded' },
  captureLat: 19.1, captureLng: 72.8, captureAccuracy: 12,
  media: [{ fieldId: 'ph', label: 'Cooler photo', type: 'CAMERA', key: 'visibility-media/c1/x.jpg', viewPath: '/v1/visibility/captures/media?key=visibility-media/c1/x.jpg' }],
  geo: [{ fieldId: 'gps', label: 'Location', value: { lat: 19.1, lng: 72.8, accuracy: 12 } }],
  geoFence: { geoFenceOk: false, distanceMeters: 1200, captureLat: 19.1, captureLng: 72.8, captureAccuracy: 12 },
  duplicateMatches: [{ hash: 'h1', captureId: 'cap-9', outletCode: 'OUT-2', windowKey: '2026-07-P1' }],
  submissions: [{ id: 's1', clientId: 'c1', captureId: 'cap-1', outletId: 'o1', windowKey: '2026-07-P2', version: 1, status: 'SUBMITTED', formValues: {}, formVersion: 1, captureLat: 19.1, captureLng: 72.8, captureAccuracy: 12, distanceMeters: 1200, geoFenceOk: false, createdAt: '2026-07-20T08:00:00.000Z' }],
  submittedBy: { id: 'u1', employeeCode: 'XSR-9' },
  approvedBy: null,
};

// A multi-photo capture in CHANGES_REQUESTED: one photo approved, one rejected.
const MULTI_DETAIL = {
  ...DETAIL,
  status: 'CHANGES_REQUESTED' as const,
  photoReviews: {
    ph1: { status: 'APPROVED', reviewedAt: '2026-07-20T09:00:00.000Z', reviewedByUserId: 'g1' },
    ph2: { status: 'REJECTED', reasonCode: 'BLURRY', reviewedAt: '2026-07-20T09:00:00.000Z', reviewedByUserId: 'g1' },
  },
  media: [
    { fieldId: 'ph1', label: 'Front photo', type: 'CAMERA', key: 'visibility-media/c1/a.jpg', viewPath: '/v1/visibility/captures/media?key=a', review: { status: 'APPROVED', reviewedAt: 'x', reviewedByUserId: 'g1' } },
    { fieldId: 'ph2', label: 'Shelf photo', type: 'CAMERA', key: 'visibility-media/c1/b.jpg', viewPath: '/v1/visibility/captures/media?key=b', review: { status: 'REJECTED', reasonCode: 'BLURRY', reviewedAt: 'x', reviewedByUserId: 'g1' } },
  ],
};

beforeEach(() => {
  listCaptures.mockReset();
  getCapture.mockReset();
  approveCapture.mockReset();
  rejectCapture.mockReset();
  reviewPhoto.mockReset();
  listCaptures.mockResolvedValue({ success: true, data: { captures: [ROW], pagination: { page: 1, limit: 25, total: 1, pages: 1 } } });
  getCapture.mockResolvedValue({ success: true, data: { capture: DETAIL } });
  approveCapture.mockResolvedValue({ success: true, data: { capture: { ...ROW, status: 'APPROVED' } } });
  rejectCapture.mockResolvedValue({ success: true, data: { capture: { ...ROW, status: 'REJECTED' } } });
  reviewPhoto.mockResolvedValue({ success: true, data: { capture: { ...ROW, status: 'CHANGES_REQUESTED' } } });
});

describe('VISQ — VisibilityCaptureQueue', () => {
  it('VISQ1: renders a row + the Outside geo-fence badge', async () => {
    render(<VisibilityCaptureQueue />);
    expect(await screen.findByText('Sharma Store')).toBeInTheDocument();
    expect(screen.getByText(/Outside/)).toBeInTheDocument();
  });

  it('VISQ2: the drawer shows duplicate matches + media grid', async () => {
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    expect(await screen.findByText(/Duplicate photo matches/i)).toBeInTheDocument();
    expect(screen.getByText(/Same photo also on outlet/i)).toBeInTheDocument();
    expect(screen.getByText(/Photos \(1\)/i)).toBeInTheDocument();
  });

  it('VISQ3: Approve calls approveCapture', async () => {
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Approve$/i }));
    await waitFor(() => expect(approveCapture).toHaveBeenCalledWith('cap-1'));
  });

  it('VISQ4: Reject-with-reason calls rejectCapture with the controlled code', async () => {
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^Reject$/i }));
    // Pick a controlled reason code, then confirm.
    fireEvent.change(screen.getByLabelText('Rejection reason code'), { target: { value: 'GEO_MISMATCH' } });
    fireEvent.click(screen.getByRole('button', { name: /Reject capture/i }));
    await waitFor(() => expect(rejectCapture).toHaveBeenCalledWith('cap-1', expect.objectContaining({ reasonCode: 'GEO_MISMATCH' })));
  });

  it('VISQ5: a CHANGES_REQUESTED row renders the "Changes requested" label', async () => {
    listCaptures.mockResolvedValue({
      success: true,
      data: {
        captures: [{ ...ROW, status: 'CHANGES_REQUESTED' }],
        pagination: { page: 1, limit: 25, total: 1, pages: 1 },
      },
    });
    render(<VisibilityCaptureQueue />);
    expect(await screen.findByText('Changes requested')).toBeInTheDocument();
  });

  it('VISQ6: per-photo Approve/Reject calls reviewPhoto with the field id + decision', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: MULTI_DETAIL } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));

    // The rejected photo card (ph2) exposes an "Approve" control (to flip its decision).
    const rejectedCard = await screen.findByTestId('photo-card-ph2');
    fireEvent.click(within(rejectedCard).getByRole('button', { name: /^Approve$/i }));
    await waitFor(() =>
      expect(reviewPhoto).toHaveBeenCalledWith('cap-1', expect.objectContaining({ fieldId: 'ph2', decision: 'APPROVED' })),
    );

    // The approved photo card (ph1) exposes a Reject control → reason picker → confirm.
    const approvedCard = await screen.findByTestId('photo-card-ph1');
    fireEvent.click(within(approvedCard).getByRole('button', { name: /^Reject$/i }));
    fireEvent.change(within(approvedCard).getByLabelText(/Reject reason for ph1/i), { target: { value: 'POSM_NOT_VISIBLE' } });
    fireEvent.click(within(approvedCard).getByRole('button', { name: /Reject photo/i }));
    await waitFor(() =>
      expect(reviewPhoto).toHaveBeenCalledWith('cap-1', expect.objectContaining({ fieldId: 'ph1', decision: 'REJECTED', reasonCode: 'POSM_NOT_VISIBLE' })),
    );
  });

  it('VISQ7: whole-capture Approve is disabled while any photo is rejected', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: MULTI_DETAIL } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    // Multi-photo → the whole-capture button is labelled "Approve all" and is disabled.
    const approveAll = await screen.findByRole('button', { name: /Approve all/i });
    expect(approveAll).toBeDisabled();
  });
});
