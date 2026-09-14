/// <reference types="vitest/globals" />
/**
 * TDD — UpiQrScanField (the UPI_QR_SCAN renderer inside SchemeFormRenderer).
 *
 * UPI_QR_SCAN is a VALUE field: a live rear-camera QR scan whose stored value is the
 * extracted UPI VPA STRING (never an image / object key). These tests assert:
 *   - it renders a "Scan UPI QR" button (no file input, no manual text entry)
 *   - a decoded QR's VPA is stored + shown read-only, and the camera stops
 *   - Rescan re-opens the live camera
 *   - there is NEVER an <input type="file"> (no gallery / file-picker fallback)
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock jsqr — the decode is driven per-test; default returns null (no QR in frame).
vi.mock('jsqr', () => ({ default: vi.fn().mockReturnValue(null) }));

// The renderer talks to the enroll API on submit only; stub the whole client.
vi.mock('@/lib/schemes', () => ({
  schemeApi: {
    enroll: vi.fn().mockResolvedValue({ success: true, data: { enrollment: {}, submission: {} } }),
    uploadMedia: vi.fn(),
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
  },
}));

import { SchemeFormRenderer } from '../SchemeFormRenderer';
import type { EnrollmentFormSchema } from '@/lib/scheme-types';

const upiSchema: EnrollmentFormSchema = {
  captureGpsOnSubmit: false,
  requireOtp: false,
  fields: [{ id: 'upi', type: 'UPI_QR_SCAN', label: 'Shop owner UPI', required: true, order: 0 }],
};

const baseContext = { schemeId: 's1', mode: 'SELF' as const, outletApproved: false };

const renderForm = () =>
  render(
    <SchemeFormRenderer schema={upiSchema} context={baseContext} onSubmitted={vi.fn()} />,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('UpiQrScanField — scan-only, stores the VPA string', () => {
  it('renders a "Scan UPI QR" button and NO file input (no gallery)', () => {
    renderForm();
    expect(screen.getByRole('button', { name: /scan upi qr/i })).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('does not show the live camera until Scan is pressed', () => {
    renderForm();
    expect(screen.queryByTestId('upi-qr-camera-view')).not.toBeInTheDocument();
  });

  it('opens the rear camera (facingMode environment) when Scan is pressed', async () => {
    renderForm();
    await userEvent.click(screen.getByRole('button', { name: /scan upi qr/i }));
    await waitFor(() => expect(screen.getByTestId('upi-qr-camera-view')).toBeInTheDocument());
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({ facingMode: expect.objectContaining({ ideal: 'environment' }) }),
      }),
    );
  });

  it('decodes a QR, stores the extracted VPA string, shows it read-only, and stops the camera', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const jsqrModule = await import('jsqr');
    vi.mocked(jsqrModule.default).mockReturnValueOnce({
      data: 'upi://pay?pa=merchant@okhdfc&pn=Merchant',
      location: {} as any,
      binaryData: [],
      chunks: [],
      version: 1,
    });

    renderForm();
    await userEvent.click(screen.getByRole('button', { name: /scan upi qr/i }));
    // Advance past the ~300ms decode poll and flush the dynamic import().then().
    await act(async () => { vi.advanceTimersByTime(400); });

    await waitFor(() => expect(screen.getByText('merchant@okhdfc')).toBeInTheDocument());
    // Camera view is gone (scan stopped); no file input ever rendered.
    expect(screen.queryByTestId('upi-qr-camera-view')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    // Rescan affordance is present.
    expect(screen.getByRole('button', { name: /rescan/i })).toBeInTheDocument();

    vi.useRealTimers();
  });

  it('Rescan re-opens the live camera', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const jsqrModule = await import('jsqr');
    vi.mocked(jsqrModule.default).mockReturnValueOnce({
      data: 'merchant@okhdfc',
      location: {} as any,
      binaryData: [],
      chunks: [],
      version: 1,
    });

    renderForm();
    await userEvent.click(screen.getByRole('button', { name: /scan upi qr/i }));
    await act(async () => { vi.advanceTimersByTime(400); });
    await waitFor(() => expect(screen.getByText('merchant@okhdfc')).toBeInTheDocument());

    vi.useRealTimers();

    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockClear();
    await userEvent.click(screen.getByRole('button', { name: /rescan/i }));
    await waitFor(() => expect(screen.getByTestId('upi-qr-camera-view')).toBeInTheDocument());
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
