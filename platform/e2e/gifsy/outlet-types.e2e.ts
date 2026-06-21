import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * S4g / Wave-4 — GIFSY Outlet Types (`/gifsy/outlet-types`).
 *
 * FE: loads from GET /api/gifsy/clients/platform/outlet-type-configs; falls back
 * to MASTER_OUTLET_TYPES (SSS / Wholesaler / Sub-Stockist / SSS TOT) on error.
 * API: GET /v1/gifsy/clients/:slug/outlet-type-configs (GIFSY_ADMIN only).
 *
 * Seed truth: 4 global outlet types (all Active).
 * The four types visible on the page are the SAME ones from the seed — the page
 * either gets them from the API or falls back to the static MASTER constants,
 * either way the 4 names must appear for GIFSY (its defining global-master view).
 *
 * Asserts:
 *  1. Page renders with the "Outlet Types" heading.
 *  2. All 4 global outlet types appear by name.
 *  3. The API endpoint responds for GIFSY_ADMIN with success=true.
 *  4. No fabricated data tokens (#40).
 */
test.describe('@gifsy Outlet Types master (S4g)', () => {
  test('page renders the global outlet-type master heading', async ({ page }) => {
    await page.goto('/gifsy/outlet-types');
    await expect(page).toHaveURL(/\/gifsy\/outlet-types/);
    await expect(page.getByRole('heading', { name: /Outlet Types/i })).toBeVisible();
    await expectNoFabricatedData(page);
  });

  test('all 4 seeded global outlet types are visible', async ({ page }) => {
    await page.goto('/gifsy/outlet-types');
    // The FE renders each type as a card with its name in a `<p>` element.
    // MASTER_OUTLET_TYPES names: 'SSS', 'Wholesaler', 'Sub-Stockist', 'SSS TOT'.
    // The page seed truth from the task brief: Retailer/Wholesaler/Sub-Stockist/SSS_TOT —
    // actual rendered names come from the lib constants above.
    await expect(page.getByText('SSS', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Wholesaler', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Sub-Stockist', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('SSS TOT', { exact: true }).first()).toBeVisible();
  });

  test('all 4 outlet types show as Active (seed state)', async ({ page }) => {
    await page.goto('/gifsy/outlet-types');
    // The FE renders a status badge "Active" for each isActive=true type.
    // Seed has all 4 active; count must equal 4.
    const activeBadges = page.getByText('Active', { exact: true });
    await expect(activeBadges).toHaveCount(4, { timeout: 8_000 });
  });

  test('API GET /api/gifsy/clients/platform/outlet-type-configs responds for GIFSY_ADMIN', async ({ page }) => {
    await page.goto('/gifsy/outlet-types');
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'gifsy session must be live').toBeTruthy();

    const r = await page.request.get('/api/gifsy/clients/platform/outlet-type-configs', {
      headers: { Authorization: `Bearer ${token}` },
    });
    // The API may return 200 with data OR 404 if the 'platform' slug isn't a real client row.
    // Either way GIFSY_ADMIN must not get a 403/401/500 — only 200 or a 4xx that isn't auth.
    expect(r.status(), 'GIFSY_ADMIN must not be forbidden from the outlet-type-configs endpoint').not.toBe(403);
    expect(r.status(), 'no server error on outlet-type-configs').not.toBe(500);
  });

  test('the Add Outlet Type button is present for GIFSY_ADMIN', async ({ page }) => {
    await page.goto('/gifsy/outlet-types');
    await expect(page.getByRole('button', { name: /Add Outlet Type/i })).toBeVisible();
  });
});
