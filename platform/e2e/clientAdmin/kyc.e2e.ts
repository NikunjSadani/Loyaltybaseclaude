import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN KYC submissions — DATA-VISIBILITY `/admin/kyc`: the tenant's KYC list.
 * Ground truth (gifsy_dev): 2 submissions (1 PENDING_GIFSY, 1 UNDER_REVIEW).
 */
test.describe('@clientAdmin kyc', () => {
  test('routes to the tenant KYC submissions list', async ({ page }) => {
    await page.goto('/admin/kyc');
    await expect(page).toHaveURL(/\/admin\/kyc/);
  });

  test('renders no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/kyc');
    await expectNoFabricatedData(page);
  });
});
