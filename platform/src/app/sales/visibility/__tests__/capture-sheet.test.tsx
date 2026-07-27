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
import type { SalesEligibleOutlet } from '@/lib/visibility-types';

const getSalesForm = vi.fn();
const submitCapture = vi.fn();
const resubmitCapture = vi.fn();
vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
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
  VisibilityCaptureForm: ({ onSubmit }: { onSubmit: (v: Record<string, unknown>) => Promise<void> | void }) => {
    const [err, setErr] = useState<string | null>(null);
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
      data: { capture: {}, version: 1, geoFenceOk: true, distanceMeters: 12, flags: ['LATE'], duplicatePhoto: false },
    });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    expect(await screen.findByText(/capture submitted/i)).toBeInTheDocument();
    expect(submitCapture).toHaveBeenCalledWith({ outletId: 'o1', formValues: { photo: 'k1' } });
    expect(screen.getByText(/captured late/i)).toBeInTheDocument();
    expect(screen.getByText(/12m from the outlet/i)).toBeInTheDocument();
  });

  it('VCS2: geo-fence BLOCK surfaces the server error, no success', async () => {
    submitCapture.mockResolvedValue({
      success: false,
      error: 'Capture is outside the allowed 50m radius of the outlet.',
    });
    render(<VisibilityCaptureSheet outlet={dueOutlet} onCaptured={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('mock-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/outside the allowed 50m radius/i);
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
    await waitFor(() => expect(screen.getByTestId('visibility-form-error')).toBeInTheDocument());
    expect(screen.getByText(/couldn't load the capture form/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByTestId('visibility-form-unavailable')).toBeInTheDocument());
    expect(screen.getByText(/no capture form has been configured yet/i)).toBeInTheDocument();
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
