/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/status — Wallet Reversal Engine fix round B:
 *  - D5: the typed remarks (trimmed) are sent on BOTH create paths (LEGACY amount form + V2 entry picker); blank → omitted.
 *  - the attention banner is mounted only when the engine mode is known and not LEGACY.
 *  - #4 "Loading payout entries…" + Submit disabled until the lookup answers; #5 failed lookup → Retry.
 *  - #6 a failed V2 submit keeps the form, reloads the entries and drops ticks that are no longer selectable.
 *  - #20 dialog semantics: role=dialog, Escape closes, focus returns to the Reverse button.
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
  id: 'b1', batchCode: 'CB-2026-10-001', period: '2026-10', status: 'CONFIRMED', uploadedBy: 'ops',
  uploadedAt: '2026-10-01T00:00:00.000Z', totalOutlets: 1, totalPoints: 0, totalPayoutPaise: 80000,
};
const row = {
  rowNum: 1, outletId: 'O1', outletName: 'Outlet One', fieldId: 'f1', fieldName: 'Volume',
  amount: 80000, narration: '', awardType: 'PAYOUT', status: 'OK', errors: [],
};

type Entry = { id: string; amountPaise: number; status: string; period: string; createdAt: string; selectable: boolean; blockedBy: string | null };
const entry = (id: string, amountPaise: number, status: string, selectable = true, blockedBy: string | null = null): Entry =>
  ({ id, amountPaise, status, period: '2026-10', createdAt: '', selectable, blockedBy });

const ok = (payload: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => payload });

interface ApiOpts {
  engineMode?: string | null;
  /** Sequence of responses for the entries lookup ('fail' = network error); the last one repeats. */
  entries?: Array<{ mode: string; entries: Entry[] } | 'fail' | 'pending'>;
  postFail?: boolean;
}

function mockApi(opts: ApiOpts) {
  const posts: Array<Record<string, unknown>> = [];
  const entryCalls: string[] = [];
  const attentionCalls: string[] = [];
  let release: (() => void) | null = null;
  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/reversal-engine/attention')) {
      attentionCalls.push(url);
      if (opts.engineMode === null) return Promise.reject(new TypeError('Failed to fetch'));
      return ok({
        success: true,
        data: {
          mode: opts.engineMode ?? 'LEGACY', modeError: null,
          pause: { paused: true, since: null, by: null, reason: null },
          wallets: [], walletsTotal: 0, unmappedCredits: [], unmappedTotal: 0, owedClawbacks: [], owedTotal: 0,
        },
      });
    }
    if (url.includes('/attachments')) return ok({ success: true, data: { attachments: [] } });
    if (url.startsWith('/api/admin/credits/batches?')) {
      return ok({ success: true, data: { batches: [batch], pagination: { page: 1, limit: 50, total: 1, pages: 1 } } });
    }
    if (url.includes('/payout-reversal-entries')) {
      const seq = opts.entries ?? [{ mode: 'LEGACY', entries: [] }];
      const r = seq[Math.min(entryCalls.length, seq.length - 1)];
      entryCalls.push(url);
      if (r === 'fail') return Promise.reject(new TypeError('Failed to fetch'));
      if (r === 'pending') return new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { mode: 'LEGACY', entries: [] } }) }); });
      return ok({ success: true, data: r });
    }
    if (url.endsWith('/reversals') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (opts.postFail) {
        return Promise.resolve({ ok: false, status: 409, json: async () => ({ success: false, error: 'Payout entry pe-b is held by another pending reversal' }) });
      }
      return ok({ success: true, data: { id: 'r1' } });
    }
    if (/\/api\/admin\/credits\/batches\/b1$/.test(url)) return ok({ success: true, data: { ...batch, rows: [row] } });
    return ok({ success: true, data: null });
  }) as unknown as typeof fetch;
  return { posts, entryCalls, attentionCalls, release: () => release?.() };
}

async function openModal() {
  render(<PayoutStatusPage />);
  fireEvent.click(await screen.findByTestId('batch-header-b1'));
  const reverse = await screen.findByRole('button', { name: /Reverse/ });
  fireEvent.click(reverse);
  await screen.findByRole('dialog');
  return reverse;
}

const submitBtn = () => screen.getByRole('button', { name: /Submit Reversal Request|Submitting…/ }) as HTMLButtonElement;

