/// <reference types="vitest/globals" />
/**
 * FUND — /admin/fund (fund reconciliation) page.
 *  F1: canManage → write buttons (GIFSY_ADMIN); F1b: GIFSY_STAFF with canManage → write buttons (B4/C1)
 *  F2: CLIENT_ADMIN (canManage=false) → no write controls; F2b: GIFSY_ADMIN canManage=false → none either
 *  F3: low-balance banner (never-blocked copy, failed alert shown loudly, Monday–Saturday, count at send time)
 *  F3b: client admin banner — client copy, no Gifsy instructions (C11)
 *  F4: receipt form posts amountRupees IN RUPEES; F4b UTR required + server error; F4c can't close while saving (C9)
 *  F5: adjustment requires a reason; accepts the Unicode minus (C10)
 *  F6: statement rows, signed amounts, flag legend (C4), RATE_CHANGE info row (D1), "all types" period note (C6)
 *  F6b: stale statement reply ignored (C8); F6c: Excel waits for Apply and uses the applied dates (C7)
 *  F7: failed summary → error, no numbers;  F8: no opening → note + Opening balance button
 *  F9: opening balance needs a confirmation step (D2)
 *  F10: Rates & alerts read-only (D6) — client admin: "Managed by Gifsy", no write controls, no console link
 *  F10b: Gifsy operator: console link + test-environment notice; item discounts with scheduled rate (C3)
 *  F11: overview explains every flag in visible text (C4) + spend-by-type empty state (C15)
 *  F12: tabs — arrow-key navigation + aria-controls → tabpanel (C15)
 *  F13: parseRupees accepts "+2500" and "−2500" (C10)
 * Run: npx vitest run src/app/admin/fund/__tests__/fund-page.test.tsx
 */
import React from 'react';
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';
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
import { parseRupees } from '@/lib/fund';

function summary(over: Record<string, unknown> = {}) {
  return {
    clientId: 't', asOf: '2026-11-23T10:00:00.000Z', openingDate: '2026-11-01T00:00:00.000Z', hasOpening: true, canManage: true,
    settingsConsoleHref: '/gifsy/clients/t#fund',
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
    itemsWithoutRate: [],
    lowBalance: { thresholdPaise: null, isLow: false, alertsPaused: null, lastAlertSentOn: null, lastAlertRecipients: null, lastAlertError: null, recipients: 0 },
    ...over,
  };
}

const LINE_BASE = {
  sourceKind: 'redemptionOrder', facePaise: 0, discountPaise: 0, feePaise: 0, tdsPaise: 0, chargedPaise: 0, status: null,
  committedAt: null, paidAt: null, returnedAt: null, utr: null, itemLabel: null, rateLabel: null, receivablePaise: 0, flags: [] as string[],
};
const STATEMENT = {
  lines: [
    { ...LINE_BASE, seq: 3, date: '2026-11-12T06:00:00.000Z', event: 'RATE_CHANGE', type: null, ref: 'RATE-1', description: 'Rate change on 12 Nov 2026: 4 lines re-priced from 01 Nov 2026, balance changed by -₹120.00', sourceKind: 'fundRate', sourceId: 'fr1', amountPaise: 0, balancePaise: 14_897_000 },
    { ...LINE_BASE, seq: 2, date: '2026-11-10T06:00:00.000Z', event: 'CHARGE', type: 'CASH_REDEMPTION', ref: 'RDM-1001', description: 'UPI redemption — Shree Stores', sourceId: 'o1', facePaise: 100_000, feePaise: 3_000, chargedPaise: 103_000, amountPaise: -103_000, balancePaise: 14_897_000, status: 'PAID', utr: 'UTR777', rateLabel: '3%', flags: ['NO_FEE_RATE', 'DATE_ESTIMATED'] },
    { ...LINE_BASE, seq: 1, date: '2026-11-05T06:00:00.000Z', event: 'RECEIPT', type: null, ref: 'FR-0001', description: 'Advance received', sourceKind: 'fundReceipt', sourceId: 'r1', amountPaise: 10_000_000, balancePaise: 15_000_000 },
  ],
  pagination: { page: 1, limit: 50, total: 3, pages: 1 },
  period: { from: null, to: null, scope: 'ALL_TYPES_FOR_PERIOD', openingBalancePaise: 5_000_000, closingBalancePaise: 14_897_000, openingEntryPaise: 0, receiptsPaise: 10_000_000, adjustmentsPaise: 0, chargesPaise: 103_000, returnsPaise: 0, byType: [] },
};

