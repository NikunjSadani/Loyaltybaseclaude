/// <reference types="vitest/globals" />
/**
 * TDD — KPI filter in sales team outlet ledger
 *
 * The sales team's outlet ledger (Points Ledger) should have the same KPI
 * filter as the partner's own wallet view — they are looking at the same data.
 *
 * X1: Ledger page has data-testid="wallet-kpi-filter" select (same testid as wallet)
 * X2: Dropdown contains "All KPIs" + at least one KPI option
 * X3: Selecting a KPI hides transactions that belong to a different KPI
 * X4: Selecting "All KPIs" restores all transactions
 * X5: Visibility KPI option present for outlet k1 (which has a Visibility transaction)
 */

import React, { Suspense, act } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import OutletLedgerPage from '../page';

async function renderLedger(outletId: string) {
  const params = Promise.resolve({ id: outletId });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <OutletLedgerPage params={params} />
      </Suspense>,
    );
    await params;
  });
  // Wait for the KPI filter select to appear (includes Suspense resolution + 350ms inner load delay)
  await waitFor(
    () => expect(screen.queryByTestId('wallet-kpi-filter')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe('X — KPI filter in sales team ledger', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('X1: ledger page has a wallet-kpi-filter select (same testid as partner wallet)', async () => {
    await renderLedger('k1');
    const select = screen.getByTestId('wallet-kpi-filter');
    expect(select.tagName.toLowerCase()).toBe('select');
  });

  it('X2: dropdown has "All KPIs" + at least one KPI from the ledger entries', async () => {
    await renderLedger('k1');
    const select = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '');
    expect(options.some(t => /all kpi/i.test(t))).toBe(true);
    expect(options.length).toBeGreaterThan(1);
  });

  it('X3: selecting a KPI hides entries with a different kpiLabel', async () => {
    await renderLedger('k1');
    const select = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option'));
    const kpiOption = options.find(o => !/all kpi/i.test(o.textContent ?? ''));
    if (!kpiOption) return;

    fireEvent.change(select, { target: { value: kpiOption.value } });

    // Redemption entries should be hidden when filtering by an earn KPI
    await waitFor(() => {
      const redeemItems = screen
        .queryAllByText(/redeemed/i)
        .filter((el) => el.closest('[data-testid="transaction-item"]'));
      expect(redeemItems.length).toBe(0);
    });
  });

  it('X4: selecting "All KPIs" restores all entries', async () => {
    await renderLedger('k1');
    const select = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option'));
    const kpiOption = options.find(o => !/all kpi/i.test(o.textContent ?? ''));
    if (!kpiOption) return;

    fireEvent.change(select, { target: { value: kpiOption.value } });
    fireEvent.change(select, { target: { value: '' } });

    // Redeem entries should be back
    await waitFor(() => {
      expect(screen.getByText(/bluetooth speaker/i)).toBeInTheDocument();
    });
  });

  it('X5: Visibility KPI option is present for k1 (has visibility earn entry)', async () => {
    await renderLedger('k1');
    const select = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent ?? '');
    expect(options.some(t => /visibility/i.test(t))).toBe(true);
  });
});
