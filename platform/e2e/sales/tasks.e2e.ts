import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * SALES_SO tasks — DATA-VISIBILITY `/sales/tasks` (S3 read slice).
 *
 * The tasks page is a computed view assembled client-side from:
 *   - GET /api/sales/outlets  (KYC-status groups, visibility items)
 *   - fetchTaskConfig()        (admin-configurable task items)
 * There is no dedicated /api/sales/tasks endpoint — the data is derived.
 *
 * The page is data-agnostic here: we verify it renders (not 500-crashed) and
 * contains no fabricated values.  If the seed happens to produce pending KYC
 * or visibility items, those will render in the groups; we do not assert their
 * exact count because that depends on the current DB state of O001/O002.
 */
test.describe('@sales tasks', () => {
  test('routes to /sales/tasks and renders the Tasks heading', async ({ page }) => {
    await page.goto('/sales/tasks');
    await expect(page).toHaveURL(/\/sales\/tasks/);
    // The page always renders a heading or the "All clear!" empty state.
    const heading = page.getByRole('heading', { name: /tasks/i });
    const allClear = page.getByText(/all clear/i);
    await expect(heading.or(allClear)).toBeVisible({ timeout: 10_000 });
  });

  test('renders without a runtime error (no crash / error boundary)', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto('/sales/tasks');
    // Wait for the page to settle (outlets + task config loaded).
    await page.waitForLoadState('networkidle');

    // Catastrophic React errors (uncaught exceptions / error boundaries) always write to console.error.
    const reactCrash = errors.find((e) => /something went wrong|minified react error/i.test(e));
    expect(reactCrash, `React crash on /sales/tasks: ${reactCrash}`).toBeUndefined();
  });

  test('renders no fabricated values (#40)', async ({ page }) => {
    await page.goto('/sales/tasks');
    await expectNoFabricatedData(page);
  });
});
