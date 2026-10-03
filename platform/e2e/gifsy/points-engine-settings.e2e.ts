import { test, expect } from '@playwright/test';
import { cookieToken, requestAs } from '../helpers/write';

/**
 * Points Compute Engine — per-tenant settings + the GIFSY-only write gate (gifsy → GIFSY_ADMIN).
 *
 * Proves:
 *   1. GET /api/admin/points-engine/settings?clientId=deoleo → enabled:true (seeded pointsEngine flag).
 *   2. PUT {clientId:deoleo, enabled:true, directCreditEnabled:false} then GET → directCreditEnabled:false
 *      (the write persists through the real settings store; polled for the settings-cache bust).
 *   3. A CLIENT_ADMIN CANNOT PUT the flags → 403 (the write is @Roles('GIFSY_ADMIN') only). This is the
 *      money-control gate: a tenant admin can never self-enable in-portal direct crediting.
 * Restores directCreditEnabled:true at the end so the fixture state is unchanged after the run.
 *
 * Backend: api/src/points-engine/points-engine-settings.controller.ts
 *   GET @Roles('GIFSY_ADMIN','CLIENT_ADMIN')   — platform reads any tenant via ?clientId=
 *   PUT @Roles('GIFSY_ADMIN')                  — owner-only; writes via AdminCoreService.upsertSetting
 * FE proxy: /api/admin/* → /v1/admin/* (httpOnly `token` cookie auth).
 */

const CLIENT = 'deoleo';
const SETTINGS = '/api/admin/points-engine/settings';

/** Unwrap the { success, data } TransformInterceptor envelope (or pass a raw body through). */
function unwrap<T>(j: unknown): T {
  return (j && typeof j === 'object' && 'data' in (j as Record<string, unknown>)
    ? (j as { data: T }).data
    : (j as T));
}

test.describe('@gifsy Points Engine settings — GIFSY-only direct-credit gate', () => {
  test('GIFSY reads + toggles tenant flags; CLIENT_ADMIN is forbidden from writing them', async ({
    page,
  }) => {
    await page.goto('/gifsy');
    expect(await cookieToken(page), 'GIFSY_ADMIN must be logged in (storageState)').toBeTruthy();

    // ── 1. Baseline: the engine is enabled for deoleo (seed) ──────────────────────────
    const getRes = await page.request.get(`${SETTINGS}?clientId=${CLIENT}`);
    const getJson = await getRes.json().catch(() => null);
    expect(getRes.status(), `GET settings: ${JSON.stringify(getJson)}`).toBe(200);
    const s0 = unwrap<{ clientId: string; enabled: boolean; directCreditEnabled: boolean }>(getJson);
    expect(s0.clientId, 'GET must echo the requested tenant').toBe(CLIENT);
    expect(s0.enabled, 'deoleo pointsEngine.enabled must be true (seed)').toBe(true);

    try {
      // ── 2. PUT directCreditEnabled=false → GET reflects it (poll for the settings-cache bust) ──
      const putRes = await page.request.put(SETTINGS, {
        data: { clientId: CLIENT, enabled: true, directCreditEnabled: false },
      });
      const putJson = await putRes.json().catch(() => null);
      expect([200, 201], `PUT settings: ${putRes.status()} ${JSON.stringify(putJson)}`).toContain(
        putRes.status(),
      );

      await expect
        .poll(
          async () => {
            const r = await page.request.get(`${SETTINGS}?clientId=${CLIENT}`);
            return unwrap<{ directCreditEnabled: boolean }>(await r.json()).directCreditEnabled;
          },
          { timeout: 10_000, message: 'directCreditEnabled must persist as false after the PUT' },
        )
        .toBe(false);

      // ── 3. A CLIENT_ADMIN must NOT be able to PUT these flags (GIFSY-only) → 403 ──────
      const ca = await requestAs('clientAdmin');
      try {
        const forbid = await ca.put(SETTINGS, {
          data: { clientId: CLIENT, enabled: true, directCreditEnabled: true },
        });
        expect(
          forbid.status(),
          'CLIENT_ADMIN must be forbidden from writing the points-engine settings',
        ).toBe(403);
      } finally {
        await ca.dispose();
      }
    } finally {
      // ── Restore directCreditEnabled=true so the seed fixture state is unchanged. ──
      await page.request.put(SETTINGS, {
        data: { clientId: CLIENT, enabled: true, directCreditEnabled: true },
      });
    }
  });
});
