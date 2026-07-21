import { test, expect } from '@playwright/test';

/**
 * B3 / gap #49 — the per-client detail (`/gifsy/clients/:slug`) now reads the REAL `clients` table
 * via GET /api/gifsy/clients/:slug (was the static lib/platform/client-registry mock). This asserts
 * the operator sees real branding at runtime AND — critically — that NO MSG91 secret is ever sent to
 * the browser (the backend omits msg91AuthKey; the page shows a masked placeholder only).
 *
 * Seeded gifsy_dev truth for deoleo (verified 2026-06-19):
 *   displayName "Deoleo India" · internalName "Deoleo India Pvt. Ltd." · deoleo.gifsy.in
 *   product brands "Bertolli, Figaro" · support email support@deoleo.gifsy.in
 */
test.describe('@gifsy client detail (B3 / #49)', () => {
  test('shows the real branding for deoleo', async ({ page }) => {
    await page.goto('/gifsy/clients/deoleo');
    await expect(page).toHaveURL(/\/gifsy\/clients\/deoleo/);

    // Header — display name as the heading, internalName + subdomain beneath it.
    await expect(page.getByRole('heading', { name: 'Deoleo India' })).toBeVisible();
    // The subdomain now appears in 3 places (the header line + the §A-DOMAIN "Domains" list rows),
    // so a bare exact-text match is a strict-mode violation. Scope to the HEADER paragraph
    // (`{internalName} · <slug>.gifsy.in`) — this asserts the real branding header specifically and
    // still excludes the support@deoleo.gifsy.in email text.
    await expect(
      page.getByRole('paragraph').filter({ hasText: 'Deoleo India Pvt. Ltd.' }),
    ).toContainText('deoleo.gifsy.in');

    // Product Brands section is open by default. The real seeded brands now render as INDIVIDUAL
    // chips (one <span> per brand), not a single joined "Bertolli, Figaro" string — so assert each
    // brand chip. This still proves the real DB branding (api/prisma/seed.ts sets ["Bertolli","Figaro"]).
    await expect(page.getByText('Bertolli', { exact: true })).toBeVisible();
    await expect(page.getByText('Figaro', { exact: true })).toBeVisible();

    // Support email now lives as an EDITABLE field in the "Client settings" section (an <input>, not
    // free text), so assert its value rather than getByText (which never matches an input value).
    await expect(page.getByTestId('support-email-input')).toHaveValue('support@deoleo.gifsy.in');
  });

  test('NEVER leaks an MSG91 secret / API key to the browser', async ({ page }) => {
    await page.goto('/gifsy/clients/deoleo');
    await expect(page.getByRole('heading', { name: 'Deoleo India' })).toBeVisible();

    // The "Notifications (MSG91)" section HEADER is fine — it's the actual key value that must be absent.
    await expect(page.getByText('Notifications (MSG91)')).toBeVisible();

    // No raw secret in the rendered text the operator sees.
    const body = (await page.locator('body').innerText());
    expect(body, 'no raw "authKey" / API key value rendered').not.toContain('msg91AuthKey');

    // The REAL leak test: the API response the browser actually received must NOT carry the
    // secret. (We assert the response body, NOT page.content() — the latter includes the bundled
    // editor-component source, where "msg91AuthKey" legitimately appears as an input field name.)
    const apiBody = await page.evaluate(async () => {
      // AF-6: this same-origin fetch carries the GIFSY httpOnly `token` cookie automatically and the
      // proxy authenticates from it (any Authorization header is stripped) — no explicit Bearer needed.
      const r = await fetch('/api/gifsy/clients/deoleo');
      return r.text();
    });
    expect(apiBody, 'backend must not send msg91AuthKey to the browser').not.toContain('msg91AuthKey');
    expect(apiBody.toLowerCase(), 'backend must not send any authKey value').not.toContain('authkey');
  });
});
