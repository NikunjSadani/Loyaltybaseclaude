import { expect, type Page } from '@playwright/test';
import type { RoleDef } from '../fixtures/roles';
import { resolveEnv } from '../fixtures/env';
import { resolveOtp } from './otp';

/**
 * Drive the REAL login form (FE → /api/auth/* → backend). This is the only path that counts as
 * "logged in" per VERIFICATION-PROTOCOL.md — NOT the persona/view switcher (which never gets a
 * real token and hides exactly the bugs we hunt).
 *
 * Flow (auth/login/page.tsx): enter phone → Send OTP → fill 6 OTP boxes (auto-submits) →
 * verifyOTP stores the JWT in localStorage and `window.location.href = roleDashboard`.
 */
export async function login(page: Page, role: RoleDef): Promise<void> {
  const env = resolveEnv();
  await page.goto('/auth/login');

  const phoneInput = page.locator('input[type="tel"]'); // only type=tel on the mobile step
  // The 6 single-char OTP boxes (inputmode=numeric, maxlength=1). Phone input is maxlength=10, so
  // this selector is unambiguous on the OTP step.
  const otpBoxes = page.locator('input[inputmode="numeric"][maxlength="1"]');
  await expect(phoneInput).toBeVisible();

  // Step 1 — fill phone (+ dev org override) and Send OTP, RETRIED until the OTP step renders. This
  // beats the Next.js hydration race: if we fill/click before React hydrates, onChange never fires and
  // the form rejects an "empty" mobile, so a single click can silently no-op. The guard short-circuits
  // once we've advanced. Re-sending OTP on retry is safe — dev disables rate limiting when FIXED_OTP is
  // set (app.module skipIf), so this no longer trips the 5/min throttle.
  await expect(async () => {
    if (await otpBoxes.first().isVisible().catch(() => false)) return; // already on the OTP step
    await phoneInput.fill(role.phone);
    await expect(phoneInput).toHaveValue(role.phone);
    // Tenant strategy (env.ts): on LOCAL the dev-only "Organization" override field carries the
    // clientId (#39: non-deoleo roles GIFSY/clientb resolve their tenant here). On STAGING the FE is a
    // production build, so that field is NOT rendered (NODE_ENV=production) and the tenant comes from
    // the host/subdomain — we skip the fill entirely. The count() check also guards local gracefully.
    if (env.tenantStrategy === 'devClientIdField') {
      const orgField = page.getByPlaceholder(/gifsy, deoleo/i);
      if (await orgField.count()) await orgField.fill(role.clientId);
    }
    await page.getByRole('button', { name: 'Send OTP' }).click();
    await expect(otpBoxes.first()).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout: 30_000 });

  // Resolve the OTP per-env: 'fixed' returns the constant (local, or staging-with-FIXED_OTP); 'fetch'
  // pulls the just-sent real code from the staging test-only hook (must run AFTER Send OTP). The local
  // path is unchanged — same constant the harness always typed.
  const otp = await resolveOtp(role);
  const digits = otp.split('');
  expect(digits).toHaveLength(6);
  // The 6 OTP boxes auto-advance focus on input. A per-box .fill() sets the value directly and
  // races with that focus shift — under load a digit can be dropped (observed: box 2 left empty
  // while 1,3-6 fill), so auto-submit never fires → redirect timeout. Instead, clear all boxes and
  // TYPE the code as real keystrokes from the first box: the component's auto-advance distributes
  // one digit per box exactly as it does for a human. Retry the whole sequence if any box drifts.
  await expect(async () => {
    for (let i = 0; i < 6; i++) await otpBoxes.nth(i).fill('');
    await otpBoxes.first().click();
    await page.keyboard.type(otp, { delay: 40 });
    for (let i = 0; i < 6; i++) {
      await expect(otpBoxes.nth(i)).toHaveValue(digits[i]);
    }
  }).toPass({ timeout: 10_000 });

  // Auto-submit fires when all 6 are filled → redirect away from /auth/login on success.
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/login'), { timeout: 15_000 });

  // Assert it routed to the RIGHT portal (getRoleDashboard) — proves login + role-routing in one go,
  // so setup/auth.setup.ts fully covers it (the login-matrix spec then only needs the broken role).
  const landed = new URL(page.url()).pathname;
  expect(
    landed.startsWith(role.expectedDashboardPath),
    `expected ${role.key} to land on ${role.expectedDashboardPath}, got ${landed}`,
  ).toBe(true);

  // Sanity: a real token landed where api-client reads it.
  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token, `login for ${role.key} produced no JWT`).toBeTruthy();

  // Assert the RIGHT role authenticated (FP-1). A token alone doesn't prove identity — if the seed
  // ever attaches a different role to this phone, every spec would silently run as the wrong role.
  const storedUser = await page.evaluate(() => localStorage.getItem('user'));
  expect(storedUser, `login for ${role.key} stored no user`).toBeTruthy();
  const parsed = JSON.parse(storedUser as string) as { role?: string };
  expect(
    parsed.role,
    `expected ${role.key} (${role.phone}) to log in as ${role.backendRole}, got ${parsed.role}`,
  ).toBe(role.backendRole);
}
