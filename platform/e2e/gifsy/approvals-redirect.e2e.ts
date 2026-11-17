import { test, expect } from '@playwright/test';

/**
 * `/admin/approvals` — RETIRED (A2/R5, 2026-11-17), GIFSY operator view.
 *
 * The old unlinked page's Approve/Reject buttons only changed local state. A GIFSY operator's bookmark
 * now lands on the real GIFSY review queue `/admin/kyc/approvals` (client-side `router.replace`).
 * The CLIENT_ADMIN branch (→ `/admin/kyc`) is e2e/clientAdmin/approvals.e2e.ts.
 */

test.describe('@gifsy approvals (retired route)', () => {
  test('/admin/approvals redirects a GIFSY operator to /admin/kyc/approvals', async ({ page }) => {
    await page.goto('/admin/approvals');
    await expect(page).toHaveURL(/\/admin\/kyc\/approvals(\?|$)/, { timeout: 12_000 });
  });
});
