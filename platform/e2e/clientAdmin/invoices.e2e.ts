import { test, expect, type Page } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN visibility invoices (B2) — `/admin/invoices` + `/admin/invoices/upload`.
 *
 * ⚠️ DIRECTORY NOTE: this is the ADMIN invoices page, but the spec lives in `clientAdmin/` (NOT a new
 * `admin/` dir). playwright.config.ts maps the per-role storageState by DIRECTORY — only `clientAdmin/`
 * is wired to the CLIENT_ADMIN session. A spec under `e2e/admin/` would match NO project (no `admin`
 * project exists), so it would never run with a real session. The page is reached AS a deoleo
 * CLIENT_ADMIN (admin/layout.tsx renders the "Visibility Invoices" nav to CLIENT_ADMIN; the upload page
 * is explicitly "Visible to GIFSY_ADMIN and CLIENT_ADMIN"). See the report for this deviation.
 *
 * KEY REGRESSION GUARD (the list-shape fix): the list endpoints return `{ invoices, pagination }`, and
 * the pages read `res.data.invoices` (not `res.data` directly). Before the fix the page called `.map`
 * on a non-array → "map is not a function" uncaught crash. In dev the invoice list is EMPTY (no seeded
 * source payouts), so the correct shape renders the empty state — never a crash. These specs assert:
 *   (a) no uncaught page error containing "is not a function" (the crash mechanism), AND
 *   (b) the empty-state text rendered (positive proof the success branch ran, not the error branch).
 */

/** Attach a pageerror collector BEFORE navigating. Returns the live array of uncaught error messages. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

/** The list-shape regression would surface as a TypeError "<x>.map is not a function". */
function assertNoListShapeCrash(errors: string[]): void {
  const mapCrash = errors.filter((m) => /is not a function/i.test(m));
  expect(mapCrash, `uncaught list-shape crash on the invoices page: ${mapCrash.join(' | ')}`).toEqual([]);
}

test.describe('@clientAdmin visibility invoices (B2)', () => {
  test('renders the list header + the three summary cards at ₹0.00 (empty data)', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/admin/invoices');
    await expect(page).toHaveURL(/\/admin\/invoices/);

    // Header — proves the page mounted (not bounced to login / not the loading spinner forever).
    await expect(page.getByRole('heading', { name: 'Visibility Invoices' })).toBeVisible();

    // The three summary cards. Labels are CSS-uppercased ("uppercase" class), so match case-insensitively.
    await expect(page.getByText(/^Base Payout$/i)).toBeVisible();
    await expect(page.getByText(/^Total GST$/i)).toBeVisible();
    await expect(page.getByText(/^Invoice Total$/i)).toBeVisible();

    // Empty data → every card total is ₹0.00 (formatINR(0)). At least one ₹0.00 value renders.
    await expect(page.getByText('₹0.00').first()).toBeVisible();

    assertNoListShapeCrash(errors);
  });

  test('shows the empty state (NOT a crash) — the list-shape regression guard', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/admin/invoices');

    // Positive render proof: the success branch ran and rendered the empty table state. If the page had
    // thrown "map is not a function" it would either crash out or fall into the error early-return, and
    // this text would be absent.
    await expect(page.getByText('No invoices match your filters')).toBeVisible();

    assertNoListShapeCrash(errors);
  });

  test('the action buttons are present', async ({ page }) => {
    await page.goto('/admin/invoices');
    // Scope to <main> — "Upload Payouts" also appears as a sidebar nav link, so an
    // unscoped role query is a strict-mode collision.
    const main = page.getByRole('main');
    await expect(main.getByRole('button', { name: 'Export Excel' })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Generate Invoices' })).toBeVisible();
    // "Upload Payouts" is a Link (anchor) to /admin/invoices/upload.
    await expect(main.getByRole('link', { name: 'Upload Payouts' })).toBeVisible();
  });

  test('renders no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/invoices');
    await expectNoFabricatedData(page);
  });

  test('the upload wizard renders the auto-sourced copy + sample-template link', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/admin/invoices/upload');
    await expect(page).toHaveURL(/\/admin\/invoices\/upload/);

    await expect(page.getByRole('heading', { name: 'Generate Visibility Invoices' })).toBeVisible();
    // The key copy: amounts are NOT hand-entered — sourced from the approved payouts (no-compute model).
    await expect(
      page.getByText(/Amounts are sourced automatically from the approved visibility payouts/i),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download sample template' })).toBeVisible();

    assertNoListShapeCrash(errors);
  });
});
