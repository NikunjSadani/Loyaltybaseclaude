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

  // sales-KYC-review grant (runtime-verified): a SALES_SO can reach /sales/kyc and it renders the
  // "KYC Submissions" review list scaffold + the status-filter control — i.e. sales has KYC-review
  // access and is NOT 403'd. The assigned-outlet list may be empty in dev, so we assert the LIST
  // SCAFFOLD (heading + status filter), never specific rows.
  test('renders the KYC Submissions review scaffold with the status filter', async ({ page }) => {
    await page.goto('/sales/kyc');
    // The list view header — proves the review surface rendered (not a forbidden/empty 403 shell).
    await expect(page.getByRole('heading', { name: /kyc submissions/i })).toBeVisible();
    // The status-filter control (the "tabs" — Pending / Approval Pending / Under Review / Approved /
    // Rejected …). Stable testid from the page; its presence proves the review filter scaffold rendered
    // even when the assigned-outlet list is empty.
    const statusFilter = page.getByTestId('kyc-status-filter');
    await expect(statusFilter).toBeVisible();
    // The filter must expose the review statuses, confirming this is the review list (not a stub).
    for (const opt of ['All', 'Approved', 'Rejected']) {
      await expect(statusFilter.locator('option', { hasText: opt })).toHaveCount(1);
    }
  });
});