describe('Payout status — reversal fix round B', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'CLIENT_ADMIN', clientId: 'bajaj', name: 'Test Admin', userId: '', canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
  });

  it('banner: not mounted for a LEGACY tenant (screen as before)', async () => {
    const api = mockApi({ engineMode: 'LEGACY' });
    render(<PayoutStatusPage />);
    await screen.findByTestId('batch-header-b1');
    await waitFor(() => expect(api.attentionCalls.length).toBeGreaterThan(0));
    expect(screen.queryByLabelText('Points reversal call-outs')).toBeNull();
    expect(screen.queryByText(/Points reversal approvals are paused/)).toBeNull();
  });

  it('banner: not mounted when the mode cannot be read', async () => {
    const api = mockApi({ engineMode: null });
    render(<PayoutStatusPage />);
    await screen.findByTestId('batch-header-b1');
    await waitFor(() => expect(api.attentionCalls.length).toBeGreaterThan(0));
    expect(screen.queryByText(/Points reversal approvals are paused/)).toBeNull();
    expect(screen.queryByText(/Could not load reversal call-outs/)).toBeNull();
  });

  it('banner: mounted for a V2 tenant', async () => {
    mockApi({ engineMode: 'V2' });
    render(<PayoutStatusPage />);
    expect(await screen.findByText(/Points reversal approvals are paused/)).toBeTruthy();
  });

  it('D5 LEGACY amount path: sends the trimmed remarks', async () => {
    const api = mockApi({ entries: [{ mode: 'LEGACY', entries: [] }] });
    await openModal();
    await screen.findByText('Reversal Amount (₹)');
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Remarks (optional)'), { target: { value: '  wrong outlet  ' } });
    fireEvent.click(submitBtn());
    await screen.findByText(/awaiting Gifsy approval/);
    expect(api.posts[0]).toMatchObject({ requestedPaise: 50000, remarks: 'wrong outlet' });
  });

  it('D5 V2 entry path: sends the trimmed remarks; blank remarks are omitted', async () => {
    const api = mockApi({ entries: [{ mode: 'V2', entries: [entry('pe-b', 50000, 'PENDING')] }] });
    await openModal();
    await screen.findByTestId('payout-entry-picker');
    fireEvent.change(screen.getByLabelText('Remarks (optional)'), { target: { value: ' duplicate credit ' } });
    fireEvent.click(submitBtn());
    await screen.findByText(/held out of bank files/);
    expect(api.posts[0]).toMatchObject({ payoutEntryIds: ['pe-b'], requestedPaise: 50000, remarks: 'duplicate credit' });

    fireEvent.click(screen.getByLabelText('Close'));
    fireEvent.click(await screen.findByRole('button', { name: /Reverse/ }));
    await screen.findByTestId('payout-entry-picker');
    fireEvent.change(screen.getByLabelText('Remarks (optional)'), { target: { value: '   ' } });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(api.posts).toHaveLength(2));
    expect(api.posts[1]).not.toHaveProperty('remarks');
  });

  it('#4 (audit B5 — LEGACY / Deoleo identical): the amount form is there at once and Submit works while the lookup is pending', async () => {
    const api = mockApi({ entries: ['pending'] });
    await openModal();
    expect(screen.queryByTestId('payout-entries-loading')).toBeNull();
    expect(screen.getByText('Reversal Amount (₹)')).toBeTruthy();
    expect(submitBtn().disabled).toBe(false);
    api.release();
    await waitFor(() => expect(api.entryCalls).toHaveLength(1));
    expect(screen.getByText('Reversal Amount (₹)')).toBeTruthy(); // LEGACY answer → the same form
    expect(submitBtn().disabled).toBe(false);
  });

  it('#5 (audit B5): a failed lookup keeps the amount form (the server refuses an amount-only request on a V2 tenant with a clear message); a V2 answer switches to the picker', async () => {
    const failed = mockApi({ entries: ['fail'] });
    await openModal();
    await waitFor(() => expect(failed.entryCalls).toHaveLength(1));
    expect(screen.queryByTestId('payout-entries-error')).toBeNull();
    expect(screen.getByText('Reversal Amount (₹)')).toBeTruthy();
    expect(submitBtn().disabled).toBe(false);
  });

  it('re-audit B2 — V2 tenant: "Loading payout entries…" and Submit waits (no amount form) while the lookup is pending', async () => {
    mockApi({ engineMode: 'V2', entries: ['pending'] });
    render(<PayoutStatusPage />);
    await waitFor(() => expect(vi.mocked(global.fetch).mock.calls.some((c) => String(c[0]).includes('/reversal-engine/attention'))).toBe(true));
    fireEvent.click(await screen.findByTestId('batch-header-b1'));
    // the mode is known before the modal opens
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(await screen.findByRole('button', { name: /Reverse/ }));
    await screen.findByRole('dialog');
    expect((await screen.findByTestId('payout-entries-loading')).textContent).toBe('Loading payout entries…');
    expect(screen.queryByText('Reversal Amount (₹)')).toBeNull();
    expect(submitBtn().disabled).toBe(true);
  });

  it('re-audit B2 — V2 tenant: a failed lookup shows an error with Retry (never a silent fallback); Retry loads the picker', async () => {
    const api = mockApi({ engineMode: 'V2', entries: ['fail', { mode: 'V2', entries: [entry('pe-b', 50000, 'PENDING')] }] });
    render(<PayoutStatusPage />);
    await waitFor(() => expect(api.attentionCalls.length).toBeGreaterThan(0));
    fireEvent.click(await screen.findByTestId('batch-header-b1'));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(await screen.findByRole('button', { name: /Reverse/ }));
    await screen.findByRole('dialog');
    const err = await screen.findByTestId('payout-entries-error');
    expect(err.textContent).toContain("Couldn't load payout entries — retry");
    expect(screen.queryByText('Reversal Amount (₹)')).toBeNull();
    expect(submitBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('payout-entry-picker');
    expect(api.entryCalls).toHaveLength(2);
    expect(submitBtn().disabled).toBe(false);
  });

  it('#5b: a V2 answer switches the modal to the entry picker', async () => {
    mockApi({ entries: [{ mode: 'V2', entries: [entry('pe-b', 50000, 'PENDING')] }] });
    await openModal();
    await screen.findByTestId('payout-entry-picker');
    expect(submitBtn().disabled).toBe(false);
  });

  it('owner D1: a PAID 194C entry shows why it can not be picked', async () => {
    mockApi({ entries: [{ mode: 'V2', entries: [entry('pe-a', 30000, 'PAID', false, 'PAID_194C'), entry('pe-b', 50000, 'PENDING')] }] });
    await openModal();
    await screen.findByTestId('payout-entry-picker');
    expect(
      screen.getByLabelText("Payout entry ₹300.00 (PAID) — not selectable: Paid 194C payout — 194C payouts can't be reversed once paid"),
    ).toBeTruthy();
  });

  it('#6: a failed V2 submit keeps the form, reloads entries and drops ticks no longer selectable', async () => {
    const api = mockApi({
      postFail: true,
      entries: [
        { mode: 'V2', entries: [entry('pe-a', 30000, 'PENDING'), entry('pe-b', 50000, 'FAILED')] },
        { mode: 'V2', entries: [entry('pe-a', 30000, 'PENDING'), entry('pe-b', 50000, 'FAILED', false, 'RESERVED')] },
      ],
    });
    await openModal();
    await screen.findByTestId('payout-entry-picker');
    expect((screen.getByLabelText('Payout entry ₹500.00 (FAILED)') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(submitBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/held by another pending reversal/);
    await waitFor(() => expect(api.entryCalls).toHaveLength(2));
    const b = (await screen.findByLabelText('Payout entry ₹500.00 (FAILED) — not selectable: Held by another pending reversal')) as HTMLInputElement;
    expect([b.checked, b.disabled]).toEqual([false, true]);
    expect((screen.getByLabelText('Payout entry ₹300.00 (PENDING)') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Reversal amount:/).textContent).toMatch(/₹300\.00 \(1 of 1 available/);
    expect(submitBtn().disabled).toBe(false);
    expect(screen.getByText(/held by another pending reversal/)).toBeTruthy(); // the error stays visible
  });

  it('#20: dialog semantics, Escape closes and focus returns to the Reverse button', async () => {
    mockApi({ entries: [{ mode: 'LEGACY', entries: [] }] });
    const reverse = await openModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('Request Reversal');
    expect(document.activeElement).toBe(screen.getByLabelText('Close'));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(reverse);
  });

  it('#20: Tab from the last control wraps to the first (focus trap)', async () => {
    mockApi({ entries: [{ mode: 'LEGACY', entries: [] }] });
    await openModal();
    await screen.findByText('Reversal Amount (₹)');
    const dialog = screen.getByRole('dialog');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Close'));
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });
});
