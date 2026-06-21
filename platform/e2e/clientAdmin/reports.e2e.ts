import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN reports — three pages:
 *   /admin/reports              — index page (static report card grid)
 *   /admin/reports/points-ledger— Outlet Points Ledger (period picker + preview)
 *   /admin/reports/ticket-aging — Ticket Aging report (filter row + preview)
 *
 * All three are purely client-side (no on-mount API calls — data is fetched only
 * when "Generate Preview" / export buttons are clicked). So "renders" = the static
 * shell painted and is not bounced to login.
 */

test.describe('@clientAdmin /admin/reports (index)', () => {
  test('routes to /admin/reports and is not bounced', async ({ page }) => {
    await page.goto('/admin/reports');
    await expect(page).toHaveURL(/\/admin\/reports/);
  });

  test('shows report cards for key reports', async ({ page }) => {
    await page.goto('/admin/reports');
    // Operational report cards always present in the static list.
    await expect(page.getByText('Outlet Master')).toBeVisible();
    await expect(page.getByText('Outlet Points Ledger')).toBeVisible();
    await expect(page.getByText('Ticket Aging Report')).toBeVisible();
  });

  test('category labels render (Operational, Business, Finance, Engagement)', async ({ page }) => {
    await page.goto('/admin/reports');
    // Each category label appears both in the filter pill buttons AND in every report card badge,
    // so getByText() without scoping or .first() triggers a strict-mode violation.
    // Using .first() is correct here — the intent is just that at least one instance renders.
    await expect(page.getByText(/Operational/).first()).toBeVisible();
    await expect(page.getByText(/Business/).first()).toBeVisible();
    await expect(page.getByText(/Finance/).first()).toBeVisible();
    await expect(page.getByText(/Engagement/).first()).toBeVisible();
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/reports');
    await expectNoFabricatedData(page);
  });
});

test.describe('@clientAdmin /admin/reports/points-ledger', () => {
  test('routes to /admin/reports/points-ledger and is not bounced', async ({ page }) => {
    await page.goto('/admin/reports/points-ledger');
    await expect(page).toHaveURL(/\/admin\/reports\/points-ledger/);
  });

  test('heading and period-picker controls render', async ({ page }) => {
    await page.goto('/admin/reports/points-ledger');
    // The page title (from the report config) or an h1 rendered by the page component.
    await expect(
      page.getByRole('heading', { name: /Points Ledger|Outlet Points/i }).or(
        page.getByText(/Points Ledger/i).first()
      )
    ).toBeVisible({ timeout: 10_000 });
    // The period "From" and "To" month inputs are always rendered on mount.
    await expect(page.locator('input[type="month"]').first()).toBeVisible();
  });

  test('Generate Preview button is present', async ({ page }) => {
    await page.goto('/admin/reports/points-ledger');
    await expect(
      page.getByRole('button', { name: /Generate Preview|Preview/i })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/reports/points-ledger');
    await expectNoFabricatedData(page);
  });
});

test.describe('@clientAdmin /admin/reports/ticket-aging', () => {
  test('routes to /admin/reports/ticket-aging and is not bounced', async ({ page }) => {
    await page.goto('/admin/reports/ticket-aging');
    await expect(page).toHaveURL(/\/admin\/reports\/ticket-aging/);
  });

  test('heading and filter row render', async ({ page }) => {
    await page.goto('/admin/reports/ticket-aging');
    await expect(
      page.getByRole('heading', { name: /Ticket Aging/i }).or(
        page.getByText(/Ticket Aging/i).first()
      )
    ).toBeVisible({ timeout: 10_000 });
    // The filter row always has a Category dropdown and a Priority dropdown.
    await expect(page.getByText(/Category/i)).toBeVisible();
    await expect(page.getByText(/Priority/i)).toBeVisible();
  });

  test('Generate Preview button is present', async ({ page }) => {
    await page.goto('/admin/reports/ticket-aging');
    await expect(
      page.getByRole('button', { name: /Generate Preview|Preview/i })
    ).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/reports/ticket-aging');
    await expectNoFabricatedData(page);
  });
});