function settings(over: Record<string, unknown> = {}) {
  return {
    clientId: 't', canManage: false, managedInConsole: true, consoleHref: null,
    thresholdPaise: 2_000_000, alertRecipients: ['ops@client.test'], lastAlertSentOn: '2026-11-20', lastAlertRecipients: 1, lastAlertError: null,
    alertEnvironment: null,
    currentFee: { feeType: 'PERCENT', rateBps: 300, flatPaise: null, effectiveFrom: '2026-11-01T00:00:00.000Z' },
    scheduledFee: { feeType: 'PERCENT', rateBps: 350, flatPaise: null, effectiveFrom: '2026-12-01T00:00:00.000Z' },
    feeRates: [], discountRates: [],
    items: [
      { rewardId: 'rw1', name: 'Amazon Pay ₹500', code: 'AMZ500', brandText: 'Amazon', deleted: false, active: true, currentRateBps: 250, currentEffectiveFrom: '2026-11-01T00:00:00.000Z', scheduledRateBps: 300, scheduledFrom: '2026-12-01T00:00:00.000Z' },
      { rewardId: 'rw2', name: 'Old Flipkart', code: 'FK', brandText: null, deleted: true, active: false, currentRateBps: null, currentEffectiveFrom: null, scheduledRateBps: null, scheduledFrom: null },
    ],
    ...over,
  };
}

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }> | undefined;

