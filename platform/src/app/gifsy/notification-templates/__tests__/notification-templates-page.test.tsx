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
    expect(screen.getByText('KYC submitted')).toBeInTheDocument();
    expect((screen.getByTestId('mode-KYC_SUBMITTED') as HTMLSelectElement).value).toBe('BOTH');
    expect((screen.getByTestId('sms-KYC_SUBMITTED') as HTMLInputElement).value).toBe('111');
    expect((screen.getByTestId('wa-KYC_SUBMITTED') as HTMLInputElement).value).toBe('kyc_submitted_v1');
    // An event absent from the config is still rendered (normalized to OFF/blank).
    expect(screen.getByTestId('row-ORDER_CANCELLED')).toBeInTheDocument();
    expect((screen.getByTestId('mode-ORDER_CANCELLED') as HTMLSelectElement).value).toBe('OFF');
  });

  it('T2: the mode selector updates state', async () => {
    stubFetch();
    render(<GifsyNotificationTemplatesPage />);
    await screen.findByTestId('row-ORDER_DISPATCHED');
    const sel = screen.getByTestId('mode-ORDER_DISPATCHED') as HTMLSelectElement;
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
    const smsInput = screen.getByTestId('sms-KYC_SUBMITTED') as HTMLInputElement;
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
    // All 10 event keys present in the persisted map (normalized), with the edit applied.
    expect(Object.keys(body.events)).toHaveLength(10);
    expect(body.events.ORDER_DISPATCHED.mode).toBe('BOTH');
    expect(body.events.KYC_SUBMITTED.smsTemplateId).toBe('111');
  });

  it('T7: the free-channel chip reflects contracts[event].freeChannels', async () => {
    stubFetch();
    render(<GifsyNotificationTemplatesPage />);
    await screen.findByTestId('row-KYC_SUBMITTED');

    // freeChannels:false → honest "not sent" label, not the false "Always on".
    const suppressed = screen.getByTestId('free-chip-KYC_SUBMITTED');
    expect(suppressed.textContent).toMatch(/not sent for this event/i);
    expect(suppressed.textContent).not.toMatch(/Always on/i);

    // freeChannels omitted → defaults to "Always on".
    expect(screen.getByTestId('free-chip-POINTS_CREDITED').textContent).toMatch(/Always on/i);
    // freeChannels:true → "Always on".
    expect(screen.getByTestId('free-chip-ORDER_DISPATCHED').textContent).toMatch(/Always on/i);
    // No contract at all → defaults to "Always on".
    expect(screen.getByTestId('free-chip-ORDER_CANCELLED').textContent).toMatch(/Always on/i);
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
