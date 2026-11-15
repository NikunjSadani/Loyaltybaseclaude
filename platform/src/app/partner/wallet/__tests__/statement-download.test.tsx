/// <reference types="vitest/globals" />
/**
 * SD — Partner wallet statement download (Excel / PDF picker)
 *
 * SD1: Excel fetches /api/wallet/statement?from=<activeFrom>&to=<activeTo> and renders the shared doc
 * SD2: the export IGNORES the Earn/Burn chips (owner D4): with "Burn" selected the doc still
 *      contains the credit rows, plus the opening/closing balance from the statement
 * SD3: the button is disabled when the selected period has no rows
 * SD4: PDF goes through the PDF renderer with the fixed "Wallet Statement" title
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { StatementDoc } from '@/lib/wallet-statement/statement-model';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
const BASE_IDENTITY = {
  businessName: 'Anil Traders', outletName: 'Anil Traders Outlet', ownerName: 'Owner', partnerCode: 'P1',
  outletType: 'SSS', hasPointsActivity: true, hasPayoutActivity: true, loyaltyEnabled: true,
  resolved: true, loading: false, activePartnerId: null as string | null,
  operableOutlets: [] as Array<{ partnerId: string; outletCode: string; isOwnLogin: boolean }>,
};
let mockIdentity: Record<string, unknown> = { ...BASE_IDENTITY };
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => mockIdentity,
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

import WalletPage from '../page';
import { statementPayload } from './statement-fixture';

const ROWS = [
  { id: 'c1', transactionType: 'CREDIT_POINTS_EARNED', description: 'Points earned', points: 1000,
    date: '2026-04-10T06:00:00.000Z', balanceAfter: 1200, fieldName: 'Monthly Target' },
  { id: 'd1', transactionType: 'DEBIT_REDEMPTION', description: 'Redeemed a voucher', points: -300,
    date: '2026-05-12T06:00:00.000Z', balanceAfter: 900 },
];
const PAYOUTS = [
  { id: 'p1', status: 'PAID', period: '2026-05', kpiLabel: 'Visibility', achievedPct: 100,
    payoutAmountPaise: 250_000, uploadedAt: '2026-05-02T06:00:00.000Z', paidAt: '2026-05-15T06:00:00.000Z', utr: 'UTR1' },
];

function stubFetch(
  rows: unknown[] = ROWS,
  outletCode = 'OUT-1',
  opts: { outletName?: string | null } = { outletName: 'Anil Traders Outlet' },
) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const u = String(url);
    if (u.startsWith('/api/wallet/statement'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve(statementPayload(rows as typeof ROWS, outletCode, opts)) });
    if (u.includes('/api/partner/payouts'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { payouts: PAYOUTS } }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  }));
}

async function renderWallet() {
  render(<WalletPage />);
  await waitFor(() => expect(screen.getByTestId('statement-controls-row')).toBeInTheDocument(), { timeout: 3000 });
}

async function pick(label: 'Excel (.xlsx)' | 'PDF') {
  fireEvent.click(screen.getByTestId('statement-download-btn'));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
  await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
}

describe('SD — partner wallet statement download', () => {
  beforeEach(() => {
    mockIdentity = { ...BASE_IDENTITY };
    downloadBlob.mockReset();
    statementToXlsxBlob.mockClear();
    statementToPdfBlob.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('SD1: Excel fetches the statement for the active range and saves an .xlsx', async () => {
    stubFetch();
    await renderWallet();
    await waitFor(() => expect(screen.getByTestId('statement-download-btn')).not.toBeDisabled());
    await pick('Excel (.xlsx)');
    const urls = vi.mocked(global.fetch).mock.calls.map((c) => String(c[0]));
    // The default period snaps to the full activity range: Apr 2026 (first row) .. May 2026.
    expect(urls).toContain('/api/wallet/statement?from=2026-04&to=2026-05');
    expect(statementToXlsxBlob).toHaveBeenCalledTimes(1);
    expect(downloadBlob.mock.calls[0][1]).toBe('wallet-statement-OUT-1-2026-04_2026-05.xlsx');
  });

  it('SD2: the export ignores the Earn/Burn filter — with "Burn" selected the credit row is still in the doc', async () => {
    stubFetch();
    await renderWallet();
    fireEvent.click(screen.getByRole('button', { name: 'Burn' }));
    // On screen the credit row is filtered out…
    await waitFor(() => expect(screen.queryByText('Monthly Target')).toBeNull());
    await pick('Excel (.xlsx)');
    const doc = statementToXlsxBlob.mock.calls[0][0];
    // …but the downloaded statement is the full range: both points rows + the payout, oldest first.
    expect(doc.lines.map((l) => l.kind === 'points' ? l.points : `pay:${l.amountInr}`)).toEqual([1000, -300, 'pay:2500']);
    expect(doc.openingBalance).toBe(200);
    expect(doc.closingBalance).toBe(900);
    expect(doc.title).toBe('Wallet Statement');
    expect(doc.outletName).toBe('Anil Traders Outlet');
    expect(doc.outletCode).toBe('OUT-1');
  });

  it('SD3: the Download button is disabled when the selected period has no rows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.startsWith('/api/wallet/statement'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(statementPayload([])) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { payouts: [] } }) });
    }));
    await renderWallet();
    expect(screen.getByTestId('statement-download-btn')).toBeDisabled();
  });

  it('SD4: PDF goes through the PDF renderer', async () => {
    stubFetch();
    await renderWallet();
    await waitFor(() => expect(screen.getByTestId('statement-download-btn')).not.toBeDisabled());
    await pick('PDF');
    expect(statementToPdfBlob).toHaveBeenCalledTimes(1);
    expect(downloadBlob.mock.calls[0][1]).toBe('wallet-statement-OUT-1-2026-04_2026-05.pdf');
  });
});

/**
 * SDO — the statement's outlet NAME and CODE are always the same outlet. The shell identity may hold
 * the login's own outlet A (seeded from storage, /partner/me pending or failed) while the active
 * selection — and so the statement API — is sibling B.
 */
