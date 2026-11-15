/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/status — WP5 payout reversal entry picker (Wallet Reversal Engine §8, Q9/Q10).
 *  - LEGACY engine (default, Deoleo): the Request Reversal modal is exactly the amount form it was.
 *  - SHADOW/V2: the modal lists the outlet+field's payout entries, preselects every available one, shows the
 *    blocked ones with the reason, and submits the selected ids with requestedPaise = Σ selected.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/credits-payouts/status',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>();
  return { ...actual, useAdminSession: vi.fn() };
});

import { useAdminSession } from '@/lib/admin-session';
import PayoutStatusPage from '../page';

const batch = {
  id: 'b1',
  batchCode: 'CB-2026-10-001',
  period: '2026-10',
  status: 'CONFIRMED',
  uploadedBy: 'ops',
  uploadedAt: '2026-10-01T00:00:00.000Z',
  totalOutlets: 1,
  totalPoints: 0,
  totalPayoutPaise: 80000,
};
const row = {
  rowNum: 1, outletId: 'O1', outletName: 'Outlet One', fieldId: 'f1', fieldName: 'Volume',
  amount: 80000, narration: '', awardType: 'PAYOUT', status: 'OK', errors: [],
};

const ok = (payload: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => payload });

function mockApi(mode: 'LEGACY' | 'V2') {
  const posts: Array<Record<string, unknown>> = [];
  const entryCalls: string[] = [];
  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/attachments')) return ok({ success: true, data: { attachments: [] } });
    if (url.startsWith('/api/admin/credits/batches?')) {
      return ok({ success: true, data: { batches: [batch], pagination: { page: 1, limit: 50, total: 1, pages: 1 } } });
    }
    if (url.includes('/payout-reversal-entries')) {
      entryCalls.push(url);
      return ok({
        success: true,
        data:
          mode === 'LEGACY'
            ? { mode, entries: [] }
            : {
                mode,
                entries: [
                  { id: 'pe-a', amountPaise: 30000, status: 'PAID', period: '2026-10', createdAt: '', selectable: true, blockedBy: null },
                  { id: 'pe-b', amountPaise: 50000, status: 'PENDING', period: '2026-10', createdAt: '', selectable: true, blockedBy: null },
                  { id: 'pe-x', amountPaise: 10000, status: 'REVERSED', period: '2026-10', createdAt: '', selectable: false, blockedBy: 'REVERSED' },
                ],
              },
      });
    }
    if (url.endsWith('/reversals') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return ok({ success: true, data: { id: 'r1' } });
    }
    if (/\/api\/admin\/credits\/batches\/b1$/.test(url)) return ok({ success: true, data: { ...batch, rows: [row] } });
    return ok({ success: true, data: null });
  }) as unknown as typeof fetch;
  return { posts, entryCalls };
}

async function openModal() {
  render(<PayoutStatusPage />);
  fireEvent.click(await screen.findByTestId('batch-header-b1'));
  fireEvent.click(await screen.findByRole('button', { name: /Reverse/ }));
  await screen.findByText('Request Reversal');
}

describe('Payout status — payout reversal entry picker (WP5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'CLIENT_ADMIN', clientId: 'bajaj', name: 'Test Admin', userId: '', canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
  });

  it('LEGACY: keeps the amount form and the original request body', async () => {
    const api = mockApi('LEGACY');
    await openModal();
    await waitFor(() => expect(api.entryCalls).toHaveLength(1));
    expect(api.entryCalls[0]).toContain('outletId=O1');
    expect(screen.queryByTestId('payout-entry-picker')).toBeNull();
    expect(screen.getByText('Reversal Amount (₹)')).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Reversal Request' }));
    await screen.findByText(/awaiting Gifsy approval/);
    expect(api.posts).toEqual([
      {
        outletId: 'O1', outletName: 'Outlet One', fieldId: 'f1', fieldName: 'Volume', awardType: 'PAYOUT',
        originalPaise: 80000, requestedPaise: 50000,
      },
    ]);
  });

  it('V2: lists entries (available preselected, blocked disabled with reason) and submits the selected ids + their sum', async () => {
    const api = mockApi('V2');
    await openModal();
    await screen.findByTestId('payout-entry-picker');
    expect(screen.queryByText('Reversal Amount (₹)')).toBeNull();
    const a = screen.getByLabelText('Payout entry ₹300 (PAID)') as HTMLInputElement;
    const b = screen.getByLabelText('Payout entry ₹500 (PENDING)') as HTMLInputElement;
    const x = screen.getByLabelText('Payout entry ₹100 (REVERSED)') as HTMLInputElement;
    expect([a.checked, b.checked, x.checked, x.disabled]).toEqual([true, true, false, true]);
    expect(screen.getByText('Already reversed')).toBeTruthy();
    expect(screen.getByText(/becomes a receivable/)).toBeTruthy();
    expect(screen.getByText(/Reversal amount:/).textContent).toMatch(/₹800 \(2 of 2 available/);

    fireEvent.click(a); // deselect the paid entry — the exact-subset case (T-pay2)
    expect(screen.getByText(/Reversal amount:/).textContent).toMatch(/₹500 \(1 of 2 available/);
    fireEvent.click(screen.getByRole('button', { name: 'Submit Reversal Request' }));
    await screen.findByText(/held out of bank files until Gifsy approves or rejects/);
    expect(api.posts).toEqual([
      {
        outletId: 'O1', outletName: 'Outlet One', fieldId: 'f1', fieldName: 'Volume', awardType: 'PAYOUT',
        originalPaise: 80000, requestedPaise: 50000, payoutEntryIds: ['pe-b'],
      },
    ]);
  });

  it('V2: submitting needs at least one entry', async () => {
    mockApi('V2');
    await openModal();
    await screen.findByTestId('payout-entry-picker');
    fireEvent.click(screen.getByLabelText('Payout entry ₹300 (PAID)'));
    fireEvent.click(screen.getByLabelText('Payout entry ₹500 (PENDING)'));
    expect((screen.getByRole('button', { name: 'Submit Reversal Request' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
