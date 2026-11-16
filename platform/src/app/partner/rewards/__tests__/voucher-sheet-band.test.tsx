/// <reference types="vitest/globals" />
/**
 * VB — Voucher redeem sheet (Bajaj training-video findings, owner-approved platform-wide):
 *   1. min/max come from the ADMIN's per-item band (minRedemptionPoints/maxRedemptionPoints),
 *      floored by the tenant minVoucherFreeAmount; Send OTP is blocked outside the band
 *      with an inline message (no server round trip).
 *   2. the sheet shows the item's real name + image (not "voucher" + an emoji).
 *   3. the success copy follows the confirm status (DELIVERED = ready; else processing).
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Kumar Store', ownerName: 'Rajesh', partnerCode: 'P1',
    outletType: 'RETAILER', hasPointsActivity: true, hasPayoutActivity: false, loyaltyEnabled: true,
  }),
}));
// Tenant floor ₹250 at rate 1.
vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => ({
    pointsConversionRate: 1,
    minBankTransferAmount: 250,
    minVoucherFreeAmount: 250,
    redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
  }),
}));
const toastError = vi.fn();
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn(), toast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import RewardsPage, { voucherAmountBand } from '../page';

// The Bajaj shape: a Hubble Amazon item — FREE_AMOUNT, admin band ₹500–₹10,000 (points at rate 1),
// a logo image, and NO separate brand field (the member catalogue doesn't send one).
const AMAZON = {
  id: 'amz',
  name: 'Amazon Voucher',
  category: 'Gift Vouchers',
  pointsCost: 0,
  description: 'Redeemable on Amazon.in',
  redemptionMode: 'GIFT_CARD',
  minRedemptionPoints: 500,
  maxRedemptionPoints: 10_000,
  imageUrls: ['https://cdn.example/amazon.png'],
  available: true,
  isAffordable: true,
};

function catalogWith(items: unknown[]) {
  return {
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: { items, userBalance: 50_000, pagination: { page: 1, limit: 20, total: items.length, pages: 1 } },
    }),
  };
}
const ok = (data: unknown) => ({ ok: true, json: () => Promise.resolve({ success: true, data }) });

function stub(items: unknown[], confirmStatus = 'CONFIRMED') {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/rewards/redeem/confirm')) {
      return Promise.resolve(ok({ orderId: 'ord-1', status: confirmStatus, message: 'x' }));
    }
    if (url.includes('/api/rewards/redeem')) {
      return Promise.resolve(ok({ orderId: 'ord-1', orderNumber: 'RDM-1', requiredPoints: 600, message: 'OTP sent' }));
    }
    if (url.includes('/api/rewards/catalog')) return Promise.resolve(catalogWith(items));
    return Promise.resolve(ok({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const redeemCalls = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter(([u]) => u === '/api/rewards/redeem');

async function openSheet(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: /vouchers/i }));
  await user.click(await screen.findByText(name));
  return screen.findByTestId('voucher-sheet-name');
}

afterEach(() => { vi.unstubAllGlobals(); toastError.mockClear(); });

describe('VB — admin band on the voucher sheet', () => {
  it('VB1: shows "min ₹500, max ₹10,000" from the item band and blocks Send OTP outside it (no request)', async () => {
    const fetchMock = stub([AMAZON]);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openSheet(user, 'Amazon Voucher');

    expect(await screen.findByTestId('voucher-amount-band')).toHaveTextContent('(min ₹500, max ₹10,000)');
    const input = await screen.findByLabelText(/voucher amount/i);

    // Below the item min (but above the ₹250 tenant floor — the old, wrong min).
    await user.type(input, '300');
    expect(await screen.findByText('Minimum redemption is ₹500')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Min ₹500 required' })).toBeDisabled();

    // Above the item max.
    await user.clear(input);
    await user.type(input, '20000');
    expect(await screen.findByText('Maximum redemption is ₹10,000')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Max ₹10,000 allowed' })).toBeDisabled();
    expect(redeemCalls(fetchMock)).toHaveLength(0);

    // Inside the band → sends.
    await user.clear(input);
    await user.type(input, '600');
    await user.click(await screen.findByRole('button', { name: /send otp/i }));
    await waitFor(() => expect(redeemCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse((redeemCalls(fetchMock)[0][1] as RequestInit).body as string)).toEqual({ rewardId: 'amz', amount: 600 });
  });

  it('VB2: the tenant floor wins when it is higher than the item min', async () => {
    stub([{ ...AMAZON, minRedemptionPoints: 100, maxRedemptionPoints: 5_000 }]);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openSheet(user, 'Amazon Voucher');
    expect(await screen.findByTestId('voucher-amount-band')).toHaveTextContent('(min ₹250, max ₹5,000)');
    await user.type(await screen.findByLabelText(/voucher amount/i), '200');
    expect(await screen.findByRole('button', { name: 'Min ₹250 required' })).toBeDisabled();
  });

  // (A min-only band is not a real case: the server's FREE_AMOUNT needs BOTH bounds and the admin
  // save requires both — the no-max branch only arises at an unknown rate, see the unit tests.)
  it('VB3: a wide band (Deoleo-style ₹100–₹50,000, floor ₹250) — a high in-band amount is allowed; the band describes the input', async () => {
    stub([{ ...AMAZON, name: 'Flexi Voucher', imageUrls: [], minRedemptionPoints: 100, maxRedemptionPoints: 50_000 }]);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openSheet(user, 'Flexi Voucher');
    expect(await screen.findByTestId('voucher-amount-band')).toHaveTextContent('(min ₹250, max ₹50,000)');
    const input = await screen.findByLabelText(/voucher amount/i);
    // L4: the band is the field's description in the normal state…
    expect(input).toHaveAttribute('aria-describedby', 'voucher-amount-band');
    await user.type(input, '40000');
    expect(await screen.findByRole('button', { name: /send otp/i })).toBeEnabled();
    // …and stays alongside the hint when one shows.
    await user.clear(input);
    await user.type(input, '60000');
    expect(input).toHaveAttribute('aria-describedby', 'voucher-amount-band voucher-amount-hint');
  });

  it('VB3b (L1): an empty band (tenant floor ₹250 above the item max ₹200) says it can\'t be redeemed and locks the input + button', async () => {
    const fetchMock = stub([{ ...AMAZON, minRedemptionPoints: 100, maxRedemptionPoints: 200 }]);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openSheet(user, 'Amazon Voucher');
    expect(await screen.findByTestId('voucher-unredeemable')).toHaveTextContent("This voucher can't be redeemed right now");
    expect(screen.queryByTestId('voucher-amount-band')).toBeNull(); // never "(min ₹250, max ₹200)"
    expect(screen.queryByText(/max ₹200/)).toBeNull();
    const input = await screen.findByLabelText(/voucher amount/i);
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('aria-describedby', 'voucher-amount-unavailable');
    const btn = await screen.findByRole('button', { name: 'Not available' });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(redeemCalls(fetchMock)).toHaveLength(0);
  });

  it('VB4: fixed denominations — only the listed amounts are offered (no text input, no band label); one below the floor is disabled', async () => {
    stub([{ ...AMAZON, name: 'Myntra Gift Card', minRedemptionPoints: 100, maxRedemptionPoints: 1000, amountOptions: [100, 500, 1000] }]);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openSheet(user, 'Myntra Gift Card');
    expect(await screen.findByRole('group', { name: /voucher amount/i })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /voucher amount/i })).toBeNull();
    expect(screen.queryByTestId('voucher-amount-band')).toBeNull();
    expect(await screen.findByRole('button', { name: /^₹100, 100 points \(below the minimum\)/ })).toBeDisabled();
    expect(await screen.findByRole('button', { name: /^₹500, 500 points$/ })).toBeEnabled();
    expect(await screen.findByRole('button', { name: /^₹1,000, 1,000 points$/ })).toBeEnabled();
  });
});

describe('VB — brand on the sheet', () => {
  it('VB5: shows the item name and its logo, not "voucher" + the emoji fallback', async () => {
    stub([AMAZON]);
    render(<RewardsPage />);
    const user = userEvent.setup();
    const heading = await openSheet(user, 'Amazon Voucher');
    expect(heading).toHaveTextContent('Amazon Voucher');
    expect(await screen.findByAltText('Amazon Voucher logo')).toHaveAttribute('src', 'https://cdn.example/amazon.png');
    expect(screen.queryByText('Voucher — Any Amount')).toBeNull();
    expect(await screen.findByText('Any amount')).toBeInTheDocument();
  });

  it('VB5b (L5): a broken logo URL falls back to the emoji tile', async () => {
    stub([AMAZON]);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openSheet(user, 'Amazon Voucher');
    fireEvent.error(screen.getByAltText('Amazon Voucher logo'));
    expect(screen.queryByAltText('Amazon Voucher logo')).toBeNull();
    expect(screen.getByTestId('voucher-sheet-name')).toHaveTextContent('Amazon Voucher');
  });

  it('VB6: an item with no image falls back to the emoji tile (and still shows its name)', async () => {
    stub([{ ...AMAZON, imageUrls: [] }]);
    render(<RewardsPage />);
    const user = userEvent.setup();
    const heading = await openSheet(user, 'Amazon Voucher');
    expect(heading).toHaveTextContent('Amazon Voucher');
    expect(screen.queryByAltText('Amazon Voucher logo')).toBeNull();
  });
});

describe('VB — success copy follows the confirm status', () => {
  async function redeem(confirmStatus: string) {
    stub([AMAZON], confirmStatus);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openSheet(user, 'Amazon Voucher');
    await user.type(screen.getByLabelText(/voucher amount/i), '600');
    await user.click(screen.getByRole('button', { name: /send otp/i }));
    await user.type(await screen.findByLabelText('OTP'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    return screen.findByTestId('voucher-success-copy');
  }

  it('VB7: DELIVERED (Hubble instant issue) → "ready — view the code under Orders", with the brand name', async () => {
    const copy = await redeem('DELIVERED');
    expect(copy).toHaveTextContent('Your Amazon Voucher (₹600) is ready — view the code under Orders.');
    expect(copy).not.toHaveTextContent(/being processed/);
    expect(await screen.findByText('Voucher ready')).toBeInTheDocument();
  });

  it('VB8: CONFIRMED (manual / still issuing) → keeps the processing wording, with the brand name', async () => {
    const copy = await redeem('CONFIRMED');
    expect(copy).toHaveTextContent('Your Amazon Voucher (₹600) is being processed. Your voucher code will appear under Orders.');
    expect(await screen.findByText('Voucher confirmed')).toBeInTheDocument();
  });
});

describe('VB — voucherAmountBand (points band → whole-rupee edges, matching the server rounding)', () => {
  it('rate 1: band edges map 1:1; floor wins when higher; no band → floor only', () => {
    expect(voucherAmountBand({ minRedemptionPoints: 500, maxRedemptionPoints: 10_000 }, 250, 1)).toEqual({ min: 500, max: 10_000 });
    expect(voucherAmountBand({ minRedemptionPoints: 100, maxRedemptionPoints: 900 }, 250, 1)).toEqual({ min: 250, max: 900 });
    expect(voucherAmountBand({ minRedemptionPoints: null, maxRedemptionPoints: null }, 250, 1)).toEqual({ min: 250, max: null });
  });

  it('non-integer rates: the ₹ edges are the extreme whole rupees whose round(₹ × rate) is inside the band', () => {
    // rate 1.5, band 500–1000 pts: round(333 × 1.5) = 500 ✓ (332 → 498 ✗); round(666 × 1.5) = 999 ✓ (667 → 1001 ✗)
    expect(voucherAmountBand({ minRedemptionPoints: 500, maxRedemptionPoints: 1000 }, 0, 1.5)).toEqual({ min: 333, max: 666 });
    // rate 3: 167 × 3 = 501 ✓ (166 → 498 ✗)
    expect(voucherAmountBand({ minRedemptionPoints: 500, maxRedemptionPoints: null }, 0, 3)).toEqual({ min: 167, max: null });
    // rate 0.5: round(999 × 0.5) = round(499.5) = 500 ✓ (998 → 499 ✗); round(10001 × 0.5) = 5001 ✗
    expect(voucherAmountBand({ minRedemptionPoints: 500, maxRedemptionPoints: 5000 }, 0, 0.5)).toEqual({ min: 999, max: 10_000 });
  });

  it('unknown rate (0 / NaN) → the floor only, no max (never a divide-by-zero edge)', () => {
    expect(voucherAmountBand({ minRedemptionPoints: 500, maxRedemptionPoints: 1000 }, 250, 0)).toEqual({ min: 250, max: null });
    expect(voucherAmountBand({ minRedemptionPoints: 500, maxRedemptionPoints: 1000 }, 250, Number.NaN)).toEqual({ min: 250, max: null });
  });
});
