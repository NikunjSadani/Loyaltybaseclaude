import { test } from '@playwright/test';
import { expectScopedOut } from '../helpers/assert';

/**
 * Partner role scoping (gap #41 / Q6). A partner holds a real JWT but must NOT see admin/gifsy
 * surfaces or another scope's data. Either the FE redirects, or the page shows an honest
 * forbidden/empty state — never real admin data. `forbiddenMarkers` are admin-only real strings
 * whose presence would prove a scope leak.
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

  test('cannot reach the gifsy platform console', async ({ page }) => {
    // No cross-tenant data marker yet: only one tenant (deoleo) is seeded, so we can't assert a
    // SECOND tenant's data is absent here (that test needs a 2nd seeded tenant — see README S7).
    // With the tightened block-signal (explicit forbidden / safe redirect only), the no-marker path
    // is sound: a partner rendering the real client list would NOT say "forbidden" → red.
    await expectScopedOut(page, '/gifsy/clients', { safeRedirects: SAFE });
  });
});
