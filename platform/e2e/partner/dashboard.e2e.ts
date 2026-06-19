import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * Partner dashboard — DATA-VISIBILITY row `/partner/dashboard`: own targets/wallet/rank.
 * Known bug #40: demo "Available 2,947 pts" (contradicts real 50,000) + "#12 of 248 partners".
 */
test.describe('@partner dashboard', () => {
  test('lands on the authenticated partner shell (not bounced/blank)', async ({ page }) => {
    await page.goto('/partner/dashboard');
    await expect(page).toHaveURL(/\/partner\/dashboard/);
    // Non-vacuous: the authenticated partner shell must actually render (Sign Out control present),
    // proving it's not a blank error page or a silent redirect target.
    await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
  });

  test('renders no fabricated demo values (#40)', async ({ page }) => {
    await page.goto('/partner/dashboard');
    await expectNoFabricatedData(page);
  });
});
