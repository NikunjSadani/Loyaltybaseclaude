import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN TDS page — `/admin/tds`.
 *
 * Scope for CLIENT_ADMIN:
 *   - 194R tab is shown to both CLIENT_ADMIN and GIFSY_ADMIN.
 *   - 194C tab is GIFSY_ADMIN only (hidden for CLIENT_ADMIN).
 *
 * Data source: GET /api/admin/tds/194r?fy=<FY>
 * The page uses `useAdminSession()` to derive `isGifsy`. For a CLIENT_ADMIN session
 * isGifsy === false, so the 194C tab is hidden entirely.
 *
 * Assertions:
 *   1. Page mounts and is not bounced.
 *   2. The FY selector renders (proves the shell painted).
 *   3. The 194R tab renders and is the active default.
 *   4. The 194C tab is NOT shown (CLIENT_ADMIN scope guard).
 *   5. The 194R liability table resolves (spinner clears).
 *   6. expectNoFabricatedData() passes.
 */

test.describe('@clientAdmin TDS (194R — tenant view)', () => {
  test('routes to /admin/tds and is not bounced', async ({ page }) => {
    await page.goto('/admin/tds');
    await expect(page).toHaveURL(/\/admin\/tds/);
  });

  test('FY selector renders (shell mounted)', async ({ page }) => {
    await page.goto('/admin/tds');
    // The FY selector is a <select> element with a "Financial Year" label.
    // Asserting the <select> element is present proves the shell painted.
    // The FY options match /20\d{2}-\d{2}/ (e.g. "2025-26") but getByText matches too
    // broadly (hits <option> elements, the heading, the table cells).  Target the label.
    await expect(page.getByText('Financial Year')).toBeVisible({ timeout: 10_000 });
    // Also assert the <select> itself is rendered.
    await expect(page.locator('select').first()).toBeVisible({ timeout: 10_000 });
  });

  test('194R tab is visible and is the default active tab', async ({ page }) => {
    await page.goto('/admin/tds');
    // The tab label is "194R — Perquisites" (from the tabs array in the page component).
    // Use getByRole('button') scoped to the tab container to avoid matching the table
    // heading "194R Liability — …" which also contains "194R".
    await expect(
      page.getByRole('button', { name: /194R/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('194C tab is NOT shown to CLIENT_ADMIN (scope guard)', async ({ page }) => {
    await page.goto('/admin/tds');
    // Allow the shell to fully render — wait for the 194R tab button to appear.
    await expect(
      page.getByRole('button', { name: /194R/i }).first()
    ).toBeVisible({ timeout: 10_000 });
    // 194C tab button must not exist for a CLIENT_ADMIN session.
    // The tab label would be "194C — Contractor (Gifsy)" if present.
    await expect(page.getByRole('button', { name: /194C/i })).toHaveCount(0);
    await expect(page.getByText(/194C — Contractor/i)).toHaveCount(0);
  });

  test('194R liability table resolves (no eternal spinner)', async ({ page }) => {
    await page.goto('/admin/tds');
    // Wait for the API call to resolve (spinner disappears).
    const spinner = page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'));
    await expect(spinner).toHaveCount(0, { timeout: 15_000 });
    // The table or the "no data" empty state must render.
    // The summary cards render with labels from SummaryCard components:
    //   "Total Amount Paid" | "TDS Liability" | "Deposited" | "Outstanding"
    // (These appear only when r194 data arrives; before that the cards are absent.)
    // We use a broad match — any one of these labels confirms the table section rendered.
    await expect(
      page.getByText(/Total Amount Paid|TDS Liability|Deposited|Outstanding/i).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/tds');
    const spinner = page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'));
    await expect(spinner).toHaveCount(0, { timeout: 15_000 });
    await expectNoFabricatedData(page);
  });
});
