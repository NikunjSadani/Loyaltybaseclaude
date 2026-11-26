/// <reference types="vitest/globals" />
/**
 * /admin/credits-payouts/status — Wallet Reversal Engine fix round B (every tenant — the per-tenant engine mode was
 * retired, so there is no LEGACY / SHADOW path any more):
 *  - D5: the typed remarks (trimmed) are sent on BOTH create paths (POINTS amount form + PAYOUT entry picker); blank → omitted.
 *  - the attention banner is mounted for every tenant (the payload has no `mode`); readiness is shown up front.
 *  - #4 "Loading payout entries…" + Submit disabled until the lookup answers; #5 failed lookup → error + Retry.
 *  - #6 a failed submit keeps the form, reloads the entries and drops ticks that are no longer selectable.
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

// The payout status / cancellation panel (own tests in _components/__tests__) is not under test here — its own
// alerts would collide with this file's `findByRole('alert')` on the reversal modal.
vi.mock('../_components/BatchPayoutPanel', () => ({
  default: () => null,
  useCanCancelPayouts: () => false,
}));

import { useAdminSession } from '@/lib/admin-session';
import PayoutStatusPage from '../page';

const batch = {
  id: 'b1', batchCode: 'CB-2026-10-001', period: '2026-10', status: 'CONFIRMED', uploadedBy: 'ops',
  uploadedAt: '2026-10-01T00:00:00.000Z', totalOutlets: 1, totalPoints: 0, totalPayoutPaise: 80000,
};
const payoutRow = {
  rowNum: 1, outletId: 'O1', outletName: 'Outlet One', fieldId: 'f1', fieldName: 'Volume',
  amount: 80000, narration: '', awardType: 'PAYOUT', status: 'OK', errors: [],
};
const pointsRow = { ...payoutRow, amount: 400, awardType: 'POINTS' };

type Entry = { id: string; amountPaise: number; status: string; period: string; createdAt: string; selectable: boolean; blockedBy: string | null };
const entry = (id: string, amountPaise: number, status: string, selectable = true, blockedBy: string | null = null): Entry =>
  ({ id, amountPaise, status, period: '2026-10', createdAt: '', selectable, blockedBy });

const ok = (payload: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => payload });

type EntriesAnswer = { mode?: string; entries?: Entry[] };

interface ApiOpts {
  /** Attention read: 'fail' = network error; otherwise fields merged over the default (approvals paused). */
  attention?: 'fail' | Record<string, unknown>;
  /** Sequence of responses for the entries lookup ('fail' = network error); the last one repeats. */
  entries?: Array<EntriesAnswer | 'fail' | 'pending'>;
  postFail?: boolean;
  /** What a 'pending' lookup answers once released. */
  pendingAnswer?: EntriesAnswer;
  /** Wallets below zero answered by GET …/wallets-in-debt (default none). */
  debtWallets?: Array<Record<string, unknown>>;
  /** The batch row (default a PAYOUT row). */
  row?: typeof payoutRow;
}

