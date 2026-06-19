import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * SALES_SO KYC — DATA-VISIBILITY `/sales/kyc`: assigned-outlet KYC + first-approve.
 * Ground truth: 2 deoleo outlets assigned. First-approve flow itself is a WRITE path (#38) → covered
 * when the write-persistence helper lands (S4), not here.
 */
test.describe('@sales kyc', () => {
  test('routes to the assigned-outlet KYC list', async ({ page }) => {
    await page.goto('/sales/kyc');
    await expect(page).toHaveURL(/\/sales\/kyc/);
  });

  test('renders no fabricated values (#40)', async ({ page }) => {
    await page.goto('/sales/kyc');
    await expectNoFabricatedData(page);
  });
});
