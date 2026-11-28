/// <reference types="vitest/globals" />
/**
 * NotificationTemplatesEditor — the per-client notification-templates editor on
 * Gifsy → Clients → <slug> → Notifications (moved from /gifsy/notification-templates 2026-11-28).
 * It edits the client being VIEWED via GET/PUT /api/gifsy/clients/:slug/notification-templates.
 * Run: npx vitest run src/components/operator/__tests__/notification-templates-editor.test.tsx
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

let mockRole = 'GIFSY_ADMIN';
vi.mock('@/lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-client')>();
  return { ...actual, getStoredUser: () => ({ id: 'u1', name: 'Owner', role: mockRole, phone: '900' }) };
});

import { NotificationTemplatesEditor, UNSAVED_NOTIFICATIONS_MESSAGE } from '../notification-templates-editor';

const CONFIG = {
  masterSms: true,
  masterWhatsapp: true,
  events: {
    KYC_SUBMITTED: { mode: 'BOTH', whatsappTemplate: 'kyc_submitted_v1', smsTemplateId: '111' },
    POINTS_CREDITED: { mode: 'SMS', whatsappTemplate: '', smsTemplateId: '222' },
    ORDER_DISPATCHED: { mode: 'OFF', whatsappTemplate: '', smsTemplateId: '' },
  },
};
const CONTRACTS = {
  KYC_SUBMITTED: { label: 'KYC submitted', sms: ['outletName'], whatsapp: ['outletName', 'date'], freeChannels: false },
  POINTS_CREDITED: { label: 'Points credited', sms: ['points', 'balance'], whatsapp: ['points'] },
  ORDER_DISPATCHED: { label: 'Order dispatched', sms: ['orderId'], whatsapp: ['orderId', 'eta'], freeChannels: true },
};
const PAYLOAD = { config: CONFIG, contracts: CONTRACTS };

const okJson = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) });
const failJson = (status: number, error: string) => Promise.resolve({ ok: false, status, json: () => Promise.resolve({ success: false, error }) });

const ROUTE = '/api/gifsy/clients/bajaj/notification-templates';

function stubFetch(opts: { get?: () => unknown; put?: (init?: RequestInit) => unknown } = {}) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (String(url) === ROUTE && method === 'PUT') return opts.put ? opts.put(init) : okJson(PAYLOAD);
    if (String(url) === ROUTE) return opts.get ? opts.get() : okJson(PAYLOAD);
    return okJson({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const putBody = (fetchMock: ReturnType<typeof stubFetch>) => {
  const call = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PUT');
  return JSON.parse((call![1] as RequestInit).body as string);
};

beforeEach(() => { mockRole = 'GIFSY_ADMIN'; });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('NotificationTemplatesEditor (per client)', () => {
  it('loads the VIEWED client by slug (never the assumed-tenant /api/admin route)', async () => {
    const fetchMock = stubFetch();
    render(<NotificationTemplatesEditor slug="bajaj" />);
    await screen.findByTestId('row-KYC_SUBMITTED');
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).toContain(ROUTE);
    expect(urls.some((u) => u.includes('/api/admin/notification-templates'))).toBe(false);
    expect(screen.getByText('KYC submitted')).toBeInTheDocument();
    expect((screen.getByTestId('mode-KYC_SUBMITTED') as HTMLSelectElement).value).toBe('BOTH');
    expect((screen.getByTestId('sms-KYC_SUBMITTED') as HTMLInputElement).value).toBe('111');
    expect((screen.getByTestId('wa-KYC_SUBMITTED') as HTMLInputElement).value).toBe('kyc_submitted_v1');
    // An event absent from the config still renders (normalised to OFF / blank).
    expect((screen.getByTestId('mode-ORDER_CANCELLED') as HTMLSelectElement).value).toBe('OFF');
  });

  it('encodes the slug in the route', async () => {
    const fetchMock = vi.fn(() => okJson(PAYLOAD));
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationTemplatesEditor slug="a b" />);
    await screen.findByTestId('row-KYC_SUBMITTED');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/gifsy/clients/a%20b/notification-templates');
  });

  it('blank template on a targeted channel warns; master off disables that channel', async () => {
    stubFetch();
    render(<NotificationTemplatesEditor slug="bajaj" />);
    await screen.findByTestId('row-ORDER_DISPATCHED');
    expect(screen.queryByTestId('warnings-ORDER_DISPATCHED')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('mode-ORDER_DISPATCHED'), { target: { value: 'SMS' } });
    expect((await screen.findByTestId('warnings-ORDER_DISPATCHED')).textContent).toMatch(/SMS will be skipped/i);

    const sms = screen.getByTestId('sms-KYC_SUBMITTED') as HTMLInputElement;
    expect(sms).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('master-sms-toggle'));
    expect(sms).toBeDisabled();
    expect(screen.getByTestId('wa-KYC_SUBMITTED')).not.toBeDisabled();
  });

  it('Save PUTs the whole config to the slug route (all events, edits applied, overrides parsed)', async () => {
    const fetchMock = stubFetch();
    render(<NotificationTemplatesEditor slug="bajaj" />);
    await screen.findByTestId('row-KYC_SUBMITTED');
    fireEvent.change(screen.getByTestId('mode-ORDER_DISPATCHED'), { target: { value: 'BOTH' } });
    fireEvent.change(screen.getByTestId('wavars-ORDER_DISPATCHED'), { target: { value: ' eta , orderId ' } });
    fireEvent.click(screen.getByTestId('save-btn'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(ROUTE, expect.objectContaining({ method: 'PUT' })));
    const body = putBody(fetchMock);
    expect(body.masterSms).toBe(true);
    expect(Object.keys(body.events)).toHaveLength(11);
    expect(body.events.ORDER_DISPATCHED.mode).toBe('BOTH');
    expect(body.events.ORDER_DISPATCHED.whatsappVariables).toEqual(['eta', 'orderId']);
    expect('whatsappVariables' in body.events.KYC_SUBMITTED).toBe(false);
    expect('waVarsText' in body.events.KYC_SUBMITTED).toBe(false);
    expect((await screen.findByTestId('nt-save-status')).textContent).toMatch(/saved/i);
  });

  it('a stored invalid override shows BLOCKED and is kept (not dropped) on save', async () => {
    const cfg = {
      ...CONFIG,
      events: {
        ...CONFIG.events,
        POINTS_CREDITED: {
          mode: 'WHATSAPP', whatsappTemplate: 't', smsTemplateId: '',
          whatsappVariables: ['points', 'bogus'],
          whatsappVariablesError: 'Stored events.POINTS_CREDITED.whatsappVariables has unknown variable "bogus".',
        },
      },
    };
    const fetchMock = stubFetch({ get: () => okJson({ config: cfg, contracts: CONTRACTS }), put: () => okJson({ config: cfg, contracts: CONTRACTS }) });
    render(<NotificationTemplatesEditor slug="bajaj" />);
    const msg = await screen.findByTestId('wavars-error-POINTS_CREDITED');
    expect(msg.textContent).toMatch(/BLOCKED/);
    expect(msg.textContent).toMatch(/"bogus"/);
    fireEvent.click(screen.getByTestId('save-btn'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'PUT')).toBe(true));
    const body = putBody(fetchMock);
    expect(body.events.POINTS_CREDITED.whatsappVariables).toEqual(['points', 'bogus']);
    expect('whatsappVariablesError' in body.events.POINTS_CREDITED).toBe(false);
  });

  it('a server 400 on save is shown loudly (role=alert) with the server message; form kept', async () => {
    stubFetch({ put: () => failJson(400, 'events.ORDER_DISPATCHED.whatsappVariables has unknown variable "utr".') });
    render(<NotificationTemplatesEditor slug="bajaj" />);
    await screen.findByTestId('row-ORDER_DISPATCHED');
    fireEvent.change(screen.getByTestId('wavars-ORDER_DISPATCHED'), { target: { value: 'utr' } });
    fireEvent.click(screen.getByTestId('save-btn'));
    const status = await screen.findByTestId('nt-save-status');
    expect(status).toHaveAttribute('role', 'alert');
    expect(status.textContent).toMatch(/Not saved/);
    expect(status.textContent).toMatch(/"utr"/);
    expect((screen.getByTestId('wavars-ORDER_DISPATCHED') as HTMLInputElement).value).toBe('utr');
  });

  it('a 403 on load shows the error with Retry (no editor)', async () => {
    stubFetch({ get: () => failJson(403, 'Access denied. Required: GIFSY_ADMIN.') });
    render(<NotificationTemplatesEditor slug="bajaj" />);
    expect((await screen.findByTestId('nt-load-error')).textContent).toMatch(/Access denied/);
    expect(screen.queryByTestId('row-KYC_SUBMITTED')).not.toBeInTheDocument();
    expect(screen.getByTestId('save-btn')).toBeDisabled();
  });

  it('free-channel chip reflects contracts[event].freeChannels', async () => {
    stubFetch();
    render(<NotificationTemplatesEditor slug="bajaj" />);
    expect((await screen.findByTestId('free-chip-KYC_SUBMITTED')).textContent).toMatch(/not sent for this event/i);
    expect(screen.getByTestId('free-chip-POINTS_CREDITED').textContent).toMatch(/Always on/i);
    expect(screen.getByTestId('free-chip-ORDER_CANCELLED').textContent).toMatch(/Always on/i);
  });

  it('standalone (no onDirtyChange): the editor guards itself — beforeunload + in-app link confirm while dirty', async () => {
    stubFetch();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.spyOn(window.history, 'back').mockImplementation(() => {});
    render(<><NotificationTemplatesEditor slug="bajaj" /><a href="/gifsy/clients" data-testid="nav-link">Clients</a></>);
    await screen.findByTestId('row-KYC_SUBMITTED');
    const unload = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
    expect(unload()).toBe(false);
    fireEvent.change(screen.getByTestId('sms-KYC_SUBMITTED'), { target: { value: '999' } });
    expect(unload()).toBe(true);
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    screen.getByTestId('nav-link').dispatchEvent(e);
    expect(confirmSpy).toHaveBeenCalledWith(UNSAVED_NOTIFICATIONS_MESSAGE);
    expect(e.defaultPrevented).toBe(true);
    vi.restoreAllMocks();
  });

  it('with onDirtyChange the PARENT owns the guard (editor installs none, so no double prompt)', async () => {
    stubFetch();
    render(<NotificationTemplatesEditor slug="bajaj" onDirtyChange={() => {}} />);
    await screen.findByTestId('row-KYC_SUBMITTED');
    fireEvent.change(screen.getByTestId('sms-KYC_SUBMITTED'), { target: { value: '999' } });
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('every control is locked while a save is in flight, and unlocked after', async () => {
    let resolvePut: (v: unknown) => void = () => {};
    stubFetch({ put: () => new Promise((r) => { resolvePut = r; }) });
    render(<NotificationTemplatesEditor slug="bajaj" />);
    await screen.findByTestId('row-KYC_SUBMITTED');
    fireEvent.click(screen.getByTestId('save-btn'));
    await waitFor(() => expect(screen.getByTestId('nt-fields')).toBeDisabled());
    for (const id of ['wavars-ORDER_DISPATCHED', 'mode-ORDER_DISPATCHED', 'sms-KYC_SUBMITTED', 'master-sms-toggle']) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
    await act(async () => { resolvePut(await okJson(PAYLOAD)); });
    await waitFor(() => expect(screen.getByTestId('nt-fields')).not.toBeDisabled());
    expect(screen.getByTestId('wavars-ORDER_DISPATCHED')).not.toBeDisabled();
  });

  it('dirty tracking: reports dirty on edit, clean on revert and after save', async () => {
    stubFetch();
    const onDirty = vi.fn();
    render(<NotificationTemplatesEditor slug="bajaj" onDirtyChange={onDirty} />);
    await screen.findByTestId('row-KYC_SUBMITTED');
    expect(onDirty).toHaveBeenLastCalledWith(false);

    fireEvent.change(screen.getByTestId('sms-KYC_SUBMITTED'), { target: { value: '999' } });
    expect(onDirty).toHaveBeenLastCalledWith(true);

    // Reverting to the loaded value is clean again.
    fireEvent.change(screen.getByTestId('sms-KYC_SUBMITTED'), { target: { value: '111' } });
    expect(onDirty).toHaveBeenLastCalledWith(false);

    fireEvent.change(screen.getByTestId('sms-KYC_SUBMITTED'), { target: { value: '999' } });
    expect(onDirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTestId('save-btn'));
    await screen.findByTestId('nt-save-status');
    await waitFor(() => expect(onDirty).toHaveBeenLastCalledWith(false));
  });

  it('the variable-order override stays EDITABLE while WhatsApp is off (a BLOCKED list can be cleared)', async () => {
    const cfg = {
      masterSms: false, masterWhatsapp: false,
      events: { POINTS_CREDITED: { mode: 'OFF', whatsappTemplate: 't', smsTemplateId: '', whatsappVariables: ['bogus'], whatsappVariablesError: 'unknown variable "bogus".' } },
    };
    const fetchMock = stubFetch({ get: () => okJson({ config: cfg, contracts: CONTRACTS }), put: () => okJson({ config: cfg, contracts: CONTRACTS }) });
    render(<NotificationTemplatesEditor slug="bajaj" />);
    await screen.findByTestId('wavars-error-POINTS_CREDITED');
    expect(screen.getByTestId('wa-POINTS_CREDITED')).toBeDisabled(); // template name still follows the master
    const vars = screen.getByTestId('wavars-POINTS_CREDITED') as HTMLInputElement;
    expect(vars).not.toBeDisabled();
    fireEvent.change(vars, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('save-btn'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'PUT')).toBe(true));
    expect('whatsappVariables' in putBody(fetchMock).events.POINTS_CREDITED).toBe(false); // cleared
  });

  it('variable-order box: placeholder carries NO variable names; default shown as helper text; "Override set: N" chip only when filled', async () => {
    stubFetch();
    render(<NotificationTemplatesEditor slug="bajaj" />);
    await screen.findByTestId('row-ORDER_DISPATCHED');
    const box = screen.getByTestId('wavars-ORDER_DISPATCHED') as HTMLInputElement;
    expect(box.placeholder).toBe('Leave blank for the default order');
    expect(box.placeholder).not.toMatch(/orderId|eta/);
    expect(screen.getByTestId('wavars-default-ORDER_DISPATCHED')).toHaveTextContent('Default: orderId, eta');
    // Empty → explicitly "no override", no chip.
    expect(screen.queryByTestId('wavars-set-ORDER_DISPATCHED')).not.toBeInTheDocument();
    expect(screen.getByTestId('wavars-none-ORDER_DISPATCHED')).toHaveTextContent(/No override/);
    // Typed → chip with the parsed count (blanks/extra commas ignored).
    fireEvent.change(box, { target: { value: 'eta, orderId, ' } });
    expect(screen.getByTestId('wavars-set-ORDER_DISPATCHED')).toHaveTextContent('Override set: 2 variables');
    expect(screen.queryByTestId('wavars-none-ORDER_DISPATCHED')).not.toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'eta' } });
    expect(screen.getByTestId('wavars-set-ORDER_DISPATCHED')).toHaveTextContent('Override set: 1 variable');
    // An event with no contract → honest "no variables" default.
    expect(screen.getByTestId('wavars-default-ORDER_CANCELLED')).toHaveTextContent('Default: no variables');
  });

  it('narrow screens: the top line and each trigger-row header wrap (flex-wrap, shrinkable text)', async () => {
    stubFetch();
    render(<NotificationTemplatesEditor slug="bajaj" />);
    await screen.findByTestId('row-KYC_SUBMITTED');
    expect(screen.getByTestId('nt-top-row').className).toMatch(/flex-wrap/);
    const header = screen.getByTestId('row-header-KYC_SUBMITTED');
    expect(header.className).toMatch(/flex-wrap/);
    expect((header.firstElementChild as HTMLElement).className).toMatch(/min-w-0/);
  });

  it('owner-only guard: a non-GIFSY_ADMIN sees no editor and nothing is fetched', async () => {
    mockRole = 'GIFSY_STAFF';
    const fetchMock = stubFetch();
    render(<NotificationTemplatesEditor slug="bajaj" />);
    expect(await screen.findByTestId('nt-owner-only')).toBeInTheDocument();
    expect(screen.queryByTestId('save-btn')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
