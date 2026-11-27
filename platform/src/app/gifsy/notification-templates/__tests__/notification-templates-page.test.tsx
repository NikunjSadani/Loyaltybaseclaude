/// <reference types="vitest/globals" />
/**
 * Notification Templates — owner-only platform-level editor (/gifsy/notification-templates)
 *
 * T1: renders one row per trigger point from the mocked GET (label + fields)
 * T2: the channel-mode selector updates state
 * T3: a mode that targets a channel with a blank template shows a "will be skipped" warning
 * T4: turning a master toggle off disables that channel's inputs
 * T5: Save PUTs the whole config (masters + full events map) as the expected body
 * T6: the owner-only guard hides the editor for a non-GIFSY_ADMIN role
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mutable role for the mocked session — set per-test before rendering.
let mockRole: string = 'GIFSY_ADMIN';
vi.mock('@/lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-client')>();
  return {
    ...actual,
    getStoredUser: () => ({ id: 'u1', name: 'Owner', role: mockRole, phone: '900' }),
  };
});

import GifsyNotificationTemplatesPage from '../page';

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
  // freeChannels:false → this event suppresses the free in-app/push channels.
  KYC_SUBMITTED: { label: 'KYC submitted', sms: ['outletName'], whatsapp: ['outletName', 'date'], freeChannels: false },
  // freeChannels omitted → treated as true (graceful default during rollout).
  POINTS_CREDITED: { label: 'Points credited', sms: ['points', 'balance'], whatsapp: ['points'] },
  ORDER_DISPATCHED: { label: 'Order dispatched', sms: ['orderId'], whatsapp: ['orderId', 'eta'], freeChannels: true },
};

const PAYLOAD = { config: CONFIG, contracts: CONTRACTS };

function okJson(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) });
}

/** GET returns PAYLOAD; PUT echoes the same PAYLOAD (or a custom handler). */
function stubFetch(putHandler?: (init?: RequestInit) => unknown) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('/api/admin/notification-templates') && method === 'PUT') {
      if (putHandler) return putHandler(init);
      return okJson(PAYLOAD);
    }
    if (u.includes('/api/admin/notification-templates')) return okJson(PAYLOAD);
    return okJson({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => { mockRole = 'GIFSY_ADMIN'; });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Notification Templates page', () => {
  it('T1: renders rows from the mocked GET', async () => {
    stubFetch();
    render(<GifsyNotificationTemplatesPage />);
    // Row for a contract-labelled event, plus fields populated from config.
    await screen.findByTestId('row-KYC_SUBMITTED');
    expect(await screen.findByText('KYC submitted')).toBeInTheDocument();
    expect((await screen.findByTestId('mode-KYC_SUBMITTED') as HTMLSelectElement).value).toBe('BOTH');
    expect((await screen.findByTestId('sms-KYC_SUBMITTED') as HTMLInputElement).value).toBe('111');
    expect((await screen.findByTestId('wa-KYC_SUBMITTED') as HTMLInputElement).value).toBe('kyc_submitted_v1');
    // An event absent from the config is still rendered (normalized to OFF/blank).
    expect(await screen.findByTestId('row-ORDER_CANCELLED')).toBeInTheDocument();
    expect((await screen.findByTestId('mode-ORDER_CANCELLED') as HTMLSelectElement).value).toBe('OFF');
  });

  it('T2: the mode selector updates state', async () => {
    stubFetch();
    render(<GifsyNotificationTemplatesPage />);
    await screen.findByTestId('row-ORDER_DISPATCHED');
    const sel = await screen.findByTestId('mode-ORDER_DISPATCHED') as HTMLSelectElement;
    expect(sel.value).toBe('OFF');
    fireEvent.change(sel, { target: { value: 'WHATSAPP' } });
    expect(sel.value).toBe('WHATSAPP');
  });

  it('T3: mode targets a channel but its template is blank → warning shows', async () => {
    stubFetch();
    render(<GifsyNotificationTemplatesPage />);
    await screen.findByTestId('row-ORDER_DISPATCHED');
    // OFF → no warning yet.
    expect(screen.queryByTestId('warnings-ORDER_DISPATCHED')).not.toBeInTheDocument();
    // Switch to SMS with a blank template ID → "SMS will be skipped".
    fireEvent.change(screen.getByTestId('mode-ORDER_DISPATCHED'), { target: { value: 'SMS' } });
    const warn = await screen.findByTestId('warnings-ORDER_DISPATCHED');
    expect(warn.textContent).toMatch(/SMS will be skipped/i);
  });

  it('T4: turning a master toggle off disables that channel inputs', async () => {
    stubFetch();
    render(<GifsyNotificationTemplatesPage />);
    await screen.findByTestId('row-KYC_SUBMITTED');
    const smsInput = await screen.findByTestId('sms-KYC_SUBMITTED') as HTMLInputElement;
    expect(smsInput).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('master-sms-toggle'));
    expect(smsInput).toBeDisabled();
    // WhatsApp input stays editable — only SMS was turned off.
    expect(screen.getByTestId('wa-KYC_SUBMITTED')).not.toBeDisabled();
  });

  it('T5: Save PUTs the whole config with the expected body', async () => {
    const fetchMock = stubFetch();
    render(<GifsyNotificationTemplatesPage />);
    await screen.findByTestId('row-KYC_SUBMITTED');

    // Make a change so the persisted body reflects edited state.
    fireEvent.change(screen.getByTestId('mode-ORDER_DISPATCHED'), { target: { value: 'BOTH' } });

    fireEvent.click(screen.getByTestId('save-btn'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/notification-templates'),
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(putCall).toBeTruthy();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.masterSms).toBe(true);
    expect(body.masterWhatsapp).toBe(true);
    // All 11 event keys present in the persisted map (normalized), with the edit applied.
    expect(Object.keys(body.events)).toHaveLength(11);
    expect(body.events.VOUCHER_ISSUED).toBeTruthy();
    expect(body.events.ORDER_DISPATCHED.mode).toBe('BOTH');
    expect(body.events.KYC_SUBMITTED.smsTemplateId).toBe('111');
  });

  it('T8: whatsappVariables override round-trips (shown, kept on save) and blank omits the key', async () => {
    const cfg = {
      ...CONFIG,
      events: {
        ...CONFIG.events,
        POINTS_CREDITED: { mode: 'WHATSAPP', whatsappTemplate: 'bajaj_loyalty_points', smsTemplateId: '', whatsappVariables: ['points', 'balance'] },
      },
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      String(url).includes('/api/admin/notification-templates') ? okJson({ config: cfg, contracts: CONTRACTS }) : okJson({}),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<GifsyNotificationTemplatesPage />);
    const input = await screen.findByTestId('wavars-POINTS_CREDITED') as HTMLInputElement;
    expect(input.value).toBe('points, balance');
    // Edit another event's override, leave a third blank.
    fireEvent.change(screen.getByTestId('wavars-ORDER_DISPATCHED'), { target: { value: ' eta , orderId ' } });
    fireEvent.click(screen.getByTestId('save-btn'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'PUT')).toBe(true));
    const putCall = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PUT');
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.events.POINTS_CREDITED.whatsappVariables).toEqual(['points', 'balance']);
    expect(body.events.ORDER_DISPATCHED.whatsappVariables).toEqual(['eta', 'orderId']);
    expect('whatsappVariables' in body.events.KYC_SUBMITTED).toBe(false);
    expect('waVarsText' in body.events.KYC_SUBMITTED).toBe(false);
  });

  it('T9: an invalid STORED override shows a red blocked message and is kept (not dropped) on save', async () => {
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
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      String(url).includes('/api/admin/notification-templates') ? okJson({ config: cfg, contracts: CONTRACTS }) : okJson({}),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<GifsyNotificationTemplatesPage />);
    const msg = await screen.findByTestId('wavars-error-POINTS_CREDITED');
    expect(msg.textContent).toMatch(/BLOCKED/);
    expect(msg.textContent).toMatch(/"bogus"/);
    expect((screen.getByTestId('wavars-POINTS_CREDITED') as HTMLInputElement).value).toBe('points, bogus');
    fireEvent.click(screen.getByTestId('save-btn'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'PUT')).toBe(true));
    const putCall = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PUT');
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body.events.POINTS_CREDITED.whatsappVariables).toEqual(['points', 'bogus']);
    expect('whatsappVariablesError' in body.events.POINTS_CREDITED).toBe(false);
    expect('waVarsError' in body.events.POINTS_CREDITED).toBe(false);
  });

  it('T7: the free-channel chip reflects contracts[event].freeChannels', async () => {
    stubFetch();
    render(<GifsyNotificationTemplatesPage />);
    await screen.findByTestId('row-KYC_SUBMITTED');

    // freeChannels:false → honest "not sent" label, not the false "Always on".
    const suppressed = await screen.findByTestId('free-chip-KYC_SUBMITTED');
    expect(suppressed.textContent).toMatch(/not sent for this event/i);
    expect(suppressed.textContent).not.toMatch(/Always on/i);

    // freeChannels omitted → defaults to "Always on".
    expect((await screen.findByTestId('free-chip-POINTS_CREDITED')).textContent).toMatch(/Always on/i);
    // freeChannels:true → "Always on".
    expect((await screen.findByTestId('free-chip-ORDER_DISPATCHED')).textContent).toMatch(/Always on/i);
    // No contract at all → defaults to "Always on".
    expect((await screen.findByTestId('free-chip-ORDER_CANCELLED')).textContent).toMatch(/Always on/i);
  });

  it('T6: the owner-only guard hides the editor for a non-GIFSY_ADMIN role', async () => {
    mockRole = 'GIFSY_STAFF';
    stubFetch();
    render(<GifsyNotificationTemplatesPage />);
    expect(await screen.findByText('Owner-only')).toBeInTheDocument();
    expect(screen.queryByTestId('row-KYC_SUBMITTED')).not.toBeInTheDocument();
    expect(screen.queryByTestId('save-btn')).not.toBeInTheDocument();
  });
});
