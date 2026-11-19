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

  // ── Review layout (owner request 2026-11-19) ─────────────────────────────────
  const PROG = { programName: 'Unnati', programCategory: 'Elite' };
  const TWO_PHOTO_DETAIL = {
    ...DETAIL,
    ...PROG,
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
      expect(img.className).toMatch(/h-\[45vh\]/);
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
    expect(img.className).toMatch(/h-\[50vh\]/);
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
});
