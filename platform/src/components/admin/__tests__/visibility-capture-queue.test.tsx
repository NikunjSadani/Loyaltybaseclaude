/// <reference types="vitest/globals" />
/**
 * VISQ — VisibilityCaptureQueue (the real approve/reject queue)
 *
 * VISQ1: renders a capture row + its geo-fence badge ("Outside" for geoFenceOk=false).
 * VISQ2: opening a capture shows duplicate-photo matches + the media grid.
 * VISQ3: Approve calls visibilityApi.approveCapture.
 * VISQ4: Reject-with-reason calls rejectCapture with the controlled reason code.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const listCaptures = vi.fn();
const getCapture = vi.fn();
const approveCapture = vi.fn();
const rejectCapture = vi.fn();

vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    listCaptures: (...a: unknown[]) => listCaptures(...a),
    getCapture: (...a: unknown[]) => getCapture(...a),
    approveCapture: (...a: unknown[]) => approveCapture(...a),
    rejectCapture: (...a: unknown[]) => rejectCapture(...a),
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

beforeEach(() => {
  listCaptures.mockReset();
  getCapture.mockReset();
  approveCapture.mockReset();
  rejectCapture.mockReset();
  listCaptures.mockResolvedValue({ success: true, data: { captures: [ROW], pagination: { page: 1, limit: 25, total: 1, pages: 1 } } });
  getCapture.mockResolvedValue({ success: true, data: { capture: DETAIL } });
  approveCapture.mockResolvedValue({ success: true, data: { capture: { ...ROW, status: 'APPROVED' } } });
  rejectCapture.mockResolvedValue({ success: true, data: { capture: { ...ROW, status: 'REJECTED' } } });
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
});
