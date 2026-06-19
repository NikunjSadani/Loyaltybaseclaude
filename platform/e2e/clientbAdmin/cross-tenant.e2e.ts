import { test, expect } from '@playwright/test';

/**
 * REVERSE cross-tenant isolation (#52 bidirectional, unblocked by #39). The clientb admin logs in via
 * the dev clientId override and must see ONLY clientb's data — never deoleo's. Together with the
 * deoleo→clientb spec (clientAdmin/cross-tenant), this proves isolation in BOTH directions.
 */
const DEOLEO_MARKERS = ['Test Wholesale Co', 'CP001', 'O001', 'Test Wholesaler'];

test.describe('@clientbAdmin reverse cross-tenant isolation (#52)', () => {
  test('the /api/admin/outlets response has clientb rows, NOT deoleo (backend scoping, reverse)', async ({ page }) => {
    const resP = page.waitForResponse(
      (r) => r.url().includes('/api/admin/outlets') && r.request().method() === 'GET',
      { timeout: 15_000 },
    );
    await page.goto('/admin/users/outlets');
    const res = await resP;
    const text = await res.text();

    // Sanity: the response carries clientb's own data (so the leak-check is meaningful).
    expect(text).toContain('OB001'); // clientb's outlet code

    for (const m of DEOLEO_MARKERS) {
      expect(
        text.includes(m),
        `TENANT LEAK: deoleo "${m}" returned by /api/admin/outlets for a clientb admin`,
      ).toBe(false);
    }
  });

  test('dashboard active-partners count is clientb-scoped (1, not 3)', async ({ page }) => {
    await page.goto('/admin/dashboard');
    const value = page
      .locator('p', { hasText: /^Total Active Partners$/ })
      .locator('xpath=preceding-sibling::p[1]');
    // clientb has exactly 1 partner (CPB001); a cross-tenant leak would show 3 (incl. deoleo's 2).
    await expect(value).toHaveText('1', { timeout: 10_000 });
  });
});
