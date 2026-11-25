/// <reference types="vitest/globals" />
/**
 * Owner decision 2 (2026-11-19 — the retailer sees a negative balance as it is), in the SHARED wallet pieces:
 *  - BalanceCard: "Available to Redeem −2,986 pts" + "You owe 2,986 pts from a reversed credit — it's repaid from your
 *    next earnings." (generic wording when the debt is not from a reversal); unchanged at 0 or above;
 *  - TransactionItem: a negative running balance reads "Bal −2,986"; the reversal reference shows only when asked
 *    (sales / admin views), never on the partner's own wallet;
 *  - mapApiBalance / mapApiTransaction carry the new optional fields.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { BalanceCard, negativeBalanceNote } from '../balance-card';
import { TransactionItem } from '../transaction-item';
import { mapApiBalance, mapApiTransaction } from '../outlet-wallet-view';
import { TransactionType, WalletBucket, type WalletBalance, type WalletTransaction } from '@/types';

const bal = (redeemable: number, extra: Partial<WalletBalance> = {}): WalletBalance => ({
  earned: 10000, locked: 0, redeemable, redeemed: 2986, expired: 0, available: redeemable, ...extra,
});

describe('BalanceCard — negative balance', () => {
  it('shows the balance as it is with the owner\'s explanation line', () => {
    render(<BalanceCard balance={bal(-2986, { owedPoints: 2986, owedFromReversal: true })} />);
    expect(screen.getByTestId('available-to-redeem').textContent).toBe('−2,986 pts');
    expect(screen.getByTestId('negative-balance-note').textContent).toBe(
      "You owe 2,986 pts from a reversed credit — it's repaid from your next earnings.",
    );
    expect(document.body.textContent).not.toMatch(/₹/);
  });

  it('a negative balance not caused by a reversal gets the generic line', () => {
    expect(negativeBalanceNote({ redeemable: -841 })).toBe("You owe 841 pts — it's repaid from your next earnings.");
  });

  it('B6: staff (sales outlet view / admin) read "This outlet owes …", never the retailer wording "You owe …"', () => {
    render(<BalanceCard balance={bal(-2986, { owedPoints: 2986, owedFromReversal: true })} audience="staff" />);
    expect(screen.getByTestId('negative-balance-note').textContent).toBe(
      "This outlet owes 2,986 pts from a reversed credit — repaid from its next earnings; it can't redeem until its balance is back above zero.",
    );
  });

  it('0 or above: unchanged — no note', () => {
    render(<BalanceCard balance={bal(7014)} />);
    expect(screen.getByTestId('available-to-redeem').textContent).toBe('7,014 pts');
    expect(screen.queryByTestId('negative-balance-note')).toBeNull();
  });
});

const row = (extra: Partial<WalletTransaction> = {}): WalletTransaction => ({
  id: 't1', walletId: 'w', userId: 'u', type: TransactionType.DEBIT, bucket: WalletBucket.EARNED, amount: -10000,
  balanceAfter: -2986, description: 'Credit reversed (Volume · 2026-10) −10,000 · 2,986 owed, repaid from future earnings',
  createdAt: new Date('2026-11-19T06:00:00Z'), reversalRef: 'REV-1', ...extra,
});

describe('TransactionItem — the reversal row explains itself', () => {
  it('partner view: the passbook text and "Bal −2,986", no reference', () => {
    render(<TransactionItem transaction={row()} />);
    expect(screen.getByText('Credit reversed (Volume · 2026-10) −10,000 · 2,986 owed, repaid from future earnings')).toBeTruthy();
    expect(screen.getByText('Bal −2,986')).toBeTruthy();
    expect(screen.queryByTestId('transaction-reversal-ref')).toBeNull();
  });

  it('sales / admin view: plus the reversal reference', () => {
    render(<TransactionItem transaction={row()} showReversalRef />);
    expect(screen.getByTestId('transaction-reversal-ref').textContent).toBe('Reversal ref REV-1');
  });
});

describe('mappers carry the new optional fields only when present', () => {
  it('mapApiBalance', () => {
    const base = {
      earnedPoints: 1, lockedPoints: 0, redeemablePoints: -5, redeemedPoints: 0, expiredPoints: 0, lifetimeEarned: 1, lifetimeRedeemed: 0,
    };
    expect(mapApiBalance({ ...base, owedPoints: 5, owedFromReversal: true })).toMatchObject({ redeemable: -5, owedPoints: 5, owedFromReversal: true });
    expect(mapApiBalance({ ...base, redeemablePoints: 5 })).not.toHaveProperty('owedPoints');
  });

  it('mapApiTransaction sets reversalRef only for CREDIT_REVERSAL rows', () => {
    const t = { id: 'x', transactionType: 'DEBIT_ADJUSTMENT', description: 'd', points: -1, date: '2026-11-19T00:00:00Z', balanceAfter: 0 };
    expect(mapApiTransaction({ ...t, referenceType: 'CREDIT_REVERSAL', referenceId: 'R1' }).reversalRef).toBe('R1');
    expect(mapApiTransaction({ ...t, referenceType: 'ORDER', referenceId: 'O1' }).reversalRef).toBeNull();
  });
});

describe('upload deductions (U1 / F4)', () => {
  const base = {
    earnedPoints: 1, lockedPoints: 0, redeemablePoints: -220, redeemedPoints: 0, expiredPoints: 0, lifetimeEarned: 1, lifetimeRedeemed: 0,
  };
  it('F4: mapApiBalance carries owedFromDeduction + fields; the staff card names the deduction', () => {
    const bal2 = mapApiBalance({ ...base, owedPoints: 220, owedFromDeduction: true, owedDeductionFields: ['Target Achievement'] });
    expect(bal2).toMatchObject({ owedFromDeduction: true, owedDeductionFields: ['Target Achievement'] });
    render(<BalanceCard balance={bal2} audience="staff" />);
    expect(screen.getByText(/because points were deducted \(Target Achievement\) — it owes 220 pts/)).toBeInTheDocument();
    expect(mapApiBalance({ ...base })).not.toHaveProperty('owedFromDeduction');
  });

  it('U1: an upload deduction row shows the server text as its header, no field-name prefix / sub-line', () => {
    const text = '320 points deducted — Target Achievement, November 2026 · returns';
    const t = {
      id: 'u', transactionType: 'DEBIT_ADJUSTMENT', description: text, narration: text, fieldName: 'Target Achievement',
      points: -320, date: '2026-11-19T00:00:00Z', balanceAfter: -220, referenceType: 'CREDIT_BATCH', referenceId: 'b1',
    };
    const m = mapApiTransaction(t);
    expect(m.description).toBe(text);
    expect(m.narration).toBeUndefined();
    expect(m.kpiLabel).toBe('Target Achievement'); // the KPI filter still finds it
    // A manual debit (no field name) keeps its own description.
    expect(mapApiTransaction({ ...t, fieldName: null, narration: null, description: 'Manual correction' }).description).toBe('Manual correction');
    // A credit keeps field name header + narration sub-line.
    const c = mapApiTransaction({ ...t, transactionType: 'CREDIT_POINTS_EARNED', narration: 'Scheme', points: 50 });
    expect([c.description, c.narration]).toEqual(['Target Achievement', 'Scheme']);
  });
});
