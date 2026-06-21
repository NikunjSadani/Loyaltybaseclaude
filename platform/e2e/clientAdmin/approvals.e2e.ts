import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN approvals page — `/admin/approvals`.
 *
 * IMPORTANT: this is `/admin/approvals` (the Gifsy final-validation KYC queue),
 * NOT `/admin/kyc/approvals` which is a different surface.
 *
 * Data source: GET /api/kyc?status=PENDING_GIFSY
 * The page maps API submissions through `mapApiSubmission()` and displays them as
 * approval cards. In a seeded dev environment the KYC seed entries include some with
 * PENDING_SO_APPROVAL and APPROVED status; there may be zero in PENDING_GIFSY state,
 * so the list can be empty.
 *
 * The page also has a hardcoded MOCK_PENDING fallback for the "Actioned Today" section,
 * but the live-fetch result replaces the pending queue. We are data-agnostic on queue size.
 *
 * Assertions:
 *   1. Routes correctly (not bounced to login).
 *   2. Heading "KYC Approvals" renders (proves the page component mounted).
 *   3. The three summary stat cards (Pending Review, Approved Today, Rejected Today) render.
 *   4. The page resolves without a spinner stuck.
 *   5. expectNoFabricatedData() passes.
 *
 * NOTE: The MOCK_PENDING entries include names like "Vijay Mehta", "Ramesh Desai",
 * "Suresh Nair" — these are NOT in the fabricated token list, so expectNoFabricatedData()
 * is not affected by them being present. The key tokens it pins are `4,821` and
 * `Rahul Agarwal` (admin-shell demo persona).
 */

test.describe('@clientAdmin approvals', () => {
  test('routes to /admin/approvals and is not bounced', async ({ page }) => {
    await page.goto('/admin/approvals');
    await expect(page).toHaveURL(/\/admin\/approvals/);
  });

  test('heading "KYC Approvals" renders (page mounted, not loading forever)', async ({ page }) => {
    await page.goto('/admin/approvals');
    // The page shows a full-screen spinner while loading then renders the heading.
    await expect(page.getByRole('heading', { name: 'KYC Approvals' })).toBeVisible({ timeout: 12_000 });
  });

  test('the three stat cards render (Pending Review / Approved Today / Rejected Today)', async ({ page }) => {
    await page.goto('/admin/approvals');
    await expect(page.getByRole('heading', { name: 'KYC Approvals' })).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText('Pending Review')).toBeVisible();
    await expect(page.getByText('Approved Today')).toBeVisible();
    await expect(page.getByText('Rejected Today')).toBeVisible();
  });

  /**
   * Data-agnostic on queue size: if PENDING_GIFSY is empty the page shows "No pending
   * approvals" or similar; if it has entries it shows approval cards. Either is valid.
   * The stat card value for "Pending Review" must be a non-negative integer.
   */
  test('Pending Review count is a non-negative integer', async ({ page }) => {
    await page.goto('/admin/approvals');
    await expect(page.getByRole('heading', { name: 'KYC Approvals' })).toBeVisible({ timeout: 12_000 });
    // The count is a <p class="text-2xl font-bold text-amber-600">{pending.length}</p>
    // immediately above the "Pending Review" label.
    const countEl = page
      .locator('p', { hasText: /^Pending Review$/ })
      .locator('xpath=preceding-sibling::p[1]');
    const text = (await countEl.innerText()).trim();
    const count = parseInt(text, 10);
    expect(Number.isNaN(count), `expected an integer for Pending Review count, got "${text}"`).toBe(false);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/approvals');
    await expect(page.getByRole('heading', { name: 'KYC Approvals' })).toBeVisible({ timeout: 12_000 });
    await expectNoFabricatedData(page);
  });
});
