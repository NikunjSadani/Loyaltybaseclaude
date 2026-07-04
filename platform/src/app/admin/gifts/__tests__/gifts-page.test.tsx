/// <reference types="vitest/globals" />
/**
 * GIF — Admin Reward Catalogue + Fulfilment page (P5 5.5b)
 *
 * GIF1: fetches the real reward catalogue (+ categories) on mount
 * GIF2: renders a catalogue item from the API response
 * GIF3: creating a reward POSTs to /api/admin/rewards/catalog
 * GIF4: the fulfilment tab loads orders and the bulk upload POSTs the file,
 *       rendering the per-row error list from {processed,succeeded,skipped,failed,errors}
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdminGiftsPage from '../page';

const CATEGORIES = [
  { id: 'cat1', code: 'VOUCHERS', name: 'Vouchers', description: null, parentId: null, sortOrder: 0, isActive: true },
];

const CATALOG_ITEMS = [
  {
    id: 'r1',
    categoryId: 'cat1',
    category: { id: 'cat1', name: 'Vouchers', code: 'VOUCHERS' },
    code: 'AMZ-500',
    name: 'Amazon Voucher 500',
    description: 'Amazon gift card',
    pointsCost: 500,
    mrpPaise: 50000,
    redemptionMode: 'GIFT_CARD',
    status: 'ACTIVE',
    minRedemptionPoints: null,
    maxRedemptionPoints: null,
    stockQuantity: null,
  },
];

const ORDERS = [
  {
    id: 'o1',
    orderNumber: 'RDM-1',
    reward: { id: 'r1', name: 'Amazon Voucher 500', redemptionMode: 'GIFT_CARD' },
    partner: { id: 'p1', businessName: 'Test Store' },
    status: 'PENDING',
    redemptionMode: 'GIFT_CARD',
    totalPointsCost: 500,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  },
];

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
}

/** Route fetch by URL + method, recording every call for assertions. */
function installFetch(over?: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const custom = over?.(url, init);
    if (custom !== undefined) return custom as Promise<unknown>;

    if (url.startsWith('/api/admin/rewards/categories') && (!init || init.method === 'GET' || !init.method)) {
      return jsonOk({ categories: CATEGORIES });
    }
    if (url.startsWith('/api/admin/rewards/catalog') && (!init?.method || init.method === 'GET')) {
      return jsonOk({ items: CATALOG_ITEMS, pagination: { page: 1, limit: 200, total: 1, pages: 1 } });
    }
    if (url.startsWith('/api/admin/rewards/catalog') && init?.method === 'POST') {
      return jsonOk({ id: 'r2' });
    }
    if (url.startsWith('/api/rewards/orders')) {
      return jsonOk({ orders: ORDERS, pagination: { page: 1, limit: 100, total: 1, pages: 1 } });
    }
    // Default: empty success
    return jsonOk({});
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

beforeEach(() => {
  // jsdom lacks URL.createObjectURL — stub for the blob download path.
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:stub'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('GIF — Admin Reward Catalogue + Fulfilment', () => {
  it('GIF1: fetches the real catalogue + categories on mount', async () => {
    const { calls } = installFetch();
    render(<AdminGiftsPage />);
    await waitFor(() => {
      expect(calls.some((c) => c.url.startsWith('/api/admin/rewards/catalog'))).toBe(true);
      expect(calls.some((c) => c.url.startsWith('/api/admin/rewards/categories'))).toBe(true);
    });
  });

  it('GIF2: renders a catalogue item from the API response', async () => {
    installFetch();
    render(<AdminGiftsPage />);
    expect(await screen.findByText('Amazon Voucher 500')).toBeInTheDocument();
  });

  it('GIF3: creating a reward POSTs to /api/admin/rewards/catalog', async () => {
    const { calls } = installFetch();
    render(<AdminGiftsPage />);
    // wait for catalogue to load (Add Reward buttons appear)
    const addButtons = await screen.findAllByRole('button', { name: /add reward/i });
    await userEvent.click(addButtons[addButtons.length - 1]);

    // Fill required fields in the item modal
    const dialog = await screen.findByText('Add Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    await userEvent.type(scope.getByPlaceholderText('AMZ-500'), 'NEW-1');
    await userEvent.type(scope.getByPlaceholderText('Amazon Voucher ₹500'), 'New Reward');
    // GIFT_CARD + FIXED is the default → fill points cost
    await userEvent.type(scope.getByPlaceholderText('2500'), '750');

    await userEvent.click(scope.getByRole('button', { name: /add reward/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url.startsWith('/api/admin/rewards/catalog') && c.init?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post!.init!.body));
      expect(body.code).toBe('NEW-1');
      expect(body.redemptionMode).toBe('GIFT_CARD');
      expect(body.pointsCost).toBe(750);
    });
  });

  it('GIF5: a free-amount voucher with a blank Max is blocked (no POST)', async () => {
    const { calls } = installFetch();
    render(<AdminGiftsPage />);
    const addButtons = await screen.findAllByRole('button', { name: /add reward/i });
    await userEvent.click(addButtons[addButtons.length - 1]);

    const dialog = await screen.findByText('Add Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    await userEvent.type(scope.getByPlaceholderText('AMZ-500'), 'FA-1');
    await userEvent.type(scope.getByPlaceholderText('Amazon Voucher ₹500'), 'Free Amount Voucher');
    // Switch to Free Amount, fill the min only, leave Max blank.
    await userEvent.click(scope.getByRole('button', { name: /free amount/i }));
    await userEvent.type(scope.getByPlaceholderText('100'), '250');

    await userEvent.click(scope.getByRole('button', { name: /add reward/i }));

    // Validation blocks the save; no catalog POST is fired.
    expect(await scope.findByText(/Max is required/i)).toBeInTheDocument();
    expect(
      calls.find((c) => c.url.startsWith('/api/admin/rewards/catalog') && c.init?.method === 'POST'),
    ).toBeFalsy();
  });

  it('GIF6: a free-amount voucher WITH a Max POSTs pointsCost 0 + both bounds', async () => {
    const { calls } = installFetch();
    render(<AdminGiftsPage />);
    const addButtons = await screen.findAllByRole('button', { name: /add reward/i });
    await userEvent.click(addButtons[addButtons.length - 1]);

    const dialog = await screen.findByText('Add Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    await userEvent.type(scope.getByPlaceholderText('AMZ-500'), 'FA-2');
    await userEvent.type(scope.getByPlaceholderText('Amazon Voucher ₹500'), 'Free Amount Voucher');
    await userEvent.click(scope.getByRole('button', { name: /free amount/i }));
    await userEvent.type(scope.getByPlaceholderText('100'), '250');
    await userEvent.type(scope.getByPlaceholderText('e.g. 5000'), '5000');

    await userEvent.click(scope.getByRole('button', { name: /add reward/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url.startsWith('/api/admin/rewards/catalog') && c.init?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post!.init!.body));
      expect(body.pointsCost).toBe(0);
      expect(body.minRedemptionPoints).toBe(250);
      expect(body.maxRedemptionPoints).toBe(5000);
    });
  });

  it('GIF4: fulfilment upload POSTs the file and renders the per-row error list', async () => {
    let uploadBody: unknown;
    const { fn } = installFetch((url, init) => {
      if (url.startsWith('/api/admin/rewards/fulfilment/upload') && init?.method === 'POST') {
        uploadBody = init.body;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: {
              processed: 3, succeeded: 1, skipped: 1, failed: 1,
              errors: [{ row: 4, orderNumber: 'RDM-9', message: 'Unknown order number' }],
            },
          }),
        });
      }
      return undefined;
    });

    render(<AdminGiftsPage />);

    // Switch to the Fulfilment tab
    await userEvent.click(await screen.findByRole('button', { name: /fulfilment/i }));

    // The hidden file input drives the upload; fire a file at it directly.
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const file = new File(['x'], 'fulfilment.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    await userEvent.upload(fileInput, file);

    // Error row renders
    expect(await screen.findByText(/Unknown order number/)).toBeInTheDocument();
    expect(screen.getByText(/Row 4/)).toBeInTheDocument();

    // It was sent as multipart FormData (not JSON)
    expect(uploadBody).toBeInstanceOf(FormData);

    // sanity: upload endpoint was hit
    expect((fn.mock.calls as [string, RequestInit?][]).some(
      ([u, i]) => u.startsWith('/api/admin/rewards/fulfilment/upload') && i?.method === 'POST',
    )).toBe(true);
  });
});
