/// <reference types="vitest/globals" />
/**
 * UND — Credits upload: negative POINTS become wallet deductions + "Before you confirm" (owner rule: no silent
 * failure). Design: docs/plans/UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md.
 *
 *  - UND1: deductions panel, cards, upload-preview body; Confirm gated on every present category's tick; the confirm
 *          body carries { acknowledged, skippedRows }; the done screen lists what was accepted
 *  - UND2: hard block — a deduction wallet not prepared: ticks never enable Confirm; unlinked outlet → NOT_APPLIED
 *  - UND3: the preview fails → hard block with the reason; "Check again" re-runs it
 *  - UND4: setting OFF → old negative error; "Total Pts"
 *  - UND5: a clean credit-only file: preview asked (every tenant), no section, confirms with acknowledged []
 *  - UND6: done screen appends deductions; a skipped deduction reads "NOT deducted"
 *  - UND7: deductionsEnabled false on the server → hard block
 *  - UND9: two outlets on ONE wallet → one below-zero line incl. the held opening balance
 *  - UND10: repeat-deduction warning
 *  - UND11: (U1) the server refuses an unacknowledged category → the check re-runs, the batch stays pending, the missing
 *           box appears; tick + Retry confirm re-sends the acknowledgements — never "upload again"
 *  - UND13: a category outside the server's ackCategories is information only (no box)
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';
import type { CreditField } from '@/types';
import type { TemplateOutlet } from '@/lib/credits-payouts-template';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/credits-payouts/upload',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/admin-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-session')>();
  return {
    ...actual,
    useAdminSession: vi.fn(() => ({ role: 'CLIENT_ADMIN', clientId: 'bajaj', name: 'Admin', userId: 'u1' })),
  };
});

const CP = { monthCutoffDay: 31, safetyCapPoints: 50000, safetyCapInr: 100000, fourEyesEnabled: false, notifyEmails: [] };
const flags = { negativeDeductions: true };
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gifsy-settings')>();
  return {
    ...actual,
    getGifsySettings: vi.fn(() => ({ creditsPayouts: CP, creditUploadNegativeDeductions: flags.negativeDeductions })),
  };
});

import CreditsPayoutsUploadPage from '../page';

/** The page uploads for the PREVIOUS calendar month — computed relative to now, never hardcoded. */
function expectedPeriod(): string {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
}

const FIELDS: CreditField[] = ['Target Achievement', 'Display Bonus'].map((name, i) => ({
  id: `f${i}`, name, isActive: true, isSeparatePayout: false,
  outletTypeAwards: { WHOLESALER: 'POINTS', SSS: 'PAYOUT' },
  createdAt: '2026-01-01T00:00:00.000Z', order: i + 1,
}));
const OUTLETS: TemplateOutlet[] = [
  { id: 'BJ1', name: 'One', type: 'WHOLESALER' },
  { id: 'BJ2', name: 'Two', type: 'WHOLESALER' },
];

function makeFile(rows: (string | number)[][]): File {
  const headers = ['Outlet ID', 'Outlet Name', ...FIELDS.map((f) => f.name), ...FIELDS.map((f) => `${f.name} Narration`)];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Credits'], headers, ...rows]), 'Upload');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const file = new File([buf], 'c.xlsx');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => buf });
  return file;
}

// BJ1: credit 30 (Target) + deduction −350 (Display) → with balance 100: 100 + 30 − 350 = −220.
// BJ2: Target blank (SKIPPED) + deduction −199.5 → −200 (ROUNDED).
const MIXED = makeFile([
  ['BJ1', 'One', 30, -350, '', ''],
  ['BJ2', 'Two', '', -199.5, '', ''],
]);

type Reply = { status: number; body: unknown } | 'reject';
let previewBodies: string[] = [];
let previewReplies: Reply[] = [];
let confirmBodies: string[] = [];
let confirmReply: { status: number; body: unknown };
/** Optional queue of confirm replies (consumed in order; then confirmReply). */
let confirmQueue: Array<{ status: number; body: unknown }> = [];

