import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * S4g / Wave-4 — GIFSY Platform Settings (`/gifsy/settings`).
 *
 * This is a client-side-only page (no live API reads on mount). Settings are
 * read from localStorage via `getGifsySettings` / `saveGifsySettings`.
 * There are no fabrication risks but the page must render its sections without
 * crashing and the data-testid inputs must be present for headless interaction.
 *
 * Asserts:
 *  1. Page renders (URL + heading).
 *  2. All 5 settings sections render (Platform Identity, Security, Redemption
 *     Thresholds, Platform Notifications, Data Retention).
 *  3. The two redemption-threshold inputs with known data-testids are present.
 *  4. "Dev mode" warning banner renders (confirms Phase 2 deferred persistence).
 *  5. No fabricated data tokens (#40).
 */
test.describe('@gifsy Platform Settings (S4g)', () => {
  test('page renders with the Platform Settings heading', async ({ page }) => {
    await page.goto('/gifsy/settings');
    await expect(page).toHaveURL(/\/gifsy\/settings/);
    await expect(page.getByRole('heading', { name: /Platform Settings/i })).toBeVisible();
    await expectNoFabricatedData(page);
  });

  test('all settings sections render', async ({ page }) => {
    await page.goto('/gifsy/settings');

    // Each section has a labelled header; assert all 5 are present.
    await expect(page.getByText('Platform Identity', { exact: true })).toBeVisible();
    await expect(page.getByText('Security', { exact: true })).toBeVisible();
    await expect(page.getByText('Redemption Thresholds', { exact: true })).toBeVisible();
    await expect(page.getByText('Platform Notifications', { exact: true })).toBeVisible();
    await expect(page.getByText('Data Retention', { exact: true })).toBeVisible();
  });

  test('redemption threshold inputs are present (data-testid)', async ({ page }) => {
    await page.goto('/gifsy/settings');

    // The FE uses data-testid for Playwright targeting.
    const bankInput    = page.getByTestId('settings-min-bank-transfer');
    const voucherInput = page.getByTestId('settings-min-voucher');

    await expect(bankInput).toBeVisible();
    await expect(voucherInput).toBeVisible();

    // Default values are 250 each (from getGifsySettings initial defaults).
    await expect(bankInput).toHaveValue('250');
    await expect(voucherInput).toHaveValue('250');
  });

  test('dev-mode warning banner is visible', async ({ page }) => {
    await page.goto('/gifsy/settings');
    await expect(page.getByText(/Dev mode/i).first()).toBeVisible();
  });

  test('each section has a Save Section button', async ({ page }) => {
    await page.goto('/gifsy/settings');

    // Multiple sections each have a "Save Section" button.
    const saveButtons = page.getByRole('button', { name: /Save Section/i });
    await expect(saveButtons.first()).toBeVisible();
    // There are 4+ sections with save buttons.
    const count = await saveButtons.count();
    expect(count, 'at least 4 Save Section buttons (one per editable section)').toBeGreaterThanOrEqual(4);
  });
});
