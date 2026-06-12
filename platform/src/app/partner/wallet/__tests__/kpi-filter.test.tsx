/// <reference types="vitest/globals" />
/**
 * TDD — KPI filter in partner wallet (POINTS track)
 *
 * Outlets want to filter their transaction history by a specific KPI
 * (e.g. "Monthly Sales Target" credits only, or "Visibility" credits only).
 *
 * Rules:
 *  - Filter is a <select> with data-testid="wallet-kpi-filter"
 *  - Options are derived from the kpiLabel values on transactions
 *    for the selected period (plus "All KPIs" as default)
 *  - Visibility KPI option appears only for RETAILER/MT outlets
 *    (those types are eligible for visibility incentives)
 *  - Selecting a KPI hides transactions with a different / null kpiLabel
 *  - Selecting "All KPIs" shows everything again
 *
 * W1: POINTS-track wallet has a data-testid="wallet-kpi-filter" select
 * W2: Dropdown has "All Parameters" + at least one KPI from transactions
 * W3: Selecting a KPI hides transactions with a different kpiLabel
 * W4: Selecting "All Parameters" restores all transactions
 * W5: WHOLESALER session has NO Visibility KPI option (not eligible)
 * W6: RETAILER session DOES have a Visibility KPI option
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@/lib/redemption-store', () => ({
  loadRedemptions: () => [],
}));

import WalletPage from '../page';

const SESSION_KEY = 'partner_outlet_type_demo';

describe('W — KPI filter in partner wallet (POINTS track)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // Helper: render wallet and wait for spinner to clear (500ms load delay in page)
  async function renderWallet() {
    render(<WalletPage />);
    // The wallet has a 350-500ms load delay; wait for content
    await waitFor(
      () => expect(screen.queryByTestId('wallet-kpi-filter')).toBeInTheDocument(),
      { timeout: 3000 },
    );
  }

  it('W1: POINTS-track wallet shows a kpi-filter select', async () => {
    localStorage.setItem(SESSION_KEY, 'WHOLESALER');
    await renderWallet();
    const select = screen.getByTestId('wallet-kpi-filter');
    expect(select.tagName.toLowerCase()).toBe('select');
  });

  it('W2: dropdown has "All Parameters" + at least one KPI from transactions', async () => {
    localStorage.setItem(SESSION_KEY, 'WHOLESALER');
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '');
    expect(options.some(t => /all parameters/i.test(t))).toBe(true);
    expect(options.length).toBeGreaterThan(1);
  });

  it('W3: selecting a KPI hides transactions with a different kpiLabel', async () => {
    localStorage.setItem(SESSION_KEY, 'WHOLESALER');
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option'));
    const kpiOpt  = options.find(o => !/all parameters/i.test(o.textContent ?? ''));
    if (!kpiOpt) return;

    fireEvent.change(select, { target: { value: kpiOpt.value } });

    // Redemption entries have no kpiLabel — they should be hidden
    await waitFor(() => {
      const redemptions = screen
        .queryAllByText(/redemption.*amazon voucher/i)
        .filter(el => el.closest('[data-testid="transaction-item"]'));
      expect(redemptions.length).toBe(0);
    });
  });

  it('W4: selecting "All Parameters" restores all transactions', async () => {
    localStorage.setItem(SESSION_KEY, 'WHOLESALER');
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option'));
    const kpiOpt  = options.find(o => !/all parameters/i.test(o.textContent ?? ''));
    if (!kpiOpt) return;

    fireEvent.change(select, { target: { value: kpiOpt.value } });
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => {
      expect(screen.getByText(/redemption.*amazon voucher/i)).toBeInTheDocument();
    });
  });

  it('W5: WHOLESALER session has NO Visibility KPI option', async () => {
    localStorage.setItem(SESSION_KEY, 'WHOLESALER');
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '');
    expect(options.some(t => /visibility/i.test(t))).toBe(false);
  });

  it('W6: RETAILER session DOES have a Visibility KPI option', async () => {
    localStorage.setItem(SESSION_KEY, 'SSS');
    await renderWallet();
    const select  = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '');
    expect(options.some(t => /visibility/i.test(t))).toBe(true);
  });
});
