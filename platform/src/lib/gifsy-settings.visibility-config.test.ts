/// <reference types="vitest/globals" />
/**
 * gifsy-settings client contract — visibilityConfig (POSM) key/type
 *
 * The Visibility (POSM) config is a per-tenant nested Gifsy Setting (design D5/D6/D8/D10),
 * mirrored on the FE so the Gifsy settings client can read/write it. This asserts the client
 * CONTRACT (not the settings UI, which is W2):
 *   - DEFAULT_SETTINGS carries the dormant default shape.
 *   - the TypeScript type exposes `visibilityConfig` with the expected sub-fields.
 *   - saveGifsySettings maps the `visibilityConfig` key → the `visibilityConfig` settingKey
 *     and PUTs the WHOLE object (REPLACE-WHOLE), proving the SAVE_KEY_MAP entry exists.
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

import { DEFAULT_SETTINGS, saveGifsySettings } from '@/lib/gifsy-settings';

describe('gifsy-settings visibilityConfig contract', () => {
  beforeEach(() => {
    localStorage.clear();
    putMock.mockClear();
  });

  it('DEFAULT_SETTINGS.visibilityConfig has the dormant default shape', () => {
    expect(DEFAULT_SETTINGS.visibilityConfig).toEqual({
      outletScope:        [],
      frequencyPerMonth:  1,
      allowedSalesLevels: [],
      geoFence:           { enabled: false, radiusMeters: 50 },
    });
  });

  it('the GifsySettings type exposes visibilityConfig with the expected sub-fields', () => {
    // Compile-time contract: this object must be assignable to the type's field shape.
    const cfg: NonNullable<GifsySettings['visibilityConfig']> = {
      outletScope:        ['SSS', 'SSS_TOT'],
      frequencyPerMonth:  4,
      allowedSalesLevels: ['XSR', 'SO', 'ASM'],
      geoFence:           { enabled: true, radiusMeters: 200 },
    };
    expect(cfg.outletScope).toContain('SSS');
    expect(cfg.frequencyPerMonth).toBe(4);
    expect(cfg.geoFence.radiusMeters).toBe(200);
  });

  it('saveGifsySettings maps visibilityConfig → the visibilityConfig settingKey (REPLACE-WHOLE)', async () => {
    const value = {
      outletScope:        ['SSS'],
      frequencyPerMonth:  2,
      allowedSalesLevels: ['XSR'],
      geoFence:           { enabled: true, radiusMeters: 100 },
    };
    const ok = await saveGifsySettings({ visibilityConfig: value });
    expect(ok).toBe(true);
    expect(putMock).toHaveBeenCalledWith('/api/admin/settings', { key: 'visibilityConfig', value });
  });
});
