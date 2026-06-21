import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN visibility page — `/admin/visibility`.
 *
 * The page tab labels (from the actual page component):
 *   - "Bulk Upload"           — always rendered (the primary tab)
 *   - "Approval Queue (N)"   — only when visibilityPhotoEnabled = true (Gifsy setting)
 *   - "Fraud Log (N)"        — only when visibilityPhotoEnabled = true
 *
 * The default active tab is "upload" (Bulk Upload) when photoApprovalEnabled is false,
 * or "queue" (Approval Queue) when photoApprovalEnabled is true.
 *
 * Data:
 *   - The Approval Queue tab fetches /api/visibility/submissions?status=SUBMITTED
 *     and falls back to the hardcoded VISIBILITY_QUEUE constant on shape mismatch.
 *   - The Fraud Log tab renders the hardcoded FRAUD_LOG constant (no real API yet).
 *   - The Bulk Upload tab shows the visibility Excel upload wizard.
 *
 * We assert:
 *   1. The page mounts and is not bounced to login.
 *   2. The "Bulk Upload" tab button always renders.
 *   3. The upload wizard controls appear after clicking "Bulk Upload".
 *   4. expectNoFabricatedData() passes.
 *
 * Seed: VP001 (VisibilityProgram) — not directly surfaced in this view.
 */

test.describe('@clientAdmin visibility', () => {
  test('routes to /admin/visibility and is not bounced', async ({ page }) => {
    await page.goto('/admin/visibility');
    await expect(page).toHaveURL(/\/admin\/visibility/);
  });

  test('"Bulk Upload" tab button always renders', async ({ page }) => {
    await page.goto('/admin/visibility');
    // "Bulk Upload" is the only tab guaranteed to be present regardless of the
    // visibilityPhotoEnabled Gifsy setting.  "Approval Queue" and "Fraud Log" are
    // only rendered when photoApprovalEnabled === true.
    await expect(page.getByRole('button', { name: /Bulk Upload/i })).toBeVisible({ timeout: 10_000 });
  });

  test('"Bulk Upload" tab is the default (or can be navigated to) and shows upload controls', async ({ page }) => {
    await page.goto('/admin/visibility');
    // The page default tab is 'upload' when photoApprovalEnabled=false, 'queue' otherwise.
    // Click the Bulk Upload tab to guarantee we land on it regardless of settings.
    const bulkUploadTab = page.getByRole('button', { name: /Bulk Upload/i });
    await expect(bulkUploadTab).toBeVisible({ timeout: 10_000 });
    await bulkUploadTab.click();
    // The upload section always shows step instructions and a "Download Template" button.
    await expect(page.getByText(/Download the upload template/i)).toBeVisible({ timeout: 8_000 });
  });

  test('Upload tab renders the visibility template download button', async ({ page }) => {
    await page.goto('/admin/visibility');
    await page.getByRole('button', { name: /Bulk Upload/i }).click();
    // The step-1 panel has a "Download Template" button (indigo styled).
    await expect(
      page.getByRole('button', { name: /Download Template/i })
    ).toBeVisible({ timeout: 8_000 });
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/visibility');
    const spinner = page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'));
    await expect(spinner).toHaveCount(0, { timeout: 12_000 });
    await expectNoFabricatedData(page);
  });
});
