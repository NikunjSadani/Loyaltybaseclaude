import { test } from '@playwright/test';
import { expectScopedOut } from '../helpers/assert';

/**
 * SALES_SO scoping — a sales user must not reach the admin, gifsy, or partner portals (gap #41 — no
 * FE role guard today, so these are expected-RED until #53 adds role-based route guards).
 */
test.describe('@sales scoping', () => {
  const SAFE = ['/auth/login', '/sales/dashboard', '/sales'];

  test('cannot reach the admin portal', async ({ page }) => {
    await expectScopedOut(page, '/admin/dashboard', {
      forbiddenMarkers: ['active partners', 'total liability'],
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
