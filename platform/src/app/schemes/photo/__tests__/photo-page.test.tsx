/// <reference types="vitest/globals" />
/**
 * Scheme media viewer (/schemes/photo?key=…) — the scheme enrollment Excel's "Open photo" / "Open file" target: loads
 * the signed-in, tenant-pinned scheme media endpoint; image → <img> + Download; PDF → embedded frame + Download;
 * 403 (another programme / no scheme access) → "You don't have access"; 404 → "not found".
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

let search = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => search }));

import SchemePhotoPage from '../page';

const KEY = 'scheme-media/deoleo/2026-09/0b7c-shop_front.jpg';
const PDF_KEY = 'scheme-media/deoleo/2026-09/0b7c-gst_certificate.pdf';

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:media-1'), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, contentType = 'image/jpeg') {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    blob: () => Promise.resolve(new Blob(['x'], { type: contentType })),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Scheme photo viewer page', () => {
  it('loads the signed-in scheme media endpoint and shows the photo with a Download link', async () => {
    search = new URLSearchParams({ key: KEY });
    const fetchMock = stubFetch(200);
    render(<SchemePhotoPage />);
    const img = await screen.findByAltText('Scheme photo');
    expect(img.getAttribute('src')).toBe('blob:media-1');
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/schemes/media/file?key=${encodeURIComponent(KEY)}`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin' });
    const dl = screen.getByRole('link', { name: /download/i });
    expect(dl.getAttribute('download')).toBe('0b7c-shop_front.jpg');
    expect(screen.getByRole('heading').textContent).toBe('Scheme photo');
  });

  function stubWidth(desktop: boolean) {
    vi.stubGlobal('matchMedia', vi.fn((q: string) => ({ matches: desktop, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: (globalThis as { matchMedia: unknown }).matchMedia });
  }

  it('PDF on a PHONE: an "Open PDF" button + Download, NO frame (a blob: frame is blank on Android / iOS)', async () => {
    stubWidth(false);
    search = new URLSearchParams({ key: PDF_KEY });
    stubFetch(200, 'application/pdf');
    const { container } = render(<SchemePhotoPage />);
    const open = await screen.findByRole('link', { name: /open pdf/i });
    expect(open.getAttribute('href')).toBe('blob:media-1');
    expect(open.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('heading').textContent).toBe('Scheme file');
    expect(screen.getByRole('link', { name: /download/i }).getAttribute('download')).toBe('0b7c-gst_certificate.pdf');
  });

  it('PDF on a DESKTOP: the "Open PDF" button AND an embedded frame', async () => {
    stubWidth(true);
    search = new URLSearchParams({ key: PDF_KEY });
    stubFetch(200, 'application/pdf');
    const { container } = render(<SchemePhotoPage />);
    await screen.findByRole('link', { name: /open pdf/i });
    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBe('blob:media-1'));
  });

  it('wording follows the SERVED content type: a PDF behind a ".jpg" key reads "Scheme file" once loaded', async () => {
    stubWidth(false);
    search = new URLSearchParams({ key: KEY });
    stubFetch(200, 'application/pdf');
    render(<SchemePhotoPage />);
    await screen.findByRole('link', { name: /open pdf/i });
    expect(screen.getByRole('heading').textContent).toBe('Scheme file');
  });

  it('403 (another programme, or a role without scheme access) → "You don\'t have access"', async () => {
    search = new URLSearchParams({ key: 'scheme-media/bajaj/2026-09/x.jpg' });
    stubFetch(403);
    render(<SchemePhotoPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("You don't have access to this photo"));
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
  });

  it('403 on a PDF link says "this file"', async () => {
    search = new URLSearchParams({ key: PDF_KEY });
    stubFetch(403);
    render(<SchemePhotoPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("You don't have access to this file"));
  });

  it('404 → "Photo not found"; 401 → "Your session has ended" with Reload', async () => {
    search = new URLSearchParams({ key: KEY });
    stubFetch(404);
    const { unmount } = render(<SchemePhotoPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Photo not found'));
    unmount();
    stubFetch(401);
    render(<SchemePhotoPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Your session has ended'));
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('an image the browser cannot render → "can\'t be displayed" with a Download link', async () => {
    search = new URLSearchParams({ key: KEY });
    stubFetch(200);
    render(<SchemePhotoPage />);
    fireEvent.error(await screen.findByAltText('Scheme photo'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("This photo can't be displayed in the browser");
  });

  it('no key → "Photo not found" without calling the server', async () => {
    search = new URLSearchParams();
    const fetchMock = stubFetch(200);
    render(<SchemePhotoPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Photo not found'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
