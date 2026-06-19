import { test, expect } from '@playwright/test';
import { ROLES } from '../fixtures/roles';
import { login } from '../helpers/login';

/**
 * Login matrix.
 *
 * The WORKING roles (partner / clientAdmin / sales) are logged in — and their role-routing asserted —
 * by `setup/auth.setup.ts` (via `login()`, which now asserts the landed dashboard). We deliberately do
 * NOT re-login them here: that double-login trips the backend OTP-resend throttle and flakes.
 *
 * This spec covers the ONE thing setup can't: the known-broken role.
 */
test.describe('@login matrix', () => {
  // GIFSY is the known-broken role (#39): on localhost, resolveClientId never yields 'gifsy', so
  // verify-otp is scoped to the wrong tenant → 401 → the form never navigates. This test PASSES while
  // the bug exists and will FLIP (forcing an update) once #39 is fixed (subdomain + dev override).
  test('GIFSY login is the known-broken role (#39) — expected to fail until fixed', async ({ page }) => {
    await expect(login(page, ROLES.gifsy)).rejects.toThrow();
  });
});
