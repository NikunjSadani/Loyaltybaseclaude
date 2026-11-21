/// <reference types="vitest/globals" />
/**
 * Held opening balances — Gifsy console page (/gifsy/held-opening-balances)
 *
 * H1: renders rows + summary totals (Indian number format, failed tile red, pending breakdown, server state text)
 * H2: Apply now → preview (mode + balance before→after) → confirm POSTs apply
 * H3: an apply result with status FAILED shows the failureReason loudly
 * H4: cancel requires a non-empty reason, then POSTs it
 * H5: no-wallet rows have no Apply button; stateLabel + nextStep shown (incl. FAILED)
 * H6: a list error surfaces in a visible banner
 * H7: a temporary-error PENDING apply result shows amber, not success
 * H8: double-click on Confirm apply / Confirm cancel POSTs once
 * H9: Run sweep now posts /sweep, shows the counts, refreshes
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-client')>();
  return {
    ...actual,
    getStoredUser: () => ({ id: 'u1', name: 'Owner', role: 'GIFSY_ADMIN', phone: '900' }),
  };
});

import GifsyHeldOpeningBalancesPage from '../page';

const baseRow = {
  outletExists: true,
  walletHasActivity: false,
  eventCount: 12,
  source: 'vendor-import',
  appliedAt: null,
  appliedWalletId: null,
  applyMode: null,
  sequencing: null,
  failureReason: null,
  cancelReason: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  nextStep: null,
  attempts: 0,
  lastError: null,
  asOfDate: '2026-10-31',
};

const ROWS = [
  {
    ...baseRow, id: 'h1', outletCode: 'OUT001', outletName: 'Sharma Stores', hasWallet: true, walletHasActivity: true,
    closingPoints: 122845, status: 'PENDING', state: 'NEEDS_APPLY_NOW',
    stateLabel: 'Wallet has activity — needs Apply now', nextStep: 'Use Apply now to post one opening adjustment',
    attempts: 2, lastError: 'DB timeout',
  },
  {
    ...baseRow, id: 'h2', outletCode: 'OUT002', outletName: null, outletExists: false, hasWallet: false,
    closingPoints: 500, status: 'PENDING', state: 'NOT_ON_PORTAL',
    stateLabel: 'Not on portal (no outlet with this code)', nextStep: 'Onboard the outlet; it applies after KYC approval',
  },
  {
    ...baseRow, id: 'h3', outletCode: 'OUT003', outletName: 'Gupta Mart', hasWallet: true, closingPoints: 900,
    status: 'APPLIED', appliedAt: '2026-11-20T20:00:00.000Z', applyMode: 'FULL_PASSBOOK', state: 'APPLIED', stateLabel: 'Applied',
  },
  {
    ...baseRow, id: 'h4', outletCode: 'OUT004', outletName: 'Rao Traders', hasWallet: false, closingPoints: 4000,
    status: 'FAILED', failureReason: 'Outlet code matches 2 outlets', state: 'FAILED',
    stateLabel: 'Failed — Outlet code matches 2 outlets', nextStep: 'Fix the duplicate outlet code, then retry',
  },
];

const LIST = {
  clientId: 'bajaj',
  total: 4,
  page: 1,
  pageSize: 50,
  totals: {
    PENDING: { count: 2, points: 123345 },
    APPLIED: { count: 1, points: 900 },
    FAILED: { count: 1, points: 4000 },
    CANCELLED: { count: 0, points: 0 },
  },
  pendingByState: {
    NOT_ON_PORTAL: { count: 1, points: 500 },
    AWAITING_KYC: { count: 0, points: 0 },
    WALLET_EMPTY: { count: 0, points: 0 },
    NEEDS_APPLY_NOW: { count: 1, points: 122845 },
    AMBIGUOUS_OUTLET: { count: 0, points: 0 },
  },
  rows: ROWS,
};

const PREVIEW = {
  id: 'h1', outletCode: 'OUT001', closingPoints: 122845, canApply: true, blockedReason: null,
  mode: 'OPENING_ADJUSTMENT', walletId: 'w1', balanceBefore: 1000, balanceAfter: 123845, eventCount: 12,
};

const APPLIED_RESULT = {
  id: 'h1', status: 'APPLIED', appliedAt: '2026-11-21T00:00:00Z', balanceBefore: 1000, balanceAfter: 123845,
  failureReason: null, applyMode: 'OPENING_ADJUSTMENT',
};

function jsonRes(data: unknown, ok = true, status = 200) {
  return {
    ok, status, statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(ok ? { success: true, data } : { success: false, error: data }),
  };
}
const json = (data: unknown, ok = true, status = 200) => Promise.resolve(jsonRes(data, ok, status));

type Handler = (url: string, init?: RequestInit) => unknown;

function stubFetch(overrides: { apply?: Handler; cancel?: Handler; list?: Handler } = {}) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.startsWith('/api/gifsy/clients')) {
      return json({ clients: [{ slug: 'bajaj', internalName: 'Bajaj', status: 'ACTIVE' }] });
    }
    if (u.includes('/sweep') && method === 'POST') {
      return json({ processed: 5, applied: 3, failed: 1, retrying: 1 });
    }
    if (u.includes('/apply') && method === 'POST') {
      return overrides.apply ? overrides.apply(u, init) : json(APPLIED_RESULT);
    }
    if (u.includes('/cancel') && method === 'POST') {
      return overrides.cancel ? overrides.cancel(u, init) : json({ ...ROWS[0], status: 'CANCELLED', cancelReason: 'dup' });
    }
    if (u.includes('/preview')) return json(PREVIEW);
    if (u.startsWith('/api/admin/held-opening-balances')) {
      return overrides.list ? overrides.list(u, init) : json(LIST);
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calls = (m: ReturnType<typeof stubFetch>, part: string, method = 'GET') =>
  m.mock.calls.filter(([u, init]) => String(u).includes(part) && ((init as RequestInit | undefined)?.method ?? 'GET') === method);

beforeEach(() => {
  window.history.replaceState(null, '', '/gifsy/held-opening-balances?clientId=bajaj');
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Held opening balances page', () => {
  it('H1: renders rows, summary totals, pending breakdown and server state text', async () => {
    const fetchMock = stubFetch();
    render(<GifsyHeldOpeningBalancesPage />);

    const row = await screen.findByTestId('row-h1');
    expect(within(row).getByText('OUT001')).toBeInTheDocument();
    expect(within(row).getByText('Sharma Stores')).toBeInTheDocument();
    expect(within(row).getByText('1,22,845')).toBeInTheDocument();
    expect(within(screen.getByTestId('row-h2')).getByText('Not on the portal yet')).toBeInTheDocument();
    // 20:00Z on 20 Nov = 01:30 IST on 21 Nov
    expect(within(screen.getByTestId('row-h3')).getByText('21 Nov 2026')).toBeInTheDocument();

    const pending = screen.getByTestId('tile-PENDING');
    expect(within(pending).getByText('Waiting')).toBeInTheDocument();
    expect(within(pending).getByText('1,23,345 pts')).toBeInTheDocument();
    expect(screen.getByTestId('tile-FAILED').className).toMatch(/red/);
    expect(screen.getByTestId('tile-CANCELLED').className).not.toMatch(/red/);

    // Pending breakdown: only non-zero states; NEEDS_APPLY_NOW in amber.
    expect(screen.getByTestId('pending-NOT_ON_PORTAL')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-AWAITING_KYC')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-AMBIGUOUS_OUTLET')).not.toBeInTheDocument();
    expect(screen.getByTestId('pending-NEEDS_APPLY_NOW').className).toMatch(/amber/);
    expect(screen.getByTestId('pending-NOT_ON_PORTAL').className).not.toMatch(/amber/);

    // Server state text verbatim + next step + retry note.
    expect(within(row).getByText('Wallet has activity — needs Apply now')).toBeInTheDocument();
    expect(within(row).getByText('Use Apply now to post one opening adjustment')).toBeInTheDocument();
    expect(within(row).getByTestId('retrying-h1').textContent)
      .toBe('Retrying after a temporary error: DB timeout (attempt 2)');

    const listCall = calls(fetchMock, '/api/admin/held-opening-balances?')[0];
    expect(String(listCall[0])).toContain('clientId=bajaj');
    expect(String(listCall[0])).toContain('pageSize=50');
  });

  it('H2: Apply now previews before→after and posts apply', async () => {
    const fetchMock = stubFetch();
    render(<GifsyHeldOpeningBalancesPage />);
    const row = await screen.findByTestId('row-h1');
    fireEvent.click(within(row).getByRole('button', { name: 'Apply now for OUT001' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const mode = within(dialog).getByTestId('apply-mode').textContent ?? '';
    expect(mode).toContain('posts ONE opening-balance adjustment of 1,22,845 pts today');
    expect(mode).toContain('Opening balance from previous programme (as of 31 Oct 2026)');
    expect(within(dialog).getByTestId('apply-balance').textContent).toContain('1,000 → 1,23,845');
    expect(calls(fetchMock, '/h1/preview?clientId=bajaj')).toHaveLength(1);

    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'migrated late' } });
    fireEvent.click(within(dialog).getByTestId('confirm-apply'));

    await waitFor(() => expect(calls(fetchMock, '/h1/apply?clientId=bajaj', 'POST')).toHaveLength(1));
    const body = JSON.parse((calls(fetchMock, '/h1/apply', 'POST')[0][1] as RequestInit).body as string);
    expect(body).toEqual({ reason: 'migrated late' });
    expect(await screen.findByText(/Applied 1,22,845 pts to OUT001/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(calls(fetchMock, '/api/admin/held-opening-balances?').length).toBeGreaterThanOrEqual(2));
  });

  it('H3: a FAILED apply result shows the failure reason loudly', async () => {
    stubFetch({
      apply: () => json({ id: 'h1', status: 'FAILED', appliedAt: null, balanceBefore: 1000, balanceAfter: null, failureReason: 'Wallet is frozen', applyMode: null }),
    });
    render(<GifsyHeldOpeningBalancesPage />);
    const row = await screen.findByTestId('row-h1');
    fireEvent.click(within(row).getByRole('button', { name: 'Apply now for OUT001' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-apply'));

    const failed = await screen.findByTestId('apply-failed');
    expect(failed.textContent).toContain('Wallet is frozen');
    expect(screen.queryByText(/Applied 1,22,845 pts/)).not.toBeInTheDocument();
    expect(await screen.findByTestId('confirm-apply')).toBeDisabled();
  });

  it('H4: cancel requires a reason, then posts it', async () => {
    const fetchMock = stubFetch();
    render(<GifsyHeldOpeningBalancesPage />);
    const row = await screen.findByTestId('row-h1');
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel held balance for OUT001' }));

    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByTestId('confirm-cancel');
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason (required)'), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason (required)'), { target: { value: 'Duplicate outlet' } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(calls(fetchMock, '/h1/cancel?clientId=bajaj', 'POST')).toHaveLength(1));
    const body = JSON.parse((calls(fetchMock, '/h1/cancel', 'POST')[0][1] as RequestInit).body as string);
    expect(body).toEqual({ reason: 'Duplicate outlet' });
    expect(await screen.findByText('Cancelled the held balance for OUT001.')).toBeInTheDocument();
  });

  it('H5: no-wallet rows have no Apply button; stateLabel + nextStep shown (incl. FAILED)', async () => {
    stubFetch();
    render(<GifsyHeldOpeningBalancesPage />);
    const row = await screen.findByTestId('row-h2');
    expect(within(row).queryByRole('button', { name: /Apply now/ })).not.toBeInTheDocument();
    expect(within(row).getByText('Not on portal (no outlet with this code)')).toBeInTheDocument();
    expect(within(row).getByText('Onboard the outlet; it applies after KYC approval')).toBeInTheDocument();
    expect(screen.queryByText('Waits for KYC approval — applied automatically')).not.toBeInTheDocument();

    const failed = screen.getByTestId('row-h4');
    expect(within(failed).queryByRole('button', { name: /Apply now/ })).not.toBeInTheDocument();
    expect(within(failed).getByText('Outlet code matches 2 outlets')).toBeInTheDocument();
    expect(within(failed).getByText('Fix the duplicate outlet code, then retry')).toBeInTheDocument();
    expect(within(failed).getByRole('button', { name: 'Cancel held balance for OUT004' })).toBeInTheDocument();
    // APPLIED row has no actions at all
    expect(within(screen.getByTestId('row-h3')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('H6: a list error surfaces in a visible banner', async () => {
    stubFetch({ list: () => json('Client not found', false, 404) });
    render(<GifsyHeldOpeningBalancesPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Client not found');
  });

  it('H7: a temporary-error PENDING apply result is shown amber, not as success', async () => {
    stubFetch({
      apply: () => json({ id: 'h1', status: 'PENDING', appliedAt: null, balanceBefore: 1000, balanceAfter: null, failureReason: 'Temporary error — lock timeout', applyMode: null }),
    });
    render(<GifsyHeldOpeningBalancesPage />);
    const row = await screen.findByTestId('row-h1');
    fireEvent.click(within(row).getByRole('button', { name: 'Apply now for OUT001' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-apply'));
    const retry = await screen.findByTestId('apply-retrying');
    expect(retry.textContent).toContain('Temporary error — lock timeout');
    expect(retry.className).toMatch(/amber/);
    expect(screen.queryByText(/Applied 1,22,845 pts/)).not.toBeInTheDocument();
  });

  it('H8: double-clicking Confirm apply / Confirm cancel POSTs once', async () => {
    let resolveApply: (v: unknown) => void = () => {};
    const fetchMock = stubFetch({
      apply: () => new Promise((r) => { resolveApply = r; }),
    });
    render(<GifsyHeldOpeningBalancesPage />);
    const row = await screen.findByTestId('row-h1');
    fireEvent.click(within(row).getByRole('button', { name: 'Apply now for OUT001' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByTestId('confirm-apply');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(calls(fetchMock, '/h1/apply', 'POST')).toHaveLength(1));
    resolveApply(jsonRes(APPLIED_RESULT));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls(fetchMock, '/h1/apply', 'POST')).toHaveLength(1);

    fireEvent.click(within(await screen.findByTestId('row-h1')).getByRole('button', { name: 'Cancel held balance for OUT001' }));
    const cdialog = await screen.findByRole('dialog');
    fireEvent.change(within(cdialog).getByLabelText('Reason (required)'), { target: { value: 'dup' } });
    const cconfirm = within(cdialog).getByTestId('confirm-cancel');
    fireEvent.click(cconfirm);
    fireEvent.click(cconfirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls(fetchMock, '/h1/cancel', 'POST')).toHaveLength(1);
  });

  it('H9: Run sweep now POSTs /sweep without clientId, shows the result and refreshes', async () => {
    const fetchMock = stubFetch();
    render(<GifsyHeldOpeningBalancesPage />);
    await screen.findByTestId('row-h1');
    const before = calls(fetchMock, '/api/admin/held-opening-balances?').length;
    const btn = screen.getByTestId('run-sweep');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(await screen.findByText('Sweep finished — processed 5, applied 3, failed 1, retrying 1.')).toBeInTheDocument();
    const sweeps = calls(fetchMock, '/sweep', 'POST');
    expect(sweeps).toHaveLength(1);
    expect(String(sweeps[0][0])).toBe('/api/admin/held-opening-balances/sweep');
    await waitFor(() => expect(calls(fetchMock, '/api/admin/held-opening-balances?').length).toBeGreaterThan(before));
  });
});
