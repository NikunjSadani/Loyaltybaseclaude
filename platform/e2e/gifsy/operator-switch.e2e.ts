import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';

/**
 * A2-FE (#51) — the operator-context switcher, end-to-end through the real UI.
 * A GIFSY operator opens "Work in brand ▾" in the console, picks a brand → the FE
 * server action exchanges the gifsy session for a tenant-scoped GIFSY_ADMIN token
 * (POST /v1/auth/assume-tenant, via lib/auth-actions.assumeTenantAction), swaps the
 * httpOnly `token` cookie, lands in the admin shell, and a persistent "working in
 * <Brand>" banner shows. "Exit to platform" restores the platform (gifsy) session.
 * Proves the whole switch round-trips at runtime.
 *
 * AF-6 — the access token is an httpOnly `token` COOKIE now (no localStorage token, no
 * `homeToken`); the operator's home session is stashed server-side in a `home_token`
 * httpOnly cookie and restored on exit. So we verify the identity switch by DECODING the
 * live `token` cookie's JWT (via cookieToken) rather than reading localStorage: after
 * assume the token's `clientId` must be the assumed tenant with `assumed:true` and the
 * operator's `role` preserved (GIFSY_ADMIN); after exit `clientId` is back to `gifsy`.
 */

/** Decode a JWT payload (middle segment) — Node's base64 decoder tolerates base64url. */
function jwtClaims(token: string): { clientId?: string; role?: string; assumed?: boolean } {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
}

test.describe('@gifsy operator-context switcher (A2-FE / #51)', () => {
  test('switch into a brand → admin shell + banner; exit → back to platform', async ({ page }) => {
    await page.goto('/gifsy');

    // Baseline: the operator's live token is scoped to the platform (gifsy), not assumed.
    const homeBefore = await cookieToken(page);
    expect(homeBefore, 'operator has a live session on the console').toBeTruthy();
    const homeClaimsBefore = jwtClaims(homeBefore!);
    expect(homeClaimsBefore.clientId, 'starts in the platform (gifsy) context').toBe('gifsy');
    expect(homeClaimsBefore.role, 'is a GIFSY operator').toBe('GIFSY_ADMIN');
    expect(homeClaimsBefore.assumed ?? false, 'not in an assumed context yet').toBe(false);

    // Open the switcher and pick Deoleo.
    await page.getByRole('button', { name: /work in brand/i }).click();
    const deoleo = page.getByRole('button', { name: /deoleo/i }).first();
    await expect(deoleo).toBeVisible({ timeout: 10_000 });
    await deoleo.click();

    // Lands in the admin shell; the localStorage banner hint + the amber banner show.
    await page.waitForURL(/\/admin\//, { timeout: 15_000 });
    const assumed = await page.evaluate(() => localStorage.getItem('assumedBrand'));
    expect(assumed, 'assumedBrand stored').toMatch(/deoleo/i);
    await expect(page.getByText(/working in/i)).toBeVisible();

    // The IDENTITY SWITCH is real: the live httpOnly `token` cookie is now a
    // tenant-scoped, `assumed`-flagged token whose `clientId` is the assumed brand,
    // while the operator's own role is preserved (AF-6 replacement for the old
    // `homeToken` localStorage check).
    const assumedTok = await cookieToken(page);
    expect(assumedTok, 'assumed-tenant token cookie present').toBeTruthy();
    const assumedClaims = jwtClaims(assumedTok!);
    expect(assumedClaims.clientId, 'token re-scoped to the assumed tenant').toBe('deoleo');
    expect(assumedClaims.role, 'operator identity preserved (still GIFSY_ADMIN)').toBe('GIFSY_ADMIN');
    expect(assumedClaims.assumed, 'token flagged as an assumed-tenant context').toBe(true);

    // Exit restores the platform context (token back to gifsy, banner hint cleared).
    await page.getByRole('button', { name: /exit to platform/i }).click();
    await page.waitForURL(/\/gifsy/, { timeout: 15_000 });
    const after = await page.evaluate(() => localStorage.getItem('assumedBrand'));
    expect(after, 'assumedBrand cleared on exit').toBeNull();

    const homeAfter = await cookieToken(page);
    expect(homeAfter, 'home token cookie restored after exit').toBeTruthy();
    const homeClaimsAfter = jwtClaims(homeAfter!);
    expect(homeClaimsAfter.clientId, 'back in the platform (gifsy) context').toBe('gifsy');
    expect(homeClaimsAfter.assumed ?? false, 'assumed flag cleared on exit').toBe(false);
  });
});
