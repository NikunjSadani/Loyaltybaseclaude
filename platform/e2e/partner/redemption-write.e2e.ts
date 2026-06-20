import { test, expect } from '@playwright/test';
import { ROLES } from '../fixtures/roles';
import { resolveOtp } from '../helpers/otp';

/**
 * Money-path write-persistence (S4 extension) — the highest-stakes write. A partner redeems a fixed
 * voucher through the REAL UI (POST /api/rewards/redeem → OTP → /confirm, which debits points
 * server-side). Persistence proof: a FRESH GET /api/wallet shows the 500-pt debit stuck — not
 * optimistic UI. The redemption is driven via the UI; the balance is read via the authenticated API
 * to avoid fragile balance-sub-component parsing.
 *
 * NOTE: each run drains 500 pts from the seeded partner (starts 50,000 → ~100 runs). CI seeds fresh;
 * locally, re-seed gifsy_dev when low. The test SKIPS (not fails) when the balance is already < 500.
 */
const VOUCHER_COST = 500; // RW001 "Amazon Voucher ₹500"

test.describe('@partner redemption money-path (S4)', () => {
  test('redeeming a fixed voucher debits points and PERSISTS', async ({ page }) => {
    await page.goto('/partner/rewards');
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const readBalance = async (): Promise<number> => {
      const r = await page.request.get('/api/wallet', { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      return j.data.redeemablePoints as number;
    };

    const before = await readBalance();
    test.skip(before < VOUCHER_COST, `wallet has ${before} pts (< ${VOUCHER_COST}) — re-seed gifsy_dev`);

    // The seeded rewards render on the default Physical tab (they lack a category from the API, so the
    // FE treats them as physical — see gap on mis-categorisation). Redeem the 500-pt gift card.
    const card = page.getByText('Amazon Gift Card 500').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    // Physical redeem flow: detail → "Redeem Now" → address form → Send OTP → OTP → Confirm.
    await page.getByRole('button', { name: 'Redeem Now' }).click();
    await page.getByPlaceholder('Shop no., street name').fill('1 E2E Street');
    await page.getByPlaceholder('City').fill('Pune');
    await page.getByPlaceholder('400001').fill('411001');
    await page.getByRole('button', { name: /send otp/i }).click();
    const otpInput = page.locator('input[maxlength="6"][inputmode="numeric"]');
    await expect(otpInput).toBeVisible({ timeout: 10_000 });
    // Same OTP seam as login: 'fixed' locally (FIXED_OTP), fetched on staging-with-real-MSG91. The
    // redeem-confirm OTP is the same backend mechanism, so it must NOT be hardcoded for the staging run.
    await otpInput.fill(await resolveOtp(ROLES.partner));
    await page.getByRole('button', { name: /^confirm$/i }).click();
    await expect(page.getByText(/Redemption Confirmed/i)).toBeVisible({ timeout: 15_000 });

    // PERSISTENCE: a fresh backend read shows the debit stuck (not just optimistic UI).
    await expect.poll(readBalance, { timeout: 10_000 }).toBe(before - VOUCHER_COST);
  });
});
