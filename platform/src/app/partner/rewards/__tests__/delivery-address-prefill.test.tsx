/// <reference types="vitest/globals" />
/**
 * DAP — the physical-gift delivery form pre-fills from the ACTIVE outlet's address on file
 * (usePartnerIdentity().deliveryDefaults ← GET /partner/me). PLATFORM-WIDE, owner-approved:
 * outlet address only, fill what's on file, one grey hint, never overwrite the partner's typing.
 *
 * Run: npx vitest run src/app/partner/rewards/__tests__/delivery-address-prefill.test.tsx
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, afterEach, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

type Defaults = { line1: string | null; city: string | null; state: string | null; pincode: string | null };
let mockIdentity: {
  businessName: string; ownerName: string; partnerCode: string; outletType: string;
  hasPointsActivity: boolean; hasPayoutActivity: boolean; loyaltyEnabled: boolean;
  deliveryDefaults?: Defaults | null;
};
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => mockIdentity,
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

const FULL: Defaults = { line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' };
const HINT = 'From your outlet address';

function catalog() {
  return {
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: { items: [PLATFORM_GIFT], userBalance: 50_000, pagination: { page: 1, limit: 20, total: 1, pages: 1 } },
    }),
  };
}

// /api/auth/me is the LOGIN's own record (it ignores the outlet switch). Its channelPartner
// carries a DIFFERENT shop's data — none of it may leak into the pre-fill.
function authMe() {
  return {
    ok: true,
    json: () => Promise.resolve({
      success: true,
      data: {
        conversionRate: 1,
        user: {
          name: 'Rajesh Kumar', phone: '9800011111',
          channelPartner: {
            businessName: 'Login Own Shop', addressLine1: '99 Login Lane', city: 'Mumbai',
            state: 'Goa', pincode: '400001',
          },
        },
      },
    }),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  toastError.mockClear();
  mockIdentity = {
    businessName: 'Kumar Store', ownerName: 'Rajesh', partnerCode: 'P1',
    outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: false,
    loyaltyEnabled: true,
  };
  fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/api/auth/me')) return Promise.resolve(authMe());
    if (url.includes('/api/rewards/redeem')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          data: { orderId: 'ord-1', orderNumber: 'DEO-26-000001', requiredPoints: 1500, message: 'OTP sent' },
        }),
      });
    }
    if (url.includes('/api/rewards/catalog')) return Promise.resolve(catalog());
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function openGiftForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByText('Platform Kettle'));
  await user.click(await screen.findByRole('button', { name: /redeem now/i }));
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
function redeemBody() {
  const call = fetchMock.mock.calls.find(([u]) => u === '/api/rewards/redeem');
  return call ? JSON.parse((call[1] as RequestInit).body as string) : null;
}

describe('DAP — delivery address pre-fill from the active outlet', () => {
  it('fills street, city, state and pincode from the outlet address and submits them', async () => {
    mockIdentity.deliveryDefaults = FULL;
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user);

    expect(field('Street address *').value).toBe('12 MG Road');
    expect(field('City *').value).toBe('Pune');
    expect(field('State').value).toBe('Maharashtra');
    expect(field('Pincode *').value).toBe('411001');
    expect(await screen.findByText(HINT)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /send otp/i }));
    await waitFor(() => expect(redeemBody()).not.toBeNull());
    expect(redeemBody().deliveryAddress).toMatchObject({
      address: '12 MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001',
    });
  });

  it('leaves a blank the partner must complete when part of the address is not on file', async () => {
    mockIdentity.deliveryDefaults = { ...FULL, pincode: null };
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user);

    expect(field('Pincode *').value).toBe('');
    expect(field('City *').value).toBe('Pune');

    await user.click(await screen.findByRole('button', { name: /send otp/i }));
    expect(toastError).toHaveBeenCalledWith('Please fill in all required address fields');
    expect(redeemBody()).toBeNull();

    await user.type(field('Pincode *'), '411001');
    await user.click(await screen.findByRole('button', { name: /send otp/i }));
    await waitFor(() => expect(redeemBody()).not.toBeNull());
    expect(redeemBody().deliveryAddress.pincode).toBe('411001');
  });

  it('renders the empty form exactly as today with no hint when nothing is on file', async () => {
    // deliveryDefaults absent from the identity (older backend / no outlet address).
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user);

    for (const label of ['Street address *', 'City *', 'State', 'Pincode *']) {
      expect(field(label).value).toBe('');
    }
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('uses the active outlet address from the identity, never the login record from /api/auth/me', async () => {
    mockIdentity.deliveryDefaults = { line1: '7 Station Rd', city: 'Nashik', state: 'Maharashtra', pincode: '422001' };
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user);
    // Let /api/auth/me settle (recipient name seeded) before asserting nothing from it leaked.
    await waitFor(() => expect(field('Recipient name *').value).toBe('Rajesh Kumar'));

    expect(field('Street address *').value).toBe('7 Station Rd');
    expect(field('City *').value).toBe('Nashik');
    expect(field('Pincode *').value).toBe('422001');
    expect(screen.queryByDisplayValue('99 Login Lane')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('400001')).not.toBeInTheDocument();
  });

  it('submits the partner edit of a pre-filled field', async () => {
    mockIdentity.deliveryDefaults = FULL;
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user);

    await user.clear(field('City *'));
    await user.type(field('City *'), 'Nashik');
    await user.click(await screen.findByRole('button', { name: /send otp/i }));
    await waitFor(() => expect(redeemBody()).not.toBeNull());
    expect(redeemBody().deliveryAddress.city).toBe('Nashik');
  });

  it('never overwrites what the partner typed when the outlet address arrives late', async () => {
    mockIdentity.deliveryDefaults = null;
    const { rerender } = render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user);
    await user.type(field('City *'), 'Mumbai');
    await user.type(field('Street address *'), 'x');
    await user.clear(field('Street address *')); // deliberately cleared → must stay empty

    mockIdentity = { ...mockIdentity, deliveryDefaults: FULL };
    rerender(<RewardsPage />);

    await waitFor(() => expect(field('Pincode *').value).toBe('411001'));
    expect(field('City *').value).toBe('Mumbai');
    expect(field('Street address *').value).toBe('');
    expect(field('State').value).toBe('Maharashtra');
  });

  it('ties the hint to the address inputs as their accessible description', async () => {
    mockIdentity.deliveryDefaults = FULL;
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user);

    for (const label of ['Street address *', 'City *', 'State', 'Pincode *']) {
      expect(field(label)).toHaveAccessibleDescription(HINT);
    }
  });

  it('gives the address inputs no dangling description when there is no hint', async () => {
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user);

    for (const label of ['Street address *', 'City *', 'State', 'Pincode *']) {
      expect(field(label)).not.toHaveAttribute('aria-describedby');
    }
  });

  it('hides the hint once the partner has replaced every pre-filled value', async () => {
    mockIdentity.deliveryDefaults = { line1: null, city: 'Pune', state: null, pincode: null };
    render(<RewardsPage />);
    const user = userEvent.setup();
    await openGiftForm(user);
    expect(await screen.findByText(HINT)).toBeInTheDocument();

    await user.clear(field('City *'));
    await user.type(field('City *'), 'Nashik');
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});
