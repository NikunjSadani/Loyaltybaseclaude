/// <reference types="vitest/globals" />
/**
 * Client-detail "Feature Flags" editor — REAL persistence via
 * PATCH /api/gifsy/clients/:slug (GIFSY_ADMIN + tenancy:write). Each flag is a live
 * toggle; the backend MERGES one key at a time and the page folds the authoritative
 * features blob back into local state.
 *
 * FF1: toggling an OFF flag PATCHes { features: { <key>: true } } and flips the switch on
 * FF2: a failed PATCH leaves the switch OFF and surfaces the error (no optimistic desync)
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
  slug: 'bajaj',
  internalName: 'Bajaj Consumer Care Ltd',
  status: 'ACTIVE',
  onboardedAt: '2026-10-13',
  branding: {
    displayName: 'Bajaj', primaryColor: '#16a34a', logoUrl: '/logo.png', faviconUrl: '/favicon.ico',
    supportEmail: 'help@bajaj.co', supportPhone: '9000000000', productBrands: ['BrandA'],
  },
  features: {
    visibilityInvoiceModule: false, kycApprovalFlow: true, campaignEnrollmentForm: false,
    salesTeamApp: false, walletModule: false, referralModule: false,
    selfEnrollmentAllowed: false, nonKycOutletCampaigns: false, multiLevelApproval: false,
    rbacEnforcement: false, hubbleVoucherEnabled: false,
    partnerApp: { showSchemes: true, showInvoices: false, showWallet: false, showTeam: false, showLeaderboard: false },
  },
  partnerClasses: [{ key: 'GOLD', displayName: 'Gold', color: '#ffd700', order: 1 }],
  approvalHierarchy: {
    levels: [{ roleKey: 'L1', displayName: 'Sales Officer', shortName: 'SO', canInitiateKyc: true, canApproveKyc: false, canViewAllOutlets: false }],
    requireGifsyFinalApproval: false,
  },
  notifications: {
    whatsappSenderId: 'wa1', smsSenderId: 'SMS001',
    templateIds: { schemePublished: 't1', enrollmentConfirm: 't2', otpVerification: 't3', kycApproved: 't4', kycRejected: 't5', payoutGenerated: 't6' },
  },
  invoicing: {
    sellerLegalName: 'Tech Gifsy Solutions Limited', sellerGstin: 'GSTIN1', sellerState: 'KA',
    sellerAddress: 'addr', sellerPan: 'PAN1', bankName: 'Bank', bankAccountNumber: '123',
    bankIfsc: 'IFSC1', bankBranch: 'branch', invoicePrefix: 'TGSL-BJ', sacCode: 'SAC1',
  },
  wallet: { defaultHoldingPeriodDays: 7, pointsExpiryDays: null, minRedemptionAmount: 100, redemptionModes: ['UPI'], pointsToRupeeRatio: 1 },
};

function mockFetch(patchImpl: (url: string, init: RequestInit) => unknown) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (!init || init.method !== 'PATCH') {
      return Promise.resolve({ status: 200, ok: true, json: async () => ({ success: true, data: CONFIG }) });
    }
    return Promise.resolve(patchImpl(url, init));
  });
}

const params = Promise.resolve({ slug: 'bajaj' });

async function renderPage() {
  await act(async () => {
    render(<ClientConfigPage params={params} />);
    await params;
  });
}

describe('Feature Flags editor (real PATCH persistence)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('FF1: toggling Hubble ON PATCHes { features: { hubbleVoucherEnabled: true } } and flips the switch', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch((url, init) => {
      patchSpy(url, JSON.parse(init.body as string));
      return {
        status: 200, ok: true,
        json: async () => ({
          success: true,
          // FAITHFUL to the real backend: the PATCH projection may NOT echo every key.
          // This response deliberately OMITS hubbleVoucherEnabled — the switch must still
          // flip ON because the FE trusts the SUBMITTED patch last (guards the money-path bug).
          data: { id: '1', internalName: CONFIG.internalName, status: 'ACTIVE', features: { visibilityInvoiceModule: false, kycApprovalFlow: true, walletModule: false, salesTeamApp: false, referralModule: false } },
        }),
      };
    }));

    await renderPage();
    const toggle = await screen.findByRole('switch', { name: 'Enable Hubble Voucher Auto-Issue' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);

    await waitFor(() => expect(patchSpy).toHaveBeenCalled());
    const [url, body] = patchSpy.mock.calls[0];
    expect(url).toBe('/api/gifsy/clients/bajaj');
    expect(body).toEqual({ features: { hubbleVoucherEnabled: true } });
    // Switch reflects the persisted state (label flips to "Disable …").
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Disable Hubble Voucher Auto-Issue' })).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('FF2: a failed PATCH leaves the switch OFF and surfaces the error', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({
      status: 400, ok: false,
      json: async () => ({ success: false, error: 'Feature update rejected' }),
    })));

    await renderPage();
    const toggle = await screen.findByRole('switch', { name: 'Enable Hubble Voucher Auto-Issue' });
    fireEvent.click(toggle);

    // The error surfaces INSIDE the Feature Flags section (next to the toggles), not only
    // in the far-away settings banner at the top of the page.
    await waitFor(() => {
      expect(screen.getByTestId('feature-flags-error')).toBeInTheDocument();
    });
    // No optimistic desync — the switch stays OFF because local state never changed.
    expect(screen.getByRole('switch', { name: 'Enable Hubble Voucher Auto-Issue' })).toHaveAttribute('aria-checked', 'false');
  });
});
