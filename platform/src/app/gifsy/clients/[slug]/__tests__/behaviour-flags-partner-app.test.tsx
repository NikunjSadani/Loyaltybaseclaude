/// <reference types="vitest/globals" />
/**
 * Client-detail "Behaviour flags" (B2) + "Partner app tabs" (B3) — REAL persistence through the
 * same PATCH /api/gifsy/clients/:slug { features } path as the module toggles.
 *
 * BF1: toggling outletMasterGeo PATCHes ONLY { features: { outletMasterGeo: true } } and flips ON
 * BF2: soDeclarationKyc reflects the stored value; a failed PATCH keeps it and shows the error
 * BF3: allowPayoutWithoutPan renders with its label + help text; switching ON needs a confirm (Cancel
 *      saves nothing), OFF saves immediately; PATCHes ONLY its own key
 * PA1: partner-app tabs show EFFECTIVE values; the leaderboard switch PATCHes ONLY
 *      { features: { partnerApp: { showLeaderboard: true } } } and the sibling values stay shown
 * PA2: the tab keys no partner screen reads are read-only (no switch offered)
 */

import React, { act } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@/lib/auth-client', () => ({ getToken: () => null, getStoredUser: () => null }));
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
      outletMasterGeo: false, soDeclarationKyc: false, allowPayoutWithoutPan: false, gifsyRejectFastTrack: false,
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
    const toggle = await within(row).findByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    // L4: a plain name — state is carried by aria-checked, not baked into the label.
    expect(toggle).toHaveAttribute('aria-label', 'Outlet master Lat/Long + 200 m geo-fence');
    fireEvent.click(toggle);

    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(patchSpy.mock.calls[0][0]).toEqual({ features: { outletMasterGeo: true } });
    await waitFor(() => expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    // The sibling behaviour flag is untouched.
    expect(await within(screen.getByTestId('behaviour-flag-soDeclarationKyc')).findByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('BF2: shows a stored ON value; a failed PATCH keeps it ON and surfaces the error', async () => {
    vi.stubGlobal('fetch', mockFetch(makeConfig({ soDeclarationKyc: true }), () => ({
      status: 403, ok: false, json: async () => ({ success: false, error: 'Forbidden' }),
    })));

    await renderPage();
    const row = await screen.findByTestId('behaviour-flag-soDeclarationKyc');
    expect(await within(row).findByRole('switch')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(row).getByRole('switch'));

    expect(await screen.findByTestId('behaviour-flags-error')).toBeInTheDocument();
    expect(await within(row).findByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Behaviour flags — allowPayoutWithoutPan (BF3)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('BF3: renders label + help text OFF, toggling PATCHes only that key, siblings untouched', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch(makeConfig({ soDeclarationKyc: true }), (body) => {
      patchSpy(body);
      return { status: 200, ok: true, json: async () => ({ success: true, data: { id: 'bajaj', internalName: 'Bajaj Consumer Care Ltd', status: 'ACTIVE' } }) };
    }));

    await renderPage();
    const row = await screen.findByTestId('behaviour-flag-allowPayoutWithoutPan');
    expect(await within(row).findByText('Allow payouts without PAN')).toBeInTheDocument();
    expect(
      within(row).getByText(
        "Partners with no PAN on file can still be paid. They are paid the full amount; the TDS at the no-PAN rate is a company-borne liability shown in the TDS reports as 'NO PAN ON FILE'.",
      ),
    ).toBeInTheDocument();
    const toggle = await within(row).findByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAttribute('aria-label', 'Allow payouts without PAN');
    fireEvent.click(toggle);

    // Switching ON asks first: nothing is saved until the confirm button is pressed.
    const dialog = await screen.findByTestId('behaviour-flag-confirm');
    expect(await screen.findByText('Allow payouts without PAN?')).toBeInTheDocument();
    expect(await within(dialog).findByText(/paid the FULL amount/)).toBeInTheDocument();
    expect(within(dialog).getByText(/batches that haven't been paid yet \(draft, submitted or failed\) will be included the next time/)).toBeInTheDocument();
    expect(await within(dialog).findByText(/company-borne liability/)).toBeInTheDocument();
    expect(patchSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, allow payouts without PAN' }));

    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(patchSpy.mock.calls[0][0]).toEqual({ features: { allowPayoutWithoutPan: true } });
    await waitFor(() => expect(screen.queryByTestId('behaviour-flag-confirm')).not.toBeInTheDocument());
    await waitFor(() => expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    expect(await within(screen.getByTestId('behaviour-flag-soDeclarationKyc')).findByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(await within(screen.getByTestId('behaviour-flag-outletMasterGeo')).findByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('BF3: Cancel on the confirm dialog saves nothing and leaves the switch OFF', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch(makeConfig({}), (body) => {
      patchSpy(body);
      return { status: 200, ok: true, json: async () => ({ success: true, data: {} }) };
    }));
    await renderPage();
    const row = await screen.findByTestId('behaviour-flag-allowPayoutWithoutPan');
    fireEvent.click(within(row).getByRole('switch'));
    const dialog = await screen.findByTestId('behaviour-flag-confirm');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('behaviour-flag-confirm')).not.toBeInTheDocument());
    expect(patchSpy).not.toHaveBeenCalled();
    expect(await within(row).findByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('BF3: other behaviour flags still save immediately with no confirm dialog', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch(makeConfig({}), (body) => {
      patchSpy(body);
      return { status: 200, ok: true, json: async () => ({ success: true, data: {} }) };
    }));
    await renderPage();
    const row = await screen.findByTestId('behaviour-flag-soDeclarationKyc');
    fireEvent.click(within(row).getByRole('switch'));
    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('behaviour-flag-confirm')).not.toBeInTheDocument();
  });

  it('BF3: a stored ON value shows ON; switching OFF PATCHes { allowPayoutWithoutPan: false } with NO confirm', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch(makeConfig({ allowPayoutWithoutPan: true }), (body) => {
      patchSpy(body);
      return { status: 200, ok: true, json: async () => ({ success: true, data: { id: 'bajaj', internalName: 'Bajaj Consumer Care Ltd', status: 'ACTIVE' } }) };
    }));
    await renderPage();
    const row = await screen.findByTestId('behaviour-flag-allowPayoutWithoutPan');
    expect(await within(row).findByRole('switch')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(row).getByRole('switch'));
    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('behaviour-flag-confirm')).not.toBeInTheDocument();
    expect(patchSpy.mock.calls[0][0]).toEqual({ features: { allowPayoutWithoutPan: false } });
    await waitFor(() => expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
  });
});

describe('Behaviour flags — gifsyRejectFastTrack (BF4)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('BF4: renders label + help text OFF; switching ON asks first (F2 confirm), then PATCHes ONLY its key', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch(makeConfig({ soDeclarationKyc: true }), (body) => {
      patchSpy(body);
      return { status: 200, ok: true, json: async () => ({ success: true, data: { id: 'bajaj', internalName: 'Bajaj Consumer Care Ltd', status: 'ACTIVE' } }) };
    }));

    await renderPage();
    const row = await screen.findByTestId('behaviour-flag-gifsyRejectFastTrack');
    expect(await within(row).findByText('Send GIFSY-rejected KYC resubmissions straight to GIFSY')).toBeInTheDocument();
    expect(
      within(row).getByText(
        'When GIFSY rejects a KYC the managers already approved, the corrected resubmission skips manager approval. SO Declaration KYCs still go through managers.',
      ),
    ).toBeInTheDocument();
    const toggle = await within(row).findByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAttribute('aria-label', 'Send GIFSY-rejected KYC resubmissions straight to GIFSY');
    fireEvent.click(toggle);

    // F2: switching ON asks first — nothing saved until confirmed; the dialog spells out every consequence.
    const dialog = await screen.findByTestId('behaviour-flag-confirm');
    expect(await screen.findByText('Send GIFSY-rejected KYC resubmissions straight to GIFSY?')).toBeInTheDocument();
    for (const point of [
      'Applies to KYCs GIFSY rejected before this was switched on too.',
      "Only outlets' own assigned rep (or their managers) get the shortcut.",
      'Managers are not notified for these KYCs.',
      'Switching it off does not pull back KYCs already sent to GIFSY.',
      'SO Declaration KYCs always go through managers.',
    ]) {
      expect(within(dialog).getByText(point)).toBeInTheDocument();
    }
    expect(patchSpy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, send resubmissions straight to GIFSY' }));

    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('behaviour-flag-confirm')).not.toBeInTheDocument());
    expect(patchSpy.mock.calls[0][0]).toEqual({ features: { gifsyRejectFastTrack: true } });
    await waitFor(() => expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    // Siblings untouched.
    expect(await within(screen.getByTestId('behaviour-flag-soDeclarationKyc')).findByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(await within(screen.getByTestId('behaviour-flag-allowPayoutWithoutPan')).findByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('BF4: Cancel on the confirm saves nothing and leaves the switch OFF', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch(makeConfig({}), (body) => {
      patchSpy(body);
      return { status: 200, ok: true, json: async () => ({ success: true, data: {} }) };
    }));
    await renderPage();
    const row = await screen.findByTestId('behaviour-flag-gifsyRejectFastTrack');
    fireEvent.click(await within(row).findByRole('switch'));
    const dialog = await screen.findByTestId('behaviour-flag-confirm');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('behaviour-flag-confirm')).not.toBeInTheDocument());
    expect(patchSpy).not.toHaveBeenCalled();
    expect(await within(row).findByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('BF4: a stored ON value shows ON; switching OFF PATCHes { gifsyRejectFastTrack: false } with NO confirm', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch(makeConfig({ gifsyRejectFastTrack: true }), (body) => {
      patchSpy(body);
      return { status: 200, ok: true, json: async () => ({ success: true, data: {} }) };
    }));
    await renderPage();
    const row = await screen.findByTestId('behaviour-flag-gifsyRejectFastTrack');
    expect(await within(row).findByRole('switch')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(row).getByRole('switch'));
    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('behaviour-flag-confirm')).not.toBeInTheDocument();
    expect(patchSpy.mock.calls[0][0]).toEqual({ features: { gifsyRejectFastTrack: false } });
    await waitFor(() => expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
  });
});

