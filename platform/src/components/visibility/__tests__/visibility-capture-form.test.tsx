/**
 * visibility-capture-form.test.tsx — the shared VisibilityCaptureForm renderer:
 *   1. a camera-only CAMERA field renders the TRUE in-app live camera (getUserMedia)
 *      and NO `<input type="file">` (the device gallery can never open);
 *   2. an author-opted gallery field (`noGallery: false`) still renders the file input;
 *   3. capturing a photo runs the client-side compression path then uploads the
 *      compressed blob via visibilityApi.uploadSalesMedia;
 *   4. a field hidden by a visibleWhen clause is stripped from the submit payload;
 *   5. the partial re-capture (CHANGES_REQUESTED) flow.
 *
 * jsdom has no camera: getUserMedia / canvas.toBlob / HTMLMediaElement.play are mocked
 * below so the live-capture path runs headlessly.
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

// Track the live stream's stop() so cleanup can be asserted.
let trackStop: ReturnType<typeof vi.fn>;

beforeEach(() => {
  uploadSalesMedia.mockResolvedValue({ success: true, data: { key: 'visibility-media/c1/new.jpg' } });

  // getUserMedia → a fake stream whose single track records stop() calls.
  trackStop = vi.fn();
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] }) },
    configurable: true,
  });

  // canvas.toBlob → invoke the callback with a tiny JPEG blob (jsdom has no encoder).
  Object.defineProperty(globalThis.HTMLCanvasElement.prototype, 'toBlob', {
    value(cb: (b: Blob) => void) {
      cb(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }));
    },
    configurable: true,
    writable: true,
  });

  // HTMLMediaElement.play → resolved promise (jsdom does not implement it meaningfully).
  Object.defineProperty(globalThis.HTMLMediaElement.prototype, 'play', {
    value: vi.fn().mockResolvedValue(undefined),
    configurable: true,
    writable: true,
  });

  // URL.createObjectURL / revokeObjectURL — used for the captured still preview.
  if (!('createObjectURL' in URL)) {
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:stub', configurable: true, writable: true });
  }
  if (!('revokeObjectURL' in URL)) {
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true, writable: true });
  }
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** Tap-to-open the camera, then click the shutter once the stream is ready. */
async function shoot(fieldId: string) {
  // The camera no longer auto-opens (single-active-stream anti-contention) — open it first.
  const openBtn = await screen.findByTestId(`camera-${fieldId}-open`);
  await act(async () => {
    fireEvent.click(openBtn);
  });
  const btn = await screen.findByTestId(`camera-${fieldId}-capture`);
  await waitFor(() => expect(btn).not.toBeDisabled());
  await act(async () => {
    fireEvent.click(btn);
  });
}

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

