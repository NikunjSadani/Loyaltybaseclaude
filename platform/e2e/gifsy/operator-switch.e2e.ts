import { test, expect } from '@playwright/test';

/**
 * A2-FE (#51) — the operator-context switcher, end-to-end through the real UI.
 * A GIFSY operator opens "Work in brand ▾" in the console, picks a brand → the FE
 * exchanges the gifsy session for a tenant-scoped token (POST /api/auth/assume-tenant),
 * lands in the admin shell, and a persistent "Working in <Brand>" banner shows. "Exit"
 * restores the platform (gifsy) session. Proves the whole switch round-trips at runtime.
 */
test.describe('@gifsy operator-context switcher (A2-FE / #51)', () => {
  test('switch into a brand → admin shell + banner; exit → back to platform', async ({ page }) => {
    await page.goto('/gifsy');

    // Open the switcher and pick Deoleo.
    await page.getByRole('button', { name: /work in brand/i }).click();
    const deoleo = page.getByRole('button', { name: /deoleo/i }).first();
    await expect(deoleo).toBeVisible({ timeout: 10_000 });
    await deoleo.click();

    // Lands in the admin shell, the assumed token is stored, the banner shows.
    await page.waitForURL(/\/admin\//, { timeout: 15_000 });
    const assumed = await page.evaluate(() => localStorage.getItem('assumedBrand'));
    expect(assumed, 'assumedBrand stored').toMatch(/deoleo/i);
    const homeStashed = await page.evaluate(() => localStorage.getItem('homeToken'));
    expect(homeStashed, 'home (gifsy) token stashed for exit').toBeTruthy();
    await expect(page.getByText(/working in/i)).toBeVisible();

    // Exit restores the platform context (home token back, banner gone).
    await page.getByRole('button', { name: /exit to platform/i }).click();
    await page.waitForURL(/\/gifsy/, { timeout: 15_000 });
    const after = await page.evaluate(() => localStorage.getItem('assumedBrand'));
    expect(after, 'assumedBrand cleared on exit').toBeNull();
  });
});