const outletOk = (outletCode: string, balance: number, over: Record<string, unknown> = {}) => ({
  outletCode, found: true, linked: true, walletId: `W-${outletCode}`, partnerId: `P-${outletCode}`, balance,
  heldOpeningBalance: null, ready: true, reason: null, code: null, ...over,
});
const previewOk = (outlets: unknown[], over: Record<string, unknown> = {}): Reply =>
  ({ status: 200, body: { success: true, data: {
    deductionsEnabled: true, outlets, priorDeductions: [],
    ackCategories: ['SKIPPED', 'ROUNDED', 'NOT_APPLIED', 'BELOW_ZERO', 'REPEAT_DEDUCTION'], ...over,
  } } });

function installFetch() {
  previewBodies = [];
  confirmBodies = [];
  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const ok = (body: unknown, status = 200) =>
      Promise.resolve({ ok: status < 300, status, json: async () => body } as unknown as Response);
    if (url.includes('/credits/fields')) return ok({ success: true, data: FIELDS });
    if (url.includes('/eligible-outlets')) return ok({ success: true, data: OUTLETS });
    if (url.includes('/upload-preview')) {
      previewBodies.push(String(init?.body));
      const r = previewReplies.length > 1 ? previewReplies.shift()! : previewReplies[0];
      if (r === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
      return ok(r.body, r.status);
    }
    if (url.endsWith('/credits/batches') && init?.method === 'POST') {
      return ok({ success: true, data: { id: 'b1', batchCode: 'CB-1', totalOutlets: 2, totalPoints: 30, totalPayoutPaise: 0 } });
    }
    if (url.endsWith('/confirm')) {
      confirmBodies.push(String(init?.body));
      const c = confirmQueue.length ? confirmQueue.shift()! : confirmReply;
      return ok(c.body, c.status);
    }
    return ok({ success: false, error: `unmocked ${url}` }, 404);
  }) as unknown as typeof fetch;
}

