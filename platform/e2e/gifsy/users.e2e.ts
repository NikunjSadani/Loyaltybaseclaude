import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * S4g / Wave-4 — GIFSY Platform Users (`/gifsy/users`).
 *
 * FE calls GET /api/admin/users (roles: GIFSY_ADMIN, CLIENT_ADMIN).
 * GIFSY_ADMIN sees platform-wide users — GIFSY_ADMIN, CLIENT_ADMIN, MIS_USER.
 * Seed truth (api/prisma/seed.ts): includes the logged-in GIFSY_ADMIN
 * (phone 9830011252) and the deoleo CLIENT_ADMIN (phone 9000000001).
 *
 * Asserts:
 *  1. Page renders without error (no spinner-forever, no error banner).
 *  2. API returns at least one user (real DB hit, not fabricated).
 *  3. Real users from the seed are visible: GIFSY_ADMIN role chip appears.
 *  4. Stat strip — Gifsy Admins count is ≥ 1 (the logged-in operator is seeded).
 *  5. No fabricated data tokens (#40).
 */
test.describe('@gifsy Platform Users (S4g)', () => {
  test('page renders and loads real user data from the API', async ({ page }) => {
    await page.goto('/gifsy/users');
    await expect(page).toHaveURL(/\/gifsy\/users/);
    await expect(page.getByRole('heading', { name: /Platform Users/i })).toBeVisible();

    // Wait for data: spinner must disappear and the table must appear.
    // The FE shows the table only after loading=false and no error.
    await expect(page.getByRole('table')).toBeVisible({ timeout: 10_000 });

    await expectNoFabricatedData(page);
  });

  test('API returns real users — at least one user exists in the DB', async ({ page }) => {
    await page.goto('/gifsy/users');
    const token = await cookieToken(page);
    expect(token, 'gifsy session must be live').toBeTruthy();

    const r = await page.request.get('/api/admin/users', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status(), 'GET /api/admin/users must succeed for GIFSY_ADMIN').toBe(200);

    const body = (await r.json()) as { success: boolean; data?: { users: unknown[] } };
    expect(body.success).toBe(true);
    const users = body.data?.users ?? [];
    expect(users.length, 'at least one user must exist in the DB').toBeGreaterThan(0);
  });

  test('stat strip shows at least one Gifsy Admin (the seeded operator)', async ({ page }) => {
    await page.goto('/gifsy/users');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 10_000 });

    // The stat strip renders a div per role-bucket: locate the one labelled "Gifsy Admins"
    // and assert its number value is ≥ 1 (the logged-in GIFSY_ADMIN is always seeded).
    const giftiesAdminTile = page
      .locator('div', { has: page.getByText('Gifsy Admins', { exact: true }) })
      .last();
    const countText = await giftiesAdminTile.locator('p').first().innerText();
    expect(Number(countText), 'Gifsy Admins stat must be ≥ 1').toBeGreaterThanOrEqual(1);
  });

  test('user table shows the GIFSY_ADMIN role chip for the seeded operator', async ({ page }) => {
    await page.goto('/gifsy/users');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 10_000 });

    // The FE renders a role chip from ROLE_META keyed by role; GIFSY_ADMIN → "Gifsy Admin".
    await expect(page.getByText('Gifsy Admin').first()).toBeVisible();
  });

  test('CLIENT_ADMIN appears in the user list (cross-role read)', async ({ page }) => {
    await page.goto('/gifsy/users');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 10_000 });

    // The seeded deoleo CLIENT_ADMIN (phone 9000000001) must be listed.
    // The "Client Admin" chip from ROLE_META distinguishes this from the GIFSY tier.
    await expect(page.getByText('Client Admin').first()).toBeVisible();
  });
});
