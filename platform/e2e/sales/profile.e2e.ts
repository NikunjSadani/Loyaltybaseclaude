import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * SALES_SO profile — DATA-VISIBILITY `/sales/profile` (S3 read slice).
 *
 * API route: GET /api/auth/me  →  FE uses authHeader() and maps the user object to SalesProfile.
 *
 * Seed ground truth:
 *   seed-su-1 — name includes "Sales Officer" or the seeded name, employeeCode = EMP001,
 *   phone = 9000000003, reports to seed-su-mgr (EMPASM1).
 *
 * What we assert:
 *   1. Page renders the "My Profile" heading.
 *   2. GET /api/auth/me returns the real SO identity (name, employeeCode EMP001).
 *   3. The employee code EMP001 is visible on the rendered page (no fabricated identity).
 *   4. No fabricated demo values surface (#40).
 */
const SO_EMPLOYEE_CODE = 'EMP001';

test.describe('@sales profile', () => {
  test('routes to /sales/profile and renders the My Profile heading', async ({ page }) => {
    await page.goto('/sales/profile');
    await expect(page).toHaveURL(/\/sales\/profile/);
    await expect(
      page.getByRole('heading', { name: /my profile/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('GET /api/auth/me returns the real SO identity (EMP001)', async ({ page }) => {
    await page.goto('/sales/profile');
    const token = await cookieToken(page);
    expect(token, 'SALES_SO must be logged in').toBeTruthy();

    const res = await page.request.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status(), 'GET /api/auth/me must succeed').toBe(200);

    const body = await res.json();
    expect(body.success, 'response must have success:true').toBe(true);

    const user = body.data?.user;
    expect(user, 'user object must be present').toBeTruthy();
    expect(user.salesUser?.employeeCode, 'employee code must be EMP001').toBe(SO_EMPLOYEE_CODE);
  });

  test('profile page renders the real employee code EMP001 (not a demo placeholder)', async ({
    page,
  }) => {
    await page.goto('/sales/profile');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(SO_EMPLOYEE_CODE)).toBeVisible({ timeout: 10_000 });
  });

  test('renders no fabricated values (#40)', async ({ page }) => {
    await page.goto('/sales/profile');
    await expectNoFabricatedData(page);
  });
});
