import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN sales page — `/admin/sales`.
 *
 * Data sources:
 *   GET /api/admin/achievements/batches  → list of upload batches
 *   GET /api/admin/kpis                  → KPI definitions (for column headers)
 *   GET /api/admin/achievements/pace?month=YYYY-MM → pace data
 *
 * Seed truth: EMP001 (SO) has an outlet assignment to O001 / O002. The page primarily
 * shows the upload batch history and a pace view — neither is guaranteed populated in
 * a fresh dev environment (the batch list may be empty).
 *
 * The spec is therefore data-agnostic on batch content: it verifies the page shell
 * renders (not bounced, not crashed), the key UI elements mount, and no fabricated
 * values are present.
 */

test.describe('@clientAdmin sales', () => {
  test('routes to /admin/sales and is not bounced', async ({ page }) => {
    await page.goto('/admin/sales');
    await expect(page).toHaveURL(/\/admin\/sales/);
  });

  test('page shell renders — Download Template button and upload drop zone present', async ({ page }) => {
    await page.goto('/admin/sales');
    // Step 1 panel always renders a "Download Template — <MonthLabel>" button.
    // The text includes the current month label (e.g. "Download Template — Jun 2026").
    await expect(
      page.getByRole('button', { name: /Download Template/i }).first()
    ).toBeVisible({ timeout: 12_000 });
    // Step 2 panel is a drag-drop zone (a <div>, not a <button>), so we assert via
    // the descriptive text it always shows when no file is selected.
    await expect(
      page.getByText(/Drop your Excel here|browse/i).first()
    ).toBeVisible({ timeout: 12_000 });
  });

  test('batch history resolves (no eternal spinner)', async ({ page }) => {
    await page.goto('/admin/sales');
    const spinner = page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'));
    await expect(spinner).toHaveCount(0, { timeout: 15_000 });
  });

  /**
   * Data-agnostic: after the API call resolves the page is in one of two states:
   *   (a) a batch table with rows (if uploads have been done), or
   *   (b) an empty-state message (fresh environment).
   * Both are valid — we just confirm the page didn't crash (no uncaught errors).
   */
  test('batch list renders without a JS crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/admin/sales');
    await expect(page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'))).toHaveCount(0, {
      timeout: 15_000,
    });

    const crashErrors = errors.filter((m) => /is not a function|Cannot read/i.test(m));
    expect(crashErrors, `JS crash on /admin/sales: ${crashErrors.join(' | ')}`).toEqual([]);
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/sales');
    await expect(page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'))).toHaveCount(0, {
      timeout: 15_000,
    });
    await expectNoFabricatedData(page);
  });
});
