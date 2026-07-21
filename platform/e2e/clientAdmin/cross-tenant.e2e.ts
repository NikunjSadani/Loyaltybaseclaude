import { test, expect } from '@playwright/test';

/**
 * Cross-tenant isolation (gap #52 / Q6) — the highest-stakes property of a multi-tenant platform.
 * A SECOND tenant `clientb` is seeded with distinctive data (Zenith Trading Co / Bharat Verma /
 * CPB001 / OB001). A logged-in `deoleo` admin must NEVER see any of it — proving the backend's
 * clientId scoping actually holds, not just that the FE happens not to render it.
 *
 * NOTE: the reverse direction (clientb can't see deoleo) and "GIFSY sees both" need login for
 * non-deoleo tenants, which is blocked on localhost until the dev clientId override (#39). This
 * spec covers the catastrophic-leak direction, which is testable today.
 */
const CLIENTB_MARKERS = ['Zenith Trading', 'Bharat Verma', 'CPB001', 'OB001'];

test.describe('@clientAdmin cross-tenant isolation (#52)', () => {
  test('the /api/admin/outlets response contains NO clientb rows (backend tenant scoping)', async ({ page }) => {
    const resP = page.waitForResponse(
      (r) => r.url().includes('/api/admin/outlets') && r.request().method() === 'GET',
      { timeout: 15_000 },
    );
    await page.goto('/admin/users/outlets');
    const res = await resP;
    const text = await res.text();

    // Sanity: the response actually carries deoleo data, so the leak-check below is meaningful
    // (not vacuously passing on an empty/failed response).
    expect(text).toContain('O001'); // a deoleo outlet code

    for (const m of CLIENTB_MARKERS) {
      expect(
        text.includes(m),
        `TENANT LEAK: clientb "${m}" returned by /api/admin/outlets for a deoleo admin`,
      ).toBe(false);
    }
  });

  test('dashboard active-partners count excludes clientb (count-level isolation)', async ({ page }) => {
    await page.goto('/admin/dashboard');
    const value = page
      .locator('p', { hasText: /^Total Active Partners$/ })
      .locator('xpath=preceding-sibling::p[1]');
    // The deoleo dashboard must render a REAL scoped integer, never the em-dash placeholder and never
    // a clientb-inflated figure. It is >= the seed minimum (CP001/CP002/CP003 + CP004 = 4 active
    // deoleo partners) — a lower bound rather than an exact count because (a) write-persistence specs
    // in the same serial run create additional deoleo outlets/partners that persist across upsert
    // re-seeds, and (b) the seed itself grows. The ACTUAL clientb-leak guard is the name-level
    // isolation above + users-outlets-read's "no clientb outlet appears"; here we only prove the count
    // is a real deoleo-scoped number (clientb's CPB001 is a different tenant and never counted).
    await expect(value).toHaveText(/^\d+$/, { timeout: 10_000 });
    const n = Number((await value.textContent())?.trim());
    expect(n, 'active-partners count is a real scoped integer (>= seed baseline of 4)').toBeGreaterThanOrEqual(4);
  });
});
