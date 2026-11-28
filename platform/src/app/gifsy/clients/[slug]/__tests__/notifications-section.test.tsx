/// <reference types="vitest/globals" />
/**
 * Client-detail "Notifications" section — ONE area per client: MSG91 sender IDs + (owner only) the
 * per-trigger notification templates for THIS client (moved from /gifsy/notification-templates
 * 2026-11-28). Collapsible; deep link #notifications; edits :slug via
 * GET/PUT /api/gifsy/clients/:slug/notification-templates with no assume step.
 * Run: npx vitest run "src/app/gifsy/clients/[slug]/__tests__/notifications-section.test.tsx"
 */

import React, { act } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const roleRef: { current: string | null } = { current: 'GIFSY_ADMIN' };
vi.mock('@/lib/auth-client', () => ({
  getToken: () => null,
  getStoredUser: () => (roleRef.current ? { id: 'u1', name: 'Owner', role: roleRef.current, phone: '900' } : null),
}));
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
    rbacEnforcement: false, hubbleVoucherEnabled: false,
    partnerApp: { showSchemes: true, showInvoices: false, showWallet: false, showTeam: false, showLeaderboard: false },
  },
  partnerClasses: [],
  approvalHierarchy: { levels: [], requireGifsyFinalApproval: false },
  notifications: { whatsappSenderId: 'wa-onb', smsSenderId: 'ONBSMS', templateIds: { schemePublished: '', enrollmentConfirm: '', otpVerification: '', kycApproved: '', kycRejected: '', payoutGenerated: '' } },
  invoicing: { sellerLegalName: '', sellerGstin: '', sellerState: '', sellerAddress: '', sellerPan: '', bankName: '', bankAccountNumber: '', bankIfsc: '', bankBranch: '', invoicePrefix: '', sacCode: '' },
  wallet: { defaultHoldingPeriodDays: 0, pointsExpiryDays: null, minRedemptionAmount: 0, redemptionModes: [], pointsToRupeeRatio: 1 },
};

const NT_PAYLOAD = {
  config: { masterSms: false, masterWhatsapp: true, events: { POINTS_CREDITED: { mode: 'WHATSAPP', whatsappTemplate: 'onb_points', smsTemplateId: '' } } },
  contracts: { POINTS_CREDITED: { label: 'Points credited', sms: [], whatsapp: ['ownerName', 'points'] } },
};
const NT_ROUTE = '/api/gifsy/clients/onb-co/notification-templates';

const ok = (data: unknown) => Promise.resolve({ status: 200, ok: true, json: async () => ({ success: true, data }) });

function mockFetch() {
  return vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === NT_ROUTE) return ok(NT_PAYLOAD);
    if (u.endsWith('/ticket-remarks-email')) return ok({ to: [], cc: [], lastChange: null });
    return ok(CONFIG);
  });
}

const params = Promise.resolve({ slug: 'onb-co' });
async function renderPage() {
  await act(async () => {
    render(<ClientConfigPage params={params} />);
    await params;
  });
  await screen.findByRole('heading', { name: 'Onboarding Co' });
}
const sectionButton = () => screen.getByRole('button', { name: 'Notifications' });

beforeEach(() => { roleRef.current = 'GIFSY_ADMIN'; window.location.hash = ''; });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); window.location.hash = ''; });

