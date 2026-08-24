/// <reference types="vitest/globals" />
/**
 * CONSENT — vendor-PII consent gate on the member redeem flow (design decision #15).
 *
 * C1: a vendor-sourced physical item (requiresConsent) shows a default-UNTICKED consent
 *     checkbox, and Send OTP stays disabled until it is ticked.
 * C2: once ticked, redeem POSTs /api/rewards/redeem WITH consent:true (BE stamps the version).
 * C3: a PLATFORM item (no requiresConsent) shows NO checkbox and sends NO consent field.
 *
 * Run: npx vitest run src/app/partner/rewards/__tests__/vendor-consent.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => ({
    businessName: 'Kumar Store', ownerName: 'Rajesh', partnerCode: 'P1',
    outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: false,
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

const toastError = vi.fn();
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ error: toastError, success: vi.fn(), info: vi.fn(), toast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import RewardsPage from '../page';

// A VENDOR-sourced physical gift — requiresConsent true (member catalogue hides sourceType).
const VENDOR_GIFT = {
  id: 'vg1',
  name: 'Vendor Blender',
  brand: 'Acme',
  category: 'Home & Kitchen',
  pointsCost: 2000,
  redemptionMode: 'PHYSICAL_GIFT',
  available: true,
  isAffordable: true,
  requiresConsent: true,
};

// A PLATFORM physical gift — the BE explicitly marks it requiresConsent:false (Gifsy-
// fulfilled, no third party) so the fail-closed default does NOT add a consent gate.
const PLATFORM_GIFT = {
  id: 'pg1',
  name: 'Platform Kettle',
  brand: 'Gifsy',
  category: 'Home & Kitchen',
  pointsCost: 1500,
  redemptionMode: 'PHYSICAL_GIFT',
  available: true,
  isAffordable: true,
  requiresConsent: false,
};

// A physical item whose requiresConsent flag is ABSENT (a BE slip). Fail-closed: the
// consent gate must still appear so member PII can't be silently shared.
const CONSENT_ABSENT_PHYSICAL = {
  id: 'pa1',
  name: 'Unflagged Toaster',
  brand: 'Acme',
  category: 'Home & Kitchen',
  pointsCost: 1800,
  redemptionMode: 'PHYSICAL_GIFT',
  available: true,
  isAffordable: true,
  // requiresConsent intentionally omitted
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

function redeemOk() {
  return {
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: { orderId: 'ord-v', orderNumber: 'DEO-26-000001', requiredPoints: 2000, message: 'OTP sent' },
    }),
  };
}

// /api/auth/me carrying the member's real name — seeds the editable "Recipient name".
const MEMBER_NAME = 'Rajesh Kumar';
function meWithName() {
  return {
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: { conversionRate: 1, user: { name: MEMBER_NAME, phone: '9800011111', channelPartner: null } },
    }),
  };
}

beforeEach(() => { toastError.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });

/** Open the physical gift detail sheet → advance to the delivery-address form step. */
async function openGiftForm(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByText(name));
  await user.click(await screen.findByRole('button', { name: /redeem now/i }));
}

async function fillAddress(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('Shop no., street name'), '12 MG Road');
  await user.type(screen.getByPlaceholderText('City'), 'Mumbai');
  await user.type(screen.getByPlaceholderText('400001'), '400001');
}

describe('CONSENT — vendor-PII consent gate', () => {
  it('C1: vendor item shows a default-unticked checkbox; Send OTP is blocked until ticked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/auth/me')) return Promise.resolve(meWithName());
      if (url.includes('/api/rewards/catalog')) return Promise.resolve(catalogWith([VENDOR_GIFT]));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }));
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user, 'Vendor Blender');
    await fillAddress(user);

    const checkbox = screen.getByTestId('vendor-consent-checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    const sendOtp = screen.getByRole('button', { name: /send otp/i });
    expect(sendOtp).toBeDisabled();

    await user.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(sendOtp).not.toBeDisabled();
  });

  it('C2: after consent, redeem POSTs with consent:true and the MEMBER name (not the brand)', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/auth/me')) return Promise.resolve(meWithName());
      if (url.includes('/api/rewards/redeem')) return Promise.resolve(redeemOk());
      if (url.includes('/api/rewards/catalog')) return Promise.resolve(catalogWith([VENDOR_GIFT]));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user, 'Vendor Blender');
    // Recipient name seeded from /api/auth/me — editable but defaulting to the member.
    await waitFor(() =>
      expect((screen.getByLabelText(/recipient name/i) as HTMLInputElement).value).toBe(MEMBER_NAME),
    );
    await fillAddress(user);
    await user.click(screen.getByTestId('vendor-consent-checkbox'));
    await user.click(screen.getByRole('button', { name: /send otp/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => u === '/api/rewards/redeem');
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.consent).toBe(true);
      // The delivery name is the member's real name — NEVER the gift brand ("Acme").
      expect(body.deliveryAddress.name).toBe(MEMBER_NAME);
      expect(body.deliveryAddress.name).not.toBe('Acme');
    });
  });

  it('C3: a platform item (requiresConsent:false) shows NO checkbox and sends NO consent field', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/auth/me')) return Promise.resolve(meWithName());
      if (url.includes('/api/rewards/redeem')) return Promise.resolve(redeemOk());
      if (url.includes('/api/rewards/catalog')) return Promise.resolve(catalogWith([PLATFORM_GIFT]));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user, 'Platform Kettle');
    await fillAddress(user);

    // No consent checkbox for a platform item; Send OTP is enabled immediately.
    expect(screen.queryByTestId('vendor-consent-checkbox')).not.toBeInTheDocument();
    const sendOtp = screen.getByRole('button', { name: /send otp/i });
    expect(sendOtp).not.toBeDisabled();

    await user.click(sendOtp);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => u === '/api/rewards/redeem');
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.consent).toBeUndefined();
    });
  });

  it('C4: FAIL-CLOSED — a physical item with an ABSENT requiresConsent flag still gates on consent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/auth/me')) return Promise.resolve(meWithName());
      if (url.includes('/api/rewards/catalog')) return Promise.resolve(catalogWith([CONSENT_ABSENT_PHYSICAL]));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }));
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user, 'Unflagged Toaster');
    await fillAddress(user);

    // The consent gate must appear (fail-closed) even though the flag was never sent.
    const checkbox = screen.getByTestId('vendor-consent-checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(screen.getByRole('button', { name: /send otp/i })).toBeDisabled();
  });
});
