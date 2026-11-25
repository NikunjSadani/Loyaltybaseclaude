/// <reference types="vitest/globals" />
/** DP — "Will be deducted" panel (negative-points deductions). Warnings: before-you-confirm.test.tsx. */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { CreditUploadRow } from '@/types';
import {
  DeductionsPanel,
  deductionAmountText,
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
