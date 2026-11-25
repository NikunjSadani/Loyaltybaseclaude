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
 *  - UND8: the file had deductions but the confirm applied none → loud alert
 *  - UND9: two outlets on ONE wallet → one below-zero line incl. the held opening balance
 *  - UND10: repeat-deduction warning
 *  - UND11: the server refuses an unacknowledged category → its message is shown, nothing credited
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

const outletOk = (outletCode: string, balance: number, over: Record<string, unknown> = {}) => ({
  outletCode, found: true, linked: true, walletId: `W-${outletCode}`, partnerId: `P-${outletCode}`, balance,
  heldOpeningBalance: null, ready: true, reason: null, code: null, ...over,
});
const previewOk = (outlets: unknown[], over: Record<string, unknown> = {}): Reply =>
  ({ status: 200, body: { success: true, data: { deductionsEnabled: true, outlets, priorDeductions: [], ...over } } });

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
      return ok(confirmReply.body, confirmReply.status);
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

    expect(await screen.findByText('BJ1 · Balance will go below zero: 100 → −220')).toBeInTheDocument();
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
    await screen.findByText('Credits confirmed successfully');
    expect(JSON.parse(confirmBodies[0])).toEqual({ acknowledged: ['SKIPPED', 'ROUNDED', 'BELOW_ZERO'], skippedRows: 1 });
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
    expect(await screen.findByText('BJ1 · Balance will go below zero: 100 → −220')).toBeInTheDocument();
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
    expect(JSON.parse(confirmBodies[0])).toEqual({ acknowledged: [], skippedRows: 0 });
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

  it('UND8: the file had deductions but the confirm applied none → loud "NOT deducted" alert', async () => {
    await upload(MIXED);
    await tickAll(3);
    fireEvent.click(confirmBtn());
    expect(await screen.findByTestId('credits-deductions-ignored')).toHaveTextContent('2 deduction rows were NOT deducted');
  });

  it('UND9: two outlets sharing one wallet → ONE line with both codes, held opening balance included', async () => {
    previewReplies = [previewOk([
      outletOk('BJ1', 100, { walletId: 'W', heldOpeningBalance: 50 }),
      outletOk('BJ2', 100, { walletId: 'W' }),
    ])];
    await upload(MIXED);
    // current = 100 + 50 held; after = 150 + 30 − 350 − 200 = −370
    expect(await screen.findByText('BJ1, BJ2 · Balance will go below zero: 150 → −370')).toBeInTheDocument();
    expect(screen.getByText('(includes a held opening balance of 50 that posts first)')).toBeInTheDocument();
    expect(screen.getByLabelText('I understand 1 wallet will go below zero')).toBeInTheDocument();
  });

  it('UND10: a deduction already made for the same outlet + field → repeat warning + its own tick', async () => {
    previewReplies = [previewOk([outletOk('BJ1', 5000), outletOk('BJ2', 5000)], {
      priorDeductions: [{ outletCode: 'BJ1', fieldId: 'f1', batchId: 'b0', batchCode: 'CB-OLD', confirmedAt: '2026-11-03T06:00:00.000Z', points: 350 }],
    })];
    await upload(MIXED);
    expect(await screen.findByText("Already deducted on 3 Nov 2026 in batch CB-OLD — check this isn't a repeat.")).toBeInTheDocument();
    await tickAll(3); // SKIPPED, ROUNDED, REPEAT_DEDUCTION
    fireEvent.click(confirmBtn());
    await screen.findByText(/Credits confirmed/);
    expect(JSON.parse(confirmBodies[0]).acknowledged).toEqual(['SKIPPED', 'ROUNDED', 'REPEAT_DEDUCTION']);
  });

  it('UND11: the server refuses an unacknowledged category → its message shown; nothing credited', async () => {
    confirmReply = { status: 400, body: {
      success: false, missingAcknowledgements: ['NOT_APPLIED'],
      error: 'Before confirming, please review and tick: rows not applied. Nothing was credited or deducted.',
    } };
    await upload(MIXED);
    await tickAll(3);
    fireEvent.click(confirmBtn());
    expect(await screen.findByRole('alert')).toHaveTextContent('Before confirming, please review and tick: rows not applied');
    expect(screen.queryByText(/Credits confirmed/)).toBeNull();
  });

  it('UND12: Upload Again + a new file resets the ticks', async () => {
    const { container } = await upload(MIXED);
    await tickAll(3);
    expect(confirmBtn()).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /Upload Again/ }));
    await waitFor(() => expect(container.querySelector('input[type="file"]')).not.toBeNull());
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [MIXED] } });
    await screen.findByText('BJ1 · Balance will go below zero: 100 → −220');
    within(screen.getByTestId('before-you-confirm')).getAllByRole('checkbox').forEach((b) => expect(b).not.toBeChecked());
    expect(confirmBtn()).toBeDisabled();
  });
});
