import { test } from '@playwright/test';
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

  test('cannot reach the gifsy platform console', async ({ page }) => {
    await expectScopedOut(page, '/gifsy/clients', { safeRedirects: SAFE });
  });

  test('cannot reach the partner portal', async ({ page }) => {
    await expectScopedOut(page, '/partner/dashboard', { safeRedirects: SAFE });
  });
});
