/// <reference types="vitest/globals" />
/**
 * TDD — Wallet default statement period is computed from real data / today
 * (regression guard for the hardcoded `2026-05` default bug).
 *
 * The statement used to open on a HARDCODED month (2026-05) and stayed empty for any
 * partner whose activity was in a different month. The default is now:
 *   - the FULL activity range [minMonth..maxMonth] once data has loaded, so a payout in
 *     ANY month is visible on open without hunting;
 *   - the CURRENT month (from `new Date()`) when there is no activity at all;
 *   - never overridden once the partner picks a range of their own.
 *
 * All dates are computed RELATIVE to `new Date()` — never hardcoded — per the
 * date-relative-tests agreement.
 *
 * D1: a partner whose only payout is in a PAST month opens showing that month (not empty)
 * D2: a partner with NO activity opens on the CURRENT month, empty, picker still usable
 * D3: a manually picked narrower range is NOT overridden on a later re-render
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Anil Traders', ownerName: 'Owner', partnerCode: 'P1',
    outletType: 'WHOLESALER', hasPointsActivity: false, hasPayoutActivity: true,
  }),
}));

import WalletPage from '../page';

/* ── Relative-date helpers (never hardcode a month) ───────────────────────────── */
const MONTH_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthsAgo(n: number): Date { const now = new Date(); return new Date(now.getFullYear(), now.getMonth() - n, 1); }
function ym(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function pickerLabel(d: Date): string { return `${MONTH_SHORT[d.getMonth() + 1]} ${d.getFullYear()}`; }

function makePayout(overrides: Record<string, unknown>) {
  return {
    id: 'p', status: 'PAID', kpiLabel: 'Payout', payoutAmountPaise: 100_000,
    utr: 'UTR', narration: null, ...overrides,
  };
}

function stubFetch(payouts: unknown[]) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = url as string;
    if (u.includes('/api/wallet/transactions'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { transactions: [] } }) });
    if (u.includes('/api/partner/payouts'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { payouts } }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

async function renderWallet(payouts: unknown[]) {
  stubFetch(payouts);
  render(<WalletPage />);
  await waitFor(
    () => expect(screen.getByTestId('statement-controls-row')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe('D — Wallet default period (regression: no hardcoded month)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('D1: a payout in a PAST month is visible on open (not an empty current/May month)', async () => {
    const past = monthsAgo(2);
    const paidAt = new Date(past.getFullYear(), past.getMonth(), 15).toISOString();
    await renderWallet([makePayout({ id: 'old', kpiLabel: 'Field Visibility Payout', period: ym(past), paidAt })]);

    // The payout ROW (kpiLabel · month — the "·" distinguishes it from the KPI-filter
    // <option> that carries the same label) is on screen; the bug hid it behind an empty
    // hardcoded window.
    expect(await screen.findByText(/Field Visibility Payout ·/)).toBeInTheDocument();
    // And the period selector snapped to that past month, not the current month or May 2026.
    const pickerBtn = screen.getByTestId('period-picker-btn');
    expect(pickerBtn.textContent).toContain(pickerLabel(past));
  });

  it('D2: a partner with NO activity opens on the CURRENT month, empty, picker usable', async () => {
    await renderWallet([]);
    const now = new Date();
    const pickerBtn = screen.getByTestId('period-picker-btn');
    expect(pickerBtn.textContent).toContain(pickerLabel(now));
    expect(screen.getByText(/No transactions for this period/i)).toBeInTheDocument();

    // Picker opens and the To field allows up to the current month (max >= today).
    fireEvent.click(pickerBtn);
    await waitFor(() => expect(document.querySelectorAll('input[type="month"]').length).toBe(2));
    const toInput = document.querySelectorAll('input[type="month"]')[1] as HTMLInputElement;
    expect(toInput.max >= ym(now)).toBe(true);
  });

  it('D3: a manually picked narrower range is NOT overridden on a later re-render', async () => {
    const older  = monthsAgo(2);
    const recent = monthsAgo(1);
    await renderWallet([
      makePayout({ id: 'old', kpiLabel: 'Older Payout',  period: ym(older),
        paidAt: new Date(older.getFullYear(), older.getMonth(), 10).toISOString() }),
      makePayout({ id: 'new', kpiLabel: 'Recent Payout', period: ym(recent),
        paidAt: new Date(recent.getFullYear(), recent.getMonth(), 10).toISOString() }),
    ]);

    // Default snap shows BOTH payout ROWS (full activity range). Match the row (with "·")
    // rather than the same-label KPI-filter <option>.
    expect(await screen.findByText(/Older Payout ·/)).toBeInTheDocument();
    expect(screen.getByText(/Recent Payout ·/)).toBeInTheDocument();

    // Partner narrows the window to the recent month only.
    fireEvent.click(screen.getByTestId('period-picker-btn'));
    await waitFor(() => expect(document.querySelectorAll('input[type="month"]').length).toBe(2));
    const monthInputs = document.querySelectorAll('input[type="month"]');
    fireEvent.change(monthInputs[0], { target: { value: ym(recent) } }); // From
    fireEvent.change(monthInputs[1], { target: { value: ym(recent) } }); // To
    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(screen.queryByText(/Older Payout ·/)).not.toBeInTheDocument());
    expect(screen.getByText(/Recent Payout ·/)).toBeInTheDocument();

    // A re-render from an unrelated control must NOT reset the pick back to the full range.
    fireEvent.click(screen.getByText('Earn'));
    expect(screen.queryByText(/Older Payout ·/)).not.toBeInTheDocument();
    expect(screen.getByText(/Recent Payout ·/)).toBeInTheDocument();
  });
});
