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
 *  4. The amber "Note" banner renders (only the redemption thresholds persist; the
 *     other sections are display-only placeholders — replaced the old "Dev mode" banner).
 *  5. Only the Redemption Thresholds section is editable → exactly one Save Section button.
 *  6. No fabricated data tokens (#40).
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

  test('the partial-wiring Note banner is visible', async ({ page }) => {
    await page.goto('/gifsy/settings');
    // The old "Dev mode" banner was replaced by an amber "Note" explaining that only the
    // redemption thresholds persist to the server and the other sections are display-only
    // placeholders (see src/app/gifsy/settings/page.tsx lines 50-54).
    await expect(page.getByText(/display-only placeholders and are not yet wired/i)).toBeVisible();
  });

  test('only the Redemption Thresholds section has a Save Section button', async ({ page }) => {
    await page.goto('/gifsy/settings');

    // The Identity / Security / Notifications / Data-Retention sections became read-only
    // (disabled inputs, no fake Save button). Only Redemption Thresholds persists to the
    // server, so there is now exactly ONE "Save Section" button on the page.
    const saveButtons = page.getByRole('button', { name: /Save Section/i });
    await expect(saveButtons).toHaveCount(1);
    await expect(page.getByTestId('settings-redemption-save')).toBeVisible();
  });
});
