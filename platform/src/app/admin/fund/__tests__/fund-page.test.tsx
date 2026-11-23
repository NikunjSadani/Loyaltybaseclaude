/// <reference types="vitest/globals" />
/**
 * FUND — /admin/fund (fund reconciliation) page.
 *  F1: GIFSY_ADMIN (canManage) sees the write buttons
 *  F2: CLIENT_ADMIN never sees write controls (even if the API said canManage)
 *  F3: low-balance banner (never-blocked copy + failed-alert error shown loudly)
 *  F4: receipt form posts amountRupees IN RUPEES (1500.50 → 1500.5, never ×100) to /api/fund/receipts
 *  F5: adjustment requires a reason (no POST without one)
 *  F6: statement renders rows with signed amounts
 *  F7: a failed summary load shows an error state, no fund numbers
 *  F8: no opening balance → "all history is counted" note
 * Run: npx vitest run src/app/admin/fund/__tests__/fund-page.test.tsx
 */
import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
const roleRef = vi.hoisted(() => ({ current: 'GIFSY_ADMIN' }));
vi.mock('@/lib/admin-session', () => ({
  useAdminSession: () => ({ role: roleRef.current, clientId: 't', name: 'Test', userId: 'u', canManageSchemes: roleRef.current === 'GIFSY_ADMIN' }),
}));

import FundReconciliationPage from '../page';

function summary(over: Record<string, unknown> = {}) {
  return {
    clientId: 't', asOf: '2026-11-23T10:00:00.000Z', openingDate: '2026-11-01T00:00:00.000Z', hasOpening: true, canManage: true,
    totals: {
      openingPaise: 5_000_000, receiptsPaise: 10_000_000, adjustmentsPaise: -100_000, committedPaise: 1_200_000,
      paidPaise: 3_400_000, returnedPaise: 50_000, balancePaise: 10_350_000, availablePaise: 10_350_000,
      faceTotalPaise: 4_600_000, discountTotalPaise: 30_000, feeTotalPaise: 60_000, tdsTotalPaise: 10_000,
    },
    byType: [
      { type: 'VOUCHER', label: 'Vouchers', count: 3, facePaise: 1_000_000, discountPaise: 30_000, feePaise: 0, committedPaise: 0, paidPaise: 970_000, returnedPaise: 0, netChargedPaise: 970_000 },
    ],
    receivables: { totalPaise: 0, items: [] },
    preOpeningReturns: { facePaise: 0, items: [] },
    excludedEntries: [],
    flagCounts: {},
    brandsWithoutRate: [],
    lowBalance: { thresholdPaise: null, isLow: false, lastAlertSentOn: null, lastAlertError: null, recipients: 0 },
    ...over,
  };
}

const STATEMENT = {
  lines: [
    { seq: 2, date: '2026-11-10T06:00:00.000Z', event: 'CHARGE', type: 'CASH_REDEMPTION', ref: 'RDM-1001', description: 'UPI redemption — Shree Stores', sourceKind: 'redemptionOrder', sourceId: 'o1', facePaise: 100_000, discountPaise: 0, feePaise: 3_000, tdsPaise: 0, chargedPaise: 103_000, amountPaise: -103_000, balancePaise: 14_897_000, status: 'PAID', committedAt: null, paidAt: null, returnedAt: null, utr: 'UTR777', brandLabel: null, rateLabel: '3%', receivablePaise: 0, flags: ['NO_FEE_RATE'] },
    { seq: 1, date: '2026-11-05T06:00:00.000Z', event: 'RECEIPT', type: null, ref: 'FR-0001', description: 'Advance received', sourceKind: 'fundReceipt', sourceId: 'r1', facePaise: 0, discountPaise: 0, feePaise: 0, tdsPaise: 0, chargedPaise: 0, amountPaise: 10_000_000, balancePaise: 15_000_000, status: null, committedAt: null, paidAt: null, returnedAt: null, utr: null, brandLabel: null, rateLabel: null, receivablePaise: 0, flags: [] },
  ],
  pagination: { page: 1, limit: 50, total: 2, pages: 1 },
  period: { from: null, to: null, openingBalancePaise: 5_000_000, closingBalancePaise: 14_897_000, openingEntryPaise: 0, receiptsPaise: 10_000_000, adjustmentsPaise: 0, chargesPaise: 103_000, returnsPaise: 0, byType: [] },
};

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined;

