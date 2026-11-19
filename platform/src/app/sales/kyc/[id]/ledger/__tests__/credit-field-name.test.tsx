/// <reference types="vitest/globals" />
/**
 * CF — Sales outlet ledger: credit rows lead with the FIELD NAME.
 *
 * The owner-approved fix: a CREDIT row's header is the credit FIELD NAME (from the
 * batch), the upload narration renders as a small gray sub-line below (only when
 * present), and the raw batch-CUID `#{ref}` line is gone entirely. The KPI filter
 * lists the distinct field names.
 *
 *   CF1: a credit row shows the field name as header + narration below (no #-CUID)
 *   CF2: a blank-narration credit still shows the field-name header (no sub-line)
 *   CF3: the KPI filter lists the distinct field names
 *   CF4: a non-credit row (redeem) keeps its own description header
 *   CF5: a non-credit row with no narration falls back to the per-type default ("Points expired")
 */

import React, { Suspense, act } from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import OutletLedgerPage from '../page';

// The ledger's `statement.rows` — the SAME row shape as GET /api/wallet/statement (oldest first;
// `description` = narration, else the backend's per-type default; `narration` = the raw note).
const row = (r: Record<string, unknown>) => ({
  narration: null, fieldName: null, referenceType: null, referenceId: null, balanceBefore: 0, ...r,
});
const TXS = [
  // credit WITH a narration → header = field name, sub-line = narration
  row({ id: 't1', date: '2026-01-05T06:00:00.000Z', transactionType: 'CREDIT_BONUS', description: 'Extra push for Q1', narration: 'Extra push for Q1',
    points: 300, balanceAfter: 300, referenceType: 'CREDIT_BATCH', referenceId: 'cmr8w205dxyz', fieldName: 'Monthly Scheme' }),
  // credit with a BLANK narration → header = field name, no sub-line
  row({ id: 't2', date: '2026-01-06T06:00:00.000Z', transactionType: 'CREDIT_BONUS', description: '', narration: '',
    points: 150, balanceAfter: 450, referenceType: 'CREDIT_BATCH', referenceId: 'cmr8w999abcd', fieldName: 'Visibility' }),
  // redeem → keeps its own description as header, fieldName null
  row({ id: 't3', date: '2026-01-07T06:00:00.000Z', transactionType: 'DEBIT_REDEMPTION', description: 'Bluetooth Speaker', narration: 'Bluetooth Speaker',
    points: -100, balanceAfter: 350, referenceType: 'REDEMPTION_ORDER', referenceId: 'ord-1' }),
  // expiry with NO narration → the backend's per-type default header (never a blank title)
  row({ id: 't4', date: '2026-01-08T06:00:00.000Z', transactionType: 'DEBIT_EXPIRY', description: 'Points expired',
    points: -50, balanceAfter: 300 }),
];

function stubLedger() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: () => Promise.resolve({
      success: true,
      data: {
        meta: { name: 'Verma Traders', outletCode: 'OUT-2026-00111', mobile: '9876543210', balance: 350, lifetime: 450, redeemed: 100,
          // SSS keeps the "Visibility" KPI option (same rule as the partner wallet).
          outletType: 'SSS', hasPointsActivity: true, hasPayoutActivity: false, loyaltyEnabled: true },
        statement: { rows: TXS },
        payouts: [],
      },
    }),
  }));
}

async function renderLedger(id: string) {
  const params = Promise.resolve({ id });
  await act(async () => {
    render(
      <Suspense fallback={<div>Loading…</div>}>
        <OutletLedgerPage params={params} />
      </Suspense>,
    );
    await params;
  });
  expect(await screen.findByText('Verma Traders')).toBeInTheDocument();
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('CF — sales outlet ledger credit field name', () => {
  it('CF1: a credit row shows the field name header + narration sub-line, no #-CUID', async () => {
    stubLedger();
    await renderLedger('k1');
    // Header = field name (in the row, not the KPI <option> which also lists it).
    expect(await screen.findByText('Monthly Scheme', { ignore: 'option' })).toBeInTheDocument();
    // Narration sub-line present.
    expect(await screen.findByText('Extra push for Q1')).toBeInTheDocument();
    // The raw batch CUID must NOT render anywhere.
    expect(screen.queryByText(/cmr8w205dxyz/)).not.toBeInTheDocument();
    expect(screen.queryByText(/#cmr8w/)).not.toBeInTheDocument();
  });

  it('CF2: a blank-narration credit still shows the field-name header', async () => {
    stubLedger();
    await renderLedger('k1');
    expect(await screen.findByText('Visibility', { ignore: 'option' })).toBeInTheDocument();
    // No stray CUID for the blank-narration credit either.
    expect(screen.queryByText(/cmr8w999abcd/)).not.toBeInTheDocument();
  });

  it('CF3: the KPI filter lists the distinct field names', async () => {
    stubLedger();
    await renderLedger('k1');
    const select = await screen.findByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
    expect(options).toContain('All Parameters'); // the partner wallet's label (was "All KPIs")
    expect(options).toContain('Monthly Scheme');
    expect(options).toContain('Visibility');
    // The redeem row (fieldName null) must not appear as a KPI option.
    expect(options).not.toContain('Bluetooth Speaker');
  });

  it('CF4: a non-credit (redeem) row keeps its own description header', async () => {
    stubLedger();
    await renderLedger('k1');
    expect(await screen.findByText('Bluetooth Speaker')).toBeInTheDocument();
  });

  it('CF5: a non-credit row with no narration shows the per-type default title, never blank', async () => {
    stubLedger();
    await renderLedger('k1');
    expect(await screen.findByText('Points expired')).toBeInTheDocument();
  });
});
