import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * B3 / gap #49 — the gifsy Platform Overview (`/gifsy`) now reads the REAL `clients` table via
 * GET /api/gifsy/overview (was the static lib/platform/client-registry mock). This asserts the
 * operator sees the real status tallies + real client cards at runtime, through the :3000 proxy
 * with a real GIFSY session (storageState from setup/auth.setup.ts).
 *
 * Seeded gifsy_dev truth (verified 2026-06-19):
 *   - 2 clients total: Deoleo India (ACTIVE) + Client B Loyalty (ONBOARDING); 1 active, 1 onboarding, 0 inactive.
 *   - Deoleo card:   "Deoleo India"        · deoleo.gifsy.in   · 4/5 modules on  · ACTIVE
 *   - Client B card: "Zenith Rewards (DB)" · clientb.gifsy.in  · 3/5 modules on  · ONBOARDING
 *     (clientb's display name comes from the DB branding blob — seed.ts §clientb, displayName
 *      'Zenith Rewards (DB)'; it is deliberately distinct from the slug to prove DB-backed branding.)
 * The card metric is "N/M modules on" — the retired registry "N classes / N features" string must NOT appear.
 */
test.describe('@gifsy Platform Overview (B3 / #49)', () => {
  test('shows the real status tallies for the operator', async ({ page }) => {
    await page.goto('/gifsy');
    await expect(page).toHaveURL(/\/gifsy(\/|$)/);
    await expect(page.getByRole('heading', { name: /Platform Overview/i })).toBeVisible();

    // Each stat tile is `<div><p>{value}</p><p>{label}</p></div>`. Locate the INNERMOST div that
    // contains the label (`.last()` = tightest ancestor) so the value `<p>` we assert belongs to THIS
    // tile, not a sibling tile sharing the same digit. This binds value↔label, avoiding a false pass
    // where e.g. "1" from another tile satisfies the check.
    const tile = (label: string) =>
      page.locator('div', { has: page.getByText(label, { exact: true }) }).last();

    await expect(tile('Total Clients')).toContainText('2');
    await expect(tile('Active')).toContainText('1');
    await expect(tile('Onboarding')).toContainText('1');
    await expect(tile('Inactive')).toContainText('0');
  });

  test('lists the real client cards (Deoleo ACTIVE, Client B ONBOARDING)', async ({ page }) => {
    await page.goto('/gifsy');

    // Deoleo India — ACTIVE, deoleo.gifsy.in, 4/5 modules on.
    const deoleoCard = page.locator('a[href="/gifsy/clients/deoleo"]');
    await expect(deoleoCard).toBeVisible();
    await expect(deoleoCard).toContainText('Deoleo India');
    await expect(deoleoCard).toContainText('deoleo.gifsy.in');
    await expect(deoleoCard).toContainText('4/5 modules on');
    await expect(deoleoCard).toContainText('ACTIVE');

    // Client B — ONBOARDING, clientb.gifsy.in, 3/5 modules on. Its display name is the DB-branding
    // value "Zenith Rewards (DB)" (distinct from the slug), proving the card reads real DB branding.
    const clientbCard = page.locator('a[href="/gifsy/clients/clientb"]');
    await expect(clientbCard).toBeVisible();
    await expect(clientbCard).toContainText('Zenith Rewards (DB)');
    await expect(clientbCard).toContainText('clientb.gifsy.in');
    await expect(clientbCard).toContainText('3/5 modules on');
    await expect(clientbCard).toContainText('ONBOARDING');
  });

  test('renders the real "modules on" metric, NOT the retired registry "classes / features" text', async ({ page }) => {
    await page.goto('/gifsy');
    await expect(page.getByText('4/5 modules on')).toBeVisible();

    // The retired CLIENT_REGISTRY metric ("N classes" / "N features") must be gone from the cards.
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    expect(body, 'retired "N classes" registry metric must not appear').not.toMatch(/\d+\s+classes\b/i);
    expect(body, 'retired "N features" registry metric must not appear').not.toMatch(/\d+\s+features\b/i);

    // And no known demo/fabricated value (#40 fail-list).
    await expectNoFabricatedData(page);
  });
});
