import { test, expect } from '@playwright/test';
import { expectScopedOut } from '../helpers/assert';

/**
 * CLIENT_ADMIN scoping. Two distinct rules:
 *  - Q1: `/admin/payouts` is GIFSY-only → a CLIENT_ADMIN must be scoped OUT (nav removed / honest
 *    block), NOT a 403 stack (gap #41). Encodes the TARGET; reds until the app matches.
 *  - Cross-portal: a CLIENT_ADMIN must not reach the Gifsy console or the partner portal.
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

  test('cannot reach the gifsy platform console', async ({ page }) => {
    await expectScopedOut(page, '/gifsy/clients', { safeRedirects: SAFE });
  });

  test('cannot reach the partner portal', async ({ page }) => {
    await expectScopedOut(page, '/partner/dashboard', { safeRedirects: SAFE });
  });
});
