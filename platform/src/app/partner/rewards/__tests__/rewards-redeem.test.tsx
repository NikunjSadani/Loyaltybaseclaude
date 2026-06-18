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
