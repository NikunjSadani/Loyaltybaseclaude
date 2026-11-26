/// <reference types="vitest/globals" />
/**
 * GIFNF — OWNER RULE (2026-11-26, all clients): a CLIENT admin never sees that vouchers come from Hubble.
 * The server hands a non-Gifsy viewer the order with neutral VALUES (voucherProvider "Via API", API_* reason
 * codes — rewards.service clientSafeOrderFulfiller; field names unchanged). The view-only Redemption orders list
 * still shows every signal ("Needs reconcile", the waiting line), in neutral words, and no "Hubble" anywhere —
 * not in text, not in a tooltip.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AdminGiftsPage from '../page';

const session = vi.hoisted(() => ({ role: 'CLIENT_ADMIN' as string }));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: session.role }) }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({ role: session.role, permissions: [], ready: true, error: false, has: () => true, retry: () => {} }),
}));

const base = {
  reward: { id: 'r1', name: 'Amazon Pay', redemptionMode: 'GIFT_CARD' },
  partner: { id: 'p1', businessName: 'Store', outletCode: 'BJ-1', phone: 'XXXXXX1234' },
  redemptionMode: 'GIFT_CARD', totalPointsCost: 500,
  createdAt: '2026-11-24T05:10:00.000Z', updatedAt: '2026-11-24T05:15:00.000Z',
};
/** Exactly what the API returns to a CLIENT_ADMIN (neutral values; field names unchanged). */
const CLIENT_ORDERS = [
  { ...base, id: 'w', orderNumber: 'WAITING', status: 'PROCESSING', voucherProvider: 'Via API',
    hubbleHanded: true, hubbleWaitingSince: '2026-11-24T05:15:00.000Z', hubbleLastCheckedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    hubbleNeedsReconcile: false, hubbleReconcileReason: null },
  { ...base, id: 's', orderNumber: 'STUCK', status: 'PROCESSING', voucherProvider: 'Via API',
    hubbleHanded: true, hubbleNeedsReconcile: true, hubbleReconcileReason: 'API_INDETERMINATE',
    hubbleLatestReason: 'API_WEBHOOK_BUT_NOT_FOUND',
    hubbleNoOrderUnverifiedWhy: 'no delivered API order on this API account to verify against' },
  { ...base, id: 'd', orderNumber: 'DONE-1', status: 'DELIVERED', voucherProvider: 'Via API', voucherIssued: true, voucherCodeMasked: true, voucherCode: null },
];

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
}
function installFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/rewards/orders')) return jsonOk({ orders: CLIENT_ORDERS, pagination: { page: 1, limit: 100, total: 3, pages: 1 }, nextCursor: null });
    if (url.startsWith('/api/admin/rewards/catalog')) return jsonOk({ items: [], pagination: { page: 1, limit: 200, total: 0, pages: 0 } });
    if (url.startsWith('/api/admin/rewards/categories')) return jsonOk({ categories: [] });
    return jsonOk({});
  }));
}
const row = (n: string) => screen.getByText(n).closest('tr') as HTMLElement;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); session.role = 'CLIENT_ADMIN'; });

describe('GIFNF — client admin Redemption orders never name the fulfiller', () => {
  it('signals stay visible in neutral words; no "Hubble" in text or tooltips', async () => {
    installFetch();
    render(<AdminGiftsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /fulfilment/i }));
    await screen.findByText('WAITING');
    expect(within(row('STUCK')).getByTestId('hubble-needs-reconcile')).toHaveTextContent('Needs reconcile · API state unknown');
    expect(within(row('STUCK')).getByTestId('hubble-latest-reason')).toHaveTextContent(/^Newer: API update received/);
    expect(within(row('STUCK')).getByTestId('hubble-no-order-unverified')).toHaveTextContent(/API said “no order”, not trusted/);
    expect(within(row('WAITING')).getByTestId('hubble-waiting')).toHaveTextContent(/^Waiting via API since/);
    // A client admin's list is view-only: no Retry / Advance controls.
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    const html = document.body.innerHTML.replace(/data-testid="[^"]*"/g, '');
    expect(document.body.textContent ?? '').not.toMatch(/hubble/i);
    expect(html).not.toMatch(/hubble/i);
  });

  it('the catalogue editor a client admin opens says "API", never "Hubble"', async () => {
    installFetch();
    render(<AdminGiftsPage />);
    const addButtons = await screen.findAllByRole('button', { name: /add reward/i });
    await userEvent.click(addButtons[addButtons.length - 1]);
    await screen.findByText('Add Reward', { selector: 'h2' });
    // GIFT_CARD is the default mode → the API product-id field is on screen.
    expect(screen.getByRole('button', { name: /load via api/i })).toBeInTheDocument();
    expect(screen.getByLabelText('API product ID')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/hubble/i);
  });
});
