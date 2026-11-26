/// <reference types="vitest/globals" />
/**
 * GIFS — Redemption orders: server-side search + "Redeemed on" column.
 *  GIFS1: typing is debounced (~300 ms) — ONE request with ?q=<trimmed term>, cursor reset.
 *  GIFS2: a stale response for an older term never overwrites the newer result (async race).
 *  GIFS3: "Clear" resets the search and reloads; the input is labelled.
 *  GIFS4: empty result names the term: "No orders match 'xyz'".
 *  GIFS5: "Redeemed on" shows the order createdAt in IST date + time.
 *  GIFS6: the fulfilment sheet download follows status + search, and the UI says what it contains.
 */

import React from 'react';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import AdminGiftsPage from '../page';

const session = vi.hoisted(() => ({ role: 'GIFSY_ADMIN' as string }));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: session.role }) }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({ role: session.role, permissions: [], ready: true, error: false, has: () => true, retry: () => {} }),
}));

const order = (id: string, reward: string, createdAt = '2026-11-24T10:12:00.000Z') => ({
  id, orderNumber: `RDM-${id}`,
  reward: { id: 'r1', name: reward, redemptionMode: 'GIFT_CARD' },
  partner: { id: 'p1', businessName: 'Store One', outletCode: 'BJ-1', phone: '9811111111' },
  status: 'CONFIRMED', redemptionMode: 'GIFT_CARD', totalPointsCost: 500, createdAt, updatedAt: createdAt,
});

function page(orders: unknown[]) {
  return { success: true, data: { orders, pagination: { page: 1, limit: 100, total: orders.length, pages: 1 }, nextCursor: null } };
}
function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}

type Handler = (url: string) => Promise<unknown> | undefined;
function installFetch(onOrders?: Handler) {
  const fn = vi.fn((url: string) => {
    if (url.startsWith('/api/rewards/orders')) return onOrders?.(url) ?? jsonOk(page([order('1', 'Amazon Voucher')]));
    if (url.startsWith('/api/admin/rewards/catalog')) return jsonOk({ success: true, data: { items: [], pagination: { page: 1, limit: 200, total: 0, pages: 0 } } });
    if (url.startsWith('/api/admin/rewards/categories')) return jsonOk({ success: true, data: { categories: [] } });
    if (url.startsWith('/api/admin/rewards/fulfilment/template')) {
      return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(['x'])) });
    }
    return jsonOk({ success: true, data: {} });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const orderUrls = (fn: ReturnType<typeof installFetch>) =>
  (fn.mock.calls as [string][]).map(([u]) => u).filter((u) => u.startsWith('/api/rewards/orders'));

async function openFulfilment() {
  render(<AdminGiftsPage />);
  await userEvent.click(await screen.findByRole('button', { name: /fulfilment/i }));
  await screen.findByText('RDM-1');
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('GIFS — orders search + Redeemed on', () => {
  it('GIFS1: debounced — one request with the trimmed term, no cursor', async () => {
    const fn = installFetch();
    await openFulfilment();
    const before = orderUrls(fn).length;
    const box = screen.getByLabelText('Search orders');
    fireEvent.change(box, { target: { value: ' ama' } });
    fireEvent.change(box, { target: { value: ' amaz' } });
    fireEvent.change(box, { target: { value: ' amazon ' } });
    // Nothing sent while typing.
    expect(orderUrls(fn).length).toBe(before);
    await waitFor(() => expect(orderUrls(fn).length).toBe(before + 1), { timeout: 1500 });
    const url = new URL(orderUrls(fn).at(-1)!, 'http://x');
    expect(url.searchParams.get('q')).toBe('amazon');
    expect(url.searchParams.get('cursor')).toBeNull();
  });

  it('GIFS2: a late response for an OLDER term never replaces the newer result', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    installFetch((url) => {
      const q = new URL(url, 'http://x').searchParams.get('q');
      if (q === 'old') return new Promise((r) => { resolveOld = r; });
      if (q === 'new') return jsonOk(page([order('2', 'New Match')]));
      return undefined;
    });
    await openFulfilment();
    const box = screen.getByLabelText('Search orders');
    fireEvent.change(box, { target: { value: 'old' } });
    await new Promise((r) => setTimeout(r, 400)); // 'old' request in flight
    fireEvent.change(box, { target: { value: 'new' } });
    expect(await screen.findByText('RDM-2', {}, { timeout: 1500 })).toBeInTheDocument();
    await act(async () => { resolveOld({ ok: true, json: () => Promise.resolve(page([order('9', 'Stale')])) }); });
    expect(screen.queryByText('RDM-9')).not.toBeInTheDocument();
    expect(screen.getByText('RDM-2')).toBeInTheDocument();
  });

  it('GIFS3 + GIFS4: empty result names the term; Clear resets and reloads without q', async () => {
    const fn = installFetch((url) =>
      new URL(url, 'http://x').searchParams.get('q') === 'xyz' ? jsonOk(page([])) : undefined,
    );
    await openFulfilment();
    fireEvent.change(screen.getByLabelText('Search orders'), { target: { value: 'xyz' } });
    expect(await screen.findByText("No orders match 'xyz'", {}, { timeout: 1500 })).toBeInTheDocument();
    // Polite announcement of the result count.
    expect(screen.getByTestId('orders-search-status')).toHaveTextContent("0 orders match 'xyz'");
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('RDM-1')).toBeInTheDocument();
    expect((screen.getByLabelText('Search orders') as HTMLInputElement).value).toBe('');
    // Focus goes back to the search box; the announcement is cleared.
    expect(screen.getByLabelText('Search orders')).toHaveFocus();
    expect(screen.getByTestId('orders-search-status')).toHaveTextContent('');
    expect(new URL(orderUrls(fn).at(-1)!, 'http://x').searchParams.get('q')).toBeNull();
  });

  it('GIFS5: "Redeemed on" shows the order createdAt in IST (date + time)', async () => {
    installFetch();
    await openFulfilment();
    expect(screen.getByRole('columnheader', { name: 'Redeemed on (IST)' })).toBeInTheDocument();
    const row = screen.getByText('RDM-1').closest('tr') as HTMLElement;
    // 10:12 UTC → 3:42 pm IST
    expect(within(row).getByTestId('order-redeemed-on').textContent).toMatch(/24 Nov 2026.*0?3:42\s*pm/i);
  });

  it('GIFS6: the sheet download follows status + search and the UI says what it contains', async () => {
    const fn = installFetch();
    Object.defineProperty(globalThis, 'URL', {
      value: Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }),
      configurable: true,
    });
    await openFulfilment();
    fireEvent.change(screen.getByLabelText('Search orders'), { target: { value: 'amazon' } });
    await waitFor(() =>
      expect(screen.getByTestId('fulfilment-export-scope')).toHaveTextContent(
        /all orders awaiting fulfilment matching “amazon” — not just the rows loaded below\. Vouchers still being issued via API \(no code yet\) are left out/,
      ),
      { timeout: 1500 },
    );
    await userEvent.click(screen.getByRole('button', { name: /download fulfilment sheet/i }));
    await waitFor(() => {
      const u = (fn.mock.calls as [string][]).map(([x]) => x).find((x) => x.startsWith('/api/admin/rewards/fulfilment/template'));
      expect(u).toBeTruthy();
      expect(new URL(u!, 'http://x').searchParams.get('q')).toBe('amazon');
    });
  });
});
