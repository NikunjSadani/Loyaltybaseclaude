import { test, expect } from '@playwright/test';
import { ROLES } from '../fixtures/roles';
import { resolveOtp } from '../helpers/otp';
import { tokenFor } from '../helpers/write';

/**
 * Money-path write-persistence (stream S3 / write-flow W4) — SALES-ASSISTED REDEMPTION.
 *
 * A SALES_SO officer (phone 9000000003, role `sales`) redeems a reward ON BEHALF of the assigned
 * outlet O001 / partner CP001 (seed-cp-1, seed-w-1). Points debit from CP001's wallet, not the
 * sales officer's own account. The OTP is sent to the OUTLET's registered phone (phone 9000000002 —
 * the ChannelPartner.user.phone for seed-deoleo-partner / CP001). The sales rep enters the code the
 * outlet owner shares.
 *
 * ROUTE SUMMARY (api/src/rewards/rewards.controller.ts + rewards.service.ts §B1/#50-E):
 *   POST /api/rewards/redeem-for-outlet        { rewardId, targetPartnerId }   → { orderId, orderNumber }
 *   POST /api/rewards/redeem-for-outlet/confirm { orderId, targetPartnerId, otp } → { status: 'CONFIRMED' }
 *
 * OTP TARGET: sent to the OUTLET's registered phone via ChannelPartner.user.phone.
 * Seeded outlet O001 belongs to partner CP001 whose User.phone = '9000000002' (= ROLES.partner.phone).
 * resolveOtp(ROLES.partner) resolves the correct 6-digit code for that phone via the env-aware seam:
 *   - LOCAL  (fixed): returns env.fixedOtp (default '123456', or E2E_OTP)
 *   - STAGING (fetch): fetches the just-sent code from the test-only OTP-fetch endpoint keyed by
 *                      ROLES.partner.phone + ROLES.partner.clientId (see helpers/otp.ts)
 * This is staging-portable because it goes to the outlet's phone, NOT the SO's own phone.
 *
 * BALANCE READ: the SO's session does NOT have permission to call /api/wallet (that endpoint is gated
 * to partner roles only — @Roles('SSS','WHOLESALER','SUB_STOCKIST')). We instead read CP001's balance
 * using a cross-role token (tokenFor('partner')) on a direct /api/wallet call — exactly the pattern
 * helpers/write.ts was designed for. This gives a FRESH, authoritative backend-confirmed balance that
 * is immune to optimistic UI lying.
 *
 * SHARED-POOL CAVEAT: CP001 starts with 50,000 pts. partner/redemption-write.e2e.ts also drains
 * 500 pts from CP001 in the same serial run. Runtime is SERIAL (workers: 1), so both specs can
 * succeed without concurrent interference — but the total balance consumed is 1,000 pts per run pair.
 * The test.skip guard below cuts the spec gracefully if CP001's live balance < VOUCHER_COST so it
 * never fails due to drainage (re-seed gifsy_dev when low). Mirror of redemption-write.e2e.ts §13.
 */

/** RW001 "Amazon Voucher ₹500" — 500 pts fixed cost. */
const VOUCHER_COST = 500;

/** seed-cp-1 (CP001) — the target partner ID for the assisted redemption. */
const TARGET_PARTNER_ID = 'seed-cp-1';

/** seed-rk-1 (RW001) — the reward catalog item ID used for assisted redemption. */
const REWARD_ID = 'seed-rk-1';

