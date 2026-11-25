/// <reference types="vitest/globals" />
/**
 * UND — Credits upload: negative POINTS become wallet deductions (tenant setting
 * `creditUploadNegativeDeductions`; design docs/plans/UPLOAD-NEGATIVE-DEDUCTIONS-DESIGN.md).
 *
 *  - UND1: setting ON + a negative row → "Will be deducted" panel, Total credited / Total deducted cards,
 *          "N to credit · M to deduct"; deduction-preview drives "Balance will go below zero: 100 → −220"
 *  - UND2: a not-ready wallet (ready:false) → red reason + Confirm & Credit disabled with the why
 *  - UND3: the deduction-preview request fails → visible amber warning; Confirm stays enabled
 *  - UND4: setting OFF → old negative error, no deduction-preview request, "Total Pts" card
 *  - UND5: setting ON but a credit-only file → no deduction-preview request, "Total Pts" card
 *  - UND6: done screen appends deductions; a skipped deduction reads "NOT deducted"
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
// BJ2: deduction −199.5 → −200.
const MIXED = makeFile([
  ['BJ1', 'One', 30, -350, '', ''],
  ['BJ2', 'Two', '', -199.5, '', ''],
]);

let previewBodies: string[] = [];
let previewReply: { status: number; body: unknown } | 'reject';
let confirmReply: unknown;

function installFetch() {
  previewBodies = [];
  global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const ok = (body: unknown, status = 200) =>
      Promise.resolve({ ok: status < 300, status, json: async () => body } as unknown as Response);
    if (url.includes('/credits/fields')) return ok({ success: true, data: FIELDS });
    if (url.includes('/eligible-outlets')) return ok({ success: true, data: OUTLETS });
    if (url.includes('/deduction-preview')) {
      previewBodies.push(String(init?.body));
      if (previewReply === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
      return ok(previewReply.body, previewReply.status);
    }
    if (url.endsWith('/credits/batches') && init?.method === 'POST') {
      return ok({ success: true, data: { id: 'b1', batchCode: 'CB-1', totalOutlets: 2, totalPoints: 30, totalPayoutPaise: 0 } });
    }
    if (url.endsWith('/confirm')) return ok(confirmReply);
    return ok({ success: false, error: `unmocked ${url}` }, 404);
  }) as unknown as typeof fetch;
}

const outletOk = (outletCode: string, balance: number) => ({ outletCode, linked: true, balance, ready: true, reason: null });

async function upload(file: File) {
  const utils = render(<CreditsPayoutsUploadPage />);
  await waitFor(() => expect(utils.container.querySelector('input[type="file"]')).not.toBeNull());
  // Fields must have loaded (they drive the parse).
  await screen.findByText(/Template includes 2 active fields/);
  fireEvent.change(utils.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
  await screen.findByText('OK Rows');
  return utils;
}

describe('UND — upload with negative-points deductions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.negativeDeductions = true;
    previewReply = { status: 200, body: { success: true, data: { outlets: [outletOk('BJ1', 100), outletOk('BJ2', 5000)] } } };
    confirmReply = { success: true, data: { pointsCredited: 1, pointsCreditedTotal: 30, payoutEntriesCreated: 0, skipped: [] } };
    installFetch();
  });

  it('UND1: panel, cards and the below-zero call-out', async () => {
    await upload(MIXED);

    const panel = await screen.findByTestId('credits-deductions-panel');
    expect(panel).toHaveTextContent('Will be deducted — 2 rows · 550 pts');
    const lines = screen.getAllByTestId('credits-deduction-row').map((e) => e.textContent);
    expect(lines).toEqual(['−350 pts', '−199.5 → −200 pts']);

    expect(screen.getByText('Total credited')).toBeInTheDocument();
    expect(screen.queryByText('Total Pts')).toBeNull();
    expect(screen.getByText('Total deducted')).toBeInTheDocument();
    expect(screen.getByText('550 pts')).toBeInTheDocument();
    expect(screen.getByTestId('credits-ok-split')).toHaveTextContent('1 to credit · 2 to deduct');

    expect(await screen.findByTestId('credits-deduction-below-zero'))
      .toHaveTextContent('BJ1 · Balance will go below zero: 100 → −220');
    expect(screen.getAllByTestId('credits-deduction-below-zero')).toHaveLength(1); // BJ2 stays positive
    expect(JSON.parse(previewBodies[0])).toEqual({ outletCodes: ['BJ1', 'BJ2'] });

    await waitFor(() => expect(screen.getByRole('button', { name: /Confirm & Credit/ })).toBeEnabled());
  });

  it('UND2: ready:false → reason shown and Confirm & Credit disabled with the why', async () => {
    previewReply = { status: 200, body: { success: true, data: { outlets: [
      { outletCode: 'BJ1', linked: true, balance: 100, ready: false, reason: 'wallet not prepared for deductions — Gifsy must run the wallet backfill' },
      { outletCode: 'BJ2', linked: false, balance: null, ready: false, reason: null },
    ] } } };
    await upload(MIXED);

    expect(await screen.findByTestId('credits-deduction-blocked'))
      .toHaveTextContent('BJ1 · wallet not prepared for deductions — Gifsy must run the wallet backfill — confirm will be refused');
    expect(screen.getByText(/not linked to a partner — will be skipped, NOT deducted/)).toBeInTheDocument();
    expect(screen.getByTestId('credits-confirm-blocked')).toHaveTextContent('1 outlet wallet is not prepared for deductions');
    const btn = screen.getByRole('button', { name: /Confirm & Credit/ });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(vi.mocked(global.fetch).mock.calls.some(([u]) => String(u).endsWith('/credits/batches'))).toBe(false);
  });

  it('UND3: the balance check fails → visible amber warning; Confirm stays enabled', async () => {
    previewReply = 'reject';
    await upload(MIXED);
    expect(await screen.findByText(
      "Couldn't check wallet balances — the confirm still deducts; balances may go below zero.",
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm & Credit/ })).toBeEnabled();
  });

  it('UND3b: a non-success reply is also shown as the amber warning (never hidden)', async () => {
    previewReply = { status: 500, body: { success: false, error: 'boom' } };
    await upload(MIXED);
    expect(await screen.findByText(/Couldn't check wallet balances/)).toBeInTheDocument();
  });

  it('UND4: setting OFF → old negative error, no deduction-preview request, "Total Pts"', async () => {
    flags.negativeDeductions = false;
    await upload(MIXED);
    expect(await screen.findByText('• Amount cannot be negative (got -350).')).toBeInTheDocument();
    expect(screen.getByText('Total Pts')).toBeInTheDocument();
    expect(screen.queryByText('Total credited')).toBeNull();
    expect(screen.queryByText('Total deducted')).toBeNull();
    expect(screen.queryByTestId('credits-deductions-panel')).toBeNull();
    expect(screen.queryByTestId('credits-ok-split')).toBeNull();
    expect(previewBodies).toHaveLength(0);
  });

  it('UND5: setting ON but a credit-only file → no deduction-preview request, "Total Pts"', async () => {
    await upload(makeFile([['BJ1', 'One', 30, 40, '', '']]));
    expect(await screen.findByText('Total Pts')).toBeInTheDocument();
    expect(screen.queryByTestId('credits-deductions-panel')).toBeNull();
    expect(screen.queryByTestId('credits-deduction-callout')).toBeNull();
    expect(previewBodies).toHaveLength(0);
  });

  it('UND6: done screen — " · M deductions · Y pts deducted" and a skipped deduction reads "NOT deducted"', async () => {
    confirmReply = { success: true, data: {
      pointsCredited: 1, pointsCreditedTotal: 30, payoutEntriesCreated: 0,
      pointsDeducted: 1, pointsDeductedTotal: 350,
      deductions: [{ outletId: 'BJ1', fieldName: 'Display Bonus', points: 350, balanceBefore: 130, balanceAfter: -220 }],
      skipped: [{ outletId: 'BJ2', fieldName: 'Display Bonus', points: -200, reason: 'OUTLET_NOT_LINKED_TO_PARTNER', kind: 'DEDUCTION' }],
    } };
    await upload(MIXED);
    const btn = await screen.findByRole('button', { name: /Confirm & Credit/ });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);

    expect(await screen.findByText('1 outlet credited · 30 pts · 1 deduction · 350 pts deducted')).toBeInTheDocument();
    expect(screen.getByText('1 row NOT deducted')).toBeInTheDocument();
    expect(screen.getByText('BJ2 · Display Bonus · −200 pts · NOT deducted')).toBeInTheDocument();
  });
  it('UND7: the server says the switch is OFF (stale screen settings) → red call-out, Confirm disabled', async () => {
    previewReply = { status: 400, body: { success: false, error: 'Negative points (deductions) are not turned on for this program.' } };
    await upload(MIXED);
    expect(await screen.findByText(/Negative points \(deductions\) are not turned on for this program\. The negative rows in this file would NOT be deducted/))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm & Credit/ })).toBeDisabled();
  });

  it('UND8: the file had deductions but the confirm applied none (switch turned off meanwhile) → loud "NOT deducted" alert', async () => {
    confirmReply = { success: true, data: { pointsCredited: 1, pointsCreditedTotal: 30, payoutEntriesCreated: 0, skipped: [] } };
    await upload(MIXED);
    const btn = await screen.findByRole('button', { name: /Confirm & Credit/ });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    expect(await screen.findByTestId('credits-deductions-ignored')).toHaveTextContent('2 deduction rows were NOT deducted');
  });
});

