import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN schemes page — `/admin/schemes`.
 *
 * Data source: GET /api/schemes (scoped to the authenticated client's schemes).
 *
 * Seed truth (api/prisma/seed.ts lines 744-745 — verified 2026-06-21):
 *   Scheme code "DEMO-VIS", name "Demo Visibility Scheme", status ACTIVE.
 *
 * Cross-tenant: clientb's schemes (if any) must NOT appear in this list.
 */

const CLIENTB_MARKERS = ['Zenith Trading Co', 'CPB001'];

test.describe('@clientAdmin schemes', () => {
  test('routes to /admin/schemes and is not bounced', async ({ page }) => {
    await page.goto('/admin/schemes');
    await expect(page).toHaveURL(/\/admin\/schemes/);
  });

  test('scheme list resolves (no eternal spinner)', async ({ page }) => {
    await page.goto('/admin/schemes');
    // Wait for the loading state to clear.
    await expect(page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'))).toHaveCount(0, {
      timeout: 12_000,
    });
  });

  test('shows the seeded scheme DEMO-VIS', async ({ page }) => {
    await page.goto('/admin/schemes');
    await expect(page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'))).toHaveCount(0, {
      timeout: 12_000,
    });
    // The scheme code renders in a <span> with the code text.
    await expect(page.getByText('DEMO-VIS')).toBeVisible({ timeout: 10_000 });
  });

  test('shows the seeded scheme name "Demo Visibility Scheme"', async ({ page }) => {
    await page.goto('/admin/schemes');
    await expect(page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'))).toHaveCount(0, {
      timeout: 12_000,
    });
    // Seed name is "Demo Visibility Scheme" (seed.ts line 745), NOT "Deoleo Visibility Q2 2026".
    await expect(page.getByText('Demo Visibility Scheme')).toBeVisible({ timeout: 10_000 });
  });

  test('Create New Scheme button / link is present (proves admin-scoped shell rendered)', async ({ page }) => {
    await page.goto('/admin/schemes');
    await expect(
      page.getByRole('link', { name: /Create.*Scheme/i }).or(
        page.getByRole('button', { name: /Create.*Scheme|New Scheme/i })
      )
    ).toBeVisible({ timeout: 10_000 });
  });

  test('no clientb scheme leaks', async ({ page }) => {
    await page.goto('/admin/schemes');
    await expect(page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'))).toHaveCount(0, {
      timeout: 12_000,
    });
    const body = await page.locator('body').innerText();
    for (const m of CLIENTB_MARKERS) {
      expect(body.includes(m), `cross-tenant leak: "${m}" on /admin/schemes`).toBe(false);
    }
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/schemes');
    await expect(page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'))).toHaveCount(0, {
      timeout: 12_000,
    });
    await expectNoFabricatedData(page);
  });
});
