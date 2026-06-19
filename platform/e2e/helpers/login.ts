import { expect, type Page } from '@playwright/test';
import type { RoleDef } from '../fixtures/roles';

/**
 * Drive the REAL login form (FE → /api/auth/* → backend). This is the only path that counts as
 * "logged in" per VERIFICATION-PROTOCOL.md — NOT the persona/view switcher (which never gets a
 * real token and hides exactly the bugs we hunt).
 *
 * Flow (auth/login/page.tsx): enter phone → Send OTP → fill 6 OTP boxes (auto-submits) →
 * verifyOTP stores the JWT in localStorage and `window.location.href = roleDashboard`.
 */
export async function login(page: Page, role: RoleDef): Promise<void> {
  await page.goto('/auth/login');

  // Step 1 — phone. The only type=tel input on the mobile step.
  await page.locator('input[type="tel"]').fill(role.phone);
  await page.getByRole('button', { name: 'Send OTP' }).click();

  // Step 2 — the 6 single-char OTP boxes (inputmode=numeric, maxlength=1). The phone input is
  // maxlength=10, so this selector is unambiguous on the OTP step.
  const otpBoxes = page.locator('input[inputmode="numeric"][maxlength="1"]');
  await expect(otpBoxes.first()).toBeVisible();
  const digits = role.otp.split('');
  expect(digits).toHaveLength(6);
  for (let i = 0; i < 6; i++) {
    await otpBoxes.nth(i).fill(digits[i]);
  }

  // Auto-submit fires when all 6 are filled → redirect away from /auth/login on success.
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/login'), { timeout: 15_000 });

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
