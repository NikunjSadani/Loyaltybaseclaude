/// <reference types="vitest/globals" />
/**
 * VISFORM — VisibilityFormBuilder
 *
 * VISFORM1: validateVisibilityFormSchema flags an empty form + missing camera.
 * VISFORM2: captureGpsOnSubmit with no GPS_POINT field is an error (gps-required).
 * VISFORM3: adding a CAMERA field exposes the instruction input + sample-image uploader (D9/D16).
 * VISFORM4: geo-fence on (config) + a form with no location → red warning + save blocked (M4).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const getForm = vi.fn();
const upsertForm = vi.fn();
const uploadMedia = vi.fn();
const getConfig = vi.fn();

vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    getForm: (...a: unknown[]) => getForm(...a),
    upsertForm: (...a: unknown[]) => upsertForm(...a),
    uploadMedia: (...a: unknown[]) => uploadMedia(...a),
    getConfig: (...a: unknown[]) => getConfig(...a),
  },
  mediaViewUrl: (k: string) => `/api/visibility/captures/media?key=${k}`,
  rewriteMediaViewPath: (p: string) => p.replace(/^\/v1\//, '/api/'),
}));

// The builder reads tenant Sub-Program values (outletCategories) from settings for the
// Outlet Sub-Program condition source — stub it deterministically (no network on mount).
vi.mock('@/lib/gifsy-settings', () => ({
  useGifsySettings: () => ({ outletCategories: ['Premium', 'Standard'] }),
}));

import { VisibilityFormBuilder, validateVisibilityFormSchema } from '../VisibilityFormBuilder';
import type { VisibilityFormSchema } from '@/lib/visibility-types';

beforeEach(() => {
  getForm.mockReset();
  upsertForm.mockReset();
  uploadMedia.mockReset();
  getConfig.mockReset();
  getForm.mockResolvedValue({ success: true, data: null });
  // Default: geo-fence OFF → no geo-fence cross-check warning.
  getConfig.mockResolvedValue({ success: true, data: { geoFence: { enabled: false, radiusMeters: 50 } } });
});

describe('VISFORM — VisibilityFormBuilder', () => {
  it('VISFORM1: flags an empty form + missing camera field', () => {
    const errs = validateVisibilityFormSchema({ captureGpsOnSubmit: false, fields: [] });
    expect(errs).toContain('Add at least one field.');
    expect(errs.some((e) => /Camera field/i.test(e))).toBe(true);
  });

  it('VISFORM2: captureGpsOnSubmit with no GPS field is an error', () => {
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: true,
      fields: [{ id: 'c1', type: 'CAMERA', label: 'Cooler', required: true, order: 0 }],
    };
    const errs = validateVisibilityFormSchema(schema);
    expect(errs.some((e) => /Capture GPS on submit/i.test(e))).toBe(true);
    // Camera present → no camera-required error.
    expect(errs.some((e) => /Camera field/i.test(e))).toBe(false);
  });

  it('VISFORM3: adding a Camera field exposes instruction + sample uploader', async () => {
    render(<VisibilityFormBuilder />);

    // Wait for the (empty) form to load, then open the field picker.
    fireEvent.click(await screen.findByRole('button', { name: /add field/i }));
    // Choose the Camera field type.
    fireEvent.click(screen.getByRole('button', { name: /Camera Rear-camera capture/i }));

    // The new CAMERA field auto-expands: instruction input + sample uploader visible.
    expect(await screen.findByLabelText('Camera instruction')).toBeInTheDocument();
    expect(screen.getByLabelText('Upload sample image')).toBeInTheDocument();
  });

  it('VISFORM5: the local validator accepts a clause keyed on the reserved Outlet Sub-Program source', () => {
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: false,
      fields: [
        { id: 'p1', type: 'CAMERA', label: 'Photo 1', required: true, order: 0 },
        {
          id: 'p2', type: 'CAMERA', label: 'Photo 2', required: false, order: 1,
          requiredWhen: { fieldId: '__subProgram__', op: 'eq', value: 'Premium' },
          visibleWhen: { fieldId: '__subProgram__', op: 'eq', value: 'Premium' },
        },
      ],
    };
    const errs = validateVisibilityFormSchema(schema);
    // The reserved source is whitelisted → no "unknown field" error.
    expect(errs.some((e) => /references an unknown field/i.test(e))).toBe(false);
  });

  it('VISFORM6: Outlet Sub-Program is a selectable condition source that round-trips into the schema', async () => {
    upsertForm.mockResolvedValue({ success: true, data: { version: 2 } });
    render(<VisibilityFormBuilder />);

    // Add a Camera field (auto-expands; optional by default → "Required only when…" shows).
    fireEvent.click(await screen.findByRole('button', { name: /add field/i }));
    fireEvent.click(screen.getByRole('button', { name: /Camera Rear-camera capture/i }));

    // Give it a label so the form is valid to save.
    fireEvent.change(await screen.findByPlaceholderText(/Camera label/i), { target: { value: 'POSM photo' } });

    // Enable "Required only when…" — with no other form field, it defaults to the
    // Outlet Sub-Program source.
    fireEvent.click(screen.getByText('Required only when…'));

    // The source dropdown offers "Outlet Sub-Program"; the value dropdown offers the
    // tenant's configured Sub-Program values (from settings.outletCategories).
    expect(screen.getByRole('option', { name: 'Outlet Sub-Program' })).toBeInTheDocument();
    const premium = screen.getByRole('option', { name: 'Premium' }) as HTMLOptionElement;
    expect(premium).toBeInTheDocument();

    // Pick the value "Premium".
    fireEvent.change(premium.closest('select') as HTMLSelectElement, { target: { value: 'Premium' } });

    // Save → the reserved clause round-trips into the saved schema and the validator accepts it.
    fireEvent.click(screen.getByRole('button', { name: /save form/i }));
    await waitFor(() => expect(upsertForm).toHaveBeenCalledTimes(1));
    const saved = upsertForm.mock.calls[0][0].formSchema as VisibilityFormSchema;
    expect(saved.fields[0].requiredWhen).toEqual({ fieldId: '__subProgram__', op: 'eq', value: 'Premium' });
  });

  it('VISFORM4: geo-fence on + a location-less form → warning + save blocked (M4)', async () => {
    // Geo-fence enabled in config; the saved form is camera-only (no GPS, no captureGpsOnSubmit).
    getConfig.mockResolvedValue({ success: true, data: { geoFence: { enabled: true, radiusMeters: 50 } } });
    getForm.mockResolvedValue({
      success: true,
      data: { id: 'f', clientId: 'c', version: 1, createdAt: '', updatedAt: '',
        formSchema: { captureGpsOnSubmit: false, fields: [
          { id: 'p', type: 'CAMERA', label: 'Photo', required: true, order: 0 },
        ] } },
    });
    render(<VisibilityFormBuilder />);

    await waitFor(() => expect(screen.getByTestId('geo-fence-no-gps-warning')).toBeInTheDocument());
    const saveBtn = screen.getByRole('button', { name: /save form/i });
    expect(saveBtn).toBeDisabled();
    fireEvent.click(saveBtn);
    expect(upsertForm).not.toHaveBeenCalled();
  });
});
