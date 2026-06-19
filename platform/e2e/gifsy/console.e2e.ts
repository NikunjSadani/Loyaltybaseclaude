import { test, expect } from '@playwright/test';

/**
 * GIFSY operator console (#39). Proves login → the gifsy portal works (the whole surface was
 * login-blocked before the dev clientId override). The role guard admits only GIFSY_ADMIN here.
 *
 * NOTE: the clients list reads a STATIC CLIENT_REGISTRY (mock), not the real `clients` table — so
 * "GIFSY sees both tenants from the real DB" is a separate gifsy-portal real-data unit (gap #49).
 * These are smoke checks that the operator surface loads, not real-data assertions.
 */
test.describe('@gifsy console (#39)', () => {
  test('GIFSY_ADMIN lands on the operator console', async ({ page }) => {
    await page.goto('/gifsy');
    await expect(page).toHaveURL(/\/gifsy(\/|$)/);
    await expect(
      page.getByText(/Gifsy Loyalty Platform|clients onboarded/i).first(),
    ).toBeVisible();
  });

  test('the clients page loads for the operator', async ({ page }) => {
    await page.goto('/gifsy/clients');
    await expect(page).toHaveURL(/\/gifsy\/clients/);
    await expect(page.locator('body')).toBeVisible();
  });
});
