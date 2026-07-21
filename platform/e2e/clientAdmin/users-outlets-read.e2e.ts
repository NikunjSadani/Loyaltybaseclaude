import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN outlet pages — two related surfaces:
 *
 *   /admin/users/outlets  — fetches GET /api/admin/outlets (real DB rows: O001..O003)
 *   /admin/outlets        — uses a hardcoded OUTLET_MASTER mock (not DB-backed)
 *
 * Seed truth (api/prisma/seed.ts):
 *   O001 → CP001 (first partner)
 *   O002 → CP002 (second partner)
 *   O003 → CP003 (third partner)
 *
 * Cross-tenant guard: clientb's outlet is OB001 / CPB001 "Zenith Trading Co" — must
 * never appear on a deoleo admin page.
 *
 * NOTE on /admin/outlets: the page component (admin/outlets/page.tsx) initialises from
 * the hardcoded OUTLET_MASTER constant, not from the API.  The seed outlets O001/O002/O003
 * are NOT in that constant (which uses OUT-2026-* codes instead). We therefore only assert
 * the page heading and no-fab check for /admin/outlets, and reserve the real seed-marker
 * assertions for /admin/users/outlets which hits the real API.
 */

const CLIENTB_MARKERS = ['Zenith Trading Co', 'CPB001', 'OB001'];

// ─── /admin/users/outlets ──────────────────────────────────────────────────────

test.describe('@clientAdmin /admin/users/outlets — real API-backed outlet list', () => {
  test('routes to /admin/users/outlets and is not bounced', async ({ page }) => {
    await page.goto('/admin/users/outlets');
    await expect(page).toHaveURL(/\/admin\/users\/outlets/);
  });

  test('heading "Outlet Management" renders (page mounted, not spinner)', async ({ page }) => {
    await page.goto('/admin/users/outlets');
    // "Outlet Management" now appears twice — once in the page-header banner and once as the
    // in-page <main> title — so an unscoped getByRole('heading') hits a strict-mode violation.
    // Scope to <main> to assert the page body mounted (not just the layout banner).
    await expect(
      page.getByRole('main').getByRole('heading', { name: 'Outlet Management' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  /**
   * The page fetches /api/admin/outlets on mount and renders outlet rows.
   * Seed has 3 deoleo outlets (O001/O002/O003).  We wait for the stat chips to
   * resolve — their value is derived from the fetched list — then assert ≥1 outlet row.
   *
   * Data-agnostic on the count: the list may grow if other tests have added outlets.
   */
  test('shows ≥1 outlet row after the API call resolves', async ({ page }) => {
    await page.goto('/admin/users/outlets');
    // The Outlet Master tab is the default.  Wait for rows to appear.
    await expect(page.locator('[data-testid="outlet-row"]').first()).toBeVisible({ timeout: 12_000 });
  });

  test('stat chip "Total" shows a non-zero count (real outlets loaded)', async ({ page }) => {
    await page.goto('/admin/users/outlets');
    // Wait for the outlet list to load (API call resolves) before reading the stat chip.
    // The stat chips derive their value from the fetched outlet list.
    await expect(page.locator('[data-testid="outlet-row"]').first()).toBeVisible({ timeout: 12_000 });
    // Now the stat chip value has been updated from the API response.
    // The chip is a <button data-testid="stat-total-outlets"> containing the count <p> and label <p>.
    const totalChip = page.locator('[data-testid="stat-total-outlets"]');
    await expect(totalChip).toBeVisible({ timeout: 10_000 });
    // innerText of the button contains e.g. "3\nTotal" — extract the leading digit(s).
    const text = await totalChip.innerText();
    const count = parseInt(text.replace(/\D/g, ''), 10);
    expect(count, 'expected at least one outlet from the real DB').toBeGreaterThanOrEqual(1);
  });

  test('no clientb outlet appears (cross-tenant isolation)', async ({ page }) => {
    await page.goto('/admin/users/outlets');
    await expect(page.locator('[data-testid="outlet-row"]').first()).toBeVisible({ timeout: 12_000 });
    const body = await page.locator('body').innerText();
    for (const m of CLIENTB_MARKERS) {
      expect(body.includes(m), `cross-tenant leak: "${m}" on /admin/users/outlets`).toBe(false);
    }
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/users/outlets');
    await expectNoFabricatedData(page);
  });
});

// ─── /admin/outlets (legacy URL → should redirect to the live page) ─────────────
// The orphan Outlet Master page was replaced by a server-component redirect:
//   src/app/admin/outlets/page.tsx → redirect('/admin/users/outlets')
// INTENDED behaviour: visiting /admin/outlets lands on /admin/users/outlets.
//
// ⚠️ SUSPECTED REAL APP REGRESSION (not spec staleness): at runtime the redirect
// does NOT fire — the URL stays on /admin/outlets and the admin error boundary
// renders "This page couldn't load" (Reload / Back). Evidence: error-context for
// this test shows 23× received "http://localhost:3100/admin/outlets" + the error
// UI. The identical redirect() pattern in src/app/page.tsx (→ /auth/login) works,
// and every OTHER admin page renders fine, so the break is specific to a
// server-component redirect() page mounted under the 'use client' admin layout
// (src/app/admin/layout.tsx). Fix belongs in app source (out of scope for this
// test-only pass); the assertion below keeps the CORRECT intended behaviour and
// stays red until the redirect is fixed — it is deliberately NOT weakened to
// assert the broken error page (that would mask the regression).
test.describe('@clientAdmin /admin/outlets — legacy redirect', () => {
  test('redirects to /admin/users/outlets (orphan mock page removed)', async ({ page }) => {
    await page.goto('/admin/outlets');
    await expect(page).toHaveURL(/\/admin\/users\/outlets/);
  });
});
