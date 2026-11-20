/// <reference types="vitest/globals" />
/**
 * Visibility photo viewer (/visibility/photo?key=…) — the Excel report's "Open photo" target: loads the role-gated
 * media endpoint, shows the image + Download, and a plain error for 403 / 404 / missing key.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => search }));

import VisibilityPhotoPage from '../page';

const KEY = 'visibility-media/bajaj/vendor-import/A003/2026-11_v1.jpg';

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:photo-1'), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'image/jpeg' }),
    blob: () => Promise.resolve(new Blob(['x'], { type: 'image/jpeg' })),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Visibility photo viewer page', () => {
  it('loads the media endpoint for the key and shows the photo with a Download link', async () => {
    search = new URLSearchParams({ key: KEY });
    const fetchMock = stubFetch(200);
    render(<VisibilityPhotoPage />);
    const img = await screen.findByAltText('Visibility photo');
    expect(img.getAttribute('src')).toBe('blob:photo-1');
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/visibility/captures/media?key=${encodeURIComponent(KEY)}`);
    const dl = screen.getByRole('link', { name: /download/i });
    expect(dl.getAttribute('href')).toBe('blob:photo-1');
    expect(dl.getAttribute('download')).toBe('2026-11_v1.jpg');
  });

  it('403 → "You don\'t have access to this photo"', async () => {
    search = new URLSearchParams({ key: KEY });
    stubFetch(403);
    render(<VisibilityPhotoPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("You don't have access to this photo"));
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
  });

  it('404 → "Photo not found"', async () => {
    search = new URLSearchParams({ key: KEY });
    stubFetch(404);
    render(<VisibilityPhotoPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Photo not found'));
  });

  it('no key → "Photo not found" without calling the server', async () => {
    search = new URLSearchParams();
    const fetchMock = stubFetch(200);
    render(<VisibilityPhotoPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Photo not found'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
