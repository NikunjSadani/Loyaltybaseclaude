import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * SALES_SO outlets — DATA-VISIBILITY `/sales/outlets` (S3 read slice).
 *
 * API route: GET /api/sales/outlets  →  FE fetches /api/sales/outlets with Bearer token from
 * localStorage.  Seed ground truth: seed-su-1 (EMP001, phone 9000000003) is assigned to two
 * deoleo outlets — O001 (partner CP001) and O002 (partner CP002).  No other SO's outlets must
 * appear (scope guard).
 *
 * What we assert:
 *   1. Page routes to /sales/outlets and renders the Outlets heading.
 *   2. API returns exactly the two assigned outlet codes (O001, O002) — real scoped data.
 *   3. No other SO's outlet codes appear in the API response (scope, not leaking neighbours).
 *   4. No fabricated demo values surface in the rendered page (#40).
 */

const ASSIGNED_OUTLETS = ['O001', 'O002'];

test.describe('@sales outlets', () => {
  test('routes to /sales/outlets and renders the Outlets heading', async ({ page }) => {
    await page.goto('/sales/outlets');
    await expect(page).toHaveURL(/\/sales\/outlets/);
    await expect(page.getByRole('heading', { name: /outlets/i }).first()).toBeVisible();
  });

  test('API returns scoped outlets (O001 + O002 only) for the SO', async ({ page }) => {
    await page.goto('/sales/outlets');

    // Grab the token from localStorage after the page loaded (same origin).
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'SALES_SO must be logged in').toBeTruthy();

    const res = await page.request.get('/api/sales/outlets', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status(), 'GET /api/sales/outlets must succeed').toBe(200);

    const body = await res.json();
    expect(body.success, 'response must have success:true').toBe(true);

    const codes: string[] = (body.data?.outlets ?? []).map((o: { outletCode: string }) => o.outletCode);

    // Must contain both assigned outlets.
    for (const code of ASSIGNED_OUTLETS) {
      expect(codes, `assigned outlet ${code} must be present`).toContain(code);
    }

    // Must not contain outlet codes from a different SO's scope.
    // The seed only assigns O001 + O002 to this SO, so any extra code is a scope leak.
    const unexpected = codes.filter((c) => !ASSIGNED_OUTLETS.includes(c));
    expect(
      unexpected.length,
      `scope leak: outlet codes ${unexpected.join(', ')} returned but not assigned to this SO`,
    ).toBe(0);
  });

  test('renders no fabricated values (#40)', async ({ page }) => {
    await page.goto('/sales/outlets');
    await expectNoFabricatedData(page);
  });
});
