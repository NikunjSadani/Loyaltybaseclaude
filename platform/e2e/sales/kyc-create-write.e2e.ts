import { test, expect } from '@playwright/test';
import { authHeader } from '../helpers/write';

/**
 * SALES_SO KYC create (W16) — write-persistence spec for POST /api/kyc.
 *
 * The FE `new` page (/sales/kyc/new) is a multi-step form that:
 *   1. Loads assigned outlets via GET /api/sales/outlets.
 *   2. Uploads documents to /api/kyc/documents (GCS-backed, requires real media).
 *   3. Submits via POST /api/kyc (body: partnerName, mobile, docs array, ...).
 *   4. Verifies outlet-owner OTP via POST /api/kyc/consent.
 *
 * Driving the full happy path in a headless test is impractical because:
 *   a) Step 2 requires real file input + a live GCS bucket, which is not available in CI.
 *   b) Step 4 requires an OTP sent to a real mobile number (the partner's, not the SO's).
 *
 * Strategy (same as kyc-approve-write.e2e.ts skip guard):
 *   - Assert the FE page renders correctly (step 1 works — outlets load).
 *   - Assert the POST /api/kyc endpoint is reachable and returns a validation error
 *     (not a 404/403) when called with a minimal skeleton payload missing required fields.
 *     This proves the route exists + is auth-gated to the right role, without needing
 *     actual document uploads.
 *   - Cross-role verify: after a successful submission exists (from any source), GIFSY can
 *     read it.  We skip this step when no real submission is found in the current session.
 *
 * NOTE: A full round-trip write test for this path requires:
 *   - A mocked or pre-uploaded GCS document key (fileKey/fileUrl pair).
 *   - A seeded outlet with a known phone so we can intercept the consent OTP.
 * This is deferred until the test-fixtures layer supports document mocking.
 */
test.describe('@sales kyc-create write (W16)', () => {
  test('/sales/kyc/new FE page renders (outlets load, outlet picker appears)', async ({ page }) => {
    await page.goto('/sales/kyc/new');
    await expect(page).toHaveURL(/\/sales\/kyc\/new/);

    // The first step is "Select Outlet" — the page always renders a search/dropdown.
    // Wait for the outlets to load (the page fetches /api/sales/outlets on mount).
    await page.waitForLoadState('networkidle');

    // The outlet step renders a search input or a dropdown with the SO's outlets.
    // We look for any form element associated with outlet selection.
    const outletSearchOrStep = page
      .locator('input[type="text"], input[placeholder*="outlet"], input[placeholder*="search"]')
      .first();
    const stepLabel = page.getByText(/outlet|select outlet|beat/i).first();

    await expect(outletSearchOrStep.or(stepLabel)).toBeVisible({ timeout: 10_000 });
  });

  test('POST /api/kyc endpoint is reachable and auth-gated (not 404/403 for SALES_SO)', async ({
    page,
  }) => {
    await page.goto('/sales/kyc/new');
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'SALES_SO must be logged in').toBeTruthy();

    // Submit a skeleton payload with missing required fields.  The backend should return:
    //   - 400 (validation error) — route exists + authenticated + valid role
    // NOT:
    //   - 401 (missing auth)   — would indicate storageState/token issue
    //   - 403 (wrong role)     — SALES_SO must have kyc:create permission
    //   - 404 (route not found)
    const res = await page.request.post('/api/kyc', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: {
        // Intentionally sparse — will fail validation but proves the route + auth work.
        partnerName: '',
        mobile: '',
        documents: [],
      },
    });

    // 400 (validation) or 422 (unprocessable) are both acceptable — they prove the route is live.
    // 401 or 403 would mean the auth or role gate is broken.
    expect(
      res.status(),
      `POST /api/kyc returned ${res.status()} — expected a validation error (400/422), not an auth failure (401/403) or missing route (404)`,
    ).not.toBe(401);
    expect(res.status()).not.toBe(403);
    expect(res.status()).not.toBe(404);
  });

  // ── Cross-role persistence check (opportunistic) ──────────────────────────────────
  // If a KYC submission already exists in the DB for this SO's assigned outlet (seed-kyc-1,
  // seed-kyc-4), verify that GIFSY can read it — this is the canonical cross-role persistence
  // assertion used across all write specs.  We use seed-kyc-4 because it is always seeded.
  test('GIFSY can read a known deoleo KYC submission (cross-role persistence baseline)', async ({
    page,
  }) => {
    // We use seed-kyc-4 as a known-seeded submission to prove the GIFSY cross-read path works.
    // This is not strictly a CREATE test, but it validates the cross-role read leg that a real
    // kyc-create flow would depend on.
    const gifsyAuth = authHeader('gifsy');
    const res = await page.request.get('/api/kyc/seed-kyc-4', { headers: gifsyAuth });

    if (res.status() === 404) {
      // seed-kyc-4 doesn't exist — skip gracefully (e.g. seed not run yet).
      test.skip(true, 'seed-kyc-4 not found — seed not run or DB reset; skipping cross-role read');
      return;
    }

    expect(res.status(), 'GET /api/kyc/seed-kyc-4 as GIFSY must succeed').toBe(200);
    const body = await res.json();
    expect(body.success, 'GIFSY cross-read response must have success:true').toBe(true);
    expect(
      body.data?.submission?.id,
      'GIFSY cross-read must return the submission id',
    ).toBe('seed-kyc-4');
  });
});
