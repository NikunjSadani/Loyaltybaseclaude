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
 */

import React, { Suspense, act } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));

import OutletLedgerPage from '../page';

const TXS = [
  // credit WITH a narration → header = field name, sub-line = narration
  { id: 't1', date: '2026-01-05', description: 'Extra push for Q1', type: 'credit', points: 300, balance: 300, ref: 'cmr8w205dxyz', fieldName: 'Monthly Scheme' },
  // credit with a BLANK narration → header = field name, no sub-line
  { id: 't2', date: '2026-01-06', description: '', type: 'credit', points: 150, balance: 450, ref: 'cmr8w999abcd', fieldName: 'Visibility' },
  // redeem → keeps its own description as header, fieldName null
  { id: 't3', date: '2026-01-07', description: 'Bluetooth Speaker', type: 'redeem', points: -100, balance: 350, ref: 'ord-1', fieldName: null },
];

function stubLedger() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: () => Promise.resolve({
      success: true,
      data: {
        meta: { name: 'Verma Traders', outletCode: 'OUT-2026-00111', mobile: '9876543210', balance: 350, lifetime: 450, redeemed: 100 },
        transactions: TXS,
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
  await waitFor(() => expect(screen.getByText('Verma Traders')).toBeInTheDocument());
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('CF — sales outlet ledger credit field name', () => {
  it('CF1: a credit row shows the field name header + narration sub-line, no #-CUID', async () => {
    stubLedger();
    await renderLedger('k1');
    // Header = field name (in the row, not the KPI <option> which also lists it).
    expect(screen.getByText('Monthly Scheme', { ignore: 'option' })).toBeInTheDocument();
    // Narration sub-line present.
    expect(screen.getByText('Extra push for Q1')).toBeInTheDocument();
    // The raw batch CUID must NOT render anywhere.
    expect(screen.queryByText(/cmr8w205dxyz/)).not.toBeInTheDocument();
    expect(screen.queryByText(/#cmr8w/)).not.toBeInTheDocument();
  });

  it('CF2: a blank-narration credit still shows the field-name header', async () => {
    stubLedger();
    await renderLedger('k1');
    expect(screen.getByText('Visibility', { ignore: 'option' })).toBeInTheDocument();
    // No stray CUID for the blank-narration credit either.
    expect(screen.queryByText(/cmr8w999abcd/)).not.toBeInTheDocument();
  });

  it('CF3: the KPI filter lists the distinct field names', async () => {
    stubLedger();
    await renderLedger('k1');
    const select = screen.getByTestId('wallet-kpi-filter');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent ?? '');
    expect(options.some((t) => /all kpi/i.test(t))).toBe(true);
    expect(options).toContain('Monthly Scheme');
    expect(options).toContain('Visibility');
    // The redeem row (fieldName null) must not appear as a KPI option.
    expect(options).not.toContain('Bluetooth Speaker');
  });

  it('CF4: a non-credit (redeem) row keeps its own description header', async () => {
    stubLedger();
    await renderLedger('k1');
    expect(screen.getByText('Bluetooth Speaker')).toBeInTheDocument();
  });
});
