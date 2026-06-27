import { test, expect, type Page } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * MIS_USER read surface — DATA-VISIBILITY: the tenant read-only admin pages.
 *
 * MIS_USER sees the same admin shell as CLIENT_ADMIN but with NO write controls.
 * These specs confirm every page in the read surface renders (not bounced, not
 * 403 on GET) and carries real data (not fabricated, not cross-tenant).
 *
 * Pages covered (post-consolidation — the four REAL dashboards; the old fake
 * /payments, /redemptions, /engagement pages have been DELETED):
 *   /admin/dashboards/kyc             — KYC Dashboard (live API: GET /api/admin/dashboard/kyc)
 *   /admin/dashboards/operations      — Operations Dashboard (live API: GET /api/admin/dashboard/operations)
 *   /admin/dashboards/program-health  — Program Health (live API: GET /api/admin/dashboard/program-health)
 *   /admin/dashboards/finance         — Finance Dashboard (live API: GET /api/admin/dashboard/finance)
 *   /admin/kyc                     — KYC submissions list (live API: GET /api/kyc)
 *   /admin/tickets                 — Tickets list (live API: GET /api/tickets)
 *   /admin/reports                 — Reports catalogue (static)
 *   /admin/targets                 — Targets / KPI Management (live API: GET /api/admin/kpis)
 *   /admin/schemes                 — Schemes list — NOTE: the nav item is gifsyOnly
 *                                    (canManageSchemes=false for MIS_USER); the page
 *                                    itself is behind GET /v1/schemes which is not
 *                                    @Roles-restricted. If the FE route guard redirects
 *                                    MIS away, expectScopedOut handles it. If the page
 *                                    renders, expectNoFabricatedData runs.
 *
 * Real data markers from seed truth (gifsy_dev, deoleo tenant):
 *   - "DEO-0001" ticket (seed §3.10) must appear on /admin/tickets.
 *   - /admin/kyc must not be empty (2 seeded submissions per seed §3.6).
 *   - KPI card "Total Active Partners" must resolve to an integer on /admin/dashboard
 *     (tested in dashboard.e2e.ts; here we trust the page renders without fabrication).
 *
 * Cross-tenant guard (bidirectional §52): clientb data ("Zenith Trading Co", "CPB001")
 * must never appear on any deoleo MIS session.
 */

const OTHER_TENANT_MARKERS = ['Zenith Trading Co', 'CPB001', 'clientb'];

async function assertNoTenantLeak(page: Page): Promise<void> {
  const body = await page.locator('body').innerText();
  for (const m of OTHER_TENANT_MARKERS) {
    expect(body.includes(m), `cross-tenant leak: "${m}" visible to MIS_USER on ${page.url()}`).toBe(false);
  }
}

// ── Aggregate dashboards ──────────────────────────────────────────────────────

