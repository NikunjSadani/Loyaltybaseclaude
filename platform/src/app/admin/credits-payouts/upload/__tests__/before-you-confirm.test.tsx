/// <reference types="vitest/globals" />
/** BYC — "Before you confirm" derivations + UI (owner rule: no silent failure). */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { CreditParseResult, CreditUploadRow } from '@/types';
import {
  BeforeYouConfirm,
  UploadPreviewStatus,
  notAppliedRows,
  notReadyOutlets,
  presentCategories,
  previewRequestBody,
  repeatDeductionRows,
  walletLines,
  type UploadPreviewData,
  type UploadPreviewOutlet,
} from '../_components/before-you-confirm';

const row = (over: Partial<CreditUploadRow>): CreditUploadRow => ({
  rowNum: 3, outletId: 'BJ1', outletName: 'One', fieldId: 'f1', fieldName: 'Target', amount: 100,
  narration: '', awardType: 'POINTS', status: 'OK', errors: [], ...over,
});
const outlet = (outletCode: string, over: Partial<UploadPreviewOutlet> = {}): UploadPreviewOutlet => ({
  outletCode, found: true, linked: true, walletId: `w-${outletCode}`, partnerId: `p-${outletCode}`,
  balance: 0, heldOpeningBalance: null, ready: true, reason: null, code: null, ...over,
});
const data = (outlets: UploadPreviewOutlet[], over: Partial<UploadPreviewData> = {}): UploadPreviewData => ({
  deductionsEnabled: true, outlets, priorDeductions: [], ...over,
});
const parse = (rows: CreditUploadRow[]): CreditParseResult => ({
  headerError: null, rows, hasErrors: false, canProceed: true,
  summary: {
    total: rows.length, ok: rows.filter((r) => r.status === 'OK').length, skipped: rows.filter((r) => r.status === 'SKIP').length,
    errors: 0, totalPoints: 0, totalPayoutPaise: 0, rounded: rows.filter((r) => r.status === 'OK' && r.originalAmount !== undefined).length,
    deducted: rows.filter((r) => r.status === 'OK' && r.amount < 0).length, totalDeductedPoints: 0,
  },
});

describe('BYC — request body', () => {
  it('BYC1: every OK POINTS outlet (credits AND deductions); lines = deduction rows only; payout-only → null', () => {
    const rows = [
      row({ outletId: 'A', amount: 50 }),
      row({ outletId: 'B', amount: -20, fieldId: 'f2' }),
      row({ outletId: 'C', awardType: 'PAYOUT', amount: 10000 }),
      row({ outletId: 'D', status: 'SKIP', amount: 0 }),
    ];
    expect(previewRequestBody(rows, '2026-10')).toEqual({
      outletCodes: ['A', 'B'], period: '2026-10', lines: [{ outletCode: 'B', fieldId: 'f2' }],
    });
    expect(previewRequestBody([row({ awardType: 'PAYOUT', amount: 100 })], '2026-10')).toBeNull();
  });
});

