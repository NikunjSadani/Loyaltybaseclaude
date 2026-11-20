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
 * VISQ8–16 (review layout, 2026-11-19): list Program/Sub-Program column; centred modal with
 *   Program/Sub-Program header; two photos side by side / one large + centred; decision area
 *   below the photos; Escape + focus restore; Tab trap; explicit "Next capture".
 * VISQ17–29 (audit fix round): 3-photo layout; per-photo reject keeps the review open +
 *   focus to the next pending photo; decided only when no photo pending; in-place list
 *   refresh + focus restore (row button / heading); "no more" state; Next when the row
 *   drops out; Approve-all / Reject-all payloads; no concurrent decisions; Escape/backdrop
 *   with a typed note; sticky decision bar + height caps; chip contrast.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const listCaptures = vi.fn();
const getCapture = vi.fn();
const approveCapture = vi.fn();
const rejectCapture = vi.fn();
const reviewPhoto = vi.fn();
const getConfig = vi.fn();

vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    listCaptures: (...a: unknown[]) => listCaptures(...a),
    getCapture: (...a: unknown[]) => getCapture(...a),
    approveCapture: (...a: unknown[]) => approveCapture(...a),
    rejectCapture: (...a: unknown[]) => rejectCapture(...a),
    reviewPhoto: (...a: unknown[]) => reviewPhoto(...a),
    getConfig: (...a: unknown[]) => getConfig(...a),
  },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
  rewriteMediaViewPath: (p: string) => p.replace(/^\/v1\//, '/api/'),
}));