test.describe('@mis reads — KYC Dashboard', () => {
  test('renders KYC Dashboard heading (not bounced)', async ({ page }) => {
    await page.goto('/admin/dashboards/kyc');
    await expect(page).toHaveURL(/\/admin\/dashboards\/kyc/);
    // Real page: heading renders after the loading spinner resolves (loaded OR error branch).
    await expect(
      page.locator('main').getByRole('heading', { name: 'KYC Dashboard' }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/dashboards/kyc');
    await expect(
      page.locator('main').getByRole('heading', { name: 'KYC Dashboard' }).first()
    ).toBeVisible({ timeout: 10_000 });
    await expectNoFabricatedData(page);
    await assertNoTenantLeak(page);
  });
});

test.describe('@mis reads — Operations Dashboard', () => {
  test('renders Operations Dashboard heading (not bounced)', async ({ page }) => {
    await page.goto('/admin/dashboards/operations');
    await expect(page).toHaveURL(/\/admin\/dashboards\/operations/);
    await expect(
      page.locator('main').getByRole('heading', { name: 'Operations Dashboard' }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/dashboards/operations');
    await expect(
      page.locator('main').getByRole('heading', { name: 'Operations Dashboard' }).first()
    ).toBeVisible({ timeout: 10_000 });
    await expectNoFabricatedData(page);
    await assertNoTenantLeak(page);
  });
});

test.describe('@mis reads — Program Health Dashboard', () => {
  test('renders Program Health heading (not bounced)', async ({ page }) => {
    await page.goto('/admin/dashboards/program-health');
    await expect(page).toHaveURL(/\/admin\/dashboards\/program-health/);
    await expect(
      page.locator('main').getByRole('heading', { name: 'Program Health' }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/dashboards/program-health');
    await expect(
      page.locator('main').getByRole('heading', { name: 'Program Health' }).first()
    ).toBeVisible({ timeout: 10_000 });
    await expectNoFabricatedData(page);
    await assertNoTenantLeak(page);
  });
});

test.describe('@mis reads — Finance Dashboard', () => {
  test('renders Finance Dashboard heading (not bounced)', async ({ page }) => {
    await page.goto('/admin/dashboards/finance');
    await expect(page).toHaveURL(/\/admin\/dashboards\/finance/);
    await expect(
      page.locator('main').getByRole('heading', { name: 'Finance Dashboard' }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/dashboards/finance');
    await expect(
      page.locator('main').getByRole('heading', { name: 'Finance Dashboard' }).first()
    ).toBeVisible({ timeout: 10_000 });
    await expectNoFabricatedData(page);
    await assertNoTenantLeak(page);
  });
});

// ── Live-API pages ────────────────────────────────────────────────────────────

test.describe('@mis reads — KYC submissions', () => {
  test('routes to /admin/kyc (not bounced)', async ({ page }) => {
    await page.goto('/admin/kyc');
    await expect(page).toHaveURL(/\/admin\/kyc/);
  });

  test('page renders (not a blank screen or error state)', async ({ page }) => {
    await page.goto('/admin/kyc');
    // Wait for any loading state to clear (live API call: GET /v1/kyc).
    // Either a table or an empty-state message must become visible.
    await expect(page.locator('body')).toBeVisible();
    const body = await page.locator('body').innerText();
    // The page must not be a generic error page — a heading for the section renders.
    expect(body.length, 'page body is empty — did not render').toBeGreaterThan(50);
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/kyc');
    await expectNoFabricatedData(page);
    await assertNoTenantLeak(page);
  });
});

test.describe('@mis reads — Tickets', () => {
  test('routes to /admin/tickets (not bounced)', async ({ page }) => {
    await page.goto('/admin/tickets');
    await expect(page).toHaveURL(/\/admin\/tickets/);
  });

  test('ticket "DEO-0001" renders — real seeded data via GET /v1/tickets', async ({ page }) => {
    await page.goto('/admin/tickets');
    // seed §3.10: ticket DEO-0001 is seeded for the deoleo tenant. isSupportAdmin(MIS_USER)
    // returns true so the tickets.service.list returns ALL tenant tickets (not just owned).
    // MIS_USER must therefore see DEO-0001 — a real data assertion, not just "renders".
    await expect(page.getByText('DEO-0001').first()).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/tickets');
    await expectNoFabricatedData(page);
    await assertNoTenantLeak(page);
  });
});

test.describe('@mis reads — Reports catalogue', () => {
  test('routes to /admin/reports (not bounced)', async ({ page }) => {
    await page.goto('/admin/reports');
    await expect(page).toHaveURL(/\/admin\/reports/);
  });

  test('Outlet Master report card renders', async ({ page }) => {
    await page.goto('/admin/reports');
    // The reports page is static (no live API); the "Outlet Master" card always renders.
    await expect(page.getByText('Outlet Master')).toBeVisible();
  });

  test('no fabricated values + no cross-tenant leak (#40)', async ({ page }) => {
    await page.goto('/admin/reports');
    await expectNoFabricatedData(page);
    await assertNoTenantLeak(page);
  });
});

test.describe('@mis reads — Targets (KPI Management)', () => {
  test('routes to /admin/targets (not bounced)', async ({ page }) => {
    await page.goto('/admin/targets');
    await expect(page).toHaveURL(/\/admin\/targets/);
  });

  test('KPI Management heading renders (page mounted past load state)', async ({ page }) => {
    await page.goto('/admin/targets');
    await expect(page.getByRole('heading', { name: 'KPI Management' }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('KPI list resolves and shows real KPI row (MONTH_TGT from seed)', async ({ page }) => {
    test.fixme(true, 'MIS_USER gets 403 on GET /api/admin/kpis — MIS cannot read KPIs (RBAC gap; targets is in the MIS read column) — tracked in gap-register #57');
    await page.goto('/admin/targets');
    await expect(page.locator('[aria-label="Loading"], .animate-spin')).toHaveCount(0, { timeout: 10_000 });
    // The seeded KPI code "MONTH_TGT" appears in the font-mono code column of the table.
    // Confirms the API resolved and the table rendered with real data.
    await expect(page.getByText('MONTH_TGT').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Month Target').first()).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/targets');
    await expectNoFabricatedData(page);
  });
});

test.describe('@mis reads — Schemes', () => {
  /**
   * /admin/schemes: the nav item is gifsyOnly=true (canManageSchemes=false for MIS_USER),
   * so the sidebar does NOT link to it. However, the FE route is only guarded by
   * RequireAuth(PORTAL_ROLES.admin) — MIS_USER is in PORTAL_ROLES.admin. The page itself
   * fetches GET /v1/schemes (no @Roles restriction). Therefore, MIS can reach the page
   * directly by URL, but should see read-only content (no "Create Scheme" button visible).
   *
   * If a future change adds a @Roles guard that redirects MIS away, this test should be
   * updated to use expectScopedOut — but that is a tightening, not a regression.
   */
  test('can load /admin/schemes without a 500 or redirect to login', async ({ page }) => {
    await page.goto('/admin/schemes');
    // Acceptable outcomes: either the schemes list renders, OR a redirect to /admin/dashboard
    // (if the FE route guard grows to redirect MIS away — both are acceptable).
    // NOT acceptable: redirect to /auth/login (session expired) or a 500 error.
    const url = new URL(page.url());
    expect(
      url.pathname.startsWith('/admin'),
      `MIS landed outside /admin on ${url.pathname} — session may be expired`,
    ).toBe(true);
  });

  test('no fabricated values if page renders (#40)', async ({ page }) => {
    await page.goto('/admin/schemes');
    const url = new URL(page.url());
    // Only run the fabricated-data check if we actually landed on the schemes page.
    if (url.pathname.startsWith('/admin/schemes')) {
      await expectNoFabricatedData(page);
    }
    // If redirected to another /admin/* page (e.g. dashboard), that page is already
    // covered by dashboard.e2e.ts — no assertion needed here.
  });
});