test.describe('@sales assisted-redemption money-path (S3/W4)', () => {
  test('sales-assisted redeem debits the OUTLET wallet and PERSISTS', async ({ page }) => {
    // ── 1. Navigate to the sales catalogue so the SO's session is warmed up in the
    //       browser context. The SO token lives in the storageState injected by the
    //       `sales` playwright project; we read it from localStorage for API calls.
    await page.goto('/sales/catalogue');

    const soToken = await page.evaluate(() => localStorage.getItem('token'));
    if (!soToken) throw new Error('SO session token not found in localStorage — setup project may have failed');

    // ── 2. Read CP001's CURRENT balance via the partner's own token (cross-role read).
    //       /api/wallet is partner-gated, so we use tokenFor('partner') from helpers/write.
    //       This is the BEFORE snapshot — the ground truth from the backend.
    const partnerToken = tokenFor('partner');
    const readBalance = async (): Promise<number> => {
      const r = await page.request.get('/api/wallet', {
        headers: { Authorization: `Bearer ${partnerToken}` },
      });
      const j = await r.json();
      return (j.data?.redeemablePoints as number) ?? (j.redeemablePoints as number);
    };

    const before = await readBalance();
    // SKIP gracefully if CP001 has been drained — don't fail CI on a depleted fixture.
    // Re-seed gifsy_dev (npx prisma db seed) to restore 50,000 pts. See SHARED-POOL CAVEAT above.
    test.skip(before < VOUCHER_COST, `CP001 wallet has ${before} pts (< ${VOUCHER_COST}) — re-seed gifsy_dev`);

    // ── 3. POST /api/rewards/redeem-for-outlet as the SO (SO's JWT in the header).
    //       Body: { rewardId: 'seed-rk-1', targetPartnerId: 'seed-cp-1' }
    //       The backend: verifies the SalesUserAssignment, checks affordability on CP001's wallet,
    //       creates a PENDING RedemptionOrder on CP001, and sends the OTP to CP001's phone
    //       (9000000002 = ROLES.partner.phone).
    const initiateRes = await page.request.post('/api/rewards/redeem-for-outlet', {
      headers: {
        Authorization: `Bearer ${soToken}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({
        rewardId: REWARD_ID,
        targetPartnerId: TARGET_PARTNER_ID,
      }),
    });

    expect(initiateRes.status()).toBe(201);
    const initiateBody = (await initiateRes.json()) as { data?: { orderId: string; orderNumber: string }; orderId?: string };
    // The API wraps in { success, data } via TransformInterceptor — unwrap either shape.
    const orderId: string = initiateBody.data?.orderId ?? (initiateBody as unknown as { orderId: string }).orderId;
    expect(orderId).toBeTruthy();

    // ── 4. Resolve the OTP via the env-aware seam.
    //       The OTP is bound to ROLES.partner's phone (9000000002) — the OUTLET's registered number.
    //       resolveOtp(ROLES.partner) returns:
    //         LOCAL:   env.fixedOtp (e.g. '123456') — FIXED_OTP backend backdoor honours it.
    //         STAGING: fetches the just-sent real OTP from E2E_OTP_FETCH_URL keyed on that phone.
    //       NEVER a hardcoded literal here — this is what makes the spec staging-portable.
    const otp = await resolveOtp(ROLES.partner);

    // ── 5. POST /api/rewards/redeem-for-outlet/confirm as the SO.
    //       Body: { orderId, targetPartnerId, otp }
    //       The backend: re-verifies the SalesUserAssignment, validates the OTP bound to CP001's user,
    //       then in ONE $transaction: atomically claims PENDING→CONFIRMED, consumes the OTP, debits
    //       CP001's wallet via WalletService.debitRedeem (passbook + ledger), decrements stock for
    //       stock-tracked items, and records a RedemptionStatusHistory row (actor = SO's userId).
    const confirmRes = await page.request.post('/api/rewards/redeem-for-outlet/confirm', {
      headers: {
        Authorization: `Bearer ${soToken}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify({
        orderId,
        targetPartnerId: TARGET_PARTNER_ID,
        otp,
      }),
    });

    expect(confirmRes.status()).toBe(201);
    const confirmBody = (await confirmRes.json()) as { data?: { status: string }; status?: string };
    const confirmedStatus: string = confirmBody.data?.status ?? (confirmBody as unknown as { status: string }).status;
    expect(confirmedStatus).toBe('CONFIRMED');

    // ── 6. PERSISTENCE: fresh backend read shows the debit is stuck on CP001's wallet.
    //       This is NOT optimistic UI — it's a new HTTP request that hits the DB.
    //       Poll with timeout to allow any async ledger flush (WalletService.debitRedeem
    //       runs inside the confirm $transaction so the debit is synchronous, but
    //       expect.poll absorbs any replication/propagation lag in future deployments).
    await expect.poll(readBalance, { timeout: 10_000 }).toBe(before - VOUCHER_COST);

    // ── 7. ATTRIBUTION: confirm the debit is attributed to the ASSISTED flow, not a
    //       self-redemption by the partner. We verify the order exists via the partner's
    //       token on /api/rewards/orders — if it's visible as the partner's own order
    //       (RedemptionOrder.partnerId = seed-cp-1) then the wallet debit is correctly
    //       attributed to CP001 (the outlet), not the SO who operated the flow.
    const ordersRes = await page.request.get('/api/rewards/orders', {
      headers: { Authorization: `Bearer ${partnerToken}` },
    });
    expect(ordersRes.status()).toBe(200);
    const ordersBody = (await ordersRes.json()) as {
      data?: { orders: { id: string; status: string }[] };
      orders?: { id: string; status: string }[];
    };
    const orders = ordersBody.data?.orders ?? (ordersBody as unknown as { orders: { id: string; status: string }[] }).orders;
    const confirmedOrder = orders.find((o) => o.id === orderId);
    expect(confirmedOrder, 'RedemptionOrder should be visible on CP001 partner session').toBeTruthy();
    expect(confirmedOrder?.status).toBe('CONFIRMED');
  });
});
