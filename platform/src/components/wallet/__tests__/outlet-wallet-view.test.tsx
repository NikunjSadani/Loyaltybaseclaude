/// <reference types="vitest/globals" />
/**
 * OW — the shared <OutletWalletView> (partner wallet + sales outlet wallet).
 *
 *   OW1: on a NON-IST device, a row is bucketed into its IST month (matches the download)
 *   OW2: on a NON-IST device, "current month" (empty-history default) is the IST month
 *   OW3: a KPI selection that disappears after a period change falls back to "All Parameters"
 *   OW4: a KPI selection that disappears after the Burn chip falls back to "All Parameters"
 *   OW5: period button exposes aria-haspopup / aria-expanded; X has an aria-label;
 *        From/To labels are bound to their inputs; Escape closes the popover
 *
 * Dates are computed RELATIVE to `new Date()` — never hardcoded.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { OutletWalletView, type OutletWalletViewProps } from '../outlet-wallet-view';
import { TransactionType, WalletBucket, type WalletTransaction, type PayoutLedgerEntry } from '@/types';

const MONTH_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_MS = 330 * 60_000;
/** The IST calendar month `n` months before the current IST month, as {y, m(1-12)}. */
function istMonth(n: number) {
  const nowIst = new Date(Date.now() + IST_MS);
  const d = new Date(Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth() - n, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}
/** An instant at hh:mm IST on the 1st of that IST month. */
function istFirst(mo: { y: number; m: number }, hh: number, mm = 0) {
  return new Date(Date.UTC(mo.y, mo.m - 1, 1, hh, mm) - IST_MS);
}
const ym = (mo: { y: number; m: number }) => `${mo.y}-${String(mo.m).padStart(2, '0')}`;
const lbl = (mo: { y: number; m: number }) => `${MONTH_SHORT[mo.m]} ${mo.y}`;
/** Mid-month, midday instant (unambiguous in every timezone). */
const mid = (mo: { y: number; m: number }) => new Date(Date.UTC(mo.y, mo.m - 1, 15, 6, 30));

function tx(id: string, at: Date, amount: number, fieldName?: string): WalletTransaction {
  return {
    id, walletId: 'w', userId: 'u', type: amount >= 0 ? TransactionType.CREDIT : TransactionType.DEBIT,
    bucket: WalletBucket.EARNED, amount, balanceAfter: 0, description: fieldName ?? 'Points redeemed',
    schemeId: null, invoiceId: null, kpiLabel: fieldName, reversedById: null, reversalReason: null, createdAt: at,
  };
}
function payout(id: string, at: Date, kpiLabel: string, period: string): PayoutLedgerEntry {
  return { id, period, kpiLabel, achievedPct: 100, payoutAmountPaise: 100_000, paidAt: at.toISOString(),
    uploadedAt: at.toISOString(), utr: 'U', status: 'PAID' } as PayoutLedgerEntry;
}

function view(over: Partial<OutletWalletViewProps> = {}) {
  const props: OutletWalletViewProps = {
    balance: null, transactions: [], payouts: [], statementError: false,
    showPointsCard: false, showPayoutCard: false, inclActivationNote: false, loyaltyEnabled: true,
    outletType: 'SSS', outletCode: 'OUT-1', loadStatementDoc: vi.fn(), ...over,
  };
  return render(<OutletWalletView {...props} />);
}
const pickerText = () => screen.getByTestId('period-picker-btn').textContent ?? '';

describe('OW — IST month bucketing on a non-IST device', () => {
  const prevTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
  afterAll(() => { process.env.TZ = prevTz; });
  afterEach(() => { vi.useRealTimers(); });

  it('precondition: the device clock is NOT IST', () => {
    expect(new Date().getTimezoneOffset()).not.toBe(-330);
  });

  it('OW1: a row at 00:30 IST on the 1st (still the previous day locally) is in its IST month', () => {
    const mo = istMonth(2);
    const at = istFirst(mo, 0, 30);
    // Locally (LA) that instant is the previous calendar month.
    expect(at.getMonth() + 1).not.toBe(mo.m);
    view({ payouts: [payout('p1', at, 'Incentive', ym(mo))] });
    expect(pickerText()).toBe(lbl(mo));
    expect(screen.getByText(`Statement · ${lbl(mo)}`)).toBeInTheDocument();
    expect(screen.getByText(/Incentive ·/)).toBeInTheDocument();
  });

  it('OW2: with no history, "current month" is the IST month (same clock as the rows)', () => {
    const next = istMonth(-1);
    const instant = istFirst(next, 1); // 01:00 IST on the 1st of next IST month = previous day locally (LA)
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(instant);
    expect(new Date().getMonth() + 1).not.toBe(next.m);
    view();
    expect(pickerText()).toBe(lbl(next));
  });
});

describe('OW — stale KPI selection', () => {
  it('OW3: a KPI that is not in the newly selected period falls back to "All Parameters"', async () => {
    const older = istMonth(2);
    const recent = istMonth(1);
    view({
      transactions: [tx('t1', mid(older), 100, 'Monthly Target')],
      payouts: [payout('p1', mid(recent), 'Incentive', ym(recent))],
    });
    const select = screen.getByTestId('wallet-kpi-filter') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'Monthly Target' } });
    expect(select.value).toBe('Monthly Target');
    expect(screen.getByText('1 entries')).toBeInTheDocument();

    // Narrow the period to the recent month — "Monthly Target" no longer exists there.
    fireEvent.click(screen.getByTestId('period-picker-btn'));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: ym(recent) } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: ym(recent) } });
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect((screen.getByTestId('wallet-kpi-filter') as HTMLSelectElement).value).toBe(''));
    // The recent payout is visible (not filtered to zero by a stale selection).
    expect(screen.getByText(/Incentive ·/)).toBeInTheDocument();
    expect(screen.getByText('1 entries')).toBeInTheDocument();
  });

  it('OW4: a credit KPI selection resets to "All Parameters" when Burn hides every credit row', async () => {
    const mo = istMonth(1);
    view({ transactions: [tx('t1', mid(mo), 100, 'Monthly Target'), tx('t2', mid(mo), -40)] });
    const select = () => screen.getByTestId('wallet-kpi-filter') as HTMLSelectElement;
    fireEvent.change(select(), { target: { value: 'Monthly Target' } });
    expect(select().value).toBe('Monthly Target');
    fireEvent.click(screen.getByRole('button', { name: 'Burn' }));
    await waitFor(() => expect(select().value).toBe(''));
    expect(screen.getByText('Points redeemed')).toBeInTheDocument();
  });
});

describe('OW — period popover accessibility', () => {
  it('OW5: aria on the trigger + close button, labelled inputs, Escape closes', async () => {
    view();
    const btn = screen.getByTestId('period-picker-btn');
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(btn).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: 'Select period' });
    expect(btn.getAttribute('aria-controls')).toBe(dialog.id);
    expect(screen.getByRole('button', { name: 'Close period picker' })).toBeInTheDocument();
    // Labels are bound to their inputs.
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'month');
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'month');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(btn).toHaveAttribute('aria-expanded', 'false');

    // The X button closes it too.
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole('button', { name: 'Close period picker' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
