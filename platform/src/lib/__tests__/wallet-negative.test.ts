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
      "This outlet owes 841 pts — repaid from its next earnings; it can't redeem until its balance is 0 or more.",
    );
    expect(negativeBalanceNote({ redeemable: 0 })).toBeNull();
  });
  it('F4: an upload deduction behind the negative stretch — partner / staff wording, fields named', () => {
    expect(negativeBalanceNote({ redeemable: -220, owedFromDeduction: true, owedDeductionFields: ['Target Achievement'] })).toBe(
      "Your balance is below zero because points were deducted (Target Achievement). You owe 220 pts — it's repaid from your next earnings. You can redeem again once your balance is 0 or more.",
    );
    expect(negativeBalanceNote({ redeemable: -220, owedFromDeduction: true, owedDeductionFields: ['Target Achievement'] }, 'staff')).toBe(
      "This outlet's balance is below zero because points were deducted (Target Achievement) — it owes 220 pts, repaid from its next earnings; it can't redeem until its balance is 0 or more.",
    );
    expect(negativeBalanceNote({ redeemable: -5, owedFromDeduction: true, owedDeductionFields: [] })).toBe(
      "Your balance is below zero because points were deducted. You owe 5 pts — it's repaid from your next earnings. You can redeem again once your balance is 0 or more.",
    );
  });
  it('F4: both causes are named when a reversal AND a deduction are behind it', () => {
    expect(negativeBalanceNote({ redeemable: -900, owedFromReversal: true, owedFromDeduction: true, owedDeductionFields: ['Target', 'Display'] })).toBe(
      "Your balance is below zero because of a reversed credit and points deducted (Target, Display). You owe 900 pts — it's repaid from your next earnings. You can redeem again once your balance is 0 or more.",
    );
  });
  it('F4: owedFromDeduction false / absent → exactly today\'s text', () => {
    expect(negativeBalanceNote({ redeemable: -2986, owedFromReversal: true, owedFromDeduction: false })).toBe(
      "You owe 2,986 pts from a reversed credit — it's repaid from your next earnings.",
    );
  });
  it('liabilitySplitNote: only when something is owed; singular / plural', () => {
    expect(liabilitySplitNote(0, 0)).toBeNull();
    expect(liabilitySplitNote(undefined, undefined)).toBeNull();
    expect(liabilitySplitNote(841, 1)).toBe(
      'Liability counts positive balances only — 841 pts owed by 1 wallet with a negative balance are not included.',
    );
    expect(liabilitySplitNote(3827, 2)).toBe(
      'Liability counts positive balances only — 3,827 pts owed by 2 wallets with a negative balance are not included.',
    );
  });
});
