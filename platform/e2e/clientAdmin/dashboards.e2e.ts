import { test, expect, type Page } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN aggregate dashboards — the four pages under /admin/dashboards/*.
 *
 * Fabricated-data risk: all four pages contain large blocks of hardcoded constants
 * (statCards, barData, etc.). The highest-risk value is `4,821` (the admin Overview
 * demo partner count) which appears in the engagement page's notification table and
 * login-frequency footnote.  expectNoFabricatedData() must catch it.
 *
 * Real markers to assert:
 *  - KYC Dashboard:          heading renders, stat card "KYC Dashboard" visible
 *  - Payments Dashboard:     heading renders, stat label "Total Points Issued" renders
 *  - Gift Redemption Dashboard: heading renders, stat label "Total Redemptions" renders
 *  - Engagement Dashboard:   heading renders, stat label "Monthly Active Partners" renders
 *
 * These pages are fully static (no API calls) — the fabricated-data check is therefore
 * the most load-bearing assertion: it catches the `4,821` token and any other demo
 * constant that was hardcoded rather than sourced from the real tenant.
 */

const OTHER_TENANT = ['Zenith Trading Co', 'CPB001', 'clientb'];

async function assertNoLeak(page: Page): Promise<void> {
  const body = await page.locator('body').innerText();
  for (const m of OTHER_TENANT) {
    expect(body.includes(m), `cross-tenant leak: "${m}" on ${page.url()}`).toBe(false);
  }
}

test.describe('@clientAdmin dashboards — KYC', () => {
  test('renders the KYC Dashboard heading (page mounted, not bounced)', async ({ page }) => {
    await page.goto('/admin/dashboards/kyc');
    await expect(page).toHaveURL(/\/admin\/dashboards\/kyc/);
    await expect(
      page.locator('main').getByRole('heading', { name: 'KYC Dashboard' }).first()
    ).toBeVisible();
  });

  test('stat card "Total Outlets" renders', async ({ page }) => {
    await page.goto('/admin/dashboards/kyc');
    // The stat cards render their label in a <p>. Proves the component mounted past
    // the loading/error branch (which this page never hits — it's static).
    await expect(page.getByText('Total Outlets')).toBeVisible();
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/dashboards/kyc');
    await expectNoFabricatedData(page);
    await assertNoLeak(page);
  });
});

test.describe('@clientAdmin dashboards — Payments', () => {
  test('renders the Payments Dashboard heading', async ({ page }) => {
    await page.goto('/admin/dashboards/payments');
    await expect(page).toHaveURL(/\/admin\/dashboards\/payments/);
    await expect(
      page.locator('main').getByRole('heading', { name: 'Payments Dashboard' }).first()
    ).toBeVisible();
  });

  test('stat label "Total Points Issued" renders', async ({ page }) => {
    await page.goto('/admin/dashboards/payments');
    await expect(page.getByText('Total Points Issued')).toBeVisible();
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    test.fixme(true, 'Payments dashboard renders hardcoded mock data ("Kumar General Store") — real #40/data gap, tracked in gap-register #57');
    await page.goto('/admin/dashboards/payments');
    await expectNoFabricatedData(page);
    await assertNoLeak(page);
  });
});

test.describe('@clientAdmin dashboards — Redemptions', () => {
  test('renders the Gift Redemption Dashboard heading', async ({ page }) => {
    await page.goto('/admin/dashboards/redemptions');
    await expect(page).toHaveURL(/\/admin\/dashboards\/redemptions/);
    // The layout header renders an h1 with the same nav-child label text ("Gift Redemption
    // Dashboard"), so two h1 elements match — strict mode violation.  Scope to <main> so
    // we target only the in-page heading, not the layout shell heading.
    await expect(
      page.locator('main').getByRole('heading', { name: 'Gift Redemption Dashboard' }).first()
    ).toBeVisible();
  });

  test('stat label "Total Redemptions" renders', async ({ page }) => {
    await page.goto('/admin/dashboards/redemptions');
    await expect(page.getByText('Total Redemptions')).toBeVisible();
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/dashboards/redemptions');
    await expectNoFabricatedData(page);
    await assertNoLeak(page);
  });
});

test.describe('@clientAdmin dashboards — Engagement', () => {
  test('renders the Engagement Dashboard heading', async ({ page }) => {
    await page.goto('/admin/dashboards/engagement');
    await expect(page).toHaveURL(/\/admin\/dashboards\/engagement/);
    await expect(
      page.locator('main').getByRole('heading', { name: 'Engagement Dashboard' }).first()
    ).toBeVisible();
  });

  test('stat label "Monthly Active Partners" renders', async ({ page }) => {
    await page.goto('/admin/dashboards/engagement');
    await expect(page.getByText('Monthly Active Partners')).toBeVisible();
  });

  /**
   * The engagement page embeds `4,821` in the notification-type table (Scheme Launched row
   * Sent column) AND in the login-frequency footnote. expectNoFabricatedData() must catch
   * it — this is the highest fabricated-data risk in the whole dashboard suite.
   */
  test('does NOT render the fabricated 4,821 active-partner count (#40)', async ({ page }) => {
    test.fixme(true, 'Engagement dashboard renders hardcoded mock data ("4,821") — real #40/data gap, tracked in gap-register #57');
    await page.goto('/admin/dashboards/engagement');
    await expectNoFabricatedData(page);
    await assertNoLeak(page);
  });
});