describe('VisibilityCaptureForm — camera field (live, camera-only)', () => {
  it('renders the live camera UI and NO file input (gallery can never open)', async () => {
    const { container } = render(<VisibilityCaptureForm schema={CAMERA_SCHEMA} onSubmit={vi.fn()} />);
    // Camera-only field shows a tap-to-open button (stream NOT auto-opened), and NO file input.
    expect(await screen.findByTestId('camera-photo-open')).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    // Tapping Open reveals the live preview + shutter — still no file input, ever.
    await act(async () => { fireEvent.click(screen.getByTestId('camera-photo-open')); });
    expect(await screen.findByTestId('camera-photo-video')).toBeInTheDocument();
    expect(screen.getByTestId('camera-photo-capture')).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

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

  it('compresses then uploads the compressed blob when a photo is captured', async () => {
    const compressed = new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' });
    const compressSpy = vi.spyOn(imageCompression, 'compress').mockResolvedValue(compressed);

    render(<VisibilityCaptureForm schema={CAMERA_SCHEMA} onSubmit={vi.fn()} />);
    await shoot('photo');

    await waitFor(() => {
      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(uploadSalesMedia).toHaveBeenCalledTimes(1);
    });
    // The File handed to compress is the live-captured JPEG, and the UPLOADED blob is the
    // compressed output (not the raw frame).
    const passed = compressSpy.mock.calls[0][0] as File;
    expect(passed).toBeInstanceOf(File);
    expect(passed.type).toBe('image/jpeg');
    expect(uploadSalesMedia).toHaveBeenCalledWith(compressed, 'photo.jpg');

    // The captured photo is shown back to the rep (KYC-enrollment parity) — not just a text chip.
    expect(await screen.findByTestId('camera-photo-captured-img')).toBeInTheDocument();
    expect(screen.getByText('Photo captured')).toBeInTheDocument();
  });

  it('stops every camera track after the shot (no lingering stream)', async () => {
    vi.spyOn(imageCompression, 'compress').mockResolvedValue(
      new Blob([new Uint8Array([9])], { type: 'image/jpeg' }),
    );
    render(<VisibilityCaptureForm schema={CAMERA_SCHEMA} onSubmit={vi.fn()} />);
    await shoot('photo');
    // Freezing to the still tears the stream down.
    await waitFor(() => expect(trackStop).toHaveBeenCalled());
  });
});

describe('VisibilityCaptureForm — gallery-allowed field (noGallery: false)', () => {
  const GALLERY_SCHEMA: VisibilityFormSchema = {
    captureGpsOnSubmit: false,
    fields: [
      {
        id: 'photo',
        type: 'CAMERA',
        label: 'Store photo',
        required: true,
        order: 0,
        noGallery: false,
      },
    ],
  };

  it('keeps the <input type="file"> (gallery allowed by the author) and no live camera', () => {
    const { container } = render(<VisibilityCaptureForm schema={GALLERY_SCHEMA} onSubmit={vi.fn()} />);
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
    // No live camera is mounted for a gallery-allowed field.
    expect(screen.queryByTestId('camera-photo-video')).not.toBeInTheDocument();
  });

  it('compresses then uploads on file selection via the gallery input', async () => {
    const compressed = new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' });
    const compressSpy = vi.spyOn(imageCompression, 'compress').mockResolvedValue(compressed);

    const { container } = render(<VisibilityCaptureForm schema={GALLERY_SCHEMA} onSubmit={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'raw.jpg', { type: 'image/jpeg' });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await waitFor(() => {
      expect(compressSpy).toHaveBeenCalledWith(file);
      expect(uploadSalesMedia).toHaveBeenCalledWith(compressed, 'photo.jpg');
    });
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
    render(<VisibilityCaptureForm schema={CAMERA_SCHEMA} onSubmit={onSubmit} />);
    await shoot('photo');

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

describe('VisibilityCaptureForm — outlet-context conditional (sub-program)', () => {
  // A 2nd CAMERA that only shows + is required for sub-program 'X', driven by the OUTLET's
  // sub-program (reserved `__subProgram__` source), NOT a rep-entered value.
  const TWO_PHOTO_SCHEMA: VisibilityFormSchema = {
    captureGpsOnSubmit: false,
    fields: [
      { id: 'photo1', type: 'CAMERA', label: 'Photo 1', required: true, order: 0 },
      {
        id: 'photo2',
        type: 'CAMERA',
        label: 'Photo 2',
        required: false,
        order: 1,
        visibleWhen: { fieldId: '__subProgram__', op: 'eq', value: 'X' },
        requiredWhen: { fieldId: '__subProgram__', op: 'eq', value: 'X' },
      },
    ],
  };

  it('shows + requires the 2nd CAMERA when the outlet sub-program matches (X)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <VisibilityCaptureForm
        schema={TWO_PHOTO_SCHEMA}
        initialValues={{ photo1: 'visibility-media/c1/p1.jpg' }}
        outletContext={{ subProgram: 'X' }}
        onSubmit={onSubmit}
      />,
    );

    // Photo 2 is visible (its visibleWhen clause is true for sub-program X).
    expect(screen.getByText('Photo 2')).toBeInTheDocument();

    // Submitting without Photo 2 is blocked — it is required for sub-program X.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit capture/i }));
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('"Photo 2" is required.'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('hides + does not require the 2nd CAMERA for a different sub-program (Y); no reserved key in payload', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <VisibilityCaptureForm
        schema={TWO_PHOTO_SCHEMA}
        initialValues={{ photo1: 'visibility-media/c1/p1.jpg' }}
        outletContext={{ subProgram: 'Y' }}
        onSubmit={onSubmit}
      />,
    );

    // Photo 2 is hidden (its visibleWhen clause is false for sub-program Y).
    expect(screen.queryByText('Photo 2')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit capture/i }));
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload).toEqual({ photo1: 'visibility-media/c1/p1.jpg' });
    expect(payload).not.toHaveProperty('photo2');
    // The reserved outlet-context key must NEVER be submitted.
    expect(payload).not.toHaveProperty('__subProgram__');
  });

  it('never submits the reserved key even when the 2nd photo is captured (X)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <VisibilityCaptureForm
        schema={TWO_PHOTO_SCHEMA}
        initialValues={{
          photo1: 'visibility-media/c1/p1.jpg',
          photo2: 'visibility-media/c1/p2.jpg',
          // A crafted/stale reserved key in the initial values must be stripped.
          __subProgram__: 'spoofed',
        }}
        outletContext={{ subProgram: 'X' }}
        onSubmit={onSubmit}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit capture/i }));
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload).toEqual({
      photo1: 'visibility-media/c1/p1.jpg',
      photo2: 'visibility-media/c1/p2.jpg',
    });
    expect(payload).not.toHaveProperty('__subProgram__');
  });
});

