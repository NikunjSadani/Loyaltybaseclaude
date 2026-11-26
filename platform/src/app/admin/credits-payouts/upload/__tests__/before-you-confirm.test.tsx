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
  withServerRequired,
  ackItemsFor,
  ackSignature,
  ACK_ORDER,
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
  deductionsEnabled: true, outlets, priorDeductions: [], ackCategories: [...ACK_ORDER], ...over,
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
  it('BYC2: per PARTNER wallet: two outlets of one partner share one line; held opening balance counted once (U4)', () => {
    const rows = [
      row({ outletId: 'A', amount: 30 }),
      row({ outletId: 'A', amount: -500, fieldId: 'f2' }),
      row({ outletId: 'B', amount: -100, fieldId: 'f2' }),
      row({ outletId: 'C', amount: -10, fieldId: 'f2' }),
    ];
    // The held opening balance is PARTNER-level and repeated on each outlet → counted ONCE per wallet.
    const d = data([
      outlet('A', { walletId: 'W1', partnerId: 'P1', balance: 200, heldOpeningBalance: 150 }),
      outlet('B', { walletId: 'W1', partnerId: 'P1', balance: 200, heldOpeningBalance: 150 }),
      outlet('C', { walletId: null, partnerId: 'P2', balance: null }),
    ]);
    expect(walletLines(rows, d)).toEqual([
      // start = 200 + 150 held (once); before deduct = 350 + 30; after = 380 − 500 − 100
      { key: 'P1', outletCodes: ['A', 'B'], current: 350, held: 150, expired: 0, after: -220 },
      { key: 'P2', outletCodes: ['C'], current: 0, held: null, expired: 0, after: -10 },
    ]);
  });

  it('BYC2b (U3): outlets without a wallet group by PARTNER — one line for the wallet confirm will create', () => {
    const rows = [row({ outletId: 'A', amount: -40 }), row({ outletId: 'B', amount: -60, fieldId: 'f2' })];
    const d = data([
      outlet('A', { walletId: null, partnerId: 'P1', balance: null }),
      outlet('B', { walletId: null, partnerId: 'P1', balance: null }),
    ]);
    expect(walletLines(rows, d)).toEqual([
      { key: 'P1', outletCodes: ['A', 'B'], current: 0, held: null, expired: 0, after: -100 },
    ]);
    // BELOW_ZERO ack key = partnerId|after
    expect(presentCategories(parse(rows), d).find((c) => c.category === 'BELOW_ZERO')!.items[0].key).toBe('P1|-100');
  });

  it('BYC2c (U5): due lots expire AFTER the file credits land — expired = min(dueExpiry, max(0, before-deduct))', () => {
    // balance 500, credit 100, raw dueExpiry 250 → before deduct 600, expired 250, after 600 − 250 − 400 = −50
    const rows = [row({ outletId: 'A', amount: 100 }), row({ outletId: 'A', amount: -400, fieldId: 'f2' })];
    const d = data([outlet('A', { walletId: 'W', partnerId: 'PA', balance: 500, dueExpiry: 250 })]);
    expect(walletLines(rows, d)).toEqual([{ key: 'PA', outletCodes: ['A'], current: 500, held: null, expired: 250, after: -50 }]);
    const below = presentCategories(parse(rows), d).find((c) => c.category === 'BELOW_ZERO')!;
    expect(below.items[0].text).toBe('A · Balance will go below zero: 500 → −50 pts');
    expect(below.items[0].detail).toBe('(after 250 points expiring now are taken off)');
    expect(below.items[0].key).toBe('PA|-50');
  });

  it('BYC2d (U5): the raw dueExpiry is clamped — a wallet already at/below zero expires nothing', () => {
    const rows = [row({ outletId: 'A', amount: -10 })];
    const d = data([outlet('A', { partnerId: 'PA', balance: -40, dueExpiry: 999 })]);
    expect(walletLines(rows, d)).toEqual([{ key: 'PA', outletCodes: ['A'], current: -40, held: null, expired: 0, after: -50 }]);
    const d2 = data([outlet('A', { partnerId: 'PA', balance: 30, dueExpiry: 999 })]);
    expect(walletLines(rows, d2)[0]).toMatchObject({ expired: 30, after: -10 });
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
    expect(below.items[0].text).toBe('BJ1 · Balance will go below zero: 50 → −50 pts'); // 50 + 200 credit − 300
    const repeat = cats.find((c) => c.category === 'REPEAT_DEDUCTION')!;
    // U5: the server's points are net of give-backs.
    expect(repeat.items[0].detail).toBe('Already deducted on 3 Nov 2026 in batch CB-OLD (300 pts still deducted) — check this isn\'t a repeat.');
    expect(cats.every((c) => c.required)).toBe(true);
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

describe('BYC — server-decided acknowledgements', () => {
  it('BYC10: a present category outside ackCategories is listed for information only (no box)', () => {
    const rows = [row({ rowNum: 3, status: 'SKIP', amount: 0 }), row({ rowNum: 4, amount: 200, originalAmount: 199.5 })];
    const cats = presentCategories(parse(rows), data([outlet('BJ1')], { ackCategories: ['ROUNDED'] }));
    expect(cats.map((c) => [c.category, c.required])).toEqual([['SKIPPED', false], ['ROUNDED', true]]);
    render(<BeforeYouConfirm categories={cats} acked={new Set()} onToggle={vi.fn()} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByTestId('ack-info-SKIPPED')).toHaveTextContent('For your information — no tick needed.');
  });

  it('BYC11: withServerRequired — a refused category becomes required; one this screen cannot list gets its own box', () => {
    const rows = [row({ rowNum: 3, status: 'SKIP', amount: 0 })];
    const cats = presentCategories(parse(rows), data([outlet('BJ1')], { ackCategories: [] }));
    const out = withServerRequired(cats, ['SKIPPED', 'BELOW_ZERO']);
    expect(out.map((c) => [c.category, c.required])).toEqual([['SKIPPED', true], ['BELOW_ZERO', true]]);
    expect(out[1].label).toBe('I understand some wallets will go below zero');
    expect(withServerRequired(cats, [])).toBe(cats);
  });
});

describe('BYC — ack keys (byte-identical with the server)', () => {
  it('BYC12: ROUNDED / NOT_APPLIED / REPEAT keys and ackItemsFor (SKIPPED sends no items)', () => {
    const rows = [
      row({ rowNum: 3, status: 'SKIP', amount: 0 }),
      row({ rowNum: 4, outletId: 'BJ1', fieldId: 'f1', amount: 200, originalAmount: 199.5 }),
      row({ rowNum: 5, outletId: 'BJ1', fieldId: 'f2', awardType: 'PAYOUT', amount: 20000, originalAmount: 199.5 }),
      row({ rowNum: 6, outletId: 'X', fieldId: 'f3' }),
      row({ rowNum: 7, outletId: 'BJ1', fieldId: 'f4', amount: -50 }),
    ];
    const d = data([outlet('BJ1', { partnerId: 'P1', balance: 5000 }), outlet('X', { found: false })], {
      priorDeductions: [
        { outletCode: 'BJ1', fieldId: 'f4', batchId: 'b0', batchCode: 'CB-0', confirmedAt: '2026-11-01T00:00:00.000Z', points: 40, givenBack: 10 },
        { outletCode: 'BJ1', fieldId: 'f4', batchId: 'b1', batchCode: 'CB-1', confirmedAt: '2026-11-02T00:00:00.000Z', points: 25 },
      ],
    });
    const cats = presentCategories(parse(rows), d);
    const keys = Object.fromEntries(cats.map((c) => [c.category, c.items.map((i) => i.key)]));
    expect(keys.ROUNDED).toEqual(['BJ1|f1|POINTS|200|199.5', 'BJ1|f2|PAYOUT|20000|199.5']);
    expect(keys.NOT_APPLIED).toEqual(['X|f3']);
    expect(keys.REPEAT_DEDUCTION).toEqual(['BJ1|f4|b0|40', 'BJ1|f4|b1|25']);
    expect(cats.find((c) => c.category === 'REPEAT_DEDUCTION')!.label).toBe('I understand 1 deduction may be a repeat');
    expect(ackItemsFor(cats, ['SKIPPED', 'ROUNDED', 'NOT_APPLIED'])).toEqual({
      ROUNDED: ['BJ1|f1|POINTS|200|199.5', 'BJ1|f2|PAYOUT|20000|199.5'],
      NOT_APPLIED: ['X|f3'],
    });
  });

  it('BYC13 (U1): the tick signature changes when the item KEYS change, not only the wording', () => {
    const rows = [row({ outletId: 'A', amount: -300 })];
    const c1 = presentCategories(parse(rows), data([outlet('A', { partnerId: 'P', balance: 100 })])).find((c) => c.category === 'BELOW_ZERO')!;
    const c2 = presentCategories(parse(rows), data([outlet('A', { partnerId: 'P', balance: 50 })])).find((c) => c.category === 'BELOW_ZERO')!;
    expect(c1.label).toBe(c2.label);                  // same wording ("1 wallet will go below zero")
    expect(ackSignature(c1)).not.toBe(ackSignature(c2)); // different after → different key → tick cleared
  });

  it('BYC14 (U2): server items replace the local list when their keys differ; a missing category is built from them', () => {
    const rows = [row({ outletId: 'A', amount: -300 })];
    const cats = presentCategories(parse(rows), data([outlet('A', { partnerId: 'P', balance: 100 })]));
    const out = withServerRequired(cats, ['BELOW_ZERO', 'REPEAT_DEDUCTION'], {
      BELOW_ZERO:       [{ key: 'P|-260', text: 'Wallet of A: 40 → -260' }],
      REPEAT_DEDUCTION: [{ key: 'A|f1|b9|300', text: 'A · Target — already deducted in CB-9' }],
    });
    const bz = out.find((c) => c.category === 'BELOW_ZERO')!;
    expect(bz.items).toEqual([{ key: 'P|-260', text: 'Wallet of A: 40 → -260' }]);
    const rp = out.find((c) => c.category === 'REPEAT_DEDUCTION')!;
    expect([rp.required, rp.items.length]).toEqual([true, 1]);
    expect(ackItemsFor(out, ['BELOW_ZERO', 'REPEAT_DEDUCTION'])).toEqual({ BELOW_ZERO: ['P|-260'], REPEAT_DEDUCTION: ['A|f1|b9|300'] });
  });

  it('BYC15: OFF_PORTAL_DUPLICATE (server-only) gets its own box with the server rows, last in order', () => {
    const rows = [row({ rowNum: 3, status: 'SKIP', amount: 0 })];
    const cats = presentCategories(parse(rows), data([outlet('BJ1')], { ackCategories: [] }));
    const out = withServerRequired(cats, ['OFF_PORTAL_DUPLICATE', 'SKIPPED'], {
      OFF_PORTAL_DUPLICATE: [{ key: 'BJ1|f1|2026-10|150000', text: 'BJ1 · ₹1,500 — already paid outside the portal on 10 Nov 2026' }],
    });
    expect(out.map((c) => c.category)).toEqual(['SKIPPED', 'OFF_PORTAL_DUPLICATE']);
    const op = out[1];
    expect(op.required).toBe(true);
    expect(op.label).toBe('I understand some payouts may already have been paid outside the portal (off-portal payments register)');
    expect(op.items).toEqual([{ key: 'BJ1|f1|2026-10|150000', text: 'BJ1 · ₹1,500 — already paid outside the portal on 10 Nov 2026' }]);
    expect(ackItemsFor(out, ['OFF_PORTAL_DUPLICATE'])).toEqual({ OFF_PORTAL_DUPLICATE: ['BJ1|f1|2026-10|150000'] });
    expect(ACK_ORDER.at(-1)).toBe('OFF_PORTAL_DUPLICATE');
  });
});
