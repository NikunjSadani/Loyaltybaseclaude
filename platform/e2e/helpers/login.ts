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
 * verifyOTP sets the JWT as an httpOnly `token` cookie (AF-6: NOT localStorage) and
 * `window.location.href = roleDashboard`.
 */
export async function login(page: Page, role: RoleDef): Promise<void> {
  const env = resolveEnv();

  // hostHeader (local prod-build) strategy: steer tenant resolution by injecting x-forwarded-host on
  // EVERY request from this page — the login page SSR, the send-otp/verify-otp server actions (which
  // resolve clientId from the host via resolveTrustedHost), and the post-login navigations. Must be set
  // BEFORE the first goto. Trusted locally because EDGE_SECRET is unset (lib/platform/edge-trust.ts).
  // The role projects set the same header at the project level (playwright.config.ts) for post-login
  // spec requests. See env.ts TenantStrategy.
  if (env.tenantStrategy === 'hostHeader' && role.host) {
    await page.setExtraHTTPHeaders({ 'x-forwarded-host': role.host });
  }

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

  // Sanity: a real session landed. AF-6 — the JWT is an httpOnly `token` cookie now (NOT
  // localStorage, which a stored-XSS could read). Playwright reads httpOnly cookies via the context.
  const cookies = await page.context().cookies();
  const tokenCookie = cookies.find((c) => c.name === 'token');
  expect(tokenCookie?.value, `login for ${role.key} produced no JWT cookie`).toBeTruthy();

  // Assert the RIGHT role authenticated (FP-1) by decoding the JWT payload — a token alone doesn't
  // prove identity; if the seed ever attaches a different role to this phone, every spec would
  // silently run as the wrong role. (No localStorage `user` post-AF-6.)
  const payload = JSON.parse(
    Buffer.from(tokenCookie!.value.split('.')[1], 'base64').toString('utf8'),
  ) as { role?: string };
  expect(
    payload.role,
    `expected ${role.key} (${role.phone}) to log in as ${role.backendRole}, got ${payload.role}`,
  ).toBe(role.backendRole);
}
