/**
 * visibility-capture-form.test.tsx — the shared VisibilityCaptureForm renderer:
 *   1. renders a CAMERA field with its per-field instruction + sample thumbnail;
 *   2. selecting a photo runs the client-side compression path then uploads the
 *      compressed blob via visibilityApi.uploadSalesMedia;
 *   3. a field hidden by a visibleWhen clause is stripped from the submit payload.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Mock the canonical client — the renderer only touches uploadSalesMedia + mediaViewUrl.
const uploadSalesMedia = vi.fn();
vi.mock('@/lib/visibility', () => ({
  visibilityApi: {
    uploadSalesMedia: (...a: unknown[]) => uploadSalesMedia(...a),
  },
  mediaViewUrl: (key: string) => `/api/visibility/captures/media?key=${encodeURIComponent(key)}`,
}));

import {
  VisibilityCaptureForm,
  imageCompression,
} from '@/components/visibility/VisibilityCaptureForm';
import type { VisibilityFormSchema } from '@/lib/visibility-types';

beforeEach(() => {
  uploadSalesMedia.mockResolvedValue({ success: true, data: { key: 'visibility-media/c1/new.jpg' } });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const CAMERA_SCHEMA: VisibilityFormSchema = {
  captureGpsOnSubmit: false,
  fields: [
    {
      id: 'photo',
      type: 'CAMERA',
      label: 'Store photo',
      required: true,
      order: 0,
      instruction: 'Shoot the store board with POSM visible',
      sampleImageKey: 'visibility-media/c1/sample.jpg',
    },
  ],
};

describe('VisibilityCaptureForm — camera field', () => {
  it('renders the instruction text and the sample-image thumbnail', () => {
    render(<VisibilityCaptureForm schema={CAMERA_SCHEMA} onSubmit={vi.fn()} />);
    expect(screen.getByTestId('camera-instruction-photo')).toHaveTextContent(
      'Shoot the store board with POSM visible',
    );
    const sample = screen.getByTestId('camera-sample-photo') as HTMLImageElement;
    expect(sample.getAttribute('src')).toBe(
      '/api/visibility/captures/media?key=visibility-media%2Fc1%2Fsample.jpg',
    );
  });

  it('compresses then uploads the compressed blob on photo selection', async () => {
    const compressed = new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' });
    const compressSpy = vi.spyOn(imageCompression, 'compress').mockResolvedValue(compressed);

    const { container } = render(<VisibilityCaptureForm schema={CAMERA_SCHEMA} onSubmit={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'raw.jpg', { type: 'image/jpeg' });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await waitFor(() => {
      expect(compressSpy).toHaveBeenCalledWith(file);
      expect(uploadSalesMedia).toHaveBeenCalledTimes(1);
    });
    // uploaded blob is the COMPRESSED output, not the raw file
    expect(uploadSalesMedia).toHaveBeenCalledWith(compressed, 'photo.jpg');
  });
});

describe('VisibilityCaptureForm — submit while uploading (L2)', () => {
  it('disables submit while a photo upload is in flight', async () => {
    // compress resolves immediately; the UPLOAD hangs so we can observe the in-flight state.
    const compressed = new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' });
    vi.spyOn(imageCompression, 'compress').mockResolvedValue(compressed);
    let resolveUpload!: (v: unknown) => void;
    uploadSalesMedia.mockReturnValue(new Promise((res) => { resolveUpload = res; }));

    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<VisibilityCaptureForm schema={CAMERA_SCHEMA} onSubmit={onSubmit} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'raw.jpg', { type: 'image/jpeg' });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    // Upload is in flight → submit is disabled + labelled "Uploading photo…" and a click no-ops.
    const uploadingBtn = await screen.findByRole('button', { name: /uploading photo/i });
    expect(uploadingBtn).toBeDisabled();
    fireEvent.click(uploadingBtn);
    expect(onSubmit).not.toHaveBeenCalled();

    // Once the upload resolves, the button re-enables as "Submit capture".
    await act(async () => {
      resolveUpload({ success: true, data: { key: 'visibility-media/c1/new.jpg' } });
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /submit capture/i })).not.toBeDisabled(),
    );
  });
});

describe('VisibilityCaptureForm — submit payload', () => {
  it('strips a visibleWhen-hidden field from the submitted formValues', async () => {
    const schema: VisibilityFormSchema = {
      captureGpsOnSubmit: false,
      fields: [
        { id: 'photo', type: 'CAMERA', label: 'Photo', required: true, order: 0 },
        { id: 'kind', type: 'DROPDOWN', label: 'Kind', required: false, order: 1, options: ['A', 'B'] },
        {
          id: 'secret',
          type: 'TEXT',
          label: 'Secret',
          required: false,
          order: 2,
          visibleWhen: { fieldId: 'kind', op: 'eq', value: 'B' },
        },
      ],
    };
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <VisibilityCaptureForm
        schema={schema}
        // 'secret' carries a stale value but is hidden (kind !== 'B') → must be stripped.
        initialValues={{ photo: 'visibility-media/c1/x.jpg', kind: 'A', secret: 'stale-leak' }}
        onSubmit={onSubmit}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit capture/i }));
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload).toEqual({ photo: 'visibility-media/c1/x.jpg', kind: 'A' });
    expect(payload).not.toHaveProperty('secret');
  });
});
