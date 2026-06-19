import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * Partner wallet — DATA-VISIBILITY row `/partner/wallet`: own balance + own ledger.
 * Ground truth (gifsy_dev, partner 9000000002 / "Test Wholesale Co"): redeemablePoints = 50,000,
 * redeemed = 0, locked = 0, empty ledger. Known bug #40: the statement renders demo "8,550".
 */
test.describe('@partner wallet', () => {
  test('shows the real redeemable balance (50,000)', async ({ page }) => {
    await page.goto('/partner/wallet');
    // The real balance must be visible somewhere on the page.
    await expect(page.getByText('50,000').first()).toBeVisible();
  });

  test('renders no fabricated demo values (#40)', async ({ page }) => {
    await page.goto('/partner/wallet');
    await expectNoFabricatedData(page);
  });
});
