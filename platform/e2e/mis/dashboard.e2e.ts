import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * MIS_USER dashboard — DATA-VISIBILITY `/admin/dashboard`: read-only view.
 *
 * Seed truth:
 *   MIS_USER = seed-deoleo-mis (phone 9000000004, clientId = deoleo).
 *   Real name: "Deoleo MIS User".
 *   The admin shell reads the real JWT user via getAdminSession() (gap #55 fix —
 *   getAdminSession now reads getStoredUser() before falling back to DEMO_SESSIONS).
 *   Therefore:
 *     - name shown in header must be "Deoleo MIS User" (the JWT name), NOT the
 *       old demo persona "Rahul Agarwal" (CLIENT_ADMIN demo) — a fabricated-data
 *       regression now pinned in FABRICATED_TOKENS.
 *     - role label must be "MIS User" (adminRoleLabel('MIS_USER')), NOT "Client Admin".
 *
 * If either demo value surfaces, that is gap #40 / gap #55 regressing — this test
 * is the canary.
 */
test.describe('@mis dashboard — identity + KPIs', () => {
  test('routes to /admin/dashboard (authed, not bounced to login)', async ({ page }) => {
    await page.goto('/admin/dashboard');
    await expect(page).toHaveURL(/\/admin\/dashboard/);
  });

  test('shows "MIS User" role label — NOT "Client Admin" (gap #55 regression guard)', async ({ page }) => {
    await page.goto('/admin/dashboard');
    // adminRoleLabel('MIS_USER') === 'MIS User' — must be visible in the header user menu.
    // A regression to the DEMO_SESSIONS fallback would show "Client Admin" instead.
    await expect(page.getByText(/MIS User/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('shows the real MIS name "Deoleo MIS User" — NOT the demo persona "Rahul Agarwal"', async ({ page }) => {
    await page.goto('/admin/dashboard');
    // Wait for client-side hydration — useAdminSession fires an effect that reads localStorage.
    // The real JWT name (from getStoredUser) must populate within the timeout.
    await expect(page.getByText('Deoleo MIS User').first()).toBeVisible({ timeout: 10_000 });

    // Belt-and-suspenders: the fabricated persona must be absent (also caught by
    // expectNoFabricatedData below, but explicit here to name the finding clearly).
    const body = await page.locator('body').innerText();
    expect(
      body.includes('Rahul Agarwal'),
      'Demo persona "Rahul Agarwal" must not appear for MIS_USER — gap #55 regression',
    ).toBe(false);
  });

  test('KPI cards show REAL live values, not the loading dash', async ({ page }) => {
    await page.goto('/admin/dashboard');
    // Same check as clientAdmin/dashboard.e2e.ts (#47): the API call to
    // /api/admin/dashboard/kpis is allowed for MIS_USER (@Roles includes MIS_USER).
    // The value cell must resolve to a real integer, not the '—' placeholder.
    const value = page
      .locator('p', { hasText: /^Total Active Partners$/ })
      .locator('xpath=preceding-sibling::p[1]');
    await expect(value).toHaveText(/^\d[\d,]*$/, { timeout: 10_000 });
  });

  test('no fabricated values (#40) — "Rahul Agarwal" pinned in FABRICATED_TOKENS', async ({ page }) => {
    await page.goto('/admin/dashboard');
    // expectNoFabricatedData scans innerText for all tokens in fabricated.ts, which now
    // includes 'Rahul Agarwal'. A MIS login that fell back to the CLIENT_ADMIN demo
    // session would render that name — caught here.
    await expectNoFabricatedData(page);
  });
});
