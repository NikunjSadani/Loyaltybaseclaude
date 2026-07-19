/// <reference types="vitest/globals" />
/**
 * Client-detail "Wallet Settings" card — REAL money-path persistence via
 * GET/PUT /api/gifsy/clients/:slug/wallet-settings (GIFSY_ADMIN, tenant-targeted).
 * This card replaced the old fake `Client.wallet` blob editor.
 *
 * WS1: expanding the card loads the tenant's real conversion rate / expiry / floors
 * WS2: MONEY GUARD — a BLANK conversion rate is rejected (never coerced to 0) with no PUT
 * WS3: a valid edit PUTs numeric values and reflects the authoritative (snapped) response
 */

import React, { act } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@/lib/auth-client', () => ({ getToken: () => null }));

vi.mock('@/components/admin/outlet-type-config-section', () => ({
  OutletTypeConfigSection: () => <div data-testid="outlet-type-config-stub" />,
}));

import ClientConfigPage from '../page';

const CONFIG = {
  slug: 'onb-co',
  internalName: 'Onboarding Co Pvt Ltd',
  status: 'ACTIVE',
  onboardedAt: '2026-07-01',
  branding: {
    displayName: 'Onboarding Co', primaryColor: '#16a34a', logoUrl: '/logo.png',
    faviconUrl: '/favicon.ico', supportEmail: 'help@onb.co', supportPhone: '9000000000',
    productBrands: ['BrandA'],
  },
  features: {
    visibilityInvoiceModule: false, kycApprovalFlow: true, campaignEnrollmentForm: false,
    salesTeamApp: false, walletModule: false, referralModule: false,
    selfEnrollmentAllowed: false, nonKycOutletCampaigns: false, multiLevelApproval: false,
    rbacEnforcement: false,
    partnerApp: { showSchemes: true, showInvoices: false, showWallet: false, showTeam: false, showLeaderboard: false },
  },
  partnerClasses: [],
  approvalHierarchy: { levels: [], requireGifsyFinalApproval: false },
  notifications: { whatsappSenderId: 'wa1', smsSenderId: 'SMS001', templateIds: { schemePublished: '', enrollmentConfirm: '', otpVerification: '', kycApproved: '', kycRejected: '', payoutGenerated: '' } },
  invoicing: { sellerLegalName: 'Tech Gifsy Solutions Limited', sellerGstin: '', sellerState: '', sellerAddress: '', sellerPan: '', bankName: '', bankAccountNumber: '', bankIfsc: '', bankBranch: '', invoicePrefix: '', sacCode: '' },
  wallet: { defaultHoldingPeriodDays: 0, pointsExpiryDays: null, minRedemptionAmount: 0, redemptionModes: [], pointsToRupeeRatio: 1 },
};

const WALLET = {
  slug: 'onb-co',
  conversionRate: 2,
  pointsExpiryDays: 365,
  minBankTransferAmount: 300,
  minVoucherFreeAmount: 150,
};

const params = Promise.resolve({ slug: 'onb-co' });

/**
 * Build a mock fetch routing by URL + method:
 *   GET  …/wallet-settings → WALLET
 *   PUT  …/wallet-settings → putImpl (defaults to echoing the body as the saved state)
 *   any other GET          → the page-hydration CONFIG
 */
function mockFetch(putImpl?: (url: string, init: RequestInit) => unknown) {
  return vi.fn((url: string, init?: RequestInit) => {
    const isWallet = url.endsWith('/wallet-settings');
    if (isWallet && (!init || init.method === 'GET' || !init.method)) {
      return Promise.resolve({ status: 200, ok: true, json: async () => ({ success: true, data: WALLET }) });
    }
    if (isWallet && init?.method === 'PUT') {
      if (putImpl) return Promise.resolve(putImpl(url, init));
      const body = JSON.parse(init.body as string);
      return Promise.resolve({ status: 200, ok: true, json: async () => ({ success: true, data: { slug: 'onb-co', ...body } }) });
    }
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ success: true, data: CONFIG }) });
  });
}

async function renderPage() {
  await act(async () => {
    render(<ClientConfigPage params={params} />);
    await params;
  });
}

/** Expand the collapsed "Wallet Settings" section so the card mounts + fetches. */
async function openWalletCard() {
  await act(async () => { fireEvent.click(screen.getByText('Wallet Settings')); });
  await screen.findByTestId('wallet-conversion-rate');
}

describe('Wallet settings editor (real GET/PUT money-path persistence)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('WS1: loads the tenant real conversion rate / expiry / floors', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await renderPage();
    await openWalletCard();

    await waitFor(() => {
      expect((screen.getByTestId('wallet-conversion-rate') as HTMLInputElement).value).toBe('2');
    });
    expect((screen.getByTestId('wallet-points-expiry') as HTMLInputElement).value).toBe('365');
    expect((screen.getByTestId('wallet-min-bank') as HTMLInputElement).value).toBe('300');
    expect((screen.getByTestId('wallet-min-voucher') as HTMLInputElement).value).toBe('150');
  });

  it('WS2: MONEY GUARD — a blank conversion rate is rejected with no PUT (never coerced to 0)', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', mockFetch((url, init) => { spy(url, JSON.parse(init.body as string)); return { status: 200, ok: true, json: async () => ({ success: true, data: WALLET }) }; }));
    await renderPage();
    await openWalletCard();

    fireEvent.change(screen.getByTestId('wallet-conversion-rate'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('wallet-settings-save'));

    await waitFor(() => {
      expect(screen.getByTestId('wallet-save-error')).toBeInTheDocument();
    });
    // No PUT fired — a blank rate must not reach the backend as 0.
    expect(spy).not.toHaveBeenCalled();
  });

  it('WS3: a valid edit PUTs numeric values and reflects the saved response', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', mockFetch((url, init) => {
      const body = JSON.parse(init.body as string);
      spy(url, body);
      return { status: 200, ok: true, json: async () => ({ success: true, data: { slug: 'onb-co', ...body } }) };
    }));
    await renderPage();
    await openWalletCard();

    fireEvent.change(screen.getByTestId('wallet-conversion-rate'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByTestId('wallet-settings-save'));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [url, body] = spy.mock.calls[0];
    expect(url).toBe('/api/gifsy/clients/onb-co/wallet-settings');
    expect(body).toEqual({
      conversionRate: 1.5,
      pointsExpiryDays: 365,
      minBankTransferAmount: 300,
      minVoucherFreeAmount: 150,
    });
  });
});
