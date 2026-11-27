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

// The Fulfilment tab's Advance + bulk controls are Gifsy-operator only; these suites exercise
// them as GIFSY_ADMIN (the view-only CLIENT_ADMIN path is covered in gifts-orders-view-only).
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: 'GIFSY_ADMIN' }) }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({ role: 'GIFSY_ADMIN', permissions: [], ready: true, error: false, has: () => true, retry: () => {} }),
}));

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
    // GIFT_CARD + FIXED is the default → PURE DERIVE: enter the ₹ selling value (price
    // driver); the backend derives pointsCost. No manual points input exists.
    await userEvent.type(scope.getByPlaceholderText('500'), '750');

    await userEvent.click(scope.getByRole('button', { name: /add reward/i }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url.startsWith('/api/admin/rewards/catalog') && c.init?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post!.init!.body));
      expect(body.code).toBe('NEW-1');
      expect(body.redemptionMode).toBe('GIFT_CARD');
      // Pure derive: the FE sends the selling value, NEVER a manual pointsCost.
      expect(body.sellingValuePaise).toBe(75000); // ₹750 → paise
      expect(body.pointsCost).toBeUndefined();
    });
  });

  it('GIF3b: a fixed item with NO selling value is blocked (no POST — selling value is required)', async () => {
    const { calls } = installFetch();
    render(<AdminGiftsPage />);
    const addButtons = await screen.findAllByRole('button', { name: /add reward/i });
    await userEvent.click(addButtons[addButtons.length - 1]);

    const dialog = await screen.findByText('Add Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    await userEvent.type(scope.getByPlaceholderText('AMZ-500'), 'NOSV-1');
    await userEvent.type(scope.getByPlaceholderText('Amazon Voucher ₹500'), 'No Selling Value');
    // Leave the selling value blank → validation must block the save.
    await userEvent.click(scope.getByRole('button', { name: /add reward/i }));

    expect(await scope.findByText(/Selling value .* is required/i)).toBeInTheDocument();
    expect(
      calls.find((c) => c.url.startsWith('/api/admin/rewards/catalog') && c.init?.method === 'POST'),
    ).toBeFalsy();
  });

  it('GIF3c: there is NO manual points-cost input for a fixed item', async () => {
    installFetch();
    render(<AdminGiftsPage />);
    const addButtons = await screen.findAllByRole('button', { name: /add reward/i });
    await userEvent.click(addButtons[addButtons.length - 1]);

    const dialog = await screen.findByText('Add Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    // The old manual "Points cost *" field (placeholder 2500) is gone — pure derive.
    expect(scope.queryByText('Points cost *')).toBeNull();
    expect(scope.queryByPlaceholderText('2500')).toBeNull();
  });

  it('GIF3d: a derived-points preview shows when the tenant conversion rate is available', async () => {
    // /api/settings returns the live per-tenant rate (2 pts/₹ here) for the preview.
    const { calls } = installFetch((url) =>
      url.startsWith('/api/settings') ? jsonOk({ conversionRate: 2 }) : undefined,
    );
    render(<AdminGiftsPage />);
    // The page fetches the rate on mount.
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/settings'))).toBe(true));

    const addButtons = await screen.findAllByRole('button', { name: /add reward/i });
    await userEvent.click(addButtons[addButtons.length - 1]);
    const dialog = await screen.findByText('Add Reward', { selector: 'h2' });
    const modal = dialog.closest('div.relative') as HTMLElement;
    const scope = within(modal);

    await userEvent.type(scope.getByPlaceholderText('500'), '500'); // ₹500 × 2 = 1,000 pts
    expect(await scope.findByText(/1,000 pts/)).toBeInTheDocument();
    expect(scope.getByText(/at this tenant's conversion rate/i)).toBeInTheDocument();
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

  it('GIF6: a free-amount voucher WITH a Max POSTs both bounds (no manual pointsCost)', async () => {
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
      // Pure derive: the FE no longer sends pointsCost (the backend keeps it 0 for a banded item).
      expect(body.pointsCost).toBeUndefined();
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
    await userEvent.type(scope.getByPlaceholderText('500'), '750'); // ₹ selling value (price driver)

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
    await userEvent.type(scope.getByPlaceholderText('500'), '750'); // ₹ selling value (price driver)
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

  describe('GIF-H — per-brand Hubble amounts', () => {
    const FIXED_LOOKUP = {
      product: {
        productId: 'fk-1', name: 'Flipkart', denominationType: 'FIXED',
        denominations: [150, 300, 1250], minValue: 150, maxValue: 10000, maxVouchersPerOrder: 10,
      },
      conversionRate: 2,
      minVoucherFreeAmount: 200,
    };
    const FLEX_LOOKUP = {
      product: {
        productId: 'amz-1', name: 'Amazon Pay', denominationType: 'FLEXIBLE',
        denominations: [], minValue: 500, maxValue: 10000, maxVouchersPerOrder: 10,
      },
      conversionRate: 1,
      minVoucherFreeAmount: 0,
    };

    async function openAdd() {
      const addButtons = await screen.findAllByRole('button', { name: /add reward/i });
      await userEvent.click(addButtons[addButtons.length - 1]);
      const dialog = await screen.findByText('Add Reward', { selector: 'h2' });
      return within(dialog.closest('div.relative') as HTMLElement);
    }

    it('GIF15: FIXED brand → "Load from Hubble" shows its amounts (points each, below-minimum disabled); ticked amounts are saved as hubbleDenominations', async () => {
      const { calls } = installFetch((url) =>
        url.startsWith('/api/admin/rewards/hubble-products/fk-1') ? jsonOk(FIXED_LOOKUP) : undefined,
      );
      render(<AdminGiftsPage />);
      const scope = await openAdd();
      await userEvent.type(scope.getByPlaceholderText('AMZ-500'), 'FK');
      await userEvent.type(scope.getByPlaceholderText('Amazon Voucher ₹500'), 'Flipkart');
      await userEvent.type(scope.getByPlaceholderText(/amazon-pay-product-id/i), 'fk-1');
      await userEvent.click(scope.getByRole('button', { name: /load via api/i }));

      const panel = await scope.findByTestId('hubble-product-panel');
      expect(await within(panel).findByText('Flipkart')).toBeInTheDocument();
      expect(await within(panel).findByText(/fixed amounts/i)).toBeInTheDocument();
      // ₹150 is below the ₹200 program minimum → disabled; ₹300 = 600 pts at rate 2.
      expect(await within(panel).findByRole('checkbox', { name: 'Offer ₹150' })).toBeDisabled();
      expect(await within(panel).findByText('600 pts')).toBeInTheDocument();

      await userEvent.click(await within(panel).findByRole('checkbox', { name: 'Offer ₹1,250' }));
      await userEvent.click(await within(panel).findByRole('checkbox', { name: 'Offer ₹300' }));
      // The selling-value / range inputs are gone — the amounts drive the item.
      expect(scope.queryByPlaceholderText('500')).not.toBeInTheDocument();
      expect(scope.getByTestId('amount-list-note')).toHaveTextContent('₹300 · ₹1,250');

      await userEvent.click(scope.getByRole('button', { name: /add reward/i }));
      await waitFor(() => {
        const post = calls.find((c) => c.url.startsWith('/api/admin/rewards/catalog') && c.init?.method === 'POST');
        expect(post).toBeTruthy();
        const body = JSON.parse(String(post!.init!.body));
        expect(body.hubbleProductId).toBe('fk-1');
        expect(body.hubbleDenominations).toEqual([300, 1250]);
        expect(body).not.toHaveProperty('minRedemptionPoints');
        expect(body).not.toHaveProperty('maxRedemptionPoints');
        expect(body).not.toHaveProperty('sellingValuePaise');
      });
    });

    it('GIF16: FIXED brand + a typed Free-amount range is refused in the editor (no POST)', async () => {
      const { calls } = installFetch((url) =>
        url.startsWith('/api/admin/rewards/hubble-products/fk-1') ? jsonOk(FIXED_LOOKUP) : undefined,
      );
      render(<AdminGiftsPage />);
      const scope = await openAdd();
      await userEvent.type(scope.getByPlaceholderText('AMZ-500'), 'FK');
      await userEvent.type(scope.getByPlaceholderText('Amazon Voucher ₹500'), 'Flipkart');
      await userEvent.type(scope.getByPlaceholderText(/amazon-pay-product-id/i), 'fk-1');
      await userEvent.click(scope.getByRole('button', { name: /load via api/i }));
      await scope.findByTestId('hubble-product-panel');
      await userEvent.click(scope.getByRole('button', { name: /free amount/i }));
      await userEvent.type(scope.getByPlaceholderText('100'), '100');
      await userEvent.type(scope.getByPlaceholderText('e.g. 5000'), '10000');
      await userEvent.click(scope.getByRole('button', { name: /add reward/i }));
      expect(await scope.findByText(/only issues fixed amounts — choose the amounts/i)).toBeInTheDocument();
      expect(calls.some((c) => c.url.startsWith('/api/admin/rewards/catalog') && c.init?.method === 'POST')).toBe(false);
    });

    it('GIF17: FLEXIBLE brand → shows the min–max and lets the admin add specific whole-rupee amounts inside it', async () => {
      const { calls } = installFetch((url) =>
        url.startsWith('/api/admin/rewards/hubble-products/amz-1') ? jsonOk(FLEX_LOOKUP) : undefined,
      );
      render(<AdminGiftsPage />);
      const scope = await openAdd();
      await userEvent.type(scope.getByPlaceholderText('AMZ-500'), 'AMZ');
      await userEvent.type(scope.getByPlaceholderText('Amazon Voucher ₹500'), 'Amazon');
      await userEvent.type(scope.getByPlaceholderText(/amazon-pay-product-id/i), 'amz-1');
      await userEvent.click(scope.getByRole('button', { name: /load via api/i }));
      const panel = await scope.findByTestId('hubble-product-panel');
      expect(await within(panel).findByText(/flexible amount/i)).toBeInTheDocument();
      expect(panel).toHaveTextContent('₹500');
      expect(panel).toHaveTextContent('₹10,000');

      const amt = await within(panel).findByLabelText('Amount to offer');
      await userEvent.type(amt, '250');
      await userEvent.click(await within(panel).findByRole('button', { name: /add amount/i }));
      expect(await scope.findByText(/minimum for this brand is ₹500/i)).toBeInTheDocument();
      await userEvent.clear(amt);
      await userEvent.type(amt, '1000.5'); // a decimal is never swallowed — refused, nothing added
      await userEvent.click(await within(panel).findByRole('button', { name: /add amount/i }));
      expect(await within(panel).findByText('Check the amount — whole rupees only')).toHaveAttribute('role', 'alert');
      expect(scope.queryByRole('button', { name: 'Remove ₹1,000' })).toBeNull();
      await userEvent.clear(amt);
      await userEvent.type(amt, '1000');
      await userEvent.click(await within(panel).findByRole('button', { name: /add amount/i }));
      expect(scope.getByRole('button', { name: 'Remove ₹1,000' })).toBeInTheDocument();

      await userEvent.click(scope.getByRole('button', { name: /add reward/i }));
      await waitFor(() => {
        const post = calls.find((c) => c.url.startsWith('/api/admin/rewards/catalog') && c.init?.method === 'POST');
        expect(post).toBeTruthy();
        expect(JSON.parse(String(post!.init!.body)).hubbleDenominations).toEqual([1000]);
      });
    });

    it("GIF20: FIXED brand whose list Hubble didn't return → says so and allows manual whole-rupee amounts (≥ program minimum)", async () => {
      const UNKNOWN = { ...FIXED_LOOKUP, product: { ...FIXED_LOOKUP.product, denominations: [] } };
      const { calls } = installFetch((url) =>
        url.startsWith('/api/admin/rewards/hubble-products/fk-1') ? jsonOk(UNKNOWN) : undefined,
      );
      render(<AdminGiftsPage />);
      const scope = await openAdd();
      await userEvent.type(scope.getByPlaceholderText('AMZ-500'), 'FK');
      await userEvent.type(scope.getByPlaceholderText('Amazon Voucher ₹500'), 'Flipkart');
      await userEvent.type(scope.getByPlaceholderText(/amazon-pay-product-id/i), 'fk-1');
      await userEvent.click(scope.getByRole('button', { name: /load via api/i }));
      const panel = await scope.findByTestId('hubble-product-panel');
      expect(await within(panel).findByTestId('fixed-list-unknown'))
        .toHaveTextContent("The API didn't return its amounts — enter the amounts the API shows for this brand");

      const amt = await within(panel).findByLabelText('Amount to offer');
      // F2/F6: an invalid amount never disables "Add amount" — the tap shows "Check the amount" (and
      // adds nothing); the next keystroke hides it.
      await userEvent.type(amt, '1,2');
      const addBtn = await within(panel).findByRole('button', { name: /add amount/i });
      expect(addBtn).toBeEnabled();
      await userEvent.click(addBtn);
      expect(await within(panel).findByText('Check the amount — whole rupees only')).toHaveAttribute('role', 'alert');
      await userEvent.type(amt, '5');
      expect(within(panel).queryByText('Check the amount — whole rupees only')).toBeNull();
      await userEvent.clear(amt);
      await userEvent.type(amt, '175'); // below the ₹200 program minimum
      await userEvent.click(await within(panel).findByRole('button', { name: /add amount/i }));
      expect(await scope.findByText(/below this program's minimum voucher amount/i)).toBeInTheDocument();
      await userEvent.clear(amt);
      await userEvent.type(amt, '300');
      await userEvent.click(await within(panel).findByRole('button', { name: /add amount/i }));

      await userEvent.click(scope.getByRole('button', { name: /add reward/i }));
      await waitFor(() => {
        const post = calls.find((c) => c.url.startsWith('/api/admin/rewards/catalog') && c.init?.method === 'POST');
        expect(post).toBeTruthy();
        expect(JSON.parse(String(post!.init!.body)).hubbleDenominations).toEqual([300]);
      });
    });

    it('GIF18: a Hubble lookup error is shown honestly (e.g. product not found / not configured)', async () => {
      installFetch((url) =>
        url.startsWith('/api/admin/rewards/hubble-products/')
          ? Promise.resolve({
              ok: false, status: 404,
              json: () => Promise.resolve({ success: false, error: 'No active Hubble product with ID "bad-id".' }),
            })
          : undefined,
      );
      render(<AdminGiftsPage />);
      const scope = await openAdd();
      await userEvent.type(scope.getByPlaceholderText(/amazon-pay-product-id/i), 'bad-id');
      await userEvent.click(scope.getByRole('button', { name: /load via api/i }));
      expect(await scope.findByRole('alert')).toHaveTextContent('No active Hubble product with ID "bad-id".');
      expect(scope.queryByTestId('hubble-product-panel')).not.toBeInTheDocument();
    });

    it('GIF19: editing a saved list item auto-loads the brand, shows the saved amounts, and clearing them sends []', async () => {
      const LIST_ITEM = {
        ...CATALOG_ITEMS[0], id: 'r-fk', pointsCost: 0, minRedemptionPoints: 300, maxRedemptionPoints: 2500,
        metadata: { hubbleProductId: 'fk-1', hubbleDenominations: [300, 1250] },
      };
      const { calls } = installFetch((url, init) => {
        if (url.startsWith('/api/admin/rewards/hubble-products/fk-1')) return jsonOk(FIXED_LOOKUP);
        if (url.startsWith('/api/admin/rewards/catalog') && (!init?.method || init.method === 'GET')) {
          return jsonOk({ items: [LIST_ITEM], pagination: { page: 1, limit: 200, total: 1, pages: 1 } });
        }
        return undefined;
      });
      render(<AdminGiftsPage />);
      await userEvent.click(await screen.findByRole('button', { name: /edit reward/i }));
      const dialog = await screen.findByText('Edit Reward', { selector: 'h2' });
      const scope = within(dialog.closest('div.relative') as HTMLElement);
      const panel = await scope.findByTestId('hubble-product-panel');
      expect(await within(panel).findByRole('checkbox', { name: 'Offer ₹300' })).toBeChecked();
      expect(await within(panel).findByRole('checkbox', { name: 'Offer ₹1,250' })).toBeChecked();
      expect(calls.some((c) => c.url === '/api/admin/rewards/hubble-products/fk-1')).toBe(true);

      // Untick both → the item falls back to a normal voucher; the save sends [] to clear the list.
      await userEvent.click(await within(panel).findByRole('checkbox', { name: 'Offer ₹300' }));
      await userEvent.click(await within(panel).findByRole('checkbox', { name: 'Offer ₹1,250' }));
      // The stored shape is variable-amount → switch to Fixed and price it at ₹300 instead.
      await userEvent.click(scope.getByRole('button', { name: /🎯 fixed/i }));
      await userEvent.type(scope.getByPlaceholderText('500'), '300');
      await userEvent.click(scope.getByRole('button', { name: /save/i }));
      await waitFor(() => {
        const patch = calls.find((c) => c.url.startsWith('/api/admin/rewards/catalog/r-fk') && c.init?.method === 'PATCH');
        expect(patch).toBeTruthy();
        expect(JSON.parse(String(patch!.init!.body)).hubbleDenominations).toEqual([]);
      });
    });
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
    // Selling value is the FIXED price driver (placeholder "500"); MRP keeps "(optional)".
    await userEvent.type(scope.getByPlaceholderText('500'), '400');

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

    const svInput = scope.getByPlaceholderText('500') as HTMLInputElement;
    expect(svInput.value).toBe('400');
  });

  it('GIF-PAGES: loads EVERY page of the catalogue (an item past the first 200 is still listed and editable)', async () => {
    const A = { ...CATALOG_ITEMS[0], id: 'r-page1', name: 'Page One Kettle' };
    const B = { ...CATALOG_ITEMS[0], id: 'r-page2', name: 'Page Two Mixer' };
    const { calls } = installFetch((url, init) => {
      if (!url.startsWith('/api/admin/rewards/catalog') || (init?.method && init.method !== 'GET')) return undefined;
      if (url === '/api/admin/rewards/catalog?page=1&limit=200') return jsonOk({ items: [A], pagination: { page: 1, limit: 200, total: 201, pages: 2 } });
      if (url === '/api/admin/rewards/catalog?page=2&limit=200') return jsonOk({ items: [B], pagination: { page: 2, limit: 200, total: 201, pages: 2 } });
      return undefined;
    });
    render(<AdminGiftsPage />);
    expect(await screen.findByText('Page One Kettle')).toBeInTheDocument();
    expect(await screen.findByText('Page Two Mixer')).toBeInTheDocument();
    expect(calls.filter((c) => c.url.startsWith('/api/admin/rewards/catalog?')).map((c) => c.url))
      .toEqual(['/api/admin/rewards/catalog?page=1&limit=200', '/api/admin/rewards/catalog?page=2&limit=200']);
  });

  describe('GIF-STK — stock history wiring (owner 2026-11-26)', () => {
    const STOCKED = { ...CATALOG_ITEMS[0], id: 'r-stk', sellingValuePaise: 40000, stockQuantity: 5 };
    const serveStocked = (url: string, init?: RequestInit) =>
      url === '/api/admin/rewards/catalog?page=1&limit=200'
        ? jsonOk({ items: [STOCKED], pagination: { page: 1, limit: 200, total: 1, pages: 1 } })
        : init?.method === 'PATCH'
          ? jsonOk({ item: STOCKED })
          : undefined;

    const openEditor = async () => {
      await userEvent.click(await screen.findByRole('button', { name: /edit reward/i }));
      const dialog = await screen.findByText('Edit Reward', { selector: 'h2' });
      return within(dialog.closest('div.relative') as HTMLElement);
    };

    it('GIF-STK1: saving other fields NEVER sends the stock (a stale window cannot overwrite a redemption) — no reason box', async () => {
      const { calls } = installFetch(serveStocked);
      render(<AdminGiftsPage />);
      const scope = await openEditor();
      expect(scope.queryByLabelText(/Reason for the stock change/)).toBeNull();
      await userEvent.click(scope.getByRole('button', { name: /save changes/i }));
      await waitFor(() => {
        const patch = calls.find((c) => c.url === '/api/admin/rewards/catalog/r-stk' && c.init?.method === 'PATCH');
        expect(patch).toBeTruthy();
        const body = JSON.parse(String(patch!.init!.body));
        expect('stockQuantity' in body).toBe(false);
        expect('stockReason' in body).toBe(false);
      });
    });

    it('GIF-STK2: changing the stock shows the reason box and sends stock + reason', async () => {
      const { calls } = installFetch(serveStocked);
      render(<AdminGiftsPage />);
      const scope = await openEditor();
      const stock = scope.getByDisplayValue('5');
      await userEvent.clear(stock);
      await userEvent.type(stock, '8');
      await userEvent.type(scope.getByLabelText(/Reason for the stock change/), 'Restocked');
      await userEvent.click(scope.getByRole('button', { name: /save changes/i }));
      await waitFor(() => {
        const patch = calls.find((c) => c.url === '/api/admin/rewards/catalog/r-stk' && c.init?.method === 'PATCH');
        expect(JSON.parse(String(patch!.init!.body))).toMatchObject({ stockQuantity: 8, stockReason: 'Restocked' });
      });
      // the stock history panel was asked for this reward
      expect(calls.some((c) => c.url === '/api/admin/rewards/catalog/r-stk/stock-history')).toBe(true);
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
    expect(await screen.findByText(/Row 4/)).toBeInTheDocument();

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

    // Pure derive: a FIXED item now requires a ₹ selling value before it can be saved
    // (the legacy UPI item has none stored) — enter one, then save.
    await userEvent.type(scope.getByPlaceholderText('500'), '1000');

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
