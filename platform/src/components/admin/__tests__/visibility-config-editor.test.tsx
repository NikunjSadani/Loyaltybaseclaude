/// <reference types="vitest/globals" />
/**
 * VISCFG — VisibilityConfigEditor
 *
 * VISCFG1: hydrates the per-tenant config and round-trips a whole-block save (setConfig).
 * VISCFG2: toggling an outlet type + a sales level is reflected in the saved block.
 * VISCFG3: describeWindows renders the D6 window preview per frequency.
 * VISCFG4: geo-fence on + a form with NO location → red warning + save blocked (M4).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const getConfig = vi.fn();
const setConfig = vi.fn();
const getForm = vi.fn();

vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    getConfig: (...a: unknown[]) => getConfig(...a),
    setConfig: (...a: unknown[]) => setConfig(...a),
    getForm: (...a: unknown[]) => getForm(...a),
  },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
  rewriteMediaViewPath: (p: string) => p.replace(/^\/v1\//, '/api/'),
}));

import { VisibilityConfigEditor, describeWindows } from '../VisibilityConfigEditor';

beforeEach(() => {
  getConfig.mockReset();
  setConfig.mockReset();
  getForm.mockReset();
  setConfig.mockResolvedValue({ success: true, data: {} });
  // Default: a form that DOES capture location (a GPS field present) — no geo-fence warning.
  getForm.mockResolvedValue({
    success: true,
    data: { id: 'f', clientId: 'c', version: 1, createdAt: '', updatedAt: '',
      formSchema: { captureGpsOnSubmit: false, fields: [
        { id: 'p', type: 'CAMERA', label: 'Photo', required: true, order: 0 },
        { id: 'g', type: 'GPS_POINT', label: 'Loc', required: false, order: 1 },
      ] } },
  });
});

describe('VISCFG — VisibilityConfigEditor', () => {
  it('VISCFG1: hydrates config and saves the whole block via setConfig', async () => {
    getConfig.mockResolvedValue({
      success: true,
      data: { outletScope: ['SSS'], frequencyPerMonth: 2, allowedSalesLevels: ['SO'], geoFence: { enabled: false, radiusMeters: 50 } },
    });
    render(<VisibilityConfigEditor />);

    // SSS checkbox is checked after hydration.
    const sss = await screen.findByLabelText('SSS');
    expect((sss as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        outletScope: ['SSS'],
        frequencyPerMonth: 2,
        allowedSalesLevels: ['SO'],
        geoFence: { enabled: false, radiusMeters: 50 },
      }),
    );
  });

  it('VISCFG2: toggling an outlet type + sales level is included in the saved block', async () => {
    getConfig.mockResolvedValue({
      success: true,
      data: { outletScope: ['SSS'], frequencyPerMonth: 1, allowedSalesLevels: ['XSR'], geoFence: { enabled: false, radiusMeters: 50 } },
    });
    render(<VisibilityConfigEditor />);

    fireEvent.click(await screen.findByLabelText('SSS_TOT')); // add outlet type
    fireEvent.click(screen.getByLabelText('ASM'));            // add sales level
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));

    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
    const block = setConfig.mock.calls[0][0];
    expect(block.outletScope).toEqual(expect.arrayContaining(['SSS', 'SSS_TOT']));
    expect(block.allowedSalesLevels).toEqual(expect.arrayContaining(['XSR', 'ASM']));
  });

  it('VISCFG3: describeWindows renders the D6 window preview', () => {
    expect(describeWindows(1)).toBe('[1–end]');
    expect(describeWindows(2)).toBe('[1–15] [16–end]');
    expect(describeWindows(4)).toBe('[1–8] [9–15] [16–23] [24–end]');
  });

  it('VISCFG4: geo-fence on + a location-less form → warning + save blocked (M4)', async () => {
    getConfig.mockResolvedValue({
      success: true,
      data: { outletScope: ['SSS'], frequencyPerMonth: 1, allowedSalesLevels: ['SO'], geoFence: { enabled: true, radiusMeters: 50 } },
    });
    // A camera-only form → captures NO device location.
    getForm.mockResolvedValue({
      success: true,
      data: { id: 'f', clientId: 'c', version: 1, createdAt: '', updatedAt: '',
        formSchema: { captureGpsOnSubmit: false, fields: [
          { id: 'p', type: 'CAMERA', label: 'Photo', required: true, order: 0 },
        ] } },
    });
    render(<VisibilityConfigEditor />);

    // The warning appears and the Save button is disabled → no setConfig even on click.
    await waitFor(() => expect(screen.getByTestId('geo-fence-no-gps-warning')).toBeInTheDocument());
    const saveBtn = screen.getByRole('button', { name: /save configuration/i });
    expect(saveBtn).toBeDisabled();
    fireEvent.click(saveBtn);
    expect(setConfig).not.toHaveBeenCalled();
  });
});