describe('Client page → Notifications section', () => {
  it('is one collapsible "Notifications" area: collapsed by default, opening shows sender IDs + this client\'s templates', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();
    // The old separate "Notifications (MSG91)" header is gone — one section.
    expect(screen.queryByText('Notifications (MSG91)')).not.toBeInTheDocument();
    expect(screen.queryByTestId('notification-templates-editor')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u) === NT_ROUTE)).toBe(false); // nothing loaded while collapsed

    await act(async () => { fireEvent.click(sectionButton()); });
    expect(screen.getByText('Sender IDs (MSG91)')).toBeInTheDocument();
    expect(screen.getByText('ONBSMS')).toBeInTheDocument();
    expect(await screen.findByTestId('row-POINTS_CREDITED')).toBeInTheDocument();
    expect((screen.getByTestId('wa-POINTS_CREDITED') as HTMLInputElement).value).toBe('onb_points');
    // Read the VIEWED client's config by slug — never the assumed-tenant /api/admin route.
    expect(fetchMock.mock.calls.some(([u]) => String(u) === NT_ROUTE)).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/admin/notification-templates'))).toBe(false);
  });

  it('Save PUTs to /api/gifsy/clients/<slug>/notification-templates', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();
    await act(async () => { fireEvent.click(sectionButton()); });
    await screen.findByTestId('row-POINTS_CREDITED');
    fireEvent.change(screen.getByTestId('wavars-POINTS_CREDITED'), { target: { value: 'points, ownerName' } });
    fireEvent.click(screen.getByTestId('save-btn'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(NT_ROUTE, expect.objectContaining({ method: 'PUT' })));
    const put = fetchMock.mock.calls.find(([u, i]) => String(u) === NT_ROUTE && (i as RequestInit | undefined)?.method === 'PUT');
    const body = JSON.parse((put![1] as RequestInit).body as string);
    expect(body.masterWhatsapp).toBe(true);
    expect(body.events.POINTS_CREDITED.whatsappVariables).toEqual(['points', 'ownerName']);
  });

  it('deep link #notifications opens the section on load', async () => {
    window.location.hash = '#notifications';
    vi.stubGlobal('fetch', mockFetch());
    await renderPage();
    expect(document.getElementById('notifications')).not.toBeNull();
    expect(await screen.findByTestId('row-POINTS_CREDITED')).toBeInTheDocument();
  });

  it('collapsing keeps unsaved template edits; the header shows "Unsaved changes" while dirty', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await renderPage();
    await act(async () => { fireEvent.click(sectionButton()); });
    await screen.findByTestId('row-POINTS_CREDITED');
    expect(screen.queryByTestId('notifications-unsaved')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('wa-POINTS_CREDITED'), { target: { value: 'edited_tpl' } });
    expect(await screen.findByTestId('notifications-unsaved')).toHaveTextContent('Unsaved changes');

    // Collapse (header button now also carries the marker text) and re-open: the edit is still there.
    const header = () => document.querySelector('#notifications > button') as HTMLButtonElement;
    await act(async () => { fireEvent.click(header()); });
    expect(header()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('notifications-unsaved')).toBeInTheDocument(); // visible on the collapsed header
    await act(async () => { fireEvent.click(header()); });
    expect((screen.getByTestId('wa-POINTS_CREDITED') as HTMLInputElement).value).toBe('edited_tpl');
  });

  it('legacy Template IDs are read-only + labelled; saving sender IDs never sends templateIds', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();
    await act(async () => { fireEvent.click(sectionButton()); });
    const legacy = screen.getByTestId('legacy-template-ids');
    expect(legacy).toHaveTextContent('Legacy — not used for sending. Use Notification templates below.');
    expect(legacy.querySelector('input')).toBeNull();

    // Sender-IDs edit mode: still no template-id inputs, and the PATCH carries sender IDs only.
    const block = legacy.parentElement as HTMLElement;
    await act(async () => { fireEvent.click(within(block).getByRole('button', { name: /Edit/ })); });
    expect(screen.getByTestId('legacy-template-ids').querySelector('input')).toBeNull();
    const editBlock = screen.getByTestId('legacy-template-ids').parentElement as HTMLElement;
    const saveBtn = within(editBlock).getByRole('button', { name: 'Save' });
    await act(async () => { fireEvent.click(saveBtn); });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u) === '/api/gifsy/clients/onb-co' && (i as RequestInit | undefined)?.method === 'PATCH')).toBe(true));
    const patch = fetchMock.mock.calls.find(([u, i]) => String(u) === '/api/gifsy/clients/onb-co' && (i as RequestInit | undefined)?.method === 'PATCH');
    const body = JSON.parse((patch![1] as RequestInit).body as string);
    expect(body.notifications).toEqual({ whatsappSenderId: 'wa-onb', smsSenderId: 'ONBSMS' });
  });

  it('sender-ID edits mark the section "Unsaved changes" and arm ONE leave guard (in-app link asks once)', async () => {
    vi.stubGlobal('fetch', mockFetch());
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.spyOn(window.history, 'back').mockImplementation(() => {});
    await renderPage();
    await act(async () => { fireEvent.click(sectionButton()); });
    await screen.findByTestId('row-POINTS_CREDITED');
    const block = screen.getByTestId('legacy-template-ids').parentElement as HTMLElement;
    await act(async () => { fireEvent.click(within(block).getByRole('button', { name: /Edit/ })); });
    expect(screen.queryByTestId('notifications-unsaved')).not.toBeInTheDocument(); // editing alone isn't dirty
    const smsInput = within(screen.getByTestId('legacy-template-ids').parentElement as HTMLElement)
      .getAllByRole('textbox').find((i) => (i as HTMLInputElement).value === 'ONBSMS') as HTMLInputElement;
    fireEvent.change(smsInput, { target: { value: 'NEWSMS' } });
    expect(await screen.findByTestId('notifications-unsaved')).toBeInTheDocument();

    // In-app link (the page's own "back to clients" style link) → ONE confirm with the shared message; Cancel stays.
    const a = document.createElement('a');
    a.href = '/gifsy/clients';
    document.body.appendChild(a);
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    a.dispatchEvent(e);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith('You have unsaved notification changes — leave without saving?');
    expect(e.defaultPrevented).toBe(true);
    a.remove();

    // Reverting the value clears the marker.
    fireEvent.change(smsInput, { target: { value: 'ONBSMS' } });
    await waitFor(() => expect(screen.queryByTestId('notifications-unsaved')).not.toBeInTheDocument());
    vi.restoreAllMocks();
  });

  it('a non-owner sees the sender IDs but NOT the templates editor, and it is never fetched', async () => {
    roleRef.current = null;
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    await renderPage();
    await act(async () => { fireEvent.click(sectionButton()); });
    expect(screen.getByText('ONBSMS')).toBeInTheDocument();
    expect(screen.queryByTestId('client-notification-templates')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u) === NT_ROUTE)).toBe(false);
  });
});
