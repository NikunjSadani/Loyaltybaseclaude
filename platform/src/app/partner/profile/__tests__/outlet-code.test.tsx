/// <reference types="vitest/globals" />
/**
 * Partner profile — renders REAL identity + beneficiary from /auth/me (no mock fallback).
 *
 * P1: "Outlet Code" label is present
 * P2: the real outlet code value is rendered (from the API, not a placeholder)
 * P3: outlet code appears in the profile header card
 * P4: outlet code has monospace styling
 * AF3-1: the REAL bank (from /auth/me) is shown — and the old hardcoded fake bank is NOT
 * AF3-2: the account number is masked (raw number never rendered)
 * AF3-3: none of the retired MOCK_PROFILE fabricated values leak onto the page
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/components/pwa/PwaAppSettings', () => ({ default: () => null }));
vi.mock('@/lib/partner-session', () => ({
  usePartnerSession: () => ({ outletType: 'WHOLESALER' }),
}));
vi.mock('@/lib/api-client', () => ({ api: { get: vi.fn() } }));

import { api } from '@/lib/api-client';
import ProfilePage from '../page';

/* ─── Fixture: a real /auth/me payload (the { success, data } envelope) ───────── */

const ME = {
  success: true,
  data: {
    user: {
      name:  'Anil Traders Owner',
      phone: '9900000041',
      channelPartner: {
        businessName:      'Anil Traders',
        partnerCode:       'OUT-2026-000123',
        gstNumber:         '27AABCU9603R1ZX',
        panNumber:         'AABCU9603R',
        kycStatus:         'APPROVED',
        bankName:          'State Bank of India',
        bankAccountNumber: '111122223333',
        ifscCode:          'SBIN0001234',
        upiId:             null,
        wallets: [{ redeemablePoints: 1200, lockedPoints: 0 }],
      },
    },
  },
};

async function renderAndLoad() {
  render(<ProfilePage />);
  await waitFor(
    () => expect(screen.getByText('Anil Traders')).toBeInTheDocument(),
    { timeout: 2000 },
  );
}

/* ─── Tests ──────────────────────────────────────────────────────────────────── */

describe('Partner Profile — real data, no fabrication', () => {
  beforeEach(() => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue(ME);
  });

  it('P1: "Outlet Code" label is visible', async () => {
    await renderAndLoad();
    expect(screen.getByText(/outlet code/i)).toBeInTheDocument();
  });

  it('P2: the REAL outlet code value is rendered', async () => {
    await renderAndLoad();
    const el = screen.getByTestId('outlet-code-value');
    expect(el.textContent).toBe('OUT-2026-000123');
  });

  it('P3: outlet code is inside the dark profile header card', async () => {
    await renderAndLoad();
    expect(screen.getByTestId('profile-header')).toContainElement(screen.getByTestId('outlet-code-value'));
  });

  it('P4: outlet code element has font-mono class', async () => {
    await renderAndLoad();
    expect(screen.getByTestId('outlet-code-value').className).toMatch(/font-mono/);
  });

  it('AF3-1: shows the REAL bank and NOT the old hardcoded fake bank', async () => {
    await renderAndLoad();
    expect(screen.getByText('State Bank of India')).toBeInTheDocument();
    expect(screen.queryByText('HDFC Bank')).not.toBeInTheDocument();
  });

  it('AF3-2: the account number is masked (raw number never rendered)', async () => {
    await renderAndLoad();
    const acct = screen.getByTestId('bank-account-value');
    expect(acct.textContent).toContain('3333');           // last 4 visible
    expect(screen.queryByText('111122223333')).not.toBeInTheDocument(); // raw never shown
  });

  it('AF3-3: no retired MOCK_PROFILE fabricated values leak onto the page', async () => {
    await renderAndLoad();
    for (const fake of ['Rajesh Kumar', 'Kumar General Store', 'HDFC0001234', '1234567890123456']) {
      expect(screen.queryByText(fake)).not.toBeInTheDocument();
    }
  });
});
