/// <reference types="vitest/globals" />
/**
 * Sales-assisted redeem — amounts (owner 2026-11-11).
 *  SA1: a Hubble "choose from amounts" gift card shows the amounts as buttons (with points at the
 *       tenant rate from /me) — no free typing — and posts the chosen amount.
 *  SA2: a free-amount item's ₹ input is whole-rupee only (a typed "750.5" or a pasted "1,250.75"
 *       stays visible → "Check the amount — whole rupees only", nothing sent) and posts an integer.
 *  SA4: once the OTP is sent the amount is frozen: success shows the ORDER's amount; "Change
 *       amount" returns to an unlocked field (fresh redeem).
 *  SA3: a catalogue WITHOUT a list item never calls /api/auth/me (no extra request for e.g. Deoleo).
 *
 * Run: npx vitest run src/app/sales/catalogue/__tests__/catalogue-amounts.test.tsx
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';
import CataloguePage from '../page';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}));

const LIST_ITEM = {
  id: 'fk-1', name: 'Flipkart Card', pointsCost: 0, description: 'Flipkart gift card',
  imageUrls: null, status: 'ACTIVE', stockQuantity: null, redemptionMode: 'GIFT_CARD',
  minRedemptionPoints: 300, maxRedemptionPoints: 1250, amountOptions: [300, 600, 1250],
};
const FREE_ITEM = {
  id: 'amz-1', name: 'Amazon Any', pointsCost: 0, description: 'Amazon gift card',
  imageUrls: null, status: 'ACTIVE', stockQuantity: null, redemptionMode: 'GIFT_CARD',
  minRedemptionPoints: 100, maxRedemptionPoints: 10000,
};
const OUTLET = {
  id: 'o1', partnerId: 'p1', kycId: 'k1', name: 'Shop One', mobile: '9830011252', balance: 50000,
  ownerName: 'Asha', deliveryDefaults: null,
};

function mockFetch(items: unknown[]) {
  const posts: Record<string, unknown>[] = [];
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
    if (url.includes('/api/rewards/redeem-for-outlet')) {
      posts.push(JSON.parse(String(init?.body ?? '{}')));
      return ok({ orderId: 'ord-1', orderNumber: 'BAJ-26-000001' });
    }
    if (url.includes('/api/rewards/catalog')) return ok({ items });
    if (url.includes('/api/sales/outlets')) return ok({ outlets: [OUTLET] });
    if (url.includes('/api/auth/me')) return ok({ conversionRate: 2, settings: { minVoucherFreeAmount: 500 } });
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

describe('sales catalogue — redemption amounts', () => {
  it('SA1: list item → amount buttons with points (rate 2), no ₹ input, posts the chosen amount', async () => {
    const { posts } = mockFetch([LIST_ITEM]);
    await openConfirm(/Flipkart Card/);

    expect(await screen.findByRole('group', { name: /voucher amount/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount to redeem (₹)')).not.toBeInTheDocument();
    expect(await screen.findByText('2,500 pts')).toBeInTheDocument(); // ₹1,250 × 2
    expect(await screen.findByRole('button', { name: /Send OTP/ })).toBeDisabled();

    // ₹300 is below the ₹500 program minimum → greyed out (disabled), like the partner sheet.
    expect(await screen.findByRole('button', { name: /^₹300, 600 points \(below the minimum\)/ })).toBeDisabled();
    expect(await screen.findByRole('button', { name: /^₹600, 1,200 points$/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /^₹1,250, 2,500 points$/ }));
    expect(screen.getByRole('button', { name: /^₹1,250, 2,500 points$/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Send OTP/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ rewardId: 'fk-1', targetPartnerId: 'p1', amount: 1250 });
  });

  it('SA2: free-amount ₹ input is whole-rupee only and posts an integer', async () => {
    const { posts } = mockFetch([FREE_ITEM]);
    await openConfirm(/Amazon Any/);
    await screen.findByTestId('redeem-amount-band'); // limits loaded (Send is disabled until then)
    const input = await screen.findByLabelText('Amount to redeem (₹)') as HTMLInputElement;
    expect(input).toHaveAttribute('inputmode', 'numeric');

    const user = userEvent.setup();
    await user.click(input);
    await user.paste('1,250.75');
    expect(input.value).toBe('1,250.75'); // never shrunk
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the amount');
    // F6: the button is NOT disabled for an invalid amount — a tap shows the reason, sends nothing.
    const send = await screen.findByRole('button', { name: /Send OTP/ });
    expect(send).toBeEnabled();
    // F2: the next keystroke hides the message (never shown mid-typing)…
    await user.type(input, '5');
    expect(input.value).toBe('1,250.755'); // an invalid text is edited verbatim
    expect(screen.queryByRole('alert')).toBeNull();
    // …and a tap on Send OTP commits: the message is back, nothing is sent.
    fireEvent.click(send);
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the amount');
    expect(posts).toHaveLength(0);
    await user.clear(input);
    await user.type(input, '750.5');
    expect(input.value).toBe('750.5'); // a typed "." is never swallowed — the amount is never changed
    fireEvent.click(screen.getByRole('button', { name: /Send OTP/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check the amount — whole rupees only');
    expect(posts).toHaveLength(0);
    await user.clear(input);
    await user.type(input, '750');

    fireEvent.click(screen.getByRole('button', { name: /Send OTP/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ rewardId: 'amz-1', amount: 750 });
  });

  it('F3: the success screen uses the SERVER requiredPoints frozen at OTP-send (points deducted + new balance, en-IN ₹)', async () => {
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
      if (url.includes('/api/rewards/redeem-for-outlet/confirm')) { posts.push(url); return ok({ orderId: 'ord-1', status: 'CONFIRMED', message: 'ok' }); }
      if (url.includes('/api/rewards/redeem-for-outlet')) {
        posts.push(String(init?.body));
        return ok({ orderId: 'ord-1', orderNumber: 'BAJ-26-000001', requiredPoints: 2468 });
      }
      if (url.includes('/api/rewards/catalog')) return ok({ items: [FREE_ITEM] });
      if (url.includes('/api/sales/outlets')) return ok({ outlets: [OUTLET] });
      // The typed-amount ₹ limits need the tenant rate (Send stays disabled until it loads).
      if (url.includes('/api/auth/me')) return ok({ conversionRate: 2, settings: { minVoucherFreeAmount: 500 } });
      return ok({});
    }));
    await openConfirm(/Amazon Any/);
    await screen.findByTestId('redeem-amount-band');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Amount to redeem (₹)'), '1234');
    fireEvent.click(screen.getByRole('button', { name: /Send OTP/ }));
    await screen.findByText('OTP sent to outlet');
    const otp = document.querySelector('input[maxlength="6"]') as HTMLInputElement;
    fireEvent.change(otp, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify & Redeem/ }));
    expect(await screen.findByText('Redemption Successful!')).toBeInTheDocument();
    expect(await screen.findByText('₹1,234')).toBeInTheDocument();
    expect(await screen.findByText('−2,468 pts')).toBeInTheDocument();
    expect(await screen.findByText(`${(50000 - 2468).toLocaleString('en-IN')} pts`)).toBeInTheDocument();
  });

  it('SA4: after the OTP is sent the ORDER amount is shown; "Change amount" returns to an unlocked field', async () => {
    const { posts } = mockFetch([FREE_ITEM]);
    await openConfirm(/Amazon Any/);
    await screen.findByTestId('redeem-amount-band');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Amount to redeem (₹)'), '900');
    fireEvent.click(screen.getByRole('button', { name: /Send OTP/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ amount: 900 });
    expect(await screen.findByText('₹900')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Change amount' }));
    const input = await screen.findByLabelText('Amount to redeem (₹)') as HTMLInputElement;
    expect(input).toBeEnabled();
    expect(input.value).toBe('900');
    await user.clear(input);
    await user.type(input, '1200');
    fireEvent.click(screen.getByRole('button', { name: /Send OTP/ }));
    await waitFor(() => expect(posts).toHaveLength(2)); // a fresh redeem with the new amount
    expect(posts[1]).toMatchObject({ amount: 1200 });
  });

  it('SA3: no list item → /api/auth/me is never requested', async () => {
    const { urls } = mockFetch([FREE_ITEM]);
    render(<CataloguePage />);
    await screen.findByRole('button', { name: /Amazon Any/ });
    expect(urls.some((u) => u.includes('/api/auth/me'))).toBe(false);
  });
});
