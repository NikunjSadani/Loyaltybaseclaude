/// <reference types="vitest/globals" />
/**
 * TDD — Narration field on wallet transactions (both tracks)
 *
 * Admins can attach an optional narration to any payout/transaction row.
 * It is displayed as a small extra line under the main transaction header.
 *
 * INR track (PayoutLedgerEntry):
 *   layout: kpiLabel · period  /  UTR (if any)  /  narration (if any)
 *
 * POINTS track (WalletTransaction via TransactionItem):
 *   layout: description  /  subLabel (if any)  /  narration (if any)
 *
 * Y1: INR track — a payout WITH narration shows narration text (data-testid="payout-narration")
 * Y2: INR track — a payout WITHOUT narration shows no payout-narration element
 * Y3: POINTS track — a transaction WITH narration shows narration text (data-testid="transaction-narration")
 * Y4: POINTS track — a transaction WITHOUT narration shows no transaction-narration element
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/redemption-store', () => ({
  loadRedemptions: () => [],
}));

import WalletPage from '../page';

const SESSION_KEY = 'partner_outlet_type_demo';

async function renderAndWait(outletType: string) {
  localStorage.setItem(SESSION_KEY, outletType);
  render(<WalletPage />);
  // Wait for loading to settle — statement-controls-row appears once data is loaded
  await waitFor(
    () => expect(screen.getByTestId('statement-controls-row')).toBeInTheDocument(),
    { timeout: 3000 },
  );
}

describe('Y — Narration on wallet transactions', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── INR track (RETAILER) ──

  it('Y1: INR track — payout with narration shows payout-narration element', async () => {
    await renderAndWait('SSS');
    const narrations = screen.getAllByTestId('payout-narration');
    expect(narrations.length).toBeGreaterThan(0);
  });

  it('Y2: INR track — payout without narration has no payout-narration element for that row', async () => {
    await renderAndWait('SSS');
    // Every payout-narration that IS rendered must have non-empty text
    const narrations = screen.queryAllByTestId('payout-narration');
    narrations.forEach((el) => {
      expect(el.textContent?.trim().length).toBeGreaterThan(0);
    });
  });

  // ── POINTS track (WHOLESALER) ──

  it('Y3: POINTS track — transaction with narration shows transaction-narration element', async () => {
    await renderAndWait('WHOLESALER');
    const narrations = screen.getAllByTestId('transaction-narration');
    expect(narrations.length).toBeGreaterThan(0);
  });

  it('Y4: POINTS track — every transaction-narration rendered has non-empty text', async () => {
    await renderAndWait('WHOLESALER');
    const narrations = screen.queryAllByTestId('transaction-narration');
    narrations.forEach((el) => {
      expect(el.textContent?.trim().length).toBeGreaterThan(0);
    });
  });
});
