/// <reference types="vitest/globals" />
/**
 * GIFVC — voucher handling on the Fulfilment queue (money paths).
 *  - voucher fields are sent ONLY for a forward move whose inputs are on screen; switching the
 *    target clears them (a code can never ride on a refund move);
 *  - an order that already has a code shows it read-only (no editable input); Hubble → no input;
 *  - an issued code hides the refund targets; GIFSY_ADMIN gets "Voucher cancelled with vendor…"
 *    (reason required) and, once the code is cleared, the refund targets appear.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  reward: { id: 'r1', name: 'Amazon Voucher 500', redemptionMode: 'GIFT_CARD' },
  partner: { id: 'p1', businessName: 'Store One' },
  redemptionMode: 'GIFT_CARD', totalPointsCost: 500,
  createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
};

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
}

function installFetch(orders: unknown[], extra?: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const c = extra?.(url, init);
    if (c !== undefined) return c as Promise<unknown>;
    if (url.startsWith('/api/rewards/orders?')) {
      return jsonOk({ orders, pagination: { page: 1, limit: 100, total: orders.length, pages: 1 }, nextCursor: null });
    }
    if (url.startsWith('/api/admin/rewards/catalog')) return jsonOk({ items: [], pagination: { page: 1, limit: 200, total: 0, pages: 0 } });
    if (url.startsWith('/api/admin/rewards/categories')) return jsonOk({ categories: [] });
    return jsonOk({});
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

async function openRow(orderNumber: string) {
  render(<AdminGiftsPage />);
  await userEvent.click(await screen.findByRole('button', { name: /fulfilment/i }));
  return (await screen.findByText(orderNumber)).closest('tr') as HTMLElement;
}
const optionValues = (select: HTMLElement) => Array.from((select as HTMLSelectElement).options).map((o) => o.value);
const advanceSelect = () => screen.getByText('Advance to').parentElement!.querySelector('select') as HTMLSelectElement;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); session.role = 'GIFSY_ADMIN'; session.perms = []; });

describe('GIFVC — voucher handling', () => {
  it('GIFVC1: a code typed for PROCESSING is NOT sent after switching to CANCELLED (and the draft is cleared)', async () => {
    const calls = installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null }]);
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));

    expect(advanceSelect().value).toBe('PROCESSING');
    await userEvent.type(screen.getByLabelText('Card no. / code'), 'AMZ-TYPED-1234');
    await userEvent.type(screen.getByLabelText('Provider'), 'Gifsy');

    await userEvent.selectOptions(advanceSelect(), 'CANCELLED');
    expect(screen.queryByLabelText('Card no. / code')).toBeNull();
    // Back to PROCESSING → the previously typed code is gone (fresh draft per target).
    await userEvent.selectOptions(advanceSelect(), 'PROCESSING');
    expect((screen.getByLabelText('Card no. / code') as HTMLInputElement).value).toBe('');
    await userEvent.type(screen.getByLabelText('Card no. / code'), 'AMZ-TYPED-1234');
    await userEvent.selectOptions(advanceSelect(), 'CANCELLED');

    await userEvent.click(screen.getByRole('button', { name: /confirm → CANCELLED/i }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/transition'))).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/transition'))!.init!.body));
    expect(body).toEqual({ toStatus: 'CANCELLED' });
  });

  it('GIFVC2: a forward move WITH the inputs on screen does send the code', async () => {
    const calls = installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null }]);
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    await userEvent.type(screen.getByLabelText('Card no. / code'), 'AMZ-NEW-5678');
    await userEvent.click(screen.getByRole('button', { name: /confirm → PROCESSING/i }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/transition'))).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/transition'))!.init!.body));
    expect(body).toEqual({ toStatus: 'PROCESSING', voucherCode: 'AMZ-NEW-5678' });
  });

  it('GIFVC2b: an optional PIN typed with the code is sent alongside it (trimmed)', async () => {
    const calls = installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null }]);
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    await userEvent.type(screen.getByLabelText('Card no. / code'), '6001220012345678');
    await userEvent.type(screen.getByLabelText('PIN (if the card has one)'), ' 482913 ');
    await userEvent.click(screen.getByRole('button', { name: /confirm → PROCESSING/i }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/transition'))).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/transition'))!.init!.body));
    expect(body).toEqual({ toStatus: 'PROCESSING', voucherCode: '6001220012345678', voucherPin: '482913' });
  });

  it('GIFVC2c: a PIN without a card number is refused client-side (no request)', async () => {
    const calls = installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null }]);
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    await userEvent.type(screen.getByLabelText('PIN (if the card has one)'), '4829');
    await userEvent.click(screen.getByRole('button', { name: /confirm → PROCESSING/i }));
    expect(await screen.findByText('Enter the card number before the PIN')).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/transition'))).toBe(false);
  });

  it('GIFVC2d: a fulfilling operator sees the stored card number AND PIN on the row', async () => {
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'DELIVERED', voucherCode: '6001220012345678', voucherPin: '482913', voucherProvider: 'Gifsy' }]);
    const row = await openRow('RDM-1');
    expect(within(row).getByTestId('order-voucher-code')).toHaveTextContent('6001220012345678');
    // The PIN is masked behind a per-row "Show PIN" toggle, hidden by default.
    const pin = within(row).getByTestId('order-voucher-pin');
    expect(pin).toHaveTextContent('PIN ••••');
    expect(pin).not.toHaveTextContent('482913');
    // Label-flip pattern: the accessible name CONTAINS the visible text ("Show PIN" / "Hide PIN");
    // no aria-pressed (a flipping name + a pressed state double-announces).
    const toggle = within(pin).getByRole('button', { name: 'Show PIN for order RDM-1' });
    expect(toggle).toHaveTextContent('Show PIN');
    expect(toggle).not.toHaveAttribute('aria-pressed');
    await userEvent.click(toggle);
    expect(pin).toHaveTextContent('482913');
    const hide = within(pin).getByRole('button', { name: 'Hide PIN for order RDM-1' });
    expect(hide).toHaveTextContent('Hide PIN');
    expect(hide).not.toHaveAttribute('aria-pressed');
    await userEvent.click(hide);
    expect(pin).not.toHaveTextContent('482913');
    expect(within(pin).getByRole('button', { name: 'Show PIN for order RDM-1' })).toBeInTheDocument();
  });

  it('GIFVC2e: a stored code WITHOUT a PIN offers a set-once PIN box on a forward move and sends only the PIN', async () => {
    const calls = installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'PROCESSING', voucherCode: 'CARD-1111-2222', voucherPin: null, voucherProvider: 'Gifsy', voucherFillable: true }]);
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    expect(screen.getByTestId('voucher-code-readonly')).toHaveTextContent('CARD-1111-2222');
    expect(screen.queryByLabelText('Card no. / code')).toBeNull(); // the stored code is not editable
    expect(screen.getByText('Add the PIN for this card — it can be saved once')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('PIN (if the card has one)'), ' 9911 ');
    await userEvent.click(screen.getByRole('button', { name: /confirm → DISPATCHED/i }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/transition'))).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/transition'))!.init!.body));
    expect(body).toEqual({ toStatus: 'DISPATCHED', voucherPin: '9911' });
  });

  it('item 14: the row PIN box follows the SERVER voucherFillable — false (e.g. unpaid / cash / Hubble) → no PIN box', async () => {
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'PROCESSING', voucherCode: 'CARD-1111-2222', voucherPin: null, voucherProvider: 'Gifsy', voucherFillable: false }]);
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    expect(screen.getByTestId('voucher-code-readonly')).toHaveTextContent('CARD-1111-2222');
    expect(screen.queryByLabelText('PIN (if the card has one)')).toBeNull();
    expect(screen.queryByText('Add the PIN for this card — it can be saved once')).toBeNull();
  });

  it('item 3: after a transition the row re-reads voucherFillable from the SERVER (never keeps the stale list value)', async () => {
    let fillable = false;
    const calls = installFetch(
      [{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: 'CARD-1111-2222', voucherPin: null, voucherProvider: 'Gifsy', voucherFillable: true }],
      (url, init) => {
        if (url === '/api/rewards/orders/o1/transition' && init?.method === 'POST') {
          return jsonOk({ order: { id: 'o1', status: 'PROCESSING', voucherCode: 'CARD-1111-2222', voucherPin: null, voucherProvider: 'Gifsy' } });
        }
        if (url === '/api/admin/gift-orders/o1') return jsonOk({ id: 'o1', voucherFillable: fillable });
        return undefined;
      },
    );
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    expect(screen.getByText('Add the PIN for this card — it can be saved once')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /confirm → PROCESSING/i }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/admin/gift-orders/o1')).toBe(true));
    // Server now says NOT fillable → the stale list `true` must not offer the PIN box.
    const after = (await screen.findByText('RDM-1')).closest('tr') as HTMLElement;
    await userEvent.click(within(after).getByRole('button', { name: /advance/i }));
    expect(screen.getByTestId('voucher-code-readonly')).toHaveTextContent('CARD-1111-2222');
    expect(screen.queryByText('Add the PIN for this card — it can be saved once')).toBeNull();
    // …and the reverse: a later update where the server says fillable → the PIN box returns.
    fillable = true;
    await userEvent.click(screen.getByRole('button', { name: /confirm → DISPATCHED/i }));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/admin/gift-orders/o1').length).toBe(2));
    const again = (await screen.findByText('RDM-1')).closest('tr') as HTMLElement;
    await userEvent.click(within(again).getByRole('button', { name: /advance/i }));
    expect(await screen.findByText('Add the PIN for this card — it can be saved once')).toBeInTheDocument();
  });

  it('GIFVC2f: a stored PIN is read-only + masked in the advance form (no PIN input)', async () => {
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'PROCESSING', voucherCode: 'CARD-1111-2222', voucherPin: '9911', voucherProvider: 'Gifsy' }]);
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    expect(screen.queryByLabelText('PIN (if the card has one)')).toBeNull();
    expect(screen.getByTestId('voucher-pin-readonly')).toHaveTextContent('PIN ••••');
  });

  it('GIFVC3: an order that already has a code shows it READ-ONLY (no editable input) and hides refund targets', async () => {
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: 'AMZN-1234-5678-WXYZ', voucherProvider: 'Gifsy' }]);
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    expect(optionValues(advanceSelect())).toEqual(['PROCESSING']); // CANCELLED / RETURNED hidden
    expect(screen.getByTestId('voucher-code-readonly')).toHaveTextContent('AMZN-1234-5678-WXYZ');
    expect(screen.queryByLabelText('Card no. / code')).toBeNull();
  });

  it('GIFVC4: a Hubble order never offers voucher inputs nor the vendor-cancel action', async () => {
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null, voucherProvider: 'Hubble' }]);
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    expect(screen.queryByLabelText('Card no. / code')).toBeNull();
    expect(screen.queryByRole('button', { name: /voucher cancelled with vendor/i })).toBeNull();
  });

  it('GIFVC5: "Voucher cancelled with vendor…" requires a reason, POSTs it, then the refund targets appear', async () => {
    const calls = installFetch(
      [{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'DISPATCHED', voucherCode: 'AMZN-1234-5678-WXYZ', voucherProvider: 'Gifsy' }],
      (url, init) => (url === '/api/rewards/orders/o1/voucher-cancelled' && init?.method === 'POST'
        ? jsonOk({ order: { id: 'o1', status: 'DISPATCHED', voucherCode: null, voucherProvider: null } })
        : undefined),
    );
    const row = await openRow('RDM-1');
    // Before: only the forward edge.
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    expect(optionValues(advanceSelect())).toEqual(['DELIVERED']);
    await userEvent.click(within(row).getByRole('button', { name: /close/i }));

    await userEvent.click(within(row).getByRole('button', { name: /voucher cancelled with vendor/i }));
    const confirm = screen.getByRole('button', { name: /confirm voucher cancelled/i });
    expect(confirm).toBeDisabled(); // reason required
    await userEvent.type(screen.getByLabelText(/reason/i), '  Vendor ref VC-77  ');
    await userEvent.click(confirm);

    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/voucher-cancelled'))).toBe(true));
    const post = calls.find((c) => c.url.endsWith('/voucher-cancelled'))!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ reason: 'Vendor ref VC-77' });

    // The row now has no code → refund targets are offered; the action is gone.
    const updated = (await screen.findByText('RDM-1')).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(updated).queryByText('AMZN-1234-5678-WXYZ')).toBeNull());
    expect(within(updated).queryByRole('button', { name: /voucher cancelled with vendor/i })).toBeNull();
    await userEvent.click(within(updated).getByRole('button', { name: /advance/i }));
    expect(optionValues(advanceSelect())).toEqual(['DELIVERED', 'RETURNED']);
  });

  it('GIFVC6: a server error on the vendor-cancel is shown and the code stays', async () => {
    installFetch(
      [{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: 'AMZN-1234-5678-WXYZ', voucherProvider: 'Gifsy' }],
      (url) => (url.endsWith('/voucher-cancelled')
        ? Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ success: false, error: 'The voucher code changed — refresh and try again.' }) })
        : undefined),
    );
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /voucher cancelled with vendor/i }));
    await userEvent.type(screen.getByLabelText(/reason/i), 'dup click');
    await userEvent.click(screen.getByRole('button', { name: /confirm voucher cancelled/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/voucher code changed/);
    expect(within(row).getByText('AMZN-1234-5678-WXYZ')).toBeInTheDocument();
  });

  it('GIFVC8: read-only staff (code withheld, voucherIssued only) see "Voucher issued" and no controls', async () => {
    session.role = 'GIFSY_STAFF'; session.perms = ['rewards:read'];
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null, voucherIssued: true, voucherCodeMasked: true }]);
    const row = await openRow('RDM-1');
    expect(within(row).getByTestId('order-voucher-code')).toHaveTextContent('Voucher issued');
    expect(within(row).queryByTestId('order-voucher-pin')).toBeNull();
    expect(within(row).queryByRole('button', { name: /advance/i })).toBeNull();
  });

  it('GIFVC9: an operator row flagged voucherIssued (code withheld) still hides refund targets', async () => {
    session.role = 'GIFSY_STAFF'; session.perms = ['rewards:read', 'rewards:manage_orders'];
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null, voucherIssued: true }]);
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    expect(optionValues(advanceSelect())).toEqual(['PROCESSING']);
    // No editable code input either (a code is already issued).
    expect(screen.queryByLabelText('Card no. / code')).toBeNull();
  });

  it('GIFVC10: a stuck Hubble order shows "Needs reconcile" + reason and hides refund targets', async () => {
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null,
      voucherProvider: 'Hubble', hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' }]);
    const row = await openRow('RDM-1');
    expect(within(row).getByTestId('hubble-needs-reconcile')).toHaveTextContent('Needs reconcile · Hubble state unknown');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    expect(optionValues(advanceSelect())).toEqual(['PROCESSING']);
    expect(screen.queryByLabelText('Card no. / code')).toBeNull(); // no plain manual code on a Hubble order
  });

  it('GIFVC10b: a "Hubble not configured" order (never placed) keeps its refund targets', async () => {
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null,
      voucherProvider: null, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_NOT_CONFIGURED' }]);
    const row = await openRow('RDM-1');
    expect(within(row).getByTestId('hubble-needs-reconcile')).toHaveTextContent('Hubble not configured');
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    expect(optionValues(advanceSelect())).toEqual(['PROCESSING', 'CANCELLED', 'RETURNED']);
  });

  it('GIFVC10c: never-placed reasons hide "Retry with Hubble" (nothing to re-read) but keep "Fulfil manually"', async () => {
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null,
      hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INVALID_AMOUNT' }]);
    const row = await openRow('RDM-1');
    expect(within(row).queryByRole('button', { name: /retry with hubble/i })).toBeNull();
    expect(within(row).getByRole('button', { name: /fulfil manually/i })).toBeInTheDocument();
  });

  it('GIFVC10d: a whitespace-only code is "no code" (no code shown, refund targets kept)', async () => {
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: '   ' }]);
    const row = await openRow('RDM-1');
    expect(within(row).queryByTestId('order-voucher-code')).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: /advance/i }));
    expect(optionValues(advanceSelect())).toEqual(['PROCESSING', 'CANCELLED', 'RETURNED']);
  });

  it('GIFVC11: "Retry with Hubble" POSTs hubble-reconcile and re-fetches', async () => {
    const calls = installFetch(
      [{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'PROCESSING', voucherCode: null, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' }],
      (url, init) => (url === '/api/rewards/orders/o1/hubble-reconcile' && init?.method === 'POST' ? jsonOk({ orderId: 'o1', outcome: 'DELIVERED' }) : undefined),
    );
    const row = await openRow('RDM-1');
    const before = calls.filter((c) => c.url.startsWith('/api/rewards/orders?')).length;
    await userEvent.click(within(row).getByRole('button', { name: /retry with hubble/i }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/hubble-reconcile'))).toBe(true));
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/rewards/orders?')).length).toBeGreaterThan(before));
  });

  it.each([
    ['REFUNDED_NO_HUBBLE_ORDER', /Hubble confirmed it has no order for this redemption — points refunded/],
    ['PENDING_NO_HUBBLE_ORDER_TOO_RECENT', /retry later \(orders must be at least 2 hours old\)/],
    ['NO_HUBBLE_ORDER_NOT_REFUNDABLE', /can’t be refunded automatically/],
    ['NO_HUBBLE_ORDER_UNVERIFIED', /couldn’t confirm that answer against a known Hubble order — not refunded/],
    ['SOME_FUTURE_OUTCOME', /Hubble: SOME_FUTURE_OUTCOME/],
  ])('GIFVC11b: retry outcome %s is shown in plain words', async (outcome, text) => {
    installFetch(
      [{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' }],
      (url, init) => (url === '/api/rewards/orders/o1/hubble-reconcile' && init?.method === 'POST' ? jsonOk({ orderId: 'o1', outcome }) : undefined),
    );
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /retry with hubble/i }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it.each(['HUBBLE_ISSUED_AFTER_REFUND', 'HUBBLE_WEBHOOK_AFTER_NO_ORDER_REFUND'])(
    'GIFVC11c: a post-refund flag (%s) hides Retry + Fulfil manually and offers an audited "Acknowledge — resolved" (note required)',
    async (reason) => {
      const calls = installFetch(
        [{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'FAILED', voucherCode: null, hubbleNeedsReconcile: true, hubbleReconcileReason: reason }],
        (url, init) => (url === '/api/rewards/orders/o1/hubble-acknowledge' && init?.method === 'POST'
          ? jsonOk({ order: { id: 'o1', hubbleNeedsReconcile: false, hubbleReconcileReason: null } })
          : undefined),
      );
      const row = await openRow('RDM-1');
      expect(within(row).getByTestId('hubble-needs-reconcile')).toHaveTextContent(/check the order in Hubble’s portal/);
      expect(within(row).queryByRole('button', { name: /retry with hubble/i })).toBeNull();
      expect(within(row).queryByRole('button', { name: /fulfil manually/i })).toBeNull();
      await userEvent.click(within(row).getByRole('button', { name: /acknowledge — resolved/i }));
      const confirm = screen.getByRole('button', { name: /^acknowledge — resolved$/i });
      expect(confirm).toBeDisabled();
      await userEvent.type(screen.getByLabelText('Note *'), '  Checked Hubble — no voucher  ');
      await userEvent.click(confirm);
      await waitFor(() => expect(calls.some((c) => c.url.endsWith('/hubble-acknowledge'))).toBe(true));
      const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/hubble-acknowledge'))!.init!.body));
      expect(body).toEqual({ note: 'Checked Hubble — no voucher' });
      const updated = (await screen.findByText('RDM-1')).closest('tr') as HTMLElement;
      await waitFor(() => expect(within(updated).queryByTestId('hubble-needs-reconcile')).toBeNull());
    },
  );

  it.each(['FAILED', 'CANCELLED', 'RETURNED'])(
    'GIFVC11e: a leftover open-order flag on a %s (points returned) order offers Acknowledge, not Retry',
    async (status) => {
      installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status, voucherCode: null, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_PROCESSING_CLAIM_LOST' }]);
      const row = await openRow('RDM-1');
      expect(within(row).queryByRole('button', { name: /retry with hubble/i })).toBeNull();
      expect(within(row).getByRole('button', { name: /acknowledge — resolved/i })).toBeInTheDocument();
    },
  );

  it('GIFVC11h: Hubble unreachable on Acknowledge → offers "acknowledge anyway" (≥ 20-char note) and sends force', async () => {
    let attempt = 0;
    const calls = installFetch(
      [{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'FAILED', voucherCode: null, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_SUCCESS_NO_CODE' }],
      (url, init) => {
        if (url !== '/api/rewards/orders/o1/hubble-acknowledge' || init?.method !== 'POST') return undefined;
        attempt += 1;
        return attempt === 1
          ? Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ success: false, error: 'Hubble could not be checked right now — try again in a few minutes.' }) })
          : jsonOk({ order: { id: 'o1', hubbleNeedsReconcile: false, hubbleReconcileReason: null } });
      },
    );
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /acknowledge — resolved/i }));
    await userEvent.type(screen.getByLabelText('Note *'), 'short');
    await userEvent.click(screen.getByRole('button', { name: /^acknowledge — resolved$/i }));
    const force = await screen.findByRole('checkbox', { name: /hubble unreachable — acknowledge anyway/i });
    await userEvent.click(force);
    const confirm = screen.getByRole('button', { name: /^acknowledge — resolved$/i });
    expect(confirm).toBeDisabled(); // note < 20 chars
    await userEvent.type(screen.getByLabelText('Note *'), ' — portal shows no voucher');
    await userEvent.click(confirm);
    await waitFor(() => expect(attempt).toBe(2));
    const sent = calls.filter((c) => c.url.endsWith('/hubble-acknowledge')).map((c) => JSON.parse(String(c.init!.body)));
    expect(sent[0]).toEqual({ note: 'short' });
    expect(sent[1]).toEqual({ note: 'short — portal shows no voucher', force: true });
  });

  it('GIFVC11f: a flagged DELIVERED order (possible double issuance) hides Retry and offers Acknowledge', async () => {
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'DELIVERED', voucherCode: 'CARD-1', voucherProvider: 'Hubble', hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_PROCESSING_AFTER_MANUAL' }]);
    const row = await openRow('RDM-1');
    expect(within(row).queryByRole('button', { name: /retry with hubble/i })).toBeNull();
    expect(within(row).getByRole('button', { name: /acknowledge — resolved/i })).toBeInTheDocument();
  });

  it('GIFVC11g: the row shows WHY Hubble\'s "no order" was not trusted', async () => {
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE', hubbleNoOrderUnverifiedWhy: 'no delivered Hubble order on this Hubble account to verify against' }]);
    const row = await openRow('RDM-1');
    expect(within(row).getByTestId('hubble-no-order-unverified')).toHaveTextContent(/not trusted: no delivered Hubble order on this Hubble account/);
    expect(within(row).getByRole('button', { name: /retry with hubble/i })).toBeInTheDocument();
  });

  it('GIFVC11d: an open-order flag (HUBBLE_WEBHOOK_BUT_NOT_FOUND) keeps Retry and offers no Acknowledge', async () => {
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: null, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_WEBHOOK_BUT_NOT_FOUND' }]);
    const row = await openRow('RDM-1');
    expect(within(row).getByRole('button', { name: /retry with hubble/i })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /acknowledge/i })).toBeNull();
  });

  it('GIFVC12: "Fulfil manually" needs a code + reason and PATCHes a manual override; the badge clears', async () => {
    const calls = installFetch(
      [{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'PROCESSING', voucherCode: null, voucherProvider: 'Hubble', hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_PROCESSING_NOT_FOUND' }],
      (url, init) => (url === '/api/rewards/orders/o1' && init?.method === 'PATCH'
        ? jsonOk({ order: { id: 'o1', voucherCode: 'POOL-7777', voucherProvider: 'Manual' } })
        : undefined),
    );
    const row = await openRow('RDM-1');
    await userEvent.click(within(row).getByRole('button', { name: /fulfil manually/i }));
    const confirm = screen.getByRole('button', { name: /confirm manual fulfilment/i });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Card no. / code *'), 'POOL-7777');
    expect(confirm).toBeDisabled(); // reason still required
    await userEvent.type(screen.getByLabelText('Reason *'), 'Hubble down');
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.url === '/api/rewards/orders/o1' && c.init?.method === 'PATCH')).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.init?.method === 'PATCH')!.init!.body));
    expect(body).toEqual({ voucherCode: 'POOL-7777', manualOverride: true, overrideReason: 'Hubble down' });
    const updated = (await screen.findByText('RDM-1')).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(updated).queryByTestId('hubble-needs-reconcile')).toBeNull());
    expect(within(updated).getByText('POOL-7777')).toBeInTheDocument();
  });

  it('GIFVC13: a permissioned GIFSY_STAFF sees the badge but not the Hubble ops actions (GIFSY_ADMIN only)', async () => {
    session.role = 'GIFSY_STAFF'; session.perms = ['rewards:read', 'rewards:manage_orders'];
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'PROCESSING', voucherCode: null, hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE' }]);
    const row = await openRow('RDM-1');
    expect(within(row).getByTestId('hubble-needs-reconcile')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /retry with hubble/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: /fulfil manually/i })).toBeNull();
  });

  it('GIFVC7: a permissioned GIFSY_STAFF can advance but never sees the vendor-cancel action (GIFSY_ADMIN only)', async () => {
    session.role = 'GIFSY_STAFF'; session.perms = ['rewards:read', 'rewards:manage_orders'];
    installFetch([{ ...base, id: 'o1', orderNumber: 'RDM-1', status: 'CONFIRMED', voucherCode: 'AMZN-1234-5678-WXYZ', voucherProvider: 'Gifsy' }]);
    const row = await openRow('RDM-1');
    expect(within(row).getByRole('button', { name: /advance/i })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /voucher cancelled with vendor/i })).toBeNull();
  });
});