function mockApi(opts: ApiOpts) {
  const posts: Array<Record<string, unknown>> = [];
  const entryCalls: string[] = [];
  const attentionCalls: string[] = [];
  let release: (() => void) | null = null;
  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // Wallets below zero (mounted on every tenant): none unless given.
    if (url.includes('/reversal-engine/wallets-in-debt')) {
      const w = opts.debtWallets ?? [];
      return ok({
        success: true,
        data: { total: w.length, totalOwedPoints: w.reduce((n, x) => n + Number(x.owedPoints ?? 0), 0), limit: 1000, anyNegative: w.length > 0, program: null, wallets: w },
      });
    }
    if (url.includes('/reversal-engine/attention')) {
      attentionCalls.push(url);
      if (opts.attention === 'fail') return Promise.reject(new TypeError('Failed to fetch'));
      // No `mode` field — the contract no longer carries one.
      return ok({
        success: true,
        data: {
          readiness: { unsequencedWithHistory: 0, blocked: 0, ready: true, message: null },
          pause: { paused: true, since: null, by: null, reason: null },
          wallets: [], walletsTotal: 0, unmappedCredits: [], unmappedTotal: 0, owedClawbacks: [], owedTotal: 0,
          ...(opts.attention ?? {}),
        },
      });
    }
    if (url.includes('/attachments')) return ok({ success: true, data: { attachments: [] } });
    if (url.startsWith('/api/admin/credits/batches?')) {
      return ok({ success: true, data: { batches: [batch], pagination: { page: 1, limit: 50, total: 1, pages: 1 } } });
    }
    if (url.includes('/payout-reversal-entries')) {
      const seq = opts.entries ?? [{ mode: 'V2', entries: [entry('pe-b', 50000, 'PENDING')] }];
      const r = seq[Math.min(entryCalls.length, seq.length - 1)];
      entryCalls.push(url);
      if (r === 'fail') return Promise.reject(new TypeError('Failed to fetch'));
      if (r === 'pending') {
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, status: 200, json: async () => ({ success: true, data: opts.pendingAnswer ?? { mode: 'V2', entries: [] } }) });
        });
      }
      return ok({ success: true, data: r });
    }
    if (url.endsWith('/reversals') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (opts.postFail) {
        return Promise.resolve({ ok: false, status: 409, json: async () => ({ success: false, error: 'Payout entry pe-b is held by another pending reversal' }) });
      }
      return ok({ success: true, data: { id: 'r1' } });
    }
    if (/\/api\/admin\/credits\/batches\/b1$/.test(url)) return ok({ success: true, data: { ...batch, rows: [opts.row ?? payoutRow] } });
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

