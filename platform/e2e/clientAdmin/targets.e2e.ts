import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN KPI / Targets page — `/admin/targets`.
 *
 * Data source: GET /api/admin/kpis (live KpiDef[] for this tenant).
 * The page is data-agnostic: it may have 0 KPIs (seed not yet run) or several (seed applied).
 * The list renders a "No KPIs defined yet." empty state or a table — both are valid outcomes.
 * What must NOT happen: a crash or an infinite spinner (the list-shape regression pattern).
 *
 * Real API endpoint used by the page: /api/admin/kpis.
 */

test.describe('@clientAdmin targets (KPI Management)', () => {
  test('routes to /admin/targets and is not bounced to login', async ({ page }) => {
    await page.goto('/admin/targets');
    await expect(page).toHaveURL(/\/admin\/targets/);
  });

  test('heading "KPI Management" renders (page mounted past load state)', async ({ page }) => {
    await page.goto('/admin/targets');
    await expect(page.getByRole('heading', { name: 'KPI Management' })).toBeVisible({ timeout: 10_000 });
  });

  test('Excel upload banner is present (proves shell rendered, not just title tag)', async ({ page }) => {
    await page.goto('/admin/targets');
    // The banner link to /admin/targets/upload is always rendered regardless of KPI list state.
    await expect(page.getByText('Upload Targets via Excel')).toBeVisible();
  });

  test('the Seed Defaults and Add KPI buttons render', async ({ page }) => {
    await page.goto('/admin/targets');
    await expect(page.getByRole('button', { name: 'Seed Defaults' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add KPI' })).toBeVisible();
  });

  /**
   * The KPI API returns data for this tenant (seed seeds MONTH_TGT "Month Target" and others).
   * Wait for the loading state to clear then confirm the KPI table rendered with a real row.
   * The table renders KPI codes in <td class="font-mono"> — assert the seeded code is visible.
   */
  test('KPI list resolves and shows real KPI row (MONTH_TGT from seed)', async ({ page }) => {
    await page.goto('/admin/targets');
    // Wait for the Spinner (aria-label="Loading") to disappear.
    await expect(page.locator('[aria-label="Loading"]')).toHaveCount(0, { timeout: 15_000 });
    // The seeded KPI code "MONTH_TGT" appears in the font-mono code column of the table.
    // This assertion confirms the API call resolved AND the table rendered with real data.
    await expect(page.getByText('MONTH_TGT').first()).toBeVisible({ timeout: 10_000 });
    // Also confirm the label column shows the human-readable name (may appear in a filter too → .first()).
    await expect(page.getByText('Month Target').first()).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/targets');
    await expectNoFabricatedData(page);
  });
});
