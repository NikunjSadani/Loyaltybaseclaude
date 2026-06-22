/// <reference types="vitest/globals" />
/**
 * RR — Partner Rewards page: live catalogue + real redeem→OTP→confirm flow
 *
 * RR1: catalogue is rendered from GET /api/rewards/catalog (no localStorage fallback)
 * RR2: happy path — Send OTP posts /api/rewards/redeem, then Confirm posts
 *      /api/rewards/redeem/confirm and the success screen appears
 * RR3: a 400 from redeem (insufficient / out of range) surfaces the backend message
 * RR4: a 401 from confirm (bad OTP) surfaces the backend message and stays on the sheet
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

// ── Module mocks ──

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

vi.mock('@/lib/partner-session', () => ({
  usePartnerSession: () => ({
    outletId: 'o1', outletType: 'WHOLESALER', firmName: 'Kumar Store',
    partnerName: 'Rajesh', tier: 'Gold', mobile: '9876543210',
    track: 'POINTS', pointsBalance: 50_000, pointsLifetime: 60_000,
    leaderboardRank: 1, leaderboardTotal: 10,
    inrEarnedThisCycle: 0, pendingPayoutInr: 0,
  }),
}));

vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => ({
    pointsConversionRate: 1,
    minBankTransferAmount: 250,
    minVoucherFreeAmount: 250,
    redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
  }),
}));

// Toast: capture error() calls so we can assert on surfaced backend messages.
const toastError = vi.fn();
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn(), toast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import RewardsPage from '../page';

// ── Live catalogue payload (a FIXED voucher = simplest redeem happy path) ──

const FIXED_VOUCHER = {
  id: 'rv1',
  name: 'Amazon Voucher ₹500',
  brand: 'Amazon',
  category: 'Vouchers',
  pointsCost: 500,
  description: 'Redeemable on Amazon.in',
  redemptionMode: 'GIFT_CARD',
  voucherType: 'FIXED',
  fixedAmount: 500,
  available: true,
  isAffordable: true,
};

function catalogResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: { items: [FIXED_VOUCHER], userBalance: 50_000, pagination: { page: 1, limit: 20, total: 1, pages: 1 } },
    }),
  };
}

beforeEach(() => {
  pushMock.mockClear();
  toastError.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The voucher lives under the "Vouchers" tab (default tab is physical). */
async function openVoucherSheet(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /vouchers/i }));
  await user.click(await screen.findByText('Amazon Voucher ₹500'));
}

describe('RR — Rewards live catalogue + redeem flow', () => {
  it('RR1: renders catalogue items from GET /api/rewards/catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/rewards/catalog')) return Promise.resolve(catalogResponse());
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }));
    render(<RewardsPage />);
    const user = userEvent.setup();
    // Switch to the Vouchers tab where this item lives, then assert it rendered
    // from the live catalogue (not any localStorage/demo fallback).
    await user.click(await screen.findByRole('button', { name: /vouchers/i }));
    expect(await screen.findByText('Amazon Voucher ₹500')).toBeInTheDocument();
  });

  it('RR2: happy path — redeem posts both endpoints and reaches the success screen', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/rewards/redeem/confirm')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: { orderId: 'ord-1', status: 'CONFIRMED', message: 'Redemption confirmed' },
          }),
        });
      }
      if (url.includes('/api/rewards/redeem')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: { orderId: 'ord-1', orderNumber: 'RDM-1', requiredPoints: 500, message: 'OTP sent' },
          }),
        });
      }
      return Promise.resolve(catalogResponse());
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RewardsPage />);
    const user = userEvent.setup();

    // Open the voucher sheet (Vouchers tab → item)
    await openVoucherSheet(user);

    // Step 1 — Send OTP → POST /api/rewards/redeem
    await user.click(await screen.findByRole('button', { name: /send otp/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/rewards/redeem', expect.objectContaining({ method: 'POST' })),
    );

    // Step 2 — enter OTP and Confirm → POST /api/rewards/redeem/confirm
    const otpInput = await screen.findByLabelText('OTP');
    await user.type(otpInput, '123456');
    await user.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/rewards/redeem/confirm', expect.objectContaining({ method: 'POST' })),
    );

    // Success screen
    expect(await screen.findByText(/voucher confirmed/i)).toBeInTheDocument();
  });

  it('RR3: a 400 from redeem surfaces the backend error message', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/rewards/redeem')) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ success: false, error: 'Insufficient points. Required: 500, Available: 100' }),
        });
      }
      return Promise.resolve(catalogResponse());
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RewardsPage />);
    const user = userEvent.setup();
    await openVoucherSheet(user);
    await user.click(await screen.findByRole('button', { name: /send otp/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/insufficient points/i)),
    );
  });

  it('RR4: a 401 from confirm (bad OTP) surfaces the message and stays on the sheet', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/rewards/redeem/confirm')) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ success: false, error: 'Invalid or expired OTP' }),
        });
      }
      if (url.includes('/api/rewards/redeem')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: { orderId: 'ord-1', orderNumber: 'RDM-1', requiredPoints: 500, message: 'OTP sent' },
          }),
        });
      }
      return Promise.resolve(catalogResponse());
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RewardsPage />);
    const user = userEvent.setup();
    await openVoucherSheet(user);
    await user.click(await screen.findByRole('button', { name: /send otp/i }));

    const otpInput = await screen.findByLabelText('OTP');
    await user.type(otpInput, '000000');
    await user.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/invalid or expired otp/i)),
    );
    // Still on the redeem sheet (not the success screen)
    expect(screen.queryByText(/voucher confirmed/i)).not.toBeInTheDocument();
  });
});