async function upload(file: File) {
  const utils = render(<CreditsPayoutsUploadPage />);
  await waitFor(() => expect(utils.container.querySelector('input[type="file"]')).not.toBeNull());
  await screen.findByText(/Template includes 2 active fields/);
  fireEvent.change(utils.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
  await screen.findByText('OK Rows');
  return utils;
}

const confirmBtn = () => screen.getByRole('button', { name: /Confirm & Credit/ });
/** Wait for the preview answer (the below-zero etc. blocks appear), then tick every box. */
async function tickAll(expected: number) {
  await waitFor(() => expect(screen.queryByText('Checking wallet balances…')).toBeNull());
  const section = await screen.findByTestId('before-you-confirm');
  const boxes = within(section).getAllByRole('checkbox');
  expect(boxes).toHaveLength(expected);
  boxes.forEach((b) => fireEvent.click(b));
}

describe('UND — upload with deductions + Before you confirm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.negativeDeductions = true;
    previewReplies = [previewOk([outletOk('BJ1', 100), outletOk('BJ2', 5000)])];
    confirmReply = { status: 200, body: { success: true, data: { pointsCredited: 1, pointsCreditedTotal: 30, payoutEntriesCreated: 0, skipped: [] } } };
    confirmQueue = [];
    installFetch();
  });

  it('UND1: panels + cards; Confirm gated on every tick; confirm body; "You accepted"', async () => {
    await upload(MIXED);

    expect(await screen.findByTestId('credits-deductions-panel')).toHaveTextContent('Will be deducted — 2 rows · 550 pts');
    expect(screen.getAllByTestId('credits-deduction-row').map((e) => e.textContent)).toEqual(['−350 pts', '−199.5 → −200 pts']);
    expect(screen.getByText('Total credited')).toBeInTheDocument();
    expect(screen.getByText('30 pts')).toBeInTheDocument();
    expect(screen.getByText('550 pts')).toBeInTheDocument();
    expect(screen.getByTestId('credits-ok-split')).toHaveTextContent('1 to credit or pay · 2 to deduct');

    expect(await screen.findByText('BJ1 · Balance will go below zero: 100 → −220 pts')).toBeInTheDocument();
    expect(JSON.parse(previewBodies[0])).toEqual({
      outletCodes: ['BJ1', 'BJ2'], period: expectedPeriod(),
      lines: [{ outletCode: 'BJ1', fieldId: 'f1' }, { outletCode: 'BJ2', fieldId: 'f1' }],
    });

    // Three categories present: SKIPPED, ROUNDED, BELOW_ZERO → disabled until each is ticked.
    expect(confirmBtn()).toBeDisabled();
    expect(screen.getByTestId('credits-confirm-blocked')).toHaveTextContent('Tick all 3 boxes under "Before you confirm" to continue.');
    expect(confirmBtn()).toHaveAttribute('aria-describedby', 'confirm-block-reason');
    fireEvent.click(screen.getByLabelText('I understand 1 row will not be credited (blank, zero or not applicable)'));
    fireEvent.click(screen.getByLabelText('I understand 1 row was rounded to whole units'));
    expect(confirmBtn()).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I understand 1 wallet will go below zero'));
    expect(confirmBtn()).toBeEnabled();

    fireEvent.click(confirmBtn());
    await screen.findByText('Upload confirmed'); // U8: the file has deductions — not "Credits confirmed"
    expect(screen.queryByText(/Credits confirmed/)).toBeNull();
    expect(JSON.parse(confirmBodies[0])).toEqual({
      acknowledged: ['SKIPPED', 'ROUNDED', 'BELOW_ZERO'],
      // The exact keys the admin saw, built byte-identically to the server (SKIPPED: category only).
      ackItems: { ROUNDED: ['BJ2|f1|POINTS|-200|-199.5'], BELOW_ZERO: ['P-BJ1|-220'] },
      skippedRows: 1,
    });
    const accepted = screen.getByTestId('credits-accepted');
    expect(accepted).toHaveTextContent('You accepted:');
    expect(accepted).toHaveTextContent('1 wallet will go below zero');
  });

  it('UND2: a deduction wallet not prepared is a HARD block (ticks never enable Confirm); unlinked → not applied', async () => {
    previewReplies = [previewOk([
      outletOk('BJ1', 100, { ready: false, reason: 'wallet not prepared for deductions — Gifsy must run the wallet backfill' }),
      outletOk('BJ2', 0, { linked: false, walletId: null }),
    ])];
    await upload(MIXED);

    expect(await screen.findByTestId('credits-deduction-blocked'))
      .toHaveTextContent('BJ1 · wallet not prepared for deductions — Gifsy must run the wallet backfill — confirm will be refused');
    expect(screen.getByText("I understand 1 row won't be applied (outlet not found or not linked)")).toBeInTheDocument();
    await tickAll(4); // SKIPPED, ROUNDED, NOT_APPLIED, BELOW_ZERO
    expect(confirmBtn()).toBeDisabled();
    expect(screen.getByTestId('credits-confirm-blocked')).toHaveTextContent('1 outlet wallet is not prepared for deductions');
    fireEvent.click(confirmBtn());
    expect(vi.mocked(global.fetch).mock.calls.some(([u]) => String(u).endsWith('/credits/batches'))).toBe(false);
  });

  it('UND3: the check fails → hard block with the reason; "Check again" re-runs it', async () => {
    previewReplies = ['reject', previewOk([outletOk('BJ1', 100), outletOk('BJ2', 5000)])];
    await upload(MIXED);
    const alert = await screen.findByText(/Couldn't check wallet balances — the server could not be reached\./);
    expect(alert).toHaveTextContent("If a wallet isn't prepared for deductions, the whole confirm is refused.");
    expect(confirmBtn()).toBeDisabled();
    expect(screen.getByTestId('credits-confirm-blocked')).toHaveTextContent("Couldn't check wallet balances — use Check again.");

    fireEvent.click(screen.getByRole('button', { name: /Check again/ }));
    expect(await screen.findByText('BJ1 · Balance will go below zero: 100 → −220 pts')).toBeInTheDocument();
    expect(previewBodies).toHaveLength(2);
  });

  it('UND3b: a non-success reply shows the server reason (never hidden)', async () => {
    previewReplies = [{ status: 500, body: { success: false, error: 'boom' } }];
    await upload(MIXED);
    expect(await screen.findByText(/Couldn't check wallet balances — boom\./)).toBeInTheDocument();
    expect(confirmBtn()).toBeDisabled();
  });

  it('UND4: setting OFF → old negative error, "Total Pts"', async () => {
    flags.negativeDeductions = false;
    await upload(MIXED);
    expect(await screen.findByText('• Amount cannot be negative (got -350).')).toBeInTheDocument();
    expect(screen.getByText('Total Pts')).toBeInTheDocument();
    expect(screen.queryByText('Total credited')).toBeNull();
    expect(screen.queryByTestId('credits-deductions-panel')).toBeNull();
    expect(screen.queryByTestId('credits-ok-split')).toBeNull();
    expect(screen.queryByRole('button', { name: /Confirm & Credit/ })).toBeNull(); // errors → fix and re-upload
  });

  it('UND5: a clean credit-only file → preview asked, no section, confirms with acknowledged []', async () => {
    previewReplies = [previewOk([outletOk('BJ1', 100)], { deductionsEnabled: false })];
    await upload(makeFile([['BJ1', 'One', 30, 40, '', '']]));
    expect(await screen.findByText('Total Pts')).toBeInTheDocument();
    await waitFor(() => expect(confirmBtn()).toBeEnabled());
    expect(screen.queryByTestId('before-you-confirm')).toBeNull();
    expect(screen.queryByTestId('credits-confirm-blocked')).toBeNull();
    expect(JSON.parse(previewBodies[0])).toEqual({ outletCodes: ['BJ1'], period: expectedPeriod(), lines: [] });
    fireEvent.click(confirmBtn());
    await screen.findByText('Credits confirmed successfully');
    expect(JSON.parse(confirmBodies[0])).toEqual({ acknowledged: [], ackItems: {}, skippedRows: 0 });
    expect(screen.queryByTestId('credits-accepted')).toBeNull();
  });

  it('UND6: done screen — " · M deductions · Y pts deducted"; a skipped deduction reads "NOT deducted"', async () => {
    confirmReply = { status: 200, body: { success: true, data: {
      pointsCredited: 1, pointsCreditedTotal: 30, payoutEntriesCreated: 0,
      pointsDeducted: 1, pointsDeductedTotal: 350,
      deductions: [{ outletId: 'BJ1', fieldName: 'Display Bonus', points: 350, balanceBefore: 130, balanceAfter: -220 }],
      skipped: [{ outletId: 'BJ2', fieldName: 'Display Bonus', points: -200, reason: 'OUTLET_NOT_LINKED_TO_PARTNER', kind: 'DEDUCTION' }],
    } } };
    await upload(MIXED);
    await tickAll(3);
    fireEvent.click(confirmBtn());
    expect(await screen.findByText('1 outlet credited · 30 pts · 1 deduction · 350 pts deducted')).toBeInTheDocument();
    expect(screen.getByText('1 row NOT deducted')).toBeInTheDocument();
    expect(screen.getByText('BJ2 · Display Bonus · −200 pts · NOT deducted')).toBeInTheDocument();
  });

  it('UND7: deductionsEnabled false on the server → hard block, ticks never enable Confirm', async () => {
    previewReplies = [previewOk([outletOk('BJ1', 100), outletOk('BJ2', 5000)], { deductionsEnabled: false })];
    await upload(MIXED);
    expect(await screen.findByTestId('credits-deductions-off')).toHaveTextContent('Deductions are switched off for this client');
    await tickAll(3);
    expect(confirmBtn()).toBeDisabled();
  });

  it('UND9: two outlets sharing one wallet → ONE line with both codes, held opening balance included', async () => {
    previewReplies = [previewOk([
      // Partner-level held opening balance repeated on both outlets → counted ONCE (U4).
      outletOk('BJ1', 100, { walletId: 'W', partnerId: 'P', heldOpeningBalance: 50 }),
      outletOk('BJ2', 100, { walletId: 'W', partnerId: 'P', heldOpeningBalance: 50 }),
    ])];
    await upload(MIXED);
    // current = 100 + 50 held; after = 150 + 30 − 350 − 200 = −370
    expect(await screen.findByText('BJ1, BJ2 · Balance will go below zero: 150 → −370 pts')).toBeInTheDocument();
    expect(screen.getByText('(includes a held opening balance of 50 that posts first)')).toBeInTheDocument();
    expect(screen.getByLabelText('I understand 1 wallet will go below zero')).toBeInTheDocument();
  });

  it('UND10: a deduction already made for the same outlet + field → repeat warning + its own tick', async () => {
    previewReplies = [previewOk([outletOk('BJ1', 5000), outletOk('BJ2', 5000)], {
      priorDeductions: [{ outletCode: 'BJ1', fieldId: 'f1', batchId: 'b0', batchCode: 'CB-OLD', confirmedAt: '2026-11-03T06:00:00.000Z', points: 350 }],
    })];
    await upload(MIXED);
    expect(await screen.findByText("Already deducted on 3 Nov 2026 in batch CB-OLD (350 pts still deducted) — check this isn't a repeat.")).toBeInTheDocument();
    await tickAll(3); // SKIPPED, ROUNDED, REPEAT_DEDUCTION
    fireEvent.click(confirmBtn());
    await screen.findByText(/Upload confirmed/);
    expect(JSON.parse(confirmBodies[0]).acknowledged).toEqual(['SKIPPED', 'ROUNDED', 'REPEAT_DEDUCTION']);
    expect(JSON.parse(confirmBodies[0]).ackItems.REPEAT_DEDUCTION).toEqual(['BJ1|f1|b0|350']);
  });

  it('UND11 (U1): a refused acknowledgement → the check re-runs, the batch stays pending, tick + Retry confirm', async () => {
    // The first check sees BJ1 at 5,000 (no below-zero); by confirm time the server finds it below zero.
    previewReplies = [
      previewOk([outletOk('BJ1', 5000), outletOk('BJ2', 5000)]),
      previewOk([outletOk('BJ1', 100), outletOk('BJ2', 5000)]),
    ];
    confirmQueue = [{ status: 400, body: {
      success: false,
      error: 'Before confirming, reload the page and tick: wallets going below zero. Nothing was credited or deducted.',
      details: { missingAcknowledgements: ['BELOW_ZERO'] },
    } }];
    await upload(MIXED);
    await tickAll(2); // SKIPPED, ROUNDED
    fireEvent.click(confirmBtn());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Batch CB-1 is saved but not confirmed yet');
    expect(alert).toHaveTextContent('tick the boxes, then press Retry confirm');
    expect(alert.textContent).not.toMatch(/upload (it )?again|re-upload|reload the page/i);
    // The check re-ran and now shows the below-zero wallet with its own (unticked) box; the batch stays pending.
    expect(await screen.findByText('BJ1 · Balance will go below zero: 100 → −220 pts')).toBeInTheDocument();
    expect(previewBodies).toHaveLength(2);
    const retry = screen.getByRole('button', { name: 'Retry confirm for CB-1' });
    expect(retry).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Confirm & Credit/ })).toBeNull();

    fireEvent.click(screen.getByLabelText('I understand 1 wallet will go below zero'));
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await screen.findByText('Upload confirmed');
    expect(confirmBodies).toHaveLength(2);
    expect(JSON.parse(confirmBodies[1])).toEqual({
      acknowledged: ['SKIPPED', 'ROUNDED', 'BELOW_ZERO'],
      ackItems: { ROUNDED: ['BJ2|f1|POINTS|-200|-199.5'], BELOW_ZERO: ['P-BJ1|-220'] },
      skippedRows: 1,
    });
    // One batch only — never a second save.
    expect(vi.mocked(global.fetch).mock.calls.filter(([u, i]) => String(u).endsWith('/credits/batches') && (i as RequestInit)?.method === 'POST')).toHaveLength(1);
  });

  it('UND13: a category outside the server\'s ackCategories is listed for information only (no box)', async () => {
    previewReplies = [previewOk([outletOk('BJ1', 100), outletOk('BJ2', 5000)], { ackCategories: ['BELOW_ZERO'] })];
    await upload(MIXED);
    await tickAll(1); // only BELOW_ZERO needs a tick
    expect(screen.getByTestId('ack-info-SKIPPED')).toBeInTheDocument();
    expect(screen.getByTestId('ack-info-ROUNDED')).toBeInTheDocument();
    expect(confirmBtn()).toBeEnabled();
    fireEvent.click(confirmBtn());
    await screen.findByText('Upload confirmed');
    expect(JSON.parse(confirmBodies[0])).toEqual({ acknowledged: ['BELOW_ZERO'], ackItems: { BELOW_ZERO: ['P-BJ1|-220'] }, skippedRows: 1 });
  });

  it('UND12: Upload Again + a new file resets the ticks', async () => {
    const { container } = await upload(MIXED);
    await tickAll(3);
    expect(confirmBtn()).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Upload Again/ }));
    await waitFor(() => expect(container.querySelector('input[type="file"]')).not.toBeNull());
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [MIXED] } });
    await screen.findByText('BJ1 · Balance will go below zero: 100 → −220 pts');
    within(screen.getByTestId('before-you-confirm')).getAllByRole('checkbox').forEach((b) => expect(b).not.toBeChecked());
    expect(confirmBtn()).toBeDisabled();
  });

  const refuse = (missing: string[], items: Record<string, Array<{ key: string; text: string }>> = {}) => ({ status: 400, body: {
    success: false,
    error: 'Before confirming, reload the page and tick: …. Nothing was credited or deducted.',
    details: { missingAcknowledgements: missing, items },
  } });

  it('UND14 (U2): a refusal with details.items re-shows the box WITH the server\'s row and sends its key', async () => {
    // Locally nothing goes below zero; the server (under the wallet lock) finds BJ1's wallet will.
    previewReplies = [previewOk([outletOk('BJ1', 5000), outletOk('BJ2', 5000)])];
    confirmQueue = [refuse(['BELOW_ZERO'], { BELOW_ZERO: [{ key: 'P-BJ1|-150', text: 'Wallet of BJ1: 150 → -150' }] })];
    await upload(MIXED);
    await tickAll(2);
    fireEvent.click(confirmBtn());
    expect(await screen.findByText('Wallet of BJ1: 150 → -150')).toBeInTheDocument();
    // …still there after the re-check the refusal started (that answer keeps the server's findings)
    await waitFor(() => expect(previewBodies).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('Checking wallet balances…')).toBeNull());
    expect(screen.getByText('Wallet of BJ1: 150 → -150')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('I understand some wallets will go below zero'));
    const retry = screen.getByRole('button', { name: 'Retry confirm for CB-1' });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await screen.findByText('Upload confirmed');
    expect(JSON.parse(confirmBodies[1]).ackItems.BELOW_ZERO).toEqual(['P-BJ1|-150']);
  });

  it('UND15 (U1): a ticked below-zero box is cleared when a re-check changes its after-balance (same wording)', async () => {
    previewReplies = [
      previewOk([outletOk('BJ1', 100), outletOk('BJ2', 5000)]),
      previewOk([outletOk('BJ1', 50), outletOk('BJ2', 5000)]),
    ];
    confirmQueue = [refuse(['ROUNDED'])]; // refuses ROUNDED only → the check re-runs
    await upload(MIXED);
    await tickAll(3);
    fireEvent.click(confirmBtn());
    expect(await screen.findByText('BJ1 · Balance will go below zero: 50 → −270 pts')).toBeInTheDocument();
    const box = screen.getByLabelText('I understand 1 wallet will go below zero') as HTMLInputElement;
    expect(box.checked).toBe(false);                                       // key changed → tick cleared
    expect((screen.getByLabelText('I understand 1 row will not be credited (blank, zero or not applicable)') as HTMLInputElement).checked).toBe(true);
  });

  it('UND16 (U4): a SAVED batch whose re-check finds an unprepared wallet → resolve-without-re-upload advice; Retry stays pressable', async () => {
    previewReplies = [
      previewOk([outletOk('BJ1', 100), outletOk('BJ2', 5000)]),
      previewOk([outletOk('BJ1', 100, { ready: false, reason: 'wallet not prepared' }), outletOk('BJ2', 5000)]),
    ];
    confirmQueue = [refuse(['ROUNDED'])];
    await upload(MIXED);
    await tickAll(3);
    fireEvent.click(confirmBtn());
    await screen.findByTestId('credits-deduction-blocked');
    const reason = screen.getByTestId('credits-confirm-blocked');
    expect(reason).toHaveTextContent('This batch is saved and waiting. Ask Gifsy to prepare the listed wallets, then press Retry confirm — no need to upload again.');
    expect(reason.textContent).not.toMatch(/remove those rows|re-upload/);
    fireEvent.click(screen.getByLabelText('I understand 1 row was rounded to whole units'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry confirm for CB-1' })).toBeEnabled());
  });

  it('UND17 (U4): a SAVED batch whose re-check fails → "press Check again, then Retry confirm"', async () => {
    previewReplies = [previewOk([outletOk('BJ1', 100), outletOk('BJ2', 5000)]), 'reject'];
    confirmQueue = [refuse(['ROUNDED'])];
    await upload(MIXED);
    await tickAll(3);
    fireEvent.click(confirmBtn());
    // The blocked panel first renders with the refusal text, then updates once the re-check
    // fails — wait for the final text instead of asserting on the first render (load flake).
    await waitFor(() => expect(screen.getByTestId('credits-confirm-blocked'))
      .toHaveTextContent('This batch is saved and waiting. The wallet check failed — press Check again, then Retry confirm.'), { timeout: 5000 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry confirm for CB-1' })).toBeDisabled());
  });

  it('UND18: a 409 wallet-not-ready confirm refusal re-runs the check at once and lists the wallets — saved-batch wording', async () => {
    previewReplies = [
      previewOk([outletOk('BJ1', 100), outletOk('BJ2', 5000)]),
      previewOk([outletOk('BJ1', 100, { ready: false, reason: 'wallet not prepared for deductions' }), outletOk('BJ2', 5000)]),
    ];
    confirmQueue = [{ status: 409, body: {
      success: false,
      error: "Some outlets' wallets aren't ready for deductions yet — ask Gifsy to prepare them, then upload again. Outlets: BJ1.",
    } }];
    await upload(MIXED);
    await tickAll(3);
    fireEvent.click(confirmBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      "Batch CB-1 is saved and waiting — some outlets' wallets aren't ready for deductions yet (BJ1), so nothing was credited or deducted. Ask Gifsy to prepare the listed wallets, then press Retry confirm — no need to upload again.",
    );
    expect(alert.textContent).not.toMatch(/then upload again/);
    expect(await screen.findByTestId('credits-deduction-blocked')).toHaveTextContent('BJ1 · wallet not prepared for deductions');
    expect(previewBodies).toHaveLength(2);
    expect(screen.getByTestId('credits-confirm-blocked'))
      .toHaveTextContent('This batch is saved and waiting. Ask Gifsy to prepare the listed wallets, then press Retry confirm — no need to upload again.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry confirm for CB-1' })).toBeEnabled());
  });

  it('UND19: the outlet list stops at the first full stop — "Nothing was credited or deducted" is not part of it', async () => {
    previewReplies = [previewOk([outletOk('BJ1', 100), outletOk('BJ2', 5000)])];
    confirmQueue = [{ status: 409, body: {
      success: false,
      error: "Some outlets' wallets aren't ready for deductions yet — ask Gifsy to prepare them, then upload again. Outlets: BJ1. Nothing was credited or deducted.",
    } }];
    await upload(MIXED);
    await tickAll(3);
    fireEvent.click(confirmBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("aren't ready for deductions yet (BJ1), so nothing was credited or deducted.");
    expect(alert.textContent).not.toMatch(/Nothing was credited or deducted\)/);
    expect(alert.textContent).not.toMatch(/\(BJ1\. Nothing/);
  });

  it('UND20: retrying a SAVED batch while deductions are switched off shows the saved-batch advice, never "remove the negative rows"', async () => {
    previewReplies = [previewOk([outletOk('BJ1', 100), outletOk('BJ2', 5000)])];
    confirmQueue = [{ status: 400, body: {
      success: false,
      error: 'Deductions are switched off for this client — remove the negative rows or ask Gifsy. Row for One (BJ1) / field "Display Bonus" has -350 points.',
    } }];
    await upload(MIXED);
    await tickAll(3);
    fireEvent.click(confirmBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Batch CB-1 is saved and waiting — deductions are switched off for this client, so nothing was credited or deducted. Ask Gifsy to switch deductions on, then press Retry confirm — no need to upload again.',
    );
    expect(alert.textContent).not.toMatch(/remove the negative rows/);
    expect(screen.getByRole('button', { name: 'Retry confirm for CB-1' })).toBeInTheDocument();
  });
});
