import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * SALES_SO dashboard — DATA-VISIBILITY `/sales/dashboard`: assigned/team data.
 * Ground truth (gifsy_dev): user "Test Sales Officer" (SALES_SO), 2 assigned deoleo outlets. Only an
 * SO is seeded (no managers) → Q4 whole-downline roll-up is NOT testable yet (needs a hierarchy seed).
 */
const OTHER_TENANT = ['Client B', 'clientb'];

test.describe('@sales dashboard', () => {
  test('routes to the sales dashboard (authed, not bounced)', async ({ page }) => {
    await page.goto('/sales/dashboard');
    await expect(page).toHaveURL(/\/sales\/dashboard/);
  });

  test('shows the real sales-user identity, not a demo persona', async ({ page }) => {
    await page.goto('/sales/dashboard');
    await expect(page.getByText(/test sales officer/i).first()).toBeVisible();
  });

  test('no fabricated values + no cross-tenant leak (#40 / Q6)', async ({ page }) => {
    await page.goto('/sales/dashboard');
    await expectNoFabricatedData(page);
    const body = await page.locator('body').innerText();
    for (const m of OTHER_TENANT) {
      expect(body.includes(m), `cross-tenant leak: "${m}" visible to a deoleo sales user`).toBe(false);
    }
  });
});
