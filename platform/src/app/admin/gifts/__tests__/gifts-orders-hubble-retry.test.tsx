/// <reference types="vitest/globals" />
/**
 * GIFHR — "Retry with Hubble" visibility matrix (owner 2026-11-24: any open order handed to Hubble,
 * not only flagged ones) + the muted "Waiting via API since … · last checked …" line.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AdminGiftsPage from '../page';

const session = vi.hoisted(() => ({ role: 'GIFSY_ADMIN' as string, perms: [] as string[] }));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: session.role }) }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({
    role: session.role, permissions: session.perms, ready: true, error: false,
    has: (p: string) => session.role !== 'GIFSY_STAFF' || session.perms.includes(p), retry: () => {},
  }),
}));

const base = {
  reward: { id: 'r1', name: 'Amazon', redemptionMode: 'GIFT_CARD' },
  partner: { id: 'p1', businessName: 'Store', outletCode: 'BJ-1', phone: '98' },
  redemptionMode: 'GIFT_CARD', totalPointsCost: 500,
  createdAt: '2026-11-24T05:10:00.000Z', updatedAt: '2026-11-24T05:15:00.000Z',
};
const ORDERS = [
  // Unflagged, handed to Hubble, still PROCESSING (the prod incident shape).
  { ...base, id: 'w', orderNumber: 'WAITING', status: 'PROCESSING', voucherProvider: 'Hubble',
    hubbleHanded: true, hubbleWaitingSince: '2026-11-24T05:15:00.000Z', hubbleLastCheckedAt: new Date(Date.now() - 4 * 60_000).toISOString() },
  // Flagged stale.
  { ...base, id: 's', orderNumber: 'STALE', status: 'PROCESSING', voucherProvider: 'Hubble',
    hubbleHanded: true, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_STILL_OPEN_STALE' },
  // Never handed to Hubble (manual / Deoleo-like).
  { ...base, id: 'm', orderNumber: 'MANUAL', status: 'CONFIRMED', voucherProvider: null, hubbleHanded: false },
  // Delivered Hubble order.
  { ...base, id: 'd', orderNumber: 'DONE-1', status: 'DELIVERED', voucherProvider: 'Hubble', voucherCode: 'CARD-1', hubbleHanded: false },
];

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
}
function installFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/rewards/orders')) return jsonOk({ orders: ORDERS, pagination: { page: 1, limit: 100, total: 4, pages: 1 }, nextCursor: null });
    if (url.startsWith('/api/admin/rewards/catalog')) return jsonOk({ items: [], pagination: { page: 1, limit: 200, total: 0, pages: 0 } });
    if (url.startsWith('/api/admin/rewards/categories')) return jsonOk({ categories: [] });
    return jsonOk({});
  }));
}
async function open() {
  render(<AdminGiftsPage />);
  await userEvent.click(await screen.findByRole('button', { name: /fulfilment/i }));
  await screen.findByText('WAITING');
}
const row = (n: string) => screen.getByText(n).closest('tr') as HTMLElement;
const retryIn = (n: string) => within(row(n)).queryByRole('button', { name: 'Retry with Hubble' });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); session.role = 'GIFSY_ADMIN'; session.perms = []; });

describe('GIFHR — Retry with Hubble visibility', () => {
  it('GIFSY_ADMIN: Retry on the unflagged waiting order AND the stale-flagged one; not on manual / delivered', async () => {
    installFetch();
    await open();
    expect(retryIn('WAITING')).toBeInTheDocument();
    expect(retryIn('STALE')).toBeInTheDocument();
    expect(retryIn('MANUAL')).not.toBeInTheDocument();
    expect(retryIn('DONE-1')).not.toBeInTheDocument();
    // The stale flag reads in plain words and keeps "Fulfil manually".
    expect(within(row('STALE')).getByText(/Still processing via API/)).toBeInTheDocument();
    expect(within(row('STALE')).getByRole('button', { name: /fulfil manually/i })).toBeInTheDocument();
    // OWNER 2026-11-24: no "Advance" on a Hubble order without a code (backend refuses it too);
    // a non-Hubble order keeps it.
    expect(within(row('WAITING')).queryByRole('button', { name: 'Advance' })).not.toBeInTheDocument();
    expect(within(row('STALE')).queryByRole('button', { name: 'Advance' })).not.toBeInTheDocument();
    expect(within(row('MANUAL')).getByRole('button', { name: 'Advance' })).toBeInTheDocument();
    // Audit I: "Fulfil manually…" is offered on the UNFLAGGED waiting order too (the block message names it).
    await userEvent.click(within(row('WAITING')).getByRole('button', { name: /fulfil manually/i }));
    expect(await screen.findByText(/Fulfil this Hubble order manually/)).toBeInTheDocument();
  });

  it('audit J: HUBBLE_NOT_ELIGIBLE_NOW reads "API can’t be checked — fulfil manually" (no refund promise)', async () => {
    ORDERS.push({ ...base, id: 'n', orderNumber: 'NOTELIG', status: 'CONFIRMED', voucherProvider: null,
      hubbleHanded: true, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_NOT_ELIGIBLE_NOW' } as never);
    try {
      installFetch();
      await open();
      expect(within(row('NOTELIG')).getByText(/API can’t be checked — fulfil manually$/)).toBeInTheDocument();
    } finally {
      ORDERS.pop();
    }
  });

  it('audit K: past the 7-day window the waiting line says it needs ops action', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    ORDERS.push({ ...base, id: 'o', orderNumber: 'OLDWAIT', status: 'PROCESSING', voucherProvider: 'Hubble',
      hubbleHanded: true, hubbleWaitingSince: old, hubbleLastCheckedAt: null } as never);
    try {
      installFetch();
      await open();
      expect(within(row('OLDWAIT')).getByTestId('hubble-waiting')).toHaveTextContent(/over 7 days — needs ops action/);
    } finally {
      ORDERS.pop();
    }
  });

  it('the unflagged waiting order shows "Waiting via API since <IST> · last checked <relative>"', async () => {
    installFetch();
    await open();
    const line = within(row('WAITING')).getByTestId('hubble-waiting');
    expect(line.textContent).toMatch(/^Waiting via API since 24 Nov 2026, 10:45 am · last checked 4 min ago$/i);
    expect(within(row('STALE')).queryByTestId('hubble-waiting')).not.toBeInTheDocument();
  });

  it.each([
    ['GIFSY_STAFF with manage_orders', 'GIFSY_STAFF', ['rewards:read', 'rewards:manage_orders']],
    ['CLIENT_ADMIN (view only)', 'CLIENT_ADMIN', []],
  ])('%s: no Retry button (GIFSY_ADMIN only, as before)', async (_l, role, perms) => {
    session.role = role; session.perms = perms;
    installFetch();
    await open();
    expect(retryIn('WAITING')).not.toBeInTheDocument();
    expect(retryIn('STALE')).not.toBeInTheDocument();
    if (role === 'GIFSY_STAFF') {
      // Audit I: an operator who can't act sees WHY instead of a bare dash.
      expect(within(row('WAITING')).getByTestId('hubble-held-note')).toHaveTextContent('With the API — a Gifsy admin can retry or fulfil');
      expect(within(row('MANUAL')).queryByTestId('hubble-held-note')).not.toBeInTheDocument();
    }
  });
});
