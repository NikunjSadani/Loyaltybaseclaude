import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * Partner targets read (Stream S3p, Wave 3).
 *
 * Tests: GET /api/partner/targets?period=YYYY-MM renders own targets.
 *
 * Data-agnostic: CP001 (seed-cp-1) may have no targets configured for the
 * current period in a fresh dev seed. Both states must pass:
 *   - empty     → "No targets configured" empty state
 *   - populated → at least one KPI card + the hero scorecard render
 *
 * Endpoint: GET /api/partner/targets?period=YYYY-MM
 *           → { success, data: { period, outlets: [{ outletCode, kpis }] } }
 * FE page:  /partner/targets
 */

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

test.describe('@partner targets (read)', () => {
  test('page mounts and renders the heading', async ({ page }) => {
    await page.goto('/partner/targets');
    await expect(page).toHaveURL(/\/partner\/targets/);
    await expect(page.getByRole('heading', { name: /my targets/i })).toBeVisible();
  });

  test('renders targets or the empty state from the real API (data-agnostic)', async ({ page }) => {
    await page.goto('/partner/targets');

    // Either the empty state (no targets configured) or the hero scorecard renders.
    // The hero scorecard contains the "Performance" text + a fraction like "0/1" or "1/1".
    const emptyState = page.getByText(/no targets configured/i);
    // The hero card always renders the performance label when params.length > 0
    const heroCard = page.getByText(/performance/i).first();

    await expect(emptyState.or(heroCard)).toBeVisible({ timeout: 10_000 });
  });

  test('API returns the expected shape for the current period', async ({ page }) => {
    await page.goto('/partner/targets');
    const token = await cookieToken(page);
    const period = currentPeriod();
    const r = await page.request.get(`/api/partner/targets?period=${period}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.ok()).toBe(true);
    const j = await r.json();
    expect(j.success, 'GET /api/partner/targets must succeed').toBe(true);
    // Shape check: data.outlets is always an array (possibly empty).
    const outlets = j.data?.outlets;
    expect(Array.isArray(outlets), 'data.outlets must be an array').toBe(true);
    // Any present outlet must have the expected fields.
    for (const outlet of outlets as Array<{ outletCode: string; kpis: unknown[] }>) {
      expect(outlet.outletCode, 'outlet must have an outletCode').toBeTruthy();
      expect(Array.isArray(outlet.kpis), 'outlet.kpis must be an array').toBe(true);
    }
  });

  test('period selector is present and defaults to current month', async ({ page }) => {
    await page.goto('/partner/targets');
    // A <select> with the current period value must exist.
    const period = currentPeriod();
    const selector = page.locator('select');
    await expect(selector).toBeVisible({ timeout: 5_000 });
    await expect(selector).toHaveValue(period);
  });

  test('renders no fabricated demo values (#40)', async ({ page }) => {
    await page.goto('/partner/targets');
    await expectNoFabricatedData(page);
  });
});
