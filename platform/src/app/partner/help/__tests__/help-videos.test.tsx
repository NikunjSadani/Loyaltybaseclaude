/// <reference types="vitest/globals" />
/**
 * HV-P — Help & videos in the PARTNER app (tenant flag `helpVideos`, Bajaj ON / Deoleo OFF).
 *
 * HV-P1  Profile shows the "Help & videos" link only when identity.features.helpVideos is ON (identity
 *        the page already loads — no extra request).
 * HV-P2  Flag OFF / features absent → no link, and the page requests only /api/auth/me.
 * HV-P3  List renders guides from /api/partner/help-topics; links to /partner/help/:id.
 * HV-P4  Empty → "No guides yet".
 * HV-P5  Detail → video (no autoplay) + steps; video error → steps still shown.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('@/components/pwa/PwaAppSettings', () => ({ default: () => null }));
const identityRef: { current: Record<string, unknown> } = { current: {} };
vi.mock('@/lib/partner-identity', () => ({ usePartnerIdentity: () => identityRef.current }));

import ProfilePage from '../../profile/page';
import PartnerHelpPage from '../page';
import PartnerHelpTopicPage from '../[id]/page';

function json(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return Promise.resolve({ ok: status >= 200 && status < 300, status, statusText: '', json: () => Promise.resolve(body), text: () => Promise.resolve(text) });
}

const ME = { success: true, data: { user: { name: 'Anil', phone: '9900000041', channelPartner: { businessName: 'Anil Traders', partnerCode: 'P1' } } } };

function setIdentity(features: Record<string, unknown> | undefined) {
  identityRef.current = {
    businessName: 'Anil Traders', ownerName: 'Anil', partnerCode: 'P1', outletType: 'RETAILER',
    hasPointsActivity: false, hasPayoutActivity: false, features,
  };
}

const TOPIC = {
  id: 'wallet',
  title: 'Your wallet',
  description: null,
  steps: ['Open Wallet', 'See your balance', 'Tap a row for details'],
  videoUrl: '/api/help/media?token=v',
  posterUrl: null,
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('HV-P — partner Profile entry', () => {
  it('HV-P1: flag ON → "Help & videos" link to /partner/help', async () => {
    setIdentity({ helpVideos: true });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => json(ME)));
    render(<ProfilePage />);
    const link = await screen.findByText('Help & videos', {}, { timeout: 15_000 });
    expect(link.closest('a')?.getAttribute('href')).toBe('/partner/help');
  });

  it('HV-P2: flag OFF (Deoleo) or features absent → no link; only /api/auth/me requested', async () => {
    for (const features of [{ helpVideos: false }, undefined]) {
      setIdentity(features);
      const fetchMock = vi.fn().mockImplementation(() => json(ME));
      vi.stubGlobal('fetch', fetchMock);
      const { unmount } = render(<ProfilePage />);
      expect(await screen.findByText('Terms & Conditions', {}, { timeout: 15_000 })).toBeInTheDocument();
      expect(screen.queryByText('Help & videos')).toBeNull();
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/auth/me']);
      unmount();
      vi.unstubAllGlobals();
    }
  });
});

describe('HV-P — list + detail', () => {
  it('HV-P3: list from /api/partner/help-topics', async () => {
    const fetchMock = vi.fn().mockImplementation(() => json({ success: true, data: { topics: [TOPIC] } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<PartnerHelpPage />);
    const items = await screen.findAllByTestId('help-list-item', {}, { timeout: 15_000 });
    expect(items[0].getAttribute('href')).toBe('/partner/help/wallet');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/partner/help-topics');
  });

  it('HV-P4: empty → "No guides yet"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => json({ success: true, data: { topics: [] } })));
    render(<PartnerHelpPage />);
    expect(await screen.findByTestId('help-empty', {}, { timeout: 15_000 })).toHaveTextContent('No guides yet');
  });

  it('HV-P5: detail → video without autoplay + steps; a video error keeps the steps', async () => {
    const fetchMock = vi.fn().mockImplementation(() => json({ success: true, data: TOPIC }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { render(<PartnerHelpTopicPage params={Promise.resolve({ id: 'wallet' })} />); });
    const video = (await screen.findByTestId('help-video', {}, { timeout: 15_000 })) as HTMLVideoElement;
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/partner/help-topics/wallet');
    fireEvent.error(video); // 1st error → silent token refresh
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.error(await screen.findByTestId('help-video')); // 2nd → error box
    await waitFor(() => expect(screen.getByTestId('help-video-error')).toBeInTheDocument());
    expect(screen.getByTestId('help-video-retry')).toBeInTheDocument();
    expect(screen.getByTestId('help-steps').querySelectorAll('li')).toHaveLength(3);
  });
});
