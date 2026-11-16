/// <reference types="vitest/globals" />
/**
 * VISCFG — VisibilityConfigEditor
 *
 * VISCFG1: hydrates the per-tenant config and round-trips a whole-block save (setConfig).
 * VISCFG2: toggling an outlet type + a sales level is reflected in the saved block.
 * VISCFG3: describeWindows renders the D6 window preview per frequency.
 * VISCFG4: geo-fence on + a form with NO location → red warning + save blocked (M4).
 * VISCFG5: APPLIES-TO programs / subPrograms hydrate, round-trip, and drive the in-scope count.
 * VISCFG6: an older config without the keys saves explicit [] (unscoped = every program); options error is shown.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

const apiGet = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => apiGet(...a) } }));

const SCOPE_OPTIONS = {
  outletTypes: [{ code: 'SSS', label: 'RLP' }],
  programs: [{ value: 'Unnati', inSettings: true }, { value: 'Pragati', inSettings: true }],
  subPrograms: [{ value: 'Lite', inSettings: true }, { value: 'Legacy', inSettings: false }],
};

import { VisibilityConfigEditor, describeWindows } from '../VisibilityConfigEditor';

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation(async (url: string) => {
    if (url === '/api/admin/kpis/scope-options') return { success: true, data: SCOPE_OPTIONS };
    if (url.startsWith('/api/admin/kpis/scope-count')) return { success: true, data: { count: url.includes('programs=') ? 7 : 40 } };
    return { success: false, error: 'unexpected' };
  });
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
    expect(await screen.findByTestId('geo-fence-no-gps-warning')).toBeInTheDocument();
    const saveBtn = await screen.findByRole('button', { name: /save configuration/i });
    expect(saveBtn).toBeDisabled();
    fireEvent.click(saveBtn);
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('VISCFG5: programs / subPrograms hydrate, round-trip on save, and drive the in-scope count', async () => {
    getConfig.mockResolvedValue({
      success: true,
      data: { outletScope: ['SSS'], frequencyPerMonth: 1, allowedSalesLevels: ['SO'], geoFence: { enabled: false, radiusMeters: 50 },
        programs: ['Unnati'], subPrograms: [] },
    });
    render(<VisibilityConfigEditor />);
    // The config and the scope OPTIONS load via separate requests — wait for each (CI-runner flake 2026-11-15:
    // a sync getBy on the sub-program options ran before the options request resolved).
    const progs = await screen.findByRole('group', { name: 'Programs (optional)' }, { timeout: 15000 });
    expect(await within(progs).findByRole('checkbox', { name: 'Unnati' }, { timeout: 15000 })).toBeChecked();
    const subs = await screen.findByRole('group', { name: 'Sub-Programs (optional)' }, { timeout: 15000 });
    expect(await within(subs).findByRole('checkbox', { name: /Legacy.*not in settings list/ }, { timeout: 15000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('visibility-scope-count')).toHaveTextContent('7 matching outlets right now.'), { timeout: 15000 });
    expect(apiGet).toHaveBeenCalledWith('/api/admin/kpis/scope-count?outletTypes=SSS&programs=Unnati');

    fireEvent.click(await within(subs).findByRole('checkbox', { name: 'Lite' }, { timeout: 15000 }));
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
    expect(setConfig.mock.calls[0][0]).toMatchObject({ outletScope: ['SSS'], programs: ['Unnati'], subPrograms: ['Lite'] });
  }, 30000);

  it('VISCFG6: an older config (no keys) saves [] for both; no count without an outlet type; options error shown', async () => {
    apiGet.mockImplementation(async () => ({ success: false, error: 'Nope' }));
    getConfig.mockResolvedValue({
      success: true,
      data: { outletScope: [], frequencyPerMonth: 1, allowedSalesLevels: ['SO'], geoFence: { enabled: false, radiusMeters: 50 } },
    });
    render(<VisibilityConfigEditor />);
    expect(await screen.findByTestId('scope-options-error')).toHaveTextContent('Nope');
    expect(screen.queryByTestId('visibility-scope-count')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('SSS'));
    fireEvent.click(screen.getByRole('button', { name: /save configuration/i }));
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
    expect(setConfig.mock.calls[0][0]).toMatchObject({ programs: [], subPrograms: [] });
  });
});
