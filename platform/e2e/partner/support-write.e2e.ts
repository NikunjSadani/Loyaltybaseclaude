import { test, expect } from '@playwright/test';
import { uniqueMarker, expectPersistsAfterReload } from '../helpers/persist';

/**
 * Write-persistence (S4) — the harness's first act→persist→re-read test. A partner raises a support
 * ticket through the real form (POST /api/tickets); the proof is that it survives a FULL page reload,
 * which re-fetches GET /api/tickets from the backend — so it actually persisted to the DB, not just
 * optimistic UI state. (Each run creates one ticket in gifsy_dev; the unique marker keeps it
 * unambiguous. Read tests prove pages SHOW real data; this proves a write STICKS.)
 */
test.describe('@partner support write-persistence (S4)', () => {
  test('raising a ticket persists (survives reload → backend re-fetch)', async ({ page }) => {
    const subject = uniqueMarker('E2E-persist');

    await page.goto('/partner/support');
    await page.getByRole('button', { name: /new ticket/i }).click();

    // Scope all form interactions to the modal — a "Billing Issue" category button also appears on
    // EXISTING tickets in the list (accumulated across runs), so an unscoped selector is ambiguous.
    const modal = page.locator('div.rounded-t-2xl', { hasText: 'New Support Ticket' });
    await modal.getByRole('button', { name: /Billing Issue/i }).click();
    await modal.getByPlaceholder(/briefly describe your issue/i).fill(subject);
    await modal.getByPlaceholder(/provide more details/i).fill('Created by the E2E write-persistence test.');
    await modal.getByRole('button', { name: /submit ticket/i }).click();

    // Optimistically prepended to the list…
    await expect(page.getByText(subject).first()).toBeVisible({ timeout: 10_000 });

    // …and PROVEN persisted: a full reload re-reads from the backend and the ticket is still there.
    await expectPersistsAfterReload(page, subject);
  });
});
