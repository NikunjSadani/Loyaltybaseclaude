/// <reference types="vitest/globals" />
/**
 * gifsy-settings — a save never persists the DERIVED uniquenessPolicy by accident.
 *
 * The server returns `uniquenessPolicy` (ENFORCED: upi forced true while salesApp.upiManualEntry
 * is on) and `uniquenessPolicyStored` (what was saved). A caller echoing a whole-settings snapshot
 * would PUT the derived value as the stored one. saveGifsySettings must send the STORED policy for
 * an unchanged echo, but an EXPLICIT policy change (a targeted `{ uniquenessPolicy }` save, or an
 * edited value) as-is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const putMock = vi.fn().mockResolvedValue({ success: true, data: {} });
vi.mock('@/lib/api-client', () => ({
  api: {
    put: (...args: unknown[]) => putMock(...args),
    get: vi.fn().mockResolvedValue({ success: true, data: null }),
  },
}));

import { saveGifsySettings, hydrateGifsySettings, getGifsySettings } from '@/lib/gifsy-settings';

const STORED  = { gst: true, phone: true, bank: false, upi: false };
const DERIVED = { gst: true, phone: true, bank: false, upi: true };

function hydrateInvalidState() {
  // Manual UPI entry ON while the STORED upi uniqueness is OFF → derived upi forced ON.
  hydrateGifsySettings({
    conversionRate: 1, minBankTransferAmount: 250, minVoucherFreeAmount: 250, paceAmberThreshold: 10,
    visibilityEnabled: false, kycGstinRequired: true,
    redemptionChannels: { physicalGifts: true, vouchers: true, bankTransfer: true },
    salesApp: { ledgerLabel: 'Wallet', upiEnabled: true, upiManualEntry: true },
    outletPrograms: ['A'], outletCategories: ['B'],
    uniquenessPolicy: DERIVED,
    uniquenessPolicyStored: STORED,
  });
}

const policyPut = () =>
  putMock.mock.calls.find(([, body]) => (body as { key: string }).key === 'uniquenessPolicy')?.[1] as
    | { key: string; value: unknown }
    | undefined;

describe('saveGifsySettings — uniquenessPolicy is saved from the STORED policy', () => {
  beforeEach(() => {
    localStorage.clear();
    putMock.mockClear();
    hydrateInvalidState();
  });

  it('a whole-settings SNAPSHOT echo PUTs the STORED policy, never the derived upi=true', async () => {
    const snapshot = { ...getGifsySettings() };
    expect(snapshot.uniquenessPolicy).toEqual(DERIVED); // the hazard: snapshot carries the derived value
    expect(await saveGifsySettings(snapshot)).toBe(true);
    expect(policyPut()?.value).toEqual(STORED);
    // Cache: stored stays STORED; enforced is re-derived (manual entry still on → upi true).
    expect(getGifsySettings().uniquenessPolicyStored).toEqual(STORED);
    expect(getGifsySettings().uniquenessPolicy).toEqual(DERIVED);
  });

  it('a TARGETED { uniquenessPolicy } save is explicit — sent as-is (U6 recovery: upi ON)', async () => {
    expect(await saveGifsySettings({ uniquenessPolicy: DERIVED })).toBe(true);
    expect(policyPut()?.value).toEqual(DERIVED);
    expect(getGifsySettings().uniquenessPolicyStored).toEqual(DERIVED);
  });

  it('a snapshot whose policy was EDITED (differs from stored + derived) is sent as-is', async () => {
    const edited = { gst: true, phone: false, bank: true, upi: true };
    const snapshot = { ...getGifsySettings(), uniquenessPolicy: edited };
    expect(await saveGifsySettings(snapshot)).toBe(true);
    expect(policyPut()?.value).toEqual(edited);
    expect(getGifsySettings().uniquenessPolicyStored).toEqual(edited);
  });

  it('a save WITHOUT uniquenessPolicy PUTs no policy key at all', async () => {
    expect(await saveGifsySettings({ minBankTransferAmount: 300 })).toBe(true);
    expect(policyPut()).toBeUndefined();
    expect(putMock).toHaveBeenCalledWith('/api/admin/settings', { key: 'minBankTransferAmount', value: 300 });
    expect(getGifsySettings().uniquenessPolicyStored).toEqual(STORED);
  });
});