describe('VisibilityCaptureForm — partial re-capture (CHANGES_REQUESTED)', () => {
  const TWO_PHOTO: VisibilityFormSchema = {
    captureGpsOnSubmit: false,
    fields: [
      { id: 'photo1', type: 'CAMERA', label: 'Front photo', required: true, order: 0 },
      { id: 'photo2', type: 'CAMERA', label: 'Shelf photo', required: true, order: 1 },
      { id: 'note', type: 'TEXT', label: 'Note', required: false, order: 2 },
    ],
  };
  const REVIEWS = {
    photo1: { status: 'APPROVED' as const, reviewedAt: 'x', reviewedByUserId: 'g1' },
    photo2: { status: 'REJECTED' as const, reasonCode: 'BLURRY' as const, reason: 'too dark', reviewedAt: 'x', reviewedByUserId: 'g1' },
  };

  it('shows ONLY the rejected photo as editable; approved photo carried forward; non-camera hidden', () => {
    render(
      <VisibilityCaptureForm schema={TWO_PHOTO} photoReviews={REVIEWS} partialRecapture onSubmit={vi.fn()} />,
    );
    // The rejected photo (photo2) is editable with its reason shown.
    expect(screen.getByText('Shelf photo')).toBeInTheDocument();
    expect(screen.getByText(/Flagged for re-capture/i)).toBeInTheDocument();
    expect(screen.getByText(/too dark/)).toBeInTheDocument();
    // The rejected photo renders the live camera (camera-only) — its tap-to-open control.
    expect(screen.getByTestId('camera-photo2-open')).toBeInTheDocument();
    // The approved photo (photo1) is carried forward read-only (no live camera for it).
    expect(screen.getByTestId('carried-forward-photo1')).toBeInTheDocument();
    expect(screen.queryByTestId('camera-photo1-capture')).not.toBeInTheDocument();
    // A non-camera field is hidden entirely in partial mode.
    expect(screen.queryByText('Note')).not.toBeInTheDocument();
  });

  it('blocks submit until the rejected photo is re-captured, then sends only that field', async () => {
    const compressed = new Blob([new Uint8Array([9, 9])], { type: 'image/jpeg' });
    vi.spyOn(imageCompression, 'compress').mockResolvedValue(compressed);
    uploadSalesMedia.mockResolvedValue({ success: true, data: { key: 'visibility-media/c1/reshot.jpg' } });

    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <VisibilityCaptureForm schema={TWO_PHOTO} photoReviews={REVIEWS} partialRecapture onSubmit={onSubmit} />,
    );

    // Submit with nothing re-captured → blocked.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit re-capture/i }));
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Shelf photo.*re-captured/i));
    expect(onSubmit).not.toHaveBeenCalled();

    // Re-capture the only editable photo (photo2) via the live camera.
    await shoot('photo2');
    await waitFor(() => expect(uploadSalesMedia).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit re-capture/i }));
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Payload contains ONLY the re-captured (rejected) field.
    expect(onSubmit.mock.calls[0][0]).toEqual({ photo2: 'visibility-media/c1/reshot.jpg' });
  });

  it('falls back to the full form when partialRecapture is set but no photo is rejected', () => {
    const allApproved = {
      photo1: { status: 'APPROVED' as const, reviewedAt: 'x', reviewedByUserId: 'g1' },
      photo2: { status: 'APPROVED' as const, reviewedAt: 'x', reviewedByUserId: 'g1' },
    };
    render(
      <VisibilityCaptureForm schema={TWO_PHOTO} photoReviews={allApproved} partialRecapture onSubmit={vi.fn()} />,
    );
    // Normal full form → the non-camera field is visible and the button is "Submit capture".
    expect(screen.getByText('Note')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit capture/i })).toBeInTheDocument();
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
