import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN dashboard — DATA-VISIBILITY `/admin/dashboard`: real tenant KPIs.
 * Ground truth (gifsy_dev): tenant = "Deoleo India Pvt. Ltd." (user "Deoleo Admin"); 2 partners,
 * 2 outlets. The OTHER tenant "Client B (Demo)" / clientb must NEVER appear to a deoleo admin.
 */
const OTHER_TENANT = ['Client B', 'clientb']; // cross-tenant leak markers (S7-lite; full test = #52)

test.describe('@clientAdmin dashboard', () => {
  test('routes to the admin dashboard (authed, not bounced to login)', async ({ page }) => {
    await page.goto('/admin/dashboard');
    await expect(page).toHaveURL(/\/admin\/dashboard/);
  });

  test('shows the real tenant identity, not a demo persona', async ({ page }) => {
    await page.goto('/admin/dashboard');
    // Real anchor: the logged-in admin's own tenant context ("Deoleo") must render. If the shell
    // hardcodes a demo identity (as the partner shell does, #40), this reds — a real finding.
    await expect(page.getByText(/deoleo/i).first()).toBeVisible();
  });

  test('no fabricated values + no cross-tenant leak (#40 / Q6)', async ({ page }) => {
    await page.goto('/admin/dashboard');
    await expectNoFabricatedData(page);
    const body = await page.locator('body').innerText();
    for (const m of OTHER_TENANT) {
      expect(body.includes(m), `cross-tenant leak: "${m}" visible to a deoleo admin`).toBe(false);
    }
  });
});