describe('Payout status — reversal fix round B (every tenant)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAdminSession).mockReturnValue({
      role: 'CLIENT_ADMIN', clientId: 'bajaj', name: 'Test Admin', userId: '', canManageSchemes: true,
    } as ReturnType<typeof useAdminSession>);
  });

  it('banner: mounted for every tenant — the attention payload has no mode field', async () => {
    mockApi({});
    render(<PayoutStatusPage />);
    expect(await screen.findByText(/Points reversal approvals are paused/)).toBeTruthy();
    expect(screen.getByLabelText('Points reversal call-outs')).toBeTruthy();
  });

  it('banner: renders nothing when there is nothing to report (no empty box)', async () => {
    const api = mockApi({ attention: { pause: { paused: false, since: null, by: null, reason: null } } });
    render(<PayoutStatusPage />);
    await screen.findByTestId('batch-header-b1');
    await waitFor(() => expect(api.attentionCalls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByLabelText('Points reversal call-outs')).toBeNull();
  });

  it('banner: shows the readiness line when wallets are not prepared for reversals', async () => {
    const message = '12 wallets with points history are not yet prepared for reversals — Gifsy must run the wallet backfill for this program before any points reversal';
    mockApi({ attention: { readiness: { unsequencedWithHistory: 12, blocked: 0, ready: false, message } } });
    render(<PayoutStatusPage />);
    expect((await screen.findByTestId('attention-readiness')).textContent).toBe(message);
  });

  it('banner: a failed call-out read is shown, never silent', async () => {
    mockApi({ attention: 'fail' });
    render(<PayoutStatusPage />);
    expect((await screen.findByText(/Could not load reversal call-outs/)).getAttribute('role')).toBe('alert');
  });

  it('owner D2: negative wallets (e.g. imported) show the wallets-below-zero list on any tenant — neutral wording', async () => {
    mockApi({
      debtWallets: [{
        walletId: 'w9', partnerName: 'Imported Shop', outletCodes: ['O9'], balance: -841, debtPoints: 0, owedPoints: 841,
        sources: [], note: 'No reversal behind it — negative from imported / earlier history',
      }],
    });
    render(<PayoutStatusPage />);
    expect((await screen.findByTestId('wallets-in-debt-summary')).textContent).toBe('1 wallet below zero · 841 pts owed');
    expect(await screen.findByLabelText('Points reversal call-outs')).toBeTruthy(); // both mounted
  });

  it('D5 POINTS amount path: debt copy (never written off) and the trimmed remarks are sent', async () => {
    const api = mockApi({ row: pointsRow });
    await openModal();
    await screen.findByText('Reversal Amount (pts)');
    expect(screen.getByText(/repaid from its future earnings — nothing is written off/)).toBeTruthy();
    expect(api.entryCalls).toHaveLength(0); // POINTS rows never look up payout entries
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '300' } });
    fireEvent.change(screen.getByLabelText('Remarks (optional)'), { target: { value: '  wrong outlet  ' } });
    fireEvent.click(submitBtn());
    await screen.findByText(/awaiting Gifsy approval/);
    expect(api.posts[0]).toMatchObject({ awardType: 'POINTS', requestedPaise: 300, remarks: 'wrong outlet' });
  });

  it('D5 entry path: sends the trimmed remarks; blank remarks are omitted', async () => {
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

  it('#4: "Loading payout entries…" and Submit waits (no amount form) while the lookup is pending; the answer shows the picker', async () => {
    const api = mockApi({ entries: ['pending'], pendingAnswer: { mode: 'V2', entries: [entry('pe-b', 50000, 'PENDING')] } });
    await openModal();
    expect((await screen.findByTestId('payout-entries-loading')).textContent).toBe('Loading payout entries…');
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(submitBtn().disabled).toBe(true);
    api.release();
    await screen.findByTestId('payout-entry-picker');
    await waitFor(() => expect(submitBtn().disabled).toBe(false));
  });

  it('#5: a failed lookup shows an error with Retry (never a silent fallback); Retry loads the picker', async () => {
    const api = mockApi({ entries: ['fail', { mode: 'V2', entries: [entry('pe-b', 50000, 'PENDING')] }] });
    await openModal();
    const err = await screen.findByTestId('payout-entries-error');
    expect(err.textContent).toContain("Couldn't load payout entries — retry");
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(submitBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('payout-entry-picker');
    expect(api.entryCalls).toHaveLength(2);
    await waitFor(() => expect(submitBtn().disabled).toBe(false));
  });

  it('#5: an answer without an entries list is an error with Retry — never the amount form', async () => {
    mockApi({ entries: [{ mode: 'V2' }] });
    await openModal();
    expect(await screen.findByTestId('payout-entries-error')).toBeTruthy();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(submitBtn().disabled).toBe(true);
  });

  it('#5b: an answer that omits the mode field still shows the entry picker', async () => {
    mockApi({ entries: [{ entries: [entry('pe-b', 50000, 'PENDING')] }] });
    await openModal();
    await screen.findByTestId('payout-entry-picker');
    await waitFor(() => expect(submitBtn().disabled).toBe(false));
  });

  it('owner D1: a PAID 194C entry shows why it can not be picked', async () => {
    mockApi({ entries: [{ mode: 'V2', entries: [entry('pe-a', 30000, 'PAID', false, 'PAID_194C'), entry('pe-b', 50000, 'PENDING')] }] });
    await openModal();
    expect(
      await screen.findByLabelText("Payout entry ₹300.00 (PAID) — not selectable: Paid 194C payout — 194C payouts can't be reversed once paid"),
    ).toBeTruthy();
  });

  it('#6: a failed submit keeps the form, reloads entries and drops ticks no longer selectable', async () => {
    const api = mockApi({
      postFail: true,
      entries: [
        { mode: 'V2', entries: [entry('pe-a', 30000, 'PENDING'), entry('pe-b', 50000, 'FAILED')] },
        { mode: 'V2', entries: [entry('pe-a', 30000, 'PENDING'), entry('pe-b', 50000, 'FAILED', false, 'RESERVED')] },
      ],
    });
    await openModal();
    expect(((await screen.findByLabelText('Payout entry ₹500.00 (FAILED)')) as HTMLInputElement).checked).toBe(true);
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
    mockApi({});
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
    mockApi({});
    await openModal();
    await screen.findByTestId('payout-entry-picker');
    const dialog = screen.getByRole('dialog');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Close'));
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);
  });
});