describe('Partner app tabs (B3)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── requireLocation: DEFAULT ON (owner 2026-11-21); the switch is an explicit emergency off ──
  it('BF5: requireLocation ABSENT → shows ON (no note); switching OFF PATCHes an explicit false with NO confirm + shows the emergency-off note', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch(makeConfig({}), (body) => {
      patchSpy(body);
      return { status: 200, ok: true, json: async () => ({ success: true, data: { id: 'bajaj', internalName: 'Bajaj Consumer Care Ltd', status: 'ACTIVE' } }) };
    }));
    await renderPage();
    const row = await screen.findByTestId('behaviour-flag-requireLocation');
    const toggle = await within(row).findByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('behaviour-flag-requireLocation-note')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('behaviour-flag-confirm')).not.toBeInTheDocument();
    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(patchSpy.mock.calls[0][0]).toEqual({ features: { requireLocation: false } });
    await waitFor(() => expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByTestId('behaviour-flag-requireLocation-note').textContent).toBe(
      'Emergency off — KYC and visibility photos can then be submitted without a phone location (no location check for them)',
    );
  });

  it('BF5: requireLocation stored false → shows OFF + note; switching ON asks first, then PATCHes true', async () => {
    const patchSpy = vi.fn();
    vi.stubGlobal('fetch', mockFetch(makeConfig({ requireLocation: false }), (body) => {
      patchSpy(body);
      return { status: 200, ok: true, json: async () => ({ success: true, data: { id: 'bajaj', internalName: 'Bajaj Consumer Care Ltd', status: 'ACTIVE' } }) };
    }));
    await renderPage();
    const row = await screen.findByTestId('behaviour-flag-requireLocation');
    expect(await within(row).findByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('behaviour-flag-requireLocation-note')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('switch'));
    fireEvent.click(within(await screen.findByTestId('behaviour-flag-confirm')).getByRole('button', { name: 'Yes, require location' }));
    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(patchSpy.mock.calls[0][0]).toEqual({ features: { requireLocation: true } });
    await waitFor(() => expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
  });

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
    expect(await within(row).findByRole('switch')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(within(row).getByRole('switch'));

    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(patchSpy.mock.calls[0][0]).toEqual({ features: { partnerApp: { showLeaderboard: true } } });
    await waitFor(() => expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    // Effective sibling values remain (Wallet default ON, Invoices OFF).
    expect(await within(screen.getByTestId('partner-app-showWallet')).findByText('On')).toBeInTheDocument();
    expect(await within(screen.getByTestId('partner-app-showInvoices')).findByText('Off')).toBeInTheDocument();
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
