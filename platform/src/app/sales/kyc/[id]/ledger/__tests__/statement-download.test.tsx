/// <reference types="vitest/globals" />
/**
 * SLD — Sales outlet ledger: the shared Download → Excel / PDF picker
 *
 * SLD1: the Download picker is present and the on-screen list still renders
 * SLD2: Excel fetches /api/kyc/<id>/ledger/statement?from=&to= and renders the shared doc with
 *       the outlet name + code from `meta`, interleaving the ledger's payouts
 * SLD3: PDF goes through the PDF renderer
 * SLD4: the button is disabled when the selected period has no rows
 */
import React, { Suspense, act } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { StatementDoc } from '@/lib/wallet-statement/statement-model';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
const downloadBlob = vi.fn();
vi.mock('@/lib/download', () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }));
const statementToXlsxBlob = vi.fn((_d: StatementDoc) => new Blob(['x']));
vi.mock('@/lib/wallet-statement/statement-xlsx', () => ({
  statementToXlsxBlob: (d: StatementDoc) => statementToXlsxBlob(d),
}));
const statementToPdfBlob = vi.fn(async (_d: StatementDoc) => new Blob(['p']));
vi.mock('@/lib/wallet-statement/statement-pdf', () => ({
  statementToPdfBlob: (d: StatementDoc) => statementToPdfBlob(d),
}));

import OutletLedgerPage from '../page';

const META = { name: 'Verma Traders', outletCode: 'OUT-111', mobile: '98', balance: 250, lifetime: 300, redeemed: 50,
  outletType: 'SSS', hasPointsActivity: true, hasPayoutActivity: true, loyaltyEnabled: true };
const PAYOUTS = [
  { id: 'p1', period: '2026-05', kpiLabel: 'Visibility', achievedPct: 100, payoutAmountPaise: 500000,
    uploadedAt: '2026-05-02T00:00:00.000Z', utr: 'UTR9', paidAt: '2026-05-10T00:00:00.000Z', status: 'PAID' },
];
const STATEMENT = {
  openingBalance: 0, closingBalance: 250, currentBalance: 250, outletCode: 'OUT-111',
  rows: [
    { id: 't1', date: '2026-04-05T06:00:00.000Z', transactionType: 'CREDIT_BONUS', description: 'Q1 push', narration: 'Q1 push',
      fieldName: 'Monthly Scheme', points: 300, balanceBefore: 0, balanceAfter: 300, referenceType: 'CREDIT_BATCH', referenceId: 'b1' },
    { id: 't2', date: '2026-05-08T06:00:00.000Z', transactionType: 'DEBIT_REDEMPTION', description: 'Redeemed', narration: 'Redeemed',
      fieldName: null, points: -50, balanceBefore: 300, balanceAfter: 250, referenceType: null, referenceId: null },
  ],
};

// The on-screen ledger carries the SAME statement rows (GET /api/kyc/k1/ledger → data.statement).
function stub(txs: unknown[] = STATEMENT.rows, payouts: unknown[] = PAYOUTS) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    if (u.startsWith('/api/kyc/k1/ledger/statement'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: STATEMENT }) });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { meta: META, statement: { rows: txs }, payouts } }),
    });
  }));
}

async function renderLedger() {
  const params = Promise.resolve({ id: 'k1' });
  await act(async () => {
    render(<Suspense fallback={<div>Loading…</div>}><OutletLedgerPage params={params} /></Suspense>);
    await params;
  });
  expect(await screen.findByText('Verma Traders')).toBeInTheDocument();
}

async function pick(label: 'Excel (.xlsx)' | 'PDF') {
  await waitFor(() => expect(screen.getByTestId('statement-download-btn')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('statement-download-btn'));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
  await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
}

describe('SLD — sales ledger statement download', () => {
  beforeEach(() => {
    downloadBlob.mockReset();
    statementToXlsxBlob.mockClear();
    statementToPdfBlob.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('SLD1: the Download picker is present and the on-screen list still renders', async () => {
    stub();
    await renderLedger();
    expect(await screen.findByTestId('statement-download-btn')).toBeInTheDocument();
    expect(await screen.findAllByTestId('transaction-item')).toHaveLength(2);
  });

  it('SLD2: Excel fetches the ledger statement for the range and builds the doc from meta + payouts', async () => {
    stub();
    await renderLedger();
    await pick('Excel (.xlsx)');
    const urls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('/api/kyc/k1/ledger/statement?from=2026-04&to=2026-05');
    const doc = statementToXlsxBlob.mock.calls[0][0];
    expect(doc.title).toBe('Wallet Statement');
    expect(doc.outletName).toBe('Verma Traders');
    expect(doc.outletCode).toBe('OUT-111');
    expect(doc.openingBalance).toBe(0);
    expect(doc.closingBalance).toBe(250);
    // oldest first: credit (Apr), redeem (8 May), then the payout (10 May)
    expect(doc.lines.map((l) => l.kind === 'points' ? l.balance : `pay:${l.amountInr}`)).toEqual([300, 250, 'pay:5000']);
    expect(downloadBlob.mock.calls[0][1]).toBe('wallet-statement-OUT-111-2026-04_2026-05.xlsx');
  });

  it('SLD3: PDF goes through the PDF renderer', async () => {
    stub();
    await renderLedger();
    await pick('PDF');
    expect(statementToPdfBlob).toHaveBeenCalledTimes(1);
    expect(downloadBlob.mock.calls[0][1]).toBe('wallet-statement-OUT-111-2026-04_2026-05.pdf');
  });

  it('SLD5: the document names the outlet from the statement response (Outlet.name), exactly like the partner download', async () => {
    stub();
    const base = vi.mocked(global.fetch).getMockImplementation()!;
    vi.mocked(global.fetch).mockImplementation((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('/api/kyc/k1/ledger/statement')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: { ...STATEMENT, outletName: 'Verma Outlet (master)' } }),
        } as Response);
      }
      return base(url, init);
    });
    await renderLedger();
    await pick('Excel (.xlsx)');
    const doc = statementToXlsxBlob.mock.calls[0][0];
    // Not the page header's businessName ("Verma Traders"): the statement's own Outlet.name + code pair.
    expect(doc.outletName).toBe('Verma Outlet (master)');
    expect(doc.outletCode).toBe('OUT-111');
  });

  it('SLD4: the Download button is disabled when the selected period has no rows', async () => {
    stub([], []);
    await renderLedger();
    expect(await screen.findByTestId('statement-download-btn')).toBeDisabled();
  });
});
