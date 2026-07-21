import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';
import { ROLES } from '../fixtures/roles';
import { resolveOtp } from '../helpers/otp';

/**
 * Money-path write-persistence (S4 extension) — the highest-stakes write. A partner redeems a fixed
 * voucher through the REAL UI (POST /api/rewards/redeem → OTP → /confirm, which debits points
 * server-side). Persistence proof: a FRESH GET /api/wallet shows the 500-pt debit stuck — not
 * optimistic UI. The redemption is driven via the UI; the balance is read via the authenticated API
 * to avoid fragile balance-sub-component parsing.
 *
 * RUNS AS `partnerApproved` (CP004 / seed-cp-4), NOT the default `partner` (CP001). The redeem
 * confirm gates on KYC-APPROVED (rewards.service.confirmRedeem, GLB-1 all-mode gate, owner decision
 * 2026-06-27) and CP001 is deliberately KYC-pending (the KYC-flow fixture), so a self-redeem as CP001
 * 400s. CP004 is APPROVED + funded 50k (seed §3.3/§3.4b-cp4) — the happy-path redeemer.
 *
 * NOTE: each run drains 500 pts from CP004 (starts 50,000). CI seeds fresh; locally re-seed gifsy_dev
 * when low. The test SKIPS (not fails) when the balance is already < 500.
 */
const VOUCHER_COST = 500; // RW001 "Amazon Voucher ₹500" (500-pt fixed GIFT_CARD voucher)

test.describe('@partnerApproved redemption money-path (S4)', () => {
  test('redeeming a fixed voucher debits points and PERSISTS', async ({ page }) => {
    await page.goto('/partner/rewards');
    const token = await cookieToken(page);
    const readBalance = async (): Promise<number> => {
      const r = await page.request.get('/api/wallet', { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      return j.data.redeemablePoints as number;
    };

    const before = await readBalance();
    test.skip(before < VOUCHER_COST, `wallet has ${before} pts (< ${VOUCHER_COST}) — re-seed gifsy_dev`);

    // RW001 ("Amazon Voucher ₹500", the seed value) is a GIFT_CARD-mode reward → the FE buckets it
    // under the "Vouchers" tab (redemptionMode === 'GIFT_CARD'), NOT the default Physical tab. Switch
    // tabs, then open the FIXED-voucher redeem sheet for the 500-pt voucher.
    await page.getByRole('button', { name: 'Vouchers' }).click();
    const card = page.getByText('Amazon Voucher ₹500').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    // FIXED voucher redeem flow (VoucherRedeemSheet): sheet → "Send OTP" → OTP → Confirm. Unlike the
    // physical-gift flow there is NO address form — the fixed voucher goes straight to OTP.
    await page.getByRole('button', { name: /send otp/i }).click();
    const otpInput = page.locator('input[maxlength="6"][inputmode="numeric"]');
    await expect(otpInput).toBeVisible({ timeout: 10_000 });
    // Same OTP seam as login: 'fixed' locally (FIXED_OTP), fetched on staging-with-real-MSG91. The
    // redeem-confirm OTP is bound to the REDEEMING partner's phone — CP004 (ROLES.partnerApproved).
    await otpInput.fill(await resolveOtp(ROLES.partnerApproved));
    await page.getByRole('button', { name: /^confirm$/i }).click();
    await expect(page.getByText(/Voucher Confirmed/i)).toBeVisible({ timeout: 15_000 });

    // PERSISTENCE: a fresh backend read shows the debit stuck (not just optimistic UI).
    await expect.poll(readBalance, { timeout: 10_000 }).toBe(before - VOUCHER_COST);
  });
});
