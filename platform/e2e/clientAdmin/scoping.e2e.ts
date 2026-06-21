import { test, expect } from '@playwright/test';
import { expectScopedOut } from '../helpers/assert';

/**
 * CLIENT_ADMIN scoping. Three distinct rules:
 *  - Q1: `/admin/payouts` is GIFSY-only → a CLIENT_ADMIN must be scoped OUT (nav removed / honest
 *    block), NOT a 403 stack (gap #41). Encodes the TARGET; reds until the app matches.
 *  - Q2: `/admin/kyc/approvals` is GIFSY-only — the Gifsy bulk-validation workspace. A CLIENT_ADMIN
 *    must NOT reach it (not even read-only). The tenant KYC list (`/admin/kyc`) is theirs; the
 *    approvals workspace is platform-operator territory.
 *  - Cross-portal: a CLIENT_ADMIN must not reach the Gifsy console or the partner portal.
 *
 * S4n additions (per DATA-VISIBILITY §2 negative matrix):
 *  - Q2 block: /admin/kyc/approvals + /admin/payouts/fund (the sub-page of Q1 payouts).
 *  - Gifsy surface: extend to /gifsy/users and /gifsy/outlet-types (both GIFSY_ADMIN-only).
 *  - Partner portal: extend to /partner/wallet (data-bearing, seed markers from seed.ts §3.3).
 */
test.describe('@clientAdmin scoping', () => {
  const SAFE = ['/auth/login', '/admin/dashboard', '/admin'];

  test('Q1 — cannot manage payouts (GIFSY-only)', async ({ page }) => {
    await expectScopedOut(page, '/admin/payouts', {
      // payout-list markers that would prove the page rendered payout management for a client admin
      forbiddenMarkers: ['payout batch', 'process payout', 'settlement'],
      safeRedirects: SAFE,
    });
  });

  // Tightens the Q1 scope-out: the app does not merely "redirect somewhere safe" — it bounces a
  // CLIENT_ADMIN off /admin/payouts and LANDS them on /admin/dashboard specifically (runtime-verified).
  // Asserting the exact destination guards against a future regression that redirects elsewhere (e.g.
  // back to /admin/payouts via a loop, or to a 403 page) while still technically being "scoped out".
  test('Q1 — /admin/payouts redirects a CLIENT_ADMIN to /admin/dashboard', async ({ page }) => {
    await page.goto('/admin/payouts');
    // The route guard runs client-side post-hydration, so the redirect fires a beat after goto.
    await page.waitForURL((u) => u.pathname.endsWith('/admin/dashboard'), { timeout: 10_000 });
    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    // And NOT still sitting on the payouts route.
    expect(new URL(page.url()).pathname.endsWith('/admin/payouts')).toBe(false);
  });

  // S4n — Q1 sub-page: /admin/payouts/fund is the fund-disbursement page under the payouts shell.
  // The payouts layout guards the whole tree with allowedRoles=['GIFSY_ADMIN'], so CLIENT_ADMIN
  // must be redirected off this sub-page too, not just the index.
  test('Q1 — cannot reach /admin/payouts/fund (fund disbursement, GIFSY-only sub-page)', async ({ page }) => {
    await expectScopedOut(page, '/admin/payouts/fund', {
      forbiddenMarkers: ['fund', 'disburse', 'payout batch'],
      safeRedirects: SAFE,
    });
  });

  // S4n — Q2: the Gifsy KYC bulk-approval workspace is GIFSY_ADMIN-only (DATA-VISIBILITY §3 Q2).
  // Forbidden markers = cross-tenant KYC strings that only the Gifsy operator should see (both
  // deoleo PENDING_GIFSY submission + clientb's PENDING_GIFSY entry, both seeded in seed.ts §3.6 /
  // §4). A CLIENT_ADMIN must never reach this workspace at all.
  test('Q2 — cannot reach /admin/kyc/approvals (Gifsy bulk-approval workspace, GIFSY-only)', async ({ page }) => {
    await expectScopedOut(page, '/admin/kyc/approvals', {
      // These strings appear in the Gifsy cross-tenant review queue; their presence for a CLIENT_ADMIN
      // session would be a real Q2 scope violation.
      forbiddenMarkers: ['bulk verify', 'review queue', 'Zenith Trading Co', 'CPB001'],
      safeRedirects: SAFE,
    });
  });

  test('cannot reach the gifsy platform console', async ({ page }) => {
    await expectScopedOut(page, '/gifsy/clients', { safeRedirects: SAFE });
  });

  // S4n: second gifsy surface — platform users list.
  test('cannot reach the gifsy platform users page', async ({ page }) => {
    await expectScopedOut(page, '/gifsy/users', {
      forbiddenMarkers: ['Gifsy Super Admin'],
      safeRedirects: SAFE,
    });
  });

  // S4n: third gifsy surface — outlet types (global master list, GIFSY_ADMIN-only console page).
  test('cannot reach the gifsy outlet-types page', async ({ page }) => {
    await expectScopedOut(page, '/gifsy/outlet-types', {
      // Outlet type names are seeded globally; their appearance here means the console rendered.
      forbiddenMarkers: ['SSS TOT', 'Sub-Stockist'],
      safeRedirects: SAFE,
    });
  });

  test('cannot reach the partner portal', async ({ page }) => {
    await expectScopedOut(page, '/partner/dashboard', { safeRedirects: SAFE });
  });

  // S4n: partner wallet — data-bearing. A leak would expose CP001's wallet balance/owner to an
  // admin who has no business in the partner portal. Forbidden markers from seed.ts §3.3.
  test('cannot reach the partner wallet page', async ({ page }) => {
    await expectScopedOut(page, '/partner/wallet', {
      forbiddenMarkers: ['Deoleo Demo Wholesale Mart', 'Ravi Kumar'],
      safeRedirects: SAFE,
    });
  });
});
