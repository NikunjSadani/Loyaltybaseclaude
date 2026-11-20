/// <reference types="vitest/globals" />
/**
 * TDD — Points Summary visibility and content rules (Deoleo tenant)
 *
 * The Points Summary card is now driven by the REAL points-presence signal
 * (identity.hasPointsActivity from /api/partner/me), NOT a hardcoded outlet-type
 * allow-list. A partner who actually holds/earned points sees it; a payout-only
 * partner does not — regardless of outlet type.
 *
 * U1: Points Summary card is shown when the partner has points activity
 * U2: Points Summary card is NOT shown for a payout-only partner (no points activity)
 * U5: Points Summary shows "Redeemable" label
 * U6: Points Summary does NOT show "Available" label
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/components/pwa/PwaAppSettings', () => ({ default: () => null }));
vi.mock('@/lib/api-client', () => ({ api: { get: vi.fn() } }));

// The points summary keys off the REAL points-presence signal. `mockIdentity` is
// mutable so a test can simulate a points-active vs a payout-only partner.
let mockIdentity = {
  businessName: 'Anil Traders', ownerName: 'Anil Traders Owner', partnerCode: 'OUT-2026-000123',
  outletType: 'WHOLESALER' as string | null, hasPointsActivity: true, hasPayoutActivity: false,
};
vi.mock('@/lib/partner-identity', () => ({
  usePartnerIdentity: () => mockIdentity,
}));

import { api } from '@/lib/api-client';
import ProfilePage from '../page';

const ME = {
  success: true,
  data: {
    user: {
      name: 'Anil Traders Owner', phone: '9900000041',
      channelPartner: {
        businessName: 'Anil Traders', partnerCode: 'OUT-2026-000123',
        gstNumber: '27AABCU9603R1ZX', panNumber: 'AABCU9603R', kycStatus: 'APPROVED',
        bankName: 'State Bank of India', bankAccountNumber: '111122223333', ifscCode: 'SBIN0001234', upiId: null,
        wallets: [{ redeemablePoints: 1200, lockedPoints: 0 }],
      },
    },
  },
};

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

async function renderAndLoad() {
  render(<ProfilePage />);
  expect(await screen.findByTestId('profile-header', {}, { timeout: 15_000 })).toBeInTheDocument();
}

/* ─── Tests ──────────────────────────────────────────────────────────────────── */

describe('U — Points Summary rules (real points-presence signal)', () => {
  beforeEach(() => {
    mockIdentity = {
      businessName: 'Anil Traders', ownerName: 'Anil Traders Owner', partnerCode: 'OUT-2026-000123',
      outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: false,
    };
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue(ME);
  });

  // ── Visibility by real points signal ──

  it('U1: Points Summary card is shown when the partner has points activity', async () => {
    mockIdentity = { ...mockIdentity, hasPointsActivity: true };
    await renderAndLoad();
    expect(await screen.findByTestId('points-summary')).toBeInTheDocument();
  });

  it('U2: Points Summary card is NOT shown for a payout-only partner (no points activity)', async () => {
    mockIdentity = { ...mockIdentity, outletType: 'SSS', hasPointsActivity: false, hasPayoutActivity: true };
    await renderAndLoad();
    expect(screen.queryByTestId('points-summary')).not.toBeInTheDocument();
  });

  // ── Content ──

  it('U5: Points Summary shows "Redeemable" label', async () => {
    mockIdentity = { ...mockIdentity, hasPointsActivity: true };
    await renderAndLoad();
    expect(await screen.findByTestId('points-summary')).toHaveTextContent(/redeemable/i);
  });

  it('U6: Points Summary does NOT show "Available" label', async () => {
    mockIdentity = { ...mockIdentity, hasPointsActivity: true };
    await renderAndLoad();
    expect(await screen.findByTestId('points-summary')).not.toHaveTextContent(/available/i);
  });

  it('owner decision 2 (2026-11-19): a negative balance is shown as it is, with the note', async () => {
    const neg = JSON.parse(JSON.stringify(ME));
    neg.data.user.channelPartner.wallets = [{ redeemablePoints: -2986, lockedPoints: 0 }];
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue(neg);
    await renderAndLoad();
    expect((await screen.findByTestId('profile-redeemable')).textContent).toBe('−2,986');
    expect(screen.getByTestId('profile-negative-note').textContent).toBe("You owe 2,986 pts — it's repaid from your next earnings.");
  });

  it('fix round 4 item 6: the profile reads the same signal as the wallet page — "from a reversed credit" when /api/wallet says so', async () => {
    const neg = JSON.parse(JSON.stringify(ME));
    neg.data.user.channelPartner.wallets = [{ redeemablePoints: -2986, lockedPoints: 0 }];
    (api.get as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) =>
      url === '/api/wallet' ? { success: true, data: { owedFromReversal: true } } : neg,
    );
    await renderAndLoad();
    await vi.waitFor(() =>
      expect(screen.getByTestId('profile-negative-note').textContent).toBe(
        "You owe 2,986 pts from a reversed credit — it's repaid from your next earnings.",
      ),
    );
  });
});
