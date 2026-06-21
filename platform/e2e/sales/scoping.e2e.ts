import { test } from '@playwright/test';
import { expectScopedOut } from '../helpers/assert';

/**
 * SALES_SO scoping — a sales user must not reach the admin, gifsy, or partner portals (gap #41 — no
 * FE role guard today, so these are expected-RED until #53 adds role-based route guards).
 *
 * S4n additions: extend the matrix with a second admin surface (the KYC submissions list, which is
 * CLIENT_ADMIN territory), a second gifsy surface (platform users), and partner wallet — a data-
 * bearing page where a scope leak would surface a specific partner's real points balance.
 * Forbidden markers are pulled from seed.ts so a real data leak is caught, not just a missing 403.
 */
test.describe('@sales scoping', () => {
  const SAFE = ['/auth/login', '/sales/dashboard', '/sales'];

  test('cannot reach the admin portal', async ({ page }) => {
    await expectScopedOut(page, '/admin/dashboard', {
      forbiddenMarkers: ['active partners', 'total liability'],
      safeRedirects: SAFE,
    });
  });

  // S4n: second admin surface — KYC submissions list.
  // Forbidden markers = deoleo partner codes seeded in seed.ts §3.3 (CP001, CP002).
  test('cannot reach the admin KYC submissions list', async ({ page }) => {
    await expectScopedOut(page, '/admin/kyc', {
      forbiddenMarkers: ['CP001', 'CP002', 'Deoleo Demo Wholesale Mart'],
      safeRedirects: SAFE,
    });
  });

  test('cannot reach the gifsy platform console', async ({ page }) => {
    await expectScopedOut(page, '/gifsy/clients', { safeRedirects: SAFE });
  });

  // S4n: second gifsy surface — platform users list (GIFSY_ADMIN-only).
  // The gifsy admin user name is a reliable forbidden marker if the page leaks its data.
  test('cannot reach the gifsy platform users page', async ({ page }) => {
    await expectScopedOut(page, '/gifsy/users', {
      forbiddenMarkers: ['Gifsy Super Admin'],
      safeRedirects: SAFE,
    });
  });

  test('cannot reach the partner portal', async ({ page }) => {
    await expectScopedOut(page, '/partner/dashboard', { safeRedirects: SAFE });
  });

  // S4n: partner wallet is a data-bearing page — a leak would expose CP001's real points balance
  // (seed-w-1: 50 000 redeemable points) and owner name to a sales user who has no business there.
  test('cannot reach the partner wallet page', async ({ page }) => {
    await expectScopedOut(page, '/partner/wallet', {
      // seed.ts §3.3: CP001 partner name and owner name seeded on the wallet page.
      forbiddenMarkers: ['Deoleo Demo Wholesale Mart', 'Ravi Kumar'],
      safeRedirects: SAFE,
    });
  });
});