/* ════════════════════════════════════════════════════════════════════════════
   CASH — Cash Payout tab: real beneficiary + free-amount, no fabricated data
   ════════════════════════════════════════════════════════════════════════════ */

// A FREE_AMOUNT cash catalog item (pointsCost 0 with a min) — the deterministic
// cash item the page should resolve.
const CASH_ITEM = {
  id: 'cash-1',
  name: 'Cash Payout',
  brand: 'Cash',
  category: 'Cash',
  pointsCost: 0,
  redemptionMode: 'BANK_TRANSFER',
  minRedemptionPoints: 500,
  available: true,
  isAffordable: true,
};

function catalogWithCash() {
  return {
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: { items: [CASH_ITEM], userBalance: 50_000, pagination: { page: 1, limit: 20, total: 1, pages: 1 } },
    }),
  };
}

/** /api/auth/me with a real on-file bank beneficiary + conversionRate. */
function meWithBank() {
  return {
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: {
        conversionRate: 1,
        user: {
          channelPartner: {
            bankName: 'Axis Bank',
            bankAccountNumber: '998877665544',
            bankAccountHolder: 'Test Partner',
            ifscCode: 'UTIB0001234',
            upiId: null,
            paymentMode: 'BANK_TRANSFER',
          },
        },
      },
    }),
  };
}

/** /api/auth/me with NO bank/UPI on file. */
function meEmpty() {
  return {
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: {
        conversionRate: 1,
        user: { channelPartner: { bankName: null, bankAccountNumber: null, ifscCode: null, upiId: null } },
      },
    }),
  };
}

describe('CASH — Cash Payout tab (real beneficiary, free-amount)', () => {
  it('CASH1: shows the REAL on-file bank details (never the fabricated HDFC/****3210)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/auth/me')) return Promise.resolve(meWithBank());
      if (url.includes('/api/rewards/catalog')) return Promise.resolve(catalogWithCash());
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }));
    render(<RewardsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /bank transfer/i }));

    // Real beneficiary rendered, masked account — no fabricated literals anywhere.
    expect(await screen.findByText(/axis bank/i)).toBeInTheDocument();
    expect(screen.getByText(/5544/)).toBeInTheDocument();        // last-4 of the real acct
    expect(screen.queryByText(/HDFC/)).not.toBeInTheDocument();
    expect(screen.queryByText(/3210/)).not.toBeInTheDocument();
  });

  it('CASH2: free-amount input renders with the ₹-min derived from the cash item + real rate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/auth/me')) return Promise.resolve(meWithBank());
      if (url.includes('/api/rewards/catalog')) return Promise.resolve(catalogWithCash());
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }));
    render(<RewardsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /bank transfer/i }));
    await user.click(await screen.findByRole('button', { name: /redeem for cash/i }));

    // The free-amount ₹ input is present, and the ₹-min (500 pts ÷ rate 1 = ₹500) is shown.
    expect(await screen.findByLabelText(/payout amount/i)).toBeInTheDocument();
    expect(screen.getByText(/min ₹500/i)).toBeInTheDocument();
  });

  it('CASH3: posts { rewardId, amount } to the redeem endpoint for a cash payout', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/auth/me')) return Promise.resolve(meWithBank());
      if (url.includes('/api/rewards/redeem')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: { orderId: 'ord-c', orderNumber: 'RDM-C', requiredPoints: 500, message: 'OTP sent' },
          }),
        });
      }
      if (url.includes('/api/rewards/catalog')) return Promise.resolve(catalogWithCash());
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RewardsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /bank transfer/i }));
    await user.click(await screen.findByRole('button', { name: /redeem for cash/i }));

    await user.type(await screen.findByLabelText(/payout amount/i), '600');
    await user.click(screen.getByRole('button', { name: /redeem ₹600/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => u === '/api/rewards/redeem');
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toEqual({ rewardId: 'cash-1', amount: 600 });
    });
  });

  it('CASH4: with NO bank/UPI on file, shows the complete-KYC empty-state and hides the form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/auth/me')) return Promise.resolve(meEmpty());
      if (url.includes('/api/rewards/catalog')) return Promise.resolve(catalogWithCash());
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }));
    render(<RewardsPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /bank transfer/i }));

    expect(await screen.findByText(/complete your bank\/upi details in kyc/i)).toBeInTheDocument();
    // No redeem CTA when there's no beneficiary.
    expect(screen.queryByRole('button', { name: /redeem for cash/i })).not.toBeInTheDocument();
  });
});