describe('BYC — derivations', () => {
  it('BYC2: per WALLET after: two outlets of one partner share one wallet line; held opening balance included', () => {
    const rows = [
      row({ outletId: 'A', amount: 30 }),
      row({ outletId: 'A', amount: -500, fieldId: 'f2' }),
      row({ outletId: 'B', amount: -100, fieldId: 'f2' }),
      row({ outletId: 'C', amount: -10, fieldId: 'f2' }),
    ];
    const d = data([
      outlet('A', { walletId: 'W1', balance: 200, heldOpeningBalance: 150 }),
      outlet('B', { walletId: 'W1', balance: 200 }),
      outlet('C', { walletId: null, balance: null }),
    ]);
    expect(walletLines(rows, d)).toEqual([
      // current = 200 + 150 held; after = 350 + 30 − 500 − 100
      { key: 'W1', outletCodes: ['A', 'B'], current: 350, held: 150, after: -220 },
      { key: 'outlet:C', outletCodes: ['C'], current: 0, held: null, after: -10 },
    ]);
  });

  it('BYC3: a wallet the file only credits is never a below-zero line', () => {
    expect(walletLines([row({ outletId: 'A', amount: 5 })], data([outlet('A', { balance: -900 })]))).toEqual([]);
  });

  it('BYC4: not applied = found false (server reason) / linked false / missing; they are left out of wallet lines', () => {
    const rows = [
      row({ outletId: 'A' }), row({ outletId: 'B', amount: -5 }), row({ outletId: 'C' }),
    ];
    const d = data([
      outlet('A', { found: false, reason: 'Outlet A was deactivated on 3 Nov' }),
      outlet('B', { linked: false }),
    ]);
    expect(notAppliedRows(rows, d).map((x) => [x.row.outletId, x.reason])).toEqual([
      ['A', 'Outlet A was deactivated on 3 Nov'],
      ['B', 'Outlet is not linked to a partner (onboard / KYC it first).'],
      ['C', "The server check didn't return this outlet — it may not be applied."],
    ]);
    expect(walletLines(rows, d)).toEqual([]);
  });

  it('BYC5: repeat = deduction with a prior one for the same outlet + field; not-ready = linked deduction outlets with ready false', () => {
    const rows = [row({ outletId: 'A', amount: -5, fieldId: 'f1' }), row({ outletId: 'A', amount: -5, fieldId: 'f9' }), row({ outletId: 'B', amount: 50 })];
    const prior = { outletCode: 'A', fieldId: 'f1', batchId: 'b0', batchCode: 'CB-OLD', confirmedAt: '2026-11-03T06:00:00.000Z', points: 5 };
    const d = data([outlet('A', { ready: false, reason: 'not prepared' }), outlet('B', { ready: false })], { priorDeductions: [prior] });
    expect(repeatDeductionRows(rows, d).map((x) => x.row.fieldId)).toEqual(['f1']);
    expect(notReadyOutlets(rows, d).map((o) => o.outletCode)).toEqual(['A']); // B only gets credits → ready ignored
  });

  it('BYC6: presentCategories — only present ones, plain checkbox labels; a clean file has none', () => {
    expect(presentCategories(parse([row({})]), data([outlet('BJ1')]))).toEqual([]);
    const rows = [
      row({ rowNum: 3, status: 'SKIP', amount: 0, skipReason: 'blank' }),
      row({ rowNum: 4, amount: 200, originalAmount: 199.5 }),
      row({ rowNum: 5, outletId: 'X' }),
      row({ rowNum: 6, outletId: 'BJ1', amount: -300, fieldId: 'f1' }),
    ];
    const d = data([outlet('BJ1', { balance: 50 }), outlet('X', { found: false, reason: 'gone' })], {
      priorDeductions: [{ outletCode: 'BJ1', fieldId: 'f1', batchId: 'b0', batchCode: 'CB-OLD', confirmedAt: '2026-11-03T06:00:00.000Z', points: 300 }],
    });
    const cats = presentCategories(parse(rows), d);
    expect(cats.map((c) => [c.category, c.label])).toEqual([
      ['SKIPPED', 'I understand 1 row will not be credited (blank, zero or not applicable)'],
      ['ROUNDED', 'I understand 1 row was rounded to whole units'],
      ['NOT_APPLIED', "I understand 1 row won't be applied (outlet not found or not linked)"],
      ['BELOW_ZERO', 'I understand 1 wallet will go below zero'],
      ['REPEAT_DEDUCTION', 'I understand 1 deduction may be a repeat'],
    ]);
    const below = cats.find((c) => c.category === 'BELOW_ZERO')!;
    expect(below.items[0].text).toBe('BJ1 · Balance will go below zero: 50 → −50'); // 50 + 200 credit − 300
    const repeat = cats.find((c) => c.category === 'REPEAT_DEDUCTION')!;
    expect(repeat.items[0].detail).toBe('Already deducted on 3 Nov 2026 in batch CB-OLD — check this isn\'t a repeat.');
  });

  it('BYC7: counts are en-IN formatted in labels (1,164 rows)', () => {
    const rows = Array.from({ length: 1164 }, (_, i) => row({ rowNum: i + 3, fieldId: `f${i}`, status: 'SKIP', amount: 0 }));
    expect(presentCategories(parse(rows), null)[0].label).toBe('I understand 1,164 rows will not be credited (blank, zero or not applicable)');
  });
});

describe('BYC — UI', () => {
  it('BYC8: one checkbox per category, first 20 rows + "…and N more"; nothing for no categories', () => {
    const rows = Array.from({ length: 23 }, (_, i) => row({ rowNum: i + 3, fieldId: `f${i}`, status: 'SKIP', amount: 0 }));
    const cats = presentCategories(parse(rows), null);
    const onToggle = vi.fn();
    const { rerender, container } = render(<BeforeYouConfirm categories={cats} acked={new Set()} onToggle={onToggle} />);
    expect(screen.getAllByTestId('ack-item-SKIPPED')).toHaveLength(20);
    expect(screen.getByText('…and 3 more — see the downloaded report.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('I understand 23 rows will not be credited (blank, zero or not applicable)'));
    expect(onToggle).toHaveBeenCalledWith('SKIPPED');
    rerender(<BeforeYouConfirm categories={[]} acked={new Set()} onToggle={onToggle} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('BYC9: preview status — loading is a live status; failure shows the reason + Check again', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<UploadPreviewStatus state={{ status: 'loading' }} onRetry={onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking wallet balances…');
    rerender(<UploadPreviewStatus state={{ status: 'error', message: 'boom.' }} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't check wallet balances — boom.");
    expect(screen.getByRole('alert')).toHaveTextContent("If a wallet isn't prepared for deductions, the whole confirm is refused.");
    fireEvent.click(screen.getByRole('button', { name: /Check again/ }));
    expect(onRetry).toHaveBeenCalled();
  });
});
