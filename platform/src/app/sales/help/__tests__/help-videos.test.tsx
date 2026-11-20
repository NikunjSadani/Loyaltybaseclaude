/// <reference types="vitest/globals" />
/**
 * HV-S — Help & videos in the SALES app (tenant flag `helpVideos`, Bajaj ON / Deoleo OFF).
 *
 * HV-S1  Profile shows the "Help & videos" entry only when the flag is ON (read from the layout's
 *        existing /api/sales/me via SalesFeaturesContext — no extra request).
 * HV-S2  Flag OFF / features not loaded → no entry, and the page makes exactly its usual requests.
 * HV-S3  List renders published guides from /api/sales/help-topics.
 * HV-S4  Empty list → "No guides yet".
 * HV-S5  Detail: <video controls playsinline preload="metadata">, never autoplay, + numbered steps.
 * HV-S6  Video fails to load → one SILENT refresh (fresh token, e.g. expired after a long pause); a second failure
 *        shows the explanation + Retry, and the steps STILL show throughout.
 * HV-S6b Retry in the error box re-fetches the guide (fresh token) and shows the player again.
 * HV-S7  Guide without a video → steps only (no <video>).
 * HV-S8  API 404 (flag OFF / not visible) → "not available", no crash.
 * HV-S9  List labels: video guide → play icon + "Video · 3 steps"; steps-only → list icon + "3 steps" (no bare number).
 * HV-S10 Player sizing: portrait by default (before metadata); a 780×1688 recording stays portrait (fills the width,
 *        height ≤ 75vh, object-fit contain); a 1280×720 recording switches to landscape. Native controls (incl.
 *        full screen) are kept.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { SalesFeaturesContext } from '@/lib/sales-features-context';
import { normalizeFeatures } from '@/lib/tenant-features';
import { __resetSessionCacheForTests } from '@/lib/session-cache';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('@/components/pwa/PwaAppSettings', () => ({ default: () => null }));

import SalesProfilePage from '../../profile/page';
import SalesHelpPage from '../page';
import SalesHelpTopicPage from '../[id]/page';
import { guideMetaLabel, playerStyle, DEFAULT_VIDEO_RATIO } from '@/components/help/help-topics';

function json(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return Promise.resolve({ ok: status >= 200 && status < 300, status, statusText: '', json: () => Promise.resolve(body), text: () => Promise.resolve(text) });
}

const ME = { success: true, data: { user: { name: 'Ravi SO', phone: '9000000001', role: 'SALES_SO', salesUser: { employeeCode: 'E1' } } } };

function stubProfileFetch() {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/auth/me')) return json(ME);
    if (url.includes('/api/sales/outlets')) return json({ success: true, data: { outlets: [] } });
    return json({ success: false, error: 'unexpected' }, 500);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const TOPIC_VIDEO = {
  id: 'kyc-upi',
  title: 'Complete a KYC (UPI)',
  description: 'Register an outlet with a UPI ID',
  steps: ['Open KYC and tap New KYC', 'Enter the outlet details', 'Enter the UPI ID and submit'],
  videoUrl: '/api/help/media?token=abc',
  posterUrl: '/api/help/media?token=poster',
};
const TOPIC_STEPS_ONLY = { ...TOPIC_VIDEO, id: 'steps-only', title: 'Raise a support ticket', videoUrl: null, posterUrl: null };

afterEach(() => { vi.unstubAllGlobals(); });

describe('HV-S — sales Profile entry', () => {
  it('HV-S1: flag ON → "Help & videos" entry links to /sales/help', async () => {
    stubProfileFetch();
    render(
      <SalesFeaturesContext.Provider value={normalizeFeatures({ helpVideos: true })}>
        <SalesProfilePage />
      </SalesFeaturesContext.Provider>,
    );
    const entry = await screen.findByTestId('profile-help-videos', {}, { timeout: 15_000 });
    expect(entry.getAttribute('href')).toBe('/sales/help');
    expect(entry.textContent).toContain('Help & videos');
  });

  it('HV-S2: flag OFF (Deoleo), or features not loaded → no entry and no extra request', async () => {
    for (const value of [normalizeFeatures({}), null]) {
      // Each iteration is a fresh session: /api/auth/me is session-cached (lib/cached-reads.ts).
      __resetSessionCacheForTests();
      const fetchMock = stubProfileFetch();
      const { unmount } = render(
        <SalesFeaturesContext.Provider value={value}>
          <SalesProfilePage />
        </SalesFeaturesContext.Provider>,
      );
      expect(await screen.findByText('Ravi SO', {}, { timeout: 15_000 })).toBeInTheDocument();
      expect(screen.queryByTestId('profile-help-videos')).toBeNull();
      expect(screen.queryByText(/Help & videos/)).toBeNull();
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.sort()).toEqual(['/api/auth/me', '/api/sales/outlets']);
      expect(urls.some((u) => u.includes('help'))).toBe(false);
      unmount();
      vi.unstubAllGlobals();
    }
  });
});

describe('HV-S — list + detail', () => {
  it('HV-S3: list renders the guides from /api/sales/help-topics', async () => {
    const fetchMock = vi.fn().mockImplementation(() => json({ success: true, data: { topics: [TOPIC_VIDEO, TOPIC_STEPS_ONLY] } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<SalesHelpPage />);
    const items = await screen.findAllByTestId('help-list-item', {}, { timeout: 15_000 });
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute('href')).toBe('/sales/help/kyc-upi');
    expect(screen.getByText('Complete a KYC (UPI)')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/sales/help-topics');
  });

  it('HV-S4: empty → "No guides yet"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => json({ success: true, data: { topics: [] } })));
    render(<SalesHelpPage />);
    expect(await screen.findByTestId('help-empty', {}, { timeout: 15_000 })).toHaveTextContent('No guides yet');
  });

  it('HV-S5: detail → video (controls, playsinline, preload=metadata, NO autoplay) + numbered steps', async () => {
    const fetchMock = vi.fn().mockImplementation(() => json({ success: true, data: TOPIC_VIDEO }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { render(<SalesHelpTopicPage params={Promise.resolve({ id: 'kyc-upi' })} />); });
    const video = (await screen.findByTestId('help-video', {}, { timeout: 15_000 })) as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('/api/help/media?token=abc');
    expect(video.getAttribute('poster')).toBe('/api/help/media?token=poster');
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.autoplay).toBe(false);
    const steps = screen.getByTestId('help-steps').querySelectorAll('li');
    expect(steps).toHaveLength(3);
    expect(steps[0].textContent).toBe('1Open KYC and tap New KYC');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/sales/help-topics/kyc-upi');
  });

  it('HV-S6: first video error → silent refresh with a FRESH token; second error → message + steps still shown', async () => {
    let n = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      n += 1;
      return json({ success: true, data: { ...TOPIC_VIDEO, videoUrl: `/api/help/media?token=t${n}` } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { render(<SalesHelpTopicPage params={Promise.resolve({ id: 'kyc-upi' })} />); });
    const first = await screen.findByTestId('help-video', {}, { timeout: 15_000 });
    expect(first.getAttribute('src')).toBe('/api/help/media?token=t1');
    fireEvent.error(first);
    // silent refresh: same page, new token, no error box, steps never disappear
    await waitFor(() => expect(screen.getByTestId('help-video').getAttribute('src')).toBe('/api/help/media?token=t2'));
    expect(screen.queryByTestId('help-video-error')).toBeNull();
    expect(screen.getByTestId('help-steps').querySelectorAll('li')).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // a second failure right away → the error box (no silent loop)
    fireEvent.error(screen.getByTestId('help-video'));
    await waitFor(() => expect(screen.queryByTestId('help-video')).toBeNull());
    expect(screen.getByTestId('help-video-error')).toHaveTextContent(/could not be loaded/i);
    expect(screen.getByTestId('help-steps').querySelectorAll('li')).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('HV-S6b: Retry re-fetches the guide (fresh token) and shows the player again', async () => {
    let n = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      n += 1;
      return json({ success: true, data: { ...TOPIC_VIDEO, videoUrl: `/api/help/media?token=t${n}` } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { render(<SalesHelpTopicPage params={Promise.resolve({ id: 'kyc-upi' })} />); });
    fireEvent.error(await screen.findByTestId('help-video', {}, { timeout: 15_000 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('help-video').getAttribute('src')).toBe('/api/help/media?token=t2'));
    fireEvent.error(screen.getByTestId('help-video'));
    fireEvent.click(await screen.findByTestId('help-video-retry'));
    await waitFor(() => expect(screen.getByTestId('help-video').getAttribute('src')).toBe('/api/help/media?token=t3'));
    expect(screen.queryByTestId('help-video-error')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toBe('/api/sales/help-topics/kyc-upi');
  });

  it('HV-S7: no video → steps only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => json({ success: true, data: TOPIC_STEPS_ONLY })));
    await act(async () => { render(<SalesHelpTopicPage params={Promise.resolve({ id: 'steps-only' })} />); });
    expect(await screen.findByTestId('help-steps', {}, { timeout: 15_000 })).toBeInTheDocument();
    expect(screen.queryByTestId('help-video')).toBeNull();
    expect(screen.queryByTestId('help-video-error')).toBeNull();
  });

  it('HV-S8: 404 (flag OFF / not visible) → "not available"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => json({ success: false, error: 'Help & videos is not available.' }, 404)));
    render(<SalesHelpPage />);
    expect(await screen.findByTestId('help-unavailable', {}, { timeout: 15_000 })).toBeInTheDocument();
  });

  it('HV-S9: list labels — "Video · N steps" with a play icon; steps-only "N steps" with a list icon', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => json({ success: true, data: { topics: [TOPIC_VIDEO, TOPIC_STEPS_ONLY] } })));
    render(<SalesHelpPage />);
    const items = await screen.findAllByTestId('help-list-item', {}, { timeout: 15_000 });
    expect(items[0].querySelector('[data-testid="help-list-meta"]')?.textContent).toBe('Video · 3 steps');
    expect(items[0].querySelector('[data-testid="help-list-icon-video"]')).not.toBeNull();
    expect(items[1].querySelector('[data-testid="help-list-meta"]')?.textContent).toBe('3 steps');
    expect(items[1].querySelector('[data-testid="help-list-icon-steps"]')).not.toBeNull();
    // the old bare count badge is gone: the icon box holds no text
    expect(items[1].firstElementChild?.textContent).toBe('');
    expect(guideMetaLabel({ videoUrl: null, steps: ['one'] })).toBe('1 step');
    expect(guideMetaLabel({ videoUrl: 'u', steps: ['a', 'b', 'c', 'd', 'e'] })).toBe('Video · 5 steps');
  });

  it('HV-S10: portrait by default; 780×1688 stays portrait; 1280×720 becomes landscape; controls kept', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => json({ success: true, data: TOPIC_VIDEO })));
    await act(async () => { render(<SalesHelpTopicPage params={Promise.resolve({ id: 'kyc-upi' })} />); });
    const video = (await screen.findByTestId('help-video', {}, { timeout: 15_000 })) as HTMLVideoElement;
    expect(video.getAttribute('data-orientation')).toBe('portrait'); // before metadata
    expect(video.hasAttribute('controls')).toBe(true);
    expect(video.getAttribute('controlslist')).toBeNull(); // full screen not disabled

    const setDims = (w: number, h: number) => {
      Object.defineProperty(video, 'videoWidth', { configurable: true, value: w });
      Object.defineProperty(video, 'videoHeight', { configurable: true, value: h });
      fireEvent.loadedMetadata(video);
    };
    setDims(780, 1688);
    await waitFor(() => expect(video.getAttribute('data-orientation')).toBe('portrait'));
    setDims(1280, 720);
    await waitFor(() => expect(video.getAttribute('data-orientation')).toBe('landscape'));
    // a broken/zero size never changes the box
    setDims(0, 0);
    expect(video.getAttribute('data-orientation')).toBe('landscape');
  });

  it('HV-S10b: playerStyle — full width, aspect from the video, height capped at 75vh, contain (never crop)', () => {
    expect(playerStyle(780 / 1688)).toEqual({ width: '100%', aspectRatio: String(780 / 1688), maxHeight: '75vh', objectFit: 'contain' });
    expect(playerStyle(16 / 9)).toMatchObject({ width: '100%', aspectRatio: String(16 / 9), maxHeight: '75vh', objectFit: 'contain' });
    expect(DEFAULT_VIDEO_RATIO).toBeLessThan(1); // portrait default
    expect(playerStyle(Number.NaN).aspectRatio).toBe(String(DEFAULT_VIDEO_RATIO));
    expect(playerStyle(0).aspectRatio).toBe(String(DEFAULT_VIDEO_RATIO));
  });
});
