/// <reference types="vitest/globals" />
/**
 * GSP — Admin Gifts page "Gifsy Settings" panel saves ONLY the keys it edits.
 *
 * The panel used to PUT its whole mount-time settings snapshot (saveGifsySettings(fullSettings)),
 * which also wrote back the DERIVED uniquenessPolicy (upi forced true while manual UPI entry is
 * on) and a stale salesApp / creditsPayouts / visibilityConfig. It must now send only:
 *   GSP1: channel toggle → { redemptionChannels } alone
 *   GSP2: Save Settings  → { redemptionChannels, pointsConversionRate, minBankTransferAmount,
 *                            minVoucherFreeAmount } alone — never uniquenessPolicy / salesApp
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: 'GIFSY_ADMIN' }) }));

const saveMock = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/gifsy-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gifsy-settings')>();
  return { ...actual, saveGifsySettings: (...a: unknown[]) => saveMock(...a) };
});

import AdminGiftsPage from '../page';
import { hydrateGifsySettings } from '@/lib/gifsy-settings';

const PANEL_KEYS = ['minBankTransferAmount', 'minVoucherFreeAmount', 'pointsConversionRate', 'redemptionChannels'];

beforeEach(() => {
  saveMock.mockClear();
  vi.stubGlobal('fetch', vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) })));
  // Invalid-but-real state: manual UPI entry ON, stored upi OFF → derived upi forced ON.
  hydrateGifsySettings({
    conversionRate: 1, minBankTransferAmount: 250, minVoucherFreeAmount: 250, paceAmberThreshold: 10,
    visibilityEnabled: false, kycGstinRequired: true,
    redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
    salesApp: { ledgerLabel: 'Wallet', upiEnabled: true, upiManualEntry: true },
    outletPrograms: ['A'], outletCategories: ['B'],
    uniquenessPolicy:       { gst: true, phone: true, bank: false, upi: true },
    uniquenessPolicyStored: { gst: true, phone: true, bank: false, upi: false },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('GSP — Gifsy Settings panel saves only its own keys', () => {
  it('GSP1: toggling a redemption channel saves ONLY redemptionChannels', async () => {
    render(<AdminGiftsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^vouchers$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith({
      redemptionChannels: { physicalGifts: true, vouchers: false, bankTransfer: true },
    });
  });

  it('GSP2: Save Settings PUTs only the four panel keys — no uniquenessPolicy / salesApp', async () => {
    render(<AdminGiftsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const payload = saveMock.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(PANEL_KEYS);
    expect(payload).not.toHaveProperty('uniquenessPolicy');
    expect(payload).not.toHaveProperty('salesApp');
    expect(payload.minBankTransferAmount).toBe(250);
  });
});
