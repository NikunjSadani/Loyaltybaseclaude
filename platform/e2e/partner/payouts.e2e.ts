import { test, expect } from '@playwright/test';

/**
 * Partner payouts redirect (Stream S3p, Wave 3).
 *
 * /partner/payouts is a server-side redirect to /partner/wallet (see
 * platform/src/app/partner/payouts/page.tsx — it calls `redirect('/partner/wallet')`
 * unconditionally). There is no payouts-specific UI or endpoint.
 *
 * This spec:
 *   1. Navigates to /partner/payouts.
 *   2. Asserts the browser ends up on /partner/wallet (the redirect fired).
 *   3. Asserts the wallet page rendered real content (not a blank/error state).
 *
 * NOTE: because the payouts page is a pure redirect there is no "data-agnostic"
 * list or API call to assert on this path. The wallet surface (balance + ledger)
 * is fully covered by partner/wallet.e2e.ts. This file exists solely to pin the
 * redirect so a future accidental removal of the redirect page is caught by CI.
 */

test.describe('@partner payouts (redirect to wallet)', () => {
  test('navigating to /partner/payouts redirects to /partner/wallet', async ({ page }) => {
    await page.goto('/partner/payouts');

    // The Next.js server-side redirect fires before the FE loads, so the URL
    // resolves to /partner/wallet without any client-side navigation delay.
    await page.waitForURL(/\/partner\/wallet/, { timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe('/partner/wallet');
  });

  test('the redirected wallet page renders real content (not an error state)', async ({ page }) => {
    await page.goto('/partner/payouts');
    await page.waitForURL(/\/partner\/wallet/, { timeout: 10_000 });

    // Wallet heading proves the page mounted correctly after the redirect.
    // The exact heading text is driven by partner/wallet page.tsx.
    const walletHeading = page.getByRole('heading', { name: /wallet|points|balance/i }).first();
    // Fallback: the wallet balance chip is also reliable (renders the redeemable pts).
    const balanceChip = page.getByText('50,').first(); // 50,000 formatted as "50,000"

    await expect(walletHeading.or(balanceChip)).toBeVisible({ timeout: 10_000 });
  });
});