import { VisibilityCaptureQueue } from '../VisibilityCaptureQueue';
import { currentWindowKey } from '@/lib/visibility-window';

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
  getConfig.mockReset();
  getConfig.mockResolvedValue({ success: true, data: { frequencyPerMonth: 2 } });
  document.querySelectorAll('[data-operator-banner]').forEach((n) => n.remove());
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
    expect(await screen.findByText(/Outside/)).toBeInTheDocument();
  });

  it('VISQ2: the drawer shows duplicate matches + media grid', async () => {
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    expect(await screen.findByText(/Duplicate photo matches/i)).toBeInTheDocument();
    expect(await screen.findByText(/Same photo also on outlet/i)).toBeInTheDocument();
    expect(await screen.findByText(/Photos \(1\)/i)).toBeInTheDocument();
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

  it('VISQ5: a CHANGES_REQUESTED row renders the plain "Needs re-take" label (and SUBMITTED reads "Waiting for review")', async () => {
    listCaptures.mockResolvedValue({
      success: true,
      data: {
        captures: [{ ...ROW, status: 'CHANGES_REQUESTED' }, { ...ROW, id: 'cap-2', status: 'SUBMITTED' }],
        pagination: { page: 1, limit: 25, total: 2, pages: 1 },
      },
    });
    render(<VisibilityCaptureQueue />);
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Needs re-take')).toBeInTheDocument();
    expect(within(table).getByText('Waiting for review')).toBeInTheDocument();
    // The status filter uses the same words (codes stay as the option values).
    expect(screen.getByRole('option', { name: 'Needs re-take' })).toHaveAttribute('value', 'CHANGES_REQUESTED');
  });

  it('VISQ5b: a re-take / rejection whose window has CLOSED reads "Not approved — window closed" (report + Excel words)', async () => {
    listCaptures.mockResolvedValue({
      success: true,
      data: {
        captures: [
          { ...ROW, status: 'CHANGES_REQUESTED', windowClosed: true },
          { ...ROW, id: 'cap-2', status: 'REJECTED', windowClosed: true },
          { ...ROW, id: 'cap-3', status: 'APPROVED', windowClosed: true },
        ],
        pagination: { page: 1, limit: 25, total: 3, pages: 1 },
      },
    });
    render(<VisibilityCaptureQueue />);
    const table = await screen.findByRole('table');
    expect(await within(table).findAllByText('Not approved — window closed')).toHaveLength(2);
    expect(within(table).getByText('Approved')).toBeInTheDocument();
    expect(within(table).queryByText('Needs re-take')).not.toBeInTheDocument();
  });

  // ── Permanent review history (2026-11-20) ─────────────────────────────────────
  const HISTORY = [
    { id: 'e3', version: 2, action: 'PHOTO_REJECTED', statusAfter: 'CHANGES_REQUESTED', fieldId: 'ph2', fieldLabel: 'Shelf photo', reasonCode: 'BLURRY', reason: 'out of focus', actorUserId: 'g1', actorName: 'Asha Reviewer', backfilled: false, createdAt: '2026-07-20T09:00:00.000Z' },
    { id: 'e2', version: 2, action: 'RESUBMITTED', statusAfter: 'SUBMITTED', fieldId: null, fieldLabel: null, reasonCode: null, reason: null, actorUserId: 'r1', actorName: 'Ravi Rep', backfilled: false, createdAt: '2026-07-19T09:00:00.000Z' },
    { id: 'e1', version: 1, action: 'CAPTURE_REJECTED_ALL', statusAfter: 'REJECTED', fieldId: null, fieldLabel: null, reasonCode: 'WRONG_OUTLET', reason: null, actorUserId: null, actorName: null, backfilled: true, createdAt: '2026-07-18T09:00:00.000Z' },
  ];

  it('VISQ30: the dialog shows the review timeline with names, photo, reason and IST time', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: { ...MULTI_DETAIL, reviewHistory: HISTORY, lastReview: { actorName: 'Asha Reviewer', actorUserId: 'g1', at: '2026-07-20T09:00:00.000Z', action: 'PHOTO_REJECTED' } } } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const list = await screen.findByTestId('capture-review-history');
    const e3 = within(list).getByTestId('history-e3');
    expect(e3).toHaveTextContent('Asha Reviewer');
    expect(e3).toHaveTextContent('Asked for a re-take of a photo');
    expect(e3).toHaveTextContent('Shelf photo');
    expect(e3).toHaveTextContent('Photo is blurry / unclear — out of focus');
    expect(e3).toHaveTextContent('IST');
    expect(within(list).getByTestId('history-e2')).toHaveTextContent('Ravi Rep');
    // Unknown actor is never blank; a backfilled row says it came from earlier records.
    expect(within(list).getByTestId('history-e1')).toHaveTextContent('Unknown user');
    expect(within(list).getByTestId('history-e1')).toHaveTextContent('from earlier records');
    // Newest first.
    expect(within(list).getAllByTestId(/^history-/).map((n) => n.dataset.testid)).toEqual(['history-e3', 'history-e2', 'history-e1']);
  });

  it('VISQ31: header shows "Reviewed by <name> on <date time IST>" and Needs re-take shows per-photo remarks', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: { ...MULTI_DETAIL, reviewHistory: HISTORY, lastReview: { actorName: 'Asha Reviewer', actorUserId: 'g1', at: '2026-07-20T09:00:00.000Z', action: 'PHOTO_REJECTED' } } } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const by = await screen.findByTestId('capture-reviewed-by');
    expect(by.textContent).toMatch(/^Reviewed by Asha Reviewer on .+ IST$/);
    const remarks = screen.getByTestId('capture-retake-remarks');
    expect(remarks).toHaveTextContent('Needs re-take');
    expect(remarks).toHaveTextContent('Shelf photo — Photo is blurry / unclear');
    // The approved photo is not listed as a re-take.
    expect(remarks).not.toHaveTextContent('Front photo');
  });

  it('VISQ33: an IMPORTED old-app capture shows "Imported — old app approval", never the importing admin', async () => {
    const at = '2025-06-20T06:30:00.000Z';
    getCapture.mockResolvedValue({ success: true, data: { capture: {
      ...DETAIL, status: 'APPROVED', imported: true, reviewedAt: at,
      // The API nulls approvedBy for an imported capture; even if an old API sent it, it must not show.
      approvedBy: { id: 'admin1', name: 'Gifsy Admin' },
      reviewHistory: [{ id: 'e1', version: 1, action: 'CAPTURE_APPROVED_ALL', statusAfter: 'APPROVED', fieldId: null, fieldLabel: null, reasonCode: null, reason: null, actorUserId: null, actorName: 'Imported — old app approval', backfilled: true, createdAt: at }],
      lastReview: { actorName: 'Imported — old app approval', actorUserId: null, at, action: 'CAPTURE_APPROVED_ALL' },
    } } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const by = await screen.findByTestId('capture-reviewed-by');
    expect(by.textContent).toMatch(/^Imported — old app approval on .+ IST$/);
    expect(by).not.toHaveTextContent('Reviewed by');
    const e1 = within(screen.getByTestId('capture-review-history')).getByTestId('history-e1');
    expect(e1).toHaveTextContent('Imported — old app approval');
    // A backfilled summary reads as the outcome ("Approved"), marked as from earlier records — not "Approved all photos".
    expect(e1).toHaveTextContent('Approved');
    expect(e1).not.toHaveTextContent('Approved all photos');
    expect(e1).toHaveTextContent('from earlier records');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Gifsy Admin');
  });

  it('VISQ34: when the WHOLE capture was rejected, each photo chip says "Rejected" (not "Needs re-take")', async () => {
    const rej = { status: 'REJECTED', reasonCode: 'WRONG_OUTLET', reviewedAt: 'x', reviewedByUserId: 'g1' };
    getCapture.mockResolvedValue({ success: true, data: { capture: {
      ...MULTI_DETAIL, status: 'REJECTED', rejectionReasonCode: 'WRONG_OUTLET',
      photoReviews: { ph1: rej, ph2: rej },
      media: MULTI_DETAIL.media.map((m) => ({ ...m, review: rej })),
    } } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const chip = await screen.findByTestId('photo-review-ph2');
    expect(chip).toHaveTextContent('Rejected');
    expect(chip).not.toHaveTextContent('Needs re-take');
  });

  it('VISQ32: an unreviewed capture shows no "Reviewed by" line and falls back to submission history without events', async () => {
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    expect(await screen.findByText(/Submission history \(1\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('capture-reviewed-by')).toBeNull();
    expect(screen.queryByTestId('capture-retake-remarks')).toBeNull();
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

  // ── Review layout (owner request 2026-11-19) ─────────────────────────────────
  const PROG = { programName: 'Unnati', programCategory: 'Elite' };
  const TWO_PHOTO_DETAIL = {
    ...DETAIL,
    ...PROG,
    duplicateMatches: [],
    media: [
      { fieldId: 'w1', label: 'Window 1', type: 'CAMERA', key: 'k1', viewPath: '/v1/visibility/captures/media?key=k1', geo: { lat: 12.9, lng: 77.5, accuracy: 10 }, fenceStatus: 'inside' },
      { fieldId: 'w2', label: 'Window 2', type: 'CAMERA', key: 'k2', viewPath: '/v1/visibility/captures/media?key=k2', geo: { lat: 12.95, lng: 77.5, accuracy: 10 }, fenceStatus: 'outside' },
    ],
  };

  it('VISQ8: the list shows Program / Sub-Program per row', async () => {
    listCaptures.mockResolvedValue({ success: true, data: { captures: [{ ...ROW, ...PROG }], pagination: { page: 1, limit: 25, total: 1, pages: 1 } } });
    render(<VisibilityCaptureQueue />);
    expect(await screen.findByRole('columnheader', { name: 'Program' })).toBeInTheDocument();
    const cell = await screen.findByTestId('row-program-cap-1');
    expect(within(cell).getByText('Unnati')).toBeInTheDocument();
    expect(within(cell).getByText('Elite')).toBeInTheDocument();
  });

  it('VISQ9: review opens a centred modal dialog with Program + Sub-Program in the header', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: { ...DETAIL, ...PROG } } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Capture review' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Centred overlay (not a right-hand side panel) + ~90% viewport on desktop.
    expect(dialog.parentElement!.className).toMatch(/items-center/);
    expect(dialog.parentElement!.className).toMatch(/justify-center/);
    expect(dialog.className).toMatch(/sm:w-\[90vw\]/);
    expect(dialog.className).toMatch(/sm:h-\[90vh\]/);
    expect(dialog.className).not.toMatch(/max-w-lg/);
    const header = await within(dialog).findByTestId('capture-review-header');
    const prog = within(header).getByTestId('capture-review-program');
    expect(within(prog).getByText('Program')).toBeInTheDocument();
    expect(within(prog).getByText('Unnati')).toBeInTheDocument();
    expect(within(prog).getByText('Sub-Program')).toBeInTheDocument();
    expect(within(prog).getByText('Elite')).toBeInTheDocument();
    // Outlet + code + window + rep in the header too.
    expect(within(header).getByText('Sharma Store')).toBeInTheDocument();
    expect(within(header).getByText('OUT-1')).toBeInTheDocument();
    expect(within(header).getByText('2026-07-P2')).toBeInTheDocument();
    expect(within(header).getByText('XSR-9')).toBeInTheDocument();
  });

  it('VISQ10: missing programme fields render as a dash (no crash)', async () => {
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const prog = await screen.findByTestId('capture-review-program');
    expect(within(prog).getAllByText('—')).toHaveLength(2);
  });

  it('VISQ11: two photos render side by side, each large with its label + per-photo fence badge', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: TWO_PHOTO_DETAIL } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const grid = await screen.findByTestId('capture-review-photos');
    expect(grid.className).toMatch(/md:grid-cols-2/); // side by side on desktop
    expect(grid.className).toMatch(/grid-cols-1/);    // stacked on narrow screens
    const c1 = within(grid).getByTestId('photo-card-w1');
    const c2 = within(grid).getByTestId('photo-card-w2');
    expect(within(c1).getByText('Window 1')).toBeInTheDocument();
    expect(within(c2).getByText('Window 2')).toBeInTheDocument();
    expect(within(within(c1).getByTestId('photo-fence-w1')).getByText('In fence')).toBeInTheDocument();
    expect(within(within(c2).getByTestId('photo-fence-w2')).getByText('Outside')).toBeInTheDocument();
    for (const id of ['w1', 'w2']) {
      const img = screen.getByTestId(`photo-img-${id}`);
      expect(img.className).toMatch(/object-contain/);
      // Capped so header + photos + per-photo controls + decision bar fit the 90vh dialog.
      expect(img.className).toMatch(/sm:h-\[calc\(90vh-23rem\)\]/);
      expect(img).toHaveAttribute('alt', expect.stringContaining(id === 'w1' ? 'Window 1' : 'Window 2'));
      // Click still opens the full-size photo (auth-gated /api path) in a new tab.
      const link = img.closest('a')!;
      expect(link).toHaveAttribute('href', `/api/visibility/captures/media?key=k${id.slice(1)}`);
      expect(link).toHaveAttribute('target', '_blank');
    }
    // Label + badge sit UNDER the image.
    expect(screen.getByTestId('photo-img-w1').compareDocumentPosition(within(c1).getByText('Window 1')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('VISQ12: a single photo renders large and centred', async () => {
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const wrap = await screen.findByTestId('capture-review-photos');
    expect(wrap.className).toMatch(/justify-center/);
    const card = within(wrap).getByTestId('photo-card-ph');
    expect(card.className).toMatch(/mx-auto/);
    const img = within(card).getByTestId('photo-img-ph');
    // The fixture has duplicate matches above the photos → the "tight" cap.
    expect(img.className).toMatch(/sm:h-\[calc\(90vh-24rem\)\]/);
    expect(img.className).toMatch(/object-contain/);
    expect(img).toHaveAttribute('alt', 'Cooler photo — Sharma Store');
  });

  it('VISQ13: the decision controls sit BELOW the photos and still call the same endpoints', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: TWO_PHOTO_DETAIL } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const photos = await screen.findByTestId('capture-review-photos');
    const decision = screen.getByTestId('capture-review-decision');
    expect(photos.compareDocumentPosition(decision) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Per-photo controls (multi-photo) remain, under each photo.
    expect(within(screen.getByTestId('photo-card-w2')).getByRole('button', { name: /^Reject$/i })).toBeInTheDocument();
    fireEvent.click(within(decision).getByRole('button', { name: /Approve all/i }));
    await waitFor(() => expect(approveCapture).toHaveBeenCalledWith('cap-1'));
    fireEvent.click(within(decision).getByRole('button', { name: /Reject all/i }));
    fireEvent.click(within(decision).getByRole('button', { name: /Reject capture/i }));
    await waitFor(() => expect(rejectCapture).toHaveBeenCalledWith('cap-1', expect.objectContaining({ reasonCode: 'BLURRY' })));
  });

  it('VISQ14: Escape closes the dialog and focus returns to the Review button', async () => {
    render(<VisibilityCaptureQueue />);
    const reviewBtn = await screen.findByRole('button', { name: /review/i });
    reviewBtn.focus();
    fireEvent.click(reviewBtn);
    const dialog = await screen.findByRole('dialog');
    await screen.findByTestId('capture-review-header');
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(reviewBtn);
  });

  it('VISQ15: Tab is trapped inside the dialog (wraps last → first)', async () => {
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const dialog = await screen.findByRole('dialog');
    await screen.findByTestId('capture-review-header');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter((n) => n.getAttribute('aria-hidden') !== 'true');
    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(close).toBeInTheDocument();
  });

  it('VISQ16: after a decision, an explicit "Next capture" button opens the next submitted capture', async () => {
    const ROW2 = { ...ROW, id: 'cap-2', outletCode: 'OUT-2', outletName: 'Gupta Mart' };
    listCaptures.mockResolvedValue({ success: true, data: { captures: [ROW, ROW2], pagination: { page: 1, limit: 25, total: 2, pages: 1 } } });
    getCapture.mockImplementation((id: string) => Promise.resolve({
      success: true,
      data: { capture: id === 'cap-2' ? { ...DETAIL, ...ROW2 } : DETAIL },
    }));
    render(<VisibilityCaptureQueue />);
    fireEvent.click((await screen.findAllByRole('button', { name: /review/i }))[0]);
    await screen.findByTestId('capture-review-header');
    // Not automatic — no Next button before a decision.
    expect(screen.queryByRole('button', { name: /Next capture/i })).not.toBeInTheDocument();
    getCapture.mockImplementation((id: string) => Promise.resolve({
      success: true,
      data: { capture: id === 'cap-2' ? { ...DETAIL, ...ROW2 } : { ...DETAIL, status: 'APPROVED' } },
    }));
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/i }));
    const next = await screen.findByRole('button', { name: /Next capture/i });
    expect(getCapture).not.toHaveBeenCalledWith('cap-2');
    fireEvent.click(next);
    await waitFor(() => expect(getCapture).toHaveBeenCalledWith('cap-2'));
    const header = await screen.findByTestId('capture-review-header');
    await waitFor(() => expect(within(header).getByText('Gupta Mart')).toBeInTheDocument());
  });

  // ── Audit fix round (2026-11-19) ─────────────────────────────────────────────
  const photo = (id: string, label: string, review: unknown = null) => ({
    fieldId: id, label, type: 'CAMERA', key: `k-${id}`, viewPath: `/v1/visibility/captures/media?key=k-${id}`, fenceStatus: 'inside', review,
  });
  const THREE_PHOTO_DETAIL = {
    ...DETAIL, ...PROG, duplicateMatches: [],
    media: [photo('p1', 'Window 1'), photo('p2', 'Window 2'), photo('p3', 'Counter')],
  };
  const ROW2 = { ...ROW, id: 'cap-2', outletCode: 'OUT-2', outletName: 'Gupta Mart' };
  const list = (captures: unknown[]) => ({ success: true, data: { captures, pagination: { page: 1, limit: 25, total: captures.length, pages: 1 } } });

  it('VISQ17: three photos lay out in three columns on desktop (stacked on narrow)', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: THREE_PHOTO_DETAIL } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const grid = await screen.findByTestId('capture-review-photos');
    expect(grid.className).toMatch(/md:grid-cols-3/);
    expect(grid.className).toMatch(/grid-cols-1/);
    for (const id of ['p1', 'p2', 'p3']) expect(within(grid).getByTestId(`photo-card-${id}`)).toBeInTheDocument();
  });

  it('VISQ18: rejecting photo 1 of 3 keeps the review open and moves focus to photo 2\'s controls', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: THREE_PHOTO_DETAIL } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const card1 = await screen.findByTestId('photo-card-p1');
    // After the call the server derives CHANGES_REQUESTED (photo 1 rejected, 2 + 3 pending).
    getCapture.mockResolvedValue({ success: true, data: { capture: {
      ...THREE_PHOTO_DETAIL, status: 'CHANGES_REQUESTED',
      media: [photo('p1', 'Window 1', { status: 'REJECTED', reasonCode: 'BLURRY' }), photo('p2', 'Window 2'), photo('p3', 'Counter')],
    } } });
    fireEvent.click(within(card1).getByRole('button', { name: /^Reject$/i }));
    fireEvent.click(within(card1).getByRole('button', { name: /Reject photo/i }));
    await waitFor(() => expect(reviewPhoto).toHaveBeenCalledWith('cap-1', expect.objectContaining({ fieldId: 'p1', decision: 'REJECTED' })));
    await waitFor(() => expect(within(screen.getByTestId('photo-card-p1')).getByText(/Needs re-take/)).toBeInTheDocument());
    // Still reviewing: no "Decision saved / Next capture"; focus is on photo 2's first control.
    expect(screen.queryByTestId('capture-review-next')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const card2 = screen.getByTestId('photo-card-p2');
    await waitFor(() => expect(within(card2).getByRole('button', { name: /^Approve$/i })).toHaveFocus());
  });

  it('VISQ19: once the LAST pending photo is decided, the review counts as decided', async () => {
    const twoDone = {
      ...THREE_PHOTO_DETAIL, status: 'CHANGES_REQUESTED',
      media: [photo('p1', 'Window 1', { status: 'REJECTED' }), photo('p2', 'Window 2', { status: 'APPROVED' }), photo('p3', 'Counter')],
    };
    getCapture.mockResolvedValue({ success: true, data: { capture: twoDone } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const card3 = await screen.findByTestId('photo-card-p3');
    getCapture.mockResolvedValue({ success: true, data: { capture: {
      ...twoDone, media: [twoDone.media[0], twoDone.media[1], photo('p3', 'Counter', { status: 'APPROVED' })],
    } } });
    fireEvent.click(within(card3).getByRole('button', { name: /^Approve$/i }));
    expect(await screen.findByTestId('capture-review-next')).toBeInTheDocument();
  });

  it('VISQ20: a decision refreshes the list in place (rows stay mounted) and Escape returns focus to that row\'s Review button', async () => {
    render(<VisibilityCaptureQueue />);
    const reviewBtn = await screen.findByRole('button', { name: /review/i });
    reviewBtn.focus();
    fireEvent.click(reviewBtn);
    await screen.findByTestId('capture-review-header');
    getCapture.mockResolvedValue({ success: true, data: { capture: { ...DETAIL, status: 'APPROVED' } } });
    listCaptures.mockResolvedValue(list([{ ...ROW, status: 'APPROVED' }])); // row stays (e.g. "All" filter)
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/i }));
    await screen.findByTestId('capture-review-next');
    await waitFor(() => expect(listCaptures).toHaveBeenCalledTimes(2));
    expect(reviewBtn.isConnected).toBe(true); // never swapped for the full-list spinner
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(reviewBtn);
  });

  it('VISQ21: when the decided row drops out of the list, Escape returns focus to the list heading', async () => {
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    await screen.findByTestId('capture-review-header');
    getCapture.mockResolvedValue({ success: true, data: { capture: { ...DETAIL, status: 'APPROVED' } } });
    listCaptures.mockResolvedValue(list([])); // Submitted filter → the approved row is gone
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/i }));
    await screen.findByTestId('capture-review-next');
    await waitFor(() => expect(screen.queryByRole('button', { name: /review/i })).not.toBeInTheDocument());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /^Captures/ }));
  });

  it('VISQ22: "No more submitted captures on this page" when nothing is left to review', async () => {
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    await screen.findByTestId('capture-review-header');
    getCapture.mockResolvedValue({ success: true, data: { capture: { ...DETAIL, status: 'APPROVED' } } });
    listCaptures.mockResolvedValue(list([]));
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/i }));
    const box = await screen.findByTestId('capture-review-next');
    await waitFor(() => expect(within(box).getByText(/No more submitted captures on this page/i)).toBeInTheDocument());
    expect(within(box).queryByRole('button', { name: /Next capture/i })).not.toBeInTheDocument();
  });

  it('VISQ23: "Next capture" still works when the decided row drops out of the Submitted list', async () => {
    listCaptures.mockResolvedValue(list([ROW, ROW2]));
    getCapture.mockImplementation((id: string) => Promise.resolve({ success: true, data: { capture: id === 'cap-2' ? { ...DETAIL, ...ROW2 } : DETAIL } }));
    render(<VisibilityCaptureQueue />);
    fireEvent.click((await screen.findAllByRole('button', { name: /review/i }))[0]);
    await screen.findByTestId('capture-review-header');
    getCapture.mockImplementation((id: string) => Promise.resolve({ success: true, data: { capture: id === 'cap-2' ? { ...DETAIL, ...ROW2 } : { ...DETAIL, status: 'APPROVED' } } }));
    listCaptures.mockResolvedValue(list([ROW2])); // cap-1 is no longer in the list (idx < 0)
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/i }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /review/i })).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: /Next capture/i }));
    await waitFor(() => expect(getCapture).toHaveBeenCalledWith('cap-2'));
    await waitFor(() => expect(within(screen.getByTestId('capture-review-header')).getByText('Gupta Mart')).toBeInTheDocument());
  });

  it('VISQ24: "Approve all" / "Reject all" on a multi-photo capture send the whole-capture payloads', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: TWO_PHOTO_DETAIL } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const decision = await screen.findByTestId('capture-review-decision');
    fireEvent.click(within(decision).getByRole('button', { name: /Approve all/i }));
    await waitFor(() => expect(approveCapture).toHaveBeenCalledWith('cap-1'));
    expect(approveCapture).toHaveBeenCalledTimes(1);
    fireEvent.click(within(decision).getByRole('button', { name: /Reject all/i }));
    fireEvent.change(within(decision).getByLabelText('Rejection reason code'), { target: { value: 'WRONG_OUTLET' } });
    fireEvent.change(within(decision).getByLabelText('Rejection detail (optional)'), { target: { value: '  not this shop  ' } });
    fireEvent.click(within(decision).getByRole('button', { name: /Reject capture/i }));
    await waitFor(() => expect(rejectCapture).toHaveBeenCalledWith('cap-1', { reasonCode: 'WRONG_OUTLET', reason: 'not this shop' }));
    expect(reviewPhoto).not.toHaveBeenCalled();
  });

  it('VISQ25: whole-capture and per-photo decisions cannot run at the same time', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: TWO_PHOTO_DETAIL } });
    let release!: (v: unknown) => void;
    reviewPhoto.mockReturnValue(new Promise((r) => { release = r; }));
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const decision = await screen.findByTestId('capture-review-decision');
    fireEvent.click(within(screen.getByTestId('photo-card-w1')).getByRole('button', { name: /^Approve$/i }));
    await waitFor(() => expect(within(decision).getByRole('button', { name: /Approve all/i })).toBeDisabled());
    expect(within(decision).getByRole('button', { name: /Reject all/i })).toBeDisabled();
    release({ success: true, data: { capture: TWO_PHOTO_DETAIL } });
    await waitFor(() => expect(within(decision).getByRole('button', { name: /Approve all/i })).not.toBeDisabled());

    // And the reverse: a whole-capture call in flight locks every per-photo control.
    approveCapture.mockReturnValue(new Promise(() => {}));
    fireEvent.click(within(decision).getByRole('button', { name: /Approve all/i }));
    await waitFor(() => {
      for (const id of ['w1', 'w2']) {
        for (const b of within(screen.getByTestId(`photo-card-${id}`)).getAllByRole('button')) expect(b).toBeDisabled();
      }
    });
  });

  it('VISQ26: Escape inside a typed reject note closes only the form; the backdrop asks before discarding', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    await screen.findByTestId('capture-review-header');
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/i }));
    const note = screen.getByLabelText('Rejection detail (optional)');
    fireEvent.change(note, { target: { value: 'board missing' } });
    fireEvent.keyDown(note, { key: 'Escape' });
    // The dialog stays; only the reject form closed; focus back on "Reject".
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reject capture/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Reject$/i })).toHaveFocus();
    expect(confirmSpy).not.toHaveBeenCalled();

    // Re-open: the note was kept. Backdrop click with a typed note asks first.
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/i }));
    expect(screen.getByLabelText('Rejection detail (optional)')).toHaveValue('board missing');
    confirmSpy.mockReturnValueOnce(false);
    fireEvent.click(screen.getByTestId('capture-review-backdrop'));
    expect(confirmSpy).toHaveBeenCalledWith('Discard the rejection note?');
    expect(screen.getByRole('dialog')).toBeInTheDocument(); // declined → stays open
    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(screen.getByTestId('capture-review-backdrop'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    confirmSpy.mockRestore();
  });

  it('VISQ27: the decision bar is a real footer — outside the scroll area, after it, with the details above it', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: TWO_PHOTO_DETAIL } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const decision = await screen.findByTestId('capture-review-decision');
    const scroll = screen.getByTestId('capture-review-scroll');
    expect(decision.tagName).toBe('FOOTER');
    expect(decision.className).toMatch(/shrink-0/);
    expect(scroll.contains(decision)).toBe(false);
    expect(scroll.className).toMatch(/flex-1/);
    expect(scroll.className).toMatch(/overflow-y-auto/);
    // The footer is the dialog's last child (pinned to the bottom of the flex column).
    expect(screen.getByRole('dialog').lastElementChild).toBe(decision);
    // Geo-fence / Captured values / History live INSIDE the scroll area, above the footer.
    for (const t of ['Geo-fence', 'Captured values', /Submission history/]) {
      const el = within(scroll).getByText(t);
      expect(el.compareDocumentPosition(decision) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('VISQ28: with duplicate matches shown, two-photo heights use the tighter cap', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: { ...TWO_PHOTO_DETAIL, duplicateMatches: DETAIL.duplicateMatches } } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    expect((await screen.findByTestId('photo-img-w1')).className).toMatch(/sm:h-\[calc\(90vh-28rem\)\]/);
  });

  // ── Staging polish (2026-11-19) ─────────────────────────────────────────────
  it('VISQ30: the dialog starts BELOW the Gifsy operator banner (header + X never covered)', async () => {
    const banner = document.createElement('div');
    banner.setAttribute('data-operator-banner', '');
    banner.getBoundingClientRect = () => ({ top: 0, bottom: 64, left: 0, right: 390, width: 390, height: 64, x: 0, y: 0, toJSON: () => ({}) });
    document.body.prepend(banner);
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    await screen.findByTestId('capture-review-header');
    expect(screen.getByTestId('capture-review-overlay').style.top).toBe('64px');
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' })).toBeVisible();
    banner.remove();
  });

  it('VISQ31: without an operator banner the overlay starts at the top', async () => {
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    await screen.findByTestId('capture-review-header');
    expect(screen.getByTestId('capture-review-overlay').style.top).toBe('0px');
  });

  it('VISQ32: footer actions — Approve is the right-aligned primary with Reject beside it (not half-width)', async () => {
    for (const cap of [DETAIL, TWO_PHOTO_DETAIL]) {
      getCapture.mockResolvedValue({ success: true, data: { capture: cap } });
      const { unmount } = render(<VisibilityCaptureQueue />);
      fireEvent.click(await screen.findByRole('button', { name: /review/i }));
      const actions = await screen.findByTestId('capture-review-actions');
      expect(actions.className).toMatch(/sm:justify-end/);
      expect(actions.className).toMatch(/flex-col-reverse/); // phone: Approve on top
      const [first, second] = Array.from(actions.querySelectorAll('button'));
      expect(first.textContent).toMatch(cap === DETAIL ? /Reject$/ : /Reject all/);
      expect(second.textContent).toMatch(cap === DETAIL ? /Approve$/ : /Approve all/); // rightmost on sm+
      for (const btn of [first, second]) expect(btn.className).not.toMatch(/flex-1/);
      unmount();
    }
  });

  it('VISQ33: contrast — geo-fence gloss, "this photo" and "±m" labels are gray-600', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: TWO_PHOTO_DETAIL } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    expect((await screen.findByTestId('geo-fence-gloss')).className).toMatch(/text-gray-600/);
    expect(within(screen.getByTestId('photo-fence-w1')).getByText('this photo').className).toMatch(/text-gray-600/);
    expect(within(screen.getByTestId('capture-review-header')).getByText(/±12 m/).className).toMatch(/text-gray-600/);
    expect(screen.getByText(/±12 m accuracy/).className).toMatch(/text-gray-600/);
  });

  it("VISQ34: the Window filter placeholder is TODAY's window for the tenant frequency (not hardcoded)", async () => {
    render(<VisibilityCaptureQueue />);
    const input = screen.getByLabelText('Window');
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    await waitFor(() => expect(input).toHaveAttribute('placeholder', currentWindowKey(new Date(), 2)));
    expect(input.getAttribute('placeholder')).toMatch(/^\d{4}-\d{2}-P[1-4]$/);
  });

  it('VISQ35: the Window placeholder falls back to frequency 1 when the config cannot load', async () => {
    getConfig.mockResolvedValue({ success: false, error: 'nope' });
    render(<VisibilityCaptureQueue />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    expect(screen.getByLabelText('Window')).toHaveAttribute('placeholder', currentWindowKey(new Date(), 1));
  });

  it('VISQ36: the geo-tag dot is green in fence, red outside, grey unverifiable', async () => {
    const cases: Array<[boolean | null, RegExp]> = [[true, /bg-green-500/], [false, /bg-red-500/], [null, /bg-gray-400/]];
    for (const [ok, cls] of cases) {
      getCapture.mockResolvedValue({ success: true, data: { capture: { ...DETAIL, geoFence: { ...DETAIL.geoFence, geoFenceOk: ok } } } });
      const { unmount } = render(<VisibilityCaptureQueue />);
      fireEvent.click(await screen.findByRole('button', { name: /review/i }));
      expect((await screen.findByTestId('geo-pin-dot-gps')).className).toMatch(cls);
      unmount();
    }
  });

  it('VISQ29: Program / Sub-Program chip labels use the -700 shades (contrast)', async () => {
    getCapture.mockResolvedValue({ success: true, data: { capture: { ...DETAIL, ...PROG } } });
    render(<VisibilityCaptureQueue />);
    fireEvent.click(await screen.findByRole('button', { name: /review/i }));
    const prog = await screen.findByTestId('capture-review-program');
    expect(within(prog).getByText('Program').className).toMatch(/text-indigo-700/);
    expect(within(prog).getByText('Sub-Program').className).toMatch(/text-violet-700/);
  });
});
