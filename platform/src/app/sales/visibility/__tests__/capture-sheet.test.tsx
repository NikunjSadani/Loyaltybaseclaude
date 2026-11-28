/// <reference types="vitest/globals" />
/**
 * VCS — VisibilityCaptureSheet (VISIBILITY-POSM-DESIGN.md §5 / D10 / D11).
 *
 * VCS1: a successful submit shows the success read-back + non-blocking flags
 * VCS2: a geo-fence BLOCK surfaces the server error and does NOT reach success
 * VCS3: a REJECTED window routes through resubmitCapture (D11), not submitCapture
 * VCS4: a load ERROR (403 / reject) → distinct "couldn't load — retry" state (H1)
 * VCS5: a genuine null form (success:true, no schema) → "no capture form configured" (H1)
 * VCS6: the error-state Retry button re-invokes the load and recovers (H1)
 * VCS7: a rejected-then-LATE capture still resubmits (status REJECTED + captureId) (M3)
 *
 * The shared `VisibilityCaptureForm` is mocked to a button that forwards the
 * controlled onSubmit contract (it validates/builds formValues + captures GPS for
 * real elsewhere — its own spec covers that); this isolates the sheet's endpoint
 * routing + outcome handling.
 */

import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// requireLocation is DEFAULT ON since 2026-11-21 (LOCATION-GATE.md). These pre-gate cases model a tenant with the
// explicit emergency off (`requireLocation: false`) at the ONE shared seam, so their flows stay byte-identical.
// The default-ON / explicit-true paths are covered by the *location-gate* tests.
vi.mock('@/lib/location-required', () => ({ isLocationRequired: () => false }));
vi.mock('@/lib/use-location-setting', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-location-setting')>()),
  useLocationSetting: () => ({ lastKnown: false, gateEnabled: false, requireForForm: false, captureHold: false, settingsNote: false }),
}));
import type { SalesEligibleOutlet } from '@/lib/visibility-types';

const getSalesForm = vi.fn();
const submitCapture = vi.fn();
const resubmitCapture = vi.fn();
const getFenceDistance = vi.fn();
vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    getFenceDistance: (i: unknown) => getFenceDistance(i),
    getSalesForm: () => getSalesForm(),
    submitCapture: (i: unknown) => submitCapture(i),
    resubmitCapture: (id: string, i: unknown) => resubmitCapture(id, i),
    uploadMedia: vi.fn(),
    getSalesEligible: vi.fn(),
    getOutletStatus: vi.fn(),
  },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
}));

// Mock the shared form: a button that forwards onSubmit and surfaces a thrown error
// inline (mirroring the real renderer's onSubmit contract).
vi.mock('@/components/visibility/VisibilityCaptureForm', () => ({
  VisibilityCaptureForm: ({ onSubmit, measureFenceDistance }: {
    onSubmit: (v: Record<string, unknown>) => Promise<void> | void;
    measureFenceDistance?: (fix: { lat: number; lng: number; accuracy?: number }) => Promise<unknown>;
  }) => {
    const [err, setErr] = useState<string | null>(null);
    const [measured, setMeasured] = useState<string>('');
    return (
      <div>
        <button
          onClick={async () => {
            try { await onSubmit({ photo: 'k1' }); }
            catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
          }}
        >
          mock-submit
        </button>
        <button
          onClick={async () => {
            try {
              const m = await measureFenceDistance?.({ lat: 21.150509, lng: 72.832284, accuracy: 13 });
              setMeasured(JSON.stringify(m));
            } catch {
              setMeasured('error');
            }
          }}
        >
          mock-measure
        </button>
        <p data-testid="measured">{measured}</p>
        {err && <p role="alert">{err}</p>}
      </div>
    );
  },
}));

import { VisibilityCaptureSheet } from '../VisibilityCaptureSheet';

