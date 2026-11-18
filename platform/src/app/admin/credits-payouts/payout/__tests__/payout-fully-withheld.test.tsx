/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/payout — payouts FULLY WITHHELD as TDS (owner audit A-H2, 2026-11-18).
 *
 * Money path. An outlet whose whole payout was withheld as TDS is NOT in the bank file (no ₹0 line);
 * the API says so in the X-Fully-Withheld-* headers and the screen must show it loudly (amber),
 * never silently.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/credits-payouts/payout',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>();
  return { ...actual, useAdminSession: vi.fn() };
});
vi.mock('@/lib/download', () => ({ downloadBlob: vi.fn() }));

import { useAdminSession } from '@/lib/admin-session';
import { downloadBlob } from '@/lib/download';
import PayoutDownloadPage from '../page';

function mockFetch(headers: Record<string, string>, post?: () => Promise<unknown>) {
  const json = (payload: unknown) => Promise.resolve({ ok: true, json: async () => payload, blob: async () => new Blob() });
  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/admin/credits/payout-downloads') && init?.method === 'POST') {
      if (post) return post();
      return Promise.resolve({ ok: true, headers: new Headers(headers), blob: async () => new Blob(['x']) });
    }
    if (url.includes('/payout-downloads')) return json({ success: true, data: [] });
    if (url.includes('/reversals')) return json({ success: true, data: { reversals: [], pagination: null } });
    return json({ success: true, data: [] });
  }) as unknown as typeof fetch;
}

describe('Generate payout file — fully withheld payouts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'GIFSY_ADMIN', clientId: 'gifsy', name: 'Op', userId: '', canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
  });

  it('shows an amber notice naming the payouts not sent to the bank', async () => {
    const note = '2 payouts fully withheld as TDS — not sent to the bank (outlets O1, O7).';
    mockFetch({ 'X-Fully-Withheld-Count': '2', 'X-Fully-Withheld-Note': encodeURIComponent(note) });
    render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByText('Generate & Download'));
    const banner = await screen.findByTestId('fully-withheld-notice');
    expect(banner).toHaveTextContent(note);
    expect(banner.className).toMatch(/amber/);
  });

  it('shows nothing when no payout was fully withheld', async () => {
    mockFetch({ 'X-Fully-Withheld-Count': '0' });
    render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByText('Generate & Download'));
    await screen.findByText('Generate & Download');
    expect(screen.queryByTestId('fully-withheld-notice')).toBeNull();
  });
  it('shows an amber notice listing payouts HELD (KYC not approved) — never silent', async () => {
    const note = '2 payouts held — KYC not approved: O3 (Shop C), O9 (Shop K). They stay pending for the next file.';
    mockFetch({ 'X-Fully-Withheld-Count': '0', 'X-Held-Count': '2', 'X-Held-Note': encodeURIComponent(note) });
    render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByText('Generate & Download'));
    const banner = await screen.findByTestId('held-notice');
    expect(banner).toHaveTextContent(note);
    expect(banner.className).toMatch(/amber/);
  });
  it('B-L2: the file is saved even when a notice header is malformed (decode never breaks the download)', async () => {
    mockFetch({ 'X-Fully-Withheld-Count': '1', 'X-Fully-Withheld-Note': '%E0%A4%A' });
    render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByText('Generate & Download'));
    await screen.findByTestId('fully-withheld-notice');
    expect(vi.mocked(downloadBlob)).toHaveBeenCalledTimes(1);
  });

  it('A-L3: "no bank file" JSON answer → shows the reason, downloads nothing', async () => {
    mockFetch({}, () =>
      Promise.resolve({
        ok: true,
        headers: new Headers({ 'Content-Type': 'application/json', 'X-Fully-Withheld-Count': '2' }),
        json: async () => ({ success: true, data: { noBankFile: true, message: 'No bank file — every payout in this run was fully withheld as TDS (2 payouts).' } }),
        blob: async () => new Blob(['{}']),
      }),
    );
    render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByText('Generate & Download'));
    expect(await screen.findByTestId('no-bank-file-notice')).toHaveTextContent('No bank file — every payout in this run was fully withheld as TDS');
    expect(vi.mocked(downloadBlob)).not.toHaveBeenCalled();
  });

  it('B-L1: a cut connection says the outcome is UNKNOWN and to check Download History before retrying', async () => {
    mockFetch({}, () => Promise.reject(new TypeError('Failed to fetch')));
    render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByText('Generate & Download'));
    expect(await screen.findByText(/may or may not have been created.*Download History/)).toBeInTheDocument();
  });
});