function stubFetch(over: Handler = () => undefined, sum = summary(), set = settings()) {
  const fn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const custom = await over(u, init);
    const res = custom ?? (
      u.includes('/api/fund/summary') ? { body: { success: true, data: sum } }
        : u.includes('/api/fund/statement') ? { body: { success: true, data: STATEMENT } }
        : u.includes('/api/fund/entries') ? { body: { success: true, data: { entries: [] } } }
        : u.includes('/api/fund/settings') ? { body: { success: true, data: set } }
        : { body: { success: true, data: {} } }
    );
    const status = res.status ?? 200;
    return { ok: status < 400, status, json: () => Promise.resolve(res.body) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function posts(fn: ReturnType<typeof vi.fn>, path: string) {
  return fn.mock.calls.filter((c) => String(c[0]).includes(path) && (c[1] as RequestInit | undefined)?.method === 'POST');
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
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

  it('F1b (B4/C1): GIFSY_STAFF — write controls follow canManage only', async () => {
    roleRef.current = 'GIFSY_STAFF';
    stubFetch();
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    expect(await screen.findByRole('button', { name: /Record advance received/ })).toBeInTheDocument();
  });

  it('F2: CLIENT_ADMIN (canManage=false) never sees write controls', async () => {
    roleRef.current = 'CLIENT_ADMIN';
    stubFetch(undefined, summary({ canManage: false, settingsConsoleHref: null }));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    expect(screen.getByText(/Read-only view — Gifsy records receipts/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    expect(await screen.findByText(/No advances, adjustments or opening balance/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record advance received/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adjustment' })).not.toBeInTheDocument();
  });

  it('F2b: GIFSY_ADMIN but API canManage=false → no write controls', async () => {
    stubFetch(undefined, summary({ canManage: false }));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    await screen.findByText(/No advances, adjustments or opening balance/);
    expect(screen.queryByRole('button', { name: /Record advance received/ })).not.toBeInTheDocument();
  });

  it('F3: low-balance banner says spend is never blocked, shows the count at send time and a failed alert loudly', async () => {
    stubFetch(undefined, summary({
      lowBalance: { thresholdPaise: 20_000_000, isLow: true, alertsPaused: null, lastAlertSentOn: '2026-11-22', lastAlertRecipients: 3, lastAlertError: 'SMTP 550 rejected', recipients: 2 },
    }));
    render(<FundReconciliationPage />);
    const banner = await screen.findByTestId('fund-low-balance');
    expect(banner).toHaveTextContent('₹2,00,000.00');
    expect(banner).toHaveTextContent(/never blocked/);
    expect(banner).toHaveTextContent(/22 Nov 2026 to 3 recipients/);
    expect(banner).toHaveTextContent(/Monday to Saturday/);
    expect(within(banner).getByTestId('fund-alert-error')).toHaveTextContent('FAILED: SMTP 550 rejected');
  });

  it('F3b (C11): a client admin gets client copy — no Gifsy instructions; paused alerts are explained', async () => {
    roleRef.current = 'CLIENT_ADMIN';
    stubFetch(undefined, summary({
      canManage: false, settingsConsoleHref: null,
      lowBalance: { thresholdPaise: 20_000_000, isLow: true, alertsPaused: 'NO_OPENING', lastAlertSentOn: null, lastAlertRecipients: null, lastAlertError: 'The last low-balance e-mail could not be delivered. Gifsy has been notified.', recipients: 1 },
    }));
    render(<FundReconciliationPage />);
    const banner = await screen.findByTestId('fund-low-balance');
    expect(banner).not.toHaveTextContent(/decides case by case/);
    expect(banner).toHaveTextContent(/start once an opening balance is recorded/);
    expect(within(banner).getByTestId('fund-alert-error')).toHaveTextContent('could not be delivered. Gifsy has been notified.');
    expect(within(banner).getByTestId('fund-alert-error')).not.toHaveTextContent('FAILED');
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
    expect(screen.getByLabelText('UTR / reference (required)')).toHaveAttribute('maxLength', '100');
    expect(screen.getByLabelText('Note (optional)')).toHaveAttribute('maxLength', '500');
    fireEvent.click(screen.getByRole('button', { name: 'Record advance' }));
    await waitFor(() => expect(posts(fn, '/api/fund/receipts')).toHaveLength(1));
    const body = JSON.parse(String((posts(fn, '/api/fund/receipts')[0][1] as RequestInit).body));
    expect(body).toEqual({ amountRupees: 1500.5, receivedOn: '2026-11-20', referenceNumber: 'UTR123', bankName: 'HDFC' });
    expect(await screen.findByText('Advance recorded.')).toBeInTheDocument();
  });

  it('F4b: the receipt form requires a UTR (error linked + focused) and shows the server error text', async () => {
    const fn = stubFetch((u, init) => (u.includes('/api/fund/receipts') && init?.method === 'POST'
      ? { status: 400, body: { message: ['Open a client first'] } } : undefined));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    fireEvent.click(await screen.findByRole('button', { name: /Record advance received/ }));
    fireEvent.change(await screen.findByLabelText('Amount received (₹)'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record advance' }));
    expect(await screen.findByText(/UTR \/ bank reference — it is required/)).toBeInTheDocument();
    const ref = screen.getByLabelText('UTR / reference (required)');
    expect(ref).toHaveAttribute('aria-invalid', 'true');
    expect(ref.getAttribute('aria-describedby')).toContain('rc-ref-error');
    await waitFor(() => expect(document.activeElement).toBe(ref));
    expect(posts(fn, '/api/fund/receipts')).toHaveLength(0);
    fireEvent.change(ref, { target: { value: 'UTR1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record advance' }));
    expect(await screen.findByText('Open a client first')).toBeInTheDocument();
  });

  it('F4c (C9): the form cannot be closed while it is saving', async () => {
    const d = deferred<{ status?: number; body: unknown }>();
    stubFetch((u, init) => (u.includes('/api/fund/receipts') && init?.method === 'POST' ? d.promise : undefined));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    fireEvent.click(await screen.findByRole('button', { name: /Record advance received/ }));
    fireEvent.change(await screen.findByLabelText('Amount received (₹)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('UTR / reference (required)'), { target: { value: 'UTR9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record advance' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => { d.resolve({ status: 400, body: { message: 'Duplicate UTR' } }); });
    // The error stays visible inside the still-open form.
    expect(await screen.findByText('Duplicate UTR')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('F5: an adjustment requires a reason; the Unicode minus is accepted (C10)', async () => {
    const fn = stubFetch((u, init) => (u.includes('/api/fund/adjustments') && init?.method === 'POST'
      ? { status: 201, body: { success: true, data: { id: 'a1' } } } : undefined));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Adjustment' }));
    fireEvent.change(await screen.findByLabelText('Amount (₹, + or −)'), { target: { value: '−2500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    expect(await screen.findByText('A reason is required for every adjustment.')).toBeInTheDocument();
    expect(posts(fn, '/api/fund/adjustments')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Voucher provider credit note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record adjustment' }));
    await waitFor(() => expect(posts(fn, '/api/fund/adjustments')).toHaveLength(1));
    const body = JSON.parse(String((posts(fn, '/api/fund/adjustments')[0][1] as RequestInit).body));
    expect(body.amountRupees).toBe(-2500);
    expect(body.reason).toBe('Voucher provider credit note');
  });

  it('F6: the statement renders signed amounts, a flag legend, the RATE_CHANGE info row and the "all types" note', async () => {
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
    expect(within(rows[0]).queryByRole('link')).not.toBeInTheDocument();
    // C4: every flag on the page explained in visible text.
    const legend = screen.getByTestId('fund-flag-legend');
    expect(legend).toHaveTextContent(/No agency fee:.*no fee was charged/);
    expect(legend).toHaveTextContent(/Date estimated:.*shown on the day it was committed/);
    // D1: the rate change is a distinct info row.
    expect(screen.getByTestId('fund-rate-change-row')).toHaveTextContent('4 lines re-priced from 01 Nov 2026');
    // C6
    expect(screen.getByTestId('fund-period-scope')).toHaveTextContent('Totals cover all types for the period');
    expect(screen.getByTestId('fund-period')).toHaveTextContent('₹1,48,970.00');
    expect(screen.getByTestId('fund-period')).toHaveTextContent('Money in (opening + receipts)');
  });

  it('F6b (C8): a slow earlier statement reply is ignored once the filters change', async () => {
    const first = deferred<{ status?: number; body: unknown }>();
    let calls = 0;
    const newer = { ...STATEMENT, lines: [STATEMENT.lines[2]], pagination: { page: 1, limit: 50, total: 1, pages: 1 } };
    stubFetch((u) => {
      if (!u.includes('/api/fund/statement')) return undefined;
      calls += 1;
      return calls === 1 ? first.promise : { body: { success: true, data: newer } };
    });
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Statement' }));
    fireEvent.change(await screen.findByLabelText('Type'), { target: { value: 'VOUCHER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findAllByTestId('fund-statement-row')).toHaveLength(1);
    await act(async () => { first.resolve({ body: { success: true, data: STATEMENT } }); });
    // Still the newer reply — the stale one did not overwrite it.
    expect(screen.getAllByTestId('fund-statement-row')).toHaveLength(1);
    expect(screen.queryByText('RDM-1001')).not.toBeInTheDocument();
  });

  it('F6c (C7): the Excel waits for Apply and uses the applied dates', async () => {
    const fn = stubFetch((u) => (u.includes('/api/fund/export') ? { status: 500, body: { message: 'x' } } : undefined));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Statement' }));
    await screen.findAllByTestId('fund-statement-row');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } });
    expect(screen.getByRole('button', { name: /Download Excel/ })).toBeDisabled();
    expect(screen.getByTestId('fund-export-range')).toHaveTextContent(/Press Apply first/);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Download Excel/ })).not.toBeDisabled());
    expect(screen.getByTestId('fund-export-range')).toHaveTextContent(/01 Nov 2026/);
    fireEvent.click(screen.getByRole('button', { name: /Download Excel/ }));
    await waitFor(() => expect(fn.mock.calls.some((c) => String(c[0]).includes('/api/fund/export?from=2026-11-01'))).toBe(true));
  });

  it('F7: a failed summary load shows an error state and no fund numbers', async () => {
    stubFetch((u) => (u.includes('/api/fund/summary') ? { status: 500, body: { success: false, error: 'Fund engine down' } } : undefined));
    render(<FundReconciliationPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the fund summary: Fund engine down');
    expect(screen.queryByTestId('fund-balance-card')).not.toBeInTheDocument();
  });

  it('F8: no opening balance → "all history is counted" note and the Opening balance button', async () => {
    stubFetch(undefined, summary({ hasOpening: false, openingDate: null }));
    render(<FundReconciliationPage />);
    expect(await screen.findByTestId('fund-no-opening')).toHaveTextContent('No opening balance recorded — all history is counted.');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    expect(await screen.findByRole('button', { name: 'Opening balance' })).toBeInTheDocument();
  });

  it('F9 (D2): the opening balance needs a confirmation step before it is posted', async () => {
    const fn = stubFetch((u, init) => (u.includes('/api/fund/opening-balance') && init?.method === 'POST'
      ? { status: 201, body: { success: true, data: { id: 'o1' } } } : undefined), summary({ hasOpening: false, openingDate: null }));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-no-opening');
    fireEvent.click(screen.getByRole('tab', { name: 'Receipts & adjustments' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Opening balance' }));
    fireEvent.change(await screen.findByLabelText('Opening balance (₹)'), { target: { value: '50000' } });
    fireEvent.change(screen.getByLabelText('As-of date (balance at the start of this day)'), { target: { value: '2026-11-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review opening balance' }));
    const confirm = await screen.findByTestId('fund-opening-confirm');
    expect(confirm).toHaveTextContent("The opening balance can't be changed later — check the amount and the date (spend before this date is not tracked).");
    expect(confirm).toHaveTextContent('₹50,000.00');
    expect(confirm).toHaveTextContent('01 Nov 2026');
    expect(posts(fn, '/api/fund/opening-balance')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, record the opening balance' }));
    await waitFor(() => expect(posts(fn, '/api/fund/opening-balance')).toHaveLength(1));
    expect(JSON.parse(String((posts(fn, '/api/fund/opening-balance')[0][1] as RequestInit).body))).toEqual({ amountRupees: 50000, asOfDate: '2026-11-01' });
    expect(await screen.findByText('Opening balance recorded.')).toBeInTheDocument();
  });

  it('F10 (D6): Rates & alerts is read-only for a client admin — "Managed by Gifsy", no write controls, no console link', async () => {
    roleRef.current = 'CLIENT_ADMIN';
    const fn = stubFetch(undefined, summary({ canManage: false, settingsConsoleHref: null }));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Rates & alerts' }));
    expect(await screen.findByTestId('fund-rates-managed')).toHaveTextContent('Managed by Gifsy in the console.');
    expect(screen.queryByRole('link', { name: /Gifsy console/ })).not.toBeInTheDocument();
    const panel = screen.getByRole('tabpanel', { name: 'Rates & alerts' });
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('fund-scheduled-fee')).toHaveTextContent('Scheduled from 01 Dec 2026: 3.5% of each payout');
    const rows = screen.getAllByTestId('fund-item-row');
    expect(rows[0]).toHaveTextContent('Amazon Pay ₹500');
    expect(rows[0]).toHaveTextContent('3% from 01 Dec 2026');
    expect(rows[1]).toHaveTextContent('Deleted');
    expect(screen.getByTestId('fund-alert-view')).toHaveTextContent('Monday to Saturday, once an opening balance is recorded');
    expect(screen.getByTestId('fund-alert-view')).toHaveTextContent('to 1 recipient');
    expect(screen.queryByTestId('fund-alert-env')).not.toBeInTheDocument();
    // Never a write call from this tab.
    expect(fn.mock.calls.some((c) => ['POST', 'PUT'].includes(String((c[1] as RequestInit | undefined)?.method)))).toBe(false);
  });

  it('F10b: a Gifsy operator gets the console link and a loud test-environment notice', async () => {
    stubFetch(undefined, summary(), settings({ canManage: true, consoleHref: '/gifsy/clients/t#fund', alertEnvironment: 'test' }));
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    fireEvent.click(screen.getByRole('tab', { name: 'Rates & alerts' }));
    expect(await screen.findByRole('link', { name: /Gifsy console/ })).toHaveAttribute('href', '/gifsy/clients/t#fund');
    expect(screen.getByTestId('fund-alert-env')).toHaveTextContent(/TEST environment/);
  });

  it('F11 (C4/C15): the overview explains every flag in visible text; empty spend-by-type has an empty state', async () => {
    stubFetch(undefined, summary({
      byType: [],
      flagCounts: { DATE_ESTIMATED: 2, TDS_UNALLOCATED: 1, FACE_RECOMPUTED: 1, HUBBLE_NEEDS_RECONCILE: 1 },
      itemsWithoutRate: [{ rewardId: 'rw2', itemLabel: 'Old Flipkart', count: 4 }],
    }));
    render(<FundReconciliationPage />);
    const flags = await screen.findByTestId('fund-warn-flags');
    expect(flags).toHaveTextContent(/Face recomputed \(1\): The order's value was worked out again/);
    expect(flags).toHaveTextContent(/Date estimated \(2\)/);
    expect(flags).toHaveTextContent(/TDS not matched \(1\): This TDS could not be matched to a payout/);
    expect(flags).toHaveTextContent(/voucher provider/);
    expect(screen.getByTestId('fund-warn-items')).toHaveTextContent('1 voucher item without a discount');
    expect(screen.getByTestId('fund-warn-items')).toHaveTextContent('Old Flipkart (4)');
    expect(screen.getByRole('link', { name: /Gifsy console \(Fund section\)/ })).toHaveAttribute('href', '/gifsy/clients/t#fund');
    expect(screen.getByText(/No spend yet/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/Hubble/);
  });

  it('F12 (C15): tabs — arrow keys move focus/selection; each tab controls a tabpanel', async () => {
    stubFetch();
    render(<FundReconciliationPage />);
    await screen.findByTestId('fund-balance-card');
    const overview = screen.getByRole('tab', { name: 'Overview' });
    expect(document.getElementById(overview.getAttribute('aria-controls')!)).toHaveAttribute('role', 'tabpanel');
    overview.focus();
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    const statement = screen.getByRole('tab', { name: 'Statement' });
    expect(statement).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(statement);
    fireEvent.keyDown(statement, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Rates & alerts' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Rates & alerts' }), { key: 'ArrowRight' });
    expect(overview).toHaveAttribute('aria-selected', 'true');
  });

  it('F13 (C10): parseRupees accepts "+2500", the Unicode minus and grouping; rejects junk', () => {
    expect(parseRupees('+2500')).toBe(2500);
    expect(parseRupees('−2500')).toBe(-2500);
    expect(parseRupees('-2,500.50')).toBe(-2500.5);
    expect(parseRupees('₹ 1,50,000')).toBe(150000);
    expect(parseRupees('12.345')).toBeNull();
    expect(parseRupees('abc')).toBeNull();
    expect(parseRupees('+-5')).toBeNull();
  });
});
