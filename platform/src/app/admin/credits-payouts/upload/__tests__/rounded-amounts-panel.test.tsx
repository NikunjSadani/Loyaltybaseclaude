/// <reference types="vitest/globals" />
/**
 * CRP — Credits upload preview: rounded-amounts panel (owner rule 2026-11-12:
 * points + ₹ payouts are credited in whole units, rounded half-up).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { CreditUploadRow } from '@/types';
import { RoundedAmountsPanel, roundedAmountText } from '../_components/rounded-amounts-panel';

function row(p: Partial<CreditUploadRow>): CreditUploadRow {
  return {
    rowNum: 3, outletId: 'WS-001', outletName: 'Anand', fieldId: 'f1', fieldName: 'Volume',
    amount: 0, narration: '', awardType: 'POINTS', status: 'OK', errors: [], ...p,
  };
}

describe('CRP — RoundedAmountsPanel', () => {
  it('CRP1: shows "N amounts rounded" and each original → rounded value (points and ₹)', () => {
    render(<RoundedAmountsPanel rows={[
      row({ rowNum: 3, amount: 200, originalAmount: 199.5 }),
      row({ rowNum: 4, fieldId: 'f2', awardType: 'PAYOUT', amount: 20000, originalAmount: 199.5 }),
      row({ rowNum: 5, fieldId: 'f3', amount: 500 }),                       // whole → not listed
      row({ rowNum: 6, fieldId: 'f4', status: 'ERROR', amount: 1001, originalAmount: 1000.5 }), // not OK → not listed
    ]} />);
    expect(screen.getByText('2 amounts rounded to whole units')).toBeInTheDocument();
    const cells = screen.getAllByTestId('credits-rounded-row').map((e) => e.textContent);
    expect(cells).toEqual(['199.5 → 200 pts', '₹199.5 → ₹200']);
  });

  it('CRP2: renders nothing when no amount was rounded (whole-number uploads unchanged)', () => {
    const { container } = render(<RoundedAmountsPanel rows={[row({ amount: 500 })]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('CRP3: singular copy for one rounded amount', () => {
    render(<RoundedAmountsPanel rows={[row({ amount: 199, originalAmount: 199.4 })]} />);
    expect(screen.getByText('1 amount rounded to whole units')).toBeInTheDocument();
    expect(roundedAmountText(row({ amount: 199, originalAmount: 199.4 }))).toBe('199.4 → 199 pts');
  });
});
