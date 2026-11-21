/// <reference types="vitest/globals" />
/**
 * Held opening balances — Gifsy console page (/gifsy/held-opening-balances)
 *
 * H1: renders rows + summary totals (Indian number format, failed tile red)
 * H2: Apply now → preview (mode + balance before→after) → confirm POSTs apply
 * H3: an apply result with status FAILED shows the failureReason loudly
 * H4: cancel requires a non-empty reason, then POSTs it
 * H5: a PENDING row without a wallet shows no Apply button, only the KYC note
 * H6: a list error surfaces in a visible banner
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
};

const ROWS = [
  { ...baseRow, id: 'h1', outletCode: 'OUT001', outletName: 'Sharma Stores', hasWallet: true, closingPoints: 122845, status: 'PENDING' },
  { ...baseRow, id: 'h2', outletCode: 'OUT002', outletName: null, outletExists: false, hasWallet: false, closingPoints: 500, status: 'PENDING' },
  { ...baseRow, id: 'h3', outletCode: 'OUT003', outletName: 'Gupta Mart', hasWallet: true, closingPoints: 900, status: 'APPLIED', appliedAt: '2026-11-20T20:00:00.000Z', applyMode: 'FULL_PASSBOOK' },
];

const LIST = {
  clientId: 'bajaj',
  total: 3,
  page: 1,
  pageSize: 50,
  totals: {
    PENDING: { count: 2, points: 123345 },
    APPLIED: { count: 1, points: 900 },
    FAILED: { count: 1, points: 4000 },
    CANCELLED: { count: 0, points: 0 },
  },
  rows: ROWS,
};

const PREVIEW = {
  id: 'h1', outletCode: 'OUT001', closingPoints: 122845, canApply: true, blockedReason: null,
  mode: 'OPENING_ADJUSTMENT', walletId: 'w1', balanceBefore: 1000, balanceAfter: 123845, eventCount: 12,
};

function json(data: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok, status, statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(ok ? { success: true, data } : { success: false, error: data }),
  });
}

type Handler = (url: string, init?: RequestInit) => unknown;

function stubFetch(overrides: { apply?: Handler; cancel?: Handler; list?: Handler } = {}) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.startsWith('/api/gifsy/clients')) {
      return json({ clients: [{ slug: 'bajaj', internalName: 'Bajaj', status: 'ACTIVE' }] });
    }
    if (u.includes('/apply') && method === 'POST') {
      return overrides.apply ? overrides.apply(u, init) : json({ id: 'h1', status: 'APPLIED', appliedAt: '2026-11-21T00:00:00Z', balanceBefore: 1000, balanceAfter: 123845, failureReason: null });
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
  it('H1: renders rows and summary totals', async () => {
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
    expect(within(dialog).getByTestId('apply-mode').textContent).toContain('ONE opening-balance adjustment of 1,22,845 pts');
    expect(within(dialog).getByTestId('apply-balance').textContent).toContain('1,000 → 1,23,845');
    expect(calls(fetchMock, '/h1/preview?clientId=bajaj')).toHaveLength(1);

    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'migrated late' } });
    fireEvent.click(within(dialog).getByTestId('confirm-apply'));

    await waitFor(() => expect(calls(fetchMock, '/h1/apply?clientId=bajaj', 'POST')).toHaveLength(1));
    const body = JSON.parse((calls(fetchMock, '/h1/apply', 'POST')[0][1] as RequestInit).body as string);
    expect(body).toEqual({ reason: 'migrated late' });
    expect(await screen.findByText(/Applied 1,22,845 pts to OUT001/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // list refreshed after apply
    await waitFor(() => expect(calls(fetchMock, '/api/admin/held-opening-balances?').length).toBeGreaterThanOrEqual(2));
  });

  it('H3: a FAILED apply result shows the failure reason loudly', async () => {
    stubFetch({
      apply: () => json({ id: 'h1', status: 'FAILED', appliedAt: null, balanceBefore: 1000, balanceAfter: null, failureReason: 'Wallet is frozen' }),
    });
    render(<GifsyHeldOpeningBalancesPage />);
    const row = await screen.findByTestId('row-h1');
    fireEvent.click(within(row).getByRole('button', { name: 'Apply now for OUT001' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('confirm-apply'));

    const failed = await screen.findByTestId('apply-failed');
    expect(failed.textContent).toContain('Wallet is frozen');
    expect(screen.queryByText(/Applied 1,22,845 pts/)).not.toBeInTheDocument();
    expect(screen.getByTestId('confirm-apply')).toBeDisabled();
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

  it('H5: a no-wallet PENDING row has no Apply button, only the KYC note', async () => {
    stubFetch();
    render(<GifsyHeldOpeningBalancesPage />);
    const row = await screen.findByTestId('row-h2');
    expect(within(row).queryByRole('button', { name: /Apply now/ })).not.toBeInTheDocument();
    expect(within(row).getByText('Waits for KYC approval — applied automatically')).toBeInTheDocument();
    // APPLIED row has no actions at all
    expect(within(screen.getByTestId('row-h3')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('H6: a list error surfaces in a visible banner', async () => {
    stubFetch({ list: () => json('Client not found', false, 404) });
    render(<GifsyHeldOpeningBalancesPage />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Client not found');
  });
});
