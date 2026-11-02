/**
 * Regression tests for TransactionItem — the partner wallet statement row.
 *
 * Guards the sign rendering: the component owns the direction prefix (+/−) via
 * `amtSign`, and the stored `amount` is SIGNED (negative on debit/expiry, per the
 * backend wallet convention). The numeric part must therefore render as a
 * MAGNITUDE — otherwise a debit shows the double sign "−-6,939" (the bug a Bajaj
 * migration opening-balance DEBIT_ADJUSTMENT surfaced on 2026-11-02).
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TransactionItem } from '../wallet/transaction-item';
import { TransactionType, WalletBucket, type WalletTransaction } from '@/types';

const tx = (over: Partial<WalletTransaction>): WalletTransaction => ({
  id: 't1', walletId: 'w1', userId: 'u1',
  type: TransactionType.CREDIT, bucket: WalletBucket.REDEEMABLE,
  amount: 0, balanceAfter: 0, description: 'x',
  createdAt: new Date('2026-11-02T06:00:00.000Z'),
  ...over,
});

const amountText = () =>
  screen.getByText((_, el) => el?.tagName === 'P' && /pts$/.test(el.textContent ?? '') && /\d/.test(el.textContent ?? ''))
    .textContent?.replace(/\s+/g, '') ?? '';

describe('TransactionItem sign rendering', () => {
  it('a signed-negative DEBIT renders a single minus, not "−-"', () => {
    render(<TransactionItem transaction={tx({ type: TransactionType.DEBIT, amount: -6939, balanceAfter: 3503 })} />);
    const t = amountText();
    expect(t).toContain('−6,939');     // single U+2212 prefix + magnitude
    expect(t).not.toContain('−-');     // no double sign
    expect(t).not.toContain('-6,939'); // no raw ASCII minus from the number
  });

  it('a signed-negative EXPIRE renders a single minus', () => {
    render(<TransactionItem transaction={tx({ type: TransactionType.EXPIRE, amount: -451, balanceAfter: 0 })} />);
    const t = amountText();
    expect(t).toContain('−451');
    expect(t).not.toContain('−-');
  });

  it('a CREDIT renders "+" and the magnitude', () => {
    render(<TransactionItem transaction={tx({ type: TransactionType.CREDIT, amount: 10442, balanceAfter: 10442 })} />);
    expect(amountText()).toContain('+10,442');
  });
});
