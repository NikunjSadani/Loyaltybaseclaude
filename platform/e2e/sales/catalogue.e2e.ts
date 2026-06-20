import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * SALES_SO catalogue — DATA-VISIBILITY `/sales/catalogue`: the sales-assisted redemption catalogue.
 *
 * Regression guard for the A4 catalog-gate fix that B1 needed: a SALES_SO must NOT be 403'd from the
 * gift catalogue (the catalog read is granted to sales so they can run assisted redemptions). This
 * asserts the catalogue PAGE renders for the sales role — heading + search scaffold. It does NOT
 * attempt a redeem (that mutates a wallet and needs an assigned outlet; the write path lands with the
 * write-persistence helper, S4).
 */
test.describe('@sales catalogue', () => {
  test('routes to the catalogue (authed, not bounced)', async ({ page }) => {
    await page.goto('/sales/catalogue');
    await expect(page).toHaveURL(/\/sales\/catalogue/);
  });

  test('renders the gift catalogue for a sales user (not 403)', async ({ page }) => {
    await page.goto('/sales/catalogue');
    // The catalogue header is rendered regardless of the loading state — its presence proves the
    // sales role reached the catalogue surface (not a forbidden/redirect shell).
    await expect(page.getByRole('heading', { name: /gift catalogue/i })).toBeVisible();
    // After the catalog fetch resolves, the search box renders — the catalogue scaffold proper. The
    // placeholder uses a unicode ellipsis ("Search gifts…"), so match on the "Search gifts" prefix.
    await expect(page.getByPlaceholder(/search gifts/i)).toBeVisible();
  });

  test('renders no fabricated values (#40)', async ({ page }) => {
    await page.goto('/sales/catalogue');
    await expectNoFabricatedData(page);
  });
});
