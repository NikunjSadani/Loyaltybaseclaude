/// <reference types="vitest/globals" />
/**
 * GiftImageUpload — the REAL file → portal upload control shared by both gift editors.
 * A picked file POSTs multipart to the ONE endpoint; the returned PUBLIC url is appended
 * to `value`; an error surfaces; a stored image can be removed.
 *
 * Run: npx vitest run src/app/admin/gift-catalogue/__tests__/gift-image-upload.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api-client', () => ({ authHeader: () => ({}) }));

import { GiftImageUpload, GIFT_IMAGE_UPLOAD_URL, uploadGiftImage } from '@/components/GiftImageUpload';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); });

function okResponse(url: string) {
  return { ok: true, json: async () => ({ success: true, data: { url } }) } as Response;
}

describe('uploadGiftImage()', () => {
  it('POSTs multipart to the shared endpoint and returns the stored url', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('https://storage.googleapis.com/b/gift-catalogue/a.png'));
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
    const res = await uploadGiftImage(file);

    expect(res).toEqual({ ok: true, url: 'https://storage.googleapis.com/b/gift-catalogue/a.png' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GIFT_IMAGE_UPLOAD_URL);
    expect(url).toBe('/api/admin/gift-catalogue/image');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    // Must NOT hand-set Content-Type (browser sets the multipart boundary).
    expect(init.headers?.['Content-Type']).toBeUndefined();
  });

  it('maps a non-ok envelope to an error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: 'File too large (max 5 MB)' }) } as Response);
    const res = await uploadGiftImage(new File(['x'], 'x.png'));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/File too large/);
  });
});

describe('<GiftImageUpload/>', () => {
  it('appends the uploaded url via onChange after a successful upload', async () => {
    fetchMock.mockResolvedValueOnce(okResponse('https://storage.googleapis.com/b/gift-catalogue/new.png'));
    const onChange = vi.fn();
    render(<GiftImageUpload value={[]} onChange={onChange} />);

    const input = screen.getByTestId('gift-image-input') as HTMLInputElement;
    const file = new File([new Uint8Array([1])], 'new.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['https://storage.googleapis.com/b/gift-catalogue/new.png']));
  });

  it('shows an inline error and does not call onChange when the upload fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: 'Unsupported or corrupt file.' }) } as Response);
    const onChange = vi.fn();
    render(<GiftImageUpload value={[]} onChange={onChange} />);

    fireEvent.change(screen.getByTestId('gift-image-input'), {
      target: { files: [new File(['x'], 'bad.txt')] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/Unsupported or corrupt file/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders a thumbnail per stored url and removes one via onChange', () => {
    const onChange = vi.fn();
    const urls = ['https://storage.googleapis.com/b/gift-catalogue/1.png', 'https://storage.googleapis.com/b/gift-catalogue/2.png'];
    render(<GiftImageUpload value={urls} onChange={onChange} />);

    const removes = screen.getAllByTestId('gift-image-remove');
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[0]);
    expect(onChange).toHaveBeenCalledWith(['https://storage.googleapis.com/b/gift-catalogue/2.png']);
  });
});
