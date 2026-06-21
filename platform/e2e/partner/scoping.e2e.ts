import { test } from '@playwright/test';
import { expectScopedOut } from '../helpers/assert';

/**
 * Partner role scoping (gap #41 / Q6). A partner holds a real JWT but must NOT see admin/gifsy
 * surfaces or another scope's data. Either the FE redirects, or the page shows an honest
 * forbidden/empty state — never real admin data. `forbiddenMarkers` are admin-only real strings
 * whose presence would prove a scope leak.
 *
 * S4n additions: extend the forbidden surface matrix to cover a SECOND admin path (KYC
 * submissions, which a partner must never manage) and a SECOND gifsy path (platform users).
 * Forbidden-marker strings are deoleo seed data that would only appear if the backend returned
 * another scope's rows — their presence is proof of a real scope leak, not just a missing 403.
 */
test.describe('@partner scoping', () => {
  // Safe destinations a correct guard may redirect a partner to (never "anywhere").
  const SAFE = ['/auth/login', '/partner/dashboard', '/partner'];

  test('cannot reach the admin dashboard', async ({ page }) => {
    await expectScopedOut(page, '/admin/dashboard', {
      // Admin KPI labels — their presence on this page for a partner is a real scope leak.
      forbiddenMarkers: ['active partners', 'kyc approvals', 'total liability'],
      safeRedirects: SAFE,
    });
  });

  // S4n: a second admin surface — the admin KYC list (tenant management, not a partner view).
  // forbidden markers = the partner codes/business names a CLIENT_ADMIN would see but a partner
  // must NOT (pulled from seed.ts §3.3: CP001 "Deoleo Demo Wholesale Mart", CP002).
  test('cannot reach the admin KYC submissions list', async ({ page }) => {
    await expectScopedOut(page, '/admin/kyc', {
      forbiddenMarkers: ['CP001', 'CP002', 'Deoleo Demo Wholesale Mart'],
      safeRedirects: SAFE,
    });
  });

  test('cannot reach the gifsy platform console', async ({ page }) => {
    // No cross-tenant data marker yet: only one tenant (deoleo) is seeded, so we can't assert a
    // SECOND tenant's data is absent here (that test needs a 2nd seeded tenant — see README S7).
    // With the tightened block-signal (explicit forbidden / safe redirect only), the no-marker path
    // is sound: a partner rendering the real client list would NOT say "forbidden" → red.
    await expectScopedOut(page, '/gifsy/clients', { safeRedirects: SAFE });
  });

  // S4n: a second gifsy surface — platform users (gifsy console, GIFSY_ADMIN-only).
  // forbidden markers = the gifsy admin's own seeded name (would appear if the user list leaked).
  test('cannot reach the gifsy platform users page', async ({ page }) => {
    await expectScopedOut(page, '/gifsy/users', {
      forbiddenMarkers: ['Gifsy Super Admin'],
      safeRedirects: SAFE,
    });
  });
});
