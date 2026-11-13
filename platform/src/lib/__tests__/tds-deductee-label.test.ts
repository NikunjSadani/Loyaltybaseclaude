import { describe, it, expect } from 'vitest';
import { deducteeCellLabel } from '../tds-deductee-label';

describe('deducteeCellLabel', () => {
  it('shows a PAN unchanged (and — for an empty key)', () => {
    expect(deducteeCellLabel({ panNumber: 'ABCDE1234F' })).toBe('ABCDE1234F');
    expect(deducteeCellLabel({ panNumber: '' })).toBe('—');
  });

  it('labels a per-deductee no-PAN row with name + outlet codes', () => {
    expect(
      deducteeCellLabel({
        panNumber: '__NO_PAN__:cp1',
        noPanDeductee: { partnerId: 'cp1', clientId: 'bajaj', name: 'Ravi', outletCodes: ['B1', 'B2'] },
      }),
    ).toBe('NO PAN ON FILE · Ravi (B1, B2)');
    expect(
      deducteeCellLabel({
        panNumber: '__NO_PAN__:cp2',
        noPanDeductee: { partnerId: 'cp2', clientId: 'bajaj', name: '', outletCodes: [] },
      }),
    ).toBe('NO PAN ON FILE · Unknown');
  });

  it('labels the "Earlier no-PAN deposits" row', () => {
    expect(deducteeCellLabel({ panNumber: '__NO_PAN__', unlinkedNoPanDeposit: true })).toBe(
      'Earlier no-PAN deposits (not linked to a partner)',
    );
  });

  it('labels the bare unattributed bucket', () => {
    expect(deducteeCellLabel({ panNumber: '__NO_PAN__' })).toBe('NO PAN ON FILE (unattributed)');
  });
});
