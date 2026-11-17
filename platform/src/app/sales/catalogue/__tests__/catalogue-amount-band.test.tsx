/// <reference types="vitest/globals" />
/**
 * Sales-assisted "redeem for outlet" — the ₹ min/max band on a TYPED variable-amount item
 * (same rule as the partner voucher sheet, lib/voucher-band):
 *  SB1: the band comes from the ADMIN's per-item points band (→ ₹ at the tenant rate) and blocks
 *       Send OTP below / above it with an inline message (no request); in-band sends.
 *  SB2: the tenant floor (minVoucherFreeAmount) wins when higher than the item min.
 *  SB3: an empty band (floor above the item max) → "can't be redeemed", input + button locked.
 *  SB4: a choose-from-amounts item is unchanged (buttons, no band text).
 *  SB5: a cash (BANK_TRANSFER) item is floored by minBankTransferAmount (the server's rule).
 *  SB6: /me is requested only when a variable-amount item is opened, and the band describes the input;
 *       SB6b: a fixed-points-only catalogue never requests /me.
 *  SB7: /me pending → no band text (never "min ₹0"), Send disabled as "Loading limits…".
 *  SB8: /me fails → "Couldn't load redemption limits" + a working retry; Send disabled until then.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import CataloguePage from '../page';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}));

const AMAZON = {
  id: 'amz', name: 'Amazon Voucher', pointsCost: 0, description: 'Amazon gift card',
  imageUrls: null, status: 'ACTIVE', stockQuantity: null, redemptionMode: 'GIFT_CARD',
  minRedemptionPoints: 500, maxRedemptionPoints: 10_000,
};
const OUTLET = {
  id: 'o1', partnerId: 'p1', kycId: 'k1', name: 'Shop One', mobile: '9830011252', balance: 50_000,
  ownerName: 'Asha', deliveryDefaults: null,
};

type MeHandler = (call: number) => Promise<unknown>;

function mockFetch(items: unknown[], me?: MeHandler) {
  const posts: Record<string, unknown>[] = [];
  const urls: string[] = [];
  let meCalls = 0;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
    if (url.includes('/api/rewards/redeem-for-outlet')) {
      posts.push(JSON.parse(String(init?.body ?? '{}')));
      return ok({ orderId: 'ord-1', orderNumber: 'BAJ-26-000001', requiredPoints: 600 });
    }
    if (url.includes('/api/rewards/catalog')) return ok({ items });
    if (url.includes('/api/sales/outlets')) return ok({ outlets: [OUTLET] });
    if (url.includes('/api/auth/me')) {
      meCalls += 1;
      if (me) return me(meCalls);
      return ok({ conversionRate: 1, settings: { minVoucherFreeAmount: 250, minBankTransferAmount: 1000 } });
    }
    return ok({});
  }));
  return { posts, urls };
}

async function openConfirm(giftName: RegExp) {
  render(<CataloguePage />);
  fireEvent.click(await screen.findByRole('button', { name: giftName }));
  fireEvent.click(screen.getByRole('button', { name: /^Redeem( for|$)/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Shop One/ }));
  await screen.findByText('Confirm Redemption');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('sales catalogue — ₹ band on a typed variable-amount item', () => {
  it('SB1: shows "min ₹500, max ₹10,000" and blocks Send OTP outside it (no request); in-band sends', async () => {
    const { posts } = mockFetch([AMAZON]);
    await openConfirm(/Amazon Voucher/);
    expect(await screen.findByTestId('redeem-amount-band')).toHaveTextContent('(min ₹500, max ₹10,000)');
    const input = await screen.findByLabelText('Amount to redeem (₹)');
    const user = userEvent.setup();

    // Below the item min (above the ₹250 tenant floor).
    await user.type(input, '300');
    expect(await screen.findByText('Minimum redemption is ₹500')).toBeInTheDocument();
    const minBtn = await screen.findByRole('button', { name: 'Min ₹500 required' });
    expect(minBtn).toBeDisabled();
    fireEvent.click(minBtn);

    // Above the item max.
    await user.clear(input);
    await user.type(input, '20000');
    expect(await screen.findByText('Maximum redemption is ₹10,000')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Max ₹10,000 allowed' })).toBeDisabled();
    expect(posts).toHaveLength(0);

    // Inside the band → sends.
    await user.clear(input);
    await user.type(input, '600');
    expect(screen.queryByText(/Minimum redemption|Maximum redemption/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Send OTP/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ rewardId: 'amz', targetPartnerId: 'p1', amount: 600 });
  });

  it('SB2: the tenant floor wins when it is higher than the item min', async () => {
    mockFetch([{ ...AMAZON, minRedemptionPoints: 100, maxRedemptionPoints: 5_000 }]);
    await openConfirm(/Amazon Voucher/);
    expect(await screen.findByTestId('redeem-amount-band')).toHaveTextContent('(min ₹250, max ₹5,000)');
    await userEvent.setup().type(await screen.findByLabelText('Amount to redeem (₹)'), '200');
    expect(await screen.findByText('Minimum redemption is ₹250')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Min ₹250 required' })).toBeDisabled();
  });

  it('SB3: an empty band (floor ₹250 above the item max ₹200) says it can\'t be redeemed and locks the input + button', async () => {
    const { posts } = mockFetch([{ ...AMAZON, minRedemptionPoints: 100, maxRedemptionPoints: 200 }]);
    await openConfirm(/Amazon Voucher/);
    expect(await screen.findByTestId('redeem-unredeemable')).toHaveTextContent("This voucher can't be redeemed right now");
    expect(screen.queryByTestId('redeem-amount-band')).toBeNull();
    expect(screen.queryByText(/max ₹200/)).toBeNull();
    const input = await screen.findByLabelText('Amount to redeem (₹)');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('aria-describedby', 'redeem-amount-unavailable');
    const btn = await screen.findByRole('button', { name: 'Not available' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(posts).toHaveLength(0);
  });

  it('SB4: a choose-from-amounts item is unchanged — amount buttons, no ₹ input, no band text', async () => {
    mockFetch([{ ...AMAZON, name: 'Myntra Gift Card', minRedemptionPoints: 100, maxRedemptionPoints: 1000, amountOptions: [100, 500, 1000] }]);
    await openConfirm(/Myntra Gift Card/);
    expect(await screen.findByRole('group', { name: /voucher amount/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount to redeem (₹)')).toBeNull();
    expect(await screen.findByRole('button', { name: /^₹100, 100 points \(below the minimum\)/ })).toBeDisabled();
    expect(await screen.findByRole('button', { name: /^₹500, 500 points$/ })).toBeEnabled();
    expect(screen.queryByTestId('redeem-amount-band')).toBeNull();
  });

  it('SB5: a cash (BANK_TRANSFER) item is floored by the bank-transfer minimum', async () => {
    mockFetch([{ ...AMAZON, name: 'Bank Transfer', redemptionMode: 'BANK_TRANSFER', minRedemptionPoints: 100, maxRedemptionPoints: 50_000 }]);
    await openConfirm(/Bank Transfer/);
    expect(await screen.findByTestId('redeem-amount-band')).toHaveTextContent('(min ₹1,000, max ₹50,000)');
  });

  it('SB6: /me is requested only on opening a variable-amount item; the band describes the input (+ the hint)', async () => {
    const { urls } = mockFetch([AMAZON]);
    render(<CataloguePage />);
    fireEvent.click(await screen.findByRole('button', { name: /Amazon Voucher/ }));
    await waitFor(() => expect(urls.filter((u) => u.includes('/api/auth/me'))).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /^Redeem$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Shop One/ }));
    await screen.findByTestId('redeem-amount-band');
    const input = await screen.findByLabelText('Amount to redeem (₹)');
    expect(input).toHaveAttribute('aria-describedby', 'redeem-amount-band');
    await userEvent.setup().type(input, '20000');
    expect(input).toHaveAttribute('aria-describedby', 'redeem-amount-band redeem-amount-hint');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('SB6b: a fixed-points-only catalogue never requests /me (opening the item included)', async () => {
    const { urls } = mockFetch([{
      ...AMAZON, id: 'jbl', name: 'JBL Speaker', pointsCost: 2500, redemptionMode: 'PHYSICAL_GIFT',
      minRedemptionPoints: null, maxRedemptionPoints: null,
    }]);
    render(<CataloguePage />);
    fireEvent.click(await screen.findByRole('button', { name: /JBL Speaker/ }));
    await screen.findByRole('button', { name: 'Redeem for 2,500 pts' });
    await new Promise((r) => setTimeout(r, 20));
    expect(urls.some((u) => u.includes('/api/auth/me'))).toBe(false);
  });

  it('SB7: while /me is pending — no band text (never "min ₹0"), Send disabled as "Loading limits…"', async () => {
    const { posts } = mockFetch([AMAZON], () => new Promise(() => {})); // never resolves
    await openConfirm(/Amazon Voucher/);
    expect(await screen.findByTestId('redeem-limits-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('redeem-amount-band')).toBeNull();
    expect(screen.queryByText(/min ₹0/)).toBeNull();
    await userEvent.setup().type(await screen.findByLabelText('Amount to redeem (₹)'), '50');
    const btn = await screen.findByRole('button', { name: 'Loading limits…' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(posts).toHaveLength(0);
  });

  it('SB8: /me fails → "Couldn\'t load redemption limits" + retry; Send disabled until a retry loads the band', async () => {
    const fail = { ok: false, status: 500, json: () => Promise.resolve({ success: false, error: 'boom' }) };
    const okMe = {
      ok: true, status: 200,
      json: () => Promise.resolve({ success: true, data: { conversionRate: 1, settings: { minVoucherFreeAmount: 250 } } }),
    };
    const { posts } = mockFetch([AMAZON], (n) => Promise.resolve(n === 1 ? fail : okMe));
    await openConfirm(/Amazon Voucher/);
    const err = await screen.findByTestId('redeem-limits-error');
    expect(err).toHaveTextContent("Couldn't load redemption limits");
    expect(screen.queryByTestId('redeem-amount-band')).toBeNull();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Amount to redeem (₹)'), '600');
    expect(await screen.findByRole('button', { name: 'Limits unavailable' })).toBeDisabled();
    expect(posts).toHaveLength(0);

    await user.click(await screen.findByRole('button', { name: 'try again' }));
    expect(await screen.findByTestId('redeem-amount-band')).toHaveTextContent('(min ₹500, max ₹10,000)');
    expect(screen.queryByTestId('redeem-limits-error')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Send OTP/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ amount: 600 });
  });
});
