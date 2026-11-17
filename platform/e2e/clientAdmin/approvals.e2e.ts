import { test, expect } from '@playwright/test';

/**
 * `/admin/approvals` — RETIRED (A2, 2026-11-17).
 *
 * The old page listed PENDING_GIFSY KYCs but its Approve/Reject buttons only changed local state
 * (nothing was saved), and nothing linked to it. The route now replaces itself with the real GIFSY
 * review queue, `/admin/kyc/approvals` (client-side `router.replace`, same as `/admin/outlets`).
 *
 * Assertion: a direct visit (bookmark) lands on `/admin/kyc/approvals` and never stays on the dead URL.
 */

test.describe('@clientAdmin approvals (retired route)', () => {
  test('/admin/approvals redirects to /admin/kyc/approvals', async ({ page }) => {
    await page.goto('/admin/approvals');
    await expect(page).toHaveURL(/\/admin\/kyc\/approvals(\?|$)/, { timeout: 12_000 });
  });
});
