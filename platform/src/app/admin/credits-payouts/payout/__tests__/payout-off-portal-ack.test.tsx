/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/payout — double-payment guard (owner 2026-11-26): a bank file whose payouts match a recorded
 * off-portal payment is refused with the list; the admin ticks the acknowledgement and downloads again with exactly
 * those entry ids. Nothing is downloaded on the refusal.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const MATCH = {
  entryId: 'e1', outletId: 'O1', outletName: 'Sharma Stores', amountPaise: '250000', period: '2026-05',
  offPortal: [{ id: 'op1', paymentDate: '2026-05-20T00:00:00.000Z', utr: 'CASH1', period: '2026-05' }],
};

describe('Generate payout file — off-portal matches need an acknowledgement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAdminSession).mockReturnValue({ role: 'GIFSY_ADMIN', clientId: 'gifsy', name: 'Op', userId: '', canManageSchemes: true } as ReturnType<typeof useAdminSession>);
  });

  it('refusal lists the matches; ticking + "Download with these acknowledged" re-posts with the entry ids', async () => {
    const posts: unknown[] = [];
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/admin/credits/payout-downloads') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        if (!body.acknowledgedOffPortalMatches) {
          return Promise.resolve({ ok: false, status: 409, json: async () => ({ success: false, error: 'Nothing was downloaded — 1 payout in this file match an off-portal payment', details: { offPortalMatches: [MATCH] } }) });
        }
        return Promise.resolve({ ok: true, headers: new Headers({}), blob: async () => new Blob(['x']) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: url.includes('/reversals') ? { reversals: [], pagination: null } : [] }) });
    }) as unknown as typeof fetch;

    render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByText('Generate & Download'));
    const box = await screen.findByTestId('off-portal-matches');
    expect(box.textContent).toMatch(/Sharma Stores \(O1\)/);
    expect(box.textContent).toMatch(/UTR CASH1/);
    expect(vi.mocked(downloadBlob)).not.toHaveBeenCalled();
    const again = screen.getByRole('button', { name: 'Download with these acknowledged' });
    expect(again).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /they were NOT paid off-portal/ }));
    fireEvent.click(again);
    await waitFor(() => expect(vi.mocked(downloadBlob)).toHaveBeenCalledTimes(1));
    expect(posts[1]).toMatchObject({ acknowledgedOffPortalMatches: ['e1'] });
  });
});
