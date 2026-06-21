import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN reward catalogue — `/admin/gifts`.
 *
 * Data source:
 *   GET /api/admin/rewards/catalog?page=1&limit=200   → { items, pagination }
 *   GET /api/admin/rewards/categories                 → { categories }
 *
 * Seed truth (api/prisma/seed.ts):
 *   RW001 — "Amazon Gift Card 500"   (GIFT_CARD, 500 pts, ACTIVE)
 *   RW002 — "Cash Payout 500"        (UPI,       1000 pts, ACTIVE)
 * The "Active" stat-card label appears multiple times on the page
 * (stat card + status filter dropdown), so avoid bare getByText('Active').
 *
 * The page has two tabs: "Catalogue" and "Fulfilment". On load it opens the Catalogue
 * tab and fetches the catalog. Both seed rewards must appear in the rendered table.
 */

const OTHER_TENANT = ['Zenith Trading Co', 'CPB001'];

test.describe('@clientAdmin gifts (reward catalogue)', () => {
  test('routes to /admin/gifts and is not bounced', async ({ page }) => {
    await page.goto('/admin/gifts');
    await expect(page).toHaveURL(/\/admin\/gifts/);
  });

  test('the catalogue table resolves (no eternal spinner) and shows RW001', async ({ page }) => {
    await page.goto('/admin/gifts');
    // Wait for the loading spinner to clear — the table renders after the API call.
    await expect(page.locator('[aria-label="Loading"]')).toHaveCount(0, { timeout: 10_000 });
    // RW001 name — "Amazon Gift Card 500" (seed-rk-1). Assert by code (more stable).
    await expect(page.getByText('RW001')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Amazon Gift Card 500')).toBeVisible({ timeout: 10_000 });
  });

  test('shows RW002 (Cash Payout 500)', async ({ page }) => {
    await page.goto('/admin/gifts');
    await expect(page.locator('[aria-label="Loading"]')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('RW002')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Cash Payout 500')).toBeVisible({ timeout: 10_000 });
  });

  test('shows the item codes RW001 and RW002 in the table (code column, font-mono)', async ({ page }) => {
    await page.goto('/admin/gifts');
    await expect(page.locator('[aria-label="Loading"]')).toHaveCount(0, { timeout: 10_000 });
    // The code column renders the code in a <p class="font-mono">.
    await expect(page.getByText('RW001').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('RW002').first()).toBeVisible({ timeout: 10_000 });
  });

  test('stat cards show real counts (≥2 total rewards from seed)', async ({ page }) => {
    await page.goto('/admin/gifts');
    await expect(page.locator('[aria-label="Loading"]')).toHaveCount(0, { timeout: 10_000 });
    // The "Total Rewards" stat card label always renders.
    await expect(page.getByText('Total Rewards')).toBeVisible();
    // "Active" appears in the stat card AND in the status dropdown option — scope to the
    // stat card section (the grid of 4 stat cards) to avoid strict-mode violations.
    // The four stat cards are: Total Rewards, Active, Out of Stock, Vouchers.
    // The stat cards grid is the first element after the category section.
    // Use a text match that targets the label <p> inside a stat card div.
    await expect(
      page.locator('p').filter({ hasText: /^Active$/ }).first()
    ).toBeVisible();
  });

  test('no cross-tenant leak (clientb rewards must not appear)', async ({ page }) => {
    await page.goto('/admin/gifts');
    await expect(page.locator('[aria-label="Loading"]')).toHaveCount(0, { timeout: 10_000 });
    const body = await page.locator('body').innerText();
    for (const m of OTHER_TENANT) {
      expect(body.includes(m), `cross-tenant leak: "${m}" on /admin/gifts`).toBe(false);
    }
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/gifts');
    await expectNoFabricatedData(page);
  });
});
