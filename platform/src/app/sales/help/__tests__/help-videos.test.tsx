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
 * HV-S6  Video fails to load → an explanation shows and the steps STILL show.
 * HV-S7  Guide without a video → steps only (no <video>).
 * HV-S8  API 404 (flag OFF / not visible) → "not available", no crash.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { SalesFeaturesContext } from '@/lib/sales-features-context';
import { normalizeFeatures } from '@/lib/tenant-features';

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

  it('HV-S6: video error → message + steps still shown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => json({ success: true, data: TOPIC_VIDEO })));
    await act(async () => { render(<SalesHelpTopicPage params={Promise.resolve({ id: 'kyc-upi' })} />); });
    const video = await screen.findByTestId('help-video', {}, { timeout: 15_000 });
    fireEvent.error(video);
    await waitFor(() => expect(screen.queryByTestId('help-video')).toBeNull());
    expect(screen.getByTestId('help-video-error')).toHaveTextContent(/could not be loaded/i);
    expect(screen.getByTestId('help-steps').querySelectorAll('li')).toHaveLength(3);
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
});
