/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/payout — pending reversal cards show the payout entries an engine (SHADOW/V2) PAYOUT
 * reversal holds, with what approval will do to each (WP5 P4). A LEGACY reversal (no `payoutEntries`) renders
 * exactly as before — no held-entries block.
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
import PayoutDownloadPage from '../page';

let downloadHeaders: Record<string, string> = {};
let patchData: unknown = null;

const base = {
  outletId: 'O1', outletName: 'Outlet One', fieldName: 'Volume', period: '2026-10', awardType: 'PAYOUT',
  originalPaise: 80000, requestedAt: '2026-11-15T00:00:00.000Z', status: 'PENDING_GIFSY',
};

describe('Payout page — held payout entries on pending reversals (WP5)', () => {
  beforeEach(() => {
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'GIFSY_ADMIN', clientId: 'gifsy', name: 'Test Admin', userId: '', canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
    const json = (payload: unknown) => Promise.resolve({ ok: true, json: async () => payload, blob: async () => new Blob() });
    downloadHeaders = {};
    patchData = null;
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/admin/credits/payout-downloads' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          headers: new Headers(downloadHeaders),
          blob: async () => new Blob(),
          json: async () => ({}),
        });
      }
      if (url.includes('/reversals/') && init?.method === 'PATCH') return json({ success: true, data: patchData });
      if (url.includes('/reversals') && url.includes('PENDING_GIFSY')) {
        return json({
          success: true,
          data: {
            reversals: [
              { ...base, id: 'r-legacy', requestedPaise: 20000 },
              {
                ...base, id: 'r-v2', requestedPaise: 80000,
                payoutEntries: [
                  { payoutEntryId: 'pe-a', amountPaise: 30000, allocationState: 'RESERVED', entryStatus: 'PAID' },
                  { payoutEntryId: 'pe-b', amountPaise: 50000, allocationState: 'RESERVED', entryStatus: 'PROCESSING' },
                ],
              },
            ],
            pagination: { page: 1, limit: 50, total: 2, pages: 1 },
          },
        });
      }
      if (url.includes('/reversals')) return json({ success: true, data: { reversals: [], pagination: null } });
      return json({ success: true, data: [] });
    }) as unknown as typeof fetch;
  });

  it('lists the held entries + their approval outcome for the engine reversal only', async () => {
    render(<PayoutDownloadPage />);
    const held = await screen.findByTestId('held-entries-r-v2');
    expect(held.textContent).toMatch(/₹300 — already paid → recorded as a receivable/);
    expect(held.textContent).toMatch(/₹500 — with the bank now → approval refused until the UTR \/ failure is recorded/);
    expect(screen.queryByTestId('held-entries-r-legacy')).toBeNull();
  });

  it('download: says how many entries a pending reversal held out of the bank file (and nothing when none)', async () => {
    render(<PayoutDownloadPage />);
    await screen.findByTestId('held-entries-r-v2');
    fireEvent.click(screen.getByRole('button', { name: /Generate & Download/ }));
    await vi.waitFor(() => expect(vi.mocked(global.fetch).mock.calls.some(([u]) => String(u) === '/api/admin/credits/payout-downloads')).toBe(true));
    expect(screen.queryByTestId('reversal-held-notice')).toBeNull();

    downloadHeaders = { 'X-Reversal-Held-Count': '2', 'X-Reversal-Held-Paise': '80000' };
    fireEvent.click(await screen.findByRole('button', { name: /Generate & Download/ }));
    const notice = await screen.findByTestId('reversal-held-notice');
    expect(notice.textContent).toMatch(/2 payout entries \(₹800\) were held out of this bank file because a reversal request is pending/);
  });

  it('approve: shows what happened to every entry (cancelled / receivable / TDS)', async () => {
    patchData = {
      id: 'r-v2', status: 'APPROVED', clawbackShortfall: 30000,
      payoutOutcome: {
        cancelled: [{ entryId: 'pe-b', amountPaise: 50000, wasStatus: 'FAILED', tdsOffsetPaise: 1000, tdsNote: 'withheld TDS ₹10.00 offset in the TDS ledger' }],
        receivable: [{ entryId: 'pe-a', amountPaise: 30000, tdsNote: 'no TDS withheld' }],
        receivablePaise: 30000,
        released: [],
      },
    };
    render(<PayoutDownloadPage />);
    await screen.findByTestId('held-entries-r-v2');
    fireEvent.click(screen.getAllByRole('button', { name: /^Approve$/ })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Approve' }));
    const out = await screen.findByTestId('reversal-outcome');
    expect(out.textContent).toMatch(/Reversal approved — Outlet One \/ Volume/);
    expect(out.textContent).toMatch(/₹500 entry \(bank payment had failed\) cancelled — withheld TDS ₹10\.00 offset/);
    expect(out.textContent).toMatch(/₹300 entry was already PAID — recorded as a receivable/);
    expect(out.textContent).toMatch(/Total receivable ₹300/);
  });

  it('approve of a LEGACY reversal shows no outcome panel (unchanged)', async () => {
    patchData = { id: 'r-legacy', status: 'APPROVED', clawbackShortfall: 0, payoutClawbackNote: null };
    render(<PayoutDownloadPage />);
    await screen.findByTestId('held-entries-r-v2');
    fireEvent.click(screen.getAllByRole('button', { name: /^Approve$/ })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Approve' }));
    await vi.waitFor(() => expect(vi.mocked(global.fetch).mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'PATCH')).toBe(true));
    expect(screen.queryByTestId('reversal-outcome')).toBeNull();
  });
});
