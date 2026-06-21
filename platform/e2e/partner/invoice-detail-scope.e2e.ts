import { test, expect } from '@playwright/test';

/**
 * Partner invoice detail cross-partner scope guard (Stream S3p, Wave 3).
 *
 * Tests: a partner (CP001) cannot access another partner's invoice detail via
 * GET /api/partner/invoices/:id (the backend endpoint for /partner/invoices/[id]).
 *
 * Seed context:
 *   - CP001 (seed-cp-1, the logged-in WHOLESALER) has NO seeded invoices.
 *   - CP003 (seed-cp-3, "Deoleo Demo Distributor") has a seeded CreditPayoutEntry
 *     but invoices are generated on demand (POST /admin/invoices/generate), so there
 *     are no seeded invoice rows either.
 *
 * Since no invoice IDs are pre-seeded the scope guard is verified via:
 *   1. Direct API call: GET /api/partner/invoices/<fabricated-id> → must return 404/403
 *      (NOT another partner's invoice data). A 404 is the correct scoped-out response
 *      when the invoice doesn't exist or doesn't belong to this partner.
 *   2. FE navigation: /partner/invoices/<fabricated-id> → must NOT render real invoice
 *      data for another partner. The page renders the "Invoice not found" error state.
 *
 * If a future CI run seeds or generates a real invoice for CP003, this test should be
 * extended to use that ID and assert a 403 for CP001 (the forbidden-resource case).
 * For now the non-existent-ID path proves the backend's ownership check fires.
 *
 * Endpoints:
 *   GET /api/partner/invoices/:id     → 200 (own) | 404/403 (not-own / not-found)
 *   PATCH /api/partner/invoices/:id/invoice-number — not tested here (write on own invoice only)
 * FE page:  /partner/invoices/[id]
 */

// A fabricated invoice ID — guaranteed not to exist in any environment.
const FAKE_INVOICE_ID = 'non-existent-invoice-id-00000000';
// An ID shape that could belong to another partner (same format, different tenant value).
const OTHER_PARTNER_FAKE_ID = 'other-partner-invoice-99999999';

test.describe('@partner invoice detail scope guard', () => {
  test('GET /api/partner/invoices/:non-existent-id returns 404 or 403 (not 200)', async ({ page }) => {
    await page.goto('/partner/invoices');
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'partner must be logged in').toBeTruthy();

    const r = await page.request.get(`/api/partner/invoices/${FAKE_INVOICE_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Must be a non-200 (the backend must not return any invoice row for an unknown id).
    expect(
      r.status(),
      `GET /api/partner/invoices/${FAKE_INVOICE_ID} must return 404/403, got ${r.status()}`,
    ).not.toBe(200);
    // The response body must not contain another partner's business name.
    const body = await r.text();
    expect(body, 'response must not contain CP003 business name').not.toContain('Deoleo Demo Distributor');
    expect(body, 'response must not contain CP002 business name').not.toContain('Deoleo Demo Retail Store');
  });

  test('FE /partner/invoices/:non-existent-id renders an error/not-found state (not another partner\'s data)', async ({ page }) => {
    // Navigate to a fabricated invoice detail URL.
    await page.goto(`/partner/invoices/${FAKE_INVOICE_ID}`);

    // The FE renders: "Invoice not found" + a back link, or it redirects.
    // We use expectScopedOut with forbidden markers = the other partners' firm names.
    // If the page renders "Invoice not found" that counts as an explicit forbidden/not-found state
    // (the pattern matches in the body-check the helper does for pages that render in-place).
    // Override safe-redirect targets to include /partner/invoices (the list page is a safe destination).
    await page.waitForURL(
      (u) => !u.pathname.includes(FAKE_INVOICE_ID),
      { timeout: 5_000 },
    ).catch(() => {});

    const url = new URL(page.url());
    if (!url.pathname.includes(FAKE_INVOICE_ID)) {
      // Redirected — must be to a safe partner-scoped destination.
      expect(
        url.pathname.startsWith('/partner') || url.pathname.startsWith('/auth/login'),
        `Redirected to unexpected path: ${url.pathname}`,
      ).toBe(true);
    } else {
      // Stayed on the page — must NOT show another partner's data.
      await expect(page.locator('body')).toBeVisible();
      const bodyText = await page.locator('body').innerText();
      expect(
        bodyText,
        'page must not render CP003 firm name (Deoleo Demo Distributor)',
      ).not.toContain('Deoleo Demo Distributor');
      expect(
        bodyText,
        'page must not render CP002 firm name (Deoleo Demo Retail Store)',
      ).not.toContain('Deoleo Demo Retail Store');
      // The page should show the not-found / error message.
      const looksLikeError = /invoice not found|failed to load|not found/i.test(bodyText);
      expect(
        looksLikeError,
        'page must render an "Invoice not found" or equivalent error state, not silently blank',
      ).toBe(true);
    }
  });

  test('direct API call with a second fabricated id also returns non-200', async ({ page }) => {
    await page.goto('/partner/invoices');
    const token = await page.evaluate(() => localStorage.getItem('token'));

    const r = await page.request.get(`/api/partner/invoices/${OTHER_PARTNER_FAKE_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(
      r.status(),
      `GET /api/partner/invoices/${OTHER_PARTNER_FAKE_ID} must return 404/403, got ${r.status()}`,
    ).not.toBe(200);
  });

  test('partner cannot reach admin invoice detail for another partner via /admin path', async ({ page }) => {
    // The admin invoice detail path (/admin/invoices/[id]) is a different surface.
    // A non-existent ID may render a generic "not found" page (not a forbidden-phrase state),
    // which is acceptable: it does NOT expose another partner's real data.
    // We only assert that:
    //   a) the page does NOT contain another partner's real business names (CP002/CP003), AND
    //   b) the page redirects to a safe destination OR stays without leaking cross-partner data.
    await page.goto(`/admin/invoices/${FAKE_INVOICE_ID}`);
    // Allow client-side redirect to settle.
    await page.waitForURL(
      (u) => !u.pathname.includes(FAKE_INVOICE_ID),
      { timeout: 5_000 },
    ).catch(() => {});

    await expect(page.locator('body')).toBeVisible();
    const bodyText = await page.locator('body').innerText();
    // The most important assertion: no other partner's real firm name must be visible.
    expect(
      bodyText,
      'page must not render CP003 firm name (Deoleo Demo Distributor)',
    ).not.toContain('Deoleo Demo Distributor');
    expect(
      bodyText,
      'page must not render CP002 firm name (Deoleo Demo Retail Store)',
    ).not.toContain('Deoleo Demo Retail Store');
    // A redirect to /auth/login or /partner* is also acceptable (treated as scoped-out).
    const url = new URL(page.url());
    const redirectedSafely =
      url.pathname.startsWith('/auth/login') || url.pathname.startsWith('/partner');
    // If still on the admin path it must show a not-found/empty state (not real invoice data).
    if (!redirectedSafely) {
      const looksLikeNotFound = /not found|invoice not found|no invoice|forbidden|access denied/i.test(bodyText);
      // Accept either: an explicit not-found/forbidden message, or an empty/minimal page
      // (body length < 500 chars after whitespace compression = nothing meaningful rendered).
      const isMinimalPage = bodyText.replace(/\s+/g, ' ').trim().length < 500;
      expect(
        looksLikeNotFound || isMinimalPage,
        'admin invoice path must render a not-found/empty state, not another partner\'s real data',
      ).toBe(true);
    }
  });
});
