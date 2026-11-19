/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/payout — the plain-words outcome of a POINTS reversal (owner decision 2026-11-19): the approve
 * result shows the server's `pointsOutcome` headline ("… · 2,986 recorded as debt, repaid from future earnings" on V2;
 * "… not recovered — already spent, written off" on LEGACY), and the Reversal Report shows each approved POINTS
 * reversal's summary. A response without `pointsOutcome` (older API) shows no panel.
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

let patchData: unknown = null;

const base = {
  outletId: 'O1', outletName: 'Outlet One', fieldName: 'Volume', period: '2026-10', awardType: 'POINTS',
  originalPaise: 10000, requestedAt: '2026-11-15T00:00:00.000Z',
};

const V2_OUTCOME = {
  reversed: 10000, recovered: 7014, debtRestored: 0, owed: 2986, shortfall: 0, alreadyExpired: 0, belowZero: 2986, taken: 7014,
  headline: 'Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings',
  summary: '10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings',
  lines: ['7,014 taken from the wallet', '2,986 recorded as debt, repaid from future earnings'],
};

describe('Payout page — POINTS reversal outcome summary', () => {
  beforeEach(() => {
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'GIFSY_ADMIN', clientId: 'gifsy', name: 'Test Admin', userId: '', canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
    const json = (payload: unknown) => Promise.resolve({ ok: true, json: async () => payload, blob: async () => new Blob() });
    patchData = null;
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/reversals/') && init?.method === 'PATCH') return json({ success: true, data: patchData });
      if (url.includes('/reversals') && url.includes('PENDING_GIFSY')) {
        return json({
          success: true,
          data: {
            reversals: [{ ...base, id: 'r-pts', requestedPaise: 10000, status: 'PENDING_GIFSY' }],
            pagination: { page: 1, limit: 50, total: 1, pages: 1 },
          },
        });
      }
      if (url.includes('/reversals') && url.includes('APPROVED')) {
        return json({
          success: true,
          data: {
            reversals: [
              { ...base, id: 'r-done-v2', requestedPaise: 10000, approvedPaise: 10000, shortfallPaise: 0, status: 'APPROVED', approvedAt: '2026-11-19T00:00:00.000Z', pointsOutcome: V2_OUTCOME },
              {
                ...base, id: 'r-done-legacy', outletName: 'Outlet Two', requestedPaise: 500, approvedPaise: 500, shortfallPaise: 400, status: 'APPROVED', approvedAt: '2026-11-19T00:00:00.000Z',
                pointsOutcome: {
                  reversed: 500, recovered: 100, debtRestored: 0, owed: 0, shortfall: 400,
                  headline: 'Approved · 500 pts reversed · 100 taken from the wallet · 400 not recovered — already redeemed or expired, written off',
                  summary: '500 pts reversed · 100 taken from the wallet · 400 not recovered — already redeemed or expired, written off',
                  lines: ['100 taken from the wallet', '400 not recovered — already redeemed or expired, written off'],
                },
              },
              { ...base, id: 'r-done-old', outletName: 'Outlet Three', requestedPaise: 50, approvedPaise: 50, shortfallPaise: 0, status: 'APPROVED', approvedAt: '2026-11-19T00:00:00.000Z' },
            ],
            pagination: { page: 1, limit: 50, total: 3, pages: 1 },
          },
        });
      }
      if (url.includes('/reversals')) return json({ success: true, data: { reversals: [], pagination: null } });
      return json({ success: true, data: [] });
    }) as unknown as typeof fetch;
  });

  it('approve (V2 over-reversal): shows "recorded as debt, repaid from future earnings" — never "written off"', async () => {
    patchData = { id: 'r-pts', status: 'APPROVED', clawbackShortfall: 0, pointsOutcome: V2_OUTCOME };
    render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Approve$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Approve' }));
    const out = await screen.findByTestId('reversal-outcome');
    expect(out.textContent).toContain(
      'Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings — Outlet One / Volume',
    );
    expect(out.textContent).toContain('2,986 recorded as debt, repaid from future earnings');
    expect(out.textContent).not.toMatch(/written off/);
  });

  it('approve with an older API response (no pointsOutcome) shows no outcome panel', async () => {
    patchData = { id: 'r-pts', status: 'APPROVED', clawbackShortfall: 0 };
    render(<PayoutDownloadPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Approve$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Approve' }));
    await vi.waitFor(() =>
      expect(vi.mocked(global.fetch).mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'PATCH')).toBe(true),
    );
    expect(screen.queryByTestId('reversal-outcome')).toBeNull();
  });

  it('Reversal Report: each approved POINTS reversal says what happened (debt on V2, write-off on LEGACY); none without a summary', async () => {
    render(<PayoutDownloadPage />);
    const v2 = await screen.findByTestId('points-outcome-r-done-v2');
    expect(v2.textContent).toBe(
      'Outcome: 10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings',
    );
    expect(screen.getByTestId('points-outcome-r-done-legacy').textContent).toBe(
      'Outcome: 500 pts reversed · 100 taken from the wallet · 400 not recovered — already redeemed or expired, written off',
    );
    expect(screen.queryByTestId('points-outcome-r-done-old')).toBeNull();
  });
});

