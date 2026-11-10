/// <reference types="vitest/globals" />
/**
 * Client-detail "Behaviour flags" (B2) + "Partner app tabs" (B3) — REAL persistence through the
 * same PATCH /api/gifsy/clients/:slug { features } path as the module toggles.
 *
 * BF1: toggling outletMasterGeo PATCHes ONLY { features: { outletMasterGeo: true } } and flips ON
 * BF2: soDeclarationKyc reflects the stored value; a failed PATCH keeps it and shows the error
 * PA1: partner-app tabs show EFFECTIVE values; the leaderboard switch PATCHes ONLY
 *      { features: { partnerApp: { showLeaderboard: true } } } and the sibling values stay shown
 * PA2: the tab keys no partner screen reads are read-only (no switch offered)
 */

import React, { act } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@/lib/auth-client', () => ({ getToken: () => null }));
vi.mock('@/components/admin/outlet-type-config-section', () => ({
  OutletTypeConfigSection: () => <div data-testid="outlet-type-config-stub" />,
}));

import ClientConfigPage from '../page';

function makeConfig(features: Record<string, unknown>) {
  return {
    slug: 'bajaj',
    internalName: 'Bajaj Consumer Care Ltd',
    status: 'ACTIVE',
    onboardedAt: '2026-10-13',
    branding: {
      displayName: 'Bajaj', primaryColor: '#16a34a', logoUrl: '', faviconUrl: '',
      supportEmail: '', supportPhone: '', productBrands: [],
    },
    features: {
      visibilityInvoiceModule: false, kycApprovalFlow: true, campaignEnrollmentForm: false,
      salesTeamApp: false, walletModule: true, referralModule: false,
      selfEnrollmentAllowed: false, nonKycOutletCampaigns: false, multiLevelApproval: false,
      rbacEnforcement: false, hubbleVoucherEnabled: false,
      outletMasterGeo: false, soDeclarationKyc: false,
      // Effective values as the backend detail projects them (defaults when unset).
      partnerApp: { showSchemes: true, showInvoices: false, showWallet: true, showTeam: true, showLeaderboard: false },
      ...features,
    },
    partnerClasses: [],
    approvalHierarchy: { levels: [], requireGifsyFinalApproval: false },
    notifications: {
      whatsappSenderId: '', smsSenderId: '',
      templateIds: { schemePublished: '', enrollmentConfirm: '', otpVerification: '', kycApproved: '', kycRejected: '', payoutGenerated: '' },
    },
    invoicing: {},
    wallet: { defaultHoldingPeriodDays: 0, pointsExpiryDays: null, minRedemptionAmount: 0, redemptionModes: [], pointsToRupeeRatio: 1 },
  };
}

function mockFetch(config: ReturnType<typeof makeConfig>, patchImpl: (body: Record<string, unknown>) => unknown) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (!init || init.method !== 'PATCH') {
      return Promise.resolve({ status: 200, ok: true, json: async () => ({ success: true, data: config }) });
    }
    return Promise.resolve(patchImpl(JSON.parse(init.body as string)));
  });
}

const params = Promise.resolve({ slug: 'bajaj' });

async function renderPage() {
  await act(async () => {
    render(<ClientConfigPage params={params} />);
    await params;
  });
}

function openSection(title: string) {
  fireEvent.click(screen.getByRole('button', { name: title }));
}

describe('Behaviour flags (B2)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('BF1: toggling outletMasterGeo PATCHes only that key and flips the switch ON', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch(makeConfig({}), (body) => {
      patchSpy(body);
      return { status: 200, ok: true, json: async () => ({ success: true, data: { id: 'bajaj', internalName: 'Bajaj Consumer Care Ltd', status: 'ACTIVE' } }) };
    }));

    await renderPage();
    const row = await screen.findByTestId('behaviour-flag-outletMasterGeo');
    const toggle = within(row).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    // L4: a plain name — state is carried by aria-checked, not baked into the label.
    expect(toggle).toHaveAttribute('aria-label', 'Outlet master Lat/Long + 200 m geo-fence');
    fireEvent.click(toggle);

    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(patchSpy.mock.calls[0][0]).toEqual({ features: { outletMasterGeo: true } });
    await waitFor(() => expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    // The sibling behaviour flag is untouched.
    expect(within(screen.getByTestId('behaviour-flag-soDeclarationKyc')).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('BF2: shows a stored ON value; a failed PATCH keeps it ON and surfaces the error', async () => {
    vi.stubGlobal('fetch', mockFetch(makeConfig({ soDeclarationKyc: true }), () => ({
      status: 403, ok: false, json: async () => ({ success: false, error: 'Forbidden' }),
    })));

    await renderPage();
    const row = await screen.findByTestId('behaviour-flag-soDeclarationKyc');
    expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(row).getByRole('switch'));

    await waitFor(() => expect(screen.getByTestId('behaviour-flags-error')).toBeInTheDocument());
    expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Partner app tabs (B3)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('PA1: the leaderboard switch saves ONLY its own nested key; sibling effective values stay shown', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch(makeConfig({}), (body) => {
      patchSpy(body);
      // A partial server echo (no partnerApp) — the FE must still deep-merge, never drop siblings.
      return { status: 200, ok: true, json: async () => ({ success: true, data: { id: 'bajaj', internalName: 'Bajaj Consumer Care Ltd', status: 'ACTIVE', features: {} } }) };
    }));

    await renderPage();
    openSection('Partner app tabs');
    const row = await screen.findByTestId('partner-app-showLeaderboard');
    expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(within(row).getByRole('switch'));

    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(patchSpy.mock.calls[0][0]).toEqual({ features: { partnerApp: { showLeaderboard: true } } });
    await waitFor(() => expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    // Effective sibling values remain (Wallet default ON, Invoices OFF).
    expect(within(screen.getByTestId('partner-app-showWallet')).getByText('On')).toBeInTheDocument();
    expect(within(screen.getByTestId('partner-app-showInvoices')).getByText('Off')).toBeInTheDocument();
  });

  it('PA2: tab keys no partner screen reads are shown read-only (no switch)', async () => {
    vi.stubGlobal('fetch', mockFetch(makeConfig({}), () => ({ status: 200, ok: true, json: async () => ({ success: true, data: {} }) })));
    await renderPage();
    openSection('Partner app tabs');
    for (const k of ['showSchemes', 'showInvoices', 'showWallet', 'showTeam']) {
      const row = await screen.findByTestId(`partner-app-${k}`);
      expect(within(row).queryByRole('switch')).toBeNull();
    }
  });
});
