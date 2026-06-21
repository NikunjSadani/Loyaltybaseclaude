import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * CLIENT_ADMIN tickets page — `/admin/tickets`.
 *
 * Data source: GET /api/tickets (scoped to the authenticated client's tickets).
 *
 * Seed truth (api/prisma/seed.ts line ~495):
 *   Ticket DEO-0001, subject "Payout Delay – Q4 2025", category PAYOUT,
 *   created by `seed-deoleo-partner` (CP001 / O001).
 *
 * The page maps the backend shape onto a local Ticket type — ticketNumber is
 * used as the display identifier.
 *
 * Cross-tenant: clientb has NO seeded tickets, so a clientb ticket number
 * (if it ever appeared) would be a scope leak.
 */

test.describe('@clientAdmin tickets', () => {
  test('routes to /admin/tickets and is not bounced', async ({ page }) => {
    await page.goto('/admin/tickets');
    await expect(page).toHaveURL(/\/admin\/tickets/);
  });

  test('the ticket list resolves (no eternal spinner)', async ({ page }) => {
    await page.goto('/admin/tickets');
    // The page shows a spinner while fetching, then the table or empty state.
    await expect(page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'))).toHaveCount(0, {
      timeout: 12_000,
    });
  });

  test('shows the seeded ticket DEO-0001', async ({ page }) => {
    await page.goto('/admin/tickets');
    // Wait for any spinner to clear before asserting the ticket number.
    await expect(page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'))).toHaveCount(0, {
      timeout: 12_000,
    });
    // ticketNumber DEO-0001 is rendered in a <p class="font-mono"> inside the ticket row.
    await expect(page.getByText('DEO-0001')).toBeVisible({ timeout: 10_000 });
  });

  test('no fabricated values (#40)', async ({ page }) => {
    await page.goto('/admin/tickets');
    // Allow spinner to clear first so the body reflects the loaded state.
    await expect(page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'))).toHaveCount(0, {
      timeout: 12_000,
    });
    await expectNoFabricatedData(page);
  });
});
