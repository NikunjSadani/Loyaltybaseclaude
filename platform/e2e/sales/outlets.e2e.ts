import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * SALES_SO outlets — DATA-VISIBILITY `/sales/outlets` (S3 read slice).
 *
 * API route: GET /api/sales/outlets  →  FE fetches /api/sales/outlets with Bearer token from
 * localStorage.  Seed ground truth: seed-su-1 (EMP001, phone 9000000003) is DIRECTLY assigned to
 * two deoleo outlets — O001 (seed-sa-1, partner CP001) and O002 (seed-sa-2, partner CP002).
 *
 * SCOPE MODEL: getMyOutlets (api/src/sales/sales.service.ts:447) resolves the caller's WHOLE
 * descendant subtree (descendantSalesUserIds) and returns every assigned outlet in it — not just
 * the SO's own two. So a runtime-created downline rep (e.g. an ISR reporting to this SO) legitimately
 * contributes its outlet to this response. We therefore CANNOT assert "exactly O001+O002" — that
 * would false-fail on legitimate downline growth. Instead we assert the two seeded assigned outlets
 * are present AND that two KNOWN out-of-scope outlets never leak:
 *   - O003 (seed-o-3, partner CP003/seed-cp-3) — SAME tenant (deoleo) but NOT in this SO's downline
 *     (no SalesUserAssignment to seed-su-1's subtree). Proves the subtree scope isn't over-broad to
 *     the whole tenant.
 *   - OB001 (seed-ob-1) — a clientb outlet. Proves cross-tenant isolation (#41).
 *
 * What we assert:
 *   1. Page routes to /sales/outlets and renders the Outlets heading.
 *   2. API returns the two assigned outlet codes (O001, O002) — real scoped data.
 *   3. No out-of-scope outlet leaks: O003 (non-downline, same tenant) and OB001 (other tenant) absent.
 *   4. No fabricated demo values surface in the rendered page (#40).
 */

const ASSIGNED_OUTLETS = ['O001', 'O002'];
/** Known out-of-scope outlet codes that must NEVER appear for this SO. */
const OUT_OF_SCOPE_OUTLETS = ['O003', 'OB001'];

test.describe('@sales outlets', () => {
  test('routes to /sales/outlets and renders the Outlets heading', async ({ page }) => {
    await page.goto('/sales/outlets');
    await expect(page).toHaveURL(/\/sales\/outlets/);
    await expect(page.getByRole('heading', { name: /outlets/i }).first()).toBeVisible();
  });

  test('API returns scoped outlets (O001 + O002 only) for the SO', async ({ page }) => {
    await page.goto('/sales/outlets');

    // Grab the token from localStorage after the page loaded (same origin).
    const token = await cookieToken(page);
    expect(token, 'SALES_SO must be logged in').toBeTruthy();

    const res = await page.request.get('/api/sales/outlets', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status(), 'GET /api/sales/outlets must succeed').toBe(200);

    const body = await res.json();
    expect(body.success, 'response must have success:true').toBe(true);

    const codes: string[] = (body.data?.outlets ?? []).map((o: { outletCode: string }) => o.outletCode);

    // Must contain both directly-assigned outlets.
    for (const code of ASSIGNED_OUTLETS) {
      expect(codes, `assigned outlet ${code} must be present`).toContain(code);
    }

    // Must NOT contain any known out-of-scope outlet. O003 is same-tenant but not in this
    // SO's downline subtree; OB001 belongs to clientb. Either appearing is a real scope/
    // tenant-isolation leak (#41). Additional in-tenant DOWNLINE outlets (e.g. runtime-created
    // ISR outlets) are legitimately in scope per the whole-subtree model and are NOT asserted against.
    for (const code of OUT_OF_SCOPE_OUTLETS) {
      expect(
        codes,
        `scope leak: out-of-scope outlet ${code} returned to this SO`,
      ).not.toContain(code);
    }
  });

  test('renders no fabricated values (#40)', async ({ page }) => {
    await page.goto('/sales/outlets');
    await expectNoFabricatedData(page);
  });
});
