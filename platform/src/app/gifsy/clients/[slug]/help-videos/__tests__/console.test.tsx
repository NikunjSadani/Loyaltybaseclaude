/// <reference types="vitest/globals" />
/**
 * HV-C — Gifsy console "Help & videos" page.
 *
 * HV-C1  Lists guides per audience with who sees them (Everyone / role labels) + Draft/Published.
 * HV-C2  Flag OFF → loud banner that members see nothing yet.
 * HV-C3  Publish → PATCH { isPublished: true }; the server's refusal is shown (not swallowed).
 * HV-C4  Video upload: a non-MP4 or > 50 MB file is refused in the browser with no request.
 * HV-C5  Video upload: MP4 goes start → parts → complete, and the card updates.
 * HV-C6  GIFSY_STAFF (API 403) → "Only Gifsy admins can manage Help & videos."
 * HV-C7  The client-page entry hook is true ONLY for a stored GIFSY_ADMIN (GIFSY_STAFF / none → hidden).
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { renderHook } from '@testing-library/react';
import HelpVideosConsolePage from '../page';
import { useCanManageHelpVideos } from '@/lib/help-videos-access';

function json(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return Promise.resolve({ ok: status >= 200 && status < 300, status, statusText: '', json: () => Promise.resolve(body), text: () => Promise.resolve(text) });
}

const T1 = {
  id: 't1', audience: 'SALES', roles: [], title: 'Install the app', description: null, sortOrder: 0, isPublished: false,
  steps: ['a', 'b', 'c'], hasVideo: false, videoBytes: null, videoUrl: null, posterUrl: null,
};
const T2 = { ...T1, id: 't2', audience: 'PARTNER', roles: ['RETAILER'], title: 'Your wallet', isPublished: true };
const OPTIONS = { SALES: [{ code: 'SO', label: 'Sales Officer (level)' }], PARTNER: [{ code: 'RETAILER', label: 'Retailer (outlet type)' }] };

type Handler = (url: string, init?: RequestInit) => Promise<unknown> | undefined;
function stub(flagOn: boolean, extra?: Handler) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const r = extra?.(url, init);
    if (r) return r;
    if (url.endsWith('/help-topics/role-options')) return json({ success: true, data: OPTIONS });
    if (url.endsWith('/help-topics') && (!init || !init.method)) return json({ success: true, data: { flagOn, topics: [T1, T2] } });
    return json({ success: false, error: `unexpected ${url}` }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function renderPage() {
  await act(async () => { render(<HelpVideosConsolePage params={Promise.resolve({ slug: 'bajaj' })} />); });
  await screen.findAllByTestId('help-topic-card', {}, { timeout: 15_000 });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('HV-C — console page', () => {
  it('HV-C1: guides per audience with who sees them', async () => {
    stub(true);
    await renderPage();
    const aud = screen.getAllByTestId('help-topic-audience').map((e) => e.textContent);
    expect(aud).toEqual(['Sales app · Everyone', 'Partner app · Retailer (outlet type)']);
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.queryByTestId('help-flag-off')).toBeNull();
  });

  it('HV-C2: flag OFF → banner', async () => {
    stub(false);
    await renderPage();
    expect(screen.getByTestId('help-flag-off')).toHaveTextContent(/OFF for this client/);
  });

  it('HV-C3: publish → PATCH; server refusal is shown', async () => {
    const fetchMock = stub(true, (url, init) =>
      init?.method === 'PATCH' ? json({ success: false, error: 'Add at least 3 steps before publishing (this guide has 1).' }, 400) : undefined,
    );
    await renderPage();
    fireEvent.click(screen.getAllByText('Publish')[0]);
    expect(await screen.findByText(/Add at least 3 steps/)).toBeInTheDocument();
    const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')!;
    expect(String(patch[0])).toBe('/api/gifsy/clients/bajaj/help-topics/t1');
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ isPublished: true });
  });

  it('HV-C4: non-MP4 / over 50 MB refused in the browser — no upload request', async () => {
    const fetchMock = stub(true);
    await renderPage();
    const input = screen.getAllByTestId('help-video-input')[0] as HTMLInputElement;
    const before = fetchMock.mock.calls.length;
    fireEvent.change(input, { target: { files: [new File(['x'], 'clip.mov', { type: 'video/quicktime' })] } });
    expect(await screen.findByText(/Upload an \.mp4 video/)).toBeInTheDocument();
    const big = new File(['x'], 'big.mp4', { type: 'video/mp4' });
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await screen.findByText(/the limit is 50 MB/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('HV-C5: MP4 upload → start, parts, complete; card shows the video', async () => {
    const fetchMock = stub(true, (url) => {
      if (url.includes('/video-uploads?bytes=')) return json({ success: true, data: { uploadId: 'u1', partBytes: 4 } });
      if (url.includes('/video-uploads/u1/parts/')) return json({ success: true, data: { part: 0, bytes: 4 } });
      if (url.endsWith('/video-uploads/u1/complete')) return json({ success: true, data: { ...T1, hasVideo: true, videoBytes: 10, videoUrl: '/api/help/media?token=p' } });
      return undefined;
    });
    await renderPage();
    const input = screen.getAllByTestId('help-video-input')[0] as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['0123456789'], 'clip.mp4', { type: 'video/mp4' })] } });
    await waitFor(() => expect(screen.getByText(/Video 0\.0 MB/)).toBeInTheDocument());
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('/parts/'))).toEqual([
      '/api/gifsy/clients/bajaj/help-topics/t1/video-uploads/u1/parts/0',
      '/api/gifsy/clients/bajaj/help-topics/t1/video-uploads/u1/parts/1',
      '/api/gifsy/clients/bajaj/help-topics/t1/video-uploads/u1/parts/2',
    ]);
    expect(urls.some((u) => u.endsWith('/complete'))).toBe(true);
  });

  it('HV-C6: GIFSY_STAFF → API 403 → honest message, no guides', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => json({ success: false, error: 'Forbidden' }, 403)));
    await act(async () => { render(<HelpVideosConsolePage params={Promise.resolve({ slug: 'bajaj' })} />); });
    expect(await screen.findByText('Only Gifsy admins can manage Help & videos.')).toBeInTheDocument();
    expect(screen.queryByTestId('help-topic-card')).toBeNull();
  });

  it('HV-C7: entry link shown only for a stored GIFSY_ADMIN', async () => {
    const cases: Array<[string | null, boolean]> = [['GIFSY_ADMIN', true], ['GIFSY_STAFF', false], ['CLIENT_ADMIN', false], [null, false]];
    for (const [role, expected] of cases) {
      if (role) localStorage.setItem('user', JSON.stringify({ name: 'x', role }));
      else localStorage.removeItem('user');
      const { result, unmount } = renderHook(() => useCanManageHelpVideos());
      await waitFor(() => expect(result.current).toBe(expected));
      unmount();
    }
    localStorage.removeItem('user');
  });
});