const SCHEMA = {
  success: true,
  data: {
    id: 'f1', clientId: 'c1', version: 1, createdAt: '', updatedAt: '',
    formSchema: { captureGpsOnSubmit: false, fields: [{ id: 'photo', type: 'CAMERA', label: 'Photo', required: true, order: 0 }] },
  },
};

const dueOutlet: SalesEligibleOutlet = {
  outletId: 'o1', outletCode: 'C1', outletName: 'Test Store', zone: null, state: null,
  outletType: null, captureId: null, status: null, currentVersion: null, rejectionReason: null,
  windowState: 'due', canCapture: true,
};

const rejectedOutlet: SalesEligibleOutlet = {
  ...dueOutlet, windowState: 'rejected', captureId: 'cap-9', status: 'REJECTED', rejectionReason: 'Blurry',
};

// A REJECTED capture whose window has since CLOSED surfaces as windowState:'late' but keeps
// status:'REJECTED' + a captureId — it must still resubmit, not collide on a fresh submit (M3).
const rejectedLateOutlet: SalesEligibleOutlet = {
  ...dueOutlet, windowState: 'late', captureId: 'cap-late', status: 'REJECTED', rejectionReason: 'Blurry',
};

beforeEach(() => {
  getSalesForm.mockReset(); submitCapture.mockReset(); resubmitCapture.mockReset();
  getSalesForm.mockResolvedValue(SCHEMA);
});