describe('SDO — statement outlet name/code always the same outlet', () => {
  beforeEach(() => {
    mockIdentity = { ...BASE_IDENTITY };
    downloadBlob.mockReset();
    statementToXlsxBlob.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  const OUTLET_A = { outletName: 'Store A', businessName: 'Firm A' };

  it.each([
    ['pending', { resolved: false, loading: true }],
    ['failed', { resolved: false, loading: false }],
    ['resolved (stale A)', { resolved: true, loading: false }],
  ])('SDO1: identity %s on outlet A, statement API = B → the doc names B with B\'s code', async (_l, state) => {
    mockIdentity = { ...BASE_IDENTITY, ...OUTLET_A, ...state };
    stubFetch(ROWS, 'OUT-B', { outletName: 'Store B' });
    await renderWallet();
    await waitFor(() => expect(screen.getByTestId('statement-download-btn')).not.toBeDisabled());
    await pick('Excel (.xlsx)');
    const doc = statementToXlsxBlob.mock.calls[0][0];
    expect(doc.outletName).toBe('Store B');
    expect(doc.outletCode).toBe('OUT-B');
  });

  it.each([
    ['pending', { resolved: false, loading: true }],
    ['failed', { resolved: false, loading: false }],
  ])('SDO2: API without a name + identity %s → download BLOCKED (no mixed doc built)', async (_l, state) => {
    mockIdentity = { ...BASE_IDENTITY, ...OUTLET_A, ...state };
    stubFetch(ROWS, 'OUT-B', { outletName: undefined });
    await renderWallet();
    await waitFor(() => expect(screen.getByTestId('statement-download-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('statement-download-btn'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Excel (.xlsx)' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(statementToXlsxBlob).not.toHaveBeenCalled();
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('SDO3: API without a name + resolved identity whose ACTIVE outlet has a different code → BLOCKED', async () => {
    mockIdentity = {
      ...BASE_IDENTITY, ...OUTLET_A, activePartnerId: null,
      operableOutlets: [
        { partnerId: 'pa', outletCode: 'OUT-A', isOwnLogin: true },
        { partnerId: 'pb', outletCode: 'OUT-B', isOwnLogin: false },
      ],
    };
    stubFetch(ROWS, 'OUT-B', { outletName: undefined });
    await renderWallet();
    await waitFor(() => expect(screen.getByTestId('statement-download-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('statement-download-btn'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Excel (.xlsx)' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(statementToXlsxBlob).not.toHaveBeenCalled();
  });

  it('SDO4: API without a name + resolved identity whose active outlet IS the statement outlet → identity name', async () => {
    mockIdentity = {
      ...BASE_IDENTITY, outletName: 'Store B', businessName: 'Firm B', activePartnerId: 'pb',
      operableOutlets: [
        { partnerId: 'pa', outletCode: 'OUT-A', isOwnLogin: true },
        { partnerId: 'pb', outletCode: 'OUT-B', isOwnLogin: false },
      ],
    };
    stubFetch(ROWS, 'OUT-B', { outletName: undefined });
    await renderWallet();
    await waitFor(() => expect(screen.getByTestId('statement-download-btn')).not.toBeDisabled());
    await pick('Excel (.xlsx)');
    const doc = statementToXlsxBlob.mock.calls[0][0];
    expect([doc.outletName, doc.outletCode]).toEqual(['Store B', 'OUT-B']);
  });
});