describe('Reversal Report — audit item 3 (debt is never shown as reversed)', () => {
  beforeEach(() => {
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'GIFSY_ADMIN', clientId: 'gifsy', name: 'Test Admin', userId: '', canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
  });

  it('an Owed column appears when a reversal took a balance below zero: 10,000 supposed = 7,014 reversed + 2,986 owed + 0 pending', async () => {
    const json = (payload: unknown) => Promise.resolve({ ok: true, json: async () => payload, blob: async () => new Blob() });
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/reversals') && url.includes('APPROVED')) {
        return json({
          success: true,
          data: {
            reversals: [{ ...base, id: 'r-done-v2', requestedPaise: 10000, approvedPaise: 10000, shortfallPaise: 0, status: 'APPROVED', approvedAt: '2026-11-19T00:00:00.000Z', pointsOutcome: V2_OUTCOME }],
            pagination: { page: 1, limit: 50, total: 1, pages: 1 },
          },
        });
      }
      if (url.includes('/reversals')) return json({ success: true, data: { reversals: [], pagination: null } });
      return json({ success: true, data: [] });
    }) as unknown as typeof fetch;
    render(<PayoutDownloadPage />);
    const debt = await screen.findByTestId('processed-debt-r-done-v2');
    expect(debt.textContent).toBe('2,986 pts');
    const row = debt.closest('tr')!;
    expect(row.textContent).toContain('7,014 pts'); // reversed (green) = taken only
    expect(row.textContent).not.toMatch(/10,000 pts.*10,000 pts/); // never "Reversed 10,000"
    expect(screen.getByRole('columnheader', { name: 'Owed' })).toBeTruthy();
    expect(document.body.textContent).toMatch(/Owed = how far below zero the reversal took the outlet.s balance/);
    expect(screen.queryByRole('columnheader', { name: 'Already expired' })).toBeNull();
  });

  it('no reversal with debt (every LEGACY tenant): no Owed / Already-expired column — the report is unchanged', async () => {
    const json = (payload: unknown) => Promise.resolve({ ok: true, json: async () => payload, blob: async () => new Blob() });
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/reversals') && url.includes('APPROVED')) {
        return json({
          success: true,
          data: {
            reversals: [{
              ...base, id: 'r-done-legacy', requestedPaise: 500, approvedPaise: 500, shortfallPaise: 400, status: 'APPROVED',
              approvedAt: '2026-11-19T00:00:00.000Z',
              pointsOutcome: {
                reversed: 500, recovered: 100, debtRestored: 0, owed: 0, shortfall: 400,
                headline: 'Approved · 500 pts reversed · 100 taken from the wallet · 400 not recovered — already redeemed or expired, written off',
                summary: '500 pts reversed · 100 taken from the wallet · 400 not recovered — already redeemed or expired, written off',
                lines: [],
              },
            }],
            pagination: { page: 1, limit: 50, total: 1, pages: 1 },
          },
        });
      }
      if (url.includes('/reversals')) return json({ success: true, data: { reversals: [], pagination: null } });
      return json({ success: true, data: [] });
    }) as unknown as typeof fetch;
    render(<PayoutDownloadPage />);
    await screen.findByTestId('points-outcome-r-done-legacy');
    expect(screen.queryByRole('columnheader', { name: 'Owed' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Already expired' })).toBeNull();
  });
});

describe('Reversal Report — fix round 3 A5/B5 (expired points and debt restored are never shown as "Reversed")', () => {
  beforeEach(() => {
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'GIFSY_ADMIN', clientId: 'gifsy', name: 'Test Admin', userId: '', canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
  });

  it('10,000 supposed = 2,000 reversed + 3,000 already expired + 5,000 owed', async () => {
    const json = (payload: unknown) => Promise.resolve({ ok: true, json: async () => payload, blob: async () => new Blob() });
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/reversals') && url.includes('APPROVED')) {
        return json({
          success: true,
          data: {
            reversals: [{
              ...base, id: 'r-exp', requestedPaise: 10000, approvedPaise: 10000, shortfallPaise: 0, status: 'APPROVED',
              approvedAt: '2026-11-19T00:00:00.000Z',
              pointsOutcome: {
                reversed: 10000, recovered: 2000, debtRestored: 0, owed: 5000, alreadyExpired: 3000, belowZero: 5000, taken: 2000, shortfall: 0,
                headline: 'h', summary: '10,000 pts reversed · 2,000 taken from the wallet · 3,000 already expired — nothing to recover · 5,000 recorded as debt, repaid from future earnings', lines: [],
              },
            }],
            pagination: { page: 1, limit: 50, total: 1, pages: 1 },
          },
        });
      }
      if (url.includes('/reversals')) return json({ success: true, data: { reversals: [], pagination: null } });
      return json({ success: true, data: [] });
    }) as unknown as typeof fetch;
    render(<PayoutDownloadPage />);
    expect((await screen.findByTestId('processed-expired-r-exp')).textContent).toBe('3,000 pts');
    expect(screen.getByTestId('processed-debt-r-exp').textContent).toBe('5,000 pts');
    const row = screen.getByTestId('processed-debt-r-exp').closest('tr')!;
    expect(row.textContent).toContain('2,000 pts');
    expect(document.body.textContent).toMatch(/Already expired = points of that credit that had already expired/);
  });
});
