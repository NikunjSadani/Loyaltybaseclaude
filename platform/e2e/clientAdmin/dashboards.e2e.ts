import { test, expect, type Page } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN aggregate dashboards — the four consolidated pages under
 * /admin/dashboards/*.  Post-consolidation these are:
 *   /admin/dashboards/kyc             — KYC Dashboard
 *   /admin/dashboards/program-health  — Program Health
 *   /admin/dashboards/operations      — Operations Dashboard
 *   /admin/dashboards/finance         — Finance Dashboard
 *
 * The old fake pages (/payments, /redemptions, /engagement) have been DELETED.
 *
 * All four dashboards are REAL: each fetches GET /api/admin/dashboard/* and renders a
 * loading state first, then either the loaded view or an explicit error state — there
 * are NO hardcoded metric constants or fabricated arrays. Because they're real, the
 * no-fabricated-data check (#40) runs for real here (no test.fixme skips).
 *
 * Stable real markers (in-page <h1>, scoped to `main` to dodge the layout-shell
 * heading double-match). The heading renders on BOTH the loaded and error branches
 * (only the brief loading spinner has no h1), so it's the robust marker to wait on:
 *   - KYC Dashboard:         heading "KYC Dashboard"
 *   - Program Health:        heading "Program Health"
 *   - Operations Dashboard:  heading "Operations Dashboard"
 *   - Finance Dashboard:     heading "Finance Dashboard"
 *
 * Numeric values are intentionally NOT asserted — they depend on live tenant data and
 * an empty tenant legitimately shows zeros. expectNoFabricatedData() checks for KNOWN
 * fake tokens, not for zeros.
 */

const OTHER_TENANT = ['Zenith Trading Co', 'CPB001', 'clientb'];

async function assertNoLeak(page: Page): Promise<void> {
  const body = await page.locator('body').innerText();
  for (const m of OTHER_TENANT) {
    expect(body.includes(m), `cross-tenant leak: "${m}" on ${page.url()}`).toBe(false);
  }
}

test.describe('@clientAdmin dashboards — KYC', () => {
  test('renders the KYC Dashboard heading (page mounted, not bounced)', async ({ page }) => {
    await page.goto('/admin/dashboards/kyc');
    await expect(page).toHaveURL(/\/admin\/dashboards\/kyc/);
    // Scope to <main> to avoid the layout-shell heading double-match. The heading
    // appears after the loading spinner resolves (loaded OR error branch).
    await expect(
      page.locator('main').getByRole('heading', { name: 'KYC Dashboard' }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/dashboards/kyc');
    await expect(
      page.locator('main').getByRole('heading', { name: 'KYC Dashboard' }).first()
    ).toBeVisible({ timeout: 10_000 });
    await expectNoFabricatedData(page);
    await assertNoLeak(page);
  });
});

test.describe('@clientAdmin dashboards — Program Health', () => {
  test('renders the Program Health heading (page mounted, not bounced)', async ({ page }) => {
    await page.goto('/admin/dashboards/program-health');
    await expect(page).toHaveURL(/\/admin\/dashboards\/program-health/);
    await expect(
      page.locator('main').getByRole('heading', { name: 'Program Health' }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/dashboards/program-health');
    await expect(
      page.locator('main').getByRole('heading', { name: 'Program Health' }).first()
    ).toBeVisible({ timeout: 10_000 });
    await expectNoFabricatedData(page);
    await assertNoLeak(page);
  });
});

test.describe('@clientAdmin dashboards — Operations', () => {
  test('renders the Operations Dashboard heading (page mounted, not bounced)', async ({ page }) => {
    await page.goto('/admin/dashboards/operations');
    await expect(page).toHaveURL(/\/admin\/dashboards\/operations/);
    await expect(
      page.locator('main').getByRole('heading', { name: 'Operations Dashboard' }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/dashboards/operations');
    await expect(
      page.locator('main').getByRole('heading', { name: 'Operations Dashboard' }).first()
    ).toBeVisible({ timeout: 10_000 });
    await expectNoFabricatedData(page);
    await assertNoLeak(page);
  });
});

test.describe('@clientAdmin dashboards — Finance', () => {
  test('renders the Finance Dashboard heading (page mounted, not bounced)', async ({ page }) => {
    await page.goto('/admin/dashboards/finance');
    await expect(page).toHaveURL(/\/admin\/dashboards\/finance/);
    await expect(
      page.locator('main').getByRole('heading', { name: 'Finance Dashboard' }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/dashboards/finance');
    await expect(
      page.locator('main').getByRole('heading', { name: 'Finance Dashboard' }).first()
    ).toBeVisible({ timeout: 10_000 });
    await expectNoFabricatedData(page);
    await assertNoLeak(page);
  });
});
