import { test, expect, type Page } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * Partner visibility invoices (B2) — `/partner/invoices`: the retailer's own self-bill invoice list.
 *
 * KEY REGRESSION GUARD (the list-shape fix): GET /api/partner/invoices returns
 * `{ invoices, pagination }`; the page reads `res.data.invoices` (not `res.data` as an array). Before
 * the fix `.map` ran on a non-array → "map is not a function" crash. In dev the list is EMPTY (no
 * seeded payouts), so the correct shape renders the "No invoices yet" empty state — never a crash.
 *
 * ⚠️ FLAKINESS NOTE (gap #45 / D1): the partner shell Sidebar has a KNOWN pre-existing React hydration
 * warning. We do NOT assert "zero page errors" (that would be flaky against unrelated noise) — the
 * crash guard is SCOPED to the list-shape signature only ("is not a function"), and content assertions
 * are scoped to the invoice page body, not the shell.
 */

/** Collect uncaught page errors but only judge the list-shape signature — ignores the known #45 noise. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

function assertNoListShapeCrash(errors: string[]): void {
  const mapCrash = errors.filter((m) => /is not a function/i.test(m));
  expect(mapCrash, `uncaught list-shape crash on partner invoices: ${mapCrash.join(' | ')}`).toEqual([]);
}

test.describe('@partner visibility invoices (B2)', () => {
  test('renders the header, the Tech Gifsy self-bill explainer, and the empty state', async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto('/partner/invoices');
    await expect(page).toHaveURL(/\/partner\/invoices/);

    // Header — proves the page mounted (not bounced / not stuck on the spinner).
    await expect(page.getByRole('heading', { name: 'My Invoices' })).toBeVisible();

    // The self-bill explainer banner names the Gifsy entity that raises the invoices on the partner's
    // behalf (the runtime-verified copy uses the full legal name "Tech Gifsy Solutions Limited").
    await expect(page.getByText(/Tech Gifsy Solutions Limited/i)).toBeVisible();

    // The list-shape regression guard: the success branch rendered the empty state, not a crash.
    await expect(page.getByText('No invoices yet')).toBeVisible();

    assertNoListShapeCrash(errors);
  });

  test('renders no fabricated values (#40)', async ({ page }) => {
    await page.goto('/partner/invoices');
    await expectNoFabricatedData(page);
  });
});
