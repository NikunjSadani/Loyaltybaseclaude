/// <reference types="vitest/globals" />
/**
 * CRP — Credits upload preview: rounded amounts (owner rule 2026-11-12: points + ₹ payouts are applied in whole
 * units). The rows are listed under "Before you confirm" → ROUNDED (see before-you-confirm.test.tsx).
 */
import { describe, it, expect } from 'vitest';
import type { CreditUploadRow } from '@/types';
import { ROUNDING_COPY, roundedAmountText, roundedRows } from '../_components/rounded-amounts-panel';

function row(p: Partial<CreditUploadRow>): CreditUploadRow {
  return {
    rowNum: 3, outletId: 'WS-001', outletName: 'Anand', fieldId: 'f1', fieldName: 'Volume',
    amount: 0, narration: '', awardType: 'POINTS', status: 'OK', errors: [], ...p,
  };
}

describe('CRP — rounded amounts', () => {
  it('CRP1: original → rounded text for points, ₹ and deductions', () => {
    expect(roundedAmountText(row({ amount: 200, originalAmount: 199.5 }))).toBe('199.5 → 200 pts');
    expect(roundedAmountText(row({ awardType: 'PAYOUT', amount: 20000, originalAmount: 199.5 }))).toBe('₹199.5 → ₹200');
    expect(roundedAmountText(row({ amount: 199, originalAmount: 199.4 }))).toBe('199.4 → 199 pts');
    expect(roundedAmountText(row({ amount: -200, originalAmount: -199.5 }))).toBe('−199.5 → −200 pts');
  });

  it('CRP2: roundedRows = OK rows with a typed amount only', () => {
    const rows = [
      row({ rowNum: 3, amount: 200, originalAmount: 199.5 }),
      row({ rowNum: 5, amount: 500 }),
      row({ rowNum: 6, status: 'ERROR', amount: 1001, originalAmount: 1000.5 }),
    ];
    expect(roundedRows(rows).map((r) => r.rowNum)).toEqual([3]);
  });

  it('CRP3: rounding copy says nearest whole unit, .5 away from zero (U10)', () => {
    expect(ROUNDING_COPY).toMatch(/nearest whole unit \(\.5 goes away from zero\)/);
  });
});
