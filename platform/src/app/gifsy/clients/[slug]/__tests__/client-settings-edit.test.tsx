/// <reference types="vitest/globals" />
/**
 * Client-detail "Client settings" editor — REAL persistence via
 * PATCH /api/gifsy/clients/:slug (GIFSY_ADMIN). Unlike the in-memory-only
 * sections (branding/notifications/invoicing/wallet), saving here hits the
 * backend and merges the returned client into local state.
 *
 * CS1: editing display name + saving PATCHes only the changed field and reflects
 *      the returned status
 * CS2: the one-click "Activate" action (shown while ONBOARDING) PATCHes {status:'ACTIVE'}
 * CS3: a failed PATCH surfaces the error message
 */

import React, { act } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@/lib/auth-client', () => ({ getToken: () => null }));

// The Outlet-type config section fetches on mount and is out of scope here — stub it.
vi.mock('@/components/admin/outlet-type-config-section', () => ({
  OutletTypeConfigSection: () => <div data-testid="outlet-type-config-stub" />,
}));

import ClientConfigPage from '../page';

/** A complete ClientConfig the GET returns for the page to hydrate from. */
const CONFIG = {
  slug: 'onb-co',
  internalName: 'Onboarding Co Pvt Ltd',
  status: 'ONBOARDING',
  onboardedAt: '2026-07-01',
  branding: {
    displayName: 'Onboarding Co',
    primaryColor: '#16a34a',
    logoUrl: '/logo.png',
    faviconUrl: '/favicon.ico',
    supportEmail: 'help@onb.co',
    supportPhone: '9000000000',
    productBrands: ['BrandA'],
  },
  features: {
    visibilityInvoiceModule: false, kycApprovalFlow: true, campaignEnrollmentForm: false,
    salesTeamApp: false, walletModule: false, referralModule: false,
    selfEnrollmentAllowed: false, nonKycOutletCampaigns: false, multiLevelApproval: false,
    rbacEnforcement: false,
    partnerApp: { showSchemes: true, showInvoices: false, showWallet: false, showTeam: false, showLeaderboard: false },
  },
  partnerClasses: [{ key: 'GOLD', displayName: 'Gold', color: '#ffd700', order: 1 }],
  approvalHierarchy: {
    levels: [{ roleKey: 'L1', displayName: 'Sales Officer', shortName: 'SO', canInitiateKyc: true, canApproveKyc: false, canViewAllOutlets: false }],
    requireGifsyFinalApproval: false,
  },
  notifications: {
    whatsappSenderId: 'wa1', smsSenderId: 'SMS001',
    templateIds: {
      schemePublished: 't1', enrollmentConfirm: 't2', otpVerification: 't3',
      kycApproved: 't4', kycRejected: 't5', payoutGenerated: 't6',
    },
  },
  invoicing: {
    sellerLegalName: 'Tech Gifsy Solutions Limited', sellerGstin: 'GSTIN1', sellerState: 'KA',
    sellerAddress: 'addr', sellerPan: 'PAN1', bankName: 'Bank', bankAccountNumber: '123',
    bankIfsc: 'IFSC1', bankBranch: 'branch', invoicePrefix: 'TGSL-ONB', sacCode: 'SAC1',
  },
  wallet: {
    defaultHoldingPeriodDays: 7, pointsExpiryDays: null, minRedemptionAmount: 100,
    redemptionModes: ['UPI'], pointsToRupeeRatio: 1,
  },
};

/** Build a mock fetch: first call = GET config, later calls = PATCH per `patchImpl`. */
function mockFetch(patchImpl: (url: string, init: RequestInit) => unknown) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (!init || init.method !== 'PATCH') {
      return Promise.resolve({ status: 200, ok: true, json: async () => ({ success: true, data: CONFIG }) });
    }
    return Promise.resolve(patchImpl(url, init));
  });
}

const params = Promise.resolve({ slug: 'onb-co' });

/** Render the page and flush its Suspense (async `params`) inside act so the
 *  settings section is mounted before the test queries it. */
async function renderPage() {
  await act(async () => {
    render(<ClientConfigPage params={params} />);
    await params;
  });
}

describe('Client settings editor (real PATCH persistence)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('CS1: editing display name + Save PATCHes the changed field and reflects returned status', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch((url, init) => {
      patchSpy(url, JSON.parse(init.body as string));
      return {
        status: 200, ok: true,
        json: async () => ({
          success: true,
          // FLAT projection — the service returns displayName at the top level, NOT nested
          // under `branding` (reading it nested is the bug this shape guards against).
          data: { id: '1', internalName: CONFIG.internalName, status: 'ONBOARDING', displayName: 'Renamed Co', primaryColor: '#16a34a', supportEmail: 'help@onb.co', supportPhone: '9000000000', invoicePrefix: 'TGSL-ONB' },
        }),
      };
    }));

    await renderPage();
    const input = await screen.findByTestId('display-name-input');
    fireEvent.change(input, { target: { value: 'Renamed Co' } });
    fireEvent.click(screen.getByTestId('client-settings-save'));

    await waitFor(() => expect(patchSpy).toHaveBeenCalled());
    const [url, body] = patchSpy.mock.calls[0];
    expect(url).toBe('/api/gifsy/clients/onb-co');
    // Only the changed field is sent.
    expect(body).toEqual({ displayName: 'Renamed Co' });
    // Local state reflects the returned client.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Renamed Co' })).toBeInTheDocument();
    });
  });

  it('CS2: the Activate action PATCHes {status:"ACTIVE"} and flips the status pill', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch((url, init) => {
      patchSpy(url, JSON.parse(init.body as string));
      return {
        status: 200, ok: true,
        json: async () => ({
          success: true,
          data: { id: '1', internalName: CONFIG.internalName, status: 'ACTIVE', branding: {} },
        }),
      };
    }));

    await renderPage();
    const activateBtn = await screen.findByTestId('activate-client');
    fireEvent.click(activateBtn);

    await waitFor(() => expect(patchSpy).toHaveBeenCalledWith('/api/gifsy/clients/onb-co', { status: 'ACTIVE' }));
    // The ONBOARDING-only Activate banner disappears once active.
    await waitFor(() => {
      expect(screen.queryByTestId('activate-client')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('client-status-pill')).toHaveTextContent('Active');
  });

  it('CS3: a failed PATCH surfaces the error message', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({
      status: 400, ok: false,
      json: async () => ({ success: false, error: 'GSTIN required before activation' }),
    })));

    await renderPage();
    const activateBtn = await screen.findByTestId('activate-client');
    fireEvent.click(activateBtn);

    await waitFor(() => {
      expect(screen.getByTestId('client-save-error')).toHaveTextContent('GSTIN required before activation');
    });
  });
});
