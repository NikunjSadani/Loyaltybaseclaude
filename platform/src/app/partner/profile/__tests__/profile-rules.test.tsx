/// <reference types="vitest/globals" />
/**
 * Partner profile page rules (renders real /auth/me data, outlet-type gating via session).
 *
 * Q1: Visibility Invoices shown for SSS
 * Q2: Visibility Invoices shown for SSS_TOT
 * Q3: Visibility Invoices NOT shown for WHOLESALER
 * Q4: Visibility Invoices NOT shown for SUB_STOCKIST
 * Q5: "Change Mobile Number" is absent
 * Q6: "Help & Support" is absent
 * Q7: DPDP / "Your Data" card is absent
 * Q8: GST number is rendered
 * Q9: PAN number is rendered
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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

// Outlet-type gating (Visibility Invoices) + points-presence come from the REAL
// identity signal now (usePartnerIdentity), not the retired demo session. `mockIdentity`
// is mutable so each test can set the outlet type / points signal under test.
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

function setOutletType(type: 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST' | 'SSS_TOT') {
  mockIdentity = { ...mockIdentity, outletType: type };
}

async function renderAndLoad() {
  render(<ProfilePage />);
  await waitFor(
    () => expect(screen.getByTestId('profile-header')).toBeInTheDocument(),
    { timeout: 2000 },
  );
}

describe('Q — Partner profile page rules', () => {
  beforeEach(() => {
    mockIdentity = {
      businessName: 'Anil Traders', ownerName: 'Anil Traders Owner', partnerCode: 'OUT-2026-000123',
      outletType: 'WHOLESALER', hasPointsActivity: true, hasPayoutActivity: false,
    };
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue(ME);
  });

  it('Q1: Visibility Invoices link is shown for SSS', async () => {
    setOutletType('SSS');
    await renderAndLoad();
    expect(screen.getByText(/visibility invoices/i)).toBeInTheDocument();
  });

  it('Q2: Visibility Invoices link is shown for SSS_TOT', async () => {
    setOutletType('SSS_TOT');
    await renderAndLoad();
    expect(screen.getByText(/visibility invoices/i)).toBeInTheDocument();
  });

  it('Q3: Visibility Invoices link is NOT shown for WHOLESALER', async () => {
    setOutletType('WHOLESALER');
    await renderAndLoad();
    expect(screen.queryByText(/visibility invoices/i)).not.toBeInTheDocument();
  });

  it('Q4: Visibility Invoices link is NOT shown for SUB_STOCKIST', async () => {
    setOutletType('SUB_STOCKIST');
    await renderAndLoad();
    expect(screen.queryByText(/visibility invoices/i)).not.toBeInTheDocument();
  });

  it('Q5: "Change Mobile Number" option is absent', async () => {
    await renderAndLoad();
    expect(screen.queryByText(/change mobile/i)).not.toBeInTheDocument();
  });

  it('Q6: "Help & Support" option is absent', async () => {
    await renderAndLoad();
    expect(screen.queryByText(/help.*support|support.*help/i)).not.toBeInTheDocument();
  });

  it('Q7: DPDP "Your Data" card is absent', async () => {
    await renderAndLoad();
    expect(screen.queryByText(/your data/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/dpdp/i)).not.toBeInTheDocument();
  });

  it('Q8: GST number label and value are rendered', async () => {
    await renderAndLoad();
    expect(screen.getByText(/gst/i)).toBeInTheDocument();
    expect(screen.getByTestId('gst-number-value').textContent?.trim().length).toBeGreaterThan(0);
  });

  it('Q9: PAN number label and value are rendered', async () => {
    await renderAndLoad();
    expect(screen.getByText(/pan/i)).toBeInTheDocument();
    expect(screen.getByTestId('pan-number-value').textContent?.trim().length).toBeGreaterThan(0);
  });
});
