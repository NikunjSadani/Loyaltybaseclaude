/// <reference types="vitest/globals" />
/**
 * gifsy-settings client contract — kycGstinRequired key/type
 *
 * `kycGstinRequired` is a per-tenant Gifsy Setting (backend-enforced) mirrored on the FE so
 * the Gifsy settings client can read/write it. This asserts the client CONTRACT (not the
 * settings UI):
 *   - DEFAULT_SETTINGS carries the default (TRUE — GSTIN compulsory; opt-out).
 *   - the TypeScript type exposes `kycGstinRequired`.
 *   - a server response that OMITS the key reads back as TRUE (default-true mapping), unlike
 *     visibility's default-false.
 *   - saveGifsySettings maps the `kycGstinRequired` key → the `kycGstinRequired` settingKey
 *     and PUTs `{ key: 'kycGstinRequired', value }`, proving the SAVE_KEY_MAP entry exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GifsySettings } from '@/types';

// Mock the API client so saveGifsySettings makes no real network call; capture the PUT payload.
const putMock = vi.fn().mockResolvedValue({ success: true, data: {} });
vi.mock('@/lib/api-client', () => ({
  api: {
    put: (...args: unknown[]) => putMock(...args),
    get: vi.fn().mockResolvedValue({ success: true, data: null }),
  },
}));

import { DEFAULT_SETTINGS, saveGifsySettings, hydrateGifsySettings, getGifsySettings } from '@/lib/gifsy-settings';

describe('gifsy-settings kycGstinRequired contract', () => {
  beforeEach(() => {
    localStorage.clear();
    putMock.mockClear();
  });

  it('DEFAULT_SETTINGS.kycGstinRequired defaults to true (GSTIN compulsory)', () => {
    expect(DEFAULT_SETTINGS.kycGstinRequired).toBe(true);
  });

  it('the GifsySettings type exposes kycGstinRequired', () => {
    // Compile-time contract: this must be assignable to the type's field shape.
    const value: GifsySettings['kycGstinRequired'] = true;
    expect(value).toBe(true);
  });

  it('a server response that omits kycGstinRequired reads back as true (default-true)', () => {
    // Hydrate from a server settings block that OMITS kycGstinRequired — the mapping falls
    // back to the prior/default value, which is TRUE (unlike visibility's default-false).
    hydrateGifsySettings({} as Parameters<typeof hydrateGifsySettings>[0]);
    expect(getGifsySettings().kycGstinRequired).toBe(true);
  });

  it('saveGifsySettings maps kycGstinRequired → the kycGstinRequired settingKey', async () => {
    const ok = await saveGifsySettings({ kycGstinRequired: false });
    expect(ok).toBe(true);
    expect(putMock).toHaveBeenCalledWith('/api/admin/settings', { key: 'kycGstinRequired', value: false });
  });
});
