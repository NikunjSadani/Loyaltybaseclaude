/// <reference types="vitest/globals" />
/** DP — "Will be deducted" panel + the below-zero helpers (negative-points deductions). */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { CreditUploadRow } from '@/types';
import {
  DeductionsPanel,
  DeductionBalanceCallout,
  belowZeroLines,
  blockingOutlets,
  deductionAmountText,
  deductionOutletCodes,
} from '../_components/deductions-panel';

const row = (over: Partial<CreditUploadRow>): CreditUploadRow => ({
  rowNum: 3, outletId: 'BJ1', outletName: 'One', fieldId: 'f1', fieldName: 'Target', amount: -320,
  narration: '', awardType: 'POINTS', status: 'OK', errors: [], ...over,
});

describe('DP — DeductionsPanel', () => {
  it('DP1: renders nothing without deduction rows (credit / payout / skip / error rows only)', () => {
    const { container } = render(<DeductionsPanel rows={[
      row({ amount: 100 }),
      row({ awardType: 'PAYOUT', amount: 10000 }),
      row({ status: 'SKIP', amount: 0, originalAmount: -0.4 }),
      row({ status: 'ERROR', amount: -60000 }),
    ]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('DP2: lists each deduction with typed → rounded text', () => {
    render(<DeductionsPanel rows={[
      row({ rowNum: 3, amount: -320 }),
      row({ rowNum: 4, outletId: 'BJ2', fieldName: 'Display', amount: -200, originalAmount: -199.5 }),
      row({ rowNum: 5, amount: 50 }),
    ]} />);
    expect(screen.getByTestId('credits-deductions-panel')).toHaveTextContent('Will be deducted — 2 rows · 520 pts');
    expect(screen.getByText('Row 3 · BJ1 · Target')).toBeInTheDocument();
    expect(screen.getByText('Row 4 · BJ2 · Display')).toBeInTheDocument();
    expect(screen.getAllByTestId('credits-deduction-row').map((e) => e.textContent))
      .toEqual(['−320 pts', '−199.5 → −200 pts']);
  });

  it('DP3: shows the first 20 and "…and N more"', () => {
    const rows = Array.from({ length: 23 }, (_, i) => row({ rowNum: i + 3, fieldId: `f${i}`, amount: -1 }));
    render(<DeductionsPanel rows={rows} />);
    expect(screen.getAllByTestId('credits-deduction-row')).toHaveLength(20);
    expect(screen.getByText('…and 3 more — see the downloaded report.')).toBeInTheDocument();
  });

  it('DP4: deductionAmountText formats thousands with en-IN', () => {
    expect(deductionAmountText(row({ amount: -120000 }))).toBe('−1,20,000 pts');
  });
});

describe('DP — balance helpers + call-out', () => {
  const rows = [
    row({ outletId: 'BJ1', amount: 30, fieldId: 'a' }),
    row({ outletId: 'BJ1', amount: -350, fieldId: 'b' }),
    row({ outletId: 'BJ2', amount: -200, fieldId: 'b' }),
    row({ outletId: 'BJ1', awardType: 'PAYOUT', amount: 99999, fieldId: 'c' }), // payouts never touch the wallet
  ];

  it('DP5: deductionOutletCodes = unique deduction outlets in file order', () => {
    expect(deductionOutletCodes(rows)).toEqual(['BJ1', 'BJ2']);
  });

  it('DP6: belowZeroLines = balance + credits − deductions, linked outlets only; null balance = 0', () => {
    expect(belowZeroLines(rows, [
      { outletCode: 'BJ1', linked: true, balance: 1200, ready: true, reason: null },
      { outletCode: 'BJ2', linked: true, balance: null, ready: true, reason: null },
    ])).toEqual([{ outletCode: 'BJ2', current: 0, after: -200 }]);
    expect(belowZeroLines(rows, [
      { outletCode: 'BJ1', linked: true, balance: 100, ready: true, reason: null },
      { outletCode: 'BJ2', linked: false, balance: null, ready: false, reason: null },
    ])).toEqual([{ outletCode: 'BJ1', current: 100, after: -220 }]);
  });

  it('DP7: blockingOutlets = linked && !ready (an unlinked outlet is skipped, not refused)', () => {
    expect(blockingOutlets({ status: 'ok', outlets: [
      { outletCode: 'A', linked: true, balance: 0, ready: false, reason: 'x' },
      { outletCode: 'B', linked: false, balance: null, ready: false, reason: null },
      { outletCode: 'C', linked: true, balance: 0, ready: true, reason: null },
    ] }).map((o) => o.outletCode)).toEqual(['A']);
    expect(blockingOutlets({ status: 'loading' })).toEqual([]);
    expect(blockingOutlets(null)).toEqual([]);
  });

  it('DP8: call-out renders en-IN "1,200 → −320"-style lines and the loading text', () => {
    const { rerender } = render(<DeductionBalanceCallout rows={rows} state={{ status: 'loading' }} />);
    expect(screen.getByText('Checking wallet balances…')).toBeInTheDocument();
    rerender(<DeductionBalanceCallout rows={[row({ outletId: 'BJ1', amount: -1520 })]} state={{ status: 'ok', outlets: [
      { outletCode: 'BJ1', linked: true, balance: 1200, ready: true, reason: null },
    ] }} />);
    expect(screen.getByTestId('credits-deduction-below-zero')).toHaveTextContent('BJ1 · Balance will go below zero: 1,200 → −320');
  });

  it('DP9: an outlet missing from the reply is called out, not silently dropped', () => {
    render(<DeductionBalanceCallout rows={rows} state={{ status: 'ok', outlets: [
      { outletCode: 'BJ1', linked: true, balance: 5000, ready: true, reason: null },
    ] }} />);
    expect(screen.getByText(/balance not returned — couldn't check/)).toBeInTheDocument();
  });

  it('DP10: nothing to warn about → renders nothing', () => {
    const { container } = render(<DeductionBalanceCallout rows={rows} state={{ status: 'ok', outlets: [
      { outletCode: 'BJ1', linked: true, balance: 5000, ready: true, reason: null },
      { outletCode: 'BJ2', linked: true, balance: 5000, ready: true, reason: null },
    ] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
