/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import { formatSignedPoints, liabilitySplitNote, negativeBalanceNote } from '../wallet-negative';

describe('wallet-negative — shared wording (owner decisions 2, D1, D2 — 2026-11-19)', () => {
  it('formatSignedPoints uses a real minus sign', () => {
    expect(formatSignedPoints(-2986)).toBe('−2,986');
    expect(formatSignedPoints(7014)).toBe('7,014');
  });
  it('negativeBalanceNote: retailer vs staff wording; null at or above zero', () => {
    expect(negativeBalanceNote({ redeemable: -2986, owedFromReversal: true })).toBe(
      "You owe 2,986 pts from a reversed credit — it's repaid from your next earnings.",
    );
    expect(negativeBalanceNote({ redeemable: -841 }, 'staff')).toBe(
      "This outlet owes 841 pts — repaid from its next earnings; it can't redeem until its balance is back above zero.",
    );
    expect(negativeBalanceNote({ redeemable: 0 })).toBeNull();
  });
  it('liabilitySplitNote: only when something is owed; singular / plural', () => {
    expect(liabilitySplitNote(0, 0)).toBeNull();
    expect(liabilitySplitNote(undefined, undefined)).toBeNull();
    expect(liabilitySplitNote(841, 1)).toBe(
      'Liability counts positive balances only; 841 pts owed by 1 outlet with a negative balance is shown separately.',
    );
    expect(liabilitySplitNote(3827, 2)).toBe(
      'Liability counts positive balances only; 3,827 pts owed by 2 outlets with a negative balance are shown separately.',
    );
  });
});
