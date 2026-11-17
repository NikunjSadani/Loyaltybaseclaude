import { test, expect } from '@playwright/test';

/**
 * `/admin/approvals` — RETIRED (A2/R5, 2026-11-17), CLIENT_ADMIN view.
 *
 * The old page listed PENDING_GIFSY KYCs but its Approve/Reject buttons only changed local state
 * (nothing was saved), and nothing linked to it. The route now replaces itself by role: a CLIENT_ADMIN
 * goes to the tenant KYC list `/admin/kyc` — NEVER the GIFSY review queue `/admin/kyc/approvals`
 * (DATA-VISIBILITY §3 Q2; see scoping.e2e.ts Q2). The GIFSY branch is e2e/gifsy/approvals-redirect.e2e.ts.
 */

test.describe('@clientAdmin approvals (retired route)', () => {
  test('/admin/approvals redirects a CLIENT_ADMIN to /admin/kyc (not the GIFSY queue)', async ({ page }) => {
    await page.goto('/admin/approvals');
    await expect(page).toHaveURL(/\/admin\/kyc(\?|$)/, { timeout: 12_000 });
    await expect(page).not.toHaveURL(/\/admin\/kyc\/approvals/);
  });
});
