/// <reference types="vitest/globals" />
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The two-target KYC SLA client (fetchKycSlaTargets / saveKycSlaTargets).
 *
 * The single `slaTargetHours` (48) client is retired; the two per-tenant targets —
 * `fieldSlaTargetHours` (24) and `gifsySlaTargetHours` (96) — are read from and written
 * to GET/PUT /api/admin/settings. The stage AGE logic (business hours, freeze-at-decision,
 * field-vs-gifsy clock) is covered by kyc-sla-stage.test.ts; this file covers the client:
 * defaulting, 1–168 bounds, and the two-write save.
 */

const get = vi.fn();
const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a) },
}));

import { fetchKycSlaTargets, saveKycSlaTargets } from '@/lib/kyc-sla';
import {
  KYC_FIELD_SLA_KEY,
  KYC_GIFSY_SLA_KEY,
  KYC_FIELD_SLA_DEFAULT,
  KYC_GIFSY_SLA_DEFAULT,
} from '@/lib/kyc-sla-stage';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchKycSlaTargets — reads both targets with defaults + bounds', () => {
  it('returns the stored field/gifsy values when present and in bounds', async () => {
    get.mockResolvedValue({
      success: true,
      data: { settings: { [KYC_FIELD_SLA_KEY]: 12, [KYC_GIFSY_SLA_KEY]: 72 } },
    });
    expect(await fetchKycSlaTargets()).toEqual({ fieldHrs: 12, gifsyHrs: 72 });
  });

  it('coerces numeric strings and still bound-checks', async () => {
    get.mockResolvedValue({
      success: true,
      data: { settings: { [KYC_FIELD_SLA_KEY]: '36', [KYC_GIFSY_SLA_KEY]: '120' } },
    });
    expect(await fetchKycSlaTargets()).toEqual({ fieldHrs: 36, gifsyHrs: 120 });
  });

  it('falls back to defaults (24 / 96) when a value is absent', async () => {
    get.mockResolvedValue({ success: true, data: { settings: {} } });
    expect(await fetchKycSlaTargets()).toEqual({
      fieldHrs: KYC_FIELD_SLA_DEFAULT,
      gifsyHrs: KYC_GIFSY_SLA_DEFAULT,
    });
  });

  it('rejects out-of-bounds (< 1 or > 168) and non-integers, falling back per key', async () => {
    get.mockResolvedValue({
      success: true,
      data: { settings: { [KYC_FIELD_SLA_KEY]: 0, [KYC_GIFSY_SLA_KEY]: 999 } },
    });
    expect(await fetchKycSlaTargets()).toEqual({
      fieldHrs: KYC_FIELD_SLA_DEFAULT,
      gifsyHrs: KYC_GIFSY_SLA_DEFAULT,
    });

    get.mockResolvedValue({
      success: true,
      data: { settings: { [KYC_FIELD_SLA_KEY]: 24.5, [KYC_GIFSY_SLA_KEY]: 'abc' } },
    });
    expect(await fetchKycSlaTargets()).toEqual({
      fieldHrs: KYC_FIELD_SLA_DEFAULT,
      gifsyHrs: KYC_GIFSY_SLA_DEFAULT,
    });
  });

  it('falls back to both defaults when the request fails', async () => {
    get.mockResolvedValue({ success: false, error: 'nope' });
    expect(await fetchKycSlaTargets()).toEqual({
      fieldHrs: KYC_FIELD_SLA_DEFAULT,
      gifsyHrs: KYC_GIFSY_SLA_DEFAULT,
    });
  });
});

describe('saveKycSlaTargets — writes both keys, ANDs the results', () => {
  it('PUTs both keys and returns true when both succeed', async () => {
    put.mockResolvedValue({ success: true });
    const ok = await saveKycSlaTargets({ fieldHrs: 24, gifsyHrs: 96 });
    expect(ok).toBe(true);
    expect(put).toHaveBeenCalledTimes(2);
    const keys = put.mock.calls.map((c) => (c[1] as { key: string; value: number }));
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: KYC_FIELD_SLA_KEY, value: 24 }),
        expect.objectContaining({ key: KYC_GIFSY_SLA_KEY, value: 96 }),
      ]),
    );
  });

  it('returns false if either write fails', async () => {
    put
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: '403' });
    expect(await saveKycSlaTargets({ fieldHrs: 24, gifsyHrs: 96 })).toBe(false);
  });
});
