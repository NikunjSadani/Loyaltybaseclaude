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

  it('GIF7: uploading a gift image includes its url in the create payload', async () => {
    const IMG = 'https://storage.googleapis.com/gifsy-platform-files/gift-catalogue/2026-09/uuid-a.png';
    const { calls } = installFetch((url, init) => {
      if (url.startsWith('/api/admin/gift-catalogue/image') && init?.method === 'POST') {
        return jsonOk({ url: IMG });
      }
      return undefined;
    });
    render(<AdminGiftsPage />);

    const addButtons = await screen.findAllByRole('button', { name: /add reward/i });
    await userEvent.click(addButtons[addButtons.length - 1]);

    const dialog = await screen.findByText('Add Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    await userEvent.type(scope.getByPlaceholderText('AMZ-500'), 'IMG-1');
    await userEvent.type(scope.getByPlaceholderText('Amazon Voucher ₹500'), 'With Image');
    await userEvent.type(scope.getByPlaceholderText('2500'), '750');

    // Upload a picture through the shared control (multipart → returns the stored url).
    const imageInput = scope.getByTestId('gift-image-input') as HTMLInputElement;
    await userEvent.upload(imageInput, new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }));
    // The thumbnail (its remove control) appears once the url is stored.
    await scope.findByTestId('gift-image-remove');

    await userEvent.click(scope.getByRole('button', { name: /add reward/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url.startsWith('/api/admin/rewards/catalog') && c.init?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post!.init!.body));
      expect(body.imageUrls).toEqual([IMG]);
    });
  });

  it('GIF11: setting the Hubble product ID on a GIFT_CARD includes hubbleProductId in the create payload', async () => {
    const { calls } = installFetch();
    render(<AdminGiftsPage />);
    const addButtons = await screen.findAllByRole('button', { name: /add reward/i });
    await userEvent.click(addButtons[addButtons.length - 1]);

    const dialog = await screen.findByText('Add Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    await userEvent.type(scope.getByPlaceholderText('AMZ-500'), 'HUB-1');
    await userEvent.type(scope.getByPlaceholderText('Amazon Voucher ₹500'), 'Hubble Voucher');
    await userEvent.type(scope.getByPlaceholderText('2500'), '750');
    // The Hubble product-id field is shown for GIFT_CARD (the default mode).
    await userEvent.type(scope.getByPlaceholderText(/amazon-pay-product-id/i), 'amz-prod-9');

    await userEvent.click(scope.getByRole('button', { name: /add reward/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url.startsWith('/api/admin/rewards/catalog') && c.init?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post!.init!.body));
      expect(body.hubbleProductId).toBe('amz-prod-9');
      expect(body.redemptionMode).toBe('GIFT_CARD');
    });
  });

  it('GIF12: an existing item prefills its stored Hubble product ID from metadata', async () => {
    const ITEM_WITH_HUBBLE = {
      ...CATALOG_ITEMS[0],
      id: 'r-hub',
      metadata: { hubbleProductId: 'amz-stored' },
    };
    installFetch((url, init) =>
      url.startsWith('/api/admin/rewards/catalog') && (!init?.method || init.method === 'GET')
        ? jsonOk({ items: [ITEM_WITH_HUBBLE], pagination: { page: 1, limit: 200, total: 1, pages: 1 } })
        : undefined,
    );
    render(<AdminGiftsPage />);

    await userEvent.click(await screen.findByRole('button', { name: /edit reward/i }));
    const dialog = await screen.findByText('Edit Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    const hubbleField = scope.getByPlaceholderText(/amazon-pay-product-id/i) as HTMLInputElement;
    expect(hubbleField.value).toBe('amz-stored');
  });

  it('GIF13: entering a Selling value (₹) includes sellingValuePaise in the create payload', async () => {
    const { calls } = installFetch();
    render(<AdminGiftsPage />);
    const addButtons = await screen.findAllByRole('button', { name: /add reward/i });
    await userEvent.click(addButtons[addButtons.length - 1]);

    const dialog = await screen.findByText('Add Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    await userEvent.type(scope.getByPlaceholderText('AMZ-500'), 'SV-1');
    await userEvent.type(scope.getByPlaceholderText('Amazon Voucher ₹500'), 'Selling Value Reward');
    await userEvent.type(scope.getByPlaceholderText('2500'), '500');
    // MRP and Selling value share the "(optional)" placeholder — target selling value by its label.
    const svInput = scope.getByText('Selling value (₹)').closest('div')!.querySelector('input')!;
    await userEvent.type(svInput, '400');

    await userEvent.click(scope.getByRole('button', { name: /add reward/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url.startsWith('/api/admin/rewards/catalog') && c.init?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post!.init!.body));
      expect(body.sellingValuePaise).toBe(40000); // ₹400 → paise
    });
  });

  it('GIF14: an existing item prefills its stored selling value', async () => {
    const ITEM_WITH_SV = { ...CATALOG_ITEMS[0], id: 'r-sv', sellingValuePaise: 40000 };
    installFetch((url, init) =>
      url.startsWith('/api/admin/rewards/catalog') && (!init?.method || init.method === 'GET')
        ? jsonOk({ items: [ITEM_WITH_SV], pagination: { page: 1, limit: 200, total: 1, pages: 1 } })
        : undefined,
    );
    render(<AdminGiftsPage />);

    await userEvent.click(await screen.findByRole('button', { name: /edit reward/i }));
    const dialog = await screen.findByText('Edit Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    const svInput = scope.getByText('Selling value (₹)').closest('div')!.querySelector('input') as HTMLInputElement;
    expect(svInput.value).toBe('400');
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

  // ── Cash Payout simplification (UPI + BANK_TRANSFER → one "Cash Payout") ──────

  /** A legacy catalogue item whose stored mode is UPI (FIXED cash). */
  const UPI_ITEM = {
    id: 'rc-upi',
    categoryId: 'cat1',
    category: { id: 'cat1', name: 'Vouchers', code: 'VOUCHERS' },
    code: 'CASH-UPI',
    name: 'Instant Cash 1000',
    description: '',
    pointsCost: 500,
    mrpPaise: null,
    redemptionMode: 'UPI',
    status: 'ACTIVE',
    minRedemptionPoints: null,
    maxRedemptionPoints: null,
    stockQuantity: null,
  };

  const serveUpiItem = (url: string, init?: RequestInit) =>
    url.startsWith('/api/admin/rewards/catalog') && (!init?.method || init.method === 'GET')
      ? jsonOk({ items: [UPI_ITEM], pagination: { page: 1, limit: 200, total: 1, pages: 1 } })
      : undefined;

  it('GIF8: the item editor offers a SINGLE "Cash Payout" option (no separate UPI / Bank Transfer)', async () => {
    installFetch();
    render(<AdminGiftsPage />);
    const addButtons = await screen.findAllByRole('button', { name: /add reward/i });
    await userEvent.click(addButtons[addButtons.length - 1]);

    const dialog = await screen.findByText('Add Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    // Exactly one cash option, labelled "Cash Payout", whose stored value is BANK_TRANSFER.
    const cash = scope.getByRole('option', { name: 'Cash Payout' }) as HTMLOptionElement;
    expect(cash.value).toBe('BANK_TRANSFER');
    // The two old split options are gone.
    expect(scope.queryByRole('option', { name: /UPI/i })).toBeNull();
    expect(scope.queryByRole('option', { name: /^Bank Transfer$/i })).toBeNull();
  });

  it('GIF9: editing a stored-UPI item shows "Cash Payout" selected and PATCHes BANK_TRANSFER', async () => {
    const { calls } = installFetch(serveUpiItem);
    render(<AdminGiftsPage />);

    await userEvent.click(await screen.findByRole('button', { name: /edit reward/i }));

    const dialog = await screen.findByText('Edit Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    // The dropdown shows the single "Cash Payout" option selected (UPI mapped to it).
    const cashOption = scope.getByRole('option', { name: 'Cash Payout' }) as HTMLOptionElement;
    const select = cashOption.closest('select') as HTMLSelectElement;
    expect(select.value).toBe('BANK_TRANSFER');

    // Re-saving persists the canonical BANK_TRANSFER, never the legacy UPI.
    await userEvent.click(scope.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      const patch = calls.find(
        (c) => c.url === '/api/admin/rewards/catalog/rc-upi' && c.init?.method === 'PATCH',
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch!.init!.body)).redemptionMode).toBe('BANK_TRANSFER');
    });
  });

  it('GIF10: the catalogue table renders "Cash Payout" for a stored-UPI item (not the raw enum)', async () => {
    installFetch(serveUpiItem);
    render(<AdminGiftsPage />);

    expect(await screen.findByText('Instant Cash 1000')).toBeInTheDocument();
    // Mode column shows the friendly label; the raw enum values never surface.
    expect(await screen.findByText('Cash Payout')).toBeInTheDocument();
    expect(screen.queryByText('UPI')).toBeNull();
    expect(screen.queryByText('BANK_TRANSFER')).toBeNull();
  });
});
