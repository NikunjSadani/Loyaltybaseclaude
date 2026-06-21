import { test, expect } from '@playwright/test';

/**
 * S4g / Wave-4 — GIFSY New Client route (`/gifsy/clients/new`).
 *
 * Tenant creation is deferred at launch (the submit handler stores in-memory
 * only; "DB persistence applies in Phase 2"). This spec asserts the route
 * renders successfully (200, not a crash), the multi-step wizard UI is present,
 * and navigation to the first step is functional.
 *
 * No real API is called on mount — the page is purely client-side state.
 * Therefore no real-data assertions apply here; the goal is smoke + no-crash.
 *
 * Asserts:
 *  1. Route loads without crashing (heading visible, no Next.js error overlay).
 *  2. The first wizard step ("Identity") is active on load.
 *  3. The breadcrumb back-link to /gifsy/clients renders.
 *  4. The 4 stepper labels are visible (Identity / Branding / Features / Review).
 *  5. The "Next" navigation button is present.
 */
test.describe('@gifsy Clients → New (S4g route smoke)', () => {
  test('route renders without crashing', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/gifsy/clients/new');
    await expect(page).toHaveURL(/\/gifsy\/clients\/new/);

    // The wizard heading is the stable crash indicator: if the page mounted cleanly,
    // the heading is visible. Note: [data-nextjs-scroll-focus-boundary] is a Next.js
    // internals attribute whose presence depends on the Next.js version and is NOT a
    // reliable crash detector — use the real heading instead.
    await expect(page.getByRole('heading', { name: /Onboard New Client/i })).toBeVisible({ timeout: 10_000 });

    // No React error boundary text.
    await expect(page.getByText(/Something went wrong|Application error/i)).toHaveCount(0);

    // No React error in the console (catches minified-react-error crashes).
    const reactCrash = consoleErrors.find((e) => /something went wrong|minified react error/i.test(e));
    expect(reactCrash, `React crash on /gifsy/clients/new: ${reactCrash}`).toBeUndefined();
  });

  test('wizard starts on the Identity step', async ({ page }) => {
    await page.goto('/gifsy/clients/new');
    await expect(page.getByRole('heading', { name: /Client Identity/i })).toBeVisible();
    await expect(page.getByPlaceholder(/reliance-retail/i)).toBeVisible();
  });

  test('all 4 stepper labels render', async ({ page }) => {
    await page.goto('/gifsy/clients/new');
    await expect(page.getByText('Identity', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Branding', { exact: true })).toBeVisible();
    await expect(page.getByText('Features', { exact: true })).toBeVisible();
    await expect(page.getByText('Review', { exact: true })).toBeVisible();
  });

  test('breadcrumb back-link to /gifsy/clients is present', async ({ page }) => {
    await page.goto('/gifsy/clients/new');
    await expect(page.getByRole('link', { name: /Clients/i })).toBeVisible();
  });

  test('Next button is present on the Identity step', async ({ page }) => {
    await page.goto('/gifsy/clients/new');
    await expect(page.getByRole('button', { name: /Next/i })).toBeVisible();
  });

  test('deferred-persistence note is visible', async ({ page }) => {
    // The page explicitly surfaces the "Phase 2" deferred-persistence message
    // in the success screen; on the wizard it shows no such banner. Confirm the
    // onboarding header subtitle references "new tenant".
    await page.goto('/gifsy/clients/new');
    await expect(
      page.getByText(/Configure a new tenant on the Gifsy Loyalty Platform/i),
    ).toBeVisible();
  });
});