function stubFetch(over: Handler = () => undefined, sum = summary()) {
  const fn = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url);
    const custom = over(u, init);
    const res = custom ?? (
      u.includes('/api/fund/summary') ? { body: { success: true, data: sum } }
        : u.includes('/api/fund/statement') ? { body: { success: true, data: STATEMENT } }
        : u.includes('/api/fund/entries') ? { body: { success: true, data: { entries: [] } } }
        : { body: { success: true, data: {} } }
    );
    const status = res.status ?? 200;
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(res.body) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function posts(fn: ReturnType<typeof vi.fn>, path: string) {
  return fn.mock.calls.filter((c) => String(c[0]).includes(path) && (c[1] as RequestInit | undefined)?.method === 'POST');
}

beforeEach(() => { roleRef.current = 'GIFSY_ADMIN'; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('FUND — /admin/fund', () => {
  it('F1: GIFSY_ADMIN with canManage sees the write buttons', async () => {
    stubFetch();
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    expect(await screen.findByRole('button', { name: /Record advance received/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adjustment' })).toBeInTheDocument();
    // An opening balance exists (hasOpening) → no second "Opening balance" button.
    expect(screen.queryByRole('button', { name: 'Opening balance' })).not.toBeInTheDocument();
  });

  it('F2: CLIENT_ADMIN never sees write controls (even if the API said canManage)', async () => {
    roleRef.current = 'CLIENT_ADMIN';
    stubFetch(undefined, summary({ canManage: true }));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    expect(screen.getByText(/Read-only view/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    expect(await screen.findByText(/No advances, adjustments or opening balance/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record advance received/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adjustment' })).not.toBeInTheDocument();
  });

  it('F2b: GIFSY_ADMIN but API canManage=false (e.g. not assumed) → no write controls', async () => {
    stubFetch(undefined, summary({ canManage: false }));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    await screen.findByText(/No advances, adjustments or opening balance/);
    expect(screen.queryByRole('button', { name: /Record advance received/ })).not.toBeInTheDocument();
  });

  it('F3: low-balance banner says spend is never blocked and shows a failed alert loudly', async () => {
    stubFetch(undefined, summary({
      lowBalance: { thresholdPaise: 20_000_000, isLow: true, lastAlertSentOn: '2026-11-22', lastAlertError: 'SMTP 550 rejected', recipients: 2 },
    }));
    render(<FundReconciliationPage />);
    const banner = await screen.findByTestId('fund-low-balance');
    expect(banner).toHaveTextContent('₹2,00,000.00');
    expect(banner).toHaveTextContent(/never blocked/);
    expect(banner).toHaveTextContent(/22 Nov 2026/);
    expect(within(banner).getByTestId('fund-alert-error')).toHaveTextContent('SMTP 550 rejected');
  });

  it('F4: the receipt form posts amountRupees in rupees (1500.50 → 1500.5, not 150050)', async () => {
    const fn = stubFetch((u, init) => (u.includes('/api/fund/receipts') && init?.method === 'POST'
      ? { status: 201, body: { success: true, data: { id: 'r9' } } } : undefined));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    fireEvent.click(await screen.findByRole('button', { name: /Record advance received/ }));
    fireEvent.change(await screen.findByLabelText('Amount received (₹)'), { target: { value: '1500.50' } });
    fireEvent.change(screen.getByLabelText('Date received'), { target: { value: '2026-11-20' } });
    fireEvent.change(screen.getByLabelText('UTR / reference (required)'), { target: { value: 'UTR123' } });
    fireEvent.change(screen.getByLabelText('Bank (optional)'), { target: { value: 'HDFC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record advance' }));
    await waitFor(() => expect(posts(fn, '/api/fund/receipts')).toHaveLength(1));
    const body = JSON.parse(String((posts(fn, '/api/fund/receipts')[0][1] as RequestInit).body));
    expect(body).toEqual({ amountRupees: 1500.5, receivedOn: '2026-11-20', referenceNumber: 'UTR123', bankName: 'HDFC' });
    expect(await screen.findByText('Advance recorded.')).toBeInTheDocument();
  });

  it('F4b: the receipt form requires a UTR and shows the server error text', async () => {
    const fn = stubFetch((u, init) => (u.includes('/api/fund/receipts') && init?.method === 'POST'
      ? { status: 400, body: { message: ['Open a client first'] } } : undefined));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    fireEvent.click(await screen.findByRole('button', { name: /Record advance received/ }));
    fireEvent.change(await screen.findByLabelText('Amount received (₹)'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record advance' }));
    expect(await screen.findByText(/UTR \/ bank reference — it is required/)).toBeInTheDocument();
    expect(posts(fn, '/api/fund/receipts')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('UTR / reference (required)'), { target: { value: 'UTR1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record advance' }));
    expect(await screen.findByText('Open a client first')).toBeInTheDocument();
  });

  it('F5: an adjustment requires a reason — no POST without one; with one it posts the signed rupee amount', async () => {
    const fn = stubFetch((u, init) => (u.includes('/api/fund/adjustments') && init?.method === 'POST'
      ? { status: 201, body: { success: true, data: { id: 'a1' } } } : undefined));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Adjustment' }));
    fireEvent.change(await screen.findByLabelText('Amount (₹, + or −)'), { target: { value: '-2500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    expect(await screen.findByText('A reason is required for every adjustment.')).toBeInTheDocument();
    expect(posts(fn, '/api/fund/adjustments')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Hubble credit note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    await waitFor(() => expect(posts(fn, '/api/fund/adjustments')).toHaveLength(1));
    const body = JSON.parse(String((posts(fn, '/api/fund/adjustments')[0][1] as RequestInit).body));
    expect(body.amountRupees).toBe(-2500);
    expect(body.reason).toBe('Hubble credit note');
  });

  it('F6: the statement renders rows with signed amounts, flags and the period summary', async () => {
    stubFetch();
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Statement' }));
    const rows = await screen.findAllByTestId('fund-statement-row');
    expect(rows).toHaveLength(2);
    const amounts = screen.getAllByTestId('fund-statement-amount');
    expect(amounts[0]).toHaveTextContent('-₹1,030.00');
    expect(amounts[0].querySelector('span')).toHaveClass('text-red-700');
    expect(amounts[1]).toHaveTextContent('+₹1,00,000.00');
    expect(amounts[1].querySelector('span')).toHaveClass('text-green-700');
    expect(within(rows[0]).getByText('No agency fee')).toBeInTheDocument();
    expect(within(rows[0]).getByText('UTR777')).toBeInTheDocument();
    // A redemption order has no admin detail page → plain text, not a link.
    expect(within(rows[0]).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByTestId('fund-period')).toHaveTextContent('₹1,48,970.00');
  });

  it('F7: a failed summary load shows an error state and no fund numbers', async () => {
    stubFetch((u) => (u.includes('/api/fund/summary') ? { status: 500, body: { success: false, error: 'Fund engine down' } } : undefined));
    render(<FundReconciliationPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the fund summary: Fund engine down');
    expect(screen.queryByTestId('fund-balance-card')).not.toBeInTheDocument();
    expect(screen.queryByText('₹1,03,500.00')).not.toBeInTheDocument();
  });

  it('F8: no opening balance → "all history is counted" note and the Opening balance button', async () => {
    stubFetch(undefined, summary({ hasOpening: false, openingDate: null }));
    render(<FundReconciliationPage />);
    expect(await screen.findByTestId('fund-no-opening')).toHaveTextContent('No opening balance recorded — all history is counted.');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    expect(await screen.findByRole('button', { name: 'Opening balance' })).toBeInTheDocument();
  });
});