describe('VCS — VisibilityCaptureSheet', () => {
  it('VCS1: successful submit → success read-back + flags', async () => {
    submitCapture.mockResolvedValue({
      success: true,
      data: { capture: {}, version: 1, geoFenceOk: true, distanceMeters: 12, fenceRadiusMeters: 50, fenceDecisionDistanceMeters: 12, flags: ['LATE'], duplicatePhoto: false },
    });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    expect(await screen.findByText(/capture submitted/i)).toBeInTheDocument();
    expect(submitCapture).toHaveBeenCalledWith({ outletId: 'o1', formValues: { photo: 'k1' } });
    expect(await screen.findByText(/captured late/i)).toBeInTheDocument();
    expect((await screen.findByTestId('visibility-success-distance')).textContent).toBe(
      'Distance from outlet: 12 m — within the allowed radius.',
    );
  });

  it('VCS1b: success read-back from 1 km uses km (one decimal)', async () => {
    submitCapture.mockResolvedValue({
      success: true,
      data: { capture: {}, version: 1, geoFenceOk: true, distanceMeters: 1234.56, fenceRadiusMeters: 5000, fenceDecisionDistanceMeters: 1235, flags: [], duplicatePhoto: false },
    });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    expect((await screen.findByTestId('visibility-success-distance')).textContent).toBe(
      'Distance from outlet: 1.2 km — within the allowed radius.',
    );
  });

  it('VCS1f: success distance only when the fence applied — a distance with no fence radius shows no line', async () => {
    submitCapture.mockResolvedValue({
      success: true,
      data: { capture: {}, version: 1, geoFenceOk: null, distanceMeters: 37, fenceRadiusMeters: null, fenceDecisionDistanceMeters: null, flags: [], duplicatePhoto: false },
    });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    await screen.findByText(/capture submitted/i);
    expect(screen.queryByTestId('visibility-success-distance')).not.toBeInTheDocument();
  });

  it('VCS1g: success at the radius never contradicts — 199.6 m at 200 m reads "200 m", inside', async () => {
    submitCapture.mockResolvedValue({
      success: true,
      data: { capture: {}, version: 1, geoFenceOk: true, distanceMeters: 199.6, fenceRadiusMeters: 200, fenceDecisionDistanceMeters: 200, flags: [], duplicatePhoto: false },
    });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    expect((await screen.findByTestId('visibility-success-distance')).textContent).toBe(
      'Distance from outlet: 200 m — within the allowed radius.',
    );
  });

  it('VCS1h: the GEO_UNVERIFIABLE flag reads neutrally (no "reference geo" jargon)', async () => {
    submitCapture.mockResolvedValue({
      success: true,
      data: { capture: {}, version: 1, geoFenceOk: null, distanceMeters: null, fenceRadiusMeters: null, flags: ['GEO_UNVERIFIABLE'], duplicatePhoto: false },
    });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    expect(await screen.findByText('Location could not be verified — your reviewer will check it.')).toBeInTheDocument();
    expect(screen.queryByText(/reference geo|for one photo/i)).not.toBeInTheDocument();
  });

  it('VCS1i: an ACCEPTED capture shows the fence DECISION distance, never the stored re-pointed one, never "outside"', async () => {
    // Location gate re-pointed the stored distance at a 300 m non-fenced fix; the fence judged Window 1 at 33 m.
    submitCapture.mockResolvedValue({
      success: true,
      data: { capture: {}, version: 1, geoFenceOk: true, distanceMeters: 300.4, fenceRadiusMeters: 200, fenceDecisionDistanceMeters: 33, flags: [], duplicatePhoto: false },
    });
    const { container } = render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    expect((await screen.findByTestId('visibility-success-distance')).textContent).toBe(
      'Distance from outlet: 33 m — within the allowed radius.',
    );
    expect(container.textContent).not.toMatch(/outside|300 m|301 m/);
  });

  it('VCS1j: a decision distance above the radius (should never happen on an accepted capture) shows nothing', async () => {
    submitCapture.mockResolvedValue({
      success: true,
      data: { capture: {}, version: 1, geoFenceOk: null, distanceMeters: 300, fenceRadiusMeters: 200, fenceDecisionDistanceMeters: 300, flags: [], duplicatePhoto: false },
    });
    const { container } = render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    await screen.findByText(/capture submitted/i);
    expect(screen.queryByTestId('visibility-success-distance')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/outside/);
  });

  it('VCS1d: a LOW_ACCURACY flag is never shown to the rep (reviewer-only); other flags still are', async () => {
    submitCapture.mockResolvedValue({
      success: true,
      data: { capture: {}, version: 1, geoFenceOk: null, distanceMeters: null, flags: ['LOW_ACCURACY', 'LATE'], duplicatePhoto: false },
    });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    expect(await screen.findByText(/captured late/i)).toBeInTheDocument();
    expect(screen.queryByText(/accuracy/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/low accuracy/i)).not.toBeInTheDocument();
  });

  it('VCS1e: LOW_ACCURACY alone → no flag box at all', async () => {
    submitCapture.mockResolvedValue({
      success: true,
      data: { capture: {}, version: 1, geoFenceOk: null, distanceMeters: null, flags: ['LOW_ACCURACY'], duplicatePhoto: false },
    });
    const { container } = render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    await screen.findByText(/capture submitted/i);
    expect(container.textContent).not.toMatch(/accura/i);
  });

  it('VCS1c: no server distance (no outlet coordinates) → no distance line', async () => {
    submitCapture.mockResolvedValue({
      success: true,
      data: { capture: {}, version: 1, geoFenceOk: null, distanceMeters: null, flags: [], duplicatePhoto: false },
    });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    await screen.findByText(/capture submitted/i);
    expect(screen.queryByTestId('visibility-success-distance')).not.toBeInTheDocument();
    expect(screen.queryByText(/from the outlet/i)).not.toBeInTheDocument();
  });

  it('VCS2b: the outlet-master far block shows the server distance + radius verbatim', async () => {
    const msg = 'You are 8.3 km from the outlet. You need to be within 200 m. Please go to the outlet and try again.';
    submitCapture.mockResolvedValue({ success: false, error: msg });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(msg);
  });

  it('VCS8: the form’s distance measure asks the SERVER fence for this outlet + fix (no client math)', async () => {
    getFenceDistance.mockResolvedValue({ success: true, data: { distanceMeters: 8341, radiusMeters: 200 } });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-measure'));
    expect(await screen.findByTestId('measured')).toHaveTextContent('{"distanceMeters":8341,"radiusMeters":200}');
    expect(getFenceDistance).toHaveBeenCalledWith({ outletId: 'o1', lat: 21.150509, lng: 72.832284, accuracy: 13 });
    // Fence not applicable → nulls (the form then shows plain "location captured").
    getFenceDistance.mockResolvedValue({ success: true, data: { distanceMeters: null, radiusMeters: null } });
    fireEvent.click(screen.getByText('mock-measure'));
    await waitFor(() => expect(screen.getByTestId('measured')).toHaveTextContent('{"distanceMeters":null,"radiusMeters":null}'));
    // A failed check (429 / offline) REJECTS — the form shows "Couldn't check the distance…", never "no coordinates".
    getFenceDistance.mockResolvedValue({ success: false, error: 'Too many requests' });
    fireEvent.click(screen.getByText('mock-measure'));
    await waitFor(() => expect(screen.getByTestId('measured')).toHaveTextContent('error'));
  });

  it('VCS2: geo-fence BLOCK surfaces the server error, no success', async () => {
    submitCapture.mockResolvedValue({
      success: false,
      error: 'You are 130 m from the outlet. You need to be within 50 m. Please go to the outlet and try again.',
    });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You are 130 m from the outlet. You need to be within 50 m. Please go to the outlet and try again.',
    );
    expect(screen.queryByText(/capture submitted/i)).not.toBeInTheDocument();
  });

  it('VCS3: a REJECTED window routes through resubmitCapture (D11)', async () => {
    resubmitCapture.mockResolvedValue({
      success: true,
      data: { capture: {}, version: 2, geoFenceOk: null, distanceMeters: null, flags: [], duplicatePhoto: false },
    });
    render(<VisibilityCaptureSheet outlet={rejectedOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    await screen.findByText(/capture submitted/i);
    expect(resubmitCapture).toHaveBeenCalledWith('cap-9', { formValues: { photo: 'k1' } });
    expect(submitCapture).not.toHaveBeenCalled();
  });

  it('VCS4: a load ERROR shows the retry state, NOT "not configured" (H1)', async () => {
    getSalesForm.mockResolvedValue({ success: false, error: 'Forbidden' });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByTestId('visibility-form-error')).toBeInTheDocument();
    expect(screen.getByText(/couldn't load the capture form/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
    // NOT the not-configured state, and no form.
    expect(screen.queryByTestId('visibility-form-unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('mock-submit')).not.toBeInTheDocument();
  });

  it('VCS5: a genuine null form → "no capture form configured" (H1)', async () => {
    getSalesForm.mockResolvedValue({
      success: true,
      data: { id: 'f', clientId: 'c', version: 1, createdAt: '', updatedAt: '', formSchema: null },
    });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByTestId('visibility-form-unavailable')).toBeInTheDocument();
    expect(await screen.findByText(/no capture form has been configured yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId('visibility-form-error')).not.toBeInTheDocument();
  });

  it('VCS6: the error-state Retry re-invokes the load and recovers (H1)', async () => {
    getSalesForm.mockResolvedValueOnce({ success: false, error: 'Temporary outage' });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    const retry = await screen.findByRole('button', { name: /retry/i });
    // The next load succeeds → the form renders.
    getSalesForm.mockResolvedValueOnce(SCHEMA);
    fireEvent.click(retry);
    expect(await screen.findByText('mock-submit')).toBeInTheDocument();
    expect(getSalesForm).toHaveBeenCalledTimes(2);
  });

  it('VCS7: a rejected-then-LATE capture still resubmits (M3)', async () => {
    resubmitCapture.mockResolvedValue({
      success: true,
      data: { capture: {}, version: 2, geoFenceOk: null, distanceMeters: null, flags: [], duplicatePhoto: false },
    });
    render(<VisibilityCaptureSheet outlet={rejectedLateOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    await screen.findByText(/capture submitted/i);
    expect(resubmitCapture).toHaveBeenCalledWith('cap-late', { formValues: { photo: 'k1' } });
    expect(submitCapture).not.toHaveBeenCalled();
  });
});
